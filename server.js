/**
 * server.js — Document AI (Invoice Parser) API for Railway/local
 *
 * Endpoints:
 *  - GET  /health              -> {"ok": true}
 *  - POST /process-invoice     -> multipart/form-data: file=<pdf>, plus optional fields in req.body
 *
 * Env (Railway):
 *  - PROJECT_ID      (required)
 *  - LOCATION        (optional, default "eu")
 *  - PROCESSOR_ID    (required)
 *  - GCP_SA_JSON     (recommended on Railway: paste entire service account JSON)
 *  - API_KEY         (optional: if set, require header x-api-key)
 *
 * Notes:
 *  - If LOCATION is "eu" (multi-region), we use endpoint "eu-documentai.googleapis.com"
 *  - If GCP_SA_JSON is not set, it will try ADC (GOOGLE_APPLICATION_CREDENTIALS / metadata) instead.
 */

"use strict";

const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const { DocumentProcessorServiceClient } = require("@google-cloud/documentai").v1;

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
});

// ------------ Config ------------
const PROJECT_ID = process.env.PROJECT_ID;
const LOCATION = process.env.LOCATION || "eu";
const PROCESSOR_ID = process.env.PROCESSOR_ID;
const API_KEY = process.env.API_KEY || null;

// ------------ Helpers: entities -> clean output ------------
function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function normalizeEntities(doc) {
  // Convert doc.entities to a simpler shape so we can safely map
  const entities = Array.isArray(doc?.entities) ? doc.entities : [];
  return entities.map((e) => ({
    type: e.type || null,
    mentionText: e.mentionText || null,
    normalizedValue: e.normalizedValue || null,
    confidence: typeof e.confidence === "number" ? e.confidence : null,
    // Keep properties for line items
    properties: Array.isArray(e.properties)
      ? e.properties.map((p) => ({
          type: p.type || null,
          mentionText: p.mentionText || null,
          normalizedValue: p.normalizedValue || null,
          confidence: typeof p.confidence === "number" ? p.confidence : null,
          properties: Array.isArray(p.properties) ? p.properties : [],
        }))
      : [],
  }));
}

function bestEntity(entities, type) {
  const hits = entities.filter((e) => e.type === type);
  if (hits.length === 0) return null;
  hits.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  return hits[0];
}

function entityValue(e) {
  if (!e) return null;

  // Try normalizedValue first (often best for dates/amounts)
  if (e.normalizedValue) {
    if (typeof e.normalizedValue === "string") return e.normalizedValue;
    if (typeof e.normalizedValue.text === "string") return e.normalizedValue.text;
    // Sometimes normalizedValue may hold structured fields; fallback:
  }
  return e.mentionText ?? null;
}

function field(entities, type) {
  const e = bestEntity(entities, type);
  return {
    value: entityValue(e),
    confidence: e?.confidence ?? null,
  };
}

function extractLineItems(entities) {
  // Invoice Parser commonly uses "line_item" entities with properties.
  const lineEntities = entities.filter((e) => e.type === "line_item");

  return lineEntities.map((li) => {
    const props = Array.isArray(li.properties) ? li.properties : [];
    const pickProp = (t) => {
      const hit = props.find((p) => p.type === t) || null;
      return { value: entityValue(hit), confidence: hit?.confidence ?? null };
    };

    return {
      description: pickProp("description"),
      quantity: pickProp("quantity"),
      unit_price: pickProp("unit_price"),
      amount: pickProp("amount"),
      product_code: pickProp("product_code"),
      tax_amount: pickProp("tax_amount"),
      tax_rate: pickProp("tax_rate"),
      confidence: li.confidence ?? null,
    };
  });
}

function extractMeterNumberFromText(text) {
  if (!text || typeof text !== "string") return null;

  const patterns = [
    // Norwegian
    /måler(?:nummer|nr)\.?\s*[:\-]?\s*([0-9][0-9 \-]{7,30})/i,
    /måler\s*id\.?\s*[:\-]?\s*([0-9][0-9 \-]{7,30})/i,
    // English fallback
    /meter\s*(?:number|no|id)\.?\s*[:\-]?\s*([0-9][0-9 \-]{7,30})/i,
  ];

  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1]) {
      const cleaned = String(m[1]).replace(/[ \-]/g, "");
      if (cleaned.length >= 8) return cleaned;
    }
  }
  return null;
}

function buildInvoice(entities, docText) {
  const invoice = {
    // Core invoice fields
    invoice_id: field(entities, "invoice_id"),
    invoice_date: field(entities, "invoice_date"),
    due_date: field(entities, "due_date"),

    supplier_name: field(entities, "supplier_name"),
    supplier_address: field(entities, "supplier_address"),
    supplier_organization_id: field(entities, "supplier_organization_id"),

    buyer_name: field(entities, "buyer_name"),
    buyer_address: field(entities, "buyer_address"),

    currency: field(entities, "currency"),
    net_amount: field(entities, "net_amount"),
    total_tax_amount: field(entities, "total_tax_amount"),
    total_amount: field(entities, "total_amount"),

    // Payment-ish fields (may or may not exist)
    iban: field(entities, "iban"),
    bank_account_number: field(entities, "bank_account_number"),
    swift: field(entities, "swift"),
    payment_reference: field(entities, "payment_reference"),

    // Your custom fallback field
    meter_number: {
      value: extractMeterNumberFromText(docText),
      confidence: null, // regex fallback has no model confidence
      source: "regex_doc_text",
    },
  };

  // Simple “needs_review” flags based on confidence
  const needsReview = [];
  const mustHave = ["invoice_id", "invoice_date", "total_amount", "supplier_name"];
  for (const k of mustHave) {
    const c = invoice[k]?.confidence;
    const v = invoice[k]?.value;
    if (!v) needsReview.push({ field: k, reason: "missing" });
    else if (typeof c === "number" && c < 0.6) needsReview.push({ field: k, reason: "low_confidence", confidence: c });
  }

  return { invoice, needs_review: needsReview };
}

// ------------ Document AI client (lazy init) ------------
let _client = null;

function getDocAiClient() {
  if (_client) return _client;

  const endpoint =
    LOCATION === "eu"
      ? "eu-documentai.googleapis.com"
      : LOCATION === "us"
      ? "us-documentai.googleapis.com"
      : undefined; // region-specific locations usually work on default endpoint

  const saJson = process.env.GCP_SA_JSON;
  const credentials = saJson ? safeJsonParse(saJson) : null;

  const opts = {};
  if (endpoint) opts.apiEndpoint = endpoint;
  if (credentials) opts.credentials = credentials;

  _client = new DocumentProcessorServiceClient(opts);
  return _client;
}

// ------------ Routes ------------
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/process-invoice", upload.single("file"), async (req, res) => {
  try {
    if (API_KEY && req.header("x-api-key") !== API_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!PROJECT_ID || !PROCESSOR_ID) {
      return res.status(500).json({
        error: "Server misconfigured: PROJECT_ID and PROCESSOR_ID are required env vars.",
      });
    }

    if (!req.file) {
      return res.status(400).json({
        error: "Missing file. Send multipart/form-data with field name: file",
      });
    }

    const requestId = crypto.randomUUID();
    const mimeType = req.file.mimetype || "application/pdf";

    const processorName = `projects/${PROJECT_ID}/locations/${LOCATION}/processors/${PROCESSOR_ID}`;

    const client = getDocAiClient();

    const request = {
      name: processorName,
      rawDocument: {
        content: req.file.buffer.toString("base64"),
        mimeType,
      },
    };

    const [result] = await client.processDocument(request);
    const doc = result.document;

    const entities = normalizeEntities(doc);
    const docText = doc?.text || "";

    const line_items = extractLineItems(entities);
    const { invoice, needs_review } = buildInvoice(entities, docText);

    // Keep a small debug block (safe)
    const debug = {
      requestId,
      processor: { projectId: PROJECT_ID, location: LOCATION, processorId: PROCESSOR_ID },
      file: {
        originalname: req.file.originalname,
        mimeType,
        bytes: req.file.size,
      },
      submitted_fields: req.body || {},
      text_length: docText.length,
      entities_count: entities.length,
      line_items_count: line_items.length,
    };

    return res.json({
      ok: true,
      debug,
      invoice,
      line_items,
      needs_review,
      // If you want raw entities for debugging, uncomment:
      // raw_entities: entities,
    });
  } catch (err) {
    return res.status(500).json({
      error: err?.message || String(err),
      code: err?.code ?? null,
      details: err?.details ?? null,
    });
  }
});

// ------------ Start ------------
const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`Running on port ${port}`);
});

"use strict";

const express = require("express");
const multer = require("multer");
const { DocumentProcessorServiceClient } = require("@google-cloud/documentai").v1;

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
});

// ---- Env ----
const PROJECT_ID = process.env.PROJECT_ID;
const LOCATION = process.env.LOCATION || "eu";
const PROCESSOR_ID = process.env.PROCESSOR_ID;
const API_KEY = process.env.API_KEY || null;

// ---- Client ----
function makeClient() {
  const opts = {};

  // EU multi-region krever EU endpoint
  if (LOCATION === "eu") opts.apiEndpoint = "eu-documentai.googleapis.com";
  if (LOCATION === "us") opts.apiEndpoint = "us-documentai.googleapis.com";

  // Railway: legg inn hele service account JSON i GCP_SA_JSON
  if (process.env.GCP_SA_JSON) {
    opts.credentials = JSON.parse(process.env.GCP_SA_JSON);
  }

  return new DocumentProcessorServiceClient(opts);
}
const client = makeClient();

// ---- Helpers: entities -> structured ----
function normalizedToText(normalizedValue) {
  if (!normalizedValue) return null;
  if (typeof normalizedValue === "string") return normalizedValue;
  if (typeof normalizedValue.text === "string") return normalizedValue.text;
  return null;
}

function entityToValue(entity) {
  if (!entity) return null;
  // Prefer normalizedValue.text if present
  const nv = normalizedToText(entity.normalizedValue);
  return nv || entity.mentionText || null;
}

function pickBestEntity(entities, type) {
  const hits = (entities || []).filter((e) => e.type === type);
  if (!hits.length) return null;
  hits.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  return hits[0];
}

function field(entities, type) {
  const e = pickBestEntity(entities, type);
  return {
    value: entityToValue(e),
    confidence: typeof e?.confidence === "number" ? e.confidence : null,
  };
}

function extractLineItems(entities) {
  // Invoice Parser often returns line_item entities with properties
  const lineEntities = (entities || []).filter((e) => e.type === "line_item");
  return lineEntities.map((li) => {
    const props = Array.isArray(li.properties) ? li.properties : [];

    const propField = (t) => {
      const p = pickBestEntity(props, t);
      return {
        value: entityToValue(p),
        confidence: typeof p?.confidence === "number" ? p.confidence : null,
      };
    };

    return {
      description: propField("description"),
      quantity: propField("quantity"),
      unit: propField("unit"),
      unit_price: propField("unit_price"),
      amount: propField("amount"),
      product_code: propField("product_code"),
      tax_amount: propField("tax_amount"),
      tax_rate: propField("tax_rate"),
      confidence: typeof li?.confidence === "number" ? li.confidence : null,
    };
  });
}

// ---- Routes ----
app.get("/health", (req, res) => res.json({ ok: true }));

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
      return res.status(400).json({ error: "Missing file (field name must be 'file')" });
    }

    const name = `projects/${PROJECT_ID}/locations/${LOCATION}/processors/${PROCESSOR_ID}`;

    const request = {
      name,
      rawDocument: {
        content: req.file.buffer.toString("base64"),
        mimeType: req.file.mimetype || "application/pdf",
      },
    };

    const [result] = await client.processDocument(request);
    const doc = result.document || {};
    const entities = Array.isArray(doc.entities) ? doc.entities : [];

    // ---- EXACT-ish response shape (only from AI; nulls if missing) ----
    const response = {
      invoice_id: field(entities, "invoice_id").value,
      invoice_date: field(entities, "invoice_date").value,
      invoice_type: "invoice_statement", // constant as you used
      currency: field(entities, "currency").value,

      supplier_name: field(entities, "supplier_name").value,
      supplier_website: field(entities, "supplier_website").value,
      supplier_email: field(entities, "supplier_email").value,
      supplier_phone: field(entities, "supplier_phone").value,
      supplier_address: field(entities, "supplier_address").value,
      supplier_iban: field(entities, "iban").value || field(entities, "supplier_iban").value,
      supplier_tax_id: field(entities, "supplier_tax_id").value || field(entities, "supplier_organization_id").value,
      supplier_payment_ref: field(entities, "payment_reference").value,

      ship_to_address: field(entities, "ship_to_address").value,

      total_amount: field(entities, "total_amount").value,
      net_amount: field(entities, "net_amount").value,

      line_items: extractLineItems(entities),
      // optional debug:
      debug: {
        processor: { projectId: PROJECT_ID, location: LOCATION, processorId: PROCESSOR_ID },
        file: { name: req.file.originalname, mimeType: req.file.mimetype, bytes: req.file.size },
        entities_count: entities.length,
      },
    };

    return res.json(response);
  } catch (err) {
    return res.status(500).json({
      error: err?.message || String(err),
      code: err?.code ?? null,
      details: err?.details ?? null,
    });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`Running on port ${port}`));

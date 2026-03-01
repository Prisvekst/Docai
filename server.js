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
  if (LOCATION === "eu") opts.apiEndpoint = "eu-documentai.googleapis.com";
  if (LOCATION === "us") opts.apiEndpoint = "us-documentai.googleapis.com";
  if (process.env.GCP_SA_JSON) opts.credentials = JSON.parse(process.env.GCP_SA_JSON);
  return new DocumentProcessorServiceClient(opts);
}
const client = makeClient();

// ---- Helpers ----
function normalizedToText(normalizedValue) {
  if (!normalizedValue) return null;
  if (typeof normalizedValue === "string") return normalizedValue;
  if (typeof normalizedValue.text === "string") return normalizedValue.text;
  return null;
}

function entityValue(e) {
  if (!e) return null;
  const nv = normalizedToText(e.normalizedValue);
  return (nv || e.mentionText || null);
}

function bestEntity(entities, type) {
  const hits = (entities || []).filter((e) => e.type === type);
  if (!hits.length) return null;
  hits.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  return hits[0];
}

function pick(entities, type) {
  const e = bestEntity(entities, type);
  return {
    value: entityValue(e),
    confidence: typeof e?.confidence === "number" ? e.confidence : null,
  };
}

function pickAny(entities, types) {
  for (const t of types) {
    const v = pick(entities, t);
    if (v.value) return v;
  }
  return { value: null, confidence: null };
}

// ---- Your schema mapping (Custom Extractor types -> API fields) ----
const MAP = {
  invoice_date: ["fakturadato"],
  due_date: ["forfallsdato"],
  total_amount: ["totalsum"],
  meter_number: ["malernr"],
  customer_name: ["forbruker_navn"],
  ship_to_address: ["forbruker_adresse"],
  usage_period_kwh: ["forbruk_for_periode"],
  surcharge: ["paaslag"],
  price_area: ["prisomrade"],
};

// ---- Routes ----
app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/process-invoice", upload.single("file"), async (req, res) => {
  try {
    if (API_KEY && req.header("x-api-key") !== API_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    if (!PROJECT_ID || !PROCESSOR_ID) {
      return res.status(500).json({ error: "Missing env PROJECT_ID or PROCESSOR_ID" });
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

    // Build clean output based on your custom extractor schema
    const invoice_date = pickAny(entities, MAP.invoice_date);
    const due_date = pickAny(entities, MAP.due_date);
    const total_amount = pickAny(entities, MAP.total_amount);

    // Currency: your totalsum includes "kr" at the end, so we can derive it safely
    const currency =
      typeof total_amount.value === "string" && /kr/i.test(total_amount.value) ? "kr" : null;

    const response = {
      invoice_id: null, // not in your schema yet
      invoice_date: invoice_date.value, // normalized ISO date (e.g. 2026-02-08)
      due_date: due_date.value,         // normalized ISO date (e.g. 2026-02-22)
      invoice_type: "invoice_statement",
      currency,

      supplier_name: "Ishavskraft", // not in schema; hardcode only if you want
      supplier_website: null,
      supplier_email: null,
      supplier_phone: null,
      supplier_address: null,
      supplier_iban: null,
      supplier_tax_id: null,
      supplier_payment_ref: null,

      ship_to_address: pickAny(entities, MAP.ship_to_address).value,
      customer_name: pickAny(entities, MAP.customer_name).value,

      total_amount: total_amount.value,
      net_amount: null, // not in schema yet

      meter_number: pickAny(entities, MAP.meter_number).value,
      usage_period_kwh: pickAny(entities, MAP.usage_period_kwh).value,
      surcharge: pickAny(entities, MAP.surcharge).value,
      price_area: pickAny(entities, MAP.price_area).value,

      line_items: [], // not in your schema yet
      debug: {
        entities_count: entities.length,
        processor: { projectId: PROJECT_ID, location: LOCATION, processorId: PROCESSOR_ID },
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

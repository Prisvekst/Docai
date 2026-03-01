"use strict";

const express = require("express");
const multer = require("multer");
const { DocumentProcessorServiceClient } = require("@google-cloud/documentai").v1;

const app = express();
app.set("json spaces", 2);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
});

// ---- ENV ----
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
function nvText(nv) {
  if (!nv) return null;
  if (typeof nv === "string") return nv;
  if (typeof nv.text === "string") return nv.text;
  return null;
}

function entityValue(e) {
  if (!e) return null;
  return nvText(e.normalizedValue) || e.mentionText || null;
}

function bestEntity(list, type) {
  const hits = (list || []).filter((e) => e.type === type);
  if (!hits.length) return null;
  hits.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  return hits[0];
}

function pick(list, type) {
  const e = bestEntity(list, type);
  return {
    value: entityValue(e),
    confidence: typeof e?.confidence === "number" ? e.confidence : null,
  };
}

// Flatten nested entities so we can support both “group parent with properties” and “flat” output.
function flattenEntities(entities, prefix = "") {
  const out = [];
  for (const e of entities || []) {
    const type = prefix ? `${prefix}.${e.type || "unknown"}` : (e.type || "unknown");
    out.push({
      type,
      mentionText: e.mentionText || null,
      normalizedText: nvText(e.normalizedValue),
      confidence: typeof e.confidence === "number" ? e.confidence : null,
      _ref: e, // internal
    });
    if (Array.isArray(e.properties) && e.properties.length) {
      out.push(...flattenEntities(e.properties, type));
    }
  }
  return out;
}

// Get a field value from either:
// 1) A group entity's properties (if group exists)
// 2) A flattened entity type path (fallback)
function getFromGroupOrFlat(entities, groupType, fieldType) {
  const group = bestEntity(entities, groupType);
  if (group && Array.isArray(group.properties)) {
    const within = pick(group.properties, fieldType);
    if (within.value !== null && within.value !== undefined && String(within.value).trim() !== "") return within.value;
  }
  // fallback: flat path "Group.field"
  const flat = flattenEntities(entities);
  const hit = flat
    .filter((x) => x.type === `${groupType}.${fieldType}`)
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0];
  return hit ? (hit.normalizedText || hit.mentionText) : null;
}

// Get repeated group items (optional multiple)
function getRepeatedGroupItems(entities, groupType, schemaFields) {
  // Some outputs: multiple group entities with same type
  const groups = (entities || []).filter((e) => e.type === groupType);
  if (!groups.length) return [];

  return groups.map((g) => {
    const props = Array.isArray(g.properties) ? g.properties : [];
    const obj = {};
    for (const f of schemaFields) {
      obj[f] = pick(props, f).value;
    }
    return obj;
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

    // ---- Top-level fields (as per your schema) ----
    const invoice_date = pick(entities, "invoice_date").value;
    const due_date = pick(entities, "due_date").value;
    const invoice_number = pick(entities, "invoice_number").value;

    const total_amount = pick(entities, "total_amount").value;
    const net_amount = pick(entities, "net_amount").value;
    const vat_amount = pick(entities, "vat_amount").value;

    // ---- Groups: Supplier (single) ----
    const supplier = {
      Suppli_name: getFromGroupOrFlat(entities, "Supplier", "Suppli_name"),
      Supplier_address: getFromGroupOrFlat(entities, "Supplier", "Supplier_address"),
      supplier_email: getFromGroupOrFlat(entities, "Supplier", "supplier_email"),
      Supplier_orgnr: getFromGroupOrFlat(entities, "Supplier", "Supplier_orgnr"),
      Supplier_phone: getFromGroupOrFlat(entities, "Supplier", "Supplier_phone"),
    };

    // ---- Groups: Receiver (single) ----
    const receiver = {
      reciever_name: getFromGroupOrFlat(entities, "Reciever", "reciever_name"),
      reciever_address: getFromGroupOrFlat(entities, "Reciever", "reciever_address"),
    };

    // ---- Groups: Meter (optional multiple) ----
    const meterItems = getRepeatedGroupItems(entities, "Meter", [
      "meter_number",
      "meter_adress",
      "grid_area",
      "facility_id",
      "consumption_kwh",
      "estimated_annual_kwh",
      "period_from",
      "period_to",
    ]);

    // ---- Groups: Agreement (single) ----
    const agreement = {
      agreement_name: getFromGroupOrFlat(entities, "Agreement", "agreement_name"),
      agreement_type: getFromGroupOrFlat(entities, "Agreement", "agreement_type"),
      fixed_fee: getFromGroupOrFlat(entities, "Agreement", "fixed_fee"),
      markup_ore: getFromGroupOrFlat(entities, "Agreement", "markup_ore"),
      spot_price_ore: getFromGroupOrFlat(entities, "Agreement", "spot_price_ore"),
    };

    // ---- Groups: Additional_service (optional multiple) ----
    const additional_service = getRepeatedGroupItems(entities, "Additional_service", [
      "service_name",
      "service_amount",
      "service_vat",
    ]);

    // ---- Response in your schema structure ----
    const data = {
      invoice_number,
      invoice_date,
      due_date,
      net_amount,
      vat_amount,
      total_amount,

      Supplier: supplier,
      Reciever: receiver,
      Meter: meterItems,
      Agreement: agreement,
      Additional_service: additional_service,
    };

    // Debug: raw entities (flattened) but without giant references
    const raw_entities = flattenEntities(entities).map((x) => ({
      type: x.type,
      value: x.normalizedText || x.mentionText,
      confidence: x.confidence,
    }));

    return res.json({
      ok: true,
      data,
      raw_entities,
      debug: {
        entities_count: entities.length,
        processor: { projectId: PROJECT_ID, location: LOCATION, processorId: PROCESSOR_ID },
      },
    });
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

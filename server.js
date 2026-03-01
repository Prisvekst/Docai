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

// ---- Helpers ----
function normalizeEntity(e) {
  return {
    type: e?.type ?? null,
    mentionText: e?.mentionText ?? null,
    normalizedValue: e?.normalizedValue ?? null,
    confidence: typeof e?.confidence === "number" ? e.confidence : null,
    properties: Array.isArray(e?.properties)
      ? e.properties.map((p) => ({
          type: p?.type ?? null,
          mentionText: p?.mentionText ?? null,
          normalizedValue: p?.normalizedValue ?? null,
          confidence: typeof p?.confidence === "number" ? p.confidence : null,
        }))
      : [],
  };
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
      return res.status(400).json({
        error: "Missing file. Send multipart/form-data with field name: file",
      });
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

    // ✅ Custom Extractor: alt ligger i document.entities
    const entities = Array.isArray(doc.entities) ? doc.entities : [];

    // DEBUG OUTPUT: viser hva schemaet faktisk heter
    return res.json({
      ok: true,
      processor: { projectId: PROJECT_ID, location: LOCATION, processorId: PROCESSOR_ID },
      file: { originalname: req.file.originalname, bytes: req.file.size, mimeType: req.file.mimetype },
      entities_count: entities.length,
      raw_entities: entities.map(normalizeEntity),
      // Hvis du vil sjekke at teksten finnes (for OCR), slå på:
      // text_preview: (doc.text || "").slice(0, 1200),
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

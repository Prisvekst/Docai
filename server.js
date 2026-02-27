const express = require("express");
const multer = require("multer");
const { DocumentProcessorServiceClient } = require("@google-cloud/documentai").v1;

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const PROJECT_ID = process.env.PROJECT_ID;
const LOCATION = process.env.LOCATION || "eu";
const PROCESSOR_ID = process.env.PROCESSOR_ID;

// Litt enkel “nøkkel” så ikke hvem som helst kan bruke API-et ditt:
const API_KEY = process.env.API_KEY;

const client = new DocumentProcessorServiceClient({
  apiEndpoint: "eu-documentai.googleapis.com",
  credentials: JSON.parse(process.env.GCP_SA_JSON),
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/process-invoice", upload.single("file"), async (req, res) => {
  try {
    if (API_KEY && req.header("x-api-key") !== API_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!req.file) return res.status(400).json({ error: "Missing file (field name must be 'file')" });

    const name = `projects/${PROJECT_ID}/locations/${LOCATION}/processors/${PROCESSOR_ID}`;

    const request = {
      name,
      rawDocument: {
        content: req.file.buffer.toString("base64"),
        mimeType: req.file.mimetype || "application/pdf",
      },
    };

    const [result] = await client.processDocument(request);
    const doc = result.document;

    const entities = (doc.entities || []).map((e) => ({
      type: e.type,
      mentionText: e.mentionText,
      normalizedValue: e.normalizedValue || null,
      confidence: e.confidence,
    }));

    res.json({ entities });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err), code: err.code, details: err.details });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`Running on port ${port}`));
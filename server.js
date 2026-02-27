"use strict";

const express = require("express");
const multer = require("multer");
const { DocumentProcessorServiceClient } = require("@google-cloud/documentai").v1;

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
});

const PROJECT_ID = process.env.PROJECT_ID;
const LOCATION = process.env.LOCATION || "eu";
const PROCESSOR_ID = process.env.PROCESSOR_ID;
const API_KEY = process.env.API_KEY || null;

// EU multi-region krever EU endpoint
const client = new DocumentProcessorServiceClient({
  apiEndpoint: LOCATION === "eu" ? "eu-documentai.googleapis.com" : undefined,
  credentials: process.env.GCP_SA_JSON ? JSON.parse(process.env.GCP_SA_JSON) : undefined,
});

// ----------------- helpers -----------------
function normalizeText(t) {
  return String(t || "")
    .replace(/\r\n/g, "\n")
    .replace(/\u00A0/g, " ") // non-breaking space
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

function firstMatch(text, patterns) {
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

function cleanSpaces(s) {
  return s ? s.replace(/[ \t]+/g, " ").trim() : null;
}

function cleanPhone(s) {
  if (!s) return null;
  // keep digits + spaces
  const x = s.replace(/[^\d ]+/g, "").replace(/\s{2,}/g, " ").trim();
  return x || null;
}

function cleanCurrency(s) {
  if (!s) return null;
  // You wanted "kr" specifically; we normalize common variants
  const x = s.toLowerCase();
  if (x.includes("kr")) return "kr";
  if (x.includes("nok")) return "kr";
  if (x.includes("sek")) return "kr"; // if you really want "kr" even when SEK
  return "kr";
}

function toIsoDate(s) {
  if (!s) return null;
  // Accept: 2026-02-08, 08.02.2026, 08/02/2026, 8.2.2026
  const iso = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const dmy = s.match(/(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})/);
  if (dmy) {
    const dd = String(dmy[1]).padStart(2, "0");
    const mm = String(dmy[2]).padStart(2, "0");
    const yyyy = dmy[3];
    return `${yyyy}-${mm}-${dd}`;
  }
  return null;
}

function stripNumberLike(s) {
  // keep digits only (useful for payment ref)
  return s ? s.replace(/[^\d]/g, "") : null;
}

function amountAsText(s) {
  // You want amounts like "3.460,60" as text. Keep original formatting-ish, but trim.
  return s ? cleanSpaces(s) : null;
}

// --- DocAI entity helpers (optional assist) ---
function bestEntity(doc, type) {
  const ents = Array.isArray(doc?.entities) ? doc.entities : [];
  const hits = ents.filter((e) => e.type === type);
  if (!hits.length) return null;
  hits.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  return hits[0];
}
function entityText(e) {
  if (!e) return null;
  if (e.normalizedValue && typeof e.normalizedValue === "object" && typeof e.normalizedValue.text === "string") {
    return e.normalizedValue.text.trim();
  }
  return (e.mentionText || "").trim() || null;
}

// ----------------- Field extractors (ONLY your chosen fields) -----------------
function extractInvoiceId(doc, text) {
  // Prefer DocAI
  const fromAi = entityText(bestEntity(doc, "invoice_id"));
  if (fromAi) return stripNumberLike(fromAi) || fromAi;

  // Regex: Fakturanr / Invoice id
  const v = firstMatch(text, [
    /Faktura(?:nummer|nr)\.?\s*[:\-]?\s*([0-9]{5,20})/i,
    /Fakturanr\.?\s*[:\-]?\s*([0-9]{5,20})/i,
    /Invoice(?:\s*ID|\s*No\.?)\s*[:\-]?\s*([0-9]{5,20})/i,
  ]);
  return v ? stripNumberLike(v) : null;
}

function extractInvoiceDate(doc, text) {
  const fromAi = entityText(bestEntity(doc, "invoice_date"));
  const isoAi = toIsoDate(fromAi);
  if (isoAi) return isoAi;

  const v = firstMatch(text, [
    /Fakturadato\s*[:\-]?\s*([0-9]{1,2}[.\-/][0-9]{1,2}[.\-/][0-9]{4})/i,
    /Fakturadato\s*[:\-]?\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/i,
    /Dato\s*[:\-]?\s*([0-9]{1,2}[.\-/][0-9]{1,2}[.\-/][0-9]{4})/i,
  ]);
  return toIsoDate(v);
}

function extractCurrency(doc, text) {
  const fromAi = entityText(bestEntity(doc, "currency"));
  if (fromAi) return cleanCurrency(fromAi);

  // find "kr" or "NOK" in totals/summary areas
  const v = firstMatch(text, [
    /\b(NOK|SEK|DKK|kr)\b/i,
  ]);
  return cleanCurrency(v);
}

function extractSupplierName(doc, text) {
  const fromAi = entityText(bestEntity(doc, "supplier_name"));
  if (fromAi) return fromAi;

  // Fallback: first big-ish header line (very light heuristic)
  const v = firstMatch(text, [
    /^\s*([A-ZÆØÅ][A-Za-zÆØÅæøå \-]{2,40})\s*$/m,
  ]);
  return v;
}

function extractSupplierAddress(doc, text) {
  const fromAi = entityText(bestEntity(doc, "supplier_address"));
  if (fromAi) return cleanSpaces(fromAi);

  // Typical: "Postboks 6116, 9291 Tromsø" etc.
  const v = firstMatch(text, [
    /(Postboks\s+\d+,\s*\d{4}\s*[A-Za-zÆØÅæøå\- ]+)/i,
    /([A-Za-zÆØÅæøå\- ]+\s+\d{1,4},\s*\d{4}\s*[A-Za-zÆØÅæøå\- ]+)/i,
  ]);
  return cleanSpaces(v);
}

function extractSupplierWebsite(text) {
  const v = firstMatch(text, [
    /\b((?:www\.)[a-z0-9\-]+\.[a-z]{2,}(?:\.[a-z]{2,})?)\b/i,
    /\b([a-z0-9\-]+\.[a-z]{2,}(?:\.[a-z]{2,})?)\b/i,
  ]);
  // Prefer ishavskraft domain if multiple:
  if (!v) return null;
  // If it doesn't include www., keep as seen
  return v.toLowerCase();
}

function extractSupplierEmail(text) {
  const v = firstMatch(text, [
    /\b([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/i,
  ]);
  return v ? v.toLowerCase() : null;
}

function extractSupplierPhone(text) {
  // Norwegian phone: 8 digits, often spaced 2-2-2-2
  const v = firstMatch(text, [
    /(?:Telefon|Tlf\.?)\s*[:\-]?\s*([0-9 ][0-9 ]{7,14})/i,
    /\b([0-9]{2}\s?[0-9]{2}\s?[0-9]{2}\s?[0-9]{2})\b/,
  ]);
  return cleanPhone(v);
}

function extractSupplierIban(text) {
  // Norway IBAN starts with NO + 13 digits (15 chars total)
  const v = firstMatch(text, [
    /\b(NO\d{13})\b/i,
    /\b([A-Z]{2}\d{13,30})\b/i, // generic IBAN fallback
  ]);
  return v ? v.toUpperCase() : null;
}

function extractSupplierTaxId(text) {
  // e.g. NO979139268MVA
  const v = firstMatch(text, [
    /\b(NO\s?\d{9}\s?MVA)\b/i,
    /\b(\d{9}\s?MVA)\b/i,
  ]);
  if (!v) return null;
  return v.replace(/\s+/g, "").toUpperCase().startsWith("NO") ? v.replace(/\s+/g, "").toUpperCase() : ("NO" + v.replace(/\s+/g, "").toUpperCase());
}

function extractSupplierPaymentRef(text) {
  // Often labeled KID / betalingsreferanse / referanse
  const v = firstMatch(text, [
    /KID\s*[:\-]?\s*([0-9][0-9 \-]{6,40})/i,
    /Betalingsreferanse\s*[:\-]?\s*([0-9][0-9 \-]{6,40})/i,
    /Referanse\s*[:\-]?\s*([0-9][0-9 \-]{6,40})/i,
  ]);
  return v ? stripNumberLike(v) : null;
}

function extractShipToAddress(text) {
  // Look for "Leveringsadresse" block
  const m = text.match(/Leveringsadresse\s*[:\-]?\s*([\s\S]{0,200})/i);
  if (!m) return null;

  // Take next 1–2 lines that look like address
  const after = m[1].trim();
  const lines = after.split("\n").map((x) => x.trim()).filter(Boolean);
  if (!lines.length) return null;

  // Often: "Evjenvegen 77" on one line and "9024 TOMASJORD 3" on next
  const candidate = lines.slice(0, 2).join(" ");
  return cleanSpaces(candidate);
}

function extractTotalAmount(doc, text) {
  const fromAi = entityText(bestEntity(doc, "total_amount"));
  if (fromAi) return amountAsText(fromAi);

  // Try find "Å betale" or "Total" near end
  const v = firstMatch(text, [
    /Å\s*betale\s*[:\-]?\s*([0-9][0-9.\s]*[,\.]\d{2})/i,
    /Total(?:beløp)?\s*[:\-]?\s*([0-9][0-9.\s]*[,\.]\d{2})/i,
  ]);
  return amountAsText(v);
}

function extractNetAmount(doc, text) {
  const fromAi = entityText(bestEntity(doc, "net_amount"));
  if (fromAi) return amountAsText(fromAi);

  // Some invoices show "Nettobeløp" / "Netto"
  const v = firstMatch(text, [
    /Nettobeløp\s*[:\-]?\s*([0-9][0-9.\s]*[,\.]\d{2})/i,
    /\bNetto\s*[:\-]?\s*([0-9][0-9.\s]*[,\.]\d{2})/i,
  ]);
  return amountAsText(v);
}

// -------- line items parsing (ONLY your chosen line_item list) --------
// We scan lines that look like: "Spotpris 2517,29 kWh 79,4891 2.000,97"
// or "Energiledd nettleie dag 1712,75 kWh 23,10 øre/kWh 395,65"
// We keep them as strings exactly (as you requested).
function extractLineItems(text) {
  const lines = normalizeText(text).split("\n").map((l) => l.trim()).filter(Boolean);

  const items = [];
  for (const line of lines) {
    // Heuristic: must contain either kWh or "mnd" and end with an amount
    const hasQty = /\bkWh\b/i.test(line) || /\bmnd\b/i.test(line);
    const endsWithAmount = /(-?\d[\d.\s]*[,\.]\d{2})\s*$/.test(line);

    if (!hasQty || !endsWithAmount) continue;

    // Filter out obvious non-items:
    if (/sum|totalt|å betale|mva|merverdiavgift|fakturadato|forfallsdato/i.test(line)) continue;

    // Keep it as-is, but normalize spaces
    items.push(cleanSpaces(line));
  }

  // De-duplicate
  return Array.from(new Set(items));
}

// ----------------- routes -----------------
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
    const doc = result.document;
    const text = normalizeText(doc?.text || "");

    // Build EXACT output structure you requested
    const out = {
      invoice_id: extractInvoiceId(doc, text),
      invoice_date: extractInvoiceDate(doc, text),
      invoice_type: "invoice_statement",
      currency: extractCurrency(doc, text) || "kr",

      supplier_name: extractSupplierName(doc, text),
      supplier_website: extractSupplierWebsite(text),
      supplier_email: extractSupplierEmail(text),
      supplier_phone: extractSupplierPhone(text),
      supplier_address: extractSupplierAddress(doc, text),
      supplier_iban: extractSupplierIban(text),
      supplier_tax_id: extractSupplierTaxId(text),
      supplier_payment_ref: extractSupplierPaymentRef(text),

      ship_to_address: extractShipToAddress(text),

      total_amount: extractTotalAmount(doc, text),
      net_amount: extractNetAmount(doc, text),

      line_items: extractLineItems(text),
    };

    return res.json(out);
  } catch (err) {
    return res.status(500).json({
      error: err.message || String(err),
      code: err.code,
      details: err.details,
    });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`Running on port ${port}`));

// lib/renderTemplate.js
const fs = require("fs");
const path = require("path");

const CACHE = new Map();

function loadTemplate(file) {
  const abs = path.resolve(__dirname, "..", "templates", file);
  if (CACHE.has(abs)) return CACHE.get(abs);
  const raw = fs.readFileSync(abs, "utf8");
  CACHE.set(abs, raw);
  return raw;
}

/**
 * Very small mustache-like renderer:
 * - Replaces {{key}} with string values from data
 * - Leaves unknown tags as empty string
 * - You can pre-build complex HTML (e.g., lists) and pass as strings
 */
function renderTemplate(file, data = {}) {
  const tpl = loadTemplate(file);
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const parts = key.split(".");
    let v = data;
    for (const p of parts) v = v?.[p];
    return v === undefined || v === null ? "" : String(v);
  });
}

module.exports = { renderTemplate };

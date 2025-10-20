// lib/fmt.js
const path = require("path");

function pbFileUrl(base, collectionId, recordId, fileName) {
  if (!base) base = process.env.PB_HOST;
  return `${base.replace(
    /\/$/,
    ""
  )}/api/files/${collectionId}/${recordId}/${encodeURIComponent(fileName)}`;
}

function fmtD(d) {
  try {
    return new Date(d).toLocaleDateString();
  } catch {
    return "";
  }
}

function validateAndFormatPhoneNumber(phone = "") {
  const digits = (phone || "").replace(/\D/g, "");
  if (digits.length !== 10) return null;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 10)}`;
}

module.exports = { pbFileUrl, fmtD, validateAndFormatPhoneNumber };

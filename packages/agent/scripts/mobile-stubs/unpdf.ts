// Mobile bundle stub for PDF extraction, which is excluded from the on-device
// agent runtime.
"use strict";

function unavailable() {
  throw new Error("PDF extraction is unavailable in the mobile agent bundle");
}

module.exports = {
  extractText: unavailable,
  getDocumentProxy: unavailable,
};

"use strict";

function unavailable() {
  throw new Error("PDF extraction is unavailable in the mobile agent bundle");
}

module.exports = {
  extractText: unavailable,
  getDocumentProxy: unavailable,
};

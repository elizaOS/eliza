// Mobile bundle stub for DOCX extraction, which is not shipped into the
// on-device agent runtime.
"use strict";

async function extractRawText() {
  throw new Error("DOCX extraction is unavailable in the mobile agent bundle");
}

module.exports = {
  extractRawText,
};

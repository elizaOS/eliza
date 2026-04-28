// sharp stub for the mobile agent bundle.
"use strict";

const NOT_AVAILABLE_MSG =
  "sharp is not available in the Android mobile bundle — use a JS-only image path or skip the operation";

function unavailable() {
  throw new Error(NOT_AVAILABLE_MSG);
}

const sharp = function sharp() {
  return unavailable();
};
sharp.cache = () => sharp;
sharp.concurrency = () => 1;
sharp.simd = () => false;
sharp.format = {};
sharp.versions = {};

module.exports = sharp;
module.exports.default = sharp;
module.exports.__mobileStub = true;

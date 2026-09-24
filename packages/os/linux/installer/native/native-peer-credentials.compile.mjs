import assert from "node:assert/strict";
import { createRequire } from "node:module";

const addonPath = process.argv[2];
if (!addonPath) throw new Error("native addon path is required");
const binding = createRequire(import.meta.url)(addonPath);
assert.equal(typeof binding.capture, "function");
assert.throws(() => binding.capture(-1), /non-negative/);

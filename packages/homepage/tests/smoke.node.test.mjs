// Source-level smoke: don't import the React tree (pulls three.js, etc.); just
// assert the entry module exports a default function via static inspection.
// Runs under `node --test` so the homepage `test` script exits clean without
// adding vitest as a dep.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const marketingPath = resolve(__dirname, "../src/pages/marketing.tsx");

test("marketing.tsx exports a default function component", () => {
  const src = readFileSync(marketingPath, "utf8");
  assert.match(
    src,
    /export\s+default\s+function\s+\w+/,
    "expected `export default function ...` in marketing.tsx",
  );
});

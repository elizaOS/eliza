/**
 * Source-level smoke test for the marketing page export without importing the React tree.
 *
 * The package test script runs under node:test, so this avoids pulling three.js
 * or adding Vitest just to confirm the entry component remains exportable.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const marketingPath = resolve(__dirname, "../src/pages/marketing.tsx");
const globalStylesPath = resolve(__dirname, "../src/index.css");

test("marketing.tsx exports a default function component", () => {
  const src = readFileSync(marketingPath, "utf8");
  assert.match(
    src,
    /export\s+default\s+function\s+\w+/,
    "expected `export default function ...` in marketing.tsx",
  );
});

test("reduced-motion keeps functional loading indicators animated", () => {
  const css = readFileSync(globalStylesPath, "utf8");
  const reducedMotionStart = css.indexOf(
    "@media (prefers-reduced-motion: reduce)",
  );

  assert.notEqual(
    reducedMotionStart,
    -1,
    "expected a reduced-motion override block",
  );
  const reducedMotionBlock = css.slice(reducedMotionStart);
  assert.match(reducedMotionBlock, /\.animate-spin/);
  assert.match(reducedMotionBlock, /\[class~="animate-spin"\]/);
  assert.match(reducedMotionBlock, /\[role="progressbar"\]/);
  assert.match(reducedMotionBlock, /animation-duration:\s*1s\s*!important/);
  assert.match(
    reducedMotionBlock,
    /animation-iteration-count:\s*infinite\s*!important/,
  );
});

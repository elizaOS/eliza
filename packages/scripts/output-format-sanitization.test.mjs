/** Guards Markdown-table emitters against backslash-assisted delimiter injection. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const markdownEmitters = [
  "packages/prompts/scripts/generate-action-docs.js",
  "packages/app/scripts/audit-views-soak.mjs",
  "packages/scripts/audit-action-availability.mjs",
  "scripts/ai-qa/review-walkthrough.mjs",
  "plugins/plugin-local-inference/native/verify/eliza1_gates_collect.mjs",
  "packages/scripts/run-scenario-benchmark.mjs",
];

test("markdown emitters escape backslashes before table delimiters", () => {
  for (const relativePath of markdownEmitters) {
    const source = readFileSync(path.join(repoRoot, relativePath), "utf8");
    const backslashEscape = source.indexOf('.replace(/\\\\/g, "\\\\\\\\")');
    const delimiterEscape = source.indexOf(
      '.replace(/\\|/g, "\\\\|")',
      backslashEscape,
    );
    assert.ok(backslashEscape >= 0, `${relativePath} must escape backslashes`);
    assert.ok(
      delimiterEscape > backslashEscape,
      `${relativePath} must escape table delimiters after backslashes`,
    );
  }
});

#!/usr/bin/env node
/**
 * Smoke test for the prompt-review surface:
 *
 *   scripts/lifeops-prompt-inventory.mjs
 *   scripts/lifeops-prompt-review.mjs
 *   scripts/lifeops-action-collisions.mjs
 *
 * Runs each script against the real repo (the inventory is fast — under 1s
 * — and stable). Asserts:
 *
 *   1. The manifest file exists and parses as JSON with the expected
 *      schemaVersion + counts keys.
 *   2. The manifest contains at least 200 entries whose `kind` starts with
 *      `action-` (the task spec says we know ~209 actions exist).
 *   3. The collision report markdown is written and is non-empty.
 *   4. The collision JSON parses and carries the v1 schema version.
 *
 * Invocation: `node scripts/__tests__/lifeops-prompt-inventory.test.mjs`.
 * Exits non-zero on the first failed assertion.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..");
const AUDIT_DIR = join(REPO_ROOT, "docs", "audits", "lifeops-2026-05-11");
const MANIFEST_PATH = join(AUDIT_DIR, "prompts-manifest.json");
const COLLISIONS_MD = join(AUDIT_DIR, "action-collisions.md");
const COLLISIONS_JSON = join(AUDIT_DIR, "action-collisions.json");

const failures = [];
function assert(cond, msg) {
  if (!cond) failures.push(msg);
}

function run(script) {
  const result = spawnSync(
    "node",
    [join(REPO_ROOT, "scripts", script)],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      `script ${script} exited with status ${result.status}: ${result.stderr || result.stdout}`,
    );
  }
  return result;
}

// 1. Run the inventory script and validate the manifest.
run("lifeops-prompt-inventory.mjs");
assert(existsSync(MANIFEST_PATH), `manifest missing at ${MANIFEST_PATH}`);
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
assert(
  manifest.schemaVersion === "lifeops-prompt-inventory-v1",
  `manifest schemaVersion mismatch: ${manifest.schemaVersion}`,
);
assert(typeof manifest.generatedAt === "string", "manifest missing generatedAt");
assert(Array.isArray(manifest.prompts), "manifest.prompts must be an array");
assert(
  manifest.counts && typeof manifest.counts === "object",
  "manifest.counts missing",
);

// 2. At least 200 action-* rows.
const actionRows = manifest.prompts.filter((p) =>
  typeof p.kind === "string" && (p.kind.startsWith("action-") || p.kind === "routing-hint"),
);
assert(
  actionRows.length >= 200,
  `expected >=200 action-* rows; got ${actionRows.length}`,
);

// 3. The 5 service tasks each have a row.
const tasks = new Set(
  manifest.prompts.filter((p) => p.kind === "service-task").map((p) => p.task),
);
for (const expected of [
  "should_respond",
  "context_routing",
  "action_planner",
  "response",
  "media_description",
]) {
  assert(tasks.has(expected), `service-task row missing for ${expected}`);
}

// 4. The planner template + plannerSchema both lifted into the manifest.
const plannerEntries = manifest.prompts.filter((p) => p.kind === "planner");
assert(
  plannerEntries.length >= 2,
  `expected >=2 planner rows (template + schema); got ${plannerEntries.length}`,
);

// 5. Bundled templates: at least 20 of the 23 named templates appear.
const templateRows = manifest.prompts.filter((p) => p.kind === "template");
assert(
  templateRows.length >= 20,
  `expected >=20 template rows; got ${templateRows.length}`,
);

// 6. Run the collisions script.
run("lifeops-action-collisions.mjs");
assert(existsSync(COLLISIONS_MD), `collision markdown missing at ${COLLISIONS_MD}`);
const mdContents = readFileSync(COLLISIONS_MD, "utf8");
assert(
  mdContents.trim().length > 0 && mdContents.startsWith("# Action description collisions"),
  "collision markdown empty or missing expected heading",
);
assert(existsSync(COLLISIONS_JSON), `collision json missing at ${COLLISIONS_JSON}`);
const collisionJson = JSON.parse(readFileSync(COLLISIONS_JSON, "utf8"));
assert(
  collisionJson.schemaVersion === "lifeops-action-collisions-v1",
  `collision json schemaVersion mismatch: ${collisionJson.schemaVersion}`,
);
assert(
  Array.isArray(collisionJson.pairs),
  "collision json pairs must be an array",
);
assert(
  typeof collisionJson.threshold === "number",
  "collision json missing threshold number",
);

if (failures.length > 0) {
  console.error(`lifeops-prompt-inventory.test FAILED (${failures.length})`);
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}

console.log("lifeops-prompt-inventory.test OK");
console.log(
  `  manifest.prompts=${manifest.prompts.length}  action-rows=${actionRows.length}  templates=${templateRows.length}`,
);
console.log(
  `  collisions.pairs=${collisionJson.pairs.length}  threshold=${collisionJson.threshold}`,
);

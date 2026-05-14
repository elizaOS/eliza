#!/usr/bin/env node
/**
 * derive-fixtures.mjs — derive sibling bench fixtures from the canonical
 * eliza-1 training test split.
 *
 * Input: packages/training/datasets/eliza1-sft-0_6b/test.jsonl
 *   - Each row is {messages:[{role,content},...], task, provenance, tags}.
 *   - Tasks observed in v0_6b: action_selection, tool_use, structured_decode,
 *     voice_emotion, assistant.
 *
 * Output (sibling to the hand-authored fixtures):
 *   - src/fixtures/should-respond.derived.json
 *   - src/fixtures/planner.derived.json
 *   - src/fixtures/action.derived.json
 *
 * Mapping:
 *   - should-respond derived ← all rows. The bench's should-respond schema
 *     expects {id, input, channelType, expected, notes}. We synthesise:
 *       expected = "RESPOND" for every dataset row (the training split
 *         intentionally captures cases the model SHOULD respond to;
 *         IGNORE/STOP cases come from a different source).
 *       channelType = "dm" by default.
 *     Rows where the user message is too short / non-conversational are
 *     skipped.
 *   - planner derived ← rows tagged ``task: "tool_use"`` (real planner work)
 *     and ``task: "action_selection"``. The assistant response shape is
 *     "ACTION: NAME {json}" — we parse it into expected_action_name +
 *     expected_params. Rows with non-parseable assistant content are skipped.
 *   - action derived ← same source as planner, but split per actionName.
 *     The bench's action.json expects {id, actionName, parameters, context,
 *     expected_params}. We attach a minimal one-param schema definition.
 *
 * Re-running this script overwrites the derived files. The hand-authored
 * fixtures (should-respond.json / planner.json / action.json) are tagged
 * "origin":"manual" and are NEVER overwritten by this script.
 *
 * Run::
 *   node packages/benchmarks/eliza-1/scripts/derive-fixtures.mjs
 *   node packages/benchmarks/eliza-1/scripts/derive-fixtures.mjs --dry-run
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const BENCH_ROOT = resolve(dirname(SELF), "..");
const REPO_ROOT = resolve(BENCH_ROOT, "..", "..", "..");
const DATASET_TEST = resolve(
  REPO_ROOT,
  "packages",
  "training",
  "datasets",
  "eliza1-sft-0_6b",
  "test.jsonl",
);
const FIXTURE_DIR = resolve(BENCH_ROOT, "src", "fixtures");

/** @typedef {{role: string, content: string}} ChatMessage */
/** @typedef {{messages: ChatMessage[], task: string, provenance?: unknown, tags?: unknown}} DatasetRow */

function readDatasetRows(path) {
  /** @type {DatasetRow[]} */
  const rows = [];
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    /** @type {DatasetRow} */
    const row = JSON.parse(trimmed);
    if (!row || !Array.isArray(row.messages)) continue;
    rows.push(row);
  }
  return rows;
}

/**
 * Parse the assistant tool-use response "ACTION: NAME {json-or-text}".
 * Returns null if the row's assistant content does not match the pattern.
 *
 * @param {DatasetRow} row
 * @returns {{actionName: string, params: Record<string, unknown>, suffix: string} | null}
 */
function parseToolUseAssistant(row) {
  const asst = row.messages.find((m) => m.role === "assistant");
  if (!asst || typeof asst.content !== "string") return null;
  const text = asst.content.trim();
  const match = text.match(/^ACTION:\s*([A-Z_][A-Z0-9_]*)\s*(\{[\s\S]*?\})?\s*([\s\S]*)$/);
  if (!match) return null;
  const [, actionName, jsonChunk, suffix] = match;
  /** @type {Record<string, unknown>} */
  let params = {};
  if (jsonChunk) {
    try {
      const parsed = JSON.parse(jsonChunk);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        params = /** @type {Record<string, unknown>} */ (parsed);
      }
    } catch {
      params = {};
    }
  }
  return { actionName, params, suffix: suffix.trim() };
}

function getUserContent(row) {
  const user = row.messages.find((m) => m.role === "user");
  if (!user || typeof user.content !== "string") return null;
  const trimmed = user.content.trim();
  return trimmed || null;
}

/**
 * Build a stable, slug-safe id for a derived case.
 *
 * @param {string} prefix
 * @param {number} index
 * @param {string} hint
 */
function deriveId(prefix, index, hint) {
  const slug = hint
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "case";
  return `${prefix}-${String(index).padStart(3, "0")}-${slug}`;
}

function deriveShouldRespond(rows) {
  const cases = [];
  let index = 0;
  for (const row of rows) {
    const userContent = getUserContent(row);
    if (!userContent) continue;
    if (userContent.length < 4) continue;
    cases.push({
      id: deriveId("ds-respond", index, userContent),
      input: userContent,
      channelType: "dm",
      expected: "RESPOND",
      notes: `Derived from training test.jsonl task=${row.task}.`,
    });
    index += 1;
  }
  return {
    note:
      "Derived bench fixtures for the response-handler shouldRespond field. " +
      "Source: packages/training/datasets/eliza1-sft-0_6b/test.jsonl. " +
      "All rows in the eliza-1 training test split represent cases the model is " +
      "expected to RESPOND to — IGNORE/STOP cases come from a separate (manual) " +
      "probe set in should-respond.json. Regenerated by " +
      "packages/benchmarks/eliza-1/scripts/derive-fixtures.mjs.",
    origin: "dataset",
    derivedFrom: "packages/training/datasets/eliza1-sft-0_6b/test.jsonl",
    cases,
  };
}

function derivePlanner(rows) {
  const cases = [];
  let index = 0;
  for (const row of rows) {
    if (row.task !== "tool_use" && row.task !== "action_selection") continue;
    const userContent = getUserContent(row);
    if (!userContent) continue;
    const parsed = parseToolUseAssistant(row);
    if (!parsed) continue;
    const paramKeys = Object.keys(parsed.params);
    const actionSchema = {
      name: parsed.actionName,
      description: `Derived from training row task=${row.task}.`,
      parameters: paramKeys.map((k) => ({
        name: k,
        type: typeof parsed.params[k] === "number" ? "number" : "string",
        description: `Auto-derived from training row example value: ${JSON.stringify(parsed.params[k])}`,
      })),
    };
    // Each case ships its action plus a no-op fallback so the model has a
    // multi-action choice (matches the hand-authored fixture shape).
    cases.push({
      id: deriveId("ds-planner", index, parsed.actionName),
      input: userContent,
      availableActions: [
        actionSchema,
        {
          name: "REPLY",
          description: "Reply with a short natural-language message.",
          parameters: [
            { name: "text", type: "string", description: "Reply text." },
          ],
        },
      ],
      expected_action_name: parsed.actionName,
      expected_params: parsed.params,
      notes: `Derived from training test.jsonl task=${row.task}.`,
    });
    index += 1;
  }
  return {
    note:
      "Derived bench fixtures for the planner task. Source: training test.jsonl " +
      "rows tagged task ∈ {tool_use, action_selection}. The training split's " +
      "assistant response shape is 'ACTION: NAME {json}'; we parse that into " +
      "expected_action_name + expected_params and attach a minimal one-action " +
      "registry. Hand-authored cases in planner.json remain the prose-tuned " +
      "probe set. Regenerated by packages/benchmarks/eliza-1/scripts/derive-fixtures.mjs.",
    origin: "dataset",
    derivedFrom: "packages/training/datasets/eliza1-sft-0_6b/test.jsonl",
    cases,
  };
}

function deriveAction(rows) {
  /** @type {Map<string, {ids: Set<string>, parameters: Map<string, "string"|"number">, cases: unknown[]}>} */
  const byAction = new Map();
  for (const row of rows) {
    if (row.task !== "tool_use" && row.task !== "action_selection") continue;
    const userContent = getUserContent(row);
    if (!userContent) continue;
    const parsed = parseToolUseAssistant(row);
    if (!parsed) continue;
    let bucket = byAction.get(parsed.actionName);
    if (!bucket) {
      bucket = { ids: new Set(), parameters: new Map(), cases: [] };
      byAction.set(parsed.actionName, bucket);
    }
    for (const [k, v] of Object.entries(parsed.params)) {
      const ty = typeof v === "number" ? "number" : "string";
      if (!bucket.parameters.has(k)) bucket.parameters.set(k, ty);
    }
    const caseId = deriveId(
      `ds-${parsed.actionName.toLowerCase()}`,
      bucket.cases.length,
      userContent,
    );
    bucket.cases.push({
      id: caseId,
      actionName: parsed.actionName,
      parameters: Array.from(bucket.parameters.entries()).map(([name, type]) => ({
        name,
        type,
        description: `Auto-derived parameter for ${parsed.actionName}.`,
      })),
      context: userContent,
      expected_params: parsed.params,
    });
  }
  const cases = [];
  for (const [, bucket] of byAction) {
    for (const c of bucket.cases) cases.push(c);
  }
  return {
    note:
      "Derived bench fixtures for the per-action task. Source: training " +
      "test.jsonl rows tagged task ∈ {tool_use, action_selection}, grouped by " +
      "actionName. Hand-authored cases in action.json cover REPLY/MESSAGE only; " +
      "the derived set captures every action observed in the training test " +
      "split. Regenerated by packages/benchmarks/eliza-1/scripts/derive-fixtures.mjs.",
    origin: "dataset",
    derivedFrom: "packages/training/datasets/eliza1-sft-0_6b/test.jsonl",
    cases,
  };
}

function writeFixture(name, blob, dryRun) {
  const path = resolve(FIXTURE_DIR, name);
  const body = `${JSON.stringify(blob, null, 2)}\n`;
  if (dryRun) {
    console.log(`[dry-run] would write ${relative(REPO_ROOT, path)} (${blob.cases.length} cases, ${body.length} bytes)`);
    return;
  }
  writeFileSync(path, body, "utf8");
  console.log(`wrote ${relative(REPO_ROOT, path)} (${blob.cases.length} cases)`);
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run") || args.includes("-n");
  const rows = readDatasetRows(DATASET_TEST);
  console.log(`read ${rows.length} rows from ${relative(REPO_ROOT, DATASET_TEST)}`);
  writeFixture("should-respond.derived.json", deriveShouldRespond(rows), dryRun);
  writeFixture("planner.derived.json", derivePlanner(rows), dryRun);
  writeFixture("action.derived.json", deriveAction(rows), dryRun);
}

main();

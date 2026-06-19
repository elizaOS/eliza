/**
 * GEPA / bootstrap-fewshot run for the view-switching action_planner task against
 * a local eliza-1 model via the eliza llama.cpp fork's `llama-server` (NOT Ollama
 * — see lib/llamacpp.ts). Uses the REAL harness optimizers + the view-aware
 * `scorePlannerAction`. Schema-constrained decoding mirrors production guided
 * decode, so this measures SEMANTIC routing (does the model pick VIEWS + the
 * right view), not whether it can emit JSON unaided.
 *
 * Start a server (one model per server), then run:
 *   LLAMACPP_URL=http://127.0.0.1:8080 LABEL=eliza-1-2b \
 *     bun run plugins/plugin-training/scripts/gepa-view-switching.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPromptScorer,
  runBootstrapFewshot,
  runGepa,
  scorePlannerAction,
} from "../src/optimizers/index.js";
import type { OptimizationExample } from "../src/optimizers/types.js";
import { LLAMACPP_URL, llamacppAdapter } from "./lib/llamacpp.js";

const LABEL = process.env.LABEL ?? "llamacpp";
const DATASET = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "optimizers",
  "__fixtures__",
  "view-switching.action_planner.jsonl",
);
const TMP_OUT = "/tmp/gepa-view-switching";
const VIEW_IDS = [
  "calendar",
  "inbox",
  "wallet",
  "finances",
  "todos",
  "goals",
  "health",
  "documents",
  "relationships",
  "focus",
  "companion",
  "task-coordinator",
  "none",
];
// Planner tool-call JSON schema, action/view enum-locked. Mirrors the GBNF the
// production local engine installs for the planner.
const SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["VIEWS", "REPLY"] },
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["show"] },
        view: { type: "string", enum: VIEW_IDS },
      },
    },
    thought: { type: "string" },
  },
  required: ["action"],
};

function load(): OptimizationExample[] {
  return readFileSync(DATASET, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const r = JSON.parse(l) as {
        request: { messages: Array<{ content: string }> };
        response: { text: string };
      };
      return {
        input: { user: r.request.messages.at(-1)?.content ?? "" },
        expectedOutput: r.response.text,
      };
    });
}

const BASELINE =
  "You are the action planner. Choose the next action for the user's message and output it as JSON.";

async function main() {
  mkdirSync(TMP_OUT, { recursive: true });
  const dataset = load();
  const adapter = llamacppAdapter(SCHEMA);
  console.log(`[${LABEL}] dataset: ${dataset.length} rows | ${LLAMACPP_URL}`);
  const scorer = createPromptScorer(adapter, {
    compare: scorePlannerAction,
    maxTokens: 80,
  });
  const baseline = await scorer(BASELINE, dataset);
  const boot = await runBootstrapFewshot({
    baselinePrompt: BASELINE,
    dataset,
    scorer,
    llm: adapter,
    options: { k: 6, rankByScorer: true },
  });
  const gepa = await runGepa({
    baselinePrompt: BASELINE,
    dataset,
    scorer,
    llm: adapter,
    options: { population: 8, generations: 5, scoringSubset: dataset.length },
  });
  console.log(
    `[${LABEL}] baseline=${baseline.toFixed(3)} bootstrap=${boot.score.toFixed(3)} gepa=${gepa.score.toFixed(3)}`,
  );
  const best = [
    { name: "baseline", score: baseline, prompt: BASELINE },
    { name: "bootstrap", score: boot.score, prompt: boot.optimizedPrompt },
    { name: "gepa", score: gepa.score, prompt: gepa.optimizedPrompt },
  ].sort((a, b) => b.score - a.score)[0];
  const out = join(TMP_OUT, `${LABEL.replace(/[^a-z0-9]+/gi, "_")}.json`);
  writeFileSync(out, JSON.stringify(best, null, 2));
  console.log(
    `[${LABEL}] best: ${best.name} ${best.score.toFixed(3)} → ${out}`,
  );
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * GEPA / bootstrap-fewshot run for the CONTEXTUAL view evaluator's `view_context`
 * prompt against a local eliza-1 model via the eliza llama.cpp fork's
 * `llama-server` (NOT Ollama — see lib/llamacpp.ts). Optimizes the situation→view
 * INSTRUCTION the evaluator uses, scored by view-id match (scoreViewSelection),
 * schema-constrained (mirrors production guided decode). Persist the winning
 * instruction to <state>/optimized-prompts/view_context/ and the evaluator
 * auto-loads it via resolveOptimizedPromptForRuntime(runtime,"view_context",base).
 *
 * Start a server (one model per server), then run:
 *   LLAMACPP_URL=http://127.0.0.1:8080 LABEL=eliza-1-2b \
 *     bun run plugins/plugin-training/scripts/gepa-view-context.ts
 *
 * runNativeBackend is not used here; the best prompt is written to a temp dir for
 * inspection. Promote into the live store deliberately (never from a test).
 *
 * Measured (eliza-1 qwen3.5 via llama.cpp, view-id match over the 23-row dataset):
 *   eliza-1-0_8b  ~0.04  (cannot do contextual inference; prompt-opt flat)
 *   eliza-1-2b    ~0.57  (the default tier — usable; prompt-opt flat)
 *   eliza-1-4b    ~0.65  (bootstrap demos lift 0.61→0.65 — only tier opt helps)
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPromptScorer,
  runBootstrapFewshot,
  runGepa,
  scoreViewSelection,
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
  "view-context.jsonl",
);
const TMP_OUT = "/tmp/gepa-view-context";
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
  "none",
];
const SCHEMA = {
  type: "object",
  properties: {
    viewId: { type: "string", enum: VIEW_IDS },
    reason: { type: "string" },
  },
  required: ["viewId"],
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

// Deliberately generic baseline so GEPA/bootstrap have headroom to discover the
// situation→view mapping. The schema already constrains the output shape.
const BASELINE =
  "Decide whether opening one app view would help the user, and which. Return JSON {viewId, reason}.";

async function main() {
  mkdirSync(TMP_OUT, { recursive: true });
  const dataset = load();
  const adapter = llamacppAdapter(SCHEMA);
  console.log(`[${LABEL}] dataset: ${dataset.length} rows | ${LLAMACPP_URL}`);
  const scorer = createPromptScorer(adapter, {
    compare: scoreViewSelection,
    maxTokens: 60,
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

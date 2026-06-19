/**
 * GEPA / bootstrap-fewshot run for the CONTEXTUAL view evaluator's `view_context`
 * prompt against a local eliza model via Ollama (the on-device tier). This is the
 * "GEPA applied to the evaluator" loop: it optimizes the situation→view
 * INSTRUCTION the evaluator uses, scored by view-id match (scoreViewSelection),
 * over schema-constrained decoding. Persist the winning instruction to
 * <state>/optimized-prompts/view_context/ and the evaluator auto-loads it via
 * resolveOptimizedPromptForRuntime(runtime, "view_context", baseline).
 *
 * runNativeBackend does NOT persist; the best prompt is written to a temp dir
 * for inspection. Promote it into the live store deliberately (never from a test).
 *
 * Usage: bun run plugins/plugin-training/scripts/gepa-view-context.ts [model...]
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
import type {
  LlmAdapter,
  OptimizationExample,
} from "../src/optimizers/types.js";

const OLLAMA = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
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

function adapter(model: string): LlmAdapter {
  return {
    async complete({ system, user, temperature, maxTokens }) {
      const res = await fetch(`${OLLAMA}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          stream: false,
          format: SCHEMA,
          options: {
            temperature: temperature ?? 0,
            num_predict: maxTokens ?? 60,
          },
          messages: [
            ...(system ? [{ role: "system", content: system }] : []),
            { role: "user", content: user },
          ],
        }),
      });
      if (!res.ok) throw new Error(`ollama ${res.status}`);
      return (
        ((await res.json()) as { message?: { content?: string } }).message
          ?.content ?? ""
      );
    },
  };
}

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
  const models =
    process.argv.slice(2).length > 0
      ? process.argv.slice(2)
      : ["eliza-1-0_8b:latest", "elizatest:latest"];
  mkdirSync(TMP_OUT, { recursive: true });
  const dataset = load();
  console.log(`dataset: ${dataset.length} rows | ollama: ${OLLAMA}`);

  for (const model of models) {
    console.log(`\n=== ${model} ===`);
    const scorer = createPromptScorer(adapter(model), {
      compare: scoreViewSelection,
      maxTokens: 60,
    });
    const baseline = await scorer(BASELINE, dataset);
    const boot = await runBootstrapFewshot({
      baselinePrompt: BASELINE,
      dataset,
      scorer,
      llm: adapter(model),
      options: { k: 6, rankByScorer: true },
    });
    const gepa = await runGepa({
      baselinePrompt: BASELINE,
      dataset,
      scorer,
      llm: adapter(model),
      options: { population: 8, generations: 5, scoringSubset: dataset.length },
    });
    console.log(
      `  baseline=${baseline.toFixed(3)} bootstrap=${boot.score.toFixed(3)} gepa=${gepa.score.toFixed(3)}`,
    );
    const best = [
      { name: "baseline", score: baseline, prompt: BASELINE },
      { name: "bootstrap", score: boot.score, prompt: boot.optimizedPrompt },
      { name: "gepa", score: gepa.score, prompt: gepa.optimizedPrompt },
    ].sort((a, b) => b.score - a.score)[0];
    const out = join(TMP_OUT, `${model.replace(/[^a-z0-9]+/gi, "_")}.json`);
    writeFileSync(out, JSON.stringify(best, null, 2));
    console.log(`  best: ${best.name} ${best.score.toFixed(3)} → ${out}`);
  }
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});

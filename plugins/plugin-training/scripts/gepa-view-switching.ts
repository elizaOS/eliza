/**
 * Reproducible GEPA / bootstrap-fewshot run for the view-switching action_planner
 * task against a LOCAL eliza model via Ollama (the on-device tier stand-in).
 *
 * Replaces the throwaway /tmp grind script. Uses the REAL harness
 * (`runNativeBackend` → `runGepa` / `runBootstrapFewshot`) and the REAL
 * view-aware `scorePlannerAction` (auto-selected for task="action_planner").
 *
 * Decoding is SCHEMA-CONSTRAINED (Ollama `format`): the model is forced to emit
 * the planner tool-call shape `{action, parameters:{action,view}, thought}` with
 * `action`/`view` locked to enums. This mirrors production guided decode, so the
 * run measures SEMANTIC routing (does the model pick VIEWS + the right view),
 * not whether the 0.8B can produce valid JSON unaided (it can't — see the
 * project notes). GEPA then optimizes the prompt to improve that routing.
 *
 * runNativeBackend does NOT persist — nothing here can pollute the live
 * `~/.local/state/eliza/optimized-prompts/` store. The best prompt is written to
 * a temp dir for inspection only.
 *
 * Usage:
 *   bun run plugins/plugin-training/scripts/gepa-view-switching.ts [model...]
 *   OLLAMA_URL=http://127.0.0.1:11434 bun ... eliza-1-0_8b:latest elizatest:latest
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runNativeBackend } from "../src/backends/native.js";
import type { LlmAdapter, OptimizerName } from "../src/optimizers/types.js";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const HERE = dirname(fileURLToPath(import.meta.url));
const DATASET = join(
  HERE,
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
const PLANNER_SCHEMA = {
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

function ollamaAdapter(model: string): LlmAdapter {
  return {
    async complete({ system, user, temperature, maxTokens }) {
      const messages = [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: user },
      ];
      const res = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          stream: false,
          format: PLANNER_SCHEMA,
          options: {
            temperature: temperature ?? 0,
            num_predict: maxTokens ?? 80,
          },
          messages,
        }),
      });
      if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as { message?: { content?: string } };
      return data.message?.content ?? "";
    },
  };
}

// Deliberately generic baseline — NO view-routing guidance — so GEPA/bootstrap
// have headroom to discover the VIEWS routing rule. The schema already enforces
// the output shape; this measures whether the prompt teaches correct routing.
const BASELINE_PROMPT =
  "You are the action planner. Choose the next action for the user's message and output it as JSON.";

const NOOP_RUNTIME = { useModel: async () => "" };

async function runOne(
  model: string,
  optimizer: OptimizerName,
): Promise<{ baseline: number; score: number; prompt: string } | null> {
  try {
    const r = await runNativeBackend({
      datasetPath: DATASET,
      task: "action_planner",
      optimizer,
      baselinePrompt: BASELINE_PROMPT,
      runtime: NOOP_RUNTIME,
      adapter: ollamaAdapter(model),
      holdoutFraction: 0,
    });
    return {
      baseline: r.baselineScore,
      score: r.score,
      prompt: r.result.optimizedPrompt,
    };
  } catch (err) {
    console.error(
      `  [${model}/${optimizer}] ERROR ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

async function main() {
  const models =
    process.argv.slice(2).length > 0
      ? process.argv.slice(2)
      : ["eliza-1-0_8b:latest", "elizatest:latest"];
  mkdirSync(TMP_OUT, { recursive: true });
  console.log(`dataset: ${DATASET}`);
  console.log(`ollama:  ${OLLAMA_URL}`);

  for (const model of models) {
    console.log(`\n=== ${model} ===`);
    let best: {
      optimizer: OptimizerName;
      score: number;
      prompt: string;
    } | null = null;
    for (const optimizer of ["bootstrap-fewshot", "gepa"] as OptimizerName[]) {
      const r = await runOne(model, optimizer);
      if (!r) continue;
      console.log(
        `  ${optimizer}: baseline=${r.baseline.toFixed(3)} optimized=${r.score.toFixed(3)} (Δ=${(r.score - r.baseline).toFixed(3)})`,
      );
      if (!best || r.score > best.score) {
        best = { optimizer, score: r.score, prompt: r.prompt };
      }
    }
    if (best) {
      const safe = model.replace(/[^a-z0-9]+/gi, "_");
      const out = join(TMP_OUT, `${safe}.json`);
      writeFileSync(
        out,
        JSON.stringify(
          {
            model,
            best: best.optimizer,
            score: best.score,
            prompt: best.prompt,
          },
          null,
          2,
        ),
      );
      console.log(
        `  best: ${best.optimizer} score=${best.score.toFixed(3)} → ${out}`,
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

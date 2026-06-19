/**
 * REAL-LLM view-switching tests — gated to the post-merge / live lane
 * (`*.real.test.ts`). Runs the actual local eliza model through the real
 * optimizer harness over Ollama, with SCHEMA-CONSTRAINED decoding mirroring the
 * production planner grammar.
 *
 * Skips automatically when Ollama is unreachable or the model is absent, so it
 * never fails CI lanes without a local model. Run locally with:
 *   TEST_LANE=post-merge bun run --cwd plugins/plugin-training test src/optimizers/view-switching.real.test.ts
 *   REAL_LLM_MODEL=eliza-1-0_8b:latest OLLAMA_URL=http://127.0.0.1:11434 ...
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createPromptScorer,
  extractPlannerAction,
  extractPlannerView,
  scorePlannerAction,
} from "./scoring.js";
import type { LlmAdapter } from "./types.js";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const MODEL = process.env.REAL_LLM_MODEL ?? "eliza-1-0_8b:latest";
const DATASET = join(
  dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "view-switching.action_planner.jsonl",
);

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

function schemaAdapter(model: string): LlmAdapter {
  return {
    async complete({ system, user, temperature, maxTokens }) {
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
          messages: [
            ...(system ? [{ role: "system", content: system }] : []),
            { role: "user", content: user },
          ],
        }),
      });
      if (!res.ok) throw new Error(`ollama ${res.status}`);
      const data = (await res.json()) as { message?: { content?: string } };
      return data.message?.content ?? "";
    },
  };
}

interface Example {
  input: { user: string };
  expectedOutput: string;
}
function loadExamples(): Example[] {
  return readFileSync(DATASET, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const row = JSON.parse(l) as {
        request: { messages: Array<{ content: string }> };
        response: { text: string };
      };
      return {
        input: { user: row.request.messages.at(-1)?.content ?? "" },
        expectedOutput: row.response.text,
      };
    });
}

let ollamaUp = false;
beforeAll(async () => {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    ollamaUp = Boolean(data.models?.some((m) => m.name === MODEL));
  } catch {
    ollamaUp = false;
  }
  if (!ollamaUp) {
    console.warn(
      `[view-switching.real] SKIP — Ollama@${OLLAMA_URL} model ${MODEL} unavailable`,
    );
  }
});

describe("real local LLM — schema-constrained planner output is always gradeable", () => {
  it("emits valid, scorer-parseable JSON for every navigation input", async () => {
    if (!ollamaUp) return;
    const adapter = schemaAdapter(MODEL);
    const examples = loadExamples().slice(0, 8);
    for (const ex of examples) {
      const out = await adapter.complete({
        system:
          "You are the action planner. For a request to open/see an app surface, action=VIEWS with parameters.view; otherwise REPLY.",
        user: ex.input.user,
        temperature: 0,
        maxTokens: 80,
      });
      // Structured decode guarantees a gradeable action — never garbage/loops.
      const action = extractPlannerAction(out);
      expect(action, `"${ex.input.user}" -> ${JSON.stringify(out)}`).toMatch(
        /^(VIEWS|REPLY)$/,
      );
      if (action === "VIEWS") {
        // when it picks VIEWS the view is enum-locked to a real surface
        expect(VIEW_IDS).toContain(extractPlannerView(out));
      }
    }
  }, 120_000);
});

describe("real local LLM — prompt routing lifts the harness score", () => {
  it("a view-routing prompt scores >= the bare baseline on the dataset", async () => {
    if (!ollamaUp) return;
    const examples = loadExamples();
    const scorer = createPromptScorer(schemaAdapter(MODEL), {
      // reuse the production view-aware comparator
      compare: scorePlannerAction,
      maxExamples: 12,
      maxTokens: 80,
    });
    const baseline = await scorer(
      "You are the action planner. Choose the next action and output it as JSON.",
      examples,
    );
    const routed = await scorer(
      "You are the action planner. If the user asks to see/open/check/navigate to an app surface (calendar, inbox/messages/email, wallet, finances, todos, goals, health, documents, relationships, focus), set action=VIEWS with parameters.action=show and parameters.view=that surface. Otherwise action=REPLY. This applies in any language.",
      examples,
    );
    console.log(
      `[view-switching.real] ${MODEL} baseline=${baseline.toFixed(3)} routed=${routed.toFixed(3)}`,
    );
    expect(routed).toBeGreaterThanOrEqual(baseline);
  }, 240_000);
});

/**
 * REAL-LLM view-switching tests — gated to the post-merge / live lane
 * (`*.real.test.ts`). Runs the actual local eliza-1 model through the real
 * optimizer harness over the eliza llama.cpp fork's `llama-server` (NOT Ollama —
 * stock Ollama can't load the eliza-1 qwen3.5 tiers above 2b), with
 * SCHEMA-CONSTRAINED decoding (json_schema) mirroring the production planner
 * grammar and qwen3.5 thinking disabled.
 *
 * Skips automatically when llama-server is unreachable, so it never fails CI
 * lanes without a local model. Run locally with a server up (see
 * scripts/lib/llamacpp.ts):
 *   TEST_LANE=post-merge LLAMACPP_URL=http://127.0.0.1:8080 \
 *     bun run --cwd plugins/plugin-training test src/optimizers/view-switching.real.test.ts
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

// llama.cpp (eliza-fork llama-server), NOT Ollama. Start a server with one
// eliza-1 GGUF loaded; MODEL is a display label (the served model is whatever
// llama-server has). See scripts/lib/llamacpp.ts.
const LLAMACPP_URL = process.env.LLAMACPP_URL ?? "http://127.0.0.1:8080";
const MODEL = process.env.REAL_LLM_MODEL ?? "eliza-1-2b";
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

function schemaAdapter(_model: string): LlmAdapter {
  return {
    async complete({ system, user, temperature, maxTokens }) {
      const res = await fetch(`${LLAMACPP_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [
            ...(system ? [{ role: "system", content: system }] : []),
            { role: "user", content: user },
          ],
          response_format: {
            type: "json_schema",
            json_schema: { name: "out", schema: PLANNER_SCHEMA, strict: true },
          },
          // eliza-1 is qwen3.5 (a thinking model); disable thinking so the token
          // budget produces the JSON answer, not reasoning_content.
          chat_template_kwargs: { enable_thinking: false },
          temperature: temperature ?? 0,
          max_tokens: maxTokens ?? 80,
        }),
      });
      if (!res.ok) throw new Error(`llama-server ${res.status}`);
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return data.choices?.[0]?.message?.content ?? "";
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

let serverUp = false;
beforeAll(async () => {
  try {
    const res = await fetch(`${LLAMACPP_URL}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    serverUp = res.ok;
  } catch {
    serverUp = false;
  }
  if (!serverUp) {
    console.warn(
      `[view-switching.real] SKIP — llama-server@${LLAMACPP_URL} unavailable (start it with an eliza-1 GGUF)`,
    );
  }
});

describe("real local LLM — schema-constrained planner output is always gradeable", () => {
  it("emits valid, scorer-parseable JSON for every navigation input", async () => {
    if (!serverUp) return;
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
    if (!serverUp) return;
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

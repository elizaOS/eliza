/**
 * Live regression: PLAN_ACTIONS-as-function-call-shape recovery against
 * Cerebras llama3.1-8b.
 *
 * Companion to `cerebras-plan-actions-recovery.live.test.ts`. The sibling
 * exercises Pattern 1 (PLAN_ACTIONS({...}) wrapper as content text) by calling
 * useModel WITHOUT tools — the model has to emit the call shape as text.
 *
 * THIS test exercises Pattern 3 (the OpenAI function-call envelope
 * `{"name": "PLAN_ACTIONS", "arguments": {...}}` echoed as content text) by
 * calling useModel WITH PLAN_ACTIONS as an actual tool. The weaker model
 * often serializes the function-call shape as content text instead of issuing
 * a native tool call, and the extractor must recover those.
 *
 * Field probe @ 2026-05-13: weak-llama3.1-8b emits Pattern 3 in ~80% of trials
 * vs ~17% native tool calls. Pre-fix dispatch rate: ~17%. Post-fix: ~97%.
 *
 * Run with: CEREBRAS_API_KEY=<key> bun test cerebras-plan-actions-function-call-shape.live.test.ts
 */

import { ModelType } from "@elizaos/core";
import { expect, it } from "vitest";
import { describeLive } from "../../../packages/app-core/test/helpers/live-agent-test";
// Import from source so the test exercises the in-tree extractor changes
// without requiring a fresh dist build of @elizaos/core. Sibling Pattern-1 test
// imports from the package, but the source path is needed here because Pattern 3
// (openai-function-call shape) is the in-flight addition under test.
import { extractPlanActionsFromContent } from "../../../packages/core/src/runtime/plan-actions-extractor";

const SYSTEM_PROMPT = `You are a task-orchestration assistant.

When the user asks you to spawn a coding sub-agent, you MUST invoke the
PLAN_ACTIONS tool with action=TASKS_SPAWN_AGENT.

Do not narrate. Invoke the tool.`;

const USER_PROMPT =
  "Spawn a coding sub-agent using opencode to write /tmp/hello.py that prints hello.";

const PLAN_ACTIONS_TOOL = {
  type: "function" as const,
  function: {
    name: "PLAN_ACTIONS",
    description: "Plan and execute an action.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string" },
        parameters: { type: "object" },
        thought: { type: "string" },
      },
      required: ["action"],
    },
  },
};

const TRIALS = 30;
const TOTAL_TIMEOUT_MS = TRIALS * 8_000 + 30_000;

interface Outcome {
  nativeToolCall: boolean;
  recovered: boolean;
  recoveredAction: string | null;
  recoverySource: string | null;
  finishReason: string;
  textPreview: string;
  textLength: number;
  fullText?: string;
}

describeLive(
  "Cerebras llama3.1-8b — PLAN_ACTIONS function-call-shape recovery (30 trials)",
  { requiredEnv: ["CEREBRAS_API_KEY"] },
  ({ harness }) => {
    it(
      "extractor recovers OpenAI function-call envelope echoed as content text",
      async () => {
        const { runtime } = harness();
        runtime.setSetting("OPENAI_LARGE_MODEL", "llama3.1-8b");
        runtime.setSetting("OPENAI_SMALL_MODEL", "llama3.1-8b");
        runtime.setSetting("OPENAI_ACTION_PLANNER_MODEL", "llama3.1-8b");
        runtime.setSetting("OPENAI_PLANNER_MODEL", "llama3.1-8b");
        runtime.setSetting("OPENAI_RESPONSE_HANDLER_MODEL", "llama3.1-8b");

        const outcomes: Outcome[] = [];

        for (let i = 0; i < TRIALS; i++) {
          try {
            const raw = await runtime.useModel(ModelType.TEXT_LARGE, {
              messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: USER_PROMPT },
              ],
              tools: [PLAN_ACTIONS_TOOL],
              toolChoice: "auto",
              maxTokens: 300,
            } as Parameters<typeof runtime.useModel>[1]);

            const text =
              typeof raw === "string" ? raw : (((raw as { text?: string }).text ?? "") as string);
            const toolCalls =
              typeof raw === "object" && raw !== null
                ? ((raw as { toolCalls?: Array<{ name?: string }> }).toolCalls ?? [])
                : [];
            const nativeToolCall = toolCalls.length > 0;
            const extracted = extractPlanActionsFromContent(text);
            outcomes.push({
              nativeToolCall,
              recovered: !nativeToolCall && !!extracted,
              recoveredAction: extracted?.action ?? null,
              recoverySource: extracted?.recoverySource ?? null,
              finishReason: "ok",
              textPreview: text.slice(0, 160),
              textLength: text.length,
              fullText: !nativeToolCall && !extracted ? text : undefined,
            });
          } catch (err) {
            outcomes.push({
              nativeToolCall: false,
              recovered: false,
              recoveredAction: null,
              recoverySource: null,
              finishReason: `error:${String(err).slice(0, 80)}`,
              textPreview: "",
              textLength: 0,
            });
          }
        }

        // Print a few unrecognized outputs so a regression is debuggable.
        const unrecognized = outcomes.filter((o) => !o.nativeToolCall && !o.recovered);
        if (unrecognized.length > 0) {
          console.log(`Sample unrecognized outputs (${unrecognized.length} total):`);
          for (const o of unrecognized.slice(0, 2)) {
            console.log(
              `  finish=${o.finishReason} len=${o.textLength} full=${JSON.stringify(o.fullText)}`
            );
          }
        }

        const native = outcomes.filter((o) => o.nativeToolCall).length;
        const recovered = outcomes.filter((o) => o.recovered).length;
        const dispatched = native + recovered;
        const recoveryByPattern = outcomes
          .filter((o) => o.recovered)
          .reduce<Record<string, number>>((acc, o) => {
            const k = o.recoverySource ?? "unknown";
            acc[k] = (acc[k] ?? 0) + 1;
            return acc;
          }, {});

        const pct = (n: number) => `${((n / TRIALS) * 100).toFixed(1)}%`;
        console.log(`
=== Cerebras llama3.1-8b PLAN_ACTIONS function-call-shape (${TRIALS} trials) ===
  Native tool call:       ${native} (${pct(native)})
  Recovered from text:    ${recovered} (${pct(recovered)})
  Total dispatched:       ${dispatched} (${pct(dispatched)})
  Recovery sources:       ${JSON.stringify(recoveryByPattern)}
===`);

        // 1. No false positives: every recovered action must have a non-empty name.
        const badRecovery = outcomes.filter((o) => o.recovered && !o.recoveredAction);
        expect(badRecovery).toHaveLength(0);

        // 2. Combined dispatch rate ≥ 70%. Pre-fix this would have been ~17%
        //    because Pattern 3 (openai-function-call) didn't exist.
        expect(dispatched).toBeGreaterThanOrEqual(Math.floor(TRIALS * 0.7));

        // 3. At least one trial should have exercised the new function-call path —
        //    otherwise the test isn't actually exercising Pattern 3. (If the model
        //    suddenly becomes 100% native-tool-call-disciplined, this fails and we
        //    have a happier problem to investigate; loosen then.)
        expect(recoveryByPattern["openai-function-call"] ?? 0).toBeGreaterThan(0);
      },
      TOTAL_TIMEOUT_MS
    );
  }
);

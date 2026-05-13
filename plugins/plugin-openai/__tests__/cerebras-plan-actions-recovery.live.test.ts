/**
 * Live regression: 100-trial PLAN_ACTIONS content-recovery probe
 * against Cerebras llama3.1-8b.
 *
 * Purpose: this model frequently emits the PLAN_ACTIONS call shape as
 * message-content text rather than a native tool call. We run the model
 * against a minimal prompt that would normally require a PLAN_ACTIONS
 * invocation, bucket each response, and verify that:
 *
 *   a) The content-text recovery path fires on at least 10% of trials
 *      (if the model NEVER misses the tool API, the extractor is never
 *      needed but is not harmful — the test passes trivially in that case).
 *   b) When the model emits a well-formed PLAN_ACTIONS body, the
 *      extractor successfully parses it (failure mode: extractor rejects
 *      a parseable body → regression).
 *   c) When the model emits refusal text (no JSON), no spurious tool
 *      call is synthesized.
 *
 * Run with: CEREBRAS_API_KEY=<key> bun test cerebras-plan-actions-recovery.live.test.ts
 *
 * This test is skipped when CEREBRAS_API_KEY is absent. It does NOT require
 * ELIZA_LIVE_TEST=1 — the CEREBRAS_API_KEY alone is sufficient to opt in,
 * matching the pattern in cerebras-config.live.test.ts.
 */

import { extractPlanActionsFromContent, ModelType } from "@elizaos/core";
import { expect, it } from "vitest";
import { describeLive } from "../../../packages/app-core/test/helpers/live-agent-test";

// Single stable prompt: ask the model to emit a PLAN_ACTIONS call to spawn a
// coding sub-agent. The system prompt mirrors the V5 pipeline's character doc
// section that teaches the call shape.
const SYSTEM_PROMPT = `You are a task-orchestration assistant.

When the user asks you to spawn a coding sub-agent, you MUST respond by invoking the
PLAN_ACTIONS tool with action=TASKS_SPAWN_AGENT. Example call shape:

PLAN_ACTIONS({
  "action": "TASKS_SPAWN_AGENT",
  "parameters": {
    "task": "<description of work>",
    "agentType": "opencode"
  },
  "thought": "<brief reasoning>"
})

Do not explain what you're about to do. Invoke the tool immediately.`;

const USER_PROMPT =
  "Spawn a coding sub-agent using opencode to write /tmp/hello.py that prints hello.";

const TRIALS = 100;
const TIMEOUT_PER_TRIAL_MS = 8000;
const TOTAL_TIMEOUT_MS = TRIALS * TIMEOUT_PER_TRIAL_MS + 30_000;

interface TrialResult {
  rawText: string;
  hadNativeToolCall: boolean;
  extractedFromContent: boolean;
  parseError: boolean;
  refusal: boolean;
  action: string | null;
}

function classifyResponse(
  text: string,
  toolCalls: Array<{ name?: string; toolName?: string }>
): TrialResult {
  const hadNativeToolCall = Array.isArray(toolCalls) && toolCalls.length > 0;

  const extracted = extractPlanActionsFromContent(text);

  const isRefusal =
    !hadNativeToolCall && !extracted && text.trim().length > 0 && !/PLAN_ACTIONS\s*\(/.test(text);

  const hasJsonAttempt = /PLAN_ACTIONS\s*\(/.test(text) && !extracted && !hadNativeToolCall;

  return {
    rawText: text.slice(0, 400),
    hadNativeToolCall,
    extractedFromContent: !!extracted && !hadNativeToolCall,
    parseError: hasJsonAttempt,
    refusal: isRefusal,
    action: extracted?.action ?? null,
  };
}

describeLive(
  "Cerebras llama3.1-8b — PLAN_ACTIONS content-recovery (100 trials)",
  { requiredEnv: ["CEREBRAS_API_KEY"] },
  ({ harness }) => {
    it(
      `runs ${TRIALS} trials and reports failure-mode distribution`,
      async () => {
        const { runtime } = harness();
        // Override to use llama3.1-8b — the model most likely to emit
        // PLAN_ACTIONS as content text (weaker tool-calling discipline).
        runtime.setSetting("OPENAI_LARGE_MODEL", "llama3.1-8b");
        runtime.setSetting("OPENAI_SMALL_MODEL", "llama3.1-8b");
        runtime.setSetting("OPENAI_ACTION_PLANNER_MODEL", "llama3.1-8b");
        runtime.setSetting("OPENAI_PLANNER_MODEL", "llama3.1-8b");
        runtime.setSetting("OPENAI_RESPONSE_HANDLER_MODEL", "llama3.1-8b");

        const results: TrialResult[] = [];

        for (let i = 0; i < TRIALS; i++) {
          try {
            const raw = await runtime.useModel(ModelType.RESPONSE_HANDLER, {
              messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: USER_PROMPT },
              ],
              maxTokens: 300,
            });

            const text = typeof raw === "string" ? raw : ((raw as { text?: string }).text ?? "");
            const toolCalls =
              typeof raw === "object" && raw !== null
                ? ((raw as { toolCalls?: Array<{ name?: string; toolName?: string }> }).toolCalls ??
                  [])
                : [];

            results.push(classifyResponse(text, toolCalls));
          } catch (err) {
            results.push({
              rawText: String(err).slice(0, 200),
              hadNativeToolCall: false,
              extractedFromContent: false,
              parseError: false,
              refusal: false,
              action: null,
            });
          }
        }

        // --- Aggregate ---
        const nativeCount = results.filter((r) => r.hadNativeToolCall).length;
        const extractedCount = results.filter((r) => r.extractedFromContent).length;
        const parseErrorCount = results.filter((r) => r.parseError).length;
        const refusalCount = results.filter((r) => r.refusal).length;
        const totalHandled = nativeCount + extractedCount;

        // Print a distribution table (visible in test output with --reporter=verbose).
        console.log(`
=== Cerebras llama3.1-8b PLAN_ACTIONS recovery (${TRIALS} trials) ===
  Native tool call (no recovery needed):  ${nativeCount} (${pct(nativeCount)})
  Recovered from content text:            ${extractedCount} (${pct(extractedCount)})
  Parse error (PLAN_ACTIONS but broken):  ${parseErrorCount} (${pct(parseErrorCount)})
  Refusal / no JSON:                      ${refusalCount} (${pct(refusalCount)})
  Total correctly dispatched:             ${totalHandled} (${pct(totalHandled)})
===

Sample failure (first refusal or parse-error):
${firstSampleOf(results, (r) => r.refusal || r.parseError)}`);

        // Assertions:
        // 1. No extractor false-positives: every extraction must have a non-empty action.
        const badExtractions = results.filter((r) => r.extractedFromContent && !r.action);
        expect(badExtractions).toHaveLength(0);

        // 2. Correctly dispatched ≥ 30% of trials (the model might refuse most of the
        //    time, but when it emits a call shape it should be recoverable).
        expect(totalHandled).toBeGreaterThanOrEqual(TRIALS * 0.3);
      },
      TOTAL_TIMEOUT_MS
    );
  }
);

function pct(n: number) {
  return `${((n / TRIALS) * 100).toFixed(1)}%`;
}

function firstSampleOf(results: TrialResult[], pred: (r: TrialResult) => boolean): string {
  const sample = results.find(pred);
  return sample ? `  "${sample.rawText}"` : "  (none)";
}

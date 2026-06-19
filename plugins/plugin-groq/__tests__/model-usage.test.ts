/**
 * Live e2e for Groq's `MODEL_USED` event plumbing. Boots a real `AgentRuntime`
 * with `plugin-groq` against the live Groq API and verifies that:
 *   - `TEXT_LARGE` returns a real generation that contains the expected answer
 *   - the runtime emits `MODEL_USED` with non-zero prompt/completion token
 *     counts sourced from the upstream usage payload
 *
 * Skips with a yellow warning when `GROQ_API_KEY` is not set.
 */
import { describe, expect, it } from "vitest";

import groqPlugin from "../index";

type LiveAgentHarness =
  import("../../../packages/app-core/test/helpers/live-agent-test").LiveAgentHarness;

const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";
const REQUIRED = ["GROQ_API_KEY"] as const;

const missing = REQUIRED.filter((k) => !process.env[k]?.trim());

if (missing.length > 0) {
  const reason = `missing required env: ${missing.join(", ")}`;
  process.env.SKIP_REASON ||= reason;
  console.warn(
    `${YELLOW}[plugin-groq live] skipped — ${reason} (set ${missing.join(", ")} to enable)${RESET}`
  );
  describe("groq live MODEL_USED events", () => {
    it.skip(`[live] suite skipped — set ${missing.join(", ")} to enable`, () => {});
  });
} else {
  describe("groq live MODEL_USED events", () => {
    it("emits real prompt/completion token counts for TEXT_LARGE and returns the expected answer", async () => {
      const { buildLiveHarness } = await import(
        "../../../packages/app-core/test/helpers/live-agent-test"
      );
      const harness: LiveAgentHarness = await buildLiveHarness({
        provider: "groq",
        requiredEnv: ["GROQ_API_KEY"],
      });
      try {
        const events: Array<Record<string, unknown>> = [];
        const original = harness.runtime.emitEvent.bind(harness.runtime);
        harness.runtime.emitEvent = (async (
          type: string | string[],
          payload: Record<string, unknown>
        ) => {
          const types = Array.isArray(type) ? type : [type];
          if (types.includes("MODEL_USED")) {
            events.push({ type: types[0], ...payload });
          }
          return original(type as never, payload as never);
        }) as typeof harness.runtime.emitEvent;

        const result = await groqPlugin.models?.TEXT_LARGE?.(harness.runtime, {
          prompt: "What is 2+2? Reply with only the digit and nothing else.",
          maxTokens: 16,
        });

        expect(typeof result).toBe("string");
        expect(String(result)).toContain("4");

        const modelUsed = events.find((e) => e.type === "MODEL_USED");
        expect(modelUsed).toBeDefined();
        expect(modelUsed?.source).toBe("groq");
        expect(modelUsed?.provider).toBe("groq");
        expect(modelUsed?.type).toBe("TEXT_LARGE");
        const tokens = modelUsed?.tokens as {
          prompt: number;
          completion: number;
          total: number;
        };
        expect(tokens.prompt).toBeGreaterThan(0);
        expect(tokens.completion).toBeGreaterThan(0);
        expect(tokens.total).toBeGreaterThanOrEqual(tokens.prompt + tokens.completion - 1);
      } finally {
        await harness.close();
      }
    }, 120_000);
  });
}

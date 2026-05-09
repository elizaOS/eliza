import type { IAgentRuntime } from "@elizaos/core";
import { runWithTrajectoryContext } from "@elizaos/core";
import { describe, expect, it } from "vitest";

interface CapturedLlmCall {
  stepId: string;
  actionType: string;
  promptTokens?: number;
  completionTokens?: number;
  response?: string;
}

const REQUIRED_KEY = "OPENROUTER_API_KEY";
const apiKey = process.env[REQUIRED_KEY]?.trim();
const SHOULD_RUN = Boolean(apiKey);

function createInlineRuntime(calls: CapturedLlmCall[]): IAgentRuntime {
  const trajectoryLogger = {
    isEnabled: () => true,
    logLlmCall: (params: CapturedLlmCall) => {
      calls.push(params);
    },
  };
  const settings: Record<string, string> = {
    OPENROUTER_API_KEY: apiKey ?? "",
    OPENROUTER_SMALL_MODEL: process.env.OPENROUTER_SMALL_MODEL ?? "google/gemini-2.0-flash-001",
  };
  return {
    agentId: "agent-openrouter",
    character: { system: "You are a concise assistant." },
    emitEvent: async () => undefined,
    getService: (name: string) => (name === "trajectories" ? trajectoryLogger : null),
    getServicesByType: (type: string) => (type === "trajectories" ? [trajectoryLogger] : []),
    getSetting: (key: string) => settings[key] ?? process.env[key] ?? null,
  } as unknown as IAgentRuntime;
}

if (!SHOULD_RUN) {
  process.env.SKIP_REASON ||= `missing required env: ${REQUIRED_KEY}`;
  console.warn(
    `\x1b[33m[openrouter trajectory.test] skipped — missing required env: ${REQUIRED_KEY} (set ${REQUIRED_KEY} to enable)\x1b[0m`
  );
  describe("OpenRouter trajectory wrapping (live)", () => {
    it.skip(`[live] suite skipped — set ${REQUIRED_KEY} to enable`, () => {});
  });
} else {
  describe("OpenRouter trajectory wrapping (live)", () => {
    it("records object generation through recordLlmCall", async () => {
      const { handleObjectSmall } = await import("../models/object");

      const calls: CapturedLlmCall[] = [];
      const runtime = createInlineRuntime(calls);

      const result = await runWithTrajectoryContext(
        { trajectoryStepId: "step-openrouter" },
        async () =>
          handleObjectSmall(runtime, {
            prompt:
              'Return JSON with shape {"answer": 4} for the question 2+2. Reply with only the JSON object.',
          })
      );

      expect(JSON.stringify(result)).toContain("4");
      expect(calls).toHaveLength(1);
      const [call] = calls;
      expect(call.stepId).toBe("step-openrouter");
      expect(call.actionType).toBe("ai.generateObject");
      expect(call.promptTokens ?? 0).toBeGreaterThan(0);
      expect(call.completionTokens ?? 0).toBeGreaterThan(0);
      expect(call.response).toContain("4");
    }, 120_000);
  });
}

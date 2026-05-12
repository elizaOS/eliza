import type { IAgentRuntime, ModelHandler } from "@elizaos/core";
import { ModelType, runWithTrajectoryContext } from "@elizaos/core";
import { describe, expect, it } from "vitest";

interface CapturedLlmCall {
  stepId: string;
  actionType: string;
  promptTokens?: number;
  completionTokens?: number;
  response?: string;
}

const REQUIRED_KEY = "NVIDIA_API_KEY";
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
    NVIDIA_API_KEY: apiKey ?? "",
    NVIDIA_SMALL_MODEL: process.env.NVIDIA_SMALL_MODEL ?? "openai/gpt-oss-120b",
  };
  const runtime = {
    agentId: "agent-nvidia",
    character: { system: "You are a concise assistant." },
    emitEvent: async () => undefined,
    getService: (name: string) =>
      name === "trajectories" ? trajectoryLogger : null,
    getServicesByType: (type: string) =>
      type === "trajectories" ? [trajectoryLogger] : [],
    getSetting: (key: string) => settings[key] ?? process.env[key] ?? null,
  };

  return runtime as IAgentRuntime;
}

if (!SHOULD_RUN) {
  process.env.SKIP_REASON ||= `missing required env: ${REQUIRED_KEY}`;
  console.warn(
    `\x1b[33m[nvidiacloud trajectory.test] skipped — missing required env: ${REQUIRED_KEY} (set ${REQUIRED_KEY} to enable)\x1b[0m`,
  );
  describe("NVIDIA Cloud trajectory wrapping (live)", () => {
    it.skip(`[live] suite skipped — set ${REQUIRED_KEY} to enable`, () => {});
  });
} else {
  describe("NVIDIA Cloud trajectory wrapping (live)", () => {
    it("records structured-output generation via TEXT_SMALL through recordLlmCall", async () => {
      const mod = (await import("../dist/index.js")) as {
        nvidiaCloudPlugin: { models?: Record<string, ModelHandler> };
      };
      const handler = mod.nvidiaCloudPlugin.models?.[ModelType.TEXT_SMALL];
      if (!handler) {
        throw new Error("nvidiaCloudPlugin TEXT_SMALL handler missing");
      }

      const calls: CapturedLlmCall[] = [];
      const runtime = createInlineRuntime(calls);

      const result = await runWithTrajectoryContext(
        { trajectoryStepId: "step-nvidia" },
        async () =>
          handler(runtime, {
            prompt:
              'Return JSON with shape {"answer": 4} for the question 2+2. Reply with only the JSON object.',
            responseSchema: {
              type: "object",
              properties: { answer: { type: "number" } },
              required: ["answer"],
            },
          } as never),
      );

      expect(JSON.stringify(result)).toContain("4");
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const [call] = calls;
      expect(call.stepId).toBe("step-nvidia");
      expect(typeof call.actionType).toBe("string");
      expect(call.promptTokens ?? 0).toBeGreaterThan(0);
      expect(call.completionTokens ?? 0).toBeGreaterThan(0);
    }, 120_000);
  });
}

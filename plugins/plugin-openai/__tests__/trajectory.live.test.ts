import type { IAgentRuntime } from "@elizaos/core";
import { runWithTrajectoryContext } from "@elizaos/core";
import { describe, expect, it } from "vitest";

import { describeLive } from "../../../packages/app-core/test/helpers/live-agent-test";
import { handleTextLarge, handleTextSmall } from "../models/text";

interface CapturedLlmCall {
  stepId: string;
  actionType: string;
  promptTokens?: number;
  completionTokens?: number;
  response?: string;
}

function attachTrajectoryCapture(runtime: IAgentRuntime): CapturedLlmCall[] {
  const calls: CapturedLlmCall[] = [];
  const trajectoryLogger = {
    isEnabled: () => true,
    logLlmCall: (params: CapturedLlmCall) => {
      calls.push(params);
    },
  };
  const original = runtime.getServicesByType.bind(runtime);
  runtime.getServicesByType = ((type: string) => {
    if (type === "trajectories") return [trajectoryLogger];
    return original(type);
  }) as typeof runtime.getServicesByType;
  const originalGet = runtime.getService.bind(runtime);
  runtime.getService = ((name: string) => {
    if (name === "trajectories") return trajectoryLogger;
    return originalGet(name);
  }) as typeof runtime.getService;
  return calls;
}

describeLive(
  "OpenAI trajectory wrapping (live)",
  { requiredEnv: ["OPENAI_API_KEY"] },
  ({ harness }) => {
    it("records text and structured-output generation through recordLlmCall", async () => {
      const { runtime } = harness();
      const calls = attachTrajectoryCapture(runtime);

      await runWithTrajectoryContext({ trajectoryStepId: "step-openai-live" }, async () => {
        await handleTextSmall(runtime, {
          prompt: "Reply with the single word: hello",
        });
        await handleTextLarge(runtime, {
          prompt: 'Return JSON with shape {"ok": true} and nothing else.',
          responseSchema: {
            type: "object",
            properties: { ok: { type: "boolean" } },
            required: ["ok"],
          },
        } as Parameters<typeof handleTextLarge>[1]);
      });

      expect(calls).toHaveLength(2);
      const [textCall, structuredCall] = calls;
      expect(textCall.stepId).toBe("step-openai-live");
      expect(textCall.actionType).toBe("ai.generateText");
      expect(textCall.promptTokens ?? 0).toBeGreaterThan(0);
      expect(textCall.completionTokens ?? 0).toBeGreaterThan(0);
      expect(structuredCall.stepId).toBe("step-openai-live");
      expect(structuredCall.actionType).toBe("ai.generateText");
      expect(structuredCall.promptTokens ?? 0).toBeGreaterThan(0);
      expect(structuredCall.completionTokens ?? 0).toBeGreaterThan(0);
    }, 120_000);
  }
);

// OpenAI-only paths (image generation, research, audio) are not supported by
// Cerebras. They are gated behind OPENAI_API_KEY_REAL so users can opt into
// real-OpenAI-only assertions without affecting the default Cerebras run.
const hasRealOpenAI =
  Boolean(process.env.OPENAI_API_KEY_REAL?.trim()) &&
  !process.env.OPENAI_BASE_URL?.includes("cerebras.ai");

describe.skipIf(!hasRealOpenAI)("OpenAI image/audio trajectory (real OpenAI)", () => {
  it("records image, research, and audio generation calls", async () => {
    const previousKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY_REAL;
    try {
      const { handleImageGeneration } = await import("../models/image");
      const { handleTextToSpeech } = await import("../models/audio");
      const calls: CapturedLlmCall[] = [];
      const runtime = {
        agentId: "agent-openai-real",
        character: { system: "system prompt" },
        emitEvent: () => {},
        getService: (name: string) =>
          name === "trajectories"
            ? {
                isEnabled: () => true,
                logLlmCall: (p: CapturedLlmCall) => calls.push(p),
              }
            : null,
        getServicesByType: (type: string) =>
          type === "trajectories"
            ? [
                {
                  isEnabled: () => true,
                  logLlmCall: (p: CapturedLlmCall) => calls.push(p),
                },
              ]
            : [],
        getSetting: (key: string) => process.env[key],
      } as IAgentRuntime;

      await runWithTrajectoryContext({ trajectoryStepId: "step-openai-real" }, async () => {
        await handleImageGeneration(runtime, {
          prompt: "A small red cube on a white background",
        });
        await handleTextToSpeech(runtime, "Hello live test");
      });

      expect(calls.map((c) => c.actionType)).toContain("openai.images.generate");
      expect(calls.map((c) => c.actionType)).toContain("openai.audio.speech.create");
    } finally {
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousKey;
    }
  }, 180_000);
});

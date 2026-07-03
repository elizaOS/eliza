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

const REQUIRED_KEY = "GOOGLE_GENERATIVE_AI_API_KEY";
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
    GOOGLE_GENERATIVE_AI_API_KEY: apiKey ?? "",
  };
  return {
    agentId: "agent-google",
    character: { system: "You are a concise assistant." },
    emitEvent: async () => undefined,
    getService: (name: string) =>
      name === "trajectories" ? trajectoryLogger : null,
    getServicesByType: (type: string) =>
      type === "trajectories" ? [trajectoryLogger] : [],
    getSetting: (key: string) => settings[key] ?? process.env[key] ?? null,
  } as IAgentRuntime;
}

if (!SHOULD_RUN) {
  process.env.SKIP_REASON ||= `missing required env: ${REQUIRED_KEY}`;
  console.warn(
    `\x1b[33m[google-genai trajectory.test] live test disabled: missing required env ${REQUIRED_KEY} (set ${REQUIRED_KEY} to enable)\x1b[0m`,
  );
  describe("Google GenAI trajectory wrapping (live)", () => {
    it.skip(`[live] requires ${REQUIRED_KEY}`, () => {});
  });
} else {
  describe("Google GenAI trajectory wrapping (live)", () => {
    it("records text and structured-output generation via TEXT_* through recordLlmCall", async () => {
      const { handleTextSmall, handleTextLarge } = await import(
        "../models/text"
      );

      const calls: CapturedLlmCall[] = [];
      const runtime = createInlineRuntime(calls);

      await runWithTrajectoryContext(
        { trajectoryStepId: "step-google" },
        async () => {
          await handleTextSmall(runtime, {
            prompt: "What is 2+2? Reply with just the number.",
            maxTokens: 32,
          });
          await handleTextLarge(runtime, {
            prompt:
              'Return JSON {"answer": 4} for the question 2+2. Reply with only the JSON object.',
            responseSchema: {
              type: "object",
              properties: { answer: { type: "number" } },
              required: ["answer"],
            },
          } as Parameters<typeof handleTextLarge>[1]);
        },
      );

      expect(calls).toHaveLength(2);
      const [textCall, structuredCall] = calls;
      expect(textCall.stepId).toBe("step-google");
      expect(textCall.actionType).toBe(
        "google-genai.TEXT_SMALL.generateContent",
      );
      expect(textCall.promptTokens ?? 0).toBeGreaterThan(0);
      expect(textCall.completionTokens ?? 0).toBeGreaterThan(0);
      expect(textCall.response).toContain("4");
      expect(structuredCall.stepId).toBe("step-google");
      expect(structuredCall.actionType).toBe(
        "google-genai.TEXT_LARGE.generateContent",
      );
      expect(structuredCall.promptTokens ?? 0).toBeGreaterThan(0);
      expect(structuredCall.completionTokens ?? 0).toBeGreaterThan(0);
      expect(structuredCall.response).toContain("4");
    }, 120_000);

    it("records a native Gemini tool call trajectory", async () => {
      const { handleTextSmall } = await import("../models/text");

      const calls: CapturedLlmCall[] = [];
      const runtime = createInlineRuntime(calls);

      const result = (await runWithTrajectoryContext(
        { trajectoryStepId: "step-google-tool-call" },
        async () =>
          handleTextSmall(runtime, {
            prompt:
              "Use the lookup_weather tool for Paris. Do not answer in plain text.",
            maxTokens: 128,
            tools: {
              lookup_weather: {
                description: "Lookup current weather for a city.",
                inputSchema: {
                  type: "object",
                  properties: {
                    city: { type: "string" },
                  },
                  required: ["city"],
                },
              },
            },
            toolChoice: { type: "tool", toolName: "lookup_weather" },
          } as Parameters<typeof handleTextSmall>[1]),
      )) as unknown as {
        text: string;
        toolCalls?: Array<{
          name?: string;
          toolName?: string;
          input?: unknown;
          arguments?: unknown;
        }>;
        finishReason?: string;
      };

      expect(result.toolCalls?.length ?? 0).toBeGreaterThan(0);
      expect(
        result.toolCalls?.some(
          (call) =>
            call.name === "lookup_weather" ||
            call.toolName === "lookup_weather",
        ),
      ).toBe(true);
      expect(result.finishReason).toBe("tool-calls");

      expect(calls).toHaveLength(1);
      expect(calls[0]?.stepId).toBe("step-google-tool-call");
      expect(calls[0]?.actionType).toBe(
        "google-genai.TEXT_SMALL.generateContent",
      );
      expect(calls[0]?.response ?? result.text).toBe(result.text);
    }, 120_000);
  });
}

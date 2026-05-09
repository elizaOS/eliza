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
  } as unknown as IAgentRuntime;
}

if (!SHOULD_RUN) {
  process.env.SKIP_REASON ||= `missing required env: ${REQUIRED_KEY}`;
  console.warn(
    `\x1b[33m[google-genai trajectory.test] skipped — missing required env: ${REQUIRED_KEY} (set ${REQUIRED_KEY} to enable)\x1b[0m`,
  );
  describe("Google GenAI trajectory wrapping (live)", () => {
    it.skip(
      `[live] suite skipped — set ${REQUIRED_KEY} to enable`,
      () => {},
    );
  });
} else {
  describe("Google GenAI trajectory wrapping (live)", () => {
    it(
      "records text and object generation through recordLlmCall",
      async () => {
        const [{ handleTextSmall }, { handleObjectSmall }] = await Promise.all([
          import("../models/text"),
          import("../models/object"),
        ]);

        const calls: CapturedLlmCall[] = [];
        const runtime = createInlineRuntime(calls);

        await runWithTrajectoryContext(
          { trajectoryStepId: "step-google" },
          async () => {
            await handleTextSmall(runtime, {
              prompt: "What is 2+2? Reply with just the number.",
              maxTokens: 32,
            });
            await handleObjectSmall(runtime, {
              prompt:
                'Return JSON {"answer": 4} for the question 2+2. Reply with only the JSON object.',
              schema: {
                type: "object",
                properties: { answer: { type: "number" } },
                required: ["answer"],
              },
            });
          },
        );

        expect(calls).toHaveLength(2);
        const [textCall, objectCall] = calls;
        expect(textCall.stepId).toBe("step-google");
        expect(textCall.actionType).toBe(
          "google-genai.TEXT_SMALL.generateContent",
        );
        expect(textCall.promptTokens ?? 0).toBeGreaterThan(0);
        expect(textCall.completionTokens ?? 0).toBeGreaterThan(0);
        expect(textCall.response).toContain("4");
        expect(objectCall.stepId).toBe("step-google");
        expect(objectCall.actionType).toBe(
          "google-genai.OBJECT_SMALL.generateContent",
        );
        expect(objectCall.promptTokens ?? 0).toBeGreaterThan(0);
        expect(objectCall.completionTokens ?? 0).toBeGreaterThan(0);
        expect(objectCall.response).toContain("4");
      },
      120_000,
    );
  });
}

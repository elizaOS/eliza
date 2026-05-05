import type { IAgentRuntime } from "@elizaos/core";
import { runWithTrajectoryContext } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

function createTrajectoryRuntime() {
  const llmCalls: Record<string, unknown>[] = [];
  const trajectoryLogger = {
    isEnabled: () => true,
    logLlmCall: vi.fn((call: Record<string, unknown>) => {
      llmCalls.push(call);
    }),
  };
  const runtime = {
    agentId: "agent-google",
    character: { system: "system prompt" },
    emitEvent: vi.fn(),
    getService: vi.fn((name: string) =>
      name === "trajectories" ? trajectoryLogger : null,
    ),
    getServicesByType: vi.fn((type: string) =>
      type === "trajectories" ? [trajectoryLogger] : [],
    ),
    getSetting: vi.fn((key: string) =>
      key === "GOOGLE_GENERATIVE_AI_API_KEY" ? "test-key" : undefined,
    ),
  } as unknown as IAgentRuntime;
  return { runtime, llmCalls };
}

afterEach(() => {
  vi.doUnmock("../utils/config");
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.resetModules();
});

describe("Google GenAI trajectory wrapping", () => {
  it("records text, object, and image generation", async () => {
    const generateContent = vi.fn(async () => ({ text: '{"ok":true}' }));
    vi.doMock("../utils/config", () => ({
      createGoogleGenAI: () => ({
        models: {
          generateContent,
        },
      }),
      getActionPlannerModel: () => "gemini-action",
      getImageModel: () => "gemini-image",
      getLargeModel: () => "gemini-large",
      getMediumModel: () => "gemini-medium",
      getMegaModel: () => "gemini-mega",
      getNanoModel: () => "gemini-nano",
      getResponseHandlerModel: () => "gemini-response",
      getSafetySettings: () => [],
      getSmallModel: () => "gemini-small",
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("image-bytes", {
            headers: { "content-type": "image/png" },
          }),
      ),
    );

    const [
      { handleTextSmall },
      { handleObjectSmall },
      { handleImageDescription },
    ] = await Promise.all([
      import("../models/text"),
      import("../models/object"),
      import("../models/image"),
    ]);
    const { runtime, llmCalls } = createTrajectoryRuntime();

    await runWithTrajectoryContext(
      { trajectoryStepId: "step-google" },
      async () => {
        await handleTextSmall(runtime, {
          prompt: "Say hello",
          maxTokens: 64,
        });
        await handleObjectSmall(runtime, {
          prompt: "Return JSON",
          schema: {
            type: "object",
            properties: { ok: { type: "boolean" } },
          },
        });
        await handleImageDescription(runtime, "https://image.test/1.png");
      },
    );

    expect(generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        contents: "Return JSON",
        config: expect.objectContaining({
          responseMimeType: "application/json",
          responseJsonSchema: expect.objectContaining({ type: "object" }),
        }),
      }),
    );
    expect(llmCalls.map((call) => call.actionType)).toEqual([
      "google-genai.TEXT_SMALL.generateContent",
      "google-genai.OBJECT_SMALL.generateContent",
      "google-genai.IMAGE_DESCRIPTION.generateContent",
    ]);
  });
});

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
    agentId: "agent-openai",
    character: { system: "system prompt" },
    emitEvent: vi.fn(),
    getService: vi.fn((name: string) => (name === "trajectories" ? trajectoryLogger : null)),
    getServicesByType: vi.fn((type: string) => (type === "trajectories" ? [trajectoryLogger] : [])),
    getSetting: vi.fn((key: string) => {
      const settings: Record<string, string> = {
        OPENAI_API_KEY: "test-key",
        OPENAI_BASE_URL: "https://openai.test/v1",
        OPENAI_SMALL_MODEL: "gpt-test-small",
        OPENAI_IMAGE_MODEL: "dall-e-test",
        OPENAI_IMAGE_DESCRIPTION_MODEL: "gpt-vision-test",
        OPENAI_RESEARCH_MODEL: "o3-research-test",
        OPENAI_RESEARCH_TIMEOUT: "1000",
      };
      return settings[key];
    }),
  } as unknown as IAgentRuntime;
  return { runtime, llmCalls };
}

afterEach(() => {
  vi.doUnmock("ai");
  vi.doUnmock("../providers");
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.resetModules();
});

describe("OpenAI trajectory wrapping", () => {
  it("records text and object generation through recordLlmCall", async () => {
    const generateText = vi.fn(async () => ({
      text: "hello",
      usage: { inputTokens: 3, outputTokens: 2 },
    }));
    const generateObject = vi.fn(async () => ({
      object: { ok: true },
      usage: { inputTokens: 4, outputTokens: 5 },
    }));
    vi.doMock("ai", () => ({
      generateText,
      generateObject,
      jsonSchema: vi.fn((schema: unknown) => ({ schema })),
      streamText: vi.fn(),
    }));
    vi.doMock("../providers", () => ({
      createOpenAIClient: () => ({
        chat: (modelName: string) => ({ modelName }),
      }),
    }));

    const [{ handleTextSmall }, { handleObjectSmall }] = await Promise.all([
      import("../models/text"),
      import("../models/object"),
    ]);
    const { runtime, llmCalls } = createTrajectoryRuntime();

    await runWithTrajectoryContext({ trajectoryStepId: "step-openai" }, async () => {
      await handleTextSmall(runtime, { prompt: "Say hello" });
      await handleObjectSmall(runtime, { prompt: "Return JSON" });
    });

    expect(llmCalls).toHaveLength(2);
    expect(llmCalls[0]).toMatchObject({
      stepId: "step-openai",
      actionType: "ai.generateText",
      response: "hello",
      promptTokens: 3,
      completionTokens: 2,
    });
    expect(llmCalls[1]).toMatchObject({
      stepId: "step-openai",
      actionType: "ai.generateObject",
      promptTokens: 4,
      completionTokens: 5,
    });
  });

  it("records image and research fetch generation calls", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/images/generations")) {
        return new Response(
          JSON.stringify({
            data: [{ url: "https://image.test/1.png", revised_prompt: "rev" }],
          }),
          { status: 200 }
        );
      }
      if (url.endsWith("/chat/completions")) {
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "Title: Test\nDescription" } }],
            usage: {
              prompt_tokens: 6,
              completion_tokens: 7,
              total_tokens: 13,
            },
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ id: "resp-1", output_text: "research", output: [] }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const [{ handleImageGeneration, handleImageDescription }, { handleResearch }] =
      await Promise.all([import("../models/image"), import("../models/research")]);
    const { runtime, llmCalls } = createTrajectoryRuntime();

    await runWithTrajectoryContext({ trajectoryStepId: "step-openai" }, async () => {
      await handleImageGeneration(runtime, { prompt: "Draw a cube" });
      await handleImageDescription(runtime, "https://image.test/1.png");
      await handleResearch(runtime, { input: "Research cubes" });
    });

    expect(llmCalls.map((call) => call.actionType)).toEqual([
      "openai.images.generate",
      "openai.chat.completions.create",
      "openai.responses.create",
    ]);
  });

  it("records audio transcription and speech generation calls", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/audio/transcriptions")) {
        return new Response(JSON.stringify({ text: "transcribed audio" }), { status: 200 });
      }
      if (url.endsWith("/audio/speech")) {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { handleTranscription, handleTextToSpeech } = await import("../models/audio");
    const { runtime, llmCalls } = createTrajectoryRuntime();

    await runWithTrajectoryContext({ trajectoryStepId: "step-openai-audio" }, async () => {
      await handleTranscription(runtime, new Blob([new Uint8Array([1])], { type: "audio/webm" }));
      await handleTextToSpeech(runtime, "Speak clearly");
    });

    expect(llmCalls.map((call) => call.actionType)).toEqual([
      "openai.audio.transcriptions.create",
      "openai.audio.speech.create",
    ]);
    expect(llmCalls[0]).toMatchObject({
      stepId: "step-openai-audio",
      response: "transcribed audio",
    });
    expect(llmCalls[1]).toMatchObject({
      stepId: "step-openai-audio",
      response: "[audio bytes=3 format=mp3]",
    });
  });
});

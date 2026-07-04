/**
 * Failure-path tests for the #12182 error-handling policy (#12795): missing
 * credential, provider 4xx rejection, malformed responses, and
 * empty-completion fabrication for the NEAR AI text handlers, driven through
 * the REAL `ai` + `@ai-sdk/openai-compatible` stack against a stubbed
 * `runtime.fetch` transport — no live API. Every failure must surface as a
 * typed error — never a fabricated "" completion or success MODEL_USED event.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleTextSmall } from "../models/text";

function createRuntime(
  fetchImpl: typeof fetch | undefined,
  settings: Record<string, string | null> = {}
): IAgentRuntime {
  const defaults: Record<string, string> = { NEARAI_API_KEY: "test-key" };
  return {
    character: { system: "system prompt" },
    emitEvent: vi.fn(async () => undefined),
    fetch: fetchImpl,
    getSetting: vi.fn((key: string) =>
      key in settings ? settings[key] : (defaults[key] ?? undefined)
    ),
  } as unknown as IAgentRuntime;
}

function chatCompletion(content: string, finishReason = "stop"): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 0,
      model: "google/gemma-4-31B-it",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: finishReason,
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

const emitEventOf = (runtime: IAgentRuntime) =>
  (runtime as unknown as { emitEvent: ReturnType<typeof vi.fn> }).emitEvent;

afterEach(() => {
  vi.clearAllMocks();
});

describe("NEAR AI failure surfaces (real ai + @ai-sdk/openai-compatible, stubbed transport)", () => {
  it("throws a typed missing-credential error before any request", async () => {
    const fetchMock = vi.fn(async () => chatCompletion("hi"));
    const runtime = createRuntime(fetchMock as unknown as typeof fetch, {
      NEARAI_API_KEY: null,
    });

    await expect(handleTextSmall(runtime, { prompt: "hi" })).rejects.toThrow(
      "NEARAI_API_KEY is required"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a 401 bad credential as a typed rejection without a usage event", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "Invalid API key" } }), { status: 401 })
    );
    const runtime = createRuntime(fetchMock as unknown as typeof fetch);

    await expect(handleTextSmall(runtime, { prompt: "hi" })).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(emitEventOf(runtime)).not.toHaveBeenCalled();
  });

  it("surfaces a malformed (non-JSON) 200 response as a typed error", async () => {
    const fetchMock = vi.fn(async () => new Response("<html>oops</html>", { status: 200 }));
    const runtime = createRuntime(fetchMock as unknown as typeof fetch);

    await expect(handleTextSmall(runtime, { prompt: "hi" })).rejects.toThrow();
    expect(emitEventOf(runtime)).not.toHaveBeenCalled();
  });

  it("throws MODEL_EMPTY_COMPLETION for an empty completion instead of returning ''", async () => {
    const fetchMock = vi.fn(async () => chatCompletion("", "stop"));
    const runtime = createRuntime(fetchMock as unknown as typeof fetch);

    await expect(handleTextSmall(runtime, { prompt: "hi" })).rejects.toMatchObject({
      code: "MODEL_EMPTY_COMPLETION",
    });
    // No success telemetry for a fabricated-empty result.
    expect(emitEventOf(runtime)).not.toHaveBeenCalled();
  });

  it("keeps the success path intact: non-empty completion resolves and emits usage", async () => {
    const fetchMock = vi.fn(async () => chatCompletion("hello"));
    const runtime = createRuntime(fetchMock as unknown as typeof fetch);

    await expect(handleTextSmall(runtime, { prompt: "hi" })).resolves.toBe("hello");
    expect(emitEventOf(runtime)).toHaveBeenCalledTimes(1);
  });
});

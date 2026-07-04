/**
 * Failure-path tests for the #12182 error-handling policy (#12795): missing
 * credential, provider 4xx rejection, and empty-completion fabrication for the
 * Groq handlers, driven through the REAL `ai` + `@ai-sdk/groq` stack against a
 * stubbed transport (`runtime.fetch` / global `fetch`) — no live API. Every
 * failure must surface as a typed error — never a fabricated "" completion or
 * a success MODEL_USED event.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { groqPlugin } from "../index";

type Handler = (runtime: IAgentRuntime, params: unknown) => Promise<unknown>;

function chatCompletion(
  content: string | null,
  options?: {
    finishReason?: string;
    toolCalls?: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }>;
  }
): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 0,
      model: "openai/gpt-oss-120b",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content,
            ...(options?.toolCalls ? { tool_calls: options.toolCalls } : {}),
          },
          finish_reason: options?.finishReason ?? "stop",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message, type: "invalid_request_error" } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createRuntime(
  fetchImpl: typeof fetch | undefined,
  settings: Record<string, string | null> = {}
): IAgentRuntime {
  const defaults: Record<string, string> = { GROQ_API_KEY: "test-key" };
  return {
    character: { system: "system prompt" },
    emitEvent: vi.fn(async () => undefined),
    fetch: fetchImpl,
    getSetting: vi.fn((key: string) => (key in settings ? settings[key] : (defaults[key] ?? null))),
  } as unknown as IAgentRuntime;
}

const textSmall = groqPlugin.models?.TEXT_SMALL as Handler;
const transcription = groqPlugin.models?.TRANSCRIPTION as Handler;
const tts = groqPlugin.models?.TEXT_TO_SPEECH as Handler;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Groq text failure surfaces (real ai + @ai-sdk/groq, stubbed transport)", () => {
  it("surfaces a 401 bad credential as a typed rejection without retry or usage event", async () => {
    const fetchMock = vi.fn(async () => errorResponse(401, "Invalid API Key"));
    const runtime = createRuntime(fetchMock as unknown as typeof fetch);

    await expect(textSmall(runtime, { prompt: "hi" })).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      (runtime as unknown as { emitEvent: ReturnType<typeof vi.fn> }).emitEvent
    ).not.toHaveBeenCalled();
  });

  it("surfaces a 400 invalid request as a typed rejection", async () => {
    const fetchMock = vi.fn(async () => errorResponse(400, "bad request"));
    const runtime = createRuntime(fetchMock as unknown as typeof fetch);

    await expect(textSmall(runtime, { prompt: "hi" })).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws MODEL_EMPTY_COMPLETION for an empty completion instead of returning ''", async () => {
    const fetchMock = vi.fn(async () => chatCompletion("", { finishReason: "stop" }));
    const runtime = createRuntime(fetchMock as unknown as typeof fetch);

    await expect(textSmall(runtime, { prompt: "hi" })).rejects.toMatchObject({
      code: "MODEL_EMPTY_COMPLETION",
    });
    // No success telemetry for a fabricated-empty result.
    expect(
      (runtime as unknown as { emitEvent: ReturnType<typeof vi.fn> }).emitEvent
    ).not.toHaveBeenCalled();
  });

  it("still succeeds for a tool-call-only completion (no empty-completion false positive)", async () => {
    const fetchMock = vi.fn(async () =>
      chatCompletion(null, {
        finishReason: "tool_calls",
        toolCalls: [
          { id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":1}' } },
        ],
      })
    );
    const runtime = createRuntime(fetchMock as unknown as typeof fetch);

    const result = (await textSmall(runtime, {
      prompt: "use the tool",
      tools: [{ name: "lookup", description: "Lookup", parameters: { type: "object" } }],
    })) as { text: string; toolCalls: unknown[] };

    expect(result.text).toBe("");
    expect(result.toolCalls).toHaveLength(1);
    expect(
      (runtime as unknown as { emitEvent: ReturnType<typeof vi.fn> }).emitEvent
    ).toHaveBeenCalledTimes(1);
  });

  it("keeps the success path intact: non-empty completion resolves and emits usage", async () => {
    const fetchMock = vi.fn(async () => chatCompletion("hello"));
    const runtime = createRuntime(fetchMock as unknown as typeof fetch);

    await expect(textSmall(runtime, { prompt: "hi" })).resolves.toBe("hello");
    expect(
      (runtime as unknown as { emitEvent: ReturnType<typeof vi.fn> }).emitEvent
    ).toHaveBeenCalledTimes(1);
  });

  it("rejects a misconfigured GROQ_BASE_URL with the original parse failure as cause", async () => {
    const runtime = createRuntime(undefined, { GROQ_BASE_URL: "not a url" });

    const error = await textSmall(runtime, { prompt: "hi" }).then(
      () => {
        throw new Error("expected rejection");
      },
      (e: unknown) => e as Error
    );
    expect(error.message).toBe("GROQ_BASE_URL must be a valid http(s) URL");
    expect(error.cause).toBeDefined();
  });
});

describe("Groq audio credential/failure surfaces", () => {
  it("TRANSCRIPTION throws a typed missing-credential error before any request", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchSpy);
    const runtime = createRuntime(undefined, { GROQ_API_KEY: null });

    await expect(transcription(runtime, "aGVsbG8=")).rejects.toMatchObject({
      code: "MODEL_MISSING_CREDENTIAL",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("TEXT_TO_SPEECH throws a typed missing-credential error before any request", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchSpy);
    const runtime = createRuntime(undefined, { GROQ_API_KEY: null });

    await expect(tts(runtime, { text: "hello" })).rejects.toMatchObject({
      code: "MODEL_MISSING_CREDENTIAL",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("TRANSCRIPTION surfaces a provider 5xx as a typed error, never an empty transcript", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("upstream exploded", { status: 502 }))
    );
    const runtime = createRuntime(undefined);

    await expect(transcription(runtime, "aGVsbG8=")).rejects.toThrow("Transcription failed: 502");
  });

  it("TEXT_TO_SPEECH surfaces a provider 4xx as a typed error, never empty audio", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad voice", { status: 422 }))
    );
    const runtime = createRuntime(undefined);

    await expect(tts(runtime, { text: "hello" })).rejects.toThrow("TTS failed: 422");
  });
});

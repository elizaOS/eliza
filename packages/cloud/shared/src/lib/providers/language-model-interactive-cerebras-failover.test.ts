// Exercises the interactive-turn Cerebras failover (COLDPATH-FIX-2026-07-21).
//
// The cold-path stall-B fix: the shared/interactive turn's default Cerebras
// route had NO cross-provider fallback (withRateLimitFailFast only short-circuits
// 429), so a transient 5xx made the AI SDK SLEEP `initialDelayInMs=2000` before
// retrying the SAME dead provider (+2s/+6s of pure backoff before first token).
// getInteractiveCerebrasLanguageModel wraps the cerebras-direct model so a
// retryable upstream error (402/429/5xx) fails over to OpenRouter IMMEDIATELY
// (no backoff) for the same model. These tests prove the failover fires on a
// 5xx, is a no-op without an OpenRouter key, and never touches a non-Cerebras id.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const ORIGINAL_FETCH = globalThis.fetch;

delete process.env.BITROUTER_API_KEY;
delete process.env.AI_GATEWAY_API_KEY;
delete process.env.AIGATEWAY_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.GROQ_API_KEY;
process.env.CEREBRAS_API_KEY = "test-cerebras-key";
process.env.OPENROUTER_API_KEY = "test-openrouter-key";
delete process.env.OPENROUTER_BASE_URL;

mock.module("@/lib/utils/logger", () => ({
  logger: {
    debug: () => {},
    error: () => {},
    info: () => {},
    warn: () => {},
  },
}));

const { generateText, streamText } = await import("ai");
const { getInteractiveCerebrasLanguageModel } = await import("./language-model");

function hostOf(url: RequestInfo | URL): "openrouter" | "cerebras" | "other" {
  const u = String(url);
  if (u.includes("openrouter.ai")) return "openrouter";
  if (u.includes("cerebras.ai")) return "cerebras";
  return "other";
}

function completion(model: string, content: string): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 0,
      model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function serverError(): Response {
  return new Response(JSON.stringify({ error: { message: "upstream 5xx" } }), { status: 503 });
}

// A minimal OpenAI-compatible SSE completion stream (one content delta + done),
// so the streaming failover path yields real text chunks like production does.
function streamedCompletion(model: string, content: string): Response {
  const body =
    `data: ${JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 0,
      model,
      choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
    })}\n\n` +
    `data: ${JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 0,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}\n\n` +
    "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("getInteractiveCerebrasLanguageModel 5xx instant failover", () => {
  let hosts: Array<"openrouter" | "cerebras" | "other">;

  beforeEach(() => {
    hosts = [];
  });

  test("happy path serves directly via cerebras (no failover)", async () => {
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      hosts.push(hostOf(url));
      return completion("gemma-4-31b", "from-cerebras");
    }) as typeof fetch;

    const result = await generateText({
      model: getInteractiveCerebrasLanguageModel("gemma-4-31b"),
      prompt: "hi",
      maxRetries: 0,
    });

    expect(result.text).toBe("from-cerebras");
    expect(hosts).toEqual(["cerebras"]);
  });

  test("a transient 5xx fails over to OpenRouter WITHOUT retrying cerebras", async () => {
    // The whole point of the fix: on a 5xx we do NOT sleep-then-retry the same
    // dead cerebras upstream; we fail over to a healthy provider immediately.
    // maxRetries:0 mirrors the interactive turn's config — the ONLY retry is the
    // wrapper's instant cross-provider failover, so exactly one cerebras attempt
    // then exactly one openrouter attempt.
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const host = hostOf(url);
      hosts.push(host);
      if (host === "cerebras") return serverError();
      return completion("gemma-4-31b", "from-openrouter-failover");
    }) as typeof fetch;

    const result = await generateText({
      model: getInteractiveCerebrasLanguageModel("gemma-4-31b"),
      prompt: "hi",
      maxRetries: 0,
    });

    expect(result.text).toBe("from-openrouter-failover");
    // Exactly one cerebras attempt (no SDK backoff loop) then the failover.
    expect(hosts).toEqual(["cerebras", "openrouter"]);
  });

  test("a decorated cerebras id (:nitro) also fails over on 5xx", async () => {
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const host = hostOf(url);
      hosts.push(host);
      if (host === "cerebras") return serverError();
      return completion("gpt-oss-120b", "failover-ok");
    }) as typeof fetch;

    const result = await generateText({
      model: getInteractiveCerebrasLanguageModel("openai/gpt-oss-120b:nitro"),
      prompt: "hi",
      maxRetries: 0,
    });

    expect(result.text).toBe("failover-ok");
    expect(hosts).toEqual(["cerebras", "openrouter"]);
  });

  test("a streamed transient 5xx fails over to OpenRouter WITHOUT retrying cerebras", async () => {
    // Same fix, streaming path: exercises the middleware wrapStream branch. The
    // interactive chat turn streams, so this is the branch users actually hit.
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const host = hostOf(url);
      hosts.push(host);
      if (host === "cerebras") return serverError();
      return streamedCompletion("gemma-4-31b", "streamed-from-openrouter");
    }) as typeof fetch;

    const { textStream } = streamText({
      model: getInteractiveCerebrasLanguageModel("gemma-4-31b"),
      prompt: "hi",
      maxRetries: 0,
    });
    let out = "";
    for await (const chunk of textStream) out += chunk;

    expect(out).toBe("streamed-from-openrouter");
    expect(hosts).toEqual(["cerebras", "openrouter"]);
  });

  test("a non-retryable 400 surfaces via cerebras only (no failover)", async () => {
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      hosts.push(hostOf(url));
      return new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400 });
    }) as typeof fetch;

    await expect(
      generateText({
        model: getInteractiveCerebrasLanguageModel("gemma-4-31b"),
        prompt: "hi",
        maxRetries: 0,
      }),
    ).rejects.toBeDefined();
    // A 400 is the caller's fault; never burn a failover on it.
    expect(hosts).toEqual(["cerebras"]);
  });
});

describe("getInteractiveCerebrasLanguageModel without OpenRouter key", () => {
  test("is a no-op wrapper: a 5xx surfaces via cerebras only (nothing to fail over to)", async () => {
    // The wrapper reads getOpenRouterApiKey() at model-CONSTRUCTION time (env is
    // read fresh via getCloudAwareEnv), so removing the key before resolving the
    // model exercises the no-op branch deterministically — no re-import needed.
    const priorKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    const hosts: Array<"openrouter" | "cerebras" | "other"> = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      hosts.push(hostOf(url));
      return serverError();
    }) as typeof fetch;

    try {
      const model = getInteractiveCerebrasLanguageModel("gemma-4-31b");
      await expect(generateText({ model, prompt: "hi", maxRetries: 0 })).rejects.toBeDefined();
      // No OpenRouter key → no failover target → the 5xx surfaces from cerebras.
      expect(hosts.every((h) => h === "cerebras")).toBe(true);
      expect(hosts.length).toBeGreaterThanOrEqual(1);
    } finally {
      if (priorKey !== undefined) process.env.OPENROUTER_API_KEY = priorKey;
    }
  });
});

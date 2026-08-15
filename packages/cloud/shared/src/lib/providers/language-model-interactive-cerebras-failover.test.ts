/**
 * Exercises the interactive-turn Cerebras failover with deterministic provider
 * responses. The suite proves retryable errors switch immediately to the mapped
 * OpenRouter model, while healthy, non-retryable, and unconfigured paths retain
 * their original provider behavior.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const ORIGINAL_FETCH = globalThis.fetch;

const TEST_ENVIRONMENT = {
  ANTHROPIC_API_KEY: undefined,
  BITROUTER_API_KEY: undefined,
  CEREBRAS_API_KEY: "test-cerebras-key",
  GROQ_API_KEY: undefined,
  OPENAI_API_KEY: undefined,
  OPENROUTER_API_KEY: "test-openrouter-key",
  OPENROUTER_BASE_URL: undefined,
} as const;

type TestEnvironmentName = keyof typeof TEST_ENVIRONMENT;

const ORIGINAL_ENVIRONMENT = Object.fromEntries(
  Object.keys(TEST_ENVIRONMENT).map((name) => [name, process.env[name]]),
) as Record<TestEnvironmentName, string | undefined>;

function setEnvironmentValue(name: TestEnvironmentName, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function configureTestEnvironment(): void {
  for (const name of Object.keys(TEST_ENVIRONMENT) as TestEnvironmentName[]) {
    setEnvironmentValue(name, TEST_ENVIRONMENT[name]);
  }
}

configureTestEnvironment();

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

function requestedModel(init?: RequestInit): string | undefined {
  if (typeof init?.body !== "string") return undefined;
  return (JSON.parse(init.body) as { model?: string }).model;
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
  for (const name of Object.keys(ORIGINAL_ENVIRONMENT) as TestEnvironmentName[]) {
    setEnvironmentValue(name, ORIGINAL_ENVIRONMENT[name]);
  }
});

beforeEach(configureTestEnvironment);

describe("getInteractiveCerebrasLanguageModel 5xx instant failover", () => {
  let hosts: Array<"openrouter" | "cerebras" | "other">;

  beforeEach(() => {
    hosts = [];
  });

  test("happy path serves directly via cerebras (no failover)", async () => {
    const selections: Array<{ provider: string; fallback: boolean }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      hosts.push(hostOf(url));
      return completion("gemma-4-31b", "from-cerebras");
    }) as typeof fetch;

    const result = await generateText({
      model: getInteractiveCerebrasLanguageModel("gemma-4-31b", (selection) => {
        selections.push(selection);
      }),
      prompt: "hi",
      maxRetries: 0,
    });

    expect(result.text).toBe("from-cerebras");
    expect(hosts).toEqual(["cerebras"]);
    expect(selections).toEqual([{ provider: "cerebras", fallback: false }]);
  });

  test("a transient 5xx fails over to OpenRouter WITHOUT retrying cerebras", async () => {
    // The whole point of the fix: on a 5xx we do NOT sleep-then-retry the same
    // dead cerebras upstream; we fail over to a healthy provider immediately.
    // maxRetries:0 mirrors the interactive turn's config — the ONLY retry is the
    // wrapper's instant cross-provider failover, so exactly one cerebras attempt
    // then exactly one openrouter attempt.
    const models: string[] = [];
    const selections: Array<{ provider: string; fallback: boolean }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const host = hostOf(url);
      hosts.push(host);
      const model = requestedModel(init);
      if (model) models.push(model);
      if (host === "cerebras") return serverError();
      return completion("google/gemma-4-31b-it", "from-openrouter-failover");
    }) as typeof fetch;

    const result = await generateText({
      model: getInteractiveCerebrasLanguageModel("gemma-4-31b", (selection) => {
        selections.push(selection);
      }),
      prompt: "hi",
      maxRetries: 0,
    });

    expect(result.text).toBe("from-openrouter-failover");
    // Exactly one cerebras attempt (no SDK backoff loop) then the failover.
    expect(hosts).toEqual(["cerebras", "openrouter"]);
    expect(models).toEqual(["gemma-4-31b", "google/gemma-4-31b-it"]);
    expect(selections).toEqual([{ provider: "openrouter", fallback: true }]);
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
    const models: string[] = [];
    const selections: Array<{ provider: string; fallback: boolean }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const host = hostOf(url);
      hosts.push(host);
      const model = requestedModel(init);
      if (model) models.push(model);
      if (host === "cerebras") return serverError();
      return streamedCompletion("google/gemma-4-31b-it", "streamed-from-openrouter");
    }) as typeof fetch;

    const { textStream } = streamText({
      model: getInteractiveCerebrasLanguageModel("gemma-4-31b", (selection) => {
        selections.push(selection);
      }),
      prompt: "hi",
      maxRetries: 0,
    });
    let out = "";
    for await (const chunk of textStream) out += chunk;

    expect(out).toBe("streamed-from-openrouter");
    expect(hosts).toEqual(["cerebras", "openrouter"]);
    expect(models).toEqual(["gemma-4-31b", "google/gemma-4-31b-it"]);
    expect(selections).toEqual([{ provider: "openrouter", fallback: true }]);
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
  test("attributes a healthy direct call to Cerebras even when no fallback is configured", async () => {
    const priorKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    const selections: Array<{ provider: string; fallback: boolean }> = [];
    globalThis.fetch = (async () => completion("gemma-4-31b", "direct")) as typeof fetch;

    try {
      const result = await generateText({
        model: getInteractiveCerebrasLanguageModel("gemma-4-31b", (selection) => {
          selections.push(selection);
        }),
        prompt: "hi",
        maxRetries: 0,
      });
      expect(result.text).toBe("direct");
      expect(selections).toEqual([{ provider: "cerebras", fallback: false }]);
    } finally {
      if (priorKey !== undefined) process.env.OPENROUTER_API_KEY = priorKey;
    }
  });

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
      const selections: Array<{ provider: string; fallback: boolean }> = [];
      const model = getInteractiveCerebrasLanguageModel("gemma-4-31b", (selection) => {
        selections.push(selection);
      });
      await expect(generateText({ model, prompt: "hi", maxRetries: 0 })).rejects.toBeDefined();
      // No OpenRouter key → no failover target → the 5xx surfaces from cerebras.
      expect(hosts.every((h) => h === "cerebras")).toBe(true);
      expect(hosts.length).toBeGreaterThanOrEqual(1);
      expect(selections).toEqual([]);
    } finally {
      if (priorKey !== undefined) process.env.OPENROUTER_API_KEY = priorKey;
    }
  });
});

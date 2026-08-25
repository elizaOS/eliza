// Exercises language model openrouter fallback behavior with deterministic cloud-shared lib fixtures.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const ORIGINAL_FETCH = globalThis.fetch;

// Native-first: a native provider serves directly; OpenRouter is the on-error
// backup. We drive the OpenAI-direct path (OPENAI_BASE_URL forces the
// chat/completions client, easy to mock by host) and assert that a retryable
// failure fails over to OpenRouter.
delete process.env.BITROUTER_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.CEREBRAS_API_KEY;
delete process.env.GROQ_API_KEY;
process.env.OPENAI_API_KEY = "test-openai-key";
process.env.OPENAI_BASE_URL = "https://api.openai.test/v1";
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

const { generateText } = await import("ai");
const { getLanguageModel } = await import("./language-model");
const { SharedRuntimeTimingCollector } = await import(
  "../services/shared-runtime/shared-runtime-timing"
);

function hostOf(url: RequestInfo | URL): "openrouter" | "openai" | "other" {
  const u = String(url);
  if (u.includes("openrouter.ai")) return "openrouter";
  if (u.includes("openai.test")) return "openai";
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

function badGateway(): Response {
  return new Response(JSON.stringify({ error: { message: "Bad Gateway" } }), { status: 503 });
}

function noModelsProvided(): Response {
  return new Response(JSON.stringify({ error: { message: "No models provided", code: 400 } }), {
    status: 400,
  });
}

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("getLanguageModel native → OpenRouter fallback (AI SDK path)", () => {
  let hosts: Array<"openrouter" | "openai" | "other">;

  beforeEach(() => {
    hosts = [];
  });

  test("falls over to OpenRouter when the native provider returns a retryable 503", async () => {
    const selections: unknown[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const host = hostOf(url);
      hosts.push(host);
      return host === "openrouter" ? completion("openai/gpt-4", "from-openrouter") : badGateway();
    }) as typeof fetch;

    const result = await generateText({
      model: getLanguageModel("openai/gpt-4", undefined, (selection) => selections.push(selection)),
      prompt: "hi",
      maxRetries: 0,
    });

    expect(result.text).toBe("from-openrouter");
    expect(hosts).toEqual(["openai", "openrouter"]);
    expect(selections).toEqual([{ provider: "openrouter", fallback: true }]);
  });

  test("attributes a successful native OpenAI turn to openai, not the catch-all", async () => {
    const selections: unknown[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      hosts.push(hostOf(url));
      return completion("openai/gpt-4", "from-openai");
    }) as typeof fetch;

    const result = await generateText({
      model: getLanguageModel("openai/gpt-4", undefined, (selection) => selections.push(selection)),
      prompt: "hi",
      maxRetries: 0,
    });

    expect(result.text).toBe("from-openai");
    expect(hosts).toEqual(["openai"]);
    expect(selections).toEqual([{ provider: "openai", fallback: false }]);
  });

  test("does not fall over on a non-retryable error (400)", async () => {
    const selections: unknown[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      hosts.push(hostOf(url));
      return new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400 });
    }) as typeof fetch;

    await expect(
      generateText({
        model: getLanguageModel("openai/gpt-4", undefined, (selection) =>
          selections.push(selection),
        ),
        prompt: "hi",
        maxRetries: 0,
      }),
    ).rejects.toBeDefined();
    // OpenRouter is never reached: a 400 is a real request error, not an outage.
    expect(hosts).toEqual(["openai"]);
    // A failed call must never be attributed to a provider that served nothing.
    expect(selections).toEqual([]);
  });

  test("records a call whose provider never reported a selection as unobserved", async () => {
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      hosts.push(hostOf(url));
      return new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400 });
    }) as typeof fetch;

    let now = 0;
    const timing = new SharedRuntimeTimingCollector("failed-call", 0, () => (now += 12));
    const call = timing.prepareModelCall();
    const model = getLanguageModel("openai/gpt-4", undefined, call.select);
    call.begin();
    await expect(generateText({ model, prompt: "hi", maxRetries: 0 })).rejects.toBeDefined();
    call.finish();

    const receipt = timing.receipt("error").model;
    expect(receipt.selectedProvider).toBe("none");
    expect(receipt.calls).toEqual([{ provider: "unobserved", durationMs: 12, fallback: false }]);
  });

  test("retries OpenRouter's transient no-models 400 once after native failover", async () => {
    let openRouterAttempts = 0;
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const host = hostOf(url);
      hosts.push(host);
      if (host === "openai") return badGateway();
      openRouterAttempts++;
      return openRouterAttempts === 1
        ? noModelsProvided()
        : completion("openai/gpt-4", "recovered");
    }) as typeof fetch;

    const result = await generateText({
      model: getLanguageModel("openai/gpt-4"),
      prompt: "hi",
      maxRetries: 0,
    });

    expect(result.text).toBe("recovered");
    expect(hosts).toEqual(["openai", "openrouter", "openrouter"]);
  });

  test("does not retry an unrelated OpenRouter validation 400", async () => {
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const host = hostOf(url);
      hosts.push(host);
      if (host === "openai") return badGateway();
      return new Response(JSON.stringify({ error: { message: "model is invalid" } }), {
        status: 400,
      });
    }) as typeof fetch;

    await expect(
      generateText({ model: getLanguageModel("openai/gpt-4"), prompt: "hi", maxRetries: 0 }),
    ).rejects.toBeDefined();
    expect(hosts).toEqual(["openai", "openrouter"]);
  });
});

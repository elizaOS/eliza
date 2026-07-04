// Exercises openrouter behavior with deterministic cloud-shared lib fixtures.
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { OpenAIChatRequest } from "./types";

const ORIGINAL_FETCH = globalThis.fetch;

mock.module("@/lib/utils/logger", () => ({
  logger: {
    debug: () => {},
    error: () => {},
    info: () => {},
    warn: () => {},
  },
}));

// Imported after the logger mock so the provider binds to the stub.
const { OpenRouterProvider } = await import("./openrouter");

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

function bodyModel(init: RequestInit | undefined): string {
  return (JSON.parse(String(init?.body)) as { model: string }).model;
}

function badGateway(): Response {
  return new Response(
    JSON.stringify({ error: { message: "Bad Gateway", type: "service_unavailable" } }),
    {
      status: 503,
      headers: { "Content-Type": "application/json" },
    },
  );
}

function ok(model: string): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 0,
      model,
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

const request: OpenAIChatRequest = {
  model: "openai/gpt-oss-120b:nitro",
  messages: [{ role: "user", content: "hi" }],
  max_tokens: 5,
};

describe("OpenRouterProvider request shape", () => {
  test("defaults to the OpenRouter BYOK endpoint with bearer + attribution headers", async () => {
    let seenUrl = "";
    let seenHeaders: Headers | undefined;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(url);
      seenHeaders = new Headers(init?.headers);
      return ok(bodyModel(init));
    }) as typeof fetch;

    const provider = new OpenRouterProvider("test-key");
    const response = await provider.chatCompletions({
      ...request,
      model: "anthropic/claude-sonnet-4.6",
    });

    expect(response.status).toBe(200);
    expect(seenUrl).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(seenHeaders?.get("authorization")).toBe("Bearer test-key");
    expect(seenHeaders?.get("http-referer")).toBe("https://eliza.cloud");
    expect(seenHeaders?.get("x-title")).toBe("Eliza Cloud");
  });

  test("normalizes a custom base URL and appends /v1", async () => {
    let seenUrl = "";
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(url);
      return ok(bodyModel(init));
    }) as typeof fetch;

    const provider = new OpenRouterProvider("test-key", "https://proxy.example.com/");
    await provider.chatCompletions({ ...request, model: "anthropic/claude-sonnet-4.6" });

    expect(seenUrl).toBe("https://proxy.example.com/v1/chat/completions");
  });

  test("translates legacy xai/ ids to the OpenRouter x-ai/ catalog form", async () => {
    const models: string[] = [];
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const model = bodyModel(init);
      models.push(model);
      return ok(model);
    }) as typeof fetch;

    const provider = new OpenRouterProvider("test-key");
    await provider.chatCompletions({ ...request, model: "xai/grok-4.20" });

    expect(models).toEqual(["x-ai/grok-4.20"]);
  });
});

describe("OpenRouterProvider routing-suffix failover", () => {
  test("retries the base model when :nitro returns a retryable 503", async () => {
    const models: string[] = [];
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const model = bodyModel(init);
      models.push(model);
      return model.endsWith(":nitro") ? badGateway() : ok(model);
    }) as typeof fetch;

    const provider = new OpenRouterProvider("test-key");
    const response = await provider.chatCompletions(request);

    expect(response.status).toBe(200);
    expect(models).toEqual(["openai/gpt-oss-120b:nitro", "openai/gpt-oss-120b"]);
  });

  test("does not retry on a non-retryable error (400)", async () => {
    const models: string[] = [];
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      models.push(bodyModel(init));
      return new Response(
        JSON.stringify({ error: { message: "bad request", type: "invalid_request_error" } }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as typeof fetch;

    const provider = new OpenRouterProvider("test-key");
    await expect(provider.chatCompletions(request)).rejects.toMatchObject({ status: 400 });
    expect(models).toEqual(["openai/gpt-oss-120b:nitro"]);
  });

  test("fails fast on the :nitro priority path, then exhausts transport retry on the base model", async () => {
    const models: string[] = [];
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      models.push(bodyModel(init));
      return badGateway();
    }) as typeof fetch;

    const provider = new OpenRouterProvider("test-key", undefined, {
      maxRetries: 2,
      baseDelayMs: 0,
    });
    await expect(provider.chatCompletions(request)).rejects.toMatchObject({ status: 503 });
    expect(models).toEqual([
      "openai/gpt-oss-120b:nitro",
      "openai/gpt-oss-120b",
      "openai/gpt-oss-120b",
      "openai/gpt-oss-120b",
    ]);
  });

  test("a suffix-less model is retried transiently but never fails over to another model", async () => {
    const models: string[] = [];
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      models.push(bodyModel(init));
      return badGateway();
    }) as typeof fetch;

    const provider = new OpenRouterProvider("test-key", undefined, {
      maxRetries: 2,
      baseDelayMs: 0,
    });
    await expect(
      provider.chatCompletions({ ...request, model: "openai/gpt-oss-120b" }),
    ).rejects.toMatchObject({ status: 503 });
    expect(models).toEqual(["openai/gpt-oss-120b", "openai/gpt-oss-120b", "openai/gpt-oss-120b"]);
  });
});

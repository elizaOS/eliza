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
const { BitRouterProvider } = await import("./bitrouter");

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

describe("BitRouterProvider routing-suffix failover", () => {
  test("retries the base model when :nitro returns a retryable 503", async () => {
    const models: string[] = [];
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const model = bodyModel(init);
      models.push(model);
      return model.endsWith(":nitro") ? badGateway() : ok(model);
    }) as typeof fetch;

    const provider = new BitRouterProvider("test-key");
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

    const provider = new BitRouterProvider("test-key");
    await expect(provider.chatCompletions(request)).rejects.toMatchObject({ status: 400 });
    expect(models).toEqual(["openai/gpt-oss-120b:nitro"]);
  });

  test("retries the base id at most once, then surfaces the failure", async () => {
    const models: string[] = [];
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      models.push(bodyModel(init));
      return badGateway();
    }) as typeof fetch;

    const provider = new BitRouterProvider("test-key");
    await expect(provider.chatCompletions(request)).rejects.toMatchObject({ status: 503 });
    expect(models).toEqual(["openai/gpt-oss-120b:nitro", "openai/gpt-oss-120b"]);
  });

  test("does not attempt failover for a model without a routing suffix", async () => {
    const models: string[] = [];
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      models.push(bodyModel(init));
      return badGateway();
    }) as typeof fetch;

    const provider = new BitRouterProvider("test-key");
    await expect(
      provider.chatCompletions({ ...request, model: "openai/gpt-oss-120b" }),
    ).rejects.toMatchObject({ status: 503 });
    expect(models).toEqual(["openai/gpt-oss-120b"]);
  });
});

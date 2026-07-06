// Exercises Cerebras direct request-shaping without hitting the network.
import { afterEach, describe, expect, test } from "bun:test";
import type { OpenAIChatRequest } from "./types";

const ORIGINAL_FETCH = globalThis.fetch;

const { CerebrasDirectProvider } = await import("./cerebras-direct");

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

function body(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

function unsupportedResponseFormat(): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: "Unsupported parameter: response_format",
        type: "invalid_request_error",
        code: "unsupported_parameter",
      },
    }),
    { status: 400, headers: { "Content-Type": "application/json" } },
  );
}

function badRequest(message = "bad request"): Response {
  return new Response(
    JSON.stringify({
      error: {
        message,
        type: "invalid_request_error",
        code: "invalid_request_error",
      },
    }),
    { status: 400, headers: { "Content-Type": "application/json" } },
  );
}

function ok(model: unknown): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-cerebras-test",
      object: "chat.completion",
      created: 0,
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

const request: OpenAIChatRequest = {
  model: "gemma-4-31b",
  messages: [{ role: "user", content: "return json" }],
  response_format: { type: "json_object" },
};

describe("CerebrasDirectProvider response_format fallback", () => {
  test("retries once without response_format and marks the degraded response", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const sent = body(init);
      bodies.push(sent);
      return bodies.length === 1 ? unsupportedResponseFormat() : ok(sent.model);
    }) as typeof fetch;

    const provider = new CerebrasDirectProvider("test-key");
    const response = await provider.chatCompletions(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("x-eliza-response-format")).toBe("dropped");
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.response_format).toEqual({ type: "json_object" });
    expect(bodies[1]?.response_format).toBeUndefined();
    expect(bodies.map((sent) => sent.model)).toEqual(["gemma-4-31b", "gemma-4-31b"]);
  });

  test("does not retry unrelated 400s", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(body(init));
      return badRequest("messages must not be empty");
    }) as typeof fetch;

    const provider = new CerebrasDirectProvider("test-key");
    await expect(provider.chatCompletions(request)).rejects.toMatchObject({
      status: 400,
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.response_format).toEqual({ type: "json_object" });
  });
});

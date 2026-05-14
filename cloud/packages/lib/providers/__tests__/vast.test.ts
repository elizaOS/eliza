import { afterEach, describe, expect, mock, test } from "bun:test";
import type { OpenAIChatRequest } from "../types";
import { VastProvider } from "../vast";

const ORIGINAL_FETCH = globalThis.fetch;

// Mock the logger
mock.module("@/lib/utils/logger", () => ({
  logger: {
    debug: () => {},
    error: () => {},
    info: () => {},
    warn: () => {},
  },
}));

// Mock the models
mock.module("@/lib/models", () => ({
  getVastApiModelId: (modelId: string) => modelId,
  VAST_NATIVE_MODELS: [
    {
      id: "vast/eliza-1-27b",
      object: "model",
      created: 0,
      owned_by: "vast",
      name: "Eliza 1 27B",
    },
  ],
}));

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("VastProvider", () => {
  test("forwards eliza_prefill_plan field to worker", async () => {
    const capturedBodies: unknown[] = [];

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.body) {
        capturedBodies.push(JSON.parse(String(init.body)));
      }
      return new Response(
        JSON.stringify({
          id: "test",
          object: "chat.completion",
          created: Date.now(),
          model: "vast/eliza-1-27b",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "test response" },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const provider = new VastProvider("test-key", "http://localhost:8000");

    const prefillPlan = {
      prefix: "Hello",
      runs: [{ stop: "." }],
      freeCount: 10,
      id: "plan-1",
    };

    const request: OpenAIChatRequest = {
      model: "vast/eliza-1-27b",
      messages: [{ role: "user", content: "Hello" }],
      providerOptions: {
        eliza: {
          prefillPlan,
        },
      },
    };

    await provider.chatCompletions(request);

    expect(capturedBodies).toHaveLength(1);
    const body = capturedBodies[0] as Record<string, unknown>;
    expect(body.eliza_prefill_plan).toEqual(prefillPlan);
  });

  test("forwards eliza_guided_decode field to worker", async () => {
    const capturedBodies: unknown[] = [];

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.body) {
        capturedBodies.push(JSON.parse(String(init.body)));
      }
      return new Response(
        JSON.stringify({
          id: "test",
          object: "chat.completion",
          created: Date.now(),
          model: "vast/eliza-1-27b",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "test response" },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const provider = new VastProvider("test-key", "http://localhost:8000");

    const request: OpenAIChatRequest = {
      model: "vast/eliza-1-27b",
      messages: [{ role: "user", content: "Hello" }],
      providerOptions: {
        eliza: {
          guidedDecode: true,
        },
      },
    };

    await provider.chatCompletions(request);

    expect(capturedBodies).toHaveLength(1);
    const body = capturedBodies[0] as Record<string, unknown>;
    expect(body.eliza_guided_decode).toBe(true);
  });

  test("forwards eliza_planner_action_schemas field to worker", async () => {
    const capturedBodies: unknown[] = [];

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.body) {
        capturedBodies.push(JSON.parse(String(init.body)));
      }
      return new Response(
        JSON.stringify({
          id: "test",
          object: "chat.completion",
          created: Date.now(),
          model: "vast/eliza-1-27b",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "test response" },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const provider = new VastProvider("test-key", "http://localhost:8000");

    const schemas = [
      {
        name: "action1",
        description: "First action",
        parameters: { type: "object", properties: {} },
      },
    ];

    const request: OpenAIChatRequest = {
      model: "vast/eliza-1-27b",
      messages: [{ role: "user", content: "Hello" }],
      providerOptions: {
        eliza: {
          plannerActionSchemas: schemas,
        },
      },
    };

    await provider.chatCompletions(request);

    expect(capturedBodies).toHaveLength(1);
    const body = capturedBodies[0] as Record<string, unknown>;
    expect(body.eliza_planner_action_schemas).toEqual(schemas);
  });

  test("forwards multiple eliza fields together", async () => {
    const capturedBodies: unknown[] = [];

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.body) {
        capturedBodies.push(JSON.parse(String(init.body)));
      }
      return new Response(
        JSON.stringify({
          id: "test",
          object: "chat.completion",
          created: Date.now(),
          model: "vast/eliza-1-27b",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "test response" },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const provider = new VastProvider("test-key", "http://localhost:8000");

    const request: OpenAIChatRequest = {
      model: "vast/eliza-1-27b",
      messages: [{ role: "user", content: "Hello" }],
      providerOptions: {
        eliza: {
          prefillPlan: { prefix: "test", runs: [], freeCount: 5, id: "p1" },
          guidedDecode: true,
          plannerActionSchemas: [],
        },
      },
    };

    await provider.chatCompletions(request);

    expect(capturedBodies).toHaveLength(1);
    const body = capturedBodies[0] as Record<string, unknown>;
    expect(body.eliza_prefill_plan).toBeDefined();
    expect(body.eliza_guided_decode).toBe(true);
    expect(body.eliza_planner_action_schemas).toEqual([]);
  });

  test("omits eliza fields when providerOptions is undefined", async () => {
    const capturedBodies: unknown[] = [];

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.body) {
        capturedBodies.push(JSON.parse(String(init.body)));
      }
      return new Response(
        JSON.stringify({
          id: "test",
          object: "chat.completion",
          created: Date.now(),
          model: "vast/eliza-1-27b",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "test response" },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const provider = new VastProvider("test-key", "http://localhost:8000");

    const request: OpenAIChatRequest = {
      model: "vast/eliza-1-27b",
      messages: [{ role: "user", content: "Hello" }],
    };

    await provider.chatCompletions(request);

    expect(capturedBodies).toHaveLength(1);
    const body = capturedBodies[0] as Record<string, unknown>;
    expect(body.eliza_prefill_plan).toBeUndefined();
    expect(body.eliza_guided_decode).toBeUndefined();
    expect(body.eliza_planner_action_schemas).toBeUndefined();
  });

  test("omits eliza fields when no eliza options are provided", async () => {
    const capturedBodies: unknown[] = [];

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.body) {
        capturedBodies.push(JSON.parse(String(init.body)));
      }
      return new Response(
        JSON.stringify({
          id: "test",
          object: "chat.completion",
          created: Date.now(),
          model: "vast/eliza-1-27b",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "test response" },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const provider = new VastProvider("test-key", "http://localhost:8000");

    const request: OpenAIChatRequest = {
      model: "vast/eliza-1-27b",
      messages: [{ role: "user", content: "Hello" }],
      providerOptions: {
        other: { someField: "value" },
      },
    };

    await provider.chatCompletions(request);

    expect(capturedBodies).toHaveLength(1);
    const body = capturedBodies[0] as Record<string, unknown>;
    expect(body.eliza_prefill_plan).toBeUndefined();
    expect(body.eliza_guided_decode).toBeUndefined();
    expect(body.eliza_planner_action_schemas).toBeUndefined();
  });

  test("preserves standard OpenAI fields", async () => {
    const capturedBodies: unknown[] = [];

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.body) {
        capturedBodies.push(JSON.parse(String(init.body)));
      }
      return new Response(
        JSON.stringify({
          id: "test",
          object: "chat.completion",
          created: Date.now(),
          model: "vast/eliza-1-27b",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "test response" },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const provider = new VastProvider("test-key", "http://localhost:8000");

    const request: OpenAIChatRequest = {
      model: "vast/eliza-1-27b",
      messages: [{ role: "user", content: "Hello" }],
      temperature: 0.7,
      max_tokens: 100,
      top_p: 0.9,
      providerOptions: {
        eliza: {
          prefillPlan: { prefix: "test", runs: [], freeCount: 5, id: "p1" },
        },
      },
    };

    await provider.chatCompletions(request);

    expect(capturedBodies).toHaveLength(1);
    const body = capturedBodies[0] as Record<string, unknown>;
    expect(body.temperature).toBe(0.7);
    expect(body.max_tokens).toBe(100);
    expect(body.top_p).toBe(0.9);
    expect(body.messages).toEqual([{ role: "user", content: "Hello" }]);
  });
});

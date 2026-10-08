/**
 * Exercises the interactive-turn Cerebras failover with deterministic provider
 * responses. The suite proves retryable errors switch immediately to the mapped
 * OpenRouter model, while healthy, non-retryable, and unconfigured paths retain
 * their original provider behavior.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const ORIGINAL_FETCH = globalThis.fetch;
const ENV_KEYS = [
  "BITROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GROQ_API_KEY",
  "CEREBRAS_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENROUTER_BASE_URL",
] as const;
const originalEnvironment = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
const actualLogger = await import("../utils/logger");

delete process.env.BITROUTER_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.GROQ_API_KEY;
process.env.CEREBRAS_API_KEY = "test-cerebras-key";
process.env.OPENROUTER_API_KEY = "test-openrouter-key";
delete process.env.OPENROUTER_BASE_URL;

mock.module("../utils/logger", () => ({
  logger: {
    debug: () => {},
    error: () => {},
    info: () => {},
    warn: () => {},
  },
}));

const FIXTURE_UNMAPPED_NATIVE_MODEL = "cerebras-native-unmapped-fixture";
const actualModels = await import("../models");
// A future catalog entry must remain usable before its alternate mapping exists.
mock.module("../models", () => ({
  ...actualModels,
  CEREBRAS_NATIVE_TEXT_MODELS: [
    ...actualModels.CEREBRAS_NATIVE_TEXT_MODELS,
    FIXTURE_UNMAPPED_NATIVE_MODEL,
  ],
}));
const { APICallError, generateText, jsonSchema, streamText } = await import("ai");
const {
  getInteractiveCerebrasLanguageModel,
  ProviderConfigurationError,
  ProviderFallbackRefusedError,
} = await import("./language-model");

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

function noModelsProvided(): Response {
  return new Response(JSON.stringify({ error: { message: "No models provided", code: 400 } }), {
    status: 400,
  });
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

afterAll(() => {
  mock.module("../models", () => actualModels);
  mock.module("../utils/logger", () => actualLogger);
  for (const [key, value] of originalEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("getInteractiveCerebrasLanguageModel 5xx instant failover", () => {
  let hosts: Array<"openrouter" | "cerebras" | "other">;

  beforeEach(() => {
    hosts = [];
  });

  test.each(["qwen-3.8-27b", "cerebras/qwen-3.8-27b", "cerebras:qwen-3.8-27b"])(
    "%s calls its healthy native primary with both provider keys configured",
    async (model) => {
      const selections: unknown[] = [];
      const models: string[] = [];
      globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
        hosts.push(hostOf(url));
        const requested = requestedModel(init);
        if (requested) models.push(requested);
        return completion("qwen-3.8-27b", "native-qwen-reply");
      }) as typeof fetch;

      const result = await generateText({
        model: getInteractiveCerebrasLanguageModel(model, (selection) =>
          selections.push(selection),
        ),
        prompt: "hi",
        maxRetries: 0,
      });

      expect(result.text).toBe("native-qwen-reply");
      expect(hosts).toEqual(["cerebras"]);
      expect(models).toEqual(["qwen-3.8-27b"]);
      expect(selections).toEqual([{ provider: "cerebras", fallback: false }]);
    },
  );

  test("streams a healthy native Qwen primary without invoking OpenRouter", async () => {
    const selections: unknown[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      hosts.push(hostOf(url));
      return streamedCompletion("qwen-3.8-27b", "native-qwen-stream");
    }) as typeof fetch;

    const result = streamText({
      model: getInteractiveCerebrasLanguageModel("qwen-3.8-27b", (selection) =>
        selections.push(selection),
      ),
      prompt: "hi",
      maxRetries: 0,
    });

    expect(await result.text).toBe("native-qwen-stream");
    expect(hosts).toEqual(["cerebras"]);
    expect(selections).toEqual([{ provider: "cerebras", fallback: false }]);
  });

  test.each([400, 401])(
    "Qwen HTTP %s remains the original non-retryable primary failure",
    async (status) => {
      globalThis.fetch = (async (url: RequestInfo | URL) => {
        hosts.push(hostOf(url));
        return new Response(JSON.stringify({ error: { message: "rejected fixture request" } }), {
          status,
        });
      }) as typeof fetch;

      let caught: unknown;
      try {
        await generateText({
          model: getInteractiveCerebrasLanguageModel("qwen-3.8-27b"),
          prompt: "hi",
          maxRetries: 0,
        });
      } catch (error) {
        caught = error;
      }
      expect(APICallError.isInstance(caught)).toBe(true);
      expect((caught as InstanceType<typeof APICallError>).statusCode).toBe(status);
      expect(hosts).toEqual(["cerebras"]);
    },
  );

  test.each([429, 500, 503])(
    "Qwen Generate HTTP %s immediately fails over to the same Qwen model",
    async (status) => {
      const selections: unknown[] = [];
      const models: string[] = [];
      globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
        const host = hostOf(url);
        hosts.push(host);
        const requested = requestedModel(init);
        if (requested) models.push(requested);
        if (host === "cerebras") {
          return new Response(JSON.stringify({ error: { message: "retryable primary fixture" } }), {
            status,
          });
        }
        if (host !== "openrouter") throw new Error("Unmocked provider route forbidden");
        return completion("qwen/qwen3.8-27b", "same-qwen-generate");
      }) as typeof fetch;
      const result = await generateText({
        model: getInteractiveCerebrasLanguageModel("qwen-3.8-27b", (selection) =>
          selections.push(selection),
        ),
        prompt: "hi",
        maxRetries: 0,
      });
      expect(result.text).toBe("same-qwen-generate");
      expect(hosts).toEqual(["cerebras", "openrouter"]);
      expect(models).toEqual(["qwen-3.8-27b", "qwen/qwen3.8-27b"]);
      expect(selections).toEqual([{ provider: "openrouter", fallback: true }]);
    },
  );

  test.each([429, 500, 503])(
    "Qwen Stream HTTP %s immediately fails over to the same Qwen model",
    async (status) => {
      const selections: unknown[] = [];
      const models: string[] = [];
      globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
        const host = hostOf(url);
        hosts.push(host);
        const requested = requestedModel(init);
        if (requested) models.push(requested);
        if (host === "cerebras") {
          return new Response(JSON.stringify({ error: { message: "retryable primary fixture" } }), {
            status,
          });
        }
        if (host !== "openrouter") throw new Error("Unmocked provider route forbidden");
        return streamedCompletion("qwen/qwen3.8-27b", "same-qwen-stream");
      }) as typeof fetch;
      const result = streamText({
        model: getInteractiveCerebrasLanguageModel("qwen-3.8-27b", (selection) =>
          selections.push(selection),
        ),
        prompt: "hi",
        maxRetries: 0,
      });
      expect(await result.text).toBe("same-qwen-stream");
      expect(hosts).toEqual(["cerebras", "openrouter"]);
      expect(models).toEqual(["qwen-3.8-27b", "qwen/qwen3.8-27b"]);
      expect(selections).toEqual([{ provider: "openrouter", fallback: true }]);
    },
  );

  test("happy path serves directly via cerebras (no failover)", async () => {
    const selections: unknown[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      hosts.push(hostOf(url));
      return completion("gemma-4-31b", "from-cerebras");
    }) as typeof fetch;

    const result = await generateText({
      model: getInteractiveCerebrasLanguageModel("gemma-4-31b", (selection) =>
        selections.push(selection),
      ),
      prompt: "hi",
      maxRetries: 0,
    });

    expect(result.text).toBe("from-cerebras");
    expect(hosts).toEqual(["cerebras"]);
    expect(selections).toEqual([{ provider: "cerebras", fallback: false }]);
  });

  test("a transient 5xx fails over to OpenRouter WITHOUT retrying cerebras", async () => {
    const selections: unknown[] = [];
    // The whole point of the fix: on a 5xx we do NOT sleep-then-retry the same
    // dead cerebras upstream; we fail over to a healthy provider immediately.
    // maxRetries:0 mirrors the interactive turn's config — the ONLY retry is the
    // wrapper's instant cross-provider failover, so exactly one cerebras attempt
    // then exactly one openrouter attempt.
    const models: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const host = hostOf(url);
      hosts.push(host);
      const model = requestedModel(init);
      if (model) models.push(model);
      if (host === "cerebras") return serverError();
      return completion("google/gemma-4-31b-it", "from-openrouter-failover");
    }) as typeof fetch;

    const result = await generateText({
      model: getInteractiveCerebrasLanguageModel("gemma-4-31b", (selection) =>
        selections.push(selection),
      ),
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
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const host = hostOf(url);
      hosts.push(host);
      const model = requestedModel(init);
      if (model) models.push(model);
      if (host === "cerebras") return serverError();
      return streamedCompletion("google/gemma-4-31b-it", "streamed-from-openrouter");
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
    expect(models).toEqual(["gemma-4-31b", "google/gemma-4-31b-it"]);
  });

  test("retries OpenRouter's transient no-models 400 once during streamed failover", async () => {
    let openRouterAttempts = 0;
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const host = hostOf(url);
      hosts.push(host);
      if (host === "cerebras") return serverError();
      openRouterAttempts++;
      return openRouterAttempts === 1
        ? noModelsProvided()
        : streamedCompletion("google/gemma-4-31b-it", "recovered-stream");
    }) as typeof fetch;

    const { textStream } = streamText({
      model: getInteractiveCerebrasLanguageModel("gemma-4-31b"),
      prompt: "hi",
      maxRetries: 0,
    });
    let out = "";
    for await (const chunk of textStream) out += chunk;

    expect(out).toBe("recovered-stream");
    expect(hosts).toEqual(["cerebras", "openrouter", "openrouter"]);
  });

  test("bounds repeated OpenRouter no-models failures at one identical retry", async () => {
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const host = hostOf(url);
      hosts.push(host);
      return host === "cerebras" ? serverError() : noModelsProvided();
    }) as typeof fetch;

    await expect(
      generateText({
        model: getInteractiveCerebrasLanguageModel("gemma-4-31b"),
        prompt: "hi",
        maxRetries: 0,
      }),
    ).rejects.toBeDefined();
    expect(hosts).toEqual(["cerebras", "openrouter", "openrouter"]);
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

describe("native primary before alternate catalog resolution", () => {
  test.each([false, true])(
    "healthy unmapped catalog entry remains native (stream=%s)",
    async (stream) => {
      const hosts: string[] = [];
      globalThis.fetch = (async (url: RequestInfo | URL) => {
        hosts.push(hostOf(url));
        return stream
          ? streamedCompletion(FIXTURE_UNMAPPED_NATIVE_MODEL, "native-catalog-reply")
          : completion(FIXTURE_UNMAPPED_NATIVE_MODEL, "native-catalog-reply");
      }) as typeof fetch;
      const params = {
        model: getInteractiveCerebrasLanguageModel(FIXTURE_UNMAPPED_NATIVE_MODEL),
        prompt: "hi",
        maxRetries: 0,
      };
      const result = stream ? streamText(params) : await generateText(params);
      expect(await result.text).toBe("native-catalog-reply");
      expect(hosts).toEqual(["cerebras"]);
    },
  );

  test.each([false, true])(
    "unmapped alternate fails only after retryable native dispatch (stream=%s)",
    async (stream) => {
      const hosts: string[] = [];
      const errors: unknown[] = [];
      globalThis.fetch = (async (url: RequestInfo | URL) => {
        hosts.push(hostOf(url));
        return serverError();
      }) as typeof fetch;
      const params = {
        model: getInteractiveCerebrasLanguageModel(FIXTURE_UNMAPPED_NATIVE_MODEL),
        prompt: "hi",
        maxRetries: 0,
      };
      if (stream) {
        const result = streamText({
          ...params,
          onError: ({ error }) => {
            errors.push(error);
          },
        });
        await expect(result.text).rejects.toBeDefined();
        expect(errors.some((error) => error instanceof ProviderConfigurationError)).toBe(true);
      } else {
        await expect(generateText(params)).rejects.toBeInstanceOf(ProviderConfigurationError);
      }
      expect(hosts).toEqual(["cerebras"]);
    },
  );
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

describe("Core Qwen thinking-off control through the actual existing clients", () => {
  function options(thinking: unknown = "off") {
    return {
      eliza: { thinking },
      openai: { promptCacheKey: "core-cache-not-restored" },
      cerebras: { prompt_cache_key: "core-room-not-restored" },
    };
  }
  test.each(["qwen-3.8-27b", "cerebras/qwen-3.8-27b", "cerebras:qwen-3.8-27b:nitro"])(
    "%s suppresses reasoning without restoring cache hints",
    async (modelId) => {
      const coreOptions = options();
      const before = JSON.stringify(coreOptions);
      const bodies: Array<Record<string, unknown>> = [];
      globalThis.fetch = (async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return completion("qwen-3.8-27b", "ready");
      }) as typeof fetch;
      await generateText({
        model: getInteractiveCerebrasLanguageModel(modelId, undefined, undefined, coreOptions),
        prompt: "unchanged",
        maxRetries: 0,
      });
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toMatchObject({ model: "qwen-3.8-27b", reasoning_effort: "none" });
      expect(bodies[0]).not.toHaveProperty("prompt_cache_key");
      expect(bodies[0]).not.toHaveProperty("enable_thinking");
      expect(bodies[0]).not.toHaveProperty("disable_reasoning");
      expect(JSON.stringify(coreOptions)).toBe(before);
    },
  );
  test.each([undefined, "on", "auto", false])(
    "non-off Core hint %s keeps the existing wire",
    async (hint) => {
      const bodies: Array<Record<string, unknown>> = [];
      globalThis.fetch = (async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return completion("qwen-3.8-27b", "ready");
      }) as typeof fetch;
      await generateText({
        model: getInteractiveCerebrasLanguageModel(
          "qwen-3.8-27b",
          undefined,
          undefined,
          hint === undefined ? undefined : options(hint),
        ),
        prompt: "unchanged",
        maxRetries: 0,
      });
      expect(bodies[0]).not.toHaveProperty("reasoning_effort");
    },
  );
  test("does not send an unsupported none control to the other Cerebras model", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return completion("gpt-oss-120b", "ready");
    }) as typeof fetch;
    await generateText({
      model: getInteractiveCerebrasLanguageModel("gpt-oss-120b", undefined, undefined, options()),
      prompt: "unchanged",
      maxRetries: 0,
    });
    expect(bodies[0]).not.toHaveProperty("reasoning_effort");
  });
  test("an unreadable optional hint cannot change provider behavior", async () => {
    const coreOptions = Object.defineProperty({}, "eliza", {
      get() {
        throw new Error("PRIVATE_HINT");
      },
    });
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return completion("qwen-3.8-27b", "ready");
    }) as typeof fetch;
    await generateText({
      model: getInteractiveCerebrasLanguageModel("qwen-3.8-27b", undefined, undefined, coreOptions),
      prompt: "unchanged",
      maxRetries: 0,
    });
    expect(bodies[0]).not.toHaveProperty("reasoning_effort");
  });
  for (const mode of ["generate", "stream"] as const) {
    test(`${mode} preserves body/model/calls and the documented shorthand in real same-model fallback`, async () => {
      const run = async (thinkingOff: boolean) => {
        const requests: Array<{ host: string; body: Record<string, unknown> }> = [];
        globalThis.fetch = (async (url, init) => {
          const host = hostOf(url);
          requests.push({ host, body: JSON.parse(String(init?.body)) });
          if (host === "cerebras") return serverError();
          if (host !== "openrouter") throw new Error("Unexpected provider");
          return mode === "generate"
            ? completion("qwen/qwen3.8-27b", "ready")
            : streamedCompletion("qwen/qwen3.8-27b", "ready");
        }) as typeof fetch;
        const call = {
          model: getInteractiveCerebrasLanguageModel(
            "qwen-3.8-27b",
            undefined,
            undefined,
            thinkingOff ? options() : undefined,
          ),
          messages: [
            { role: "system" as const, content: "Trusted unchanged policy" },
            { role: "user" as const, content: "same prompt" },
          ],
          tools: {
            PROBE: {
              inputSchema: jsonSchema({
                type: "object",
                properties: { value: { type: "string" } },
                required: ["value"],
              }),
            },
          },
          toolChoice: "auto" as const,
          maxOutputTokens: 64,
          maxRetries: 0,
        };
        if (mode === "generate") await generateText(call);
        else {
          const result = streamText(call);
          for await (const _part of result.fullStream) {
          }
          await result.usage;
        }
        return requests;
      };
      const before = await run(false);
      const after = await run(true);
      expect(after.map((r) => r.host)).toEqual(["cerebras", "openrouter"]);
      expect(after.map((r) => r.body.model)).toEqual(["qwen-3.8-27b", "qwen/qwen3.8-27b"]);
      expect(before).toHaveLength(after.length);
      for (let i = 0; i < after.length; i += 1) {
        const { reasoning_effort: effort, ...body } = after[i].body;
        expect(effort).toBe("none");
        expect(body).toEqual(before[i].body);
        expect(after[i].body).not.toHaveProperty("prompt_cache_key");
        expect(after[i].body).not.toHaveProperty("reasoning");
      }
    });
    test(`${mode} retryable response racing cancellation never starts the fallback`, async () => {
      const controller = new AbortController();
      const hosts: string[] = [];
      globalThis.fetch = (async (url) => {
        const host = hostOf(url);
        hosts.push(host);
        if (host !== "cerebras") throw new Error("Cancelled call must not start fallback");
        controller.abort(new DOMException("caller cancelled", "AbortError"));
        return serverError();
      }) as typeof fetch;
      const call = {
        model: getInteractiveCerebrasLanguageModel("qwen-3.8-27b", undefined, undefined, options()),
        prompt: "same prompt",
        maxRetries: 0,
        abortSignal: controller.signal,
      };
      if (mode === "generate") await expect(generateText(call)).rejects.toThrow();
      else {
        const result = streamText(call);
        const drain = (async () => {
          for await (const _part of result.fullStream) {
          }
          return await result.usage;
        })();
        await expect(drain).rejects.toThrow();
      }
      expect(hosts).toEqual(["cerebras"]);
    });
  }
});

describe("public routing slot and cancellation before cross-provider fallback", () => {
  for (const mode of ["generate", "stream"] as const) {
    for (const thinkingOff of [false, true]) {
      test(`${mode} keeps third routing policy authority with fourth Core hint ${thinkingOff}`, async () => {
        const bodies: Array<Record<string, unknown>> = [];
        const hosts: string[] = [];
        const policyCalls: unknown[] = [];
        const routing = {
          fallbackPolicy: (context: unknown) => {
            policyCalls.push(context);
            return { allow: false as const, reason: "fixture routing refusal" };
          },
        };
        globalThis.fetch = Object.assign(
          async (url: RequestInfo | URL, init?: RequestInit) => {
            hosts.push(hostOf(url));
            bodies.push(JSON.parse(String(init?.body)));
            return serverError();
          },
          { preconnect: ORIGINAL_FETCH.preconnect },
        );
        const model = getInteractiveCerebrasLanguageModel(
          "qwen-3.8-27b",
          undefined,
          routing,
          thinkingOff ? { eliza: { thinking: "off" } } : undefined,
        );
        const call = {
          prompt: [
            { role: "user" as const, content: [{ type: "text" as const, text: "unchanged" }] },
          ],
          maxOutputTokens: 64,
        };
        const work = mode === "generate" ? model.doGenerate(call) : model.doStream(call);
        await expect(work).rejects.toBeInstanceOf(ProviderFallbackRefusedError);
        expect(hosts).toEqual(["cerebras"]);
        expect(policyCalls).toHaveLength(1);
        expect(policyCalls[0]).toMatchObject({
          model: "qwen-3.8-27b",
          primary: "cerebras",
          alternate: "openrouter",
          operation: mode,
          status: 503,
        });
        if (thinkingOff) expect(bodies[0].reasoning_effort).toBe("none");
        else expect(bodies[0]).not.toHaveProperty("reasoning_effort");
      });
    }
    test(`${mode} cancellation retains the primary SDK error before routing policy`, async () => {
      const controller = new AbortController();
      const policyCalls: unknown[] = [];
      const hosts: string[] = [];
      const routing = {
        fallbackPolicy: (context: unknown) => {
          policyCalls.push(context);
          return { allow: true as const };
        },
      };
      globalThis.fetch = Object.assign(
        async (url: RequestInfo | URL) => {
          hosts.push(hostOf(url));
          controller.abort(new DOMException("cancelled fixture", "AbortError"));
          return serverError();
        },
        { preconnect: ORIGINAL_FETCH.preconnect },
      );
      const model = getInteractiveCerebrasLanguageModel("qwen-3.8-27b", undefined, routing, {
        eliza: { thinking: "off" },
      });
      const call = {
        prompt: [
          { role: "user" as const, content: [{ type: "text" as const, text: "unchanged" }] },
        ],
        abortSignal: controller.signal,
      };
      let failure: unknown;
      try {
        await (mode === "generate" ? model.doGenerate(call) : model.doStream(call));
      } catch (error) {
        failure = error;
      }
      expect(APICallError.isInstance(failure)).toBe(true);
      if (!APICallError.isInstance(failure)) throw new Error("Original primary SDK error missing");
      expect(failure.statusCode).toBe(503);
      expect(failure.url).toContain("cerebras.ai");
      expect(failure).not.toBeInstanceOf(ProviderFallbackRefusedError);
      expect(hosts).toEqual(["cerebras"]);
      expect(policyCalls).toEqual([]);
      expect(controller.signal.aborted).toBe(true);
    });
  }
});

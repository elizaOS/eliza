/**
 * Operator fallback model at the HTTP boundary: a loopback provider rejects
 * the primary model with a long Retry-After and serves the fallback model.
 * After the first 429 the same runtime's next requests go to the fallback for
 * the cooldown window, without a hold error. Real HTTP fixture; no live model.
 */
import { createServer, type Server } from "node:http";
import {
  createModelAttemptAllowance,
  type IAgentRuntime,
  ModelType,
  runWithStreamingContext,
} from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __INTERNAL_resolveFallbackModelName,
  __INTERNAL_selectRequestModelName,
  handleTextSmall,
} from "../models/text";

// Deterministic scheduler only: the real SDK still serializes and sends every body.
const sdkBarrier = vi.hoisted(() => ({
  before: undefined as undefined | ((params: unknown) => Promise<void>),
  captured: undefined as unknown,
}));
vi.mock("ai", async (original) => {
  const actual = await original<typeof import("ai")>();
  return {
    ...actual,
    generateText: (...args: Parameters<typeof actual.generateText>) => {
      if (!sdkBarrier.before) return actual.generateText(...args);
      return sdkBarrier.before(args[0]).then(() => actual.generateText(...args));
    },
  };
});

let server: Server;
let baseUrl: string;
let requestedModels: string[] = [];
let wireBodies: Record<string, unknown>[] = [];
let forceUnavailable = false;
let heldResponse: (() => void) | undefined;

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      wireBodies.push(JSON.parse(body));
      if (heldResponse && wireBodies.length === 1) {
        heldResponse();
        return;
      }
      const model = String((JSON.parse(body) as { model?: string }).model ?? "");
      requestedModels.push(model);
      if (forceUnavailable) {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message: "Fixture server unavailable",
              type: "server_error",
            },
          })
        );
        return;
      }
      if (model === "qwen-3.8-27b") {
        response.writeHead(429, {
          "content-type": "application/json",
          "retry-after": "60",
        });
        response.end(
          JSON.stringify({
            error: { message: "Tokens per minute limit exceeded" },
          })
        );
        return;
      }
      if ((JSON.parse(body) as { stream?: boolean }).stream) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = {
          id: "fixture",
          object: "chat.completion.chunk",
          created: 1,
          model,
          choices: [
            {
              index: 0,
              delta: { content: "served by fallback" },
              finish_reason: null,
            },
          ],
        };
        response.end(
          `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`
        );
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "chatcmpl-fallback",
          object: "chat.completion",
          created: 1,
          model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "served by fallback" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        })
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture failed to bind");
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
});

beforeEach(() => {
  requestedModels = [];
  wireBodies = [];
  forceUnavailable = false;
  heldResponse = undefined;
  sdkBarrier.before = undefined;
  sdkBarrier.captured = undefined;
  vi.stubEnv("ELIZA_PROVIDER", "cerebras");
  vi.stubEnv("OPENAI_BASE_URL", baseUrl);
  vi.stubEnv("OPENAI_API_KEY", "loopback-only-key");
  vi.stubEnv("CEREBRAS_API_KEY", undefined);
  vi.stubEnv("ELIZA_MOCK_OPENAI_BASE", undefined);
  vi.stubEnv("ELIZA_TRAJECTORY_STRICT", undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function runtime(settings: Record<string, string> = {}): IAgentRuntime {
  return {
    getSetting: (key: string) => settings[key],
    character: { name: "Ada", system: "Reply to the user." },
    emitEvent: async () => {},
    getService: () => null,
    getServicesByType: () => [],
  } as unknown as IAgentRuntime;
}

describe("host trial allowance at the actual model HTTP boundary", () => {
  async function bounded({
    stream = false,
    maxAttempts = 1,
    rejectsFirst = false,
    unknownRoute = false,
    retire = "",
    messageMode = "",
    parallel = false,
  }: {
    stream?: boolean;
    maxAttempts?: number;
    rejectsFirst?: boolean;
    unknownRoute?: boolean;
    retire?: string;
    messageMode?: string;
    parallel?: boolean;
  } = {}) {
    const agent = createSQLiteTestRuntime({
      character: {
        name: "Bounded fixture",
        bio: "test",
        settings: {
          OPENAI_BASE_URL: baseUrl,
          OPENAI_API_KEY: "loopback-only-key",
        },
      },
      logLevel: "fatal",
    });
    agent.registerModel(ModelType.TEXT_SMALL, handleTextSmall, "openai", 100);
    const stop = new AbortController();
    const allowance = createModelAttemptAllowance({
      signal: stop.signal,
      budgetMicroUsd: parallel ? 26217 : 1000000,
      maxAttempts: parallel ? 10 : maxAttempts,
      maxOutputTokens: 17,
      expiresAt: Date.now() + 60000,
      tariffs: [
        {
          provider: "openai-compatible",
          model: "gemma-4-31b",
          route: unknownRoute ? "https://foreign.invalid" : baseUrl,
          inputNanoUsdPerToken: 100,
          outputNanoUsdPerToken: 100,
          inputTokenUpperBound: 262144,
        },
      ],
    });
    const lease = allowance.openTurn("fixture-turn", stop.signal);
    try {
      await runWithStreamingContext(
        {
          messageId: "fixture-turn",
          modelAttemptTurnId: "fixture-turn",
          modelAttemptLease: lease,
          abortSignal: stop.signal,
        },
        async () => {
          const entered = Promise.withResolvers<void>(),
            release = Promise.withResolvers<void>();
          const sdkMode = retire.startsWith("sdk-");
          if (sdkMode)
            sdkBarrier.before = async (params) => {
              sdkBarrier.captured = params;
              entered.resolve();
              await release.promise;
            };
          const call = agent.useModel(ModelType.TEXT_SMALL, {
            ...(messageMode
              ? {
                  messages: [
                    { role: "user", content: "Complete original prompt" },
                    {
                      role: "assistant",
                      toolCalls: [
                        {
                          id: "fixture-call",
                          function: {
                            name: "fixture-tool",
                            arguments: '{"test":true}',
                          },
                        },
                      ],
                    },
                    {
                      role: "tool",
                      toolCallId: "fixture-call",
                      name: "fixture-tool",
                      content:
                        messageMode === "tools"
                          ? '{"ready":true}'
                          : [
                              {
                                type: "tool-result",
                                toolCallId: "fixture-call",
                                toolName: "fixture-tool",
                                output: {
                                  type: "content",
                                  value: [
                                    {
                                      type: "image-data",
                                      data: "fixture",
                                      mimeType: "image/png",
                                    },
                                  ],
                                },
                              },
                            ],
                    },
                  ] as never,
                }
              : { prompt: "Complete original prompt" }),
            model: "gemma-4-31b",
            stream,
            maxTokens: 999,
            omitMaxTokens: true,
            ...(retire && !sdkMode
              ? {
                  prepareModelAttempt: async () => {
                    entered.resolve();
                    await release.promise;
                  },
                }
              : {}),
          });
          const parallelCall = parallel
            ? agent.useModel(ModelType.TEXT_SMALL, {
                prompt: "Complete original prompt",
                model: "gemma-4-31b",
                stream: false,
                maxTokens: 999,
                omitMaxTokens: true,
              })
            : undefined;
          if (retire) {
            await entered.promise;
            if (retire === "stop" || retire === "sdk-stop") stop.abort();
            else if (retire === "sdk-route") {
              const originalGet = agent.getSetting.bind(agent);
              vi.spyOn(agent, "getSetting").mockImplementation((key) =>
                key === "OPENAI_BASE_URL" ? "http://127.0.0.1:1/v1" : originalGet(key)
              );
            } else if (retire === "sdk-mutate")
              (sdkBarrier.captured as { prompt: string }).prompt = "Altered original input";
            else lease.close();
            release.resolve();
          }
          if (parallelCall) {
            const results = await Promise.allSettled([call, parallelCall]);
            expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1);
            expect(allowance.remainingMicroUsd).toBe(0);
          } else if (
            rejectsFirst ||
            unknownRoute ||
            (retire && retire !== "sdk-route") ||
            messageMode === "media"
          )
            await expect(call).rejects.toThrow();
          else {
            const result = await call;
            const textStream =
              typeof result === "object" && result !== null
                ? (result as { textStream?: AsyncIterable<unknown> }).textStream
                : undefined;
            if (textStream) {
              for await (const _chunk of textStream) {
              }
            }
          }
          if (unknownRoute || (retire && retire !== "sdk-route") || messageMode === "media") {
            expect(wireBodies).toHaveLength(0);
            return;
          }
          expect(wireBodies).toHaveLength(1);
          expect(JSON.stringify(wireBodies[0])).toContain("Complete original prompt");
          expect(wireBodies[0].max_tokens ?? wireBodies[0].max_completion_tokens).toBe(17);
          if (messageMode === "tools") {
            expect(JSON.stringify(wireBodies[0])).toContain("fixture-tool");
            expect(JSON.stringify(wireBodies[0])).toContain("ready");
          }
          await expect(
            agent.useModel(ModelType.TEXT_SMALL, {
              prompt: "second model stage",
              model: "gemma-4-31b",
              stream: false,
            })
          ).rejects.toMatchObject({
            code:
              retire === "sdk-route"
                ? "MODEL_ATTEMPT_POLICY_ROUTE"
                : "MODEL_ATTEMPT_POLICY_EXHAUSTED",
          });
          expect(wireBodies).toHaveLength(1);
        }
      );
    } finally {
      lease.close();
      allowance.close();
      await agent.stop();
    }
  }
  it("caps omitMaxTokens and refuses another physical call, preserving complete input", async () => {
    await bounded();
  });
  it("caps actual streaming output and shares the exhausted allowance", async () => {
    await bounded({ stream: true });
  });
  it("charges a failed physical attempt and refuses the actual provider retry", async () => {
    forceUnavailable = true;
    await bounded({ rejectsFirst: true });
  });
  it("keeps complete text tool calls and JSON results on the bounded wire", async () => {
    await bounded({ messageMode: "tools" });
  });
  it("refuses media-bearing tool results before actual HTTP dispatch", async () => {
    await bounded({ messageMode: "media" });
  });
  it("refuses an unknown tariff route before actual HTTP dispatch", async () => {
    await bounded({ unknownRoute: true });
  });
  it("atomically debits the last monetary reservation across real parallel HTTP attempts", async () => {
    await bounded({ parallel: true });
  });
  it.each(["sdk-stop", "sdk-return", "sdk-mutate", "sdk-route"])(
    "rechecks the physical wire after asynchronous SDK preparation: %s",
    async (retire) => {
      await bounded({ retire });
    }
  );
  it.each(["stop", "return"])(
    "blocks late physical dispatch after %s during model preparation",
    async (retire) => {
      await bounded({ retire });
    }
  );
});

it("retains the same unrefunded trial after an actual in-flight HTTP turn is interrupted", async () => {
  const agent = createSQLiteTestRuntime({
    character: {
      name: "Interrupted trial",
      bio: "test",
      settings: { OPENAI_BASE_URL: baseUrl, OPENAI_API_KEY: "fixture-only" },
    },
    logLevel: "fatal",
  });
  agent.registerModel(ModelType.TEXT_SMALL, handleTextSmall, "openai", 100);
  const sessionStop = new AbortController(),
    firstTurn = new AbortController(),
    arrived = Promise.withResolvers<void>();
  heldResponse = () => arrived.resolve();
  const allowance = createModelAttemptAllowance({
    signal: sessionStop.signal,
    budgetMicroUsd: 1000000,
    maxAttempts: 2,
    maxOutputTokens: 17,
    expiresAt: Date.now() + 60000,
    tariffs: [
      {
        provider: "openai-compatible",
        model: "gemma-4-31b",
        route: baseUrl,
        inputNanoUsdPerToken: 100,
        outputNanoUsdPerToken: 100,
        inputTokenUpperBound: 262144,
      },
    ],
  });
  const first = allowance.openTurn("interrupted", firstTurn.signal);
  try {
    const call = runWithStreamingContext(
      {
        messageId: "interrupted",
        modelAttemptTurnId: "interrupted",
        modelAttemptLease: first,
        abortSignal: firstTurn.signal,
      },
      () =>
        agent.useModel(ModelType.TEXT_SMALL, {
          prompt: "First complete turn",
          model: "gemma-4-31b",
          maxTokens: 17,
          stream: false,
        })
    );
    await arrived.promise;
    expect(wireBodies).toHaveLength(1);
    const afterFirstReservation = allowance.remainingMicroUsd;
    firstTurn.abort();
    await expect(call).rejects.toThrow();
    expect(sessionStop.signal.aborted).toBe(false);
    expect(allowance.remainingMicroUsd).toBe(afterFirstReservation);
    const next = allowance.openTurn("next-turn", new AbortController().signal);
    try {
      const result = await runWithStreamingContext(
        {
          messageId: "next-turn",
          modelAttemptTurnId: "next-turn",
          modelAttemptLease: next,
        },
        () =>
          agent.useModel(ModelType.TEXT_SMALL, {
            prompt: "Second complete turn",
            model: "gemma-4-31b",
            maxTokens: 17,
            stream: false,
          })
      );
      expect(result).toBe("served by fallback");
      expect(wireBodies).toHaveLength(2);
      expect(allowance.remainingMicroUsd).toBe(afterFirstReservation - 26217);
    } finally {
      next.close();
    }
    sessionStop.abort();
    expect(() => allowance.openTurn("after-stop", new AbortController().signal)).toThrow("ended");
  } finally {
    firstTurn.abort();
    sessionStop.abort();
    first.close();
    allowance.close();
    await agent.stop();
  }
});

describe("fallback model while the primary is rate limited", () => {
  it("serves the next requests with OPENAI_FALLBACK_MODEL after the primary's 429", async () => {
    const agent = runtime({ OPENAI_FALLBACK_MODEL: "gemma-4-31b" });
    await expect(
      handleTextSmall(agent, {
        prompt: "first",
        model: "qwen-3.8-27b",
        stream: false,
      })
    ).rejects.toMatchObject({ statusCode: 429 });
    expect(requestedModels).toEqual(["qwen-3.8-27b"]);

    const second = await handleTextSmall(agent, {
      prompt: "second",
      model: "qwen-3.8-27b",
      stream: false,
    });
    expect(second).toBe("served by fallback");
    const third = await handleTextSmall(agent, {
      prompt: "third",
      model: "qwen-3.8-27b",
      stream: false,
    });
    expect(third).toBe("served by fallback");
    expect(requestedModels).toEqual(["qwen-3.8-27b", "gemma-4-31b", "gemma-4-31b"]);
  });

  it("keeps the hold error when no fallback is configured", async () => {
    const agent = runtime();
    await expect(
      handleTextSmall(agent, {
        prompt: "first",
        model: "qwen-3.8-27b",
        stream: false,
      })
    ).rejects.toMatchObject({ statusCode: 429 });
    await expect(
      handleTextSmall(agent, {
        prompt: "second",
        model: "qwen-3.8-27b",
        stream: false,
      })
    ).rejects.toMatchObject({ name: "ProviderRateLimitCooldownError" });
    expect(requestedModels).toEqual(["qwen-3.8-27b"]);
  });
});

describe("selectRequestModelName", () => {
  const cooling = (...models: string[]) =>
    new Map(models.map((model) => [model, Date.now() + 60_000] as const));

  it("uses the primary unless it is cooling down and a distinct fallback is free", () => {
    expect(__INTERNAL_selectRequestModelName(new Map(), "qwen", "gemma")).toBe("qwen");
    expect(__INTERNAL_selectRequestModelName(cooling("qwen"), "qwen", "gemma")).toBe("gemma");
    expect(__INTERNAL_selectRequestModelName(cooling("qwen", "gemma"), "qwen", "gemma")).toBe(
      "qwen"
    );
    expect(__INTERNAL_selectRequestModelName(cooling("qwen"), "qwen", undefined)).toBe("qwen");
  });

  it("ignores an unset or identical fallback setting", () => {
    expect(__INTERNAL_resolveFallbackModelName(runtime(), "qwen")).toBeUndefined();
    expect(
      __INTERNAL_resolveFallbackModelName(runtime({ OPENAI_FALLBACK_MODEL: " qwen " }), "qwen")
    ).toBeUndefined();
    expect(
      __INTERNAL_resolveFallbackModelName(runtime({ CEREBRAS_FALLBACK_MODEL: "gemma" }), "qwen")
    ).toBe("gemma");
  });
});

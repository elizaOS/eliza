/**
 * Exercises the real OpenAI client and AI SDK retry transport with deterministic
 * fetch responses. Concurrent trajectory/timing scopes prove HTTP attribution;
 * secret-bearing fixtures prove diagnostics do not consume or expose payloads.
 * No provider, credentials, settings files, or external network are accessed.
 */
import {
  type IAgentRuntime,
  InferenceTurnTimer,
  logger,
  redactWithSecrets,
  runWithInferenceTiming,
  runWithTrajectoryContext,
} from "@elizaos/core";
import { generateText } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleResponseHandler } from "../models/text";
import { createOpenAIClient } from "../providers/openai";
import { getBaseURL, getEmbeddingBaseURL, getImageDescriptionBaseURL } from "../utils/config";

const transport = vi.hoisted(() => ({
  fetch: undefined as
    | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
    | undefined,
}));
vi.mock("@ai-sdk/openai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ai-sdk/openai")>();
  return {
    ...actual,
    createOpenAI: (options: Parameters<typeof actual.createOpenAI>[0]) => {
      // Capture the actual transport seam, but always construct the real SDK client.
      transport.fetch = options?.fetch;
      return actual.createOpenAI(options);
    },
  };
});

const PRIVATE_PROMPT = "private-request-body-fixture";
const PRIVATE_KEY = "private-provider-key-fixture";
const PRIVATE_HEADER = "private-header-secret-fixture";

function runtime(): IAgentRuntime {
  const settings: Record<string, string> = {
    OPENAI_API_KEY: PRIVATE_KEY,
    OPENAI_BASE_URL: "https://fixture.invalid/v1?private-query-fixture=secret",
    ELIZA_PROVIDER: "openai",
  };
  return {
    character: { name: "Fixture", system: "Fixture system" },
    emitEvent: vi.fn(),
    getService: vi.fn(() => null),
    getServicesByType: vi.fn(() => []),
    getSetting: (key: string) => settings[key] ?? "",
    redactSecrets: (text: string) =>
      redactWithSecrets(text, { secrets: { fixture: PRIVATE_HEADER, apiKey: PRIVATE_KEY } }),
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
}

function completion(model: string, headers: HeadersInit = {}): Response {
  return new Response(
    JSON.stringify({
      id: `completion-${model}`,
      object: "chat.completion",
      created: 0,
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Exact answer." },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }),
    { headers: { "content-type": "application/json", ...headers } }
  );
}

function diagnostics() {
  const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
  const httpCalls = () =>
    [...debug.mock.calls, ...warn.mock.calls].filter((call) =>
      call.some((value) => typeof value === "string" && value.startsWith("[OpenAI] HTTP"))
    );
  return {
    records: () =>
      httpCalls()
        .map((call) => call[0])
        .filter(
          (value): value is Record<string, unknown> =>
            typeof value === "object" && value !== null && "attemptId" in value
        ),
    serialized: () => JSON.stringify([...debug.mock.calls, ...warn.mock.calls]),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("HTTP attempt observability", () => {
  it.each([
    { structured: false, failure: "none" },
    { structured: true, failure: "none" },
    { structured: false, failure: "timer" },
    { structured: false, failure: "reporter" },
  ])(
    "records SDK and adapter point events without changing real SDK chunks (structured=$structured, diagnostic=$failure)",
    async ({ structured, failure }) => {
      vi.stubEnv("ELIZA_PLANNER_FULL_ACTION_SURFACE", "0");
      const logs = diagnostics();
      let now = 1000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const timer = new InferenceTurnTimer({ turnId: "stream-observer", label: "fixture" });
      const fixture = runtime();
      if (failure !== "none") {
        const record = timer.recordSpan.bind(timer);
        vi.spyOn(timer, "recordSpan").mockImplementation((name, duration, meta) => {
          if (name.startsWith("openai.stream.")) throw new Error(PRIVATE_PROMPT);
          record(name, duration, meta);
        });
        if (failure === "reporter")
          vi.mocked(fixture.reportError).mockImplementation(() => {
            throw new Error(PRIVATE_KEY);
          });
      }
      let releaseTail!: () => void;
      const tail = new Promise<void>((resolve) => {
        releaseTail = resolve;
      });
      let firstDelivered!: () => void;
      const delivered = new Promise<void>((resolve) => {
        firstDelivered = resolve;
      });
      const first = structured ? '{"replyText":"hel' : "hel";
      const second = structured ? 'lo"}' : "lo";
      const encoder = new TextEncoder();
      const frame = (delta: object, finish_reason: string | null = null) =>
        encoder.encode(
          `data: ${JSON.stringify({
            id: "fixture-stream",
            object: "chat.completion.chunk",
            created: 0,
            model: "fixture",
            choices: [{ index: 0, delta, finish_reason }],
          })}\n\n`
        );
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              new ReadableStream({
                async start(controller) {
                  now = 1100;
                  controller.enqueue(
                    frame(
                      structured
                        ? {
                            tool_calls: [
                              {
                                index: 0,
                                id: "call-fixture",
                                type: "function",
                                function: { name: "HANDLE_RESPONSE", arguments: first },
                              },
                            ],
                          }
                        : { content: first }
                    )
                  );
                  await tail;
                  now = 1400;
                  controller.enqueue(
                    frame(
                      structured
                        ? { tool_calls: [{ index: 0, function: { arguments: second } }] }
                        : { content: second }
                    )
                  );
                  controller.enqueue(frame({}, structured ? "tool_calls" : "stop"));
                  controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                  controller.close();
                },
              }),
              { headers: { "content-type": "text/event-stream" } }
            )
        )
      );
      const callbackChunks: string[] = [];
      const consumed = runWithTrajectoryContext({ purpose: PRIVATE_PROMPT }, () =>
        runWithInferenceTiming(timer, async () => {
          const result = await handleResponseHandler(fixture, {
            model: "fixture",
            prompt: PRIVATE_PROMPT,
            stream: true,
            ...(structured
              ? {
                  streamStructured: true,
                  tools: [
                    {
                      name: "HANDLE_RESPONSE",
                      description: "Fixture",
                      parameters: {
                        type: "object",
                        properties: { replyText: { type: "string" } },
                        required: ["replyText"],
                      },
                    },
                  ],
                  toolChoice: "required" as const,
                }
              : {}),
            onStreamChunk: (chunk: string) => {
              callbackChunks.push(chunk);
              firstDelivered();
            },
          });
          if (typeof result === "string" || !result.textStream) throw new Error("Expected stream");
          let text = "";
          for await (const chunk of result.textStream) text += chunk;
          return text;
        })
      );
      await delivered;
      const beforeTail = timer
        .summary()
        .spans.filter((span) => span.name.startsWith("openai.stream."));
      releaseTail();
      expect(await consumed).toBe(first + second);
      expect(callbackChunks).toEqual([first, second]);
      if (failure !== "none") {
        expect(beforeTail).toEqual([]);
        expect(fixture.reportError).toHaveBeenCalled();
        expect(JSON.stringify(vi.mocked(fixture.reportError).mock.calls)).not.toContain(
          PRIVATE_PROMPT
        );
        expect(logs.serialized()).not.toContain(PRIVATE_KEY);
        return;
      }
      expect(beforeTail.map((span) => span.name)).toEqual([
        "openai.stream.mode",
        "openai.stream.first-provider-event",
        "openai.stream.first-sdk-delta",
        "openai.stream.first-adapter-delivery",
      ]);
      expect(beforeTail.every((span) => span.durationMs === 0)).toBe(true);
      expect(beforeTail.slice(1).map((span) => span.startMs)).toEqual([100, 100, 100]);
      expect(new Set(beforeTail.map((span) => span.meta?.streamCallId)).size).toBe(1);
      expect(beforeTail[0]?.meta).toMatchObject({
        mode: structured ? "live-structured" : "live-text",
        modelType: "RESPONSE_HANDLER",
        purpose: "other",
        streamAttempt: 1,
      });
      expect(
        timer.summary().spans.filter((span) => span.name.startsWith("openai.stream."))
      ).toHaveLength(4);
      const timing = JSON.stringify(beforeTail);
      for (const secret of [PRIVATE_PROMPT, PRIVATE_KEY, first, second])
        expect(timing).not.toContain(secret);
      expect(logs.serialized()).not.toContain(PRIVATE_KEY);
    }
  );

  it("distinguishes a provider's non-text frame from its first text and keeps only valid numeric timings", async () => {
    const logs = diagnostics();
    vi.stubEnv("ELIZA_PLANNER_FULL_ACTION_SURFACE", "0");
    const timer = new InferenceTurnTimer({ turnId: "provider-frame", label: "fixture" });
    let releaseText!: () => void;
    const textReady = new Promise<void>((resolve) => {
      releaseText = resolve;
    });
    const encoder = new TextEncoder();
    const frame = (delta: object, time_info?: object) =>
      encoder.encode(
        `data: ${JSON.stringify({
          id: "provider-frame-fixture",
          object: "chat.completion.chunk",
          created: 0,
          model: "fixture",
          choices: [{ index: 0, delta, finish_reason: time_info ? "stop" : null }],
          ...(time_info ? { time_info } : {}),
        })}\n\n`
      );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              async start(controller) {
                controller.enqueue(frame({ role: "assistant" }));
                await textReady;
                controller.enqueue(frame({ content: "Complete reply." }));
                controller.enqueue(
                  frame(
                    {},
                    {
                      queue_time: PRIVATE_KEY,
                      prompt_time: -1,
                      completion_time: null,
                      total_time: 1e308,
                    }
                  )
                );
                controller.enqueue(
                  frame(
                    {},
                    {
                      queue_time: 0.2,
                      prompt_time: 0.05,
                      completion_time: 0.01,
                      total_time: 0.26,
                      private: PRIVATE_PROMPT,
                      created: PRIVATE_HEADER,
                    }
                  )
                );
                // Repeated provider metadata must not grow diagnostic state or replace
                // the first complete timing report with untrusted values.
                controller.enqueue(frame({}, { queue_time: PRIVATE_KEY, total_time: -1 }));
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
              },
            }),
            { headers: { "content-type": "text/event-stream" } }
          )
      )
    );
    const chunks: string[] = [];
    const consumed = runWithInferenceTiming(timer, async () => {
      const result = await handleResponseHandler(runtime(), {
        model: "fixture",
        prompt: PRIVATE_PROMPT,
        stream: true,
        onStreamChunk: (chunk) => {
          chunks.push(chunk);
        },
      });
      if (typeof result === "string" || !result.textStream) throw new Error("Expected stream");
      let text = "";
      for await (const chunk of result.textStream) text += chunk;
      return text;
    });
    try {
      await vi.waitFor(() =>
        expect(
          timer.summary().spans.some((span) => span.name === "openai.stream.first-provider-event")
        ).toBe(true)
      );
      expect(chunks).toEqual([]);
      expect(
        timer.summary().spans.some((span) => span.name === "openai.stream.first-sdk-delta")
      ).toBe(false);
    } finally {
      releaseText();
    }
    expect(await consumed).toBe("Complete reply.");
    expect(chunks).toEqual(["Complete reply."]);
    const spans = timer.summary().spans;
    expect(spans.filter((span) => span.name === "openai.stream.first-provider-event")).toHaveLength(
      1
    );
    const reports = spans.filter((span) => span.name === "openai.stream.provider-timing");
    expect(reports).toHaveLength(1);
    expect(reports[0]?.meta).toMatchObject({
      queueMs: 200,
      promptMs: 50,
      completionMs: 10,
      totalMs: 260,
    });
    for (const privateText of [PRIVATE_KEY, PRIVATE_HEADER, PRIVATE_PROMPT, "Complete reply."])
      expect(JSON.stringify(spans)).not.toContain(privateText);
    expect(logs.serialized()).not.toContain(PRIVATE_KEY);
  });

  it("resolves all endpoint variants without logging endpoint values", () => {
    const logs = diagnostics();
    const endpoints: Record<string, string> = {
      OPENAI_BASE_URL: `https://user:private-url-password@fixture.invalid/v1?token=${PRIVATE_KEY}`,
      OPENAI_EMBEDDING_URL: `https://fixture.invalid/embedding?secret=${PRIVATE_HEADER}`,
      OPENAI_IMAGE_DESCRIPTION_BASE_URL: `https://fixture.invalid/image?prompt=${PRIVATE_PROMPT}`,
    };
    const fixture = { ...runtime(), getSetting: (key: string) => endpoints[key] ?? "" };
    expect(getBaseURL(fixture)).toBe(endpoints.OPENAI_BASE_URL);
    expect(getEmbeddingBaseURL(fixture)).toBe(endpoints.OPENAI_EMBEDDING_URL);
    expect(getImageDescriptionBaseURL(fixture)).toBe(endpoints.OPENAI_IMAGE_DESCRIPTION_BASE_URL);
    expect(logs.serialized()).not.toContain("private-url-password");
    for (const value of [PRIVATE_KEY, PRIVATE_HEADER, PRIVATE_PROMPT]) {
      expect(logs.serialized()).not.toContain(value);
    }
  });

  it("correlates concurrent SDK retries with their original call, purpose, and timer", async () => {
    const logs = diagnostics();
    const attempts = new Map<string, number>();
    let releaseFirstAttempts!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      releaseFirstAttempts = resolve;
    });
    const fetch = vi.fn(
      async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        // The fixture, not production diagnostics, parses the SDK wire to choose its response.
        const model = (JSON.parse(String(init?.body)) as { model: string }).model;
        const attempt = (attempts.get(model) ?? 0) + 1;
        attempts.set(model, attempt);
        if (attempt === 1) {
          if (attempts.size === 2) releaseFirstAttempts();
          await bothStarted;
          return new Response(JSON.stringify({ error: { message: "fixture TPM limit" } }), {
            status: 429,
            headers: {
              "content-type": "application/json",
              "retry-after-ms": "1",
              "x-request-id": `upstream-${model}-${attempt}`,
              "x-ratelimit-remaining-tokens": "0",
            },
          });
        }
        return completion(model, { "x-request-id": `upstream-${model}-${attempt}` });
      }
    );
    vi.stubGlobal("fetch", fetch);
    const timers = ["planner", "evaluation"].map(
      (purpose) => new InferenceTurnTimer({ turnId: `turn-${purpose}`, label: "fixture" })
    );
    const startedAt = Date.now();
    await Promise.all(
      timers.map((timer, index) => {
        const purpose = index === 0 ? "planner" : "evaluation";
        return runWithTrajectoryContext(
          {
            trajectoryStepId: `step-${purpose}`,
            traceId: `trajectory-trace-${purpose}`,
            runId: `run-${purpose}`,
            purpose,
          },
          () =>
            runWithInferenceTiming(timer, async () => {
              const client = createOpenAIClient(runtime());
              const result = await generateText({
                model: client.chat(purpose),
                prompt: PRIVATE_PROMPT,
                maxRetries: 1,
              });
              expect(result.text).toBe("Exact answer.");
            })
        );
      })
    );
    const endedAt = Date.now();
    expect(fetch).toHaveBeenCalledTimes(4);
    const responses = logs.records().filter((row) => row.phase === "response");
    expect(responses).toHaveLength(4);
    expect(new Set(responses.map((row) => row.callId)).size).toBe(2);
    expect(new Set(responses.map((row) => row.attemptId)).size).toBe(4);
    for (const [index, purpose] of ["planner", "evaluation"].entries()) {
      const rows = responses
        .filter((row) => row.purpose === purpose)
        .sort((a, b) => Number(a.attempt) - Number(b.attempt));
      expect(rows.map((row) => row.attempt)).toEqual([1, 2]);
      expect(rows[0]?.callId).toBe(rows[1]?.callId);
      for (const row of rows) {
        expect(row).toMatchObject({
          trajectoryStepId: `step-${purpose}`,
          traceId: `trajectory-trace-${purpose}`,
          runId: `run-${purpose}`,
          turnId: `turn-${purpose}`,
          host: "fixture.invalid",
        });
        expect(row.startedAt).toBeGreaterThanOrEqual(startedAt);
        expect(row.endedAt).toBeGreaterThanOrEqual(Number(row.startedAt));
        expect(row.endedAt).toBeLessThanOrEqual(endedAt);
        expect(row.responseHeaders).toMatchObject({
          "x-request-id": `upstream-${purpose}-${row.attempt}`,
        });
      }
      const spans = timers[index]?.summary().spans.filter((span) => span.name === "openai.http");
      expect(spans).toHaveLength(2);
      expect(spans?.map((span) => span.meta?.attemptId).sort()).toEqual(
        rows.map((row) => row.attemptId).sort()
      );
      expect(spans?.every((span) => span.meta?.purpose === purpose && span.durationMs >= 0)).toBe(
        true
      );
    }
    expect(logs.serialized()).not.toContain(PRIVATE_PROMPT);
    expect(logs.serialized()).not.toContain(PRIVATE_KEY);
    expect(logs.serialized()).not.toContain("private-query-fixture");
  });

  it("redacts the fixed header projection without consuming the response or changing the request", async () => {
    const logs = diagnostics();
    const response = completion("fixture", {
      "x-request-id": `request-${PRIVATE_HEADER}`,
      "x-ratelimit-limit-tokens": "100000",
      "x-ratelimit-remaining-tokens": PRIVATE_HEADER,
      "x-ratelimit-reset-tokens": "1m",
      "retry-after": "60",
      "set-cookie": `session=${PRIVATE_HEADER}`,
      authorization: `Bearer ${PRIVATE_KEY}`,
      "x-private-debug": PRIVATE_PROMPT,
      "request-id": `${PRIVATE_HEADER}${"x".repeat(300)}`,
      "x-ratelimit-reset-requests": "unsafe\tvalue",
    });
    const readText = vi.spyOn(response, "text");
    const clone = vi.spyOn(response, "clone");
    const controller = new AbortController();
    const fetch = vi.fn(
      async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        expect(init?.signal).toBe(controller.signal);
        expect(String(init?.body)).toContain(PRIVATE_PROMPT);
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${PRIVATE_KEY}`);
        expect(response.bodyUsed).toBe(false);
        return response;
      }
    );
    vi.stubGlobal("fetch", fetch);
    const result = await generateText({
      model: createOpenAIClient(runtime()).chat("fixture"),
      prompt: PRIVATE_PROMPT,
      abortSignal: controller.signal,
      maxRetries: 0,
    });
    expect(result.text).toBe("Exact answer.");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(readText).toHaveBeenCalledTimes(1);
    expect(clone).not.toHaveBeenCalled();
    const row = logs.records().find((entry) => entry.phase === "response");
    expect(row?.responseHeaders).toMatchObject({
      "x-ratelimit-limit-tokens": "100000",
      "x-ratelimit-reset-tokens": "1m",
      "retry-after": "60",
    });
    expect(row?.responseHeaders).toHaveProperty("x-request-id");
    expect(row?.responseHeaders).toMatchObject({
      "request-id": "[OMITTED]",
      "x-ratelimit-reset-requests": "[OMITTED]",
    });
    const serialized = logs.serialized();
    for (const privateText of [
      PRIVATE_KEY,
      PRIVATE_HEADER,
      PRIVATE_PROMPT,
      "private-query-fixture",
      "set-cookie",
      "authorization",
      "x-private-debug",
    ]) {
      expect(serialized).not.toContain(privateText);
    }
    expect(serialized).toContain("REDACTED");
    expect(row).not.toHaveProperty("trajectoryStepId");
    expect(row).not.toHaveProperty("model");
  });

  it("times a rejected fetch and preserves its exact error without logging its message", async () => {
    const logs = diagnostics();
    const error = new Error(`network failure ${PRIVATE_KEY} ${PRIVATE_PROMPT}`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw error;
      })
    );
    const timer = new InferenceTurnTimer({ turnId: "failed-turn", label: "fixture" });
    await expect(
      runWithInferenceTiming(timer, () =>
        generateText({
          model: createOpenAIClient(runtime()).chat("fixture"),
          prompt: PRIVATE_PROMPT,
          maxRetries: 0,
        })
      )
    ).rejects.toBe(error);
    const row = logs.records().find((entry) => entry.phase === "error");
    expect(row).toMatchObject({ attempt: 1, turnId: "failed-turn" });
    expect(row?.endedAt).toBeGreaterThanOrEqual(Number(row?.startedAt));
    expect(row).not.toHaveProperty("status");
    expect(timer.summary().spans).toEqual([
      expect.objectContaining({
        name: "openai.http",
        meta: expect.objectContaining({ attemptId: row?.attemptId, phase: "error" }),
      }),
    ]);
    expect(logs.serialized()).not.toContain(PRIVATE_KEY);
    expect(logs.serialized()).not.toContain(PRIVATE_PROMPT);
  });

  it.each([
    "logger",
    "redactor",
    "redactor-response",
    "timer-open",
    "timer-close",
    "timer-metadata",
    "call-id",
  ])(
    "%s diagnostic failure cannot change Response, fetch Error, or input identity",
    async (failure) => {
      diagnostics();
      const diagnosticError = new Error(`diagnostic ${PRIVATE_HEADER}`);
      const throwDiagnosticError = () => {
        throw diagnosticError;
      };
      const fixture = runtime();
      const timer = new InferenceTurnTimer({ turnId: "diagnostic-failure", label: "fixture" });
      if (failure === "logger") {
        vi.spyOn(logger, "debug").mockImplementation(throwDiagnosticError);
        vi.spyOn(logger, "warn").mockImplementation(throwDiagnosticError);
      } else if (failure === "redactor") {
        fixture.redactSecrets = throwDiagnosticError;
      } else if (failure === "redactor-response") {
        fixture.redactSecrets = (text) => (text === PRIVATE_HEADER ? throwDiagnosticError() : text);
      } else if (failure === "timer-open") {
        vi.spyOn(timer, "openSpan").mockImplementation(throwDiagnosticError);
      } else if (failure === "timer-close") {
        vi.spyOn(timer, "openSpan").mockReturnValue(throwDiagnosticError);
      } else if (failure === "timer-metadata") {
        Object.defineProperty(timer, "turnId", { get: throwDiagnosticError });
      } else {
        vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(throwDiagnosticError);
      }
      const response = new Response(PRIVATE_PROMPT, {
        headers: { "x-request-id": PRIVATE_HEADER },
      });
      const originalError = new Error(`fetch ${PRIVATE_KEY}`);
      let rejectFetch = false;
      const underlyingFetch = Object.assign(
        vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
          if (rejectFetch) throw originalError;
          return response;
        }),
        { preconnect: vi.fn() }
      );
      vi.stubGlobal("fetch", underlyingFetch);
      await runWithInferenceTiming(timer, async () => {
        createOpenAIClient(fixture);
        const fetch = transport.fetch;
        expect(fetch).toBeDefined();
        if (!fetch) throw new Error("SDK factory did not receive transport");
        expect((fetch as unknown as { preconnect: unknown }).preconnect).toBe(
          underlyingFetch.preconnect
        );
        const request = new Request("https://fixture.invalid/path?private=query");
        const init = { method: "POST", body: PRIVATE_PROMPT, signal: new AbortController().signal };
        await expect(fetch(request, init)).resolves.toBe(response);
        expect(response.bodyUsed).toBe(false);
        rejectFetch = true;
        await expect(fetch(request, init)).rejects.toBe(originalError);
        expect(underlyingFetch).toHaveBeenCalledTimes(2);
        for (const call of underlyingFetch.mock.calls) {
          expect(call[0]).toBe(request);
          expect(call[1]).toBe(init);
        }
      });
    }
  );
});

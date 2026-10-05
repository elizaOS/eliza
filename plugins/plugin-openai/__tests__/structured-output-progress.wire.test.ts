/** Real loopback SSE verifies structured non-progress aborts without retry or invented usage. */
import { createServer, type Server } from "node:http";
import { type IAgentRuntime, runWithTrajectoryContext, type TextStreamResult } from "@elizaos/core";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { handleResponseHandler } from "../models/text";

let server: Server;
let origin: string;
let requests = 0;
let stringWhitespace = false;
let closedEarly = false;
let requestClosed: Promise<void>;
let resolveClosed: () => void;
const records: Record<string, unknown>[] = [];
beforeAll(async () => {
  server = createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* consume exact local request */
    }
    requests++;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (delta: unknown, finish: unknown = null, usage?: unknown) =>
      res.write(
        `data: ${JSON.stringify({ id: "local-stream", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`
      );
    send({
      role: "assistant",
      content: stringWhitespace ? '{"messageToUser":"x' : '{"messageToUser":"Saved."',
    });
    let sent = 0;
    const timer = setInterval(() => {
      if (sent++ < 64) send({ content: " ".repeat(256) });
      else {
        clearInterval(timer);
        if (stringWhitespace) send({ content: 'y"}' });
        send({}, stringWhitespace ? "stop" : "length", {
          prompt_tokens: 17,
          completion_tokens: 40960,
          total_tokens: 40977,
        });
        res.end("data: [DONE]\n\n");
      }
    }, 2);
    res.on("close", () => {
      closedEarly ||= sent < 64;
      resolveClosed();
      clearInterval(timer);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  requests = 0;
  stringWhitespace = false;
  closedEarly = false;
  records.length = 0;
  requestClosed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  vi.stubEnv("ELIZA_PROVIDER", "cerebras");
  vi.stubEnv("OPENAI_BASE_URL", origin);
  vi.stubEnv("OPENAI_API_KEY", "loopback-only");
  vi.stubEnv("CEREBRAS_API_KEY", undefined);
  vi.stubEnv("ELIZA_MOCK_OPENAI_BASE", undefined);
  vi.stubEnv("ELIZA_TRAJECTORY_STRICT", undefined);
  vi.stubEnv("ELIZA_PLANNER_FULL_ACTION_SURFACE", undefined);
});
afterEach(() => vi.unstubAllEnvs());
it.each([false, true])(
  "aborts stalled JSON and records a partial failure without retry (buffered=%s)",
  async (buffered) => {
    if (buffered) vi.stubEnv("ELIZA_PLANNER_FULL_ACTION_SURFACE", "1");
    const runtime = createRuntime();
    await expect(
      runWithTrajectoryContext(
        { trajectoryId: "offline", trajectoryStepId: "offline-step" },
        async () => {
          const result = await handleResponseHandler(runtime, {
            prompt: "Return the result as JSON.",
            responseSchema: {
              type: "object",
              additionalProperties: false,
              properties: { messageToUser: { type: "string" } },
              required: ["messageToUser"],
            },
            stream: true,
          });
          for await (const _chunk of (result as TextStreamResult).textStream) {
            /* no delivery */
          }
        }
      )
    ).rejects.toMatchObject({ code: "STRUCTURED_OUTPUT_STALLED" });
    await requestClosed;
    expect(requests).toBe(1);
    expect(closedEarly).toBe(true);
    expect(records).toHaveLength(1);
    expect(records[0].finishReason).toBe("error");
    expect(String(records[0].response)).toContain('{"messageToUser":"Saved."');
    expect(String(records[0].response).length).toBeGreaterThan(4096);
    expect(records[0].completionTokens).toBeUndefined();
  }
);

function createRuntime(): IAgentRuntime {
  const logger = {
    isEnabled: () => true,
    logLlmCall: (record: Record<string, unknown>) => records.push(record),
  };
  return {
    character: { name: "Fixture", system: "Return JSON." },
    getSetting: () => undefined,
    emitEvent: async () => {},
    getService: () => logger,
    getServicesByType: () => [logger],
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
}

it("preserves long whitespace inside a JSON string and provider-reported usage", async () => {
  stringWhitespace = true;
  await runWithTrajectoryContext(
    { trajectoryId: "offline-string", trajectoryStepId: "offline-string-step" },
    async () => {
      const result = await handleResponseHandler(createRuntime(), {
        prompt: "Return JSON",
        responseSchema: {
          type: "object",
          properties: { messageToUser: { type: "string" } },
          required: ["messageToUser"],
        },
        stream: true,
      });
      let text = "";
      for await (const chunk of (result as TextStreamResult).textStream) text += chunk;
      expect(JSON.parse(text).messageToUser).toBe(`x${" ".repeat(64 * 256)}y`);
    }
  );
  await requestClosed;
  expect(closedEarly).toBe(false);
  expect(requests).toBe(1);
  expect(records[0]).toMatchObject({
    finishReason: "stop",
    promptTokens: 17,
    completionTokens: 40960,
  });
});
it("leaves unstructured text alone and preserves terminal length usage", async () => {
  await expect(
    runWithTrajectoryContext(
      { trajectoryId: "offline-plain", trajectoryStepId: "offline-plain-step" },
      async () => {
        const result = await handleResponseHandler(createRuntime(), {
          prompt: "Return text",
          stream: true,
        });
        for await (const _chunk of (result as TextStreamResult).textStream) {
        }
      }
    )
  ).rejects.toMatchObject({ code: "MODEL_OUTPUT_INCOMPLETE" });
  await requestClosed;
  expect(closedEarly).toBe(false);
  expect(requests).toBe(1);
  expect(records[0]).toMatchObject({
    finishReason: "error",
    promptTokens: 17,
    completionTokens: 40960,
  });
});

it("preserves caller cancellation before the non-progress budget", async () => {
  const controller = new AbortController();
  await expect(
    runWithTrajectoryContext(
      { trajectoryId: "offline-cancel", trajectoryStepId: "offline-cancel-step" },
      async () => {
        const result = await handleResponseHandler(createRuntime(), {
          prompt: "Return JSON",
          responseSchema: {
            type: "object",
            properties: { messageToUser: { type: "string" } },
            required: ["messageToUser"],
          },
          stream: true,
          signal: controller.signal,
          onStreamChunk: () => controller.abort(),
        });
        for await (const _chunk of (result as TextStreamResult).textStream) {
        }
      }
    )
  ).rejects.toMatchObject({ name: "AbortError" });
  await requestClosed;
  expect(closedEarly).toBe(true);
  expect(requests).toBe(1);
  expect(records[0].finishReason).toBe("error");
});

it("keeps the safeguard scoped to Cerebras-compatible requests", async () => {
  vi.stubEnv("ELIZA_PROVIDER", "openai");
  await expect(
    runWithTrajectoryContext(
      { trajectoryId: "offline-other", trajectoryStepId: "offline-other-step" },
      async () => {
        const result = await handleResponseHandler(createRuntime(), {
          prompt: "Return JSON",
          responseSchema: {
            type: "object",
            properties: { messageToUser: { type: "string" } },
            required: ["messageToUser"],
          },
          stream: true,
        });
        for await (const _chunk of (result as TextStreamResult).textStream) {
        }
      }
    )
  ).rejects.not.toMatchObject({ code: "STRUCTURED_OUTPUT_STALLED" });
  await requestClosed;
  expect(closedEarly).toBe(false);
  expect(requests).toBe(1);
});

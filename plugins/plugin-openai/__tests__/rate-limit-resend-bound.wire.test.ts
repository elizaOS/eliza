/**
 * Bounds the requests one model call sends a provider that keeps refusing with
 * 429. Real AgentRuntime tiers, real handlers and AI SDK, a loopback provider
 * with Cerebras's two refusals: queue overload with no wait hint, and the
 * token bucket with Retry-After 60. When the lane already re-sent the request,
 * the error runtime.useModel rethrows after tier failover says so, and the
 * turn's re-send rule adds none. Before this, the turn re-sent the whole call
 * with a fresh lane budget: 8 requests on the generate lane, 12 on the stream
 * lanes. So does a hold another call sets while the live stream lane waits to
 * re-send. A first-attempt refusal with a long wait keeps the turn's re-send.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { MODEL_PROVIDER_RESENDS, ModelType, turnRateLimitResendWaitMs } from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleResponseHandler,
  handleTextLarge,
  handleTextMedium,
  handleTextNano,
  handleTextSmall,
} from "../models/text";

const MODEL = "qwen-3.8-27b";
const QUEUE_REFUSAL = {
  message: "We're experiencing high traffic right now! Please try again soon.",
  type: "too_many_requests_error",
  param: "queue",
  code: "queue_exceeded",
};
const BUCKET_REFUSAL = {
  message: "Tokens per minute limit exceeded - too many tokens processed.",
  type: "too_many_tokens_error",
  param: "quota",
  code: "token_quota_exceeded",
};
/** Lanes and what one call may send on each: the first request and its re-sends. */
const LANES = [
  ["generate", 4],
  ["live stream", 6],
  ["buffered stream", 6],
] as const;
type Lane = (typeof LANES)[number][0];
type Refusal = "queue" | "bucket";

let server: Server | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server?.close((error) => (error ? reject(error) : resolve()))
    );
    server = undefined;
  }
});

/** Answers the nth request with refusals[n] (the last one repeats), or what refusals(body) returns. */
async function provider(lane: Lane, refusals: Refusal[] | ((body: string) => Refusal)) {
  let requests = 0;
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const bucket =
        (typeof refusals === "function"
          ? refusals(body)
          : refusals[Math.min(requests, refusals.length - 1)]) === "bucket";
      requests++;
      response.writeHead(429, {
        "content-type": "application/json",
        ...(bucket ? { "retry-after": "60" } : {}),
      });
      response.end(JSON.stringify(bucket ? BUCKET_REFUSAL : QUEUE_REFUSAL));
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  // The phone's direct route: every slot is the same Cerebras model, and the
  // host caps a provider hold at 4 s so the turn's re-send is not refused locally.
  for (const [key, value] of Object.entries({
    ELIZA_PROVIDER: "cerebras",
    OPENAI_API_KEY: "loopback-only-key",
    OPENAI_BASE_URL: baseURL,
    CEREBRAS_API_KEY: "",
    CEREBRAS_MODEL: MODEL,
    CEREBRAS_SMALL_MODEL: MODEL,
    CEREBRAS_LARGE_MODEL: MODEL,
    OPENAI_RATE_LIMIT_MAX_HOLD_SECONDS: "4",
    ELIZA_BRAIN_PROVIDER: "",
    OPENROUTER_API_KEY: "",
    ELIZA_TRAJECTORY_LOGGING: "0",
    ELIZA_TRAJECTORY_STRICT: "0",
    ELIZA_PLANNER_FULL_ACTION_SURFACE: lane === "buffered stream" ? "1" : "0",
  }))
    vi.stubEnv(key, value);
  const runtime = createSQLiteTestRuntime({
    character: {
      name: "ResendBoundFixture",
      settings: { OPENAI_API_KEY: "loopback-only-key", OPENAI_BASE_URL: baseURL },
    },
    logLevel: "fatal",
  });
  runtime.registerModel(ModelType.RESPONSE_HANDLER, handleResponseHandler, "openai", 100);
  runtime.registerModel(ModelType.TEXT_NANO, handleTextNano, "openai", 100);
  runtime.registerModel(ModelType.TEXT_SMALL, handleTextSmall, "openai", 100);
  runtime.registerModel(ModelType.TEXT_MEDIUM, handleTextMedium, "openai", 100);
  runtime.registerModel(ModelType.TEXT_LARGE, handleTextLarge, "openai", 100);

  /** One useModel call, streamed to a callback as a chat turn's are; returns its error. */
  const modelCall = async (prompt = "Original complete request"): Promise<unknown> => {
    try {
      await runtime.useModel(
        ModelType.RESPONSE_HANDLER,
        lane === "generate"
          ? { prompt, stream: false }
          : { prompt, stream: true, onStreamChunk: () => undefined }
      );
    } catch (error) {
      return error;
    }
    throw new Error("expected the provider to refuse the call");
  };
  /** The call plus the single re-send Stage 1, the planner, the evaluator and the extractor make. */
  const turn = async (prompt?: string) => {
    const error = await modelCall(prompt);
    const waitMs = turnRateLimitResendWaitMs(error);
    if (waitMs === undefined) return { error, waitMs };
    // A timer can fire a few ms before Date.now() reaches the hold's end; a
    // real re-send also spends the time to build its request first.
    await new Promise((resolve) => setTimeout(resolve, waitMs + 100));
    return { error, waitMs, resent: await modelCall(prompt) };
  };
  return { turn, modelCall, requests: () => requests };
}

const resends = (error: unknown) => (error as Record<symbol, unknown>)[MODEL_PROVIDER_RESENDS];

describe("requests per model call on a 429", () => {
  it.each(LANES)(
    "stop at the %s lane's budget when no refusal carries a wait",
    async (lane, budget) => {
      const { turn, requests } = await provider(lane, ["queue"]);
      const { error, waitMs } = await turn();
      expect(requests()).toBe(budget);
      expect(error).toMatchObject({ statusCode: 429 });
      expect(resends(error)).toBe(budget - 1);
      expect(waitMs).toBeUndefined();
    }
  );

  it.each(LANES)(
    "keep the stamp through tier failover when the %s lane's re-send meets a long wait",
    async (lane) => {
      const { turn, requests } = await provider(lane, ["queue", "bucket"]);
      const { error, waitMs } = await turn();
      expect(requests()).toBe(2);
      // The provider's own refusal, not a sibling tier's local cooldown refusal.
      expect(error).toMatchObject({ name: "AI_APICallError", statusCode: 429 });
      expect(resends(error)).toBe(1);
      expect(waitMs).toBeUndefined();
    }
  );

  it("keep the stamp when another call puts the model on hold while the live stream lane waits to re-send", async () => {
    // Every slot is the same model, so a second call's bucket refusal holds
    // the model for this one too. The live stream lane checks the hold before
    // each attempt; before, that refusal left the lane unstamped and the turn
    // re-sent the call with a fresh lane: 3 + 6 requests.
    let firstCallRequests = 0;
    const { turn, modelCall } = await provider("live stream", (body) => {
      if (body.includes("Second call")) return "bucket";
      firstCallRequests++;
      return "queue";
    });
    const firstTurn = turn("First call");
    // The lane's third backoff is 1.2-1.4 s, far longer than the second call's refusal.
    await vi.waitFor(() => expect(firstCallRequests).toBe(3), { timeout: 5_000, interval: 5 });
    expect(await modelCall("Second call")).toMatchObject({ statusCode: 429 });
    const { error, waitMs } = await firstTurn;
    expect(firstCallRequests).toBe(3);
    expect(error).toMatchObject({ name: "ProviderRateLimitCooldownError", statusCode: 429 });
    // Three waits; the hold refused the third re-send.
    expect(resends(error)).toBe(3);
    expect(waitMs).toBeUndefined();
  }, 30_000);

  it.each(LANES)(
    "keep the turn's one re-send after a first-attempt long wait on the %s lane",
    async (lane) => {
      const { turn, requests } = await provider(lane, ["bucket"]);
      const { error, waitMs, resent } = await turn();
      expect(error).toMatchObject({ name: "ProviderRateLimitCooldownError", statusCode: 429 });
      expect(resends(error)).toBeUndefined();
      expect(waitMs).toBeGreaterThan(3_000);
      expect(waitMs).toBeLessThanOrEqual(4_000);
      expect(requests()).toBe(2);
      expect(resent).toMatchObject({ statusCode: 429 });
    }
  );
});

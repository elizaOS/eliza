/**
 * Bounds the requests one model call sends a provider that keeps refusing with
 * 429. Real AgentRuntime tiers, real handlers and AI SDK, a loopback provider
 * with Cerebras's two refusals: queue overload with no wait hint, and the
 * token bucket with Retry-After 60. When the lane already re-sent the request,
 * the error runtime.useModel rethrows after tier failover says so, and the
 * turn's re-send rule adds none. Before this, the turn re-sent the whole call
 * with a fresh lane budget: 8 requests on the generate lane, 12 on the stream
 * lanes. So does a hold another call sets while the live stream lane waits to
 * re-send, a fallback model's refusal once both models are held, and an
 * OpenRouter fallback's refusal after the Cerebras lane re-sent. A call whose
 * only request was refused keeps the turn's re-send.
 */
import { createServer, type Server, type ServerResponse } from "node:http";
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
const FALLBACK_MODEL = "qwen-3.8-27b-fallback";
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
/** What the loopback answers: status, headers and body. */
const REPLIES = {
  queue: [429, {}, QUEUE_REFUSAL],
  bucket: [429, { "retry-after": "60" }, BUCKET_REFUSAL],
  server: [500, {}, { message: "Encountered a server error", type: "server_error" }],
  unavailable: [503, { "retry-after": "60" }, { message: "Service unavailable" }],
} as const;
/** A refusal from REPLIES, or "ok": a 200 answer, streamed when the request asked for a stream. */
type Reply = keyof typeof REPLIES | "ok";
const ANSWER = "Answered by the loopback provider";

function answer(response: ServerResponse, model: string, stream: boolean): void {
  if (!stream) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: "answer",
        object: "chat.completion",
        created: 1,
        model,
        choices: [
          { index: 0, message: { role: "assistant", content: ANSWER }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      })
    );
    return;
  }
  const chunk = (delta: object, finish_reason: string | null) =>
    `data: ${JSON.stringify({ id: "answer", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(`${chunk({ content: ANSWER }, null)}${chunk({}, "stop")}data: [DONE]\n\n`);
}
/** Lanes and what one call may send on each: the first request and its re-sends. */
const LANES = [
  ["generate", 4],
  ["live stream", 6],
  ["buffered stream", 6],
] as const;
type Lane = (typeof LANES)[number][0];
interface WireRequest {
  /** "/fallback/..." for the OpenRouter fallback, "/v1/..." for the primary. */
  path: string;
  body: string;
  model: string;
}

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

/** Answers the nth request with replies[n] (the last one repeats), or what replies(request) returns. */
async function provider(
  lane: Lane,
  replies: Reply[] | ((request: WireRequest) => Reply | Promise<Reply>),
  env: Record<string, string> = {}
) {
  const log: WireRequest[] = [];
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", async () => {
      const { model, stream } = JSON.parse(body) as { model?: string; stream?: boolean };
      const wire = { path: request.url ?? "", body, model: model ?? "" };
      const n = log.length;
      log.push(wire);
      const reply =
        typeof replies === "function"
          ? await replies(wire)
          : replies[Math.min(n, replies.length - 1)];
      if (reply === "ok") {
        answer(response, wire.model, stream === true);
        return;
      }
      const [status, headers, refusal] = REPLIES[reply];
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(JSON.stringify(refusal));
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const baseURL = `${origin}/v1`;
  // The phone's direct route: every slot is the same Cerebras model, and a
  // provider hold lasts at most 4 s there, so the turn's re-send is not
  // refused locally.
  for (const [key, value] of Object.entries({
    ELIZA_PROVIDER: "cerebras",
    OPENAI_API_KEY: "loopback-only-key",
    OPENAI_BASE_URL: baseURL,
    CEREBRAS_API_KEY: "",
    CEREBRAS_MODEL: MODEL,
    CEREBRAS_SMALL_MODEL: MODEL,
    CEREBRAS_LARGE_MODEL: MODEL,
    OPENAI_FALLBACK_MODEL: "",
    ELIZA_BRAIN_PROVIDER: "",
    OPENROUTER_API_KEY: "",
    OPENROUTER_FALLBACK_MODEL: "",
    OPENROUTER_BASE_URL: `${origin}/fallback/v1`,
    ELIZA_TRAJECTORY_LOGGING: "0",
    ELIZA_TRAJECTORY_STRICT: "0",
    ELIZA_PLANNER_FULL_ACTION_SURFACE: lane === "buffered stream" ? "1" : "0",
    ...env,
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

  /** One useModel call, streamed to a callback as a chat turn's are. */
  const call = (prompt = "Original complete request") =>
    runtime.useModel(
      ModelType.RESPONSE_HANDLER,
      lane === "generate"
        ? { prompt, stream: false }
        : { prompt, stream: true, onStreamChunk: () => undefined }
    );
  /** A call the provider refuses; returns its error. */
  const modelCall = async (prompt?: string): Promise<unknown> => {
    try {
      await call(prompt);
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
  return { turn, call, modelCall, log, requests: () => log.length };
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
    const { turn, modelCall } = await provider("live stream", ({ body }) => {
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
    // Two re-sends reached the provider; the hold refused the third.
    expect(resends(error)).toBe(2);
    expect(waitMs).toBeUndefined();
  }, 30_000);

  it("keep the turn's re-send when another call's hold refuses the live stream lane's first re-send", async () => {
    // The call sent one request, like a refused first attempt, so the hold
    // refusal carries no stamp and the turn keeps its re-send, as before this
    // change. Counting the refused re-send would stamp it 1 and end the turn
    // after that one request.
    let firstCallRequests = 0;
    let secondCallRefused!: () => void;
    const holdSet = new Promise<void>((resolve) => {
      secondCallRefused = resolve;
    });
    const { turn, modelCall } = await provider("live stream", async ({ body }) => {
      if (body.includes("Second call")) return "bucket";
      firstCallRequests++;
      if (firstCallRequests > 1) return "bucket";
      // Answer the first request only once the second call's refusal set the
      // hold, so the lane's first backoff (300-500 ms) ends on the hold check.
      await holdSet;
      return "queue";
    });
    const firstTurn = turn("First call");
    await vi.waitFor(() => expect(firstCallRequests).toBe(1), { timeout: 5_000, interval: 5 });
    expect(await modelCall("Second call")).toMatchObject({ statusCode: 429 });
    secondCallRefused();
    const { error, waitMs, resent } = await firstTurn;
    expect(error).toMatchObject({ name: "ProviderRateLimitCooldownError", statusCode: 429 });
    expect(resends(error)).toBeUndefined();
    // A hold refusal reports the provider's whole window, so the turn waits
    // its 5 s cap; the 4 s hold has ended by then.
    expect(waitMs).toBe(5_000);
    // The turn's re-send reached the provider.
    expect(firstCallRequests).toBe(2);
    expect(resent).toMatchObject({ statusCode: 429 });
  }, 30_000);

  it.each(LANES)(
    "keep the fallback model's stamp when sibling tiers find both models held on the %s lane",
    async (lane) => {
      // OPENAI_FALLBACK_MODEL serves a call while the primary is held. Its lane
      // re-sends, meets Retry-After 60 and holds the fallback too; sibling
      // tiers then select the held primary. Before, they threw its fresh,
      // unstamped cooldown refusal and the turn re-sent on the primary.
      let fallbackRequests = 0;
      const { turn, modelCall, log } = await provider(
        lane,
        ({ body, model }) => {
          if (body.includes("Prime call")) return model === MODEL ? "bucket" : "unavailable";
          if (model === FALLBACK_MODEL) return fallbackRequests++ === 0 ? "queue" : "bucket";
          return "queue";
        },
        { OPENAI_FALLBACK_MODEL: FALLBACK_MODEL }
      );
      // Holds the primary; its sibling tiers meet the fallback's 503.
      await modelCall("Prime call");
      const primed = log.length;
      const { error, waitMs } = await turn("Turn call");
      expect(log.slice(primed).map(({ model }) => model)).toEqual([FALLBACK_MODEL, FALLBACK_MODEL]);
      expect(error).toMatchObject({ name: "AI_APICallError", statusCode: 429 });
      expect(resends(error)).toBe(1);
      expect(waitMs).toBeUndefined();
    }
  );

  it.each(LANES)(
    "send the primary when its hold ends while the fallback model's %s lane re-sends",
    async (lane) => {
      // The primary's 4 s hold ends while the fallback lane re-sends: its
      // backoffs take 2.1-2.8 s and its last refusal comes 3 s after it is
      // asked. Sibling tiers then select the primary again. Only while both
      // models are held may they rethrow what the fallback model recorded for
      // the call; otherwise the primary would never be tried and the stamped
      // refusal would end the call with no turn re-send.
      let fallbackRequests = 0;
      const { call, log } = await provider(
        lane,
        async ({ body, model }) => {
          if (body.includes("Prime call")) return model === MODEL ? "bucket" : "ok";
          if (model !== FALLBACK_MODEL) return "ok";
          if (++fallbackRequests < 4) return "queue";
          await new Promise((resolve) => setTimeout(resolve, 3_000));
          return "bucket";
        },
        { OPENAI_FALLBACK_MODEL: FALLBACK_MODEL }
      );
      // Holds the primary for 4 s; the fallback model answers.
      await call("Prime call");
      const primed = log.length;
      await expect(call("Turn call")).resolves.toBe(ANSWER);
      expect(log.slice(primed).map(({ model }) => model)).toEqual([
        FALLBACK_MODEL,
        FALLBACK_MODEL,
        FALLBACK_MODEL,
        FALLBACK_MODEL,
        MODEL,
      ]);
    }
  );

  it.each(LANES)(
    "keep the stamp when the OpenRouter fallback refuses a call the %s lane re-sent",
    async (lane) => {
      // Cerebras answers 500, the lane re-sends, and the 429 that follows goes
      // to OpenRouter, which refuses with Retry-After 60. Before, nothing was
      // stamped or recorded for the call: each sibling tier sent Cerebras once
      // more, the turn's re-send sent it five more times, and OpenRouter's 60 s
      // hold refused each hand-off locally (12 requests).
      let primaryRequests = 0;
      const { turn, log } = await provider(
        lane,
        ({ path }) =>
          path.startsWith("/fallback/") ? "bucket" : primaryRequests++ === 0 ? "server" : "queue",
        { OPENROUTER_FALLBACK_MODEL: "qwen/qwen3.8-27b", OPENROUTER_API_KEY: "loopback-only-key" }
      );
      const { error, waitMs } = await turn();
      expect(log.map(({ path }) => path.startsWith("/fallback/"))).toEqual([false, false, true]);
      expect(error).toMatchObject({ statusCode: 429 });
      expect(resends(error)).toBe(1);
      expect(waitMs).toBeUndefined();
    }
  );

  it.each(LANES)(
    "send Cerebras one request when the %s lane hands its first refusal to OpenRouter",
    async (lane) => {
      // The refusal goes to OpenRouter without a re-send. Before, it was not
      // recorded for the call, so each sibling tier sent Cerebras once more.
      const { modelCall, log } = await provider(
        lane,
        ({ path }) => (path.startsWith("/fallback/") ? "bucket" : "queue"),
        { OPENROUTER_FALLBACK_MODEL: "qwen/qwen3.8-27b", OPENROUTER_API_KEY: "loopback-only-key" }
      );
      const error = await modelCall();
      expect(log.map(({ path }) => path.startsWith("/fallback/"))).toEqual([false, true]);
      expect(resends(error)).toBeUndefined();
      // Nothing re-sent this call, so it keeps the turn's re-send.
      expect(turnRateLimitResendWaitMs(error)).toBeGreaterThan(2_000);
    }
  );

  it("stamp the live stream lane's exit for a configured OpenRouter fallback outside Cerebras mode", async () => {
    // Outside Cerebras mode the fallback never runs, but the live stream lane
    // still ends a 429 through its fallback exit. Every slot is one model, as
    // on the phone, so sibling tiers rethrow the call's recorded refusal.
    const { turn, requests } = await provider("live stream", ["queue"], {
      ELIZA_PROVIDER: "openai",
      OPENAI_SMALL_MODEL: MODEL,
      OPENAI_LARGE_MODEL: MODEL,
      OPENROUTER_FALLBACK_MODEL: "qwen/qwen3.8-27b",
      OPENROUTER_API_KEY: "loopback-only-key",
    });
    const { error, waitMs } = await turn();
    expect(requests()).toBe(6);
    expect(resends(error)).toBe(5);
    expect(waitMs).toBeUndefined();
  }, 30_000);

  it.each(LANES)(
    "leave a 5xx that ends the %s lane after a re-send to tier failover",
    async (lane) => {
      // Only a 429 is stamped and recorded at a lane's early exit: each sibling
      // tier still sends the request once.
      const { modelCall, requests } = await provider(lane, ["server", "unavailable"]);
      const error = await modelCall();
      expect(error).toMatchObject({ statusCode: 503 });
      expect(resends(error)).toBeUndefined();
      expect(requests()).toBe(6);
    }
  );

  it.each(LANES)(
    "keep the turn's one re-send after a first-attempt long wait on the %s lane",
    async (lane) => {
      const { turn, requests } = await provider(lane, ["bucket"]);
      const { error, waitMs, resent } = await turn();
      expect(error).toMatchObject({ name: "ProviderRateLimitCooldownError", statusCode: 429 });
      expect(resends(error)).toBeUndefined();
      // The provider's whole window, capped: the 4 s hold ends first, so the
      // turn's re-send reaches the provider.
      expect(waitMs).toBe(5_000);
      expect(requests()).toBe(2);
      expect(resent).toMatchObject({ statusCode: 429 });
    }
  );
});

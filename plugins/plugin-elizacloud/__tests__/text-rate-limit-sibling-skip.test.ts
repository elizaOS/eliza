/**
 * A Cloud 429 is uploaded once per refused call when every text slot sends one
 * model: the runtime's failover does not send the same request again through
 * each sibling model type. The refusal keeps status 429 and the wait the
 * gateway reported, in a body or in a stream frame.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  AgentRuntime,
  type IAgentRuntime,
  isInsufficientCreditsError,
  isModelProviderFallbackError,
  isModelProviderRetryBudgetExhaustedError,
  isRateLimitError,
  ModelType,
  providerRateLimitRetryAt,
  readProviderRateLimit,
  type TextStreamResult,
} from "@elizaos/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { rateLimitRetryWaitMs } from "../../plugin-assistant/src/runtime/evaluator";
import {
  ElizaCloudRateLimitedError,
  handleActionPlanner,
  handleResponseHandler,
  handleTextLarge,
  handleTextMedium,
  handleTextMega,
  handleTextNano,
  handleTextSmall,
} from "../src/models/text";
import { getCloudInferenceFailure } from "../src/utils/inference-diagnostics";

/** A refusal as an HTTP 429 body, or as an error frame inside a 200 stream. */
type Refusal = { body: Record<string, unknown> } | { frame: Record<string, unknown> };

let server: Server;
let baseUrl: string;
/** The model type header of each upload, in order. */
let uploads: string[] = [];
let refusal: Refusal;

beforeAll(async () => {
  server = createServer((req, res) => {
    uploads.push(String(req.headers["x-eliza-model-type"]));
    req.resume();
    req.on("end", () => {
      if ("frame" in refusal) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify(refusal.frame)}\n\n`);
        res.end("data: [DONE]\n\n");
        return;
      }
      // Today's gateway sends no Retry-After header with a provider refusal.
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify(refusal.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  uploads = [];
});

/** What the gateway answers today when the provider refuses a request. */
const PROVIDER_REFUSAL = {
  error: { message: "Rate limit exceeded. Please try again later.", type: "rate_limit_error" },
};
/** The same refusal once the gateway sizes the wait. */
const SIZED_REFUSAL = { error: { ...PROVIDER_REFUSAL.error, retryAfterMs: 1_500 } };
const REFUSAL_FRAME = { error: { ...PROVIDER_REFUSAL.error, code: 429 } };
const SIZED_REFUSAL_FRAME = { error: { ...SIZED_REFUSAL.error, code: 429 } };

/** The seven text registrations of this provider, as its plugin registers them. */
const CLOUD_TEXT_HANDLERS = [
  [ModelType.TEXT_NANO, handleTextNano],
  [ModelType.TEXT_SMALL, handleTextSmall],
  [ModelType.TEXT_MEDIUM, handleTextMedium],
  [ModelType.TEXT_LARGE, handleTextLarge],
  [ModelType.TEXT_MEGA, handleTextMega],
  [ModelType.RESPONSE_HANDLER, handleResponseHandler],
  [ModelType.ACTION_PLANNER, handleActionPlanner],
] as const;

/**
 * A runtime with every Cloud text slot registered. Without `settings` each slot
 * resolves to the plugin's one default model, as on a phone, whose launcher
 * sets one model on every slot.
 */
function agent(settings: Record<string, string> = {}): AgentRuntime {
  const runtime = new AgentRuntime({
    character: {
      name: "Sibling skip test",
      bio: [],
      settings: {
        secrets: { ELIZAOS_CLOUD_API_KEY: "synthetic-test-key" },
        ELIZAOS_CLOUD_BASE_URL: baseUrl,
        ...settings,
      },
    },
    logLevel: "fatal",
    adapter: { createLogs: async () => undefined },
  } as never);
  for (const [type, handler] of CLOUD_TEXT_HANDLERS)
    runtime.registerModel(type, handler as never, "elizaOSCloud", 50);
  return runtime;
}

const STAGE1 = { prompt: "Say hi", messages: [{ role: "user" as const, content: "Say hi" }] };
const STREAMED_STAGE1 = {
  ...STAGE1,
  stream: true,
  streamStructured: true,
  onStreamChunk: () => undefined,
};

async function refused(run: () => Promise<unknown>): Promise<unknown> {
  try {
    const result = await run();
    if (result && typeof result === "object" && "textStream" in result) {
      for await (const _chunk of (result as TextStreamResult).textStream) {
        // drain
      }
    }
  } catch (error) {
    return error;
  }
  throw new Error("Cloud call completed without the refusal");
}

describe("a Cloud 429 when every text slot sends one model", () => {
  it("uploads a refused Stage 1 call once, and once more for the chat turn's re-send", async () => {
    refusal = { body: PROVIDER_REFUSAL };
    const runtime = agent();
    const error = await refused(() => runtime.useModel(ModelType.RESPONSE_HANDLER, STAGE1));
    // Not again through the rest of RESPONSE_HANDLER's failover chain:
    // TEXT_NANO, TEXT_SMALL, TEXT_MEDIUM, TEXT_LARGE.
    expect(uploads).toEqual(["RESPONSE_HANDLER"]);
    expect(error).toBeInstanceOf(ElizaCloudRateLimitedError);
    expect((error as { status?: number }).status).toBe(429);
    expect((error as Error).message).toBe("Rate limit exceeded. Please try again later.");
    expect((error as { error?: unknown }).error).toEqual(PROVIDER_REFUSAL.error);
    expect(isRateLimitError(error)).toBe(true);
    expect(isModelProviderRetryBudgetExhaustedError(error)).toBe(true);
    // Support reads this in /api/status: the typed error is still a rate limit.
    expect(getCloudInferenceFailure(runtime)).toMatchObject({ reason: "rate-limit", status: 429 });
    // No wait was reported, so none is invented: the chat turn falls back to
    // its own capped wait before its single re-send.
    expect(error).not.toHaveProperty("rateLimit");
    expect(readProviderRateLimit(error)).toBeUndefined();
    expect(providerRateLimitRetryAt(error)).toBeUndefined();
    expect(rateLimitRetryWaitMs(error)).toBe(5_000);
    // The re-send is a new dispatch, and it is refused once as well.
    await refused(() => runtime.useModel(ModelType.RESPONSE_HANDLER, STAGE1));
    expect(uploads).toEqual(["RESPONSE_HANDLER", "RESPONSE_HANDLER"]);
  });

  it("uploads a refused planner call once", async () => {
    refusal = { body: PROVIDER_REFUSAL };
    const error = await refused(() => agent().useModel(ModelType.ACTION_PLANNER, STAGE1));
    // Not again through TEXT_MEDIUM, TEXT_SMALL and TEXT_LARGE.
    expect(uploads).toEqual(["ACTION_PLANNER"]);
    expect((error as { status?: number }).status).toBe(429);
  });

  it("uploads a refused bare-prompt call once", async () => {
    refusal = { body: PROVIDER_REFUSAL };
    const error = await refused(() => agent().useModel(ModelType.TEXT_SMALL, { prompt: "Say hi" }));
    // Not again through TEXT_MEDIUM and TEXT_LARGE.
    expect(uploads).toEqual(["TEXT_SMALL"]);
    expect((error as { status?: number }).status).toBe(429);
  });

  it("uploads once when the refusal arrives as a stream frame", async () => {
    refusal = { frame: REFUSAL_FRAME };
    const error = await refused(() =>
      agent().useModel(ModelType.RESPONSE_HANDLER, STREAMED_STAGE1 as never)
    );
    expect(uploads).toEqual(["RESPONSE_HANDLER"]);
    expect(error).toBeInstanceOf(ElizaCloudRateLimitedError);
    expect((error as { status?: number }).status).toBe(429);
    expect((error as { error?: unknown }).error).toEqual(REFUSAL_FRAME.error);
    expect(readProviderRateLimit(error)).toBeUndefined();
    expect(rateLimitRetryWaitMs(error)).toBe(5_000);
  });

  it.each([
    ["a body", { body: SIZED_REFUSAL }, STAGE1],
    ["a stream frame", { frame: SIZED_REFUSAL_FRAME }, STREAMED_STAGE1],
  ] as const)(
    "reports the 1,500 ms wait %s names and keeps status 429",
    async (_label, sized, call) => {
      refusal = sized;
      const error = await refused(() =>
        agent().useModel(ModelType.RESPONSE_HANDLER, call as never)
      );
      expect(uploads).toEqual(["RESPONSE_HANDLER"]);
      expect((error as { status?: number }).status).toBe(429);
      expect((error as { rateLimit?: unknown }).rateLimit).toEqual({
        kind: "rate_limited",
        retryAfterMs: 1_500,
      });
      expect(readProviderRateLimit(error)).toEqual({ kind: "rate_limited", retryAfterMs: 1_500 });
      expect(rateLimitRetryWaitMs(error)).toBe(1_500);
      // A report for the client and the chat re-send, not a transport retry hint.
      expect(providerRateLimitRetryAt(error)).toBeUndefined();
    }
  );

  it("still hands the call to a distinct provider", async () => {
    refusal = { body: PROVIDER_REFUSAL };
    const runtime = agent();
    const other = vi.fn(async () => "Hi from another provider");
    // Last in RESPONSE_HANDLER's chain, behind this provider's TEXT_LARGE.
    runtime.registerModel(ModelType.TEXT_LARGE, other, "other", 0);
    expect(await runtime.useModel(ModelType.RESPONSE_HANDLER, STAGE1)).toBe(
      "Hi from another provider"
    );
    expect(uploads).toEqual(["RESPONSE_HANDLER"]);
    expect(other).toHaveBeenCalledTimes(1);
  });

  it("keeps a 429 that reports spent credit a credits failure, uploaded once", async () => {
    refusal = {
      body: { error: { message: "Insufficient credits", type: "insufficient_quota" } },
    };
    const error = await refused(() => agent().useModel(ModelType.RESPONSE_HANDLER, STAGE1));
    expect(uploads).toEqual(["RESPONSE_HANDLER"]);
    expect((error as { status?: number }).status).toBe(429);
    expect(isInsufficientCreditsError(error)).toBe(true);
    expect(rateLimitRetryWaitMs(error)).toBeUndefined();
  });
});

describe("a Cloud 429 when the text slots send different models", () => {
  it("keeps the failover ladder: another slot is another model", async () => {
    refusal = { body: SIZED_REFUSAL };
    const error = await refused(() =>
      agent({ ELIZAOS_CLOUD_LARGE_MODEL: "another-large-model" }).useModel(
        ModelType.RESPONSE_HANDLER,
        STAGE1
      )
    );
    expect(uploads).toEqual([
      "RESPONSE_HANDLER",
      "TEXT_NANO",
      "TEXT_SMALL",
      "TEXT_MEDIUM",
      "TEXT_LARGE",
    ]);
    expect(error).not.toBeInstanceOf(ElizaCloudRateLimitedError);
    expect(isModelProviderRetryBudgetExhaustedError(error)).toBe(false);
    expect(isModelProviderFallbackError(error, ModelType.RESPONSE_HANDLER)).toBe(true);
    expect((error as { status?: number }).status).toBe(429);
    expect(readProviderRateLimit(error)).toEqual({ kind: "rate_limited", retryAfterMs: 1_500 });
  });
});

describe("a refusal frame inside a 200 stream", () => {
  /** One handler call with no runtime dispatch around it, on a mixed-model runtime. */
  function streamed(frame: Record<string, unknown>): Promise<unknown> {
    refusal = { frame };
    const settings: Record<string, string> = {
      ELIZAOS_CLOUD_API_KEY: "synthetic-test-key",
      ELIZAOS_CLOUD_BASE_URL: baseUrl,
      ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL: "gpt-oss-120b",
    };
    const runtime = {
      character: { name: "Stream frame test", bio: [] },
      getSetting: (key: string) => settings[key],
      emitEvent: vi.fn(),
    } as unknown as IAgentRuntime;
    return refused(() => handleResponseHandler(runtime, STREAMED_STAGE1 as never));
  }

  it("reads the wait from the same fields as a 429 body", async () => {
    const error = await streamed(SIZED_REFUSAL_FRAME);
    expect((error as { status?: number }).status).toBe(429);
    expect((error as { rateLimit?: unknown }).rateLimit).toEqual({
      kind: "rate_limited",
      retryAfterMs: 1_500,
    });
    expect(
      readProviderRateLimit(
        await streamed({ error: { ...REFUSAL_FRAME.error, retryAfterSeconds: 2 } })
      )
    ).toEqual({ kind: "rate_limited", retryAfterMs: 2_000 });
  });

  it("adds no wait to today's frame or to another status, and skips a malformed one", async () => {
    for (const frame of [
      REFUSAL_FRAME,
      { error: { ...REFUSAL_FRAME.error, retryAfterMs: "soon" } },
      { error: { ...REFUSAL_FRAME.error, retryAfterMs: -1 } },
      { error: { message: "Service unavailable", code: 503, retryAfterMs: 1_500 } },
      { error: { message: "Rate limited", code: "429", retryAfterMs: 1_500 } },
    ]) {
      const error = await streamed(frame);
      expect(error).not.toHaveProperty("rateLimit");
      expect((error as { error?: unknown }).error).toEqual(frame.error);
      expect(isModelProviderRetryBudgetExhaustedError(error)).toBe(false);
    }
  });
});

/**
 * Explorer harness (untracked, angle pacing-refusals). Drives the real plugin-openai text handler
 * against a loopback provider that refuses the first request the way Cerebras does (429,
 * Retry-After: 59) and admits every later one, and asks the chat stages' own wait rule
 * (rateLimitRetryWaitMs) how long they would wait before their one re-send.
 *
 * It shows what the one re-send meets on the direct route:
 *  - host that does not cap the hold: the model is still held when the re-send comes, so the
 *    re-send fails locally and never reaches the provider;
 *  - host that caps the hold at 5 s (the phone): the re-send is sent and admitted.
 * It also checks a prototype of a wait sized to the refused request.
 */
import { createServer, type Server } from "node:http";
import type { IAgentRuntime } from "@elizaos/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleTextSmall } from "../../../plugin-openai/models/text";
import { rateLimitRetryWaitMs } from "../runtime/evaluator.ts";

let server: Server;
let baseUrl: string;
let requests = 0;
let refuseFirst = 1;

beforeAll(async () => {
  server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requests++;
      if (requests <= refuseFirst) {
        response.writeHead(429, { "content-type": "application/json", "retry-after": "59" });
        response.end(JSON.stringify({ message: "Tokens per minute limit exceeded - too many tokens processed.", type: "too_many_requests_error", param: "quota", code: "token_quota_exceeded" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json", "x-ratelimit-limit-tokens-minute": "150000", "x-ratelimit-remaining-tokens-minute": "120000" });
      response.end(JSON.stringify({ id: "x", object: "chat.completion", created: 1, model: "qwen-3.8-27b", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture failed to bind");
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});
beforeEach(() => {
  requests = 0;
  refuseFirst = 1;
  vi.stubEnv("ELIZA_PROVIDER", "cerebras");
  vi.stubEnv("OPENAI_BASE_URL", baseUrl);
  vi.stubEnv("OPENAI_API_KEY", "loopback-only-key");
  vi.stubEnv("CEREBRAS_API_KEY", undefined);
  vi.stubEnv("OPENAI_RATE_LIMIT_MAX_HOLD_SECONDS", undefined);
  vi.stubEnv("CEREBRAS_RATE_LIMIT_MAX_HOLD_SECONDS", undefined);
});
afterEach(() => {
  vi.useRealTimers();
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
const send = (agent: IAgentRuntime) => handleTextSmall(agent, { prompt: "Probe", model: "qwen-3.8-27b", stream: false });
const failure = async (request: ReturnType<typeof send>): Promise<unknown> => {
  try {
    await request;
  } catch (error) {
    return error;
  }
  throw new Error("expected a refusal");
};

/** Prototype: wait half of what the refused request holds at the provider's refill rate, within bounds. */
function sizedRateLimitWaitMs(inputTokens: number, outputCap: number | undefined, limitPerMinute = 150_000): number {
  const hold = 1.25 * inputTokens + (outputCap ?? 16_384);
  return Math.round(Math.max(3_000, Math.min(8_000, hold / 2 / (limitPerMinute / 60_000))));
}

describe("the one re-send after a refusal, direct route", () => {
  it("never reaches the provider on a host that does not cap the hold", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const agent = runtime();
    const refused = await failure(send(agent));
    expect(refused).toMatchObject({ statusCode: 429 });
    expect(requests).toBe(1);
    const waitMs = rateLimitRetryWaitMs(refused);
    expect(waitMs).toBe(5_000);
    vi.setSystemTime(Date.now() + (waitMs ?? 0) + 50);
    const second = await failure(send(agent));
    expect(second).toMatchObject({ name: "ProviderRateLimitCooldownError", statusCode: 429 });
    expect(requests).toBe(1);
    // The local failure asks for another capped wait; chat stages re-send once, so the turn ends here.
    expect(rateLimitRetryWaitMs(second)).toBe(5_000);
    console.log(`[x-pacing] hold not capped: provider requests ${requests}; re-send after ${waitMs} ms met ${(second as Error).name}: ${(second as Error).message}`);
  });

  it("is sent and admitted where the host caps the hold at five seconds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const agent = runtime({ OPENAI_RATE_LIMIT_MAX_HOLD_SECONDS: "5" });
    const refused = await failure(send(agent));
    expect(requests).toBe(1);
    const waitMs = rateLimitRetryWaitMs(refused);
    expect(waitMs).toBe(5_000);
    // One second into the hold a small call is still failed locally, whatever its size.
    vi.setSystemTime(Date.now() + 1_000);
    const early = await failure(send(agent));
    expect(early).toMatchObject({ name: "ProviderRateLimitCooldownError" });
    expect(requests).toBe(1);
    vi.setSystemTime(Date.now() + 4_050);
    await expect(send(agent)).resolves.toBeDefined();
    expect(requests).toBe(2);
    console.log(`[x-pacing] hold capped at 5 s: provider requests ${requests}; early call met ${(early as Error).name}, wait hint ${rateLimitRetryWaitMs(early)} ms`);
  });

  it("a second refusal ends the call: nothing re-sends twice", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    refuseFirst = 2;
    const agent = runtime({ OPENAI_RATE_LIMIT_MAX_HOLD_SECONDS: "5" });
    const first = await failure(send(agent));
    vi.setSystemTime(Date.now() + (rateLimitRetryWaitMs(first) ?? 0) + 50);
    const second = await failure(send(agent));
    expect(second).toMatchObject({ statusCode: 429 });
    expect(requests).toBe(2);
    // The provider's hint is the same 59 s both times: the wait cannot tell a 6K-token call from a 60K-token one.
    expect(rateLimitRetryWaitMs(second)).toBe(5_000);
  });

  it("prototype: a wait sized to the refused request", () => {
    // Stage 1, planner and evaluator of the recorded one-conversation run (median input, cap 4,096).
    expect(sizedRateLimitWaitMs(11_163, 4_096)).toBe(3_610);
    expect(sizedRateLimitWaitMs(17_658, 4_096)).toBe(5_234);
    // An uncapped side call of 10K tokens, and an old-runtime first step of 61K tokens with no cap.
    expect(sizedRateLimitWaitMs(10_651, undefined)).toBe(5_940);
    expect(sizedRateLimitWaitMs(61_000, undefined)).toBe(8_000);
    expect(sizedRateLimitWaitMs(2_000, 4_096)).toBe(3_000);
  });
});

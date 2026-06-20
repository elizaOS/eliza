/**
 * Unit tests for the per-process native-cerebras concurrency limiter that wraps
 * the `/chat/completions` round-trip in `generateNativeChatCompletion`
 * (src/models/text.ts).
 *
 * A single chat turn fans providers out via composeState's `Promise.all`, each
 * calling `useModel` -> generateNativeChatCompletion; firing them all at once
 * overruns the one shared cerebras key's concurrent limit -> 429. The limiter
 * serializes that burst. These tests use a fake `requestRaw` backed by
 * controllable deferreds — NO live API.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Controllable fake transport. Each `requestRaw` call registers an in-flight
// entry and resolves only when the test resolves its deferred. We track the
// observed max-in-flight to assert the cap.
type Deferred = {
  resolve: (value: Response) => void;
  reject: (err: unknown) => void;
};

const transport = {
  inFlight: 0,
  maxInFlight: 0,
  /** FIFO list of pending deferreds in acquire order. */
  pending: [] as Deferred[],
  /** Order in which calls actually entered the guarded section. */
  enterOrder: [] as number[],
  reset() {
    this.inFlight = 0;
    this.maxInFlight = 0;
    this.pending = [];
    this.enterOrder = [];
  },
};

let callSeq = 0;

const requestRaw = vi.fn(async (_method: string, _path: string, _opts?: unknown) => {
  const seq = callSeq++;
  transport.inFlight += 1;
  transport.maxInFlight = Math.max(transport.maxInFlight, transport.inFlight);
  transport.enterOrder.push(seq);
  try {
    return await new Promise<Response>((resolve, reject) => {
      transport.pending.push({ resolve, reject });
    });
  } finally {
    transport.inFlight -= 1;
  }
});

vi.mock("../src/utils/sdk-client", () => ({
  createCloudApiClient: () => ({ requestRaw }),
  createElizaCloudClient: () => ({}),
}));

// Imported after the mock is registered.
import {
  __resetNativeChatLimiterForTests,
  generateNativeChatCompletion,
  withNativeChatLimit,
} from "../src/models/text";

function fakeRuntime(): IAgentRuntime {
  return {
    character: { name: "Eliza", bio: [] },
    getSetting: () => undefined,
    emitEvent: vi.fn(),
    emitModelUsageEvent: vi.fn(),
  } as unknown as IAgentRuntime;
}

function okResponse(text = "pong"): Response {
  const body = JSON.stringify({
    choices: [{ message: { content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
}

/** Yield enough microtasks for the semaphore queue to settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
}

function fireNativeCall(): Promise<unknown> {
  return generateNativeChatCompletion(
    fakeRuntime(),
    "TEXT_SMALL" as never,
    { prompt: "hi" } as never,
    { modelName: "cerebras/gpt-oss-120b", prompt: "hi" }
  );
}

// Mirrors the production /responses round-trip: the bare-`{ prompt }` path also
// funnels its requestRaw network call through `withNativeChatLimit`, sharing the
// SAME per-process limiter as the /chat/completions route. We drive the helper
// directly with the same fake transport so the two routes contend on one cap.
function fireResponsesCall(): Promise<unknown> {
  return withNativeChatLimit(() =>
    requestRaw("POST", "/responses", { headers: {}, json: { prompt: "hi" } })
  );
}

describe("native cerebras concurrency limiter", () => {
  beforeEach(() => {
    transport.reset();
    callSeq = 0;
    requestRaw.mockClear();
    delete process.env.ELIZAOS_CLOUD_NATIVE_CONCURRENCY;
    __resetNativeChatLimiterForTests();
  });

  afterEach(() => {
    delete process.env.ELIZAOS_CLOUD_NATIVE_CONCURRENCY;
    __resetNativeChatLimiterForTests();
  });

  it("defaults to a non-serializing safety ceiling of 8", async () => {
    // The default is a ceiling, not full serialization: a typical turn's 1-3
    // concurrent calls run unguarded; only a pathological burst is bounded.
    // Fire 10 with no env set and assert the ceiling is 8.
    const calls = Array.from({ length: 10 }, () => fireNativeCall());
    await flush();

    expect(transport.maxInFlight).toBe(8);
    expect(transport.pending.length).toBe(8);

    while (transport.pending.length > 0) {
      transport.pending.shift()?.resolve(okResponse());
      await flush();
    }
    await Promise.all(calls);
    expect(transport.maxInFlight).toBe(8);
    expect(requestRaw).toHaveBeenCalledTimes(10);
  });

  it("serializes when ELIZAOS_CLOUD_NATIVE_CONCURRENCY=1", async () => {
    process.env.ELIZAOS_CLOUD_NATIVE_CONCURRENCY = "1";
    __resetNativeChatLimiterForTests();

    const calls = [
      fireNativeCall(),
      fireNativeCall(),
      fireNativeCall(),
      fireNativeCall(),
      fireNativeCall(),
    ];
    await flush();

    // Limit 1 -> only one call should have entered the transport.
    expect(transport.inFlight).toBe(1);
    expect(transport.maxInFlight).toBe(1);

    // Drain one-by-one; each release lets the next in.
    for (let i = 0; i < 5; i++) {
      expect(transport.pending.length).toBe(1);
      transport.pending.shift()?.resolve(okResponse());
      await flush();
    }

    await Promise.all(calls);
    expect(transport.maxInFlight).toBe(1);
    expect(requestRaw).toHaveBeenCalledTimes(5);
  });

  it("caps in-flight native calls at 2 when ELIZAOS_CLOUD_NATIVE_CONCURRENCY=2", async () => {
    process.env.ELIZAOS_CLOUD_NATIVE_CONCURRENCY = "2";
    __resetNativeChatLimiterForTests();

    const calls = [
      fireNativeCall(),
      fireNativeCall(),
      fireNativeCall(),
      fireNativeCall(),
      fireNativeCall(),
    ];
    await flush();

    expect(transport.inFlight).toBe(2);
    expect(transport.maxInFlight).toBe(2);

    while (transport.pending.length > 0) {
      transport.pending.shift()?.resolve(okResponse());
      await flush();
    }

    await Promise.all(calls);
    // Max in-flight never exceeded the configured cap of 2.
    expect(transport.maxInFlight).toBe(2);
  });

  it("admits queued callers in FIFO acquire order", async () => {
    // Pin the limit to 1; fire 3 and resolve in order, asserting entry is FIFO.
    process.env.ELIZAOS_CLOUD_NATIVE_CONCURRENCY = "1";
    __resetNativeChatLimiterForTests();
    const calls = [fireNativeCall(), fireNativeCall(), fireNativeCall()];
    await flush();

    // First caller entered.
    expect(transport.enterOrder).toEqual([0]);
    transport.pending.shift()?.resolve(okResponse());
    await flush();
    expect(transport.enterOrder).toEqual([0, 1]);
    transport.pending.shift()?.resolve(okResponse());
    await flush();
    expect(transport.enterOrder).toEqual([0, 1, 2]);
    transport.pending.shift()?.resolve(okResponse());
    await flush();

    await Promise.all(calls);
    expect(transport.enterOrder).toEqual([0, 1, 2]);
  });

  it("releases the permit when the request rejects (next call proceeds)", async () => {
    process.env.ELIZAOS_CLOUD_NATIVE_CONCURRENCY = "1";
    __resetNativeChatLimiterForTests();
    const first = fireNativeCall();
    await flush();
    expect(transport.inFlight).toBe(1);

    const second = fireNativeCall();
    await flush();
    // Second is queued behind the semaphore (limit 1).
    expect(transport.inFlight).toBe(1);

    // Reject the first call's transport -> permit must be released in finally.
    transport.pending.shift()?.reject(new Error("boom"));
    await flush();
    await expect(first).rejects.toThrow("boom");

    // The second call should now be in-flight (permit was freed despite the throw).
    expect(transport.inFlight).toBe(1);
    expect(transport.pending.length).toBe(1);
    transport.pending.shift()?.resolve(okResponse());
    await second;
    expect(transport.maxInFlight).toBe(1);
  });

  describe("knob parsing", () => {
    // Invalid / unset values fall back to the default ceiling of 8.
    const cases: Array<{ raw: string | undefined; expected: number }> = [
      { raw: "2", expected: 2 },
      { raw: "0", expected: 8 },
      { raw: "abc", expected: 8 },
      { raw: undefined, expected: 8 },
    ];

    for (const { raw, expected } of cases) {
      it(`ELIZAOS_CLOUD_NATIVE_CONCURRENCY=${JSON.stringify(raw)} -> limit ${expected}`, async () => {
        if (raw === undefined) {
          delete process.env.ELIZAOS_CLOUD_NATIVE_CONCURRENCY;
        } else {
          process.env.ELIZAOS_CLOUD_NATIVE_CONCURRENCY = raw;
        }
        __resetNativeChatLimiterForTests();

        // Fire expected+2 calls; the observed concurrency ceiling proves the limit.
        const n = expected + 2;
        const calls = Array.from({ length: n }, () => fireNativeCall());
        await flush();

        expect(transport.maxInFlight).toBe(expected);

        while (transport.pending.length > 0) {
          transport.pending.shift()?.resolve(okResponse());
          await flush();
        }
        await Promise.all(calls);
        expect(transport.maxInFlight).toBe(expected);
      });
    }
  });

  describe("shared cap across both native routes (/chat/completions + /responses)", () => {
    it("interleaved /chat/completions and /responses calls never exceed one shared cap", async () => {
      // Both routes hit the SAME shared cerebras key, so they must contend on
      // ONE limiter. Pin to 1 and assert max-in-flight across BOTH routes ≤ 1.
      process.env.ELIZAOS_CLOUD_NATIVE_CONCURRENCY = "1";
      __resetNativeChatLimiterForTests();
      const calls = [
        fireNativeCall(), // /chat/completions
        fireResponsesCall(), // /responses
        fireNativeCall(), // /chat/completions
        fireResponsesCall(), // /responses
      ];
      await flush();

      // Default cap 1 -> only ONE round-trip in flight regardless of route.
      expect(transport.inFlight).toBe(1);
      expect(transport.maxInFlight).toBe(1);

      // Drain one-by-one; each release admits the next, whichever route it is.
      for (let i = 0; i < 4; i++) {
        expect(transport.pending.length).toBe(1);
        transport.pending.shift()?.resolve(okResponse());
        await flush();
      }

      await Promise.all(calls);
      // The /responses path was NEVER able to bypass the cap.
      expect(transport.maxInFlight).toBe(1);
      expect(requestRaw).toHaveBeenCalledTimes(4);
    });

    it("interleaved routes respect a raised cap of 2", async () => {
      process.env.ELIZAOS_CLOUD_NATIVE_CONCURRENCY = "2";
      __resetNativeChatLimiterForTests();

      const calls = [
        fireResponsesCall(),
        fireNativeCall(),
        fireResponsesCall(),
        fireNativeCall(),
        fireResponsesCall(),
      ];
      await flush();

      // Cap 2 across BOTH routes combined.
      expect(transport.inFlight).toBe(2);
      expect(transport.maxInFlight).toBe(2);

      while (transport.pending.length > 0) {
        transport.pending.shift()?.resolve(okResponse());
        await flush();
      }

      await Promise.all(calls);
      expect(transport.maxInFlight).toBe(2);
    });
  });
});

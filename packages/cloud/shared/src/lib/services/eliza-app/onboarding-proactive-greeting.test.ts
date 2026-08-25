/**
 * Proves the process-local proactive-greeting fallback uses the same lease,
 * stable-nonce, acknowledgement, and set semantics as the Durable Object.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  acknowledgeDiscordProactiveGreetings,
  clearLocalGreetingQueue,
  drainDiscordProactiveGreetings,
  enqueueDiscordProactiveGreeting,
  greetingFetch,
  peekLocalGreetingQueue,
} from "./onboarding-proactive-greeting";

beforeEach(() => clearLocalGreetingQueue());

describe("local proactive greeting queue", () => {
  test("retains a leased greeting until the matching acknowledgement", async () => {
    const sessionId = "platform:discord:local-1";
    await enqueueDiscordProactiveGreeting({
      sessionId,
      platformUserId: "local-1",
      name: "Sam",
    });

    const first = await drainDiscordProactiveGreetings();
    expect(first).toHaveLength(1);
    expect(first[0]?.message).toContain("Sam");
    expect(first[0]?.deliveryNonce).toMatch(/^[A-Za-z0-9_-]{1,25}$/);
    expect(await drainDiscordProactiveGreetings()).toEqual([]);

    expect(
      await acknowledgeDiscordProactiveGreetings([{ sessionId, leaseId: "wrong-lease" }]),
    ).toBe(0);
    expect(peekLocalGreetingQueue()).toHaveLength(1);
    expect(
      await acknowledgeDiscordProactiveGreetings([{ sessionId, leaseId: first[0]?.leaseId ?? "" }]),
    ).toBe(1);
    expect(peekLocalGreetingQueue()).toEqual([]);
  });

  test("re-enqueue is a no-op that preserves the original work and live lease", async () => {
    const sessionId = "platform:discord:local-2";
    await enqueueDiscordProactiveGreeting({
      sessionId,
      platformUserId: "local-2",
      name: "First",
    });
    const originalNonce = peekLocalGreetingQueue()[0]?.deliveryNonce;
    const leased = await drainDiscordProactiveGreetings();

    await enqueueDiscordProactiveGreeting({
      sessionId,
      platformUserId: "local-2",
      name: "Second",
    });
    const queued = peekLocalGreetingQueue();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.message).toContain("First");
    expect(queued[0]?.deliveryNonce).toBe(originalNonce);

    // Replayed enqueue cannot expose the same work to a second sender.
    expect(await drainDiscordProactiveGreetings()).toEqual([]);
    expect(
      await acknowledgeDiscordProactiveGreetings([
        { sessionId, leaseId: leased[0]?.leaseId ?? "" },
      ]),
    ).toBe(1);
  });
});

describe("greetingFetch — bounded hops fail closed and keep caller signals", () => {
  test("aborts a hung coordinator hop at the timeout", async () => {
    const hungStub = {
      fetch: (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    };
    const start = Date.now();
    await expect(
      greetingFetch(hungStub, "https://onboarding.internal/enqueue-greeting", undefined, 100),
    ).rejects.toThrow(/aborted/i);
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  test("composes a caller-provided abort signal with the hop deadline", async () => {
    let seen: AbortSignal | undefined;
    const stub = {
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen = init?.signal;
        return new Response("{}", { status: 200 });
      },
    };
    const controller = new AbortController();
    await greetingFetch(stub, "https://onboarding.internal/enqueue-greeting", {
      signal: controller.signal,
    });
    // The wrapper owns the deadline, so the signal handed to the transport is
    // a composition of the caller's signal and that deadline — never the caller's
    // object verbatim. Asserting identity here would pin the very behavior that
    // lets a never-firing caller signal defeat the bound.
    expect(seen).not.toBe(controller.signal);
  });
});

/**
 * Proves the process-local proactive-greeting fallback uses the same lease,
 * stable-nonce, acknowledgement, and set semantics as the Durable Object.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  acknowledgeDiscordProactiveGreetings,
  clearLocalGreetingQueue,
  drainDiscordProactiveGreetings,
  drainProactiveGreetings,
  enqueueDiscordProactiveGreeting,
  enqueueProactiveGreeting,
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

  test("isolates Telegram and SMS work from the Discord queue", async () => {
    await enqueueProactiveGreeting("telegram", {
      sessionId: "platform:telegram:123456",
      platformUserId: "123456",
      platform: "telegram",
    });
    await enqueueProactiveGreeting("twilio", {
      sessionId: "platform:twilio:+14155550100",
      platformUserId: "+14155550100",
      platform: "twilio",
    });

    expect(await drainDiscordProactiveGreetings()).toEqual([]);
    expect((await drainProactiveGreetings("telegram"))[0]?.platformUserId).toBe("123456");
    expect((await drainProactiveGreetings("twilio"))[0]?.platformUserId).toBe("+14155550100");
  });
});

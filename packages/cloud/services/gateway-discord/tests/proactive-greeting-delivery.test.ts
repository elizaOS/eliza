/**
 * Proves lease/ack delivery of proactive greetings with deterministic mocks,
 * including auth, provider, malformed-entry, and acknowledgement failures.
 */
import { describe, expect, mock, test } from "bun:test";
import {
  drainAndDeliverGreetings,
  isKnownDiscordDirectMessageRejection,
  isTerminalDiscordDirectMessageError,
} from "../src/proactive-greeting-delivery";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function greeting(sessionId: string, overrides?: Record<string, unknown>) {
  return {
    sessionId,
    platformUserId: sessionId.split(":").at(-1),
    message: "you're all set",
    leaseId: `lease-${sessionId.split(":").at(-1)}`,
    deliveryNonce: `nonce-${sessionId.split(":").at(-1)}`,
    ...overrides,
  };
}

describe("drainAndDeliverGreetings", () => {
  test("delivers with the stable nonce and acknowledges the matching leases", async () => {
    const sent: Array<{ userId: string; content: string; nonce: string }> = [];
    const acknowledgements: unknown[] = [];
    const report = await drainAndDeliverGreetings({
      drain: async () =>
        jsonResponse({
          greetings: [
            greeting("platform:discord:111", {
              message: "Sam, you're all set",
            }),
            greeting("platform:discord:222"),
          ],
        }),
      acknowledge: async (entries) => {
        acknowledgements.push(...entries);
        return jsonResponse({ acknowledged: entries.length });
      },
      sendDirectMessage: async (userId, content, nonce) => {
        sent.push({ userId, content, nonce });
      },
    });

    expect(report).toEqual({
      claimed: 2,
      delivered: 2,
      malformed: 0,
      failed: 0,
      acknowledged: 2,
      retainedForRetry: 0,
      authRefreshed: false,
    });
    expect(sent).toEqual([
      {
        userId: "111",
        content: "Sam, you're all set",
        nonce: "nonce-111",
      },
      { userId: "222", content: "you're all set", nonce: "nonce-222" },
    ]);
    expect(acknowledgements).toEqual([
      { sessionId: "platform:discord:111", leaseId: "lease-111" },
      { sessionId: "platform:discord:222", leaseId: "lease-222" },
    ]);
  });

  test("401 refreshes auth and leaves entries unclaimed server-side", async () => {
    const refreshAuth = mock(async () => {});
    const sendDirectMessage = mock(async () => {});
    const acknowledge = mock(async () => jsonResponse({ acknowledged: 0 }));
    const report = await drainAndDeliverGreetings({
      drain: async () => jsonResponse({ error: "unauthorized" }, 401),
      acknowledge,
      sendDirectMessage,
      refreshAuth,
    });

    expect(report.authRefreshed).toBe(true);
    expect(report.claimed).toBe(0);
    expect(refreshAuth).toHaveBeenCalledTimes(1);
    expect(sendDirectMessage).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
  });

  test("non-OK drain reports the status and sends nothing", async () => {
    const events: Array<{ kind: string; status?: number }> = [];
    const report = await drainAndDeliverGreetings({
      drain: async () => jsonResponse({ error: "boom" }, 503),
      acknowledge: async () => {
        throw new Error("must not acknowledge");
      },
      sendDirectMessage: async () => {
        throw new Error("must not send");
      },
      onEvent: (event) =>
        events.push({ kind: event.kind, status: event.status }),
    });

    expect(report.claimed).toBe(0);
    expect(events).toEqual([{ kind: "drain-failed", status: 503 }]);
  });

  test("terminal DM failures are acknowledged while rate limits remain retryable", async () => {
    const acknowledged: Array<{ sessionId: string; leaseId: string }> = [];
    const report = await drainAndDeliverGreetings({
      drain: async () =>
        jsonResponse({
          greetings: [
            greeting("platform:discord:closed"),
            greeting("platform:discord:limited"),
            greeting("platform:discord:open"),
          ],
        }),
      acknowledge: async (entries) => {
        acknowledged.push(...entries);
        return jsonResponse({ acknowledged: entries.length });
      },
      sendDirectMessage: async (userId) => {
        if (userId === "closed") throw { code: 50007, status: 403 };
        if (userId === "limited") throw { status: 429 };
      },
      isTerminalError: isTerminalDiscordDirectMessageError,
    });

    expect(report).toMatchObject({
      delivered: 1,
      failed: 2,
      acknowledged: 2,
      retainedForRetry: 1,
    });
    expect(acknowledged).toEqual([
      { sessionId: "platform:discord:closed", leaseId: "lease-closed" },
      { sessionId: "platform:discord:open", leaseId: "lease-open" },
    ]);
  });

  test("network and 5xx failures retain their leases for recovery", async () => {
    const acknowledge = mock(async () => jsonResponse({ acknowledged: 0 }));
    const report = await drainAndDeliverGreetings({
      drain: async () =>
        jsonResponse({
          greetings: [
            greeting("platform:discord:network"),
            greeting("platform:discord:server"),
          ],
        }),
      acknowledge,
      sendDirectMessage: async (userId) => {
        if (userId === "network") throw new TypeError("fetch failed");
        throw { status: 503 };
      },
      isTerminalError: isTerminalDiscordDirectMessageError,
    });

    expect(report).toMatchObject({ failed: 2, retainedForRetry: 2 });
    expect(acknowledge).not.toHaveBeenCalled();
  });

  test("acknowledgement outage does not fabricate deletion", async () => {
    const events: Array<{ kind: string; status?: number }> = [];
    const report = await drainAndDeliverGreetings({
      drain: async () =>
        jsonResponse({ greetings: [greeting("platform:discord:ack-down")] }),
      acknowledge: async () => jsonResponse({ error: "down" }, 503),
      sendDirectMessage: async () => {},
      onEvent: (event) =>
        events.push({ kind: event.kind, status: event.status }),
    });

    expect(report.delivered).toBe(1);
    expect(report.acknowledged).toBe(0);
    expect(events).toContainEqual({ kind: "ack-failed", status: 503 });
  });

  test("401 acknowledgement refreshes auth and retries the same lease", async () => {
    const refreshAuth = mock(async () => {});
    let attempts = 0;
    const report = await drainAndDeliverGreetings({
      drain: async () =>
        jsonResponse({ greetings: [greeting("platform:discord:ack-auth")] }),
      acknowledge: async () => {
        attempts += 1;
        return attempts === 1
          ? jsonResponse({ error: "unauthorized" }, 401)
          : jsonResponse({ acknowledged: 1 });
      },
      sendDirectMessage: async () => {},
      refreshAuth,
    });

    expect(attempts).toBe(2);
    expect(refreshAuth).toHaveBeenCalledTimes(1);
    expect(report.acknowledged).toBe(1);
  });

  test("malformed leased entries are poison-acked without sending", async () => {
    const acknowledged: unknown[] = [];
    const sendDirectMessage = mock(async () => {});
    const report = await drainAndDeliverGreetings({
      drain: async () =>
        jsonResponse({
          greetings: [
            greeting("platform:discord:no-user", { platformUserId: "" }),
            greeting("platform:discord:no-message", { message: "   " }),
            { sessionId: "no-lease", platformUserId: "333", message: "hi" },
            "not-an-object",
            null,
          ],
        }),
      acknowledge: async (entries) => {
        acknowledged.push(...entries);
        return jsonResponse({ acknowledged: entries.length });
      },
      sendDirectMessage,
    });

    expect(report.malformed).toBe(3);
    expect(report.acknowledged).toBe(2);
    expect(sendDirectMessage).not.toHaveBeenCalled();
    expect(acknowledged).toHaveLength(2);
  });

  test("oversize greeting content is delivered as lossless ordered chunks", async () => {
    const delivered: string[] = [];
    const nonces: string[] = [];
    await drainAndDeliverGreetings({
      drain: async () =>
        jsonResponse({
          greetings: [
            greeting("platform:discord:long", { message: "x".repeat(2500) }),
          ],
        }),
      acknowledge: async () => jsonResponse({ acknowledged: 1 }),
      sendDirectMessage: async (_userId, content, nonce) => {
        delivered.push(content);
        nonces.push(nonce);
      },
    });
    expect(delivered.map((chunk) => chunk.length)).toEqual([2000, 500]);
    expect(delivered.join("")).toBe("x".repeat(2500));
    expect(new Set(nonces).size).toBe(2);
  });

  test("a body without a greetings array claims nothing", async () => {
    const sendDirectMessage = mock(async () => {});
    const report = await drainAndDeliverGreetings({
      drain: async () => jsonResponse({ unexpected: true }),
      acknowledge: async () => jsonResponse({ acknowledged: 0 }),
      sendDirectMessage,
    });
    expect(report.claimed).toBe(0);
    expect(sendDirectMessage).not.toHaveBeenCalled();
  });
});

describe("isTerminalDiscordDirectMessageError", () => {
  test("classifies only definitive recipient/request failures as terminal", () => {
    expect(isTerminalDiscordDirectMessageError({ code: 50007 })).toBe(true);
    expect(
      isTerminalDiscordDirectMessageError({ rawError: { code: 10013 } }),
    ).toBe(true);
    expect(isTerminalDiscordDirectMessageError({ status: 403 })).toBe(true);
    expect(isTerminalDiscordDirectMessageError({ status: 429 })).toBe(false);
    expect(isTerminalDiscordDirectMessageError({ status: 503 })).toBe(false);
    expect(isTerminalDiscordDirectMessageError(new TypeError("network"))).toBe(
      false,
    );
  });
});

describe("isKnownDiscordDirectMessageRejection", () => {
  test("separates explicit Discord rejection from acceptance ambiguity", () => {
    expect(
      isKnownDiscordDirectMessageRejection({ code: 50007, status: 403 }),
    ).toBe(true);
    expect(isKnownDiscordDirectMessageRejection({ status: 429 })).toBe(true);
    expect(isKnownDiscordDirectMessageRejection({ code: 0, status: 503 })).toBe(
      false,
    );
    expect(isKnownDiscordDirectMessageRejection({ status: 503 })).toBe(false);
    expect(isKnownDiscordDirectMessageRejection(new TypeError("network"))).toBe(
      false,
    );
  });
});

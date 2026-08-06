// Reproduces the proven dropped-turn-on-401 class (staging E2E 2026-08-05:
// "real bot DROPS a turn on 401, no retry in gateway message POST") and
// proves the retry model retains the turn.
import { describe, expect, test } from "bun:test";
import {
  isRetryableRouteStatus,
  postManagedAgentMessageWithRetry,
  sendReplyWithRetry,
} from "../src/managed-message-egress";

const noSleep = async () => {};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("postManagedAgentMessageWithRetry", () => {
  test("REGRESSION 401-drop: a single denylist 401 flake no longer consumes the turn", async () => {
    // Old behavior (pre-fix routeManagedAgentMessage): first !response.ok
    // returned immediately - the user's message vanished. New behavior:
    // the idempotent POST replays and the routed reply arrives.
    let calls = 0;
    const outcome = await postManagedAgentMessageWithRetry({
      doPost: async () => {
        calls += 1;
        if (calls === 1) {
          return new Response("authentication_required", { status: 401 });
        }
        return jsonResponse({ handled: true, replyText: "hey, I'm Eliza." });
      },
      sleep: noSleep,
    });

    expect(calls).toBe(2);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.routed).toEqual({
        handled: true,
        replyText: "hey, I'm Eliza.",
      });
      expect(outcome.attempts).toBe(2);
    }
  });

  test("refreshAuth runs before retrying a 401 so a rotated token applies", async () => {
    const order: string[] = [];
    let calls = 0;
    const outcome = await postManagedAgentMessageWithRetry({
      doPost: async () => {
        calls += 1;
        order.push(`post-${calls}`);
        if (calls === 1) return new Response("expired", { status: 401 });
        return jsonResponse({ handled: true, replyText: "ok" });
      },
      refreshAuth: async () => {
        order.push("refresh");
      },
      sleep: noSleep,
    });

    expect(outcome.ok).toBe(true);
    expect(order).toEqual(["post-1", "refresh", "post-2"]);
  });

  test("a refreshAuth throw does not abort the retry loop (denylist flake heals with the same token)", async () => {
    let calls = 0;
    const outcome = await postManagedAgentMessageWithRetry({
      doPost: async () => {
        calls += 1;
        if (calls === 1) return new Response("flake", { status: 401 });
        return jsonResponse({ handled: true });
      },
      refreshAuth: async () => {
        throw new Error("refresh endpoint down");
      },
      sleep: noSleep,
    });

    expect(outcome.ok).toBe(true);
    expect(calls).toBe(2);
  });

  test("network errors (thrown fetch) retry instead of dropping", async () => {
    let calls = 0;
    const failures: Array<{ attempt: number; status?: number }> = [];
    const outcome = await postManagedAgentMessageWithRetry({
      doPost: async () => {
        calls += 1;
        if (calls < 3) throw new Error("socket hang up");
        return jsonResponse({ handled: true, replyText: "made it" });
      },
      onAttemptFailure: (info) =>
        failures.push({ attempt: info.attempt, status: info.status }),
      sleep: noSleep,
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.attempts).toBe(3);
    expect(failures).toEqual([
      { attempt: 1, status: undefined },
      { attempt: 2, status: undefined },
    ]);
  });

  test("5xx retries; exhausted attempts report a loud final failure (never a silent early return)", async () => {
    let calls = 0;
    const outcome = await postManagedAgentMessageWithRetry({
      doPost: async () => {
        calls += 1;
        return new Response("upstream sad", { status: 503 });
      },
      maxAttempts: 3,
      sleep: noSleep,
    });

    expect(calls).toBe(3);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.attempts).toBe(3);
      expect(outcome.status).toBe(503);
      expect(outcome.error).toContain("upstream sad");
    }
  });

  test("BIDIRECTIONAL: deterministic client errors (403) fail immediately - replay cannot heal them", async () => {
    let calls = 0;
    const outcome = await postManagedAgentMessageWithRetry({
      doPost: async () => {
        calls += 1;
        return new Response("forbidden", { status: 403 });
      },
      sleep: noSleep,
    });

    expect(calls).toBe(1);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(403);
  });

  test("first-attempt success does not sleep or refresh", async () => {
    let slept = false;
    let refreshed = false;
    const outcome = await postManagedAgentMessageWithRetry({
      doPost: async () =>
        jsonResponse({ handled: false, reason: "not_linked" }),
      refreshAuth: async () => {
        refreshed = true;
      },
      sleep: async () => {
        slept = true;
      },
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.attempts).toBe(1);
    expect(slept).toBe(false);
    expect(refreshed).toBe(false);
  });
});

describe("isRetryableRouteStatus", () => {
  test("classifies the internal-route failure modes", () => {
    expect(isRetryableRouteStatus(401)).toBe(true); // fail-closed denylist flake
    expect(isRetryableRouteStatus(408)).toBe(true);
    expect(isRetryableRouteStatus(429)).toBe(true);
    expect(isRetryableRouteStatus(500)).toBe(true);
    expect(isRetryableRouteStatus(503)).toBe(true);
    expect(isRetryableRouteStatus(400)).toBe(false);
    expect(isRetryableRouteStatus(403)).toBe(false);
    expect(isRetryableRouteStatus(404)).toBe(false);
  });
});

describe("sendReplyWithRetry", () => {
  test("a transient Discord send failure retries and delivers", async () => {
    let calls = 0;
    const result = await sendReplyWithRetry(
      async () => {
        calls += 1;
        if (calls === 1) {
          const err = new Error("Internal Server Error") as Error & {
            status: number;
          };
          err.status = 500;
          throw err;
        }
      },
      { sleep: noSleep },
    );

    expect(result.sent).toBe(true);
    expect(result.attempts).toBe(2);
  });

  test("BIDIRECTIONAL: a deterministic Discord 4xx (cannot DM user) fails on the first attempt", async () => {
    let calls = 0;
    const result = await sendReplyWithRetry(
      async () => {
        calls += 1;
        const err = new Error("Cannot send messages to this user") as Error & {
          status: number;
        };
        err.status = 403;
        throw err;
      },
      { sleep: noSleep },
    );

    expect(calls).toBe(1);
    expect(result.sent).toBe(false);
    expect(result.error).toContain("Cannot send messages to this user");
  });

  test("exhausted transient retries surface the failure instead of throwing", async () => {
    let calls = 0;
    const result = await sendReplyWithRetry(
      async () => {
        calls += 1;
        throw new Error("ECONNRESET");
      },
      { maxAttempts: 3, sleep: noSleep },
    );

    expect(calls).toBe(3);
    expect(result.sent).toBe(false);
    expect(result.attempts).toBe(3);
    expect(result.error).toBe("ECONNRESET");
  });
});

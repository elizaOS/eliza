/**
 * Exercises managed Discord route retries and bounded reply delivery with
 * deterministic transport failures, including dropped-turn regressions.
 */
import { describe, expect, test } from "bun:test";
import {
  deliverManagedReply,
  isRetryableRouteStatus,
  postManagedAgentMessageWithRetry,
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
    const failures: string[] = [];
    const outcome = await postManagedAgentMessageWithRetry({
      doPost: async () => {
        calls += 1;
        if (calls === 1) return new Response("flake", { status: 401 });
        return jsonResponse({ handled: true });
      },
      refreshAuth: async () => {
        throw new Error("refresh endpoint down");
      },
      onAttemptFailure: ({ error }) => failures.push(error),
      sleep: noSleep,
    });

    expect(outcome.ok).toBe(true);
    expect(calls).toBe(2);
    expect(failures).toEqual([
      "flake",
      "auth refresh failed: refresh endpoint down",
    ]);
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

  test("a malformed 2xx reply retries instead of returning fabricated success", async () => {
    let calls = 0;
    const failures: string[] = [];
    const outcome = await postManagedAgentMessageWithRetry({
      doPost: async () => {
        calls += 1;
        if (calls === 1) return new Response("not-json", { status: 200 });
        return jsonResponse({ handled: true, replyText: "recovered" });
      },
      onAttemptFailure: ({ error }) => failures.push(error),
      sleep: noSleep,
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.attempts).toBe(2);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("invalid managed route response");
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

  test("a failed error-body read preserves the HTTP status and exposes the diagnostic failure", async () => {
    const outcome = await postManagedAgentMessageWithRetry({
      doPost: async () =>
        ({
          ok: false,
          status: 503,
          statusText: "Service Unavailable",
          text: async () => {
            throw new Error("body stream locked");
          },
        }) as Response,
      maxAttempts: 1,
      sleep: noSleep,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe(503);
      expect(outcome.error).toContain("unable to read error body");
      expect(outcome.error).toContain("body stream locked");
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

describe("deliverManagedReply", () => {
  test("delivers the primary reply without invoking the fallback", async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const result = await deliverManagedReply({
      sendReply: async () => {
        primaryCalls += 1;
        return "delivered";
      },
      sendFailureNotice: async () => {
        fallbackCalls += 1;
        return "delivered";
      },
    });

    expect(result).toEqual({ state: "reply" });
    expect(primaryCalls).toBe(1);
    expect(fallbackCalls).toBe(0);
  });

  test("a route failure with no primary reply sends one visible notice", async () => {
    let fallbackCalls = 0;
    const result = await deliverManagedReply({
      sendFailureNotice: async () => {
        fallbackCalls += 1;
        return "delivered";
      },
    });

    expect(result).toEqual({ state: "failure_notice" });
    expect(fallbackCalls).toBe(1);
  });

  test("an ambiguous primary failure is confirmed once with the same nonce", async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const result = await deliverManagedReply({
      sendReply: async () => {
        primaryCalls += 1;
        if (primaryCalls === 1) {
          throw new Error("socket closed after request write");
        }
        return "delivered";
      },
      sendFailureNotice: async () => {
        fallbackCalls += 1;
        return "delivered";
      },
    });

    expect(result).toEqual({ state: "reply" });
    expect(primaryCalls).toBe(2);
    expect(fallbackCalls).toBe(0);
  });

  test("two ambiguous primary failures make one bounded fallback attempt", async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const result = await deliverManagedReply({
      sendReply: async () => {
        primaryCalls += 1;
        throw new Error(`ambiguous-${primaryCalls}`);
      },
      sendFailureNotice: async () => {
        fallbackCalls += 1;
        return "delivered";
      },
    });

    expect(result).toEqual({
      state: "failure_notice",
      primaryError: "ambiguous-2",
    });
    expect(primaryCalls).toBe(2);
    expect(fallbackCalls).toBe(1);
  });

  test("a deterministic 4xx is not retried and a failed fallback does not recurse", async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const result = await deliverManagedReply({
      sendReply: async () => {
        primaryCalls += 1;
        const error = new Error(
          "Cannot send messages to this user",
        ) as Error & {
          status: number;
        };
        error.status = 403;
        throw error;
      },
      sendFailureNotice: async () => {
        fallbackCalls += 1;
        throw new Error("Cannot send messages to this user");
      },
    });

    expect(result).toEqual({
      state: "undeliverable",
      primaryError: "Cannot send messages to this user",
      failureNoticeError: "Cannot send messages to this user",
    });
    expect(primaryCalls).toBe(1);
    expect(fallbackCalls).toBe(1);
  });

  test("a mismatched nonce receipt is reported without sending a fallback", async () => {
    let fallbackCalls = 0;
    const result = await deliverManagedReply({
      sendReply: async () => "deduplicated",
      sendFailureNotice: async () => {
        fallbackCalls += 1;
        return "delivered";
      },
    });

    expect(result).toEqual({ state: "deduplicated", attempted: "reply" });
    expect(fallbackCalls).toBe(0);
  });

  test("a mismatched fallback receipt retains the primary failure context", async () => {
    const result = await deliverManagedReply({
      sendReply: async () => {
        const error = new Error("forbidden") as Error & { status: number };
        error.status = 403;
        throw error;
      },
      sendFailureNotice: async () => "deduplicated",
    });

    expect(result).toEqual({
      state: "deduplicated",
      attempted: "failure_notice",
      primaryError: "forbidden",
    });
  });
});

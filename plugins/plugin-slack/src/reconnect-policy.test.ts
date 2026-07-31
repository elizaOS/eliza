/**
 * Reconnect policy + liveness proof.
 *
 * The behaviour that matters: a revoked token must STOP the reconnect loop,
 * and a network blip must not. On unfixed develop neither distinction exists —
 * bolt retries everything forever — so the auth-bail tests below have no
 * counterpart to pass against.
 */
import { describe, expect, it } from "vitest";
import {
  computeSlackBackoffMs,
  decideSlackReconnect,
  formatSlackError,
  isNonRecoverableSlackAuthError,
  SLACK_SOCKET_RECONNECT_POLICY,
  SlackLivenessTracker,
} from "./reconnect-policy";

describe("isNonRecoverableSlackAuthError", () => {
  it.each([
    "invalid_auth",
    "token_revoked",
    "token_expired",
    "account_inactive",
    "missing_scope",
    "not_authed",
    "org_login_required",
    "app_uninstalled",
  ])("treats %s as permanent", (code) => {
    expect(isNonRecoverableSlackAuthError(new Error(code))).toBe(true);
  });

  it.each([
    "ECONNRESET",
    "socket hang up",
    "getaddrinfo ENOTFOUND slack.com",
    "ratelimited",
    "server_error",
  ])("treats %s as recoverable", (msg) => {
    expect(isNonRecoverableSlackAuthError(new Error(msg))).toBe(false);
  });

  it("reads the structured Slack error code off a WebAPI error", () => {
    const err = Object.assign(new Error("An API error occurred"), {
      data: { error: "token_revoked" },
    });
    expect(isNonRecoverableSlackAuthError(err)).toBe(true);
  });

  it("does not misfire on an unrelated message containing a substring", () => {
    // Word-boundary anchored: "reinvalid_authorization" is not invalid_auth.
    expect(
      isNonRecoverableSlackAuthError(new Error("reinvalid_authorization")),
    ).toBe(false);
  });
});

describe("computeSlackBackoffMs", () => {
  it("grows exponentially from the initial delay", () => {
    const zeroJitter = () => 0;
    expect(
      computeSlackBackoffMs(SLACK_SOCKET_RECONNECT_POLICY, 1, zeroJitter),
    ).toBe(2_000);
    expect(
      computeSlackBackoffMs(SLACK_SOCKET_RECONNECT_POLICY, 2, zeroJitter),
    ).toBe(3_600);
    expect(
      computeSlackBackoffMs(SLACK_SOCKET_RECONNECT_POLICY, 3, zeroJitter),
    ).toBe(6_480);
  });

  it("clamps at maxMs no matter how many attempts", () => {
    expect(
      computeSlackBackoffMs(SLACK_SOCKET_RECONNECT_POLICY, 50, () => 1),
    ).toBe(SLACK_SOCKET_RECONNECT_POLICY.maxMs);
  });

  it("adds jitter so a fleet does not reconnect in lockstep", () => {
    const low = computeSlackBackoffMs(
      SLACK_SOCKET_RECONNECT_POLICY,
      2,
      () => 0,
    );
    const high = computeSlackBackoffMs(
      SLACK_SOCKET_RECONNECT_POLICY,
      2,
      () => 1,
    );
    expect(high).toBeGreaterThan(low);
    expect(high).toBeLessThanOrEqual(
      low * (1 + SLACK_SOCKET_RECONNECT_POLICY.jitter),
    );
  });
});

describe("decideSlackReconnect", () => {
  it("retries a transient network error with backoff", () => {
    const decision = decideSlackReconnect({
      error: new Error("ECONNRESET"),
      attempt: 1,
      random: () => 0,
    });
    expect(decision).toEqual({ action: "retry", attempt: 1, delayMs: 2_000 });
  });

  it("aborts immediately on a revoked token, at attempt 1", () => {
    // The infinite-churn bug: on develop this reconnects forever against a
    // credential that can never authenticate.
    const decision = decideSlackReconnect({
      error: new Error("token_revoked"),
      attempt: 1,
    });
    expect(decision.action).toBe("abort");
    expect(decision).toMatchObject({ reason: "auth" });
    expect(decision.action === "abort" && decision.message).toMatch(
      /not reconnecting/i,
    );
  });

  it("reports auth before exhaustion, so the operator is pointed at the token", () => {
    const decision = decideSlackReconnect({
      error: new Error("missing_scope"),
      attempt: SLACK_SOCKET_RECONNECT_POLICY.maxAttempts + 5,
    });
    expect(decision).toMatchObject({ action: "abort", reason: "auth" });
  });

  it("gives up on a recoverable error once attempts are exhausted", () => {
    const decision = decideSlackReconnect({
      error: new Error("ECONNRESET"),
      attempt: SLACK_SOCKET_RECONNECT_POLICY.maxAttempts,
    });
    expect(decision).toMatchObject({ action: "abort", reason: "exhausted" });
  });

  it("keeps retrying forever when maxAttempts is 0", () => {
    const decision = decideSlackReconnect({
      error: new Error("ECONNRESET"),
      attempt: 9_999,
      policy: { ...SLACK_SOCKET_RECONNECT_POLICY, maxAttempts: 0 },
      random: () => 0,
    });
    expect(decision.action).toBe("retry");
  });
});

describe("formatSlackError", () => {
  it("surfaces the Slack error code alongside the message", () => {
    const err = Object.assign(new Error("An API error occurred"), {
      data: { error: "invalid_auth" },
    });
    expect(formatSlackError(err)).toBe("An API error occurred (invalid_auth)");
  });

  it("handles strings, bare objects, and junk", () => {
    expect(formatSlackError("boom")).toBe("boom");
    expect(formatSlackError({ error: "token_revoked" })).toBe("token_revoked");
    expect(formatSlackError(undefined)).toBe("unknown error");
  });
});

describe("SlackLivenessTracker", () => {
  it("starts as connecting with no event clock", () => {
    const t = new SlackLivenessTracker();
    const snap = t.snapshot();
    expect(snap.healthState).toBe("connecting");
    expect(snap.lastEventAt).toBeNull();
  });

  it("does not seed lastEventAt on connect", () => {
    // Seeding here would mask exactly the wedged-socket case this exists to
    // catch: connected is not the same as delivering.
    const t = new SlackLivenessTracker();
    t.markConnected();
    expect(t.snapshot().lastEventAt).toBeNull();
    expect(t.snapshot().healthState).toBe("healthy");
  });

  it("reports degraded when a connected socket goes silent past the window", () => {
    let now = 1_000;
    const t = new SlackLivenessTracker({ stalenessMs: 1_000, now: () => now });
    t.markConnected();
    t.markEvent();
    expect(t.snapshot().healthState).toBe("healthy");
    now = 2_500;
    expect(t.snapshot().healthState).toBe("degraded");
  });

  it("returns to healthy once traffic resumes", () => {
    let now = 1_000;
    const t = new SlackLivenessTracker({ stalenessMs: 1_000, now: () => now });
    t.markConnected();
    t.markEvent();
    now = 2_500;
    expect(t.snapshot().healthState).toBe("degraded");
    t.markEvent();
    expect(t.snapshot().healthState).toBe("healthy");
  });

  it("reports disconnected after a drop, and failed after a permanent bail", () => {
    const t = new SlackLivenessTracker();
    t.markConnected();
    t.markDisconnected(new Error("ECONNRESET"));
    expect(t.snapshot()).toMatchObject({
      connected: false,
      healthState: "disconnected",
      lastError: "ECONNRESET",
    });

    t.markPermanentFailure("token_revoked; not reconnecting");
    const snap = t.snapshot();
    expect(snap.healthState).toBe("failed");
    expect(snap.permanentFailure).toMatch(/token_revoked/);
  });

  it("clears a permanent failure when a later connect succeeds", () => {
    const t = new SlackLivenessTracker();
    t.markPermanentFailure("token_revoked");
    expect(t.snapshot().healthState).toBe("failed");
    t.markConnected();
    expect(t.snapshot().healthState).toBe("healthy");
    expect(t.snapshot().permanentFailure).toBeNull();
  });

  it("tracks reconnect attempts and resets them on a successful connect", () => {
    const t = new SlackLivenessTracker();
    t.markReconnectAttempt(4);
    expect(t.snapshot().reconnectAttempts).toBe(4);
    t.markConnected();
    expect(t.snapshot().reconnectAttempts).toBe(0);
  });
});

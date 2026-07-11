/**
 * Unit tests for the provider usage probes in `account-usage.ts`.
 *
 * Gap (D): `account-usage.ts` shipped with no unit coverage. The probes parse
 * provider responses in two distinct shapes (legacy flat vs. new nested) and
 * funnel them through two internal normalizers — `utilizationToPct` (0..1 ->
 * percent, clamped to 0..100) and `normalizeResetTimestamp` (epoch seconds vs.
 * milliseconds vs. ISO string). Those normalizers are NOT exported, so we
 * exercise them through the only public surface that touches them:
 * `pollAnthropicUsage` and `pollCodexUsage`. Both probes default their
 * `fetchImpl` argument to the global `fetch`, so we mock the network with
 * `vi.stubGlobal("fetch", ...)` — no live calls, fully deterministic.
 *
 * What these tests would catch as a regression:
 *  - dropping support for either the flat or nested Anthropic shape;
 *  - forgetting to multiply Anthropic utilization by 100 (it ships 0..1);
 *  - failing to clamp utilization into [0, 100];
 *  - mishandling NaN / non-number / missing utilization;
 *  - treating epoch-seconds reset timestamps as already-milliseconds (or vice
 *    versa) and not parsing ISO-string resets;
 *  - not throwing (with the HTTP status) on a non-ok response.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { pollAnthropicUsage, pollCodexUsage } from "./account-usage";

/** Build a minimal Response-like object the probes consume (ok + json()). */
function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }) {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
  } as unknown as Response;
}

/**
 * Stub the global fetch with a single captured handler so we can both assert
 * the response parsing AND inspect the request (url + headers) the probe made.
 */
function stubFetch(response: Response) {
  const fetchMock = vi.fn(async () => response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("pollAnthropicUsage", () => {
  it("parses the legacy FLAT response shape (utilization is 0..1, multiplied to percent)", async () => {
    const fetchMock = stubFetch(
      jsonResponse({
        five_hour_utilization: 0.42,
        five_hour_resets_at: "2026-06-22T12:00:00.000Z",
        seven_day_utilization: 0.1,
      }),
    );

    const snap = await pollAnthropicUsage("flat-token");

    // 0.42 * 100 -> 42
    expect(snap.sessionPct).toBe(42);
    expect(snap.weeklyPct).toBeCloseTo(10, 10);
    expect(snap.resetsAt).toBe(Date.parse("2026-06-22T12:00:00.000Z"));
    expect(typeof snap.refreshedAt).toBe("number");

    // Probe hit the right endpoint with the OAuth bearer + beta header.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.anthropic.com/api/oauth/usage");
    const headers = opts.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer flat-token");
    expect(headers["anthropic-beta"]).toBe("oauth-2025-04-20");
  });

  it("parses the NESTED response shape (five_hour.utilization / resets_at)", async () => {
    stubFetch(
      jsonResponse({
        five_hour: { utilization: 0.5, resets_at: 1_700_000_000 },
        seven_day: { utilization: 0.25 },
      }),
    );

    const snap = await pollAnthropicUsage("nested-token");

    expect(snap.sessionPct).toBe(50);
    expect(snap.weeklyPct).toBe(25);
    // resets_at given in epoch SECONDS -> normalized to ms (* 1000).
    expect(snap.resetsAt).toBe(1_700_000_000 * 1000);
  });

  it("prefers the nested utilization over the flat field when both are present", async () => {
    stubFetch(
      jsonResponse({
        five_hour: { utilization: 0.9 },
        five_hour_utilization: 0.1,
        seven_day: { utilization: 0.8 },
        seven_day_utilization: 0.2,
      }),
    );

    const snap = await pollAnthropicUsage("both-token");

    expect(snap.sessionPct).toBe(90);
    expect(snap.weeklyPct).toBe(80);
  });

  it("preserves utilization already expressed as a 0..100 percentage", async () => {
    stubFetch(jsonResponse({ five_hour_utilization: 5 }));

    const snap = await pollAnthropicUsage("over-token");

    expect(snap.sessionPct).toBe(5);
  });

  it("clamps percentage utilization above 100", async () => {
    stubFetch(jsonResponse({ five_hour_utilization: 150 }));

    const snap = await pollAnthropicUsage("over-token");

    expect(snap.sessionPct).toBe(100);
  });

  it("maps 0 utilization to 0 percent (not dropped)", async () => {
    stubFetch(jsonResponse({ five_hour_utilization: 0 }));

    const snap = await pollAnthropicUsage("zero-token");

    expect(snap.sessionPct).toBe(0);
  });

  it("omits pct fields when utilization is missing / non-numeric / NaN", async () => {
    stubFetch(
      jsonResponse({
        five_hour_utilization: "not-a-number",
        seven_day_utilization: Number.NaN,
        // resets_at omitted entirely
      }),
    );

    const snap = await pollAnthropicUsage("missing-token");

    expect(snap.sessionPct).toBeUndefined();
    expect(snap.weeklyPct).toBeUndefined();
    expect(snap.resetsAt).toBeUndefined();
    // refreshedAt is always stamped even when everything else is absent.
    expect(typeof snap.refreshedAt).toBe("number");
  });

  it("passes through an epoch-MILLISECONDS reset timestamp unchanged", async () => {
    const ms = 1_700_000_000_000; // already > 1e12
    stubFetch(jsonResponse({ five_hour: { resets_at: ms } }));

    const snap = await pollAnthropicUsage("ms-token");

    expect(snap.resetsAt).toBe(ms);
  });

  it("returns undefined resetsAt for an unparseable reset string", async () => {
    stubFetch(jsonResponse({ five_hour: { resets_at: "not-a-date" } }));

    const snap = await pollAnthropicUsage("baddate-token");

    expect(snap.resetsAt).toBeUndefined();
  });

  it("stamps refreshedAt from the system clock", async () => {
    const fixed = 1_750_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(fixed);
    stubFetch(jsonResponse({ five_hour_utilization: 0.3 }));

    const snap = await pollAnthropicUsage("clock-token");

    expect(snap.refreshedAt).toBe(fixed);
  });

  it("throws with the HTTP status when the response is not ok", async () => {
    stubFetch(jsonResponse({}, { ok: false, status: 429 }));

    await expect(pollAnthropicUsage("rl-token")).rejects.toThrow(/429/);
  });
});

describe("pollCodexUsage", () => {
  it("parses the rate_limit.primary_window shape (used_percent already 0..100)", async () => {
    const fetchMock = stubFetch(
      jsonResponse({
        plan_type: "plus",
        rate_limit: {
          primary_window: {
            used_percent: 73,
            reset_at: 1_700_000_000, // epoch seconds
            limit_window_seconds: 18000,
          },
        },
      }),
    );

    const snap = await pollCodexUsage("codex-token", "acct-123");

    // used_percent is NOT multiplied (already a percent), just clamped.
    expect(snap.sessionPct).toBe(73);
    // reset_at in seconds -> normalized to ms.
    expect(snap.resetsAt).toBe(1_700_000_000 * 1000);
    // Codex has no weekly window.
    expect(snap.weeklyPct).toBeUndefined();
    expect(typeof snap.refreshedAt).toBe("number");

    // Probe hit the right endpoint with the account id + UA headers.
    const [url, opts] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://chatgpt.com/backend-api/wham/usage");
    const headers = opts.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer codex-token");
    expect(headers["ChatGPT-Account-Id"]).toBe("acct-123");
    expect(headers["User-Agent"]).toBe("codex-cli");
  });

  it("clamps used_percent above 100 down to 100 and 0 stays 0", async () => {
    stubFetch(
      jsonResponse({
        rate_limit: { primary_window: { used_percent: 150 } },
      }),
    );
    const high = await pollCodexUsage("t", "a");
    expect(high.sessionPct).toBe(100);

    stubFetch(
      jsonResponse({
        rate_limit: { primary_window: { used_percent: 0 } },
      }),
    );
    const zero = await pollCodexUsage("t", "a");
    expect(zero.sessionPct).toBe(0);
  });

  it("omits sessionPct/resetsAt when the primary_window is absent", async () => {
    stubFetch(jsonResponse({ plan_type: "free", rate_limit: {} }));

    const snap = await pollCodexUsage("t", "a");

    expect(snap.sessionPct).toBeUndefined();
    expect(snap.resetsAt).toBeUndefined();
    expect(typeof snap.refreshedAt).toBe("number");
  });

  it("omits sessionPct when used_percent is NaN/non-numeric but still parses resets", async () => {
    stubFetch(
      jsonResponse({
        rate_limit: {
          primary_window: {
            used_percent: Number.NaN,
            reset_at: "2026-06-22T00:00:00.000Z",
          },
        },
      }),
    );

    const snap = await pollCodexUsage("t", "a");

    expect(snap.sessionPct).toBeUndefined();
    expect(snap.resetsAt).toBe(Date.parse("2026-06-22T00:00:00.000Z"));
  });

  it("throws with the HTTP status when the response is not ok", async () => {
    stubFetch(jsonResponse({}, { ok: false, status: 401 }));

    await expect(pollCodexUsage("t", "a")).rejects.toThrow(/401/);
  });
});

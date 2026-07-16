/**
 * Unit tests for the canonical Codex usage client. Fully deterministic —
 * fetch is injected; every failure mode Shaw's error policy demands is
 * covered both ways (typed throw on failure, validated parse on success).
 */
import { ElizaError } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { fetchCodexUsage } from "./codex-usage.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fetchReturning(response: Response | (() => Response)): typeof fetch {
  return (async () =>
    typeof response === "function" ? response() : response) as typeof fetch;
}

const VALID_PAYLOAD = {
  plan_type: "pro",
  email: "user@example.com",
  rate_limit: {
    primary_window: {
      used_percent: 88,
      reset_at: 1_783_812_204, // epoch seconds
      limit_window_seconds: 18000,
    },
    secondary_window: {
      used_percent: 25,
      reset_at: 1_784_357_126,
      limit_window_seconds: 604800,
    },
  },
};

describe("fetchCodexUsage — success parsing", () => {
  it("parses both windows, plan, and email; normalizes epoch-seconds reset", async () => {
    const usage = await fetchCodexUsage(
      "tok",
      "acct-1",
      fetchReturning(jsonResponse(VALID_PAYLOAD)),
    );
    expect(usage).toEqual({
      sessionPct: 88,
      weeklyPct: 25,
      resetsAt: 1_783_812_204 * 1000,
      planType: "pro",
      email: "user@example.com",
    });
  });

  it("passes through an epoch-milliseconds reset unchanged and parses ISO strings", async () => {
    const ms = 1_784_000_000_000;
    const withMs = await fetchCodexUsage(
      "tok",
      "a",
      fetchReturning(
        jsonResponse({ rate_limit: { primary_window: { reset_at: ms } } }),
      ),
    );
    expect(withMs.resetsAt).toBe(ms);

    const iso = "2026-07-12T00:00:00.000Z";
    const withIso = await fetchCodexUsage(
      "tok",
      "a",
      fetchReturning(
        jsonResponse({ rate_limit: { primary_window: { reset_at: iso } } }),
      ),
    );
    expect(withIso.resetsAt).toBe(Date.parse(iso));
  });

  it("clamps percents into 0..100 and drops non-numeric ones", async () => {
    const usage = await fetchCodexUsage(
      "tok",
      "a",
      fetchReturning(
        jsonResponse({
          rate_limit: {
            primary_window: { used_percent: 150 },
            secondary_window: { used_percent: "not-a-number" },
          },
        }),
      ),
    );
    expect(usage.sessionPct).toBe(100);
    expect(usage.weeklyPct).toBeUndefined();
  });

  it("treats a valid payload with missing windows as legitimately empty (no throw)", async () => {
    const usage = await fetchCodexUsage(
      "tok",
      "a",
      fetchReturning(jsonResponse({ plan_type: "plus" })),
    );
    expect(usage).toEqual({ planType: "plus" });
  });

  it.each([
    [
      "primary",
      { primary_window: null, secondary_window: { used_percent: 25 } },
    ],
    [
      "secondary",
      { primary_window: { used_percent: 88 }, secondary_window: null },
    ],
  ])("treats a null %s window exactly like an absent optional window", async (name, rateLimit) => {
    const usage = await fetchCodexUsage(
      "tok",
      "a",
      fetchReturning(jsonResponse({ rate_limit: rateLimit })),
    );
    expect(usage).toEqual(
      name === "primary" ? { weeklyPct: 25 } : { sessionPct: 88 },
    );
  });

  it("sends bearer + account id + codex-cli UA; omits the account header when absent", async () => {
    const seen: Array<Record<string, string>> = [];
    const spy = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push({ ...(init?.headers as Record<string, string>) });
      return jsonResponse(VALID_PAYLOAD);
    }) as typeof fetch;
    await fetchCodexUsage("secret", "acct-9", spy);
    await fetchCodexUsage("secret", undefined, spy);
    expect(seen[0]?.Authorization).toBe("Bearer secret");
    expect(seen[0]?.["ChatGPT-Account-Id"]).toBe("acct-9");
    expect(seen[0]?.["User-Agent"]).toBe("codex-cli");
    expect(seen[1]).not.toHaveProperty("ChatGPT-Account-Id");
  });
});

describe("fetchCodexUsage — typed failures (never fabricated data)", () => {
  it.each([
    [401],
    [429],
    [503],
  ])("throws a typed http_error carrying status %s in context and message", async (status) => {
    const err = await fetchCodexUsage(
      "tok",
      "a",
      fetchReturning(new Response("denied", { status })),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ElizaError);
    const typed = err as ElizaError;
    expect(typed.code).toBe("codex_usage.http_error");
    expect(typed.context?.status).toBe(status);
    // Callers (rate-limit regexes, dashboards) read the status from the message.
    expect(typed.message).toContain(String(status));
  });

  it("throws a typed request_failed on transport errors, preserving the cause", async () => {
    const boom = new TypeError("network down");
    const err = await fetchCodexUsage("tok", "a", (async () => {
      throw boom;
    }) as typeof fetch).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ElizaError);
    expect((err as ElizaError).code).toBe("codex_usage.request_failed");
    expect((err as ElizaError).cause).toBe(boom);
  });

  it("throws a typed request_failed on timeout aborts", async () => {
    const abort = new DOMException("aborted", "TimeoutError");
    const err = await fetchCodexUsage("tok", "a", (async () => {
      throw abort;
    }) as typeof fetch).catch((e: unknown) => e);
    expect((err as ElizaError).code).toBe("codex_usage.request_failed");
  });

  it("throws a typed invalid_json when the body is not JSON", async () => {
    const err = await fetchCodexUsage(
      "tok",
      "a",
      fetchReturning(new Response("<html>cloudflare</html>", { status: 200 })),
    ).catch((e: unknown) => e);
    expect((err as ElizaError).code).toBe("codex_usage.invalid_json");
  });

  it.each([
    ["null body", "null"],
    ["array body", "[1,2]"],
    ["non-object rate_limit", '{"rate_limit": 5}'],
    ["non-object primary window", '{"rate_limit":{"primary_window": 7}}'],
    ["string primary window", '{"rate_limit":{"primary_window":"none"}}'],
    ["array primary window", '{"rate_limit":{"primary_window":[]}}'],
    ["non-object secondary window", '{"rate_limit":{"secondary_window": []}}'],
    ["string secondary window", '{"rate_limit":{"secondary_window":"none"}}'],
  ])("throws a typed invalid_shape for %s", async (_name, body) => {
    const err = await fetchCodexUsage(
      "tok",
      "a",
      fetchReturning(
        new Response(body, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ElizaError);
    expect((err as ElizaError).code).toBe("codex_usage.invalid_shape");
  });
});

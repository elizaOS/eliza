import { afterEach, describe, expect, it, vi } from "vitest";
import { pollMoonshotUsage, pollZaiUsage } from "./account-usage";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("pollZaiUsage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports usage-unavailable without hitting the network (no documented endpoint)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const before = Date.now();
    const snapshot = await pollZaiUsage("zai-token");

    // z.ai has no usage/quota endpoint — the probe must not invent one.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(snapshot.sessionPct).toBeUndefined();
    expect(snapshot.weeklyPct).toBeUndefined();
    expect(snapshot.resetsAt).toBeUndefined();
    expect(snapshot.refreshedAt).toBeGreaterThanOrEqual(before);
  });

  it("ignores an injected fetch impl too (still no network call)", async () => {
    const injected = vi.fn();
    const snapshot = await pollZaiUsage(
      "zai-token",
      injected as unknown as typeof fetch,
    );
    expect(injected).not.toHaveBeenCalled();
    expect(snapshot.sessionPct).toBeUndefined();
  });
});

describe("pollMoonshotUsage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("validates a funded credential and reports usage-unavailable (no percentage exists)", async () => {
    const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.moonshot.ai/v1/users/me/balance");
      expect(init?.method).toBe("GET");
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        "Bearer moonshot-token",
      );
      return jsonResponse({
        code: 0,
        scode: "0x0",
        status: true,
        data: {
          available_balance: 49.58894,
          voucher_balance: 46.58893,
          cash_balance: 3.00001,
        },
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const before = Date.now();
    const snapshot = await pollMoonshotUsage("moonshot-token");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // Pay-as-you-go wallet: there is no session/weekly utilization to report.
    expect(snapshot.sessionPct).toBeUndefined();
    expect(snapshot.weeklyPct).toBeUndefined();
    expect(snapshot.refreshedAt).toBeGreaterThanOrEqual(before);
  });

  it("uses the injected fetch impl when provided", async () => {
    const injected = vi.fn(async () =>
      jsonResponse({ data: { available_balance: 10 } }),
    );
    const snapshot = await pollMoonshotUsage(
      "moonshot-token",
      injected as unknown as typeof fetch,
    );
    expect(injected).toHaveBeenCalledTimes(1);
    expect(snapshot.sessionPct).toBeUndefined();
  });

  it("throws a quota-shaped error when the wallet is depleted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: { available_balance: 0 } })),
    );
    await expect(pollMoonshotUsage("moonshot-token")).rejects.toThrow(
      /quota exhausted/i,
    );
  });

  it("throws with the HTTP status on an unauthorized credential", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "unauthorized" }, 401)),
    );
    await expect(pollMoonshotUsage("bad-token")).rejects.toThrow(/HTTP 401/);
  });

  it("throws with the HTTP status on a rate-limited credential", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "rate limited" }, 429)),
    );
    await expect(pollMoonshotUsage("token")).rejects.toThrow(/HTTP 429/);
  });
});

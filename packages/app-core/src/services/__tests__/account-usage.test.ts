/**
 * Tests for account-usage.ts — provider probes + JSONL counters.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  pollAnthropicUsage,
  pollCodexUsage,
  readTodayCounters,
  recordCall,
} from "../account-usage";

interface MockResponseInit {
  ok?: boolean;
  status?: number;
  body: unknown;
}

function jsonResponse(init: MockResponseInit): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => init.body,
  } as unknown as Response;
}

describe("pollAnthropicUsage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("handles new nested response shape (utilization 0..1, ISO resets_at)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        body: {
          five_hour: {
            utilization: 0.72,
            resets_at: "2030-01-01T00:00:00Z",
          },
          seven_day: {
            utilization: 0.31,
            resets_at: "2030-01-08T00:00:00Z",
          },
        },
      }),
    );
    const snap = await pollAnthropicUsage("test-token", fetchMock);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/api/oauth/usage");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer test-token",
      "anthropic-beta": "oauth-2025-04-20",
    });
    expect(snap.sessionPct).toBeCloseTo(72, 5);
    expect(snap.weeklyPct).toBeCloseTo(31, 5);
    expect(snap.resetsAt).toBe(Date.parse("2030-01-01T00:00:00Z"));
    expect(typeof snap.refreshedAt).toBe("number");
  });

  it("handles legacy flat response shape (utilization 0..1, epoch-seconds reset)", async () => {
    const epochSeconds = 1893456000; // 2030-01-01
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        body: {
          five_hour_utilization: 0.5,
          five_hour_resets_at: epochSeconds,
          seven_day_utilization: 0.1,
        },
      }),
    );

    const snap = await pollAnthropicUsage("tok", fetchMock);
    expect(snap.sessionPct).toBeCloseTo(50, 5);
    expect(snap.weeklyPct).toBeCloseTo(10, 5);
    // Epoch-seconds normalized to ms.
    expect(snap.resetsAt).toBe(epochSeconds * 1000);
  });

  it("throws on HTTP error including the status code", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: false, status: 429, body: {} }));

    await expect(pollAnthropicUsage("tok", fetchMock)).rejects.toThrow(/429/);
  });
});

describe("pollCodexUsage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("converts used_percent + epoch-seconds reset_at; weeklyPct stays undefined", async () => {
    const epochSeconds = 1893456000;
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        body: {
          plan_type: "plus",
          rate_limit: {
            primary_window: {
              used_percent: 42.5,
              reset_at: epochSeconds,
              limit_window_seconds: 18000,
            },
          },
        },
      }),
    );
    const snap = await pollCodexUsage(
      "codex-token",
      "openai-acct-123",
      fetchMock,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://chatgpt.com/backend-api/wham/usage");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer codex-token",
      "ChatGPT-Account-Id": "openai-acct-123",
      "User-Agent": "codex-cli",
    });
    expect(snap.sessionPct).toBe(42.5);
    expect(snap.resetsAt).toBe(epochSeconds * 1000);
    expect(snap.weeklyPct).toBeUndefined();
  });

  it("throws on HTTP error", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: false, status: 401, body: {} }));
    await expect(pollCodexUsage("tok", "acct", fetchMock)).rejects.toThrow(
      /401/,
    );
  });
});

describe("local JSONL counters", () => {
  let tmpDir: string;
  let originalElizaHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "milady-usage-"));
    originalElizaHome = process.env.ELIZA_HOME;
    process.env.ELIZA_HOME = tmpDir;
  });

  afterEach(() => {
    if (originalElizaHome === undefined) {
      delete process.env.ELIZA_HOME;
    } else {
      process.env.ELIZA_HOME = originalElizaHome;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("readTodayCounters returns zeros for an unseen account", () => {
    expect(readTodayCounters("anthropic-subscription", "fresh")).toEqual({
      calls: 0,
      tokens: 0,
      errors: 0,
    });
  });

  it("recordCall appends one line per call and aggregates", () => {
    recordCall("anthropic-subscription", "acct-a", {
      ok: true,
      tokens: 100,
      latencyMs: 200,
      model: "claude-opus-4-7",
    });
    recordCall("anthropic-subscription", "acct-a", {
      ok: true,
      tokens: 50,
    });
    recordCall("anthropic-subscription", "acct-a", {
      ok: false,
      tokens: 0,
      errorCode: "429",
    });

    const counters = readTodayCounters("anthropic-subscription", "acct-a");
    expect(counters).toEqual({ calls: 3, tokens: 150, errors: 1 });
  });

  it("isolates counters per (provider, account) and writes mode 0o600", () => {
    recordCall("anthropic-subscription", "a", { ok: true, tokens: 1 });
    recordCall("openai-codex", "a", { ok: true, tokens: 99 });
    expect(readTodayCounters("anthropic-subscription", "a").tokens).toBe(1);
    expect(readTodayCounters("openai-codex", "a").tokens).toBe(99);
    expect(readTodayCounters("anthropic-subscription", "b").tokens).toBe(0);

    // Verify mode on at least one written file (skipped on Windows).
    if (process.platform !== "win32") {
      const today = new Date();
      const yyyy = today.getUTCFullYear();
      const mm = String(today.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(today.getUTCDate()).padStart(2, "0");
      const file = path.join(
        tmpDir,
        "usage",
        "anthropic-subscription",
        "a",
        `${yyyy}-${mm}-${dd}.jsonl`,
      );
      const stat = fs.statSync(file);
      // Files are created by appendFileSync with mode 0o600 on first write.
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });
});

/**
 * Deterministic tests for the BROWSER wait_for_url polling loop.
 */

import { describe, expect, it, vi } from "vitest";
import { waitForUrl } from "./wait-for-url.js";

/**
 * Deterministic fake clock: `now()` advances only when `sleep(ms)` is called,
 * so the poll loop runs synchronously with no real timers.
 */
function fakeClock(start = 0) {
  let current = start;
  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms;
    },
  };
}

describe("waitForUrl", () => {
  it("resolves when the URL eventually matches and emits ≥1 status callback", async () => {
    const clock = fakeClock();
    const urls = [
      "https://app.example/loading",
      "https://app.example/oauth",
      "https://app.example/callback?code=xyz",
    ];
    let i = 0;
    const getCurrentUrl = vi.fn(() => {
      const url = urls[Math.min(i, urls.length - 1)];
      i += 1;
      return url;
    });
    const statuses: string[] = [];

    const outcome = await waitForUrl(
      { pattern: "callback?code=", timeoutMs: 60_000, pollIntervalMs: 1_000 },
      {
        getCurrentUrl,
        emitStatus: (text) => {
          statuses.push(text);
        },
        now: clock.now,
        sleep: clock.sleep,
      },
    );

    expect(outcome.status).toBe("matched");
    expect(outcome.matched).toBe(true);
    expect(outcome.lastUrl).toBe("https://app.example/callback?code=xyz");
    expect(outcome.polls).toBe(3);
    // Two "still waiting" updates before the success update.
    expect(statuses.filter((s) => s.startsWith("⏳"))).toHaveLength(2);
    expect(statuses.at(-1)).toContain("✅");
    expect(statuses.length).toBeGreaterThanOrEqual(1);
  });

  it("matches on the very first poll without emitting a waiting status", async () => {
    const clock = fakeClock();
    const statuses: string[] = [];

    const outcome = await waitForUrl(
      { pattern: "/done$/", timeoutMs: 10_000, pollIntervalMs: 1_000 },
      {
        getCurrentUrl: () => "https://ci.example/run/1/done",
        emitStatus: (text) => {
          statuses.push(text);
        },
        now: clock.now,
        sleep: clock.sleep,
      },
    );

    expect(outcome.matched).toBe(true);
    expect(outcome.polls).toBe(1);
    expect(statuses.every((s) => !s.startsWith("⏳"))).toBe(true);
  });

  it("times out cleanly when the URL never matches (never throws)", async () => {
    const clock = fakeClock();
    const statuses: string[] = [];

    const outcome = await waitForUrl(
      { pattern: "callback?code=", timeoutMs: 5_000, pollIntervalMs: 1_000 },
      {
        getCurrentUrl: () => "https://app.example/still-loading",
        emitStatus: (text) => {
          statuses.push(text);
        },
        now: clock.now,
        sleep: clock.sleep,
      },
    );

    expect(outcome.status).toBe("timeout");
    expect(outcome.matched).toBe(false);
    expect(outcome.lastUrl).toBe("https://app.example/still-loading");
    expect(outcome.message).toMatch(/Timed out/);
    expect(statuses.at(-1)).toContain("⌛");
    // Elapsed never exceeds the deadline.
    expect(outcome.elapsedMs).toBeLessThanOrEqual(5_000);
  });

  it("keeps waiting when the URL source is unreadable, then succeeds", async () => {
    const clock = fakeClock();
    const values: Array<string | null> = [null, null, "https://x.example/ok"];
    let i = 0;
    const outcome = await waitForUrl(
      { pattern: "/ok$/", timeoutMs: 60_000, pollIntervalMs: 500 },
      {
        getCurrentUrl: () => values[Math.min(i++, values.length - 1)],
        now: clock.now,
        sleep: clock.sleep,
      },
    );

    expect(outcome.matched).toBe(true);
    expect(outcome.polls).toBe(3);
  });

  it("does not crash when getCurrentUrl throws", async () => {
    const clock = fakeClock();
    let i = 0;
    const outcome = await waitForUrl(
      { pattern: "/done$/", timeoutMs: 3_000, pollIntervalMs: 1_000 },
      {
        getCurrentUrl: () => {
          i += 1;
          if (i < 2) {
            throw new Error("tab not ready");
          }
          return "https://x.example/done";
        },
        now: clock.now,
        sleep: clock.sleep,
      },
    );

    expect(outcome.matched).toBe(true);
  });
});

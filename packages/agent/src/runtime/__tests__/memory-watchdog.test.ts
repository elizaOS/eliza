/**
 * Unit coverage for the memory watchdog: env enable-flag parsing, config
 * defaults/floors, and the tick/start/stop state machine that requests a clean
 * restart after sustained over-threshold RSS (debounced on transient dips,
 * one-shot, never process.exit). Deterministic — RSS is read from a mutable
 * holder, timers are faked, and restart/log are spies.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createMemoryWatchdog,
  isMemoryWatchdogEnabled,
  type MemoryWatchdogDeps,
  resolveMemoryWatchdogConfig,
} from "../memory-watchdog.ts";

const MB = 1024 * 1024;

/** Build watchdog deps whose RSS is read from a mutable holder, with spy log/restart. */
function makeDeps(rssMbHolder: { value: number }): {
  deps: MemoryWatchdogDeps;
  restart: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
} {
  const restart = vi.fn();
  const warn = vi.fn();
  const info = vi.fn();
  return {
    restart,
    warn,
    info,
    deps: {
      readRssBytes: () => rssMbHolder.value * MB,
      requestRestart: restart,
      log: { warn, info },
    },
  };
}

const config = (
  over: Partial<{ rss: number; interval: number; sustained: number }> = {},
) => ({
  rssThresholdMb: over.rss ?? 1000,
  intervalMs: over.interval ?? 1000,
  sustainedSamples: over.sustained ?? 3,
});

afterEach(() => {
  vi.useRealTimers();
});

describe("isMemoryWatchdogEnabled", () => {
  it("is disabled by default and for unset/other values", () => {
    expect(isMemoryWatchdogEnabled({})).toBe(false);
    expect(isMemoryWatchdogEnabled({ ELIZA_MEMORY_WATCHDOG: "0" })).toBe(false);
    expect(isMemoryWatchdogEnabled({ ELIZA_MEMORY_WATCHDOG: "yes" })).toBe(
      false,
    );
  });

  it("is enabled for '1' and 'true'", () => {
    expect(isMemoryWatchdogEnabled({ ELIZA_MEMORY_WATCHDOG: "1" })).toBe(true);
    expect(isMemoryWatchdogEnabled({ ELIZA_MEMORY_WATCHDOG: "true" })).toBe(
      true,
    );
  });
});

describe("resolveMemoryWatchdogConfig", () => {
  it("returns sane defaults with no env", () => {
    expect(resolveMemoryWatchdogConfig({})).toEqual({
      rssThresholdMb: 1536,
      intervalMs: 30_000,
      sustainedSamples: 3,
    });
  });

  it("honors valid overrides", () => {
    expect(
      resolveMemoryWatchdogConfig({
        ELIZA_MEMORY_WATCHDOG_RSS_MB: "2048",
        ELIZA_MEMORY_WATCHDOG_INTERVAL_MS: "5000",
        ELIZA_MEMORY_WATCHDOG_SUSTAINED: "5",
      }),
    ).toEqual({ rssThresholdMb: 2048, intervalMs: 5_000, sustainedSamples: 5 });
  });

  it("clamps absurdly-low values to floors and ignores garbage", () => {
    const cfg = resolveMemoryWatchdogConfig({
      ELIZA_MEMORY_WATCHDOG_RSS_MB: "1", // below 128 floor
      ELIZA_MEMORY_WATCHDOG_INTERVAL_MS: "10", // below 1000 floor
      ELIZA_MEMORY_WATCHDOG_SUSTAINED: "not-a-number", // → default
    });
    expect(cfg.rssThresholdMb).toBe(128);
    expect(cfg.intervalMs).toBe(1_000);
    expect(cfg.sustainedSamples).toBe(3);
  });
});

describe("createMemoryWatchdog.tick", () => {
  it("does nothing while RSS stays under the threshold", () => {
    const rss = { value: 500 };
    const { deps, restart, warn } = makeDeps(rss);
    const wd = createMemoryWatchdog(config({ rss: 1000, sustained: 3 }), deps);

    for (let i = 0; i < 10; i += 1) expect(wd.tick()).toBe(false);
    expect(restart).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not restart until the over-threshold run is sustained", () => {
    const rss = { value: 1200 };
    const { deps, restart } = makeDeps(rss);
    const wd = createMemoryWatchdog(config({ rss: 1000, sustained: 3 }), deps);

    expect(wd.tick()).toBe(false); // 1/3
    expect(wd.tick()).toBe(false); // 2/3
    expect(restart).not.toHaveBeenCalled();
    expect(wd.tick()).toBe(true); // 3/3 → restart
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("logs a [MemoryWatchdog] warning and requests a clean restart (never exits)", () => {
    const rss = { value: 2000 };
    const { deps, restart, warn } = makeDeps(rss);
    const wd = createMemoryWatchdog(config({ rss: 1000, sustained: 1 }), deps);

    expect(wd.tick()).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("[MemoryWatchdog]");
    expect(String(warn.mock.calls[0]?.[0])).toContain("restart");
    expect(restart).toHaveBeenCalledTimes(1);
    expect(String(restart.mock.calls[0]?.[0])).toContain("memory-watchdog");
  });

  it("resets the counter on a transient spike (debounce)", () => {
    const rss = { value: 0 };
    const { deps, restart } = makeDeps(rss);
    const wd = createMemoryWatchdog(config({ rss: 1000, sustained: 3 }), deps);

    rss.value = 1200;
    expect(wd.tick()).toBe(false); // 1/3
    expect(wd.tick()).toBe(false); // 2/3
    rss.value = 400; // dipped back under → reset
    expect(wd.tick()).toBe(false);
    rss.value = 1200;
    expect(wd.tick()).toBe(false); // 1/3 again
    expect(wd.tick()).toBe(false); // 2/3
    expect(restart).not.toHaveBeenCalled();
    expect(wd.tick()).toBe(true); // 3/3
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("is one-shot: never re-requests a restart after firing", () => {
    const rss = { value: 5000 };
    const { deps, restart } = makeDeps(rss);
    const wd = createMemoryWatchdog(config({ rss: 1000, sustained: 1 }), deps);

    expect(wd.tick()).toBe(true);
    for (let i = 0; i < 5; i += 1) expect(wd.tick()).toBe(false);
    expect(restart).toHaveBeenCalledTimes(1);
  });
});

describe("createMemoryWatchdog start/stop (timer-driven)", () => {
  it("fires a restart after sustained samples on its interval, then stop() halts sampling", () => {
    vi.useFakeTimers();
    const rss = { value: 2000 };
    const { deps, restart } = makeDeps(rss);
    const wd = createMemoryWatchdog(
      config({ rss: 1000, interval: 1000, sustained: 3 }),
      deps,
    );

    wd.start();
    vi.advanceTimersByTime(1000); // 1/3
    vi.advanceTimersByTime(1000); // 2/3
    expect(restart).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000); // 3/3 → restart
    expect(restart).toHaveBeenCalledTimes(1);

    wd.stop();
    vi.advanceTimersByTime(10_000);
    expect(restart).toHaveBeenCalledTimes(1); // no further activity after stop
  });

  it("start() is idempotent", () => {
    vi.useFakeTimers();
    const rss = { value: 200 };
    const { deps } = makeDeps(rss);
    const wd = createMemoryWatchdog(
      config({ rss: 1000, interval: 1000, sustained: 1 }),
      deps,
    );
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    wd.start();
    wd.start();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    wd.stop();
    setIntervalSpy.mockRestore();
  });
});

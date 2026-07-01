import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMemoryWatchdog,
  isMemoryWatchdogEnabled,
  type MemoryWatchdogConfig,
  type MemoryWatchdogDeps,
  resolveMemoryWatchdogConfig,
  startMemoryWatchdog,
  stopMemoryWatchdog,
} from "./memory-watchdog.ts";

const MB = 1024 * 1024;
const noopLog: MemoryWatchdogDeps["log"] = { warn: () => {}, info: () => {} };

/** A watchdog whose RSS samples and restart calls are fully controlled. */
function harness(
  config: Partial<MemoryWatchdogConfig> = {},
  rssMbSequence: number[] = [],
) {
  const full: MemoryWatchdogConfig = {
    rssThresholdMb: 1000,
    intervalMs: 1000,
    sustainedSamples: 3,
    ...config,
  };
  let i = 0;
  const restarts: string[] = [];
  const watchdog = createMemoryWatchdog(full, {
    readRssBytes: () =>
      (rssMbSequence[Math.min(i++, rssMbSequence.length - 1)] ?? 0) * MB,
    requestRestart: (reason) => {
      restarts.push(reason ?? "");
    },
    log: noopLog,
  });
  return { watchdog, restarts };
}

describe("isMemoryWatchdogEnabled", () => {
  it("is disabled by default (opt-in)", () => {
    expect(isMemoryWatchdogEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });
  it('enables on "1" or "true" only', () => {
    expect(
      isMemoryWatchdogEnabled({
        ELIZA_MEMORY_WATCHDOG: "1",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      isMemoryWatchdogEnabled({
        ELIZA_MEMORY_WATCHDOG: "true",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    for (const v of ["0", "false", "yes", "on", ""]) {
      expect(
        isMemoryWatchdogEnabled({
          ELIZA_MEMORY_WATCHDOG: v,
        } as NodeJS.ProcessEnv),
      ).toBe(false);
    }
  });
});

describe("resolveMemoryWatchdogConfig", () => {
  it("uses documented defaults when unset", () => {
    expect(resolveMemoryWatchdogConfig({} as NodeJS.ProcessEnv)).toEqual({
      rssThresholdMb: 1536,
      intervalMs: 30_000,
      sustainedSamples: 3,
    });
  });
  it("applies valid env overrides", () => {
    expect(
      resolveMemoryWatchdogConfig({
        ELIZA_MEMORY_WATCHDOG_RSS_MB: "2048",
        ELIZA_MEMORY_WATCHDOG_INTERVAL_MS: "15000",
        ELIZA_MEMORY_WATCHDOG_SUSTAINED: "5",
      } as NodeJS.ProcessEnv),
    ).toEqual({
      rssThresholdMb: 2048,
      intervalMs: 15_000,
      sustainedSamples: 5,
    });
  });
  it("clamps misconfigured-low values to safe floors", () => {
    const c = resolveMemoryWatchdogConfig({
      ELIZA_MEMORY_WATCHDOG_RSS_MB: "8", // < 128 floor
      ELIZA_MEMORY_WATCHDOG_INTERVAL_MS: "10", // < 1000 floor
      ELIZA_MEMORY_WATCHDOG_SUSTAINED: "0", // < 1 floor
    } as NodeJS.ProcessEnv);
    expect(c).toEqual({
      rssThresholdMb: 128,
      intervalMs: 1_000,
      sustainedSamples: 1,
    });
  });
  it("falls back to defaults on non-numeric env", () => {
    expect(
      resolveMemoryWatchdogConfig({
        ELIZA_MEMORY_WATCHDOG_RSS_MB: "lots",
      } as NodeJS.ProcessEnv).rssThresholdMb,
    ).toBe(1536);
  });
});

describe("createMemoryWatchdog.tick — threshold / debounce / one-shot", () => {
  it("never restarts while RSS stays under the threshold", () => {
    const { watchdog, restarts } = harness(
      { rssThresholdMb: 1000 },
      [500, 999, 999, 900],
    );
    for (let n = 0; n < 4; n++) expect(watchdog.tick()).toBe(false);
    expect(restarts).toEqual([]);
  });

  it("restarts only after `sustainedSamples` consecutive over-threshold ticks", () => {
    const { watchdog, restarts } = harness(
      { rssThresholdMb: 1000, sustainedSamples: 3 },
      [1200, 1200, 1200],
    );
    expect(watchdog.tick()).toBe(false); // 1
    expect(watchdog.tick()).toBe(false); // 2
    expect(watchdog.tick()).toBe(true); // 3 -> fire
    expect(restarts).toHaveLength(1);
    expect(restarts[0]).toContain("RSS 1200MB >= 1000MB for 3 samples");
  });

  it("treats RSS exactly at the threshold as over (>=, not >)", () => {
    const { watchdog, restarts } = harness(
      { rssThresholdMb: 1000, sustainedSamples: 1 },
      [1000],
    );
    expect(watchdog.tick()).toBe(true);
    expect(restarts).toHaveLength(1);
  });

  it("resets the streak when RSS dips back under the threshold", () => {
    const { watchdog, restarts } = harness(
      { rssThresholdMb: 1000, sustainedSamples: 3 },
      [1200, 1200, 500, 1200, 1200],
    );
    for (let n = 0; n < 5; n++) watchdog.tick();
    expect(restarts).toEqual([]); // never 3 in a row
  });

  it("is one-shot: after firing it never requests a second restart", () => {
    const { watchdog, restarts } = harness(
      { rssThresholdMb: 1000, sustainedSamples: 1 },
      [1200, 5000, 5000],
    );
    expect(watchdog.tick()).toBe(true);
    expect(watchdog.tick()).toBe(false);
    expect(watchdog.tick()).toBe(false);
    expect(restarts).toHaveLength(1);
  });
});

describe("createMemoryWatchdog.start/stop — timer lifecycle", () => {
  afterEach(() => vi.useRealTimers());

  it("samples on the interval and stops cleanly", () => {
    vi.useFakeTimers();
    const { watchdog, restarts } = harness(
      { rssThresholdMb: 1000, sustainedSamples: 2, intervalMs: 1000 },
      [1200, 1200, 1200],
    );
    watchdog.start();
    vi.advanceTimersByTime(1000); // over #1
    expect(restarts).toEqual([]);
    vi.advanceTimersByTime(1000); // over #2 -> fire
    expect(restarts).toHaveLength(1);
    watchdog.stop();
    vi.advanceTimersByTime(5000); // no further ticks after stop
    expect(restarts).toHaveLength(1);
  });
});

describe("startMemoryWatchdog — process-wide wiring", () => {
  afterEach(() => stopMemoryWatchdog());

  it("returns null when disabled", () => {
    expect(startMemoryWatchdog({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it("returns a live watchdog when enabled", () => {
    const wd = startMemoryWatchdog({
      ELIZA_MEMORY_WATCHDOG: "1",
      ELIZA_MEMORY_WATCHDOG_RSS_MB: "4096",
    } as NodeJS.ProcessEnv);
    expect(wd).not.toBeNull();
  });
});

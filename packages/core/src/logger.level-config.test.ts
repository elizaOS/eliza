/**
 * LOG_LEVEL must be validated once at module load and honoured by both sinks
 * (#31959): unknown names warn and fall back to the default instead of
 * silently meaning "info", `silent`/`off`/`none` disable every sink, and
 * `verbose` reaches the console as well as the in-memory buffer. Deterministic:
 * the real module is re-imported per case with the environment set, console
 * methods are spied, and the global Adze setup is re-seated afterwards.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

type LoggerModule = typeof import("./logger");

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;

async function withLogLevel(
  value: string | undefined,
  run: (
    fresh: LoggerModule,
    consoleCalls: () => number,
  ) => Promise<void> | void,
): Promise<void> {
  const previous = process.env.LOG_LEVEL;
  if (value === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = value;
  const spies = CONSOLE_METHODS.map((method) =>
    vi.spyOn(console, method).mockImplementation(() => undefined),
  );
  const consoleCalls = () =>
    spies.reduce((total, spy) => total + spy.mock.calls.length, 0);
  try {
    vi.resetModules();
    const fresh = await import("./logger");
    await run(fresh, consoleCalls);
  } finally {
    for (const spy of spies) spy.mockRestore();
    if (previous === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = previous;
    vi.resetModules();
    await import("./logger");
  }
}

describe("LOG_LEVEL configuration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["silent", "off", "none", "SILENT"])(
    "LOG_LEVEL=%s emits nothing to the buffer or the console",
    async (value) => {
      await withLogLevel(value, (fresh, consoleCalls) => {
        fresh.logger.clear();
        fresh.logger.info("level-config-info");
        fresh.logger.warn("level-config-warn");
        fresh.logger.error("level-config-error");
        expect(fresh.recentLogs()).not.toContain("level-config");
        expect(consoleCalls()).toBe(0);
      });
    },
  );

  it("treats the common misspelling warning as warn", async () => {
    await withLogLevel("warning", (fresh) => {
      fresh.logger.clear();
      fresh.logger.info("level-config-info");
      fresh.logger.warn("level-config-warn");
      expect(fresh.recentLogs()).not.toContain("level-config-info");
      expect(fresh.recentLogs()).toContain("level-config-warn");
    });
  });

  it("warns once on stderr for an unknown level and keeps the default", async () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    await withLogLevel("verbosee", (fresh) => {
      const warnings = stderr.mock.calls
        .map(([chunk]) => String(chunk))
        .filter((line) => line.includes("unknown LOG_LEVEL"));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('"verbosee"');
      fresh.logger.clear();
      fresh.logger.debug("level-config-debug");
      fresh.logger.info("level-config-info");
      expect(fresh.recentLogs()).not.toContain("level-config-debug");
      expect(fresh.recentLogs()).toContain("level-config-info");
    });
    stderr.mockRestore();
  });

  it("delivers debug lines to both sinks under LOG_LEVEL=verbose", async () => {
    await withLogLevel("verbose", (fresh, consoleCalls) => {
      fresh.logger.clear();
      const before = consoleCalls();
      fresh.logger.debug("level-config-debug");
      expect(fresh.recentLogs()).toContain("level-config-debug");
      expect(consoleCalls()).toBeGreaterThan(before);
    });
  });

  it("keeps error output under LOG_LEVEL=error", async () => {
    await withLogLevel("error", (fresh, consoleCalls) => {
      fresh.logger.clear();
      fresh.logger.info("level-config-info");
      expect(consoleCalls()).toBe(0);
      fresh.logger.error("level-config-error");
      expect(fresh.recentLogs()).toContain("level-config-error");
      expect(consoleCalls()).toBeGreaterThan(0);
    });
  });
});

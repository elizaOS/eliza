/**
 * Unit coverage for connector health probing. Telegram exposes poller liveness,
 * so a registered service object is not enough to report the connector healthy.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConnectorHealthMonitor,
  resolveConnectorHealthIntervalMs,
} from "./connector-health";

function createMonitor(service: unknown): ConnectorHealthMonitor {
  return new ConnectorHealthMonitor({
    runtime: {
      getService: vi.fn(() => service),
    } as never,
    config: {
      connectors: {
        telegram: { enabled: true },
      },
    },
    broadcastWs: vi.fn(),
    intervalMs: 60_000,
  });
}

describe("ConnectorHealthMonitor", () => {
  it("uses the configured canonical connector-health interval", () => {
    expect(resolveConnectorHealthIntervalMs("10000")).toBe(10_000);
    expect(resolveConnectorHealthIntervalMs("2147483647")).toBe(2_147_483_647);
  });

  it("passes the validated interval to the connector-health timer", () => {
    const setIntervalSpy = vi
      .spyOn(globalThis, "setInterval")
      .mockReturnValue({} as ReturnType<typeof setInterval>);
    const monitor = new ConnectorHealthMonitor({
      runtime: { getService: vi.fn() } as never,
      config: { connectors: {} },
      broadcastWs: vi.fn(),
      intervalMs: resolveConnectorHealthIntervalMs("10000"),
    });

    monitor.start();

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 10_000);
    setIntervalSpy.mockRestore();
  });

  // Defaulting (not throwing) is deliberate: the monitor is constructed
  // inside a post-listen deferred wave wrapped in a warn-and-continue catch,
  // so a throw here would silently disable connector health monitoring (and
  // the /api/health connector status) for the rest of the process lifetime
  // instead of failing fast. Number.parseInt truncates at the first
  // non-digit, so these all resolved to 10000 in production before this
  // file's validation existed, and the fix preserves that exactly.
  it.each(["10000junk", "10000.5", "010000", " 10000"])(
    "preserves the pre-existing Number.parseInt truncation for %s",
    (value) => {
      expect(resolveConnectorHealthIntervalMs(value)).toBe(10_000);
    },
  );

  // "1e4" truncates to 1 (parseInt stops at "e"); "Infinity" isn't a valid
  // leading digit at all (NaN). Both fall through to the default, matching
  // pre-existing behavior.
  it.each(["1e4", "Infinity"])(
    "falls back to the default for non-canonical connector-health interval %s",
    (value) => {
      expect(resolveConnectorHealthIntervalMs(value)).toBe(60_000);
    },
  );

  it.each(["0", "9999"])(
    "falls back to the default for a below-minimum connector-health interval %s",
    (value) => {
      expect(resolveConnectorHealthIntervalMs(value)).toBe(60_000);
    },
  );

  // Mutation-resistant: proves the fix actually closes the real bug (the
  // overflow silently reaching setInterval and firing a hot loop), not just
  // that the parser returns *a* number. Confirmed against the original
  // Number.parseInt-based resolver, which returned 2147483648 and
  // 9007199254740992 verbatim.
  it.each(["2147483648", "9007199254740992"])(
    "falls back to the default instead of overflowing setInterval for %s",
    (value) => {
      expect(resolveConnectorHealthIntervalMs(value)).toBe(60_000);
    },
  );

  it("keeps the default when the connector-health interval is unset", () => {
    expect(resolveConnectorHealthIntervalMs(undefined)).toBe(60_000);
  });

  describe("constructing ConnectorHealthMonitor from the real env var", () => {
    const originalValue = process.env.CONNECTOR_HEALTH_INTERVAL_MS;

    afterEach(() => {
      if (originalValue === undefined) {
        delete process.env.CONNECTOR_HEALTH_INTERVAL_MS;
      } else {
        process.env.CONNECTOR_HEALTH_INTERVAL_MS = originalValue;
      }
    });

    // Proves the actual regression this fix closes: constructing the monitor
    // (the real call site, inside a post-listen deferred wave wrapped in a
    // warn-and-continue catch in server.ts) never throws for a malformed
    // value, so connector health monitoring is never silently disabled for
    // the rest of the process lifetime.
    it.each(["2147483648", "1e4", "not-a-number"])(
      "never throws when CONNECTOR_HEALTH_INTERVAL_MS=%s, and defaults the interval",
      (value) => {
        process.env.CONNECTOR_HEALTH_INTERVAL_MS = value;
        const setIntervalSpy = vi
          .spyOn(globalThis, "setInterval")
          .mockReturnValue({} as ReturnType<typeof setInterval>);

        let monitor: ConnectorHealthMonitor | undefined;
        expect(() => {
          monitor = new ConnectorHealthMonitor({
            runtime: { getService: vi.fn() } as never,
            config: { connectors: {} },
            broadcastWs: vi.fn(),
          });
        }).not.toThrow();

        monitor?.start();
        expect(setIntervalSpy).toHaveBeenCalledWith(
          expect.any(Function),
          60_000,
        );
        setIntervalSpy.mockRestore();
      },
    );

    it("uses the real env var when intervalMs is not passed explicitly", () => {
      process.env.CONNECTOR_HEALTH_INTERVAL_MS = "45000";
      const setIntervalSpy = vi
        .spyOn(globalThis, "setInterval")
        .mockReturnValue({} as ReturnType<typeof setInterval>);

      const monitor = new ConnectorHealthMonitor({
        runtime: { getService: vi.fn() } as never,
        config: { connectors: {} },
        broadcastWs: vi.fn(),
      });
      monitor.start();

      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 45_000);
      setIntervalSpy.mockRestore();
    });
  });

  it("reports Telegram missing when the service exists but the poller is not live", async () => {
    const monitor = createMonitor({
      getPollerHealth: () => ({
        ok: false,
        connected: false,
        lastError: "poller stopped",
      }),
    });

    await monitor.check();

    expect(monitor.getConnectorStatuses()).toEqual({ telegram: "missing" });
  });

  it("reports Telegram ok only when poller health is connected", async () => {
    const monitor = createMonitor({
      getPollerHealth: () => ({
        ok: true,
        connected: true,
      }),
    });

    await monitor.check();

    expect(monitor.getConnectorStatuses()).toEqual({ telegram: "ok" });
  });
});

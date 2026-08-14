/**
 * Unit coverage for connector health probing. Telegram exposes poller liveness,
 * so a registered service object is not enough to report the connector healthy.
 */
import { describe, expect, it, vi } from "vitest";
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

  it.each(["10000junk", "10000.5", "1e4", "010000", " 10000", "Infinity"])(
    "rejects malformed connector-health interval %s",
    (value) => {
      expect(() => resolveConnectorHealthIntervalMs(value)).toThrow(
        "CONNECTOR_HEALTH_INTERVAL_MS must be a canonical decimal integer",
      );
    },
  );

  it.each(["0", "9999", "2147483648", "9007199254740992"])(
    "rejects out-of-range connector-health interval %s",
    (value) => {
      expect(() => resolveConnectorHealthIntervalMs(value)).toThrow(
        "CONNECTOR_HEALTH_INTERVAL_MS must be between 10000 and 2147483647",
      );
    },
  );

  it("keeps the default when the connector-health interval is unset", () => {
    expect(resolveConnectorHealthIntervalMs(undefined)).toBe(60_000);
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

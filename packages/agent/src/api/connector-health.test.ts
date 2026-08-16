/**
 * Unit coverage for strict startup interval validation and connector health
 * probing. Telegram exposes poller liveness, so a registered service object is
 * not enough to report the connector healthy.
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

// Builds a monitor whose discord probe throws (or rejects) while telegram is
// listed after it and stays healthy, mirroring the #20185 reproduction where a
// throwing getPollerHealth blanked every connector status after it.
function createIsolationMonitor(discordProbe: () => unknown): {
  monitor: ConnectorHealthMonitor;
  reportError: ReturnType<typeof vi.fn>;
} {
  const reportError = vi.fn();
  const services: Record<string, unknown> = {
    discord: { getPollerHealth: discordProbe },
    telegram: { getPollerHealth: () => ({ ok: true, connected: true }) },
  };
  const monitor = new ConnectorHealthMonitor({
    runtime: {
      getService: vi.fn((name: string) => services[name]),
      reportError,
    } as never,
    config: {
      connectors: {
        discord: { enabled: true },
        telegram: { enabled: true },
      },
    },
    broadcastWs: vi.fn(),
    intervalMs: 60_000,
  });
  return { monitor, reportError };
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

  it.each([
    "10000junk",
    "10000.5",
    "010000",
    " 10000",
    "10000 ",
    "1e4",
    "Infinity",
    "0",
    "9999",
    "2147483648",
    "9007199254740992",
  ])("fails fast on invalid CONNECTOR_HEALTH_INTERVAL_MS=%s", (value) => {
    expect(() => resolveConnectorHealthIntervalMs(value)).toThrowError(
      expect.objectContaining({ code: "CONNECTOR_HEALTH_INTERVAL_INVALID" }),
    );
  });

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

  it("isolates a synchronously throwing poller probe so later connectors still report", async () => {
    const { monitor, reportError } = createIsolationMonitor(() => {
      throw new Error("boom");
    });

    await expect(monitor.check()).resolves.toBeUndefined();

    // discord throwing must not abort the loop or fabricate an "ok" DTO;
    // telegram is listed after discord and must still be probed and reported.
    expect(monitor.getConnectorStatuses()).toEqual({
      discord: "missing",
      telegram: "ok",
    });
    expect(reportError).toHaveBeenCalledWith(
      "ConnectorHealthMonitor.probeConnector",
      expect.any(Error),
      expect.objectContaining({ connector: "discord" }),
    );
  });

  it("isolates a rejected poller-health promise with the same guarantees", async () => {
    const { monitor } = createIsolationMonitor(() =>
      Promise.reject(new Error("network down")),
    );

    await expect(monitor.check()).resolves.toBeUndefined();

    expect(monitor.getConnectorStatuses()).toEqual({
      discord: "missing",
      telegram: "ok",
    });
  });

  it("never fabricates a healthy status: statuses map is non-empty so health-routes cannot relabel connectors 'configured'", async () => {
    const { monitor } = createIsolationMonitor(() => {
      throw new Error("boom");
    });

    await monitor.check();

    const statuses = monitor.getConnectorStatuses();
    // health-routes.ts falls back to a blanket fabricated-healthy "configured"
    // only when this map is empty; a real per-connector state must survive.
    expect(Object.keys(statuses).length).toBeGreaterThan(0);
    expect(Object.values(statuses)).not.toContain("configured");
    expect(statuses.discord).toBe("missing");
  });

  it("start() does not leak an unhandledRejection when a probe throws", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    const setIntervalSpy = vi
      .spyOn(globalThis, "setInterval")
      .mockReturnValue({} as ReturnType<typeof setInterval>);
    try {
      const { monitor } = createIsolationMonitor(() => {
        throw new Error("boom");
      });

      monitor.start();

      // Give the fire-and-forget check() microtasks a chance to settle so any
      // unhandled rejection would surface before we assert.
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(rejections).toEqual([]);
      expect(monitor.getConnectorStatuses()).toEqual({
        discord: "missing",
        telegram: "ok",
      });
    } finally {
      setIntervalSpy.mockRestore();
      process.off("unhandledRejection", onRejection);
    }
  });
});

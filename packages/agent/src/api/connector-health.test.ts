/**
 * Unit coverage for connector health probing. Telegram exposes poller liveness,
 * so a registered service object is not enough to report the connector healthy.
 */
import { describe, expect, it, vi } from "vitest";
import { ConnectorHealthMonitor } from "./connector-health";

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

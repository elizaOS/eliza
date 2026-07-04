// Exercises provisioning worker health monitor behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, it } from "bun:test";
import type { ProvisioningWorkerHealth } from "./provisioning-worker-health";
import {
  HEARTBEAT_MAX_AGE_MS,
  isHeartbeatStale,
  monitorProvisioningWorkerHealth,
} from "./provisioning-worker-health-monitor";

const NOW = Date.parse("2026-06-28T00:00:00.000Z");

describe("isHeartbeatStale", () => {
  it("treats a fresh heartbeat as not stale", () => {
    const fresh = new Date(NOW - 1_000).toISOString();
    expect(isHeartbeatStale(fresh, NOW)).toBe(false);
  });

  it("treats a heartbeat older than the max age as stale", () => {
    const old = new Date(NOW - HEARTBEAT_MAX_AGE_MS - 1).toISOString();
    expect(isHeartbeatStale(old, NOW)).toBe(true);
  });

  it("treats an absent heartbeat as stale", () => {
    expect(isHeartbeatStale(undefined, NOW)).toBe(true);
  });

  it("treats an unparseable heartbeat as stale", () => {
    expect(isHeartbeatStale("not-a-date", NOW)).toBe(true);
  });

  it("does not flag a heartbeat exactly at the max age", () => {
    const edge = new Date(NOW - HEARTBEAT_MAX_AGE_MS).toISOString();
    expect(isHeartbeatStale(edge, NOW)).toBe(false);
  });
});

function captureAlerts() {
  const alerts: { title: string; details: Record<string, unknown> }[] = [];
  return {
    alerts,
    alert: async (a: { title: string; details: Record<string, unknown> }) => {
      alerts.push(a);
    },
  };
}

describe("monitorProvisioningWorkerHealth", () => {
  it("is healthy and silent when the daemon is not required", async () => {
    const { alerts, alert } = captureAlerts();
    const health: ProvisioningWorkerHealth = { ok: true, required: false };
    const result = await monitorProvisioningWorkerHealth({
      check: async () => health,
      alert,
      now: () => NOW,
    });
    expect(result.healthy).toBe(true);
    expect(result.stale).toBe(false);
    expect(alerts).toHaveLength(0);
  });

  it("is healthy and silent on a fresh heartbeat", async () => {
    const { alerts, alert } = captureAlerts();
    const health: ProvisioningWorkerHealth = {
      ok: true,
      required: true,
      lastHeartbeatAt: new Date(NOW - 1_000).toISOString(),
    };
    const result = await monitorProvisioningWorkerHealth({
      check: async () => health,
      alert,
      now: () => NOW,
    });
    expect(result.healthy).toBe(true);
    expect(result.stale).toBe(false);
    expect(alerts).toHaveLength(0);
  });

  it("is unhealthy and alerts when the heartbeat is absent (gate failed closed)", async () => {
    const { alerts, alert } = captureAlerts();
    const health: ProvisioningWorkerHealth = {
      ok: false,
      required: true,
      status: 503,
      code: "PROVISIONING_WORKER_UNHEALTHY",
      error: "Provisioning worker has not reported a heartbeat in the last 60 seconds.",
    };
    const result = await monitorProvisioningWorkerHealth({
      check: async () => health,
      alert,
      now: () => NOW,
    });
    expect(result.healthy).toBe(false);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].details.code).toBe("PROVISIONING_WORKER_UNHEALTHY");
  });

  it("is unhealthy and alerts when a present heartbeat is stale", async () => {
    const { alerts, alert } = captureAlerts();
    const health: ProvisioningWorkerHealth = {
      ok: true,
      required: true,
      lastHeartbeatAt: new Date(NOW - HEARTBEAT_MAX_AGE_MS - 10_000).toISOString(),
    };
    const result = await monitorProvisioningWorkerHealth({
      check: async () => health,
      alert,
      now: () => NOW,
    });
    expect(result.healthy).toBe(false);
    expect(result.stale).toBe(true);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].details.code).toBe("PROVISIONING_WORKER_STALE_HEARTBEAT");
  });
});

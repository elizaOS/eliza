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
      writeDbHeartbeat: async () => {},
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
      writeDbHeartbeat: async () => {},
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
      writeDbHeartbeat: async () => {},
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
      writeDbHeartbeat: async () => {},
      check: async () => health,
      alert,
      now: () => NOW,
    });
    expect(result.healthy).toBe(false);
    expect(result.stale).toBe(true);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].details.code).toBe("PROVISIONING_WORKER_STALE_HEARTBEAT");
  });

  // #16160: this per-minute monitor doubles as the cloud-api DB heartbeat
  // writer the provisioning-worker daemon reads to tell idle from split — it
  // must stamp the heartbeat on EVERY invocation, including the not-required
  // early return (the daemon may be optional while the DB signal still matters).
  it("stamps the DB heartbeat on every invocation, even when the daemon is not required", async () => {
    let writes = 0;
    const health: ProvisioningWorkerHealth = { ok: true, required: false };
    await monitorProvisioningWorkerHealth({
      writeDbHeartbeat: async () => {
        writes += 1;
      },
      check: async () => health,
      alert: async () => {},
      now: () => NOW,
    });
    expect(writes).toBe(1);
  });

  it("sendProvisioningWorkerAlert posts to every configured channel and resolves without any", async () => {
    const { sendProvisioningWorkerAlert } = await import("./provisioning-worker-health-monitor");
    const prevSlack = process.env.PROVISIONING_ALERT_SLACK_WEBHOOK;
    const prevPd = process.env.PROVISIONING_ALERT_PAGERDUTY_KEY;
    const realFetch = globalThis.fetch;
    const posted: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      posted.push(String(url));
      return new Response("ok");
    }) as typeof fetch;
    try {
      // No channels configured: structured log only, no fetch, no throw.
      delete process.env.PROVISIONING_ALERT_SLACK_WEBHOOK;
      delete process.env.PROVISIONING_ALERT_PAGERDUTY_KEY;
      await sendProvisioningWorkerAlert({
        title: "t",
        message: "m",
        details: { code: "TEST" },
      });
      expect(posted).toHaveLength(0);

      // Both channels configured: one POST each (Slack webhook + PagerDuty).
      process.env.PROVISIONING_ALERT_SLACK_WEBHOOK = "https://hooks.slack.example/T/B/x";
      process.env.PROVISIONING_ALERT_PAGERDUTY_KEY = "pd-routing-key";
      await sendProvisioningWorkerAlert({
        title: "t",
        message: "m",
        details: { code: "TEST" },
        dedupKey: "test-dedup",
      });
      expect(posted).toHaveLength(2);
      expect(posted[0]).toBe("https://hooks.slack.example/T/B/x");
      expect(posted[1]).toBe("https://events.pagerduty.com/v2/enqueue");
    } finally {
      globalThis.fetch = realFetch;
      if (prevSlack === undefined) delete process.env.PROVISIONING_ALERT_SLACK_WEBHOOK;
      else process.env.PROVISIONING_ALERT_SLACK_WEBHOOK = prevSlack;
      if (prevPd === undefined) delete process.env.PROVISIONING_ALERT_PAGERDUTY_KEY;
      else process.env.PROVISIONING_ALERT_PAGERDUTY_KEY = prevPd;
    }
  });
});

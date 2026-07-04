// Exercises cloud API v1 cron provisioning worker health route.test behavior with deterministic Worker route fixtures.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * End-to-end wiring test for the provisioning-worker-health cron route.
 *
 * This drives the REAL route handler through the REAL
 * `monitorProvisioningWorkerHealth` orchestration and the REAL
 * `sendProvisioningWorkerAlert` fan-out. Only two seams are stubbed:
 *   - the Redis-backed gate (`checkProvisioningWorkerHealth`), so we can inject
 *     a stale/absent/fresh heartbeat without a live Redis;
 *   - global `fetch`, so we can capture the outbound ops-channel alert without
 *     POSTing to a real Slack webhook.
 *
 * Asserts the dead-alert gap is closed: when the daemon heartbeat is
 * absent or stale, the route returns `healthy:false` AND the alert callback
 * actually fires (structured error log + Slack channel POST). The healthy path
 * stays silent, and an invalid cron secret is rejected before any check runs.
 */

import type { ProvisioningWorkerHealth } from "@/lib/services/provisioning-worker-health";

const checkProvisioningWorkerHealth = mock(
  async (): Promise<ProvisioningWorkerHealth> => ({
    ok: true,
    required: false,
  }),
);

const loggerError = mock(() => undefined);

// The monitor reads `process.env.PROVISIONING_ALERT_SLACK_WEBHOOK` and POSTs to
// it via global fetch; capture that POST instead of hitting the network.
const SLACK_WEBHOOK = "https://hooks.slack.test/services/PROVISIONING";
const fetchCalls: Array<{ url: string; body: unknown }> = [];
const fetchMock = mock(async (url: string, init?: RequestInit) => {
  fetchCalls.push({
    url,
    body: init?.body ? JSON.parse(init.body as string) : undefined,
  });
  return new Response("ok", { status: 200 });
});

mock.module("@/lib/services/provisioning-worker-health", () => ({
  checkProvisioningWorkerHealth,
  // Re-exported by the monitor's barrel of constants; keep the real TTL so the
  // monitor's staleness window matches production.
  PROVISIONING_WORKER_HEARTBEAT_TTL_S: 60,
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: loggerError,
    debug: mock(() => undefined),
  },
}));

const { default: app } = await import("./route");

const CRON_SECRET = "cron-secret";
const HEARTBEAT_MAX_AGE_MS = 60 * 1000;

function hitCron(secret = CRON_SECRET) {
  return app.fetch(
    new Request("https://api.example.test/", {
      method: "POST",
      headers: { "x-cron-secret": secret },
    }),
    { CRON_SECRET },
  );
}

const realFetch = globalThis.fetch;

beforeEach(() => {
  checkProvisioningWorkerHealth.mockClear();
  loggerError.mockClear();
  fetchMock.mockClear();
  fetchCalls.length = 0;
  process.env.PROVISIONING_ALERT_SLACK_WEBHOOK = SLACK_WEBHOOK;
  delete process.env.PROVISIONING_ALERT_PAGERDUTY_KEY;
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.PROVISIONING_ALERT_SLACK_WEBHOOK;
});

describe("provisioning-worker-health cron route", () => {
  test("absent heartbeat (gate failed closed) -> healthy:false and the alert fires", async () => {
    checkProvisioningWorkerHealth.mockResolvedValueOnce({
      ok: false,
      required: true,
      status: 503,
      code: "PROVISIONING_WORKER_UNHEALTHY",
      error:
        "Provisioning worker has not reported a heartbeat in the last 60 seconds.",
    });

    const response = await hitCron();
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      healthy: boolean;
      stale: boolean;
      health: ProvisioningWorkerHealth;
    };
    expect(body.healthy).toBe(false);
    expect(body.stale).toBe(false);

    // The alert callback actually fired: structured error log + Slack POST.
    expect(loggerError).toHaveBeenCalled();
    const slackPost = fetchCalls.find((c) => c.url === SLACK_WEBHOOK);
    expect(slackPost).toBeDefined();
    expect(JSON.stringify(slackPost?.body)).toContain(
      "Provisioning worker is unhealthy",
    );
  });

  test("present-but-stale heartbeat -> healthy:false, stale:true and the alert fires", async () => {
    const staleAt = new Date(
      Date.now() - HEARTBEAT_MAX_AGE_MS - 10_000,
    ).toISOString();
    checkProvisioningWorkerHealth.mockResolvedValueOnce({
      ok: true,
      required: true,
      lastHeartbeatAt: staleAt,
    });

    const response = await hitCron();
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      healthy: boolean;
      stale: boolean;
    };
    expect(body.healthy).toBe(false);
    expect(body.stale).toBe(true);

    expect(fetchCalls.some((c) => c.url === SLACK_WEBHOOK)).toBe(true);
  });

  test("fresh heartbeat -> healthy:true and NO alert fires", async () => {
    checkProvisioningWorkerHealth.mockResolvedValueOnce({
      ok: true,
      required: true,
      lastHeartbeatAt: new Date(Date.now() - 1_000).toISOString(),
    });

    const response = await hitCron();
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      healthy: boolean;
      stale: boolean;
    };
    expect(body.healthy).toBe(true);
    expect(body.stale).toBe(false);

    expect(fetchCalls.some((c) => c.url === SLACK_WEBHOOK)).toBe(false);
  });

  test("daemon not required (e.g. local) -> healthy:true, silent", async () => {
    checkProvisioningWorkerHealth.mockResolvedValueOnce({
      ok: true,
      required: false,
    });

    const response = await hitCron();
    const body = (await response.json()) as { healthy: boolean };
    expect(body.healthy).toBe(true);
    expect(fetchCalls.some((c) => c.url === SLACK_WEBHOOK)).toBe(false);
  });

  test("invalid cron secret -> rejected before the gate is ever read", async () => {
    const response = await hitCron("wrong-secret");
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(checkProvisioningWorkerHealth).not.toHaveBeenCalled();
  });
});

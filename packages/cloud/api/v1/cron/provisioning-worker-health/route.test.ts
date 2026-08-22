/**
 * End-to-end wiring test for the provisioning-worker-health cron route.
 *
 * This drives the REAL route handler through the REAL
 * `monitorProvisioningWorkerHealth` orchestration and the REAL
 * `sendProvisioningWorkerAlert` fan-out. Only two seams are stubbed:
 *   - the Redis-backed gate (`checkProvisioningWorkerHealth`), so we can inject
 *     a stale/absent/fresh heartbeat without a live Redis;
 *   - global `fetch`, so we can capture the outbound ops-channel alert without
 *     POSTing to a real Slack webhook;
 *   - the shared-DB heartbeat write, whose repository is outside this route's
 *     health/alert contract and must not initialize persistent PGlite here;
 *   - the dedicated-fleet census/jobs repositories, which would otherwise open
 *     a real database — the fleet monitor's own logic runs for real.
 *
 * Asserts the dead-alert gap is closed: when the daemon heartbeat is
 * absent or stale, the route returns `healthy:false` AND the alert callback
 * actually fires (structured error log + Slack channel POST). The healthy path
 * stays silent, and an invalid cron secret is rejected before any check runs.
 *
 * Also asserts the failure-isolation boundary (#22548): the two monitors are
 * independent questions sharing a schedule, so a rejection in either one must
 * NOT prevent the other from running and alerting, while the cron still
 * answers with a structured failure.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { ProvisioningWorkerHealth } from "@/lib/services/provisioning-worker-health";

const checkProvisioningWorkerHealth = mock(
  async (): Promise<ProvisioningWorkerHealth> => ({
    ok: true,
    required: false,
  }),
);

const loggerError = mock(() => undefined);
const writeCloudApiDbHeartbeat = mock(async () => undefined);

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

mock.module("@/lib/services/cloud-api-db-heartbeat", () => ({
  writeCloudApiDbHeartbeat,
}));

// The fleet monitor's own logic runs for real; only its two data sources are
// stubbed so no database is opened. `summarizeDedicatedFleet` returns the real
// grouped tier/status census shape.
type FleetCensusRow = { execution_tier: string; status: string; count: number };
let fleetCensus: FleetCensusRow[] = [];
let fleetCensusError: Error | null = null;
const summarizeDedicatedFleet = mock(async (): Promise<FleetCensusRow[]> => {
  if (fleetCensusError) throw fleetCensusError;
  return fleetCensus;
});
const summarizeOutcomesByTypeSince = mock(
  async (): Promise<Array<{ status: string; count: number }>> => [],
);

const unsupportedRepositoryHelper = (name: string) => () => {
  throw new Error(
    `${name} is outside the provisioning-worker-health test fixture`,
  );
};

mock.module("@/db/repositories/agent-sandboxes", () => ({
  PRE_DELETE_BACKUP_RETENTION_MS: 30 * 24 * 60 * 60 * 1000,
  agentSandboxesRepository: { summarizeDedicatedFleet },
  prepareAgentBackupInsertData: unsupportedRepositoryHelper(
    "prepareAgentBackupInsertData",
  ),
}));

mock.module("@/db/repositories/jobs", () => ({
  StaleJobExecutionError: class StaleJobExecutionError extends Error {},
  cutoverResumeWindowAllows: ({
    cutoverAtMs,
    rowStartedAtMs,
    rowUpdatedAtMs,
  }: {
    cutoverAtMs: number;
    rowStartedAtMs: number;
    rowUpdatedAtMs: number;
  }) => cutoverAtMs <= rowStartedAtMs && rowStartedAtMs <= rowUpdatedAtMs,
  hydrateJob: unsupportedRepositoryHelper("hydrateJob"),
  jobsRepository: { summarizeOutcomesByTypeSince },
  msWindowTimestampMatch: unsupportedRepositoryHelper("msWindowTimestampMatch"),
  prepareJobInsertData: unsupportedRepositoryHelper("prepareJobInsertData"),
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
  writeCloudApiDbHeartbeat.mockClear();
  fetchMock.mockClear();
  fetchCalls.length = 0;
  summarizeDedicatedFleet.mockClear();
  summarizeOutcomesByTypeSince.mockClear();
  fleetCensus = [];
  fleetCensusError = null;
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
    expect(writeCloudApiDbHeartbeat).toHaveBeenCalledTimes(1);

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

  test("invalid cron secret -> rejected before either monitor is ever run", async () => {
    const response = await hitCron("wrong-secret");
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(checkProvisioningWorkerHealth).not.toHaveBeenCalled();
    expect(writeCloudApiDbHeartbeat).not.toHaveBeenCalled();
    expect(summarizeDedicatedFleet).not.toHaveBeenCalled();
  });

  // #22548 blocker 2: the monitors are independent questions on a shared
  // schedule. Sequencing them meant one unhealthy monitoring dependency
  // silenced the other — the exact silence this cron exists to prevent.
  test("the fleet alert still fires when the sibling heartbeat monitor REJECTS", async () => {
    checkProvisioningWorkerHealth.mockRejectedValueOnce(
      new Error("redis gate unreachable"),
    );
    fleetCensus = [
      { execution_tier: "dedicated-always", status: "error", count: 26 },
    ];

    const response = await hitCron();

    // The fleet census ran despite the sibling rejection...
    expect(summarizeDedicatedFleet).toHaveBeenCalledTimes(1);
    // ...and its alert actually reached the ops channel.
    const slackPost = fetchCalls.find((c) => c.url === SLACK_WEBHOOK);
    expect(slackPost).toBeDefined();
    expect(JSON.stringify(slackPost?.body)).toContain(
      "Dedicated agent fleet is unreachable",
    );

    // The cron still answers with a structured failure naming the dead monitor.
    expect(response.status).toBe(500);
    const body = (await response.json()) as {
      success: boolean;
      code: string;
      monitors: {
        heartbeat: { ok: boolean; error?: string };
        fleet: { ok: boolean };
      };
      fleet: { unreachable: boolean } | null;
    };
    expect(body.success).toBe(false);
    expect(body.code).toBe("cron_monitor_failed");
    expect(body.monitors.heartbeat.ok).toBe(false);
    expect(body.monitors.heartbeat.error).toContain("redis gate unreachable");
    expect(body.monitors.fleet.ok).toBe(true);
    expect(body.fleet?.unreachable).toBe(true);
  });

  test("the heartbeat alert still fires when the fleet census REJECTS", async () => {
    checkProvisioningWorkerHealth.mockResolvedValueOnce({
      ok: false,
      required: true,
      status: 503,
      code: "PROVISIONING_WORKER_UNHEALTHY",
      error:
        "Provisioning worker has not reported a heartbeat in the last 60 seconds.",
    });
    fleetCensusError = new Error("fleet census query failed");

    const response = await hitCron();

    const slackPost = fetchCalls.find((c) => c.url === SLACK_WEBHOOK);
    expect(slackPost).toBeDefined();
    expect(JSON.stringify(slackPost?.body)).toContain(
      "Provisioning worker is unhealthy",
    );

    expect(response.status).toBe(500);
    const body = (await response.json()) as {
      code: string;
      healthy: boolean;
      monitors: {
        heartbeat: { ok: boolean };
        fleet: { ok: boolean; error?: string };
      };
      fleet: unknown;
    };
    expect(body.code).toBe("cron_monitor_failed");
    // The healthy monitor's answer is preserved, not discarded.
    expect(body.healthy).toBe(false);
    expect(body.monitors.heartbeat.ok).toBe(true);
    expect(body.monitors.fleet.ok).toBe(false);
    expect(body.monitors.fleet.error).toContain("fleet census query failed");
    expect(body.fleet).toBeNull();
  });

  // #22548 blocker 1, at the route boundary: a fleet of healthy sleeping
  // dedicated-lazy agents has rows but nothing running, and must stay silent.
  test("a fleet of sleeping dedicated-lazy agents does NOT page", async () => {
    checkProvisioningWorkerHealth.mockResolvedValueOnce({
      ok: true,
      required: true,
      lastHeartbeatAt: new Date(Date.now() - 1_000).toISOString(),
    });
    fleetCensus = [
      { execution_tier: "dedicated-lazy", status: "sleeping", count: 40 },
      { execution_tier: "dedicated-lazy", status: "stopped", count: 5 },
    ];

    const response = await hitCron();
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      fleet: {
        fleetTotal: number;
        expectedReachableTotal: number;
        unreachable: boolean;
      };
    };
    expect(body.fleet.fleetTotal).toBe(45);
    expect(body.fleet.expectedReachableTotal).toBe(0);
    expect(body.fleet.unreachable).toBe(false);
    expect(fetchCalls.some((c) => c.url === SLACK_WEBHOOK)).toBe(false);
  });
});

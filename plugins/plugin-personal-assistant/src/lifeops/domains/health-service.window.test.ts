/**
 * HealthDomain's default health window for owners away from UTC. Daily
 * samples are keyed by local date, so their window ends on the owner's date;
 * workouts and connector sync bound by instants (dates read as UTC days), so
 * their end must still reach the present. Deterministic: fake clock, stubbed
 * repository, connector sync replaced at the plugin-health boundary.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LifeOpsContext } from "../lifeops-context.js";
import { HealthDomain } from "./health-service.js";

const plugin = vi.hoisted(() => ({
  syncHealthConnectorData: vi.fn(async () => ({
    samples: [],
    workouts: [],
    sleepEpisodes: [],
  })),
}));

vi.mock("@elizaos/plugin-health", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@elizaos/plugin-health")>()),
  refreshStoredHealthToken: vi.fn(async () => ({ accessToken: "token" })),
  syncHealthConnectorData: plugin.syncHealthConnectorData,
}));

function domain(timeZone: string) {
  const repository = {
    listConnectorGrants: vi.fn(async () => []),
    getConnectorGrant: vi.fn(async () => null),
    getHealthSyncState: vi.fn(async () => null),
    upsertHealthSyncState: vi.fn(async () => undefined),
    upsertConnectorGrant: vi.fn(async () => undefined),
    listHealthMetricSamples: vi.fn(async () => []),
    listHealthWorkouts: vi.fn(async () => []),
    listHealthSleepEpisodes: vi.fn(async () => []),
  };
  const health = new HealthDomain({
    repository,
    agentId: () => "agent-1",
    logLifeOpsWarn: (...args: unknown[]) => {
      throw new Error(`unexpected LifeOps warning: ${JSON.stringify(args)}`);
    },
    runtime: {
      getSetting: (key: string) => (key === "TIMEZONE" ? timeZone : undefined),
    },
  } as unknown as LifeOpsContext);
  return { health, repository };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  plugin.syncHealthConnectorData.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("keeps a west-of-UTC owner's evening workouts in the default summary", async () => {
  // 23:30 PDT Oct 5 in Los Angeles is already Oct 6 in UTC.
  vi.setSystemTime(new Date("2026-10-06T06:30:00.000Z"));
  const { health, repository } = domain("America/Los_Angeles");

  await health.getHealthSummary({ provider: "strava", days: 1 });

  expect(repository.listHealthMetricSamples).toHaveBeenCalledWith(
    "agent-1",
    expect.objectContaining({ startDate: "2026-10-05", endDate: "2026-10-05" }),
  );
  // A 19:00 PDT workout (02:00Z Oct 6) is inside start_at <= 2026-10-06T23:59Z.
  expect(repository.listHealthWorkouts).toHaveBeenCalledWith(
    "agent-1",
    expect.objectContaining({ startDate: "2026-10-05", endDate: "2026-10-06" }),
  );
});

it("syncs connectors through the present for owners on either side of UTC", async () => {
  for (const [timeZone, now, expectedEnd] of [
    ["America/Los_Angeles", "2026-10-06T06:30:00.000Z", "2026-10-06"],
    ["Asia/Tokyo", "2026-10-05T23:00:00.000Z", "2026-10-06"],
  ] as const) {
    vi.setSystemTime(new Date(now));
    plugin.syncHealthConnectorData.mockClear();
    const { health } = domain(timeZone);
    vi.spyOn(health, "getHealthDataConnectorStatus").mockResolvedValue({
      provider: "strava",
      connected: true,
      grant: { id: "grant-1", tokenRef: "agent-1/owner/local/strava.json" },
    } as never);

    await health.getHealthSummary({
      provider: "strava",
      days: 2,
      forceSync: true,
    });

    expect(plugin.syncHealthConnectorData).toHaveBeenCalledWith(
      expect.objectContaining({ endDate: expectedEnd }),
    );
  }
});

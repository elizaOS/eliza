import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LifeOpsHealthConnectorStatus,
  LifeOpsHealthDailySummary,
  LifeOpsHealthMetricSample,
  LifeOpsHealthSleepEpisode,
  LifeOpsHealthSummaryResponse,
  LifeOpsHealthWorkout,
} from "../contracts/index.js";
import {
  createLifeOpsHealthMetricSample,
  createLifeOpsHealthSleepEpisode,
  createLifeOpsHealthWorkout,
} from "../lifeops/repository.js";

const { getHealthSummaryMock, hasLifeOpsAccessMock } = vi.hoisted(() => ({
  getHealthSummaryMock: vi.fn(),
  hasLifeOpsAccessMock: vi.fn(),
}));

vi.mock("../actions/lifeops-google-helpers.js", () => ({
  hasLifeOpsAccess: hasLifeOpsAccessMock,
}));

vi.mock("../lifeops/service.js", () => ({
  LifeOpsService: class {
    getHealthSummary = getHealthSummaryMock;
  },
}));

import { healthProvider } from "./health.js";

function connectorStatus(
  overrides: Partial<LifeOpsHealthConnectorStatus> = {},
): LifeOpsHealthConnectorStatus {
  return {
    provider: "strava",
    side: "owner",
    mode: "local",
    defaultMode: "local",
    availableModes: ["local"],
    executionTarget: "local",
    sourceOfTruth: "local_storage",
    configured: true,
    connected: false,
    reason: "disconnected",
    identity: null,
    grantedCapabilities: [],
    grantedScopes: [],
    expiresAt: null,
    hasRefreshToken: false,
    lastSyncAt: null,
    grant: null,
    ...overrides,
  };
}

function dailySummary(
  overrides: Partial<LifeOpsHealthDailySummary> = {},
): LifeOpsHealthDailySummary {
  return {
    date: "2026-04-20",
    provider: "strava",
    steps: 0,
    activeMinutes: 0,
    sleepHours: 0,
    calories: null,
    distanceMeters: null,
    heartRateAvg: null,
    restingHeartRate: null,
    hrvMs: null,
    sleepScore: null,
    readinessScore: null,
    weightKg: null,
    bloodPressureSystolic: null,
    bloodPressureDiastolic: null,
    bloodOxygenPercent: null,
    ...overrides,
  };
}

function summaryResponse(
  overrides: Partial<LifeOpsHealthSummaryResponse> = {},
): LifeOpsHealthSummaryResponse {
  return {
    providers: [],
    summaries: [],
    samples: [],
    workouts: [],
    sleepEpisodes: [],
    syncedAt: "2026-04-20T12:00:00.000Z",
    ...overrides,
  };
}

function metricSample(sourceExternalId: string): LifeOpsHealthMetricSample {
  return createLifeOpsHealthMetricSample({
    agentId: "owner",
    provider: "strava",
    grantId: "grant-strava",
    metric: "steps",
    value: 1,
    unit: "count",
    startAt: "2026-04-20T12:00:00.000Z",
    endAt: "2026-04-20T12:00:00.000Z",
    localDate: "2026-04-20",
    sourceExternalId,
    metadata: {},
  });
}

function workout(sourceExternalId: string): LifeOpsHealthWorkout {
  return createLifeOpsHealthWorkout({
    agentId: "owner",
    provider: "strava",
    grantId: "grant-strava",
    sourceExternalId,
    workoutType: "run",
    title: "Run",
    startAt: "2026-04-20T12:00:00.000Z",
    endAt: "2026-04-20T12:30:00.000Z",
    durationSeconds: 1800,
    distanceMeters: 5000,
    calories: 300,
    averageHeartRate: null,
    maxHeartRate: null,
    metadata: {},
  });
}

function sleepEpisode(sourceExternalId: string): LifeOpsHealthSleepEpisode {
  return createLifeOpsHealthSleepEpisode({
    agentId: "owner",
    provider: "strava",
    grantId: "grant-strava",
    sourceExternalId,
    localDate: "2026-04-20",
    timezone: null,
    startAt: "2026-04-19T22:00:00.000Z",
    endAt: "2026-04-20T06:00:00.000Z",
    isMainSleep: true,
    sleepType: "summary",
    durationSeconds: 28800,
    timeInBedSeconds: null,
    efficiency: null,
    latencySeconds: null,
    awakeSeconds: null,
    lightSleepSeconds: null,
    deepSleepSeconds: null,
    remSleepSeconds: null,
    sleepScore: null,
    readinessScore: null,
    averageHeartRate: null,
    lowestHeartRate: null,
    averageHrvMs: null,
    respiratoryRate: null,
    bloodOxygenPercent: null,
    stageSamples: [],
    metadata: {},
  });
}

describe("healthProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hasLifeOpsAccessMock.mockResolvedValue(true);
    getHealthSummaryMock.mockResolvedValue(summaryResponse());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns an empty provider result when the sender is not the owner", async () => {
    hasLifeOpsAccessMock.mockResolvedValue(false);

    const result = await healthProvider.get(
      { agentId: "owner" } as never,
      { entityId: "other" } as never,
      {} as never,
    );

    expect(result).toEqual({ text: "", values: {}, data: {} });
    expect(getHealthSummaryMock).not.toHaveBeenCalled();
  });

  it("formats connected health summary context for the owner only", async () => {
    getHealthSummaryMock.mockResolvedValue(
      summaryResponse({
        providers: [
          connectorStatus({
            connected: true,
            reason: "connected",
            identity: { username: "runner" },
          }),
        ],
        summaries: [
          dailySummary({
            steps: 8420,
            activeMinutes: 47,
            sleepHours: 7.25,
            heartRateAvg: 63,
            weightKg: 72.4,
          }),
        ],
        samples: [metricSample("sample-1"), metricSample("sample-2")],
        workouts: [workout("workout-1")],
        sleepEpisodes: [sleepEpisode("sleep-1")],
      }),
    );

    const result = await healthProvider.get(
      { agentId: "owner" } as never,
      { entityId: "owner" } as never,
      {} as never,
    );

    expect(getHealthSummaryMock).toHaveBeenCalledWith({ days: 3 });
    expect(result.text).toContain("Health connectors: strava");
    expect(result.text).toContain("8420 steps");
    expect(result.text).toContain("47 active min");
    expect(result.text).toContain("7.3h sleep");
    expect(result.values).toMatchObject({
      healthConnectedProviderCount: 1,
      healthConnectedProviders: ["strava"],
      healthSampleCount: 2,
      healthWorkoutCount: 1,
      healthSleepEpisodeCount: 1,
    });
  });
});

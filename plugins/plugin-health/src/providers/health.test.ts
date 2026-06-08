import { describe, expect, it, vi } from "vitest";
import type { LifeOpsHealthSummaryResponse } from "../contracts/health.js";
import { buildHealthProviderResult, createHealthProvider } from "./health.js";

function summary(
  overrides: Partial<LifeOpsHealthSummaryResponse> = {},
): LifeOpsHealthSummaryResponse {
  return {
    providers: [],
    summaries: [],
    samples: [],
    workouts: [],
    sleepEpisodes: [],
    syncedAt: "2026-05-30T12:00:00.000Z",
    ...overrides,
  };
}

describe("health provider", () => {
  it("formats compact connector and metric context from plugin-health contracts", () => {
    const result = buildHealthProviderResult(
      summary({
        providers: [
          {
            provider: "oura",
            connected: true,
          },
          {
            provider: "fitbit",
            connected: false,
          },
        ] as LifeOpsHealthSummaryResponse["providers"],
        summaries: [
          {
            provider: "oura",
            date: "2026-05-30",
            steps: 1234.4,
            activeMinutes: 45.2,
            sleepHours: 7.35,
            calories: null,
            distanceMeters: null,
            heartRateAvg: 62.2,
            restingHeartRate: null,
            hrvMs: null,
            sleepScore: null,
            readinessScore: null,
            weightKg: 63.25,
            bloodPressureSystolic: null,
            bloodPressureDiastolic: null,
            bloodOxygenPercent: null,
          },
        ],
      }),
    );

    expect(result.text).toContain("Health connectors: oura");
    expect(result.text).toContain(
      "oura 2026-05-30 | 1234 steps | 45 active min | 7.3h sleep | 62 bpm | 63.3 kg",
    );
    expect(result.values).toMatchObject({
      healthConnectedProviderCount: 1,
      healthConnectedProviders: ["oura"],
    });
  });

  it("keeps host access and summary loading as injected adapters", async () => {
    const getSummary = vi.fn(async () => summary());
    const provider = createHealthProvider({
      hasAccess: async () => false,
      getSummary,
    });

    const result = await provider.get({} as never, {} as never, {} as never);

    expect(result).toEqual({ text: "", values: {}, data: {} });
    expect(getSummary).not.toHaveBeenCalled();
  });
});

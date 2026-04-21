import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LifeOpsScheduleSyncClient } from "../src/lifeops/schedule-sync-client.js";

const MERGED_STATE = {
  id: "merged-1",
  agentId: "agent-1",
  scope: "cloud" as const,
  mergedAt: "2026-04-19T13:00:00.000Z",
  effectiveDayKey: "2026-04-19",
  localDate: "2026-04-19",
  timezone: "UTC",
  inferredAt: "2026-04-19T13:00:00.000Z",
  phase: "afternoon" as const,
  sleepStatus: "slept" as const,
  isProbablySleeping: false,
  sleepConfidence: 0.77,
  currentSleepStartedAt: null,
  lastSleepStartedAt: "2026-04-18T23:30:00.000Z",
  lastSleepEndedAt: "2026-04-19T07:30:00.000Z",
  lastSleepDurationMinutes: 480,
  typicalWakeHour: 7.5,
  typicalSleepHour: 23.5,
  wakeAt: "2026-04-19T07:30:00.000Z",
  firstActiveAt: "2026-04-19T07:30:00.000Z",
  lastActiveAt: "2026-04-19T12:30:00.000Z",
  meals: [],
  lastMealAt: null,
  nextMealLabel: "lunch" as const,
  nextMealWindowStartAt: "2026-04-19T13:00:00.000Z",
  nextMealWindowEndAt: "2026-04-19T15:00:00.000Z",
  nextMealConfidence: 0.6,
  observationCount: 3,
  deviceCount: 2,
  contributingDeviceKinds: ["iphone", "mac"] as const,
  metadata: {},
  createdAt: "2026-04-19T13:00:00.000Z",
  updatedAt: "2026-04-19T13:00:00.000Z",
};

describe("LifeOpsScheduleSyncClient", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];

  beforeEach(() => {
    requests.length = 0;
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input, init) => {
        requests.push({
          url: typeof input === "string" ? input : input.toString(),
          init,
        });
        return new Response(
          JSON.stringify({
            acceptedCount: 1,
            mergedState: MERGED_STATE,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      },
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("targets the local remote agent schedule routes with bearer auth", async () => {
    const client = new LifeOpsScheduleSyncClient({
      configured: true,
      mode: "remote",
      baseUrl: "https://agent.example.test/",
      accessToken: "remote-token",
    });

    await client.syncObservations({
      deviceId: "macbook-1",
      deviceKind: "mac",
      timezone: "UTC",
      observations: [
        {
          state: "active_recently",
          windowStartAt: "2026-04-19T12:30:00.000Z",
          confidence: 0.7,
        },
      ],
    });
    await client.getMergedState("UTC");

    expect(requests[0]?.url).toBe(
      "https://agent.example.test/api/lifeops/schedule/observations",
    );
    expect((requests[0]?.init?.headers as Record<string, string>)?.Authorization).toBe(
      "Bearer remote-token",
    );
    expect(requests[1]?.url).toBe(
      "https://agent.example.test/api/lifeops/schedule/merged-state?timezone=UTC&scope=cloud",
    );
  });

  it("targets the cloud-managed schedule routes with X-API-Key auth", async () => {
    const client = new LifeOpsScheduleSyncClient({
      configured: true,
      mode: "cloud",
      apiBaseUrl: "https://cloud.example.test/api/v1",
      apiKey: "cloud-key",
      agentId: "agent-123",
    });

    await client.syncObservations({
      deviceId: "iphone-1",
      deviceKind: "iphone",
      timezone: "UTC",
      observations: [
        {
          state: "woke_recently",
          windowStartAt: "2026-04-19T11:30:00.000Z",
          confidence: 0.8,
        },
      ],
    });

    expect(requests[0]?.url).toBe(
      "https://cloud.example.test/api/v1/milady/agents/agent-123/lifeops/schedule/observations",
    );
    expect((requests[0]?.init?.headers as Record<string, string>)?.["X-API-Key"]).toBe(
      "cloud-key",
    );
  });
});

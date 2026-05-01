import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LifeOpsHealthMetric,
  LifeOpsHealthMetricSample,
} from "../contracts/index.js";
import {
  HealthConnectorApiError,
  syncHealthConnectorData,
} from "./health-connectors.js";
import type { StoredHealthConnectorToken } from "./health-oauth.js";

const ORIGINAL_ENV = { ...process.env };

function tokenFor(
  provider: StoredHealthConnectorToken["provider"],
): StoredHealthConnectorToken {
  return {
    provider,
    agentId: "agent-health-test",
    side: "owner",
    mode: "local",
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://127.0.0.1:31337/callback",
    accessToken: `${provider}-access-token`,
    refreshToken: `${provider}-refresh-token`,
    tokenType: "Bearer",
    grantedScopes: [],
    expiresAt: null,
    identity: {},
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fetchUrl(input: Parameters<typeof fetch>[0]): URL {
  return new URL(
    typeof input === "string" || input instanceof URL
      ? String(input)
      : input.url,
  );
}

function findSample(
  samples: readonly LifeOpsHealthMetricSample[],
  metric: LifeOpsHealthMetric,
): LifeOpsHealthMetricSample {
  const found = samples.find((sample) => sample.metric === metric);
  if (!found) {
    throw new Error(`Missing ${metric} sample`);
  }
  return found;
}

describe("syncHealthConnectorData", () => {
  beforeEach(() => {
    process.env.MILADY_MOCK_HEALTH_BASE = "http://127.0.0.1:9876";
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("maps Strava activities into workouts and metric samples", async () => {
    const fetchMock = vi.fn(async (...[input]: Parameters<typeof fetch>) => {
      const url = fetchUrl(input);
      if (url.pathname === "/athlete") {
        return jsonResponse({ id: 123, username: "owner" });
      }
      if (url.pathname === "/athlete/activities") {
        expect(url.searchParams.get("per_page")).toBe("200");
        return jsonResponse([
          {
            id: "activity-1",
            name: "Morning run",
            sport_type: "Run",
            start_date: "2026-04-20T07:00:00.000Z",
            elapsed_time: 3600,
            moving_time: 3300,
            distance: 10000,
            calories: 720,
            average_heartrate: 145,
            max_heartrate: 181,
            total_elevation_gain: 90,
          },
        ]);
      }
      return jsonResponse({ error: "unexpected path" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    const payload = await syncHealthConnectorData({
      token: tokenFor("strava"),
      grantId: "grant-strava",
      startDate: "2026-04-20",
      endDate: "2026-04-20",
    });

    expect(payload.identity).toMatchObject({ username: "owner" });
    expect(payload.workouts).toHaveLength(1);
    expect(payload.workouts[0]).toMatchObject({
      provider: "strava",
      sourceExternalId: "activity-1",
      workoutType: "Run",
      durationSeconds: 3300,
      distanceMeters: 10000,
    });
    expect(findSample(payload.samples, "active_minutes").value).toBe(55);
    expect(findSample(payload.samples, "distance_meters").value).toBe(10000);
    expect(findSample(payload.samples, "heart_rate").value).toBe(145);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer strava-access-token",
      });
    }
  });

  it("maps Fitbit activity, sleep stages, heart rate, and weight without a device", async () => {
    const fetchMock = vi.fn(async (...[input]: Parameters<typeof fetch>) => {
      const url = fetchUrl(input);
      switch (url.pathname) {
        case "/1/user/-/profile.json":
          return jsonResponse({ user: { encodedId: "fitbit-user" } });
        case "/1/user/-/activities/date/2026-04-20.json":
          return jsonResponse({
            summary: {
              steps: 10000,
              fairlyActiveMinutes: 20,
              veryActiveMinutes: 40,
              caloriesOut: 2500,
              distances: [{ activity: "total", distance: 8.5 }],
            },
          });
        case "/1.2/user/-/sleep/date/2026-04-20.json":
          return jsonResponse({
            summary: { totalMinutesAsleep: 450 },
            sleep: [
              {
                logId: "sleep-1",
                startTime: "2026-04-19T22:30:00.000Z",
                endTime: "2026-04-20T06:00:00.000Z",
                isMainSleep: true,
                type: "stages",
                duration: 27_000_000,
                timeInBed: 460,
                efficiency: 91,
                minutesToFallAsleep: 10,
                minutesAwake: 20,
                dateOfSleep: "2026-04-20",
                levels: {
                  data: [
                    {
                      dateTime: "2026-04-19T22:30:00.000Z",
                      level: "light",
                      seconds: 1200,
                    },
                    {
                      dateTime: "2026-04-19T22:50:00.000Z",
                      level: "rem",
                      seconds: 900,
                    },
                  ],
                },
              },
            ],
          });
        case "/1/user/-/activities/heart/date/2026-04-20/1d.json":
          return jsonResponse({
            "activities-heart": [
              { dateTime: "2026-04-20", value: { restingHeartRate: 58 } },
            ],
          });
        case "/1/user/-/body/log/weight/date/2026-04-20.json":
          return jsonResponse({
            weight: [
              {
                date: "2026-04-20",
                time: "07:00:00",
                weight: 72.5,
                logId: "weight-1",
                weightUnit: "kg",
              },
            ],
          });
        default:
          return jsonResponse(
            { error: `unexpected path ${url.pathname}` },
            404,
          );
      }
    });
    vi.stubGlobal("fetch", fetchMock);

    const payload = await syncHealthConnectorData({
      token: tokenFor("fitbit"),
      grantId: "grant-fitbit",
      startDate: "2026-04-20",
      endDate: "2026-04-20",
    });

    expect(payload.identity).toMatchObject({ encodedId: "fitbit-user" });
    expect(findSample(payload.samples, "steps").value).toBe(10000);
    expect(findSample(payload.samples, "active_minutes").value).toBe(60);
    expect(findSample(payload.samples, "distance_meters").value).toBe(8500);
    expect(findSample(payload.samples, "sleep_hours").value).toBe(7.5);
    expect(findSample(payload.samples, "resting_heart_rate").value).toBe(58);
    expect(findSample(payload.samples, "weight_kg").value).toBe(72.5);
    expect(payload.sleepEpisodes).toHaveLength(1);
    expect(payload.sleepEpisodes[0].stageSamples).toEqual([
      expect.objectContaining({ stage: "light" }),
      expect.objectContaining({ stage: "rem" }),
    ]);
  });

  it("maps paginated Oura activity, readiness, sleep, heart rate, and workouts", async () => {
    const fetchMock = vi.fn(async (...[input]: Parameters<typeof fetch>) => {
      const url = fetchUrl(input);
      if (url.pathname === "/v2/usercollection/personal_info") {
        return jsonResponse({ data: { email: "owner@example.test" } });
      }
      if (url.pathname === "/v2/usercollection/daily_activity") {
        if (url.searchParams.get("next_token") === "page-2") {
          return jsonResponse({
            data: [
              {
                id: "activity-2",
                day: "2026-04-21",
                steps: 9000,
                total_calories: 2300,
                equivalent_walking_distance: 6500,
              },
            ],
          });
        }
        return jsonResponse({
          data: [
            {
              id: "activity-1",
              day: "2026-04-20",
              steps: 8000,
              total_calories: 2200,
              equivalent_walking_distance: 6000,
            },
          ],
          next_token: "page-2",
        });
      }
      if (url.pathname === "/v2/usercollection/daily_readiness") {
        return jsonResponse({
          data: [{ id: "ready-1", day: "2026-04-20", score: 83 }],
        });
      }
      if (url.pathname === "/v2/usercollection/sleep") {
        return jsonResponse({
          data: [
            {
              id: "sleep-1",
              day: "2026-04-20",
              bedtime_start: "2026-04-19T22:00:00.000Z",
              bedtime_end: "2026-04-20T06:30:00.000Z",
              type: "long_sleep",
              total_sleep_duration: 28_800,
              time_in_bed: 30_600,
              efficiency: 93,
              latency: 600,
              awake_time: 1800,
              light_sleep_duration: 14_400,
              deep_sleep_duration: 5400,
              rem_sleep_duration: 7200,
              score: 88,
              average_heart_rate: 54,
              lowest_heart_rate: 48,
              average_hrv: 62,
              average_breath: 14.5,
            },
          ],
        });
      }
      if (url.pathname === "/v2/usercollection/heartrate") {
        return jsonResponse({
          data: [
            {
              id: "hr-1",
              timestamp: "2026-04-20T08:00:00.000Z",
              bpm: 62,
              source: "awake",
            },
          ],
        });
      }
      if (url.pathname === "/v2/usercollection/workout") {
        return jsonResponse({
          data: [
            {
              id: "workout-1",
              activity: "cycling",
              start_datetime: "2026-04-20T17:00:00.000Z",
              end_datetime: "2026-04-20T18:00:00.000Z",
              distance: 20_000,
              calories: 500,
            },
          ],
        });
      }
      return jsonResponse({ error: `unexpected path ${url.pathname}` }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    const payload = await syncHealthConnectorData({
      token: tokenFor("oura"),
      grantId: "grant-oura",
      startDate: "2026-04-20",
      endDate: "2026-04-21",
    });

    expect(payload.identity).toMatchObject({ email: "owner@example.test" });
    expect(
      payload.samples.filter((sample) => sample.metric === "steps"),
    ).toHaveLength(2);
    expect(findSample(payload.samples, "readiness_score").value).toBe(83);
    expect(findSample(payload.samples, "sleep_score").value).toBe(88);
    expect(findSample(payload.samples, "heart_rate").value).toBe(62);
    expect(payload.sleepEpisodes[0]).toMatchObject({
      provider: "oura",
      sourceExternalId: "sleep-1",
      durationSeconds: 28800,
      sleepScore: 88,
      averageHrvMs: 62,
    });
    expect(payload.workouts[0]).toMatchObject({
      provider: "oura",
      workoutType: "cycling",
      durationSeconds: 3600,
      distanceMeters: 20000,
    });
  });

  it("maps Withings activity, sleep summaries, and body measures", async () => {
    const sleepStart = Math.floor(
      Date.parse("2026-04-19T22:00:00.000Z") / 1000,
    );
    const sleepEnd = Math.floor(Date.parse("2026-04-20T05:30:00.000Z") / 1000);
    const measureAt = Math.floor(Date.parse("2026-04-20T07:00:00.000Z") / 1000);
    const fetchMock = vi.fn(async (...[, init]: Parameters<typeof fetch>) => {
      const form =
        init?.body instanceof URLSearchParams
          ? init.body
          : new URLSearchParams();
      const action = form.get("action");
      if (action === "getactivity") {
        return jsonResponse({
          status: 0,
          body: {
            activities: [
              {
                date: "2026-04-20",
                steps: 7000,
                active: 50,
                totalcalories: 2100,
                distance: 5000,
                hr_average: 70,
                hr_resting: 55,
              },
            ],
          },
        });
      }
      if (action === "getsummary") {
        return jsonResponse({
          status: 0,
          body: {
            series: [
              {
                id: "sleep-1",
                startdate: sleepStart,
                enddate: sleepEnd,
                timezone: "UTC",
                data: {
                  total_sleep_time: 27_000,
                  wakeupduration: 1200,
                  durationtosleep: 600,
                  lightduration: 12_000,
                  deepduration: 6000,
                  remduration: 6000,
                  hr_average: 58,
                  hr_min: 47,
                  rr_average: 14,
                },
              },
            ],
          },
        });
      }
      if (action === "getmeas") {
        return jsonResponse({
          status: 0,
          body: {
            measuregrps: [
              {
                grpid: "measure-1",
                date: measureAt,
                measures: [
                  { type: 1, value: 725, unit: -1 },
                  { type: 10, value: 120, unit: 0 },
                  { type: 9, value: 80, unit: 0 },
                  { type: 54, value: 98, unit: 0 },
                ],
              },
            ],
          },
        });
      }
      return jsonResponse({ status: 400, error: "unexpected action" }, 400);
    });
    vi.stubGlobal("fetch", fetchMock);

    const payload = await syncHealthConnectorData({
      token: tokenFor("withings"),
      grantId: "grant-withings",
      startDate: "2026-04-20",
      endDate: "2026-04-20",
    });

    expect(findSample(payload.samples, "steps").value).toBe(7000);
    expect(findSample(payload.samples, "active_minutes").value).toBe(50);
    expect(findSample(payload.samples, "sleep_hours").value).toBe(7.5);
    expect(findSample(payload.samples, "weight_kg").value).toBe(72.5);
    expect(findSample(payload.samples, "blood_pressure_systolic").value).toBe(
      120,
    );
    expect(findSample(payload.samples, "blood_pressure_diastolic").value).toBe(
      80,
    );
    expect(findSample(payload.samples, "blood_oxygen_percent").value).toBe(98);
    expect(payload.sleepEpisodes[0]).toMatchObject({
      provider: "withings",
      sourceExternalId: "sleep-1",
      durationSeconds: 27000,
      averageHeartRate: 58,
      respiratoryRate: 14,
    });
  });

  it("refuses non-loopback mock connector bases", async () => {
    process.env.MILADY_MOCK_HEALTH_BASE = "https://mock.example.test";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      syncHealthConnectorData({
        token: tokenFor("strava"),
        grantId: "grant-strava",
        startDate: "2026-04-20",
        endDate: "2026-04-20",
      }),
    ).rejects.toBeInstanceOf(HealthConnectorApiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

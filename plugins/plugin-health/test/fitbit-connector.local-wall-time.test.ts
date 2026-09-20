/**
 * Regression coverage for Fitbit's offset-less wall-clock timestamps. Sleep
 * `startTime` / `endTime`, sleep stage `dateTime`, and weight `date` + `time`
 * arrive without a zone designator and are wall times in the account's profile
 * zone, so the normalizer must resolve them through `profile.user.timezone`
 * instead of the host's clock. The harness stubs `fetch` with Fitbit's
 * documented sleep-log example and runs the real `syncHealthConnectorData`
 * under three host `TZ` values, asserting identical, Los Angeles-correct
 * instants each time. Deterministic; no network.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HealthConnectorApiError,
  syncHealthConnectorData,
} from "../src/health-bridge/health-connectors.js";
import type { StoredHealthConnectorToken } from "../src/health-bridge/health-oauth.js";

const token: StoredHealthConnectorToken = {
  provider: "fitbit",
  agentId: "agent-fitbit",
  side: "owner",
  mode: "local",
  clientId: "test-client",
  clientSecret: "test-secret",
  redirectUri: "http://127.0.0.1/redirect",
  accessToken: "test-access-token",
  refreshToken: "test-refresh-token",
  tokenType: "Bearer",
  grantedScopes: ["profile", "activity", "heartrate", "sleep", "weight"],
  expiresAt: null,
  identity: {},
  createdAt: "2026-05-01T00:00:00.000Z",
  updatedAt: "2026-05-01T00:00:00.000Z",
};

const PROFILE_ZONE = "America/Los_Angeles";
// Fitbit reports the account's CURRENT offset; -08:00 is PST (winter).
const PST_OFFSET_MILLIS = -8 * 60 * 60 * 1_000;

function profile(user: Record<string, unknown>): Record<string, unknown> {
  return {
    user: {
      encodedId: "GGNJL9",
      fullName: "Ada Lovelace",
      distanceUnit: "en_US",
      weightUnit: "METRIC",
      ...user,
    },
  };
}

// Fitbit "Get Sleep Log by Date" documented example response (stages log).
// https://dev.fitbit.com/build/reference/web-api/sleep/get-sleep-log-by-date/
const documentedSleepLog = {
  summary: {
    stages: { deep: 92, light: 245, rem: 74, wake: 51 },
    totalMinutesAsleep: 411,
    totalSleepRecords: 1,
    totalTimeInBed: 462,
  },
  sleep: [
    {
      dateOfSleep: "2020-02-21",
      duration: 27720000,
      efficiency: 96,
      endTime: "2020-02-21T07:21:30.000",
      infoCode: 0,
      isMainSleep: true,
      levels: {
        data: [
          { dateTime: "2020-02-20T23:38:30.000", level: "wake", seconds: 30 },
          { dateTime: "2020-02-20T23:39:00.000", level: "light", seconds: 720 },
          {
            dateTime: "2020-02-20T23:51:00.000",
            level: "deep",
            seconds: 1_920,
          },
        ],
        summary: {
          deep: { count: 5, minutes: 92, thirtyDayAvgMinutes: 0 },
          light: { count: 33, minutes: 245, thirtyDayAvgMinutes: 0 },
          rem: { count: 7, minutes: 74, thirtyDayAvgMinutes: 0 },
          wake: { count: 32, minutes: 51, thirtyDayAvgMinutes: 0 },
        },
      },
      logId: 26013218219,
      minutesAfterWakeup: 0,
      minutesAsleep: 411,
      minutesAwake: 51,
      minutesToFallAsleep: 0,
      startTime: "2020-02-20T23:38:30.000",
      timeInBed: 462,
      type: "stages",
    },
  ],
};

// A sleep log that crosses the 2020-03-08 02:00 -> 03:00 PST->PDT transition:
// bedtime is UTC-8, wake is UTC-7, so a fixed offset would misplace the wake.
const dstSleepLog = {
  summary: {
    totalMinutesAsleep: 400,
    totalSleepRecords: 1,
    totalTimeInBed: 420,
  },
  sleep: [
    {
      dateOfSleep: "2020-03-08",
      duration: 25200000,
      efficiency: 95,
      endTime: "2020-03-08T07:00:00.000",
      isMainSleep: true,
      levels: {
        data: [
          { dateTime: "2020-03-07T23:00:00.000", level: "light", seconds: 600 },
        ],
      },
      logId: 26013218220,
      minutesAsleep: 400,
      minutesAwake: 20,
      minutesToFallAsleep: 0,
      startTime: "2020-03-07T23:00:00.000",
      timeInBed: 420,
      type: "stages",
    },
  ],
};

const weightLogs: Record<string, Record<string, unknown>> = {
  // 07:15 local on a Tokyo host parses as 2020-02-20T22:15Z, which moves the
  // UTC-derived localDate to the previous day.
  "2020-02-21": {
    weight: [
      {
        logId: 1001,
        date: "2020-02-21",
        time: "07:15:00",
        weight: 70.5,
        weightUnit: "kg",
      },
    ],
  },
  // 03:30 on the DST day is thirty minutes after the skipped hour (PDT).
  "2020-03-08": {
    weight: [
      {
        logId: 1002,
        date: "2020-03-08",
        time: "03:30:00",
        weight: 70.1,
        weightUnit: "kg",
      },
    ],
  },
};

const EMPTY_ACTIVITY = { summary: { steps: 0, distances: [] } };
const EMPTY_HEART = { "activities-heart": [] };

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function stubFitbit(profileUser: Record<string, unknown>): void {
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = String(input);
    const date = /\/date\/(\d{4}-\d{2}-\d{2})/.exec(url)?.[1] ?? "";
    if (url.includes("/activities/heart/")) return jsonResponse(EMPTY_HEART);
    if (url.includes("/activities/date/")) return jsonResponse(EMPTY_ACTIVITY);
    if (url.includes("/sleep/date/")) {
      return jsonResponse(
        date === "2020-03-08" ? dstSleepLog : documentedSleepLog,
      );
    }
    if (url.includes("/body/log/weight/")) {
      return jsonResponse(weightLogs[date] ?? { weight: [] });
    }
    if (url.includes("/profile.json"))
      return jsonResponse(profile(profileUser));
    throw new Error(`unexpected Fitbit fetch: ${url}`);
  });
}

interface ObservedInstants {
  sleepStartAt: string;
  sleepEndAt: string;
  sleepTimezone: string | null;
  firstStageStartAt: string;
  weightStartAt: string;
  weightLocalDate: string;
}

async function syncDay(date: string): Promise<ObservedInstants> {
  const payload = await syncHealthConnectorData({
    token,
    grantId: "grant-fitbit",
    startDate: date,
    endDate: date,
  });
  const episode = payload.sleepEpisodes[0];
  const stage = episode?.stageSamples[0];
  const weight = payload.samples.find((entry) => entry.metric === "weight_kg");
  if (!episode || !stage || !weight) {
    throw new Error(`sync for ${date} did not yield sleep, stage and weight`);
  }
  return {
    sleepStartAt: episode.startAt,
    sleepEndAt: episode.endAt,
    sleepTimezone: episode.timezone,
    firstStageStartAt: stage.startAt,
    weightStartAt: weight.startAt,
    weightLocalDate: weight.localDate,
  };
}

// Instants a Los Angeles user actually experienced.
const EXPECTED_FEBRUARY: ObservedInstants = {
  sleepStartAt: "2020-02-21T07:38:30.000Z",
  sleepEndAt: "2020-02-21T15:21:30.000Z",
  sleepTimezone: PROFILE_ZONE,
  firstStageStartAt: "2020-02-21T07:38:30.000Z",
  weightStartAt: "2020-02-21T15:15:00.000Z",
  weightLocalDate: "2020-02-21",
};
const EXPECTED_DST: ObservedInstants = {
  sleepStartAt: "2020-03-08T07:00:00.000Z",
  sleepEndAt: "2020-03-08T14:00:00.000Z",
  sleepTimezone: PROFILE_ZONE,
  firstStageStartAt: "2020-03-08T07:00:00.000Z",
  weightStartAt: "2020-03-08T10:30:00.000Z",
  weightLocalDate: "2020-03-08",
};

const HOST_ZONES = ["UTC", "Asia/Tokyo", "America/Los_Angeles"] as const;

// The package vitest config pins TZ; each case overrides the host zone and
// restores it so later files still see the pinned value.
async function withHostZone<T>(
  timeZone: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = process.env.TZ;
  process.env.TZ = timeZone;
  try {
    expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(timeZone);
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previous;
    }
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Fitbit connector — wall times resolve in the profile zone", () => {
  it.each(HOST_ZONES)(
    "stores Los Angeles instants when the host clock is %s",
    async (hostZone) => {
      stubFitbit({
        timezone: PROFILE_ZONE,
        offsetFromUTCMillis: PST_OFFSET_MILLIS,
      });
      const observed = await withHostZone(hostZone, async () => ({
        february: await syncDay("2020-02-21"),
        dst: await syncDay("2020-03-08"),
      }));
      expect(observed.february).toEqual(EXPECTED_FEBRUARY);
      expect(observed.dst).toEqual(EXPECTED_DST);
    },
  );

  it("falls back to offsetFromUTCMillis when the profile zone is not a valid IANA name", async () => {
    stubFitbit({
      timezone: "Pacific/Nowhere",
      offsetFromUTCMillis: PST_OFFSET_MILLIS,
    });
    const observed = await withHostZone("Asia/Tokyo", () =>
      syncDay("2020-02-21"),
    );
    expect(observed).toEqual({ ...EXPECTED_FEBRUARY, sleepTimezone: null });
  });

  it("uses offsetFromUTCMillis when the profile carries no timezone at all", async () => {
    stubFitbit({ offsetFromUTCMillis: PST_OFFSET_MILLIS });
    const observed = await withHostZone("UTC", () => syncDay("2020-02-21"));
    expect(observed).toEqual({ ...EXPECTED_FEBRUARY, sleepTimezone: null });
  });

  it("rejects a profile with neither a usable zone nor an offset instead of guessing", async () => {
    stubFitbit({ timezone: "Pacific/Nowhere" });
    await expect(
      withHostZone("UTC", () => syncDay("2020-02-21")),
    ).rejects.toBeInstanceOf(HealthConnectorApiError);
  });
});

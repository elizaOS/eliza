// Keyless contract test: replays REAL-shaped recorded Oura v2 collections
// (src/health-bridge/__fixtures__/oura.recorded.json — the {data:[...]} envelopes
// for sleep / daily_activity / daily_readiness / heartrate / workout, plus the
// top-level personal_info resource, with the real Oura wire field names) through
// the actual syncOura normalizer (via the exported syncHealthConnectorData) and
// asserts the produced HealthConnectorSyncPayload is contract-shaped. This is
// what validates the Oura connector against the real API shape: the raw->
// normalized sleep transform (bedtime_start->startAt, bedtime_end->endAt,
// total_sleep_duration->durationSeconds, *_sleep_duration->{light,deep,rem},
// type long_sleep->isMainSleep, score->sleepScore, average_hrv->averageHrvMs)
// is exercised against the real field names with no network.
// oura-connector.real.test.ts re-fetches the live API to catch drift.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncHealthConnectorData } from "../src/health-bridge/health-connectors.js";
import type { StoredHealthConnectorToken } from "../src/health-bridge/health-oauth.js";

const recorded = JSON.parse(
  readFileSync(
    resolve(
      import.meta.dirname,
      "../src/health-bridge/__fixtures__/oura.recorded.json",
    ),
    "utf8",
  ),
) as {
  personalInfo: Record<string, unknown>;
  dailyActivity: unknown;
  dailyReadiness: unknown;
  sleep: unknown;
  heartRate: unknown;
  workout: unknown;
};

const token: StoredHealthConnectorToken = {
  provider: "oura",
  agentId: "agent-oura",
  side: "owner",
  mode: "local",
  clientId: "test-client",
  clientSecret: "test-secret",
  redirectUri: "http://127.0.0.1/redirect",
  accessToken: "test-access-token",
  refreshToken: "test-refresh-token",
  tokenType: "Bearer",
  grantedScopes: ["personal", "daily", "heartrate", "workout"],
  expiresAt: null,
  identity: {},
  createdAt: "2026-05-01T00:00:00.000Z",
  updatedAt: "2026-05-01T00:00:00.000Z",
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/usercollection/personal_info")) {
      return jsonResponse(recorded.personalInfo);
    }
    if (url.includes("/usercollection/daily_activity")) {
      return jsonResponse(recorded.dailyActivity);
    }
    if (url.includes("/usercollection/daily_readiness")) {
      return jsonResponse(recorded.dailyReadiness);
    }
    if (url.includes("/usercollection/sleep")) {
      return jsonResponse(recorded.sleep);
    }
    if (url.includes("/usercollection/heartrate")) {
      return jsonResponse(recorded.heartRate);
    }
    if (url.includes("/usercollection/workout")) {
      return jsonResponse(recorded.workout);
    }
    throw new Error(`unexpected Oura fetch: ${url}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Oura connector — recorded real API contract", () => {
  it("normalizes the real Oura collection shapes into a contract-shaped payload", async () => {
    const payload = await syncHealthConnectorData({
      token,
      grantId: "grant-oura",
      startDate: "2026-05-01",
      endDate: "2026-05-01",
    });

    // identity falls back to the raw personal_info resource when it has no
    // `data` wrapper (the real /personal_info returns fields at top level).
    expect(payload.identity).not.toBeNull();
    expect(payload.identity?.biological_sex).toBe("female");
    expect(payload.identity?.email).toBe("ada@example.com");
    expect(payload.cursor).toBeNull();

    // One recorded sleep period -> one normalized sleep episode.
    expect(payload.sleepEpisodes).toHaveLength(1);
    const ep = payload.sleepEpisodes[0];
    if (!ep) throw new Error("missing sleep episode");

    // raw->normalized transform assertions (would catch normalizer drift):
    // id -> sourceExternalId.
    expect(ep.sourceExternalId).toBe("slp-2026-05-01");
    expect(ep.provider).toBe("oura");
    expect(ep.agentId).toBe("agent-oura");
    expect(ep.grantId).toBe("grant-oura");
    // bedtime_start/bedtime_end -> startAt/endAt normalized to ISO with ms.
    expect(ep.startAt).toBe("2026-04-30T22:48:00.000Z");
    expect(ep.endAt).toBe("2026-05-01T06:54:00.000Z");
    // day -> localDate.
    expect(ep.localDate).toBe("2026-05-01");
    // type "long_sleep" -> isMainSleep true; sleepType verbatim.
    expect(ep.isMainSleep).toBe(true);
    expect(ep.sleepType).toBe("long_sleep");
    // total_sleep_duration seconds -> durationSeconds verbatim.
    expect(ep.durationSeconds).toBe(27360);
    // time_in_bed -> timeInBedSeconds.
    expect(ep.timeInBedSeconds).toBe(29160);
    // efficiency / latency / awake_time pass through (latency/awake as seconds).
    expect(ep.efficiency).toBe(94);
    expect(ep.latencySeconds).toBe(540);
    expect(ep.awakeSeconds).toBe(1800);
    // *_sleep_duration -> {light,deep,rem}SleepSeconds.
    expect(ep.lightSleepSeconds).toBe(15120);
    expect(ep.deepSleepSeconds).toBe(6480);
    expect(ep.remSleepSeconds).toBe(5760);
    // score -> sleepScore; readinessScore stays null (not on sleep records).
    expect(ep.sleepScore).toBe(86);
    expect(ep.readinessScore).toBeNull();
    // biometrics map across.
    expect(ep.averageHeartRate).toBe(52.5);
    expect(ep.lowestHeartRate).toBe(47);
    expect(ep.averageHrvMs).toBe(68);
    expect(ep.respiratoryRate).toBe(13.5);
    // timezone offset 0 (number on the wire) -> stringified "0".
    expect(ep.timezone).toBe("0");
    expect(ep.metadata.source).toBe("oura_sleep");

    // sleep samples derived from the episode: sleep_hours + sleep_score.
    const sleepHours = payload.samples.find(
      (s) => s.sourceExternalId === "slp-2026-05-01:sleep_hours",
    );
    expect(sleepHours?.value).toBe(27360 / 3600);
    expect(sleepHours?.unit).toBe("h");
    const sleepScore = payload.samples.find(
      (s) => s.sourceExternalId === "slp-2026-05-01:sleep_score",
    );
    expect(sleepScore?.value).toBe(86);
    expect(sleepScore?.unit).toBe("score");

    // daily_activity -> steps/calories/distance samples.
    const steps = payload.samples.find((s) => s.metric === "steps");
    expect(steps?.value).toBe(11842);
    expect(steps?.unit).toBe("count");
    const calories = payload.samples.find(
      (s) => s.sourceExternalId === "act-2026-05-01:calories",
    );
    // total_calories preferred over active_calories.
    expect(calories?.value).toBe(2415);
    const distance = payload.samples.find(
      (s) => s.sourceExternalId === "act-2026-05-01:distance_meters",
    );
    expect(distance?.value).toBe(8520);

    // daily_readiness -> readiness_score sample.
    const readiness = payload.samples.find(
      (s) => s.metric === "readiness_score",
    );
    expect(readiness?.value).toBe(79);
    expect(readiness?.unit).toBe("score");

    // heartrate collection -> heart_rate sample.
    const hr = payload.samples.find(
      (s) => s.sourceExternalId === "hr-1:heart_rate",
    );
    expect(hr?.value).toBe(58);
    expect(hr?.unit).toBe("bpm");

    // workout collection -> one normalized workout.
    expect(payload.workouts).toHaveLength(1);
    const wkt = payload.workouts[0];
    if (!wkt) throw new Error("missing workout");
    expect(wkt.sourceExternalId).toBe("wkt-2026-05-01");
    // activity "running" -> workoutType.
    expect(wkt.workoutType).toBe("running");
    expect(wkt.provider).toBe("oura");
    expect(wkt.startAt).toBe("2026-05-01T13:05:00.000Z");
    expect(wkt.endAt).toBe("2026-05-01T13:47:00.000Z");
    // durationSeconds computed from start/end (42 min = 2520s).
    expect(wkt.durationSeconds).toBe(2520);
    expect(wkt.distanceMeters).toBe(8042.4);
    expect(wkt.calories).toBe(612);

    // Every sample carries the required contract fields.
    for (const s of payload.samples) {
      expect(typeof s.id).toBe("string");
      expect(s.provider).toBe("oura");
      expect(typeof s.value).toBe("number");
      expect(Number.isFinite(s.value)).toBe(true);
      expect(typeof s.startAt).toBe("string");
      expect(s.localDate).toBe(s.startAt.slice(0, 10));
    }
  });
});

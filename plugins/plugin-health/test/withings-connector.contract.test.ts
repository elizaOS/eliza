// Keyless contract test: replays REAL-shaped recorded Withings API responses
// (src/health-bridge/__fixtures__/withings.recorded.json — the {status,body}
// envelopes for getactivity / getsummary / getmeas with the real
// wbsapi.withings.net wire field names) through the actual syncWithings
// normalizer (via the exported syncHealthConnectorData) and asserts the
// produced HealthConnectorSyncPayload is contract-shaped. This is what
// validates the Withings connector against the real API shape: the raw->
// normalized transform (activities[].steps->steps, .active->active_minutes,
// .totalcalories->calories, .distance->distance_meters, .hr_average->heart_rate,
// .hr_resting->resting_heart_rate; sleep series[].startdate/.enddate UNIX->
// startAt/endAt ISO, .data.total_sleep_time->durationSeconds, .data.*duration->
// {light,deep,rem}SleepSeconds; measuregrps[].measures value*10^unit by type
// -> weight_kg/heart_rate/blood_oxygen_percent/body_temperature_celsius/
// heart_rate_variability/blood_pressure_systolic/blood_pressure_diastolic) is
// exercised against the real field names with no network.
// withings-connector.real.test.ts re-fetches the live API to catch drift.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncHealthConnectorData } from "../src/health-bridge/health-connectors.js";
import type { StoredHealthConnectorToken } from "../src/health-bridge/health-oauth.js";

const recorded = JSON.parse(
  readFileSync(
    resolve(
      import.meta.dirname,
      "../src/health-bridge/__fixtures__/withings.recorded.json",
    ),
    "utf8",
  ),
) as {
  activity: Record<string, unknown>;
  sleep: Record<string, unknown>;
  measures: Record<string, unknown>;
};

const token: StoredHealthConnectorToken = {
  provider: "withings",
  agentId: "agent-withings",
  side: "owner",
  mode: "local",
  clientId: "test-client",
  clientSecret: "test-secret",
  redirectUri: "http://127.0.0.1/redirect",
  accessToken: "test-access-token",
  refreshToken: "test-refresh-token",
  tokenType: "Bearer",
  grantedScopes: [
    "user.info",
    "user.metrics",
    "user.activity",
    "user.sleepevents",
  ],
  expiresAt: null,
  identity: { withings_user_id: "wu-1" },
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
    // Order matters: /v2/measure (activity) before the bare /measure (getmeas).
    if (url.includes("/v2/measure")) {
      return jsonResponse(recorded.activity);
    }
    if (url.includes("/v2/sleep")) {
      return jsonResponse(recorded.sleep);
    }
    if (url.includes("/measure")) {
      return jsonResponse(recorded.measures);
    }
    throw new Error(`unexpected Withings fetch: ${url}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Withings connector — recorded real API contract", () => {
  it("normalizes the real Withings response shapes into a contract-shaped payload", async () => {
    const payload = await syncHealthConnectorData({
      token,
      grantId: "grant-withings",
      startDate: "2026-05-01",
      endDate: "2026-05-01",
    });

    // Withings keeps identity as the stored token identity (no profile fetch).
    expect(payload.identity).toEqual({ withings_user_id: "wu-1" });
    expect(payload.cursor).toBeNull();
    // Withings syncWithings emits no workouts.
    expect(payload.workouts).toEqual([]);

    const dayAt = "2026-05-01T12:00:00.000Z";

    // --- getactivity samples (id is the YYYY-MM-DD date) ---
    const steps = payload.samples.find((s) => s.metric === "steps");
    expect(steps?.value).toBe(11842);
    expect(steps?.unit).toBe("count");
    expect(steps?.startAt).toBe(dayAt);
    expect(steps?.sourceExternalId).toBe("2026-05-01:withings:steps");

    // .active minutes -> active_minutes verbatim.
    const activeMinutes = payload.samples.find(
      (s) => s.metric === "active_minutes",
    );
    expect(activeMinutes?.value).toBe(69);
    expect(activeMinutes?.unit).toBe("min");

    // totalcalories preferred over calories.
    const calories = payload.samples.find(
      (s) => s.sourceExternalId === "2026-05-01:withings:calories",
    );
    expect(calories?.value).toBe(2415);
    expect(calories?.unit).toBe("kcal");

    // .distance meters -> distance_meters verbatim.
    const distance = payload.samples.find(
      (s) => s.sourceExternalId === "2026-05-01:withings:distance_meters",
    );
    expect(distance?.value).toBe(8520);
    expect(distance?.unit).toBe("m");

    // .hr_average -> heart_rate; .hr_resting -> resting_heart_rate.
    const hr = payload.samples.find(
      (s) => s.sourceExternalId === "2026-05-01:withings:heart_rate",
    );
    expect(hr?.value).toBe(78);
    const resting = payload.samples.find(
      (s) => s.metric === "resting_heart_rate",
    );
    expect(resting?.value).toBe(54);

    // --- getsummary sleep episode ---
    const sleepHours = payload.samples.find((s) => s.metric === "sleep_hours");
    // total_sleep_time 27360 s -> 7.6 h.
    expect(sleepHours?.value).toBe(27360 / 3600);
    expect(sleepHours?.unit).toBe("h");

    expect(payload.sleepEpisodes).toHaveLength(1);
    const ep = payload.sleepEpisodes[0];
    if (!ep) throw new Error("missing sleep episode");

    // series[].id -> sourceExternalId (stringified).
    expect(ep.sourceExternalId).toBe("920211001");
    expect(typeof ep.sourceExternalId).toBe("string");
    expect(ep.provider).toBe("withings");
    expect(ep.agentId).toBe("agent-withings");
    expect(ep.grantId).toBe("grant-withings");
    // startdate/enddate UNIX seconds -> ISO startAt/endAt.
    expect(ep.startAt).toBe("2026-04-30T23:48:00.000Z");
    expect(ep.endAt).toBe("2026-05-01T07:54:00.000Z");
    // .date -> localDate; timezone passes through.
    expect(ep.localDate).toBe("2026-05-01");
    expect(ep.timezone).toBe("Europe/London");
    // Withings summary is always treated as the main sleep; sleepType marker.
    expect(ep.isMainSleep).toBe(true);
    expect(ep.sleepType).toBe("summary");
    // data.total_sleep_time -> durationSeconds.
    expect(ep.durationSeconds).toBe(27360);
    // timeInBedSeconds = wakeupduration (1800) + durationSeconds (27360).
    expect(ep.timeInBedSeconds).toBe(1800 + 27360);
    // durationtosleep -> latencySeconds; wakeupduration -> awakeSeconds.
    expect(ep.latencySeconds).toBe(540);
    expect(ep.awakeSeconds).toBe(1800);
    // *duration -> {light,deep,rem}SleepSeconds.
    expect(ep.lightSleepSeconds).toBe(15120);
    expect(ep.deepSleepSeconds).toBe(6480);
    expect(ep.remSleepSeconds).toBe(5760);
    // Withings summary has no efficiency/score in this normalizer.
    expect(ep.efficiency).toBeNull();
    expect(ep.sleepScore).toBeNull();
    expect(ep.readinessScore).toBeNull();
    // biometrics map across.
    expect(ep.averageHeartRate).toBe(53);
    expect(ep.lowestHeartRate).toBe(47);
    expect(ep.respiratoryRate).toBe(14);
    expect(ep.metadata.source).toBe("withings_sleep_summary");

    // --- getmeas measure samples (value * 10^unit by `type`) ---
    const weight = payload.samples.find((s) => s.metric === "weight_kg");
    // type 1 weight: 61200 * 10^-3 = 61.2 kg.
    expect(weight?.value).toBe(61.2);
    expect(weight?.unit).toBe("kg");
    expect(weight?.sourceExternalId).toBe("770110201:withings:weight_kg");
    expect(weight?.metadata.withingsType).toBe(1);

    // type 11 heart_rate: 540 * 10^-1 = 54 bpm.
    const measHr = payload.samples.find(
      (s) => s.sourceExternalId === "770110201:withings:heart_rate",
    );
    expect(measHr?.value).toBe(54);
    expect(measHr?.unit).toBe("bpm");

    // type 54 blood_oxygen_percent: 982 * 10^-1 = 98.2 %.
    const spo2 = payload.samples.find(
      (s) => s.metric === "blood_oxygen_percent",
    );
    expect(spo2?.value).toBeCloseTo(98.2, 5);
    expect(spo2?.unit).toBe("%");

    // type 71 body_temperature_celsius: 3651 * 10^-2 = 36.51 C.
    const temp = payload.samples.find(
      (s) => s.metric === "body_temperature_celsius",
    );
    expect(temp?.value).toBeCloseTo(36.51, 5);
    expect(temp?.unit).toBe("C");

    // type 73 heart_rate_variability: 680 * 10^-1 = 68 ms.
    const hrv = payload.samples.find(
      (s) => s.metric === "heart_rate_variability",
    );
    expect(hrv?.value).toBe(68);
    expect(hrv?.unit).toBe("ms");

    // type 10 systolic / type 9 diastolic (unit 0 -> verbatim).
    const systolic = payload.samples.find(
      (s) => s.metric === "blood_pressure_systolic",
    );
    expect(systolic?.value).toBe(78);
    expect(systolic?.unit).toBe("mmHg");
    const diastolic = payload.samples.find(
      (s) => s.metric === "blood_pressure_diastolic",
    );
    expect(diastolic?.value).toBe(52);
    expect(diastolic?.unit).toBe("mmHg");

    // Every sample carries the required contract fields.
    for (const s of payload.samples) {
      expect(typeof s.id).toBe("string");
      expect(s.provider).toBe("withings");
      expect(typeof s.value).toBe("number");
      expect(Number.isFinite(s.value)).toBe(true);
      expect(typeof s.startAt).toBe("string");
      expect(s.localDate).toBe(s.startAt.slice(0, 10));
    }
  });
});

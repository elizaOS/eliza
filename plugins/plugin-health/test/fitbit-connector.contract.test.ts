/**
 * Fitbit connector contract tests replay recorded Web API resources through the
 * actual normalizer to pin real field-name mappings without network access.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncHealthConnectorData } from "../src/health-bridge/health-connectors.js";
import type { StoredHealthConnectorToken } from "../src/health-bridge/health-oauth.js";

const recorded = JSON.parse(
  readFileSync(
    resolve(
      import.meta.dirname,
      "../src/health-bridge/__fixtures__/fitbit.recorded.json",
    ),
    "utf8",
  ),
) as {
  profile: Record<string, unknown>;
  activity: Record<string, unknown>;
  sleep: Record<string, unknown>;
  heart: Record<string, unknown>;
  weight: Record<string, unknown>;
};

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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = String(input);
    // Order matters: the more specific paths must match before /profile.
    if (url.includes("/activities/heart/")) {
      return jsonResponse(recorded.heart);
    }
    if (url.includes("/activities/date/")) {
      return jsonResponse(recorded.activity);
    }
    if (url.includes("/sleep/date/")) {
      return jsonResponse(recorded.sleep);
    }
    if (url.includes("/body/log/weight/")) {
      return jsonResponse(recorded.weight);
    }
    if (url.includes("/profile.json")) {
      return jsonResponse(recorded.profile);
    }
    throw new Error(`unexpected Fitbit fetch: ${url}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Fitbit connector — recorded real API contract", () => {
  it("normalizes the real Fitbit per-date shapes into a contract-shaped payload", async () => {
    const payload = await syncHealthConnectorData({
      token,
      grantId: "grant-fitbit",
      // Single day -> each resource fetched once.
      startDate: "2026-05-01",
      endDate: "2026-05-01",
    });

    // identity falls back to profile.user (the GET /profile.json `user` wrapper).
    expect(payload.identity).not.toBeNull();
    expect(payload.identity?.encodedId).toBe("GGNJL9");
    expect(payload.identity?.fullName).toBe("Ada Lovelace");
    expect(payload.cursor).toBeNull();
    // Fitbit syncFitbit emits no workouts.
    expect(payload.workouts).toEqual([]);

    const dayAt = "2026-05-01T12:00:00.000Z";

    // raw->normalized sample transforms (would catch normalizer drift):
    // summary.steps -> steps.
    const steps = payload.samples.find((s) => s.metric === "steps");
    expect(steps?.value).toBe(11842);
    expect(steps?.unit).toBe("count");
    expect(steps?.startAt).toBe(dayAt);
    expect(steps?.sourceExternalId).toBe("2026-05-01:fitbit:steps");

    // fairlyActiveMinutes (28) + veryActiveMinutes (41) -> active_minutes (69).
    const activeMinutes = payload.samples.find(
      (s) => s.metric === "active_minutes",
    );
    expect(activeMinutes?.value).toBe(69);
    expect(activeMinutes?.unit).toBe("min");

    // summary.caloriesOut -> calories.
    const calories = payload.samples.find((s) => s.metric === "calories");
    expect(calories?.value).toBe(2415);
    expect(calories?.unit).toBe("kcal");

    // distance_meters: take ONLY the canonical activity:"total" row (the day
    // total) and convert to meters via the account locale. tracker/veryActive/...
    // are per-activity breakdowns OF that total, so summing them double/triple-
    // counts. The fixture's multi-entry shape discriminates: a correct total-only
    // read is 8520 m; a summing regression (8.52 + 8.52 + 4.1 km) would be 21140 m.
    // profile.user.distanceUnit is "METRIC" here, so km->m (*1000).
    const distance = payload.samples.find(
      (s) => s.metric === "distance_meters",
    );
    expect(distance?.value).toBe(8.52 * 1000);
    expect(distance?.unit).toBe("m");
    expect(distance?.metadata.providerUnit).toBe("METRIC");

    // activities-heart[0].value.restingHeartRate -> resting_heart_rate.
    const resting = payload.samples.find(
      (s) => s.metric === "resting_heart_rate",
    );
    expect(resting?.value).toBe(54);
    expect(resting?.unit).toBe("bpm");

    // summary.totalMinutesAsleep 456 min -> sleep_hours 7.6 h (min/60).
    const sleepHours = payload.samples.find((s) => s.metric === "sleep_hours");
    expect(sleepHours?.value).toBe(456 / 60);
    expect(sleepHours?.unit).toBe("h");

    // body.log.weight[0].weight kg -> weight_kg; logId -> sourceExternalId.
    // profile.user.weightUnit is "METRIC", so the value passes through unchanged.
    const weight = payload.samples.find((s) => s.metric === "weight_kg");
    expect(weight?.value).toBe(61.2);
    expect(weight?.unit).toBe("kg");
    expect(weight?.sourceExternalId).toBe("38291077001");
    // providerUnit is the per-log unit label; providerLocaleUnit is the account
    // locale that drives the conversion.
    expect(weight?.metadata.providerUnit).toBe("kg");
    expect(weight?.metadata.providerLocaleUnit).toBe("METRIC");

    // One recorded sleep log -> one normalized sleep episode.
    expect(payload.sleepEpisodes).toHaveLength(1);
    const ep = payload.sleepEpisodes[0];
    if (!ep) throw new Error("missing sleep episode");

    // logId (number) -> sourceExternalId (string).
    expect(ep.sourceExternalId).toBe("38291002001");
    expect(typeof ep.sourceExternalId).toBe("string");
    expect(ep.provider).toBe("fitbit");
    expect(ep.agentId).toBe("agent-fitbit");
    expect(ep.grantId).toBe("grant-fitbit");
    // startTime/endTime arrive ZONELESS on the Fitbit wire
    // ("2026-04-30T22:48:00.000"); the normalizer's Date.parse interprets them
    // in the RUNTIME-LOCAL zone, which the suite pins to America/Los_Angeles
    // (UTC-7), so 22:48 local -> 05:48Z next day. Asserting the parsed value
    // pins both the transform and this zoneless->local-time behavior.
    expect(ep.startAt).toBe(
      new Date(Date.parse("2026-04-30T22:48:00.000")).toISOString(),
    );
    expect(ep.endAt).toBe(
      new Date(Date.parse("2026-05-01T06:54:00.000")).toISOString(),
    );
    // localDate is the iterated date.
    expect(ep.localDate).toBe("2026-05-01");
    // isMainSleep verbatim; type -> sleepType.
    expect(ep.isMainSleep).toBe(true);
    expect(ep.sleepType).toBe("stages");
    // duration 29160000 ms -> durationSeconds 29160 (ms/1000, truncated).
    expect(ep.durationSeconds).toBe(29160);
    // timeInBed 486 min -> timeInBedSeconds 29160 (min*60).
    expect(ep.timeInBedSeconds).toBe(486 * 60);
    // efficiency verbatim; sleepScore falls back to efficiency.
    expect(ep.efficiency).toBe(94);
    expect(ep.sleepScore).toBe(94);
    // minutesToFallAsleep 9 min -> latencySeconds 540; minutesAwake 30 -> awakeSeconds 1800.
    expect(ep.latencySeconds).toBe(9 * 60);
    expect(ep.awakeSeconds).toBe(30 * 60);
    // Fitbit summary does not carry per-stage totals here -> null.
    expect(ep.lightSleepSeconds).toBeNull();
    expect(ep.deepSleepSeconds).toBeNull();
    expect(ep.remSleepSeconds).toBeNull();
    expect(ep.readinessScore).toBeNull();
    expect(ep.metadata.rawDateOfSleep).toBe("2026-05-01");

    // levels.data[] -> stageSamples with mapped stages + computed endAt.
    expect(ep.stageSamples).toHaveLength(4);
    const first = ep.stageSamples[0];
    if (!first) throw new Error("missing stage sample");
    expect(first.stage).toBe("light");
    expect(first.providerCode).toBe("light");
    // levels.data[].dateTime is likewise zoneless -> parsed in runtime-local.
    const firstStageStart = new Date(
      Date.parse("2026-04-30T22:48:00.000"),
    ).toISOString();
    expect(first.startAt).toBe(firstStageStart);
    // endAt = startAt + seconds (1800s).
    expect(first.endAt).toBe(
      new Date(Date.parse(firstStageStart) + 1800 * 1000).toISOString(),
    );
    // "wake" level maps to the "awake" canonical stage.
    const wakeStage = ep.stageSamples.find((s) => s.providerCode === "wake");
    expect(wakeStage?.stage).toBe("awake");

    // Every sample carries the required contract fields.
    for (const s of payload.samples) {
      expect(typeof s.id).toBe("string");
      expect(s.provider).toBe("fitbit");
      expect(typeof s.value).toBe("number");
      expect(Number.isFinite(s.value)).toBe(true);
      expect(typeof s.startAt).toBe("string");
      expect(s.localDate).toBe(s.startAt.slice(0, 10));
    }
  });

  it("ignores extra Fitbit distance breakdown rows when the total row is present", async () => {
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/activities/heart/"))
        return jsonResponse(recorded.heart);
      if (url.includes("/activities/date/")) {
        return jsonResponse({
          summary: {
            distances: [
              { activity: "total", distance: 8.52 },
              { activity: "tracker", distance: 8.52 },
              { activity: "veryActive", distance: 4.1 },
              { activity: "loggedActivities", distance: 2.0 },
            ],
          },
        });
      }
      if (url.includes("/sleep/date/")) return jsonResponse(recorded.sleep);
      if (url.includes("/body/log/weight/"))
        return jsonResponse(recorded.weight);
      if (url.includes("/profile.json")) return jsonResponse(recorded.profile);
      throw new Error(`unexpected Fitbit fetch: ${url}`);
    });

    const payload = await syncHealthConnectorData({
      token,
      grantId: "grant-fitbit",
      startDate: "2026-05-01",
      endDate: "2026-05-01",
    });

    const distance = payload.samples.find(
      (s) => s.metric === "distance_meters",
    );
    expect(distance?.value).toBeCloseTo(8.52 * 1000, 5);
    expect(distance?.unit).toBe("m");
  });

  it("falls back to the largest single Fitbit distance row when no total row is present", async () => {
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/activities/heart/"))
        return jsonResponse(recorded.heart);
      if (url.includes("/activities/date/")) {
        return jsonResponse({
          summary: {
            distances: [
              { activity: "tracker", distance: 8.52 },
              { activity: "veryActive", distance: 4.1 },
            ],
          },
        });
      }
      if (url.includes("/sleep/date/")) return jsonResponse(recorded.sleep);
      if (url.includes("/body/log/weight/"))
        return jsonResponse(recorded.weight);
      if (url.includes("/profile.json")) return jsonResponse(recorded.profile);
      throw new Error(`unexpected Fitbit fetch: ${url}`);
    });

    const payload = await syncHealthConnectorData({
      token,
      grantId: "grant-fitbit",
      startDate: "2026-05-01",
      endDate: "2026-05-01",
    });

    const distance = payload.samples.find(
      (s) => s.metric === "distance_meters",
    );
    expect(distance?.value).toBeCloseTo(8.52 * 1000, 5);
    expect(distance?.unit).toBe("m");
  });
});

// An imperial (en_US) Fitbit account reports summary.distances[].distance in
// MILES and body.log.weight[].weight in POUNDS — the units are tied to
// profile.user.distanceUnit / weightUnit, NOT to the wire field names. The
// normalizer must convert to SI, not pass them through as if metric.
const imperialRecorded = JSON.parse(
  readFileSync(
    resolve(
      import.meta.dirname,
      "../src/health-bridge/__fixtures__/fitbit.imperial.recorded.json",
    ),
    "utf8",
  ),
) as {
  profile: Record<string, unknown>;
  activity: Record<string, unknown>;
  sleep: Record<string, unknown>;
  heart: Record<string, unknown>;
  weight: Record<string, unknown>;
};

describe("Fitbit connector — imperial (en_US) locale conversion", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/activities/heart/")) {
        return jsonResponse(imperialRecorded.heart);
      }
      if (url.includes("/activities/date/")) {
        return jsonResponse(imperialRecorded.activity);
      }
      if (url.includes("/sleep/date/")) {
        return jsonResponse(imperialRecorded.sleep);
      }
      if (url.includes("/body/log/weight/")) {
        return jsonResponse(imperialRecorded.weight);
      }
      if (url.includes("/profile.json")) {
        return jsonResponse(imperialRecorded.profile);
      }
      throw new Error(`unexpected Fitbit fetch: ${url}`);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("converts miles->meters and pounds->kg using the account locale", async () => {
    const payload = await syncHealthConnectorData({
      token,
      grantId: "grant-fitbit",
      startDate: "2026-05-01",
      endDate: "2026-05-01",
    });

    // distances[total].distance = 5.0 (MILES, because distanceUnit = en_US).
    // 5.0 mi * 1609.344 = 8046.72 m — NOT 5000 m (the metric-assumption bug).
    const distance = payload.samples.find(
      (s) => s.metric === "distance_meters",
    );
    expect(distance?.value).toBeCloseTo(8046.72, 6);
    expect(distance?.unit).toBe("m");
    expect(distance?.metadata.providerUnit).toBe("en_US");

    // weight[0].weight = 150 (POUNDS, because weightUnit = en_US).
    // 150 lb * 0.45359237 = 68.0388555 kg — NOT 150 kg.
    const weight = payload.samples.find((s) => s.metric === "weight_kg");
    expect(weight?.value).toBeCloseTo(68.0388555, 6);
    expect(weight?.unit).toBe("kg");
    expect(weight?.metadata.providerUnit).toBe("POUND");
    expect(weight?.metadata.providerLocaleUnit).toBe("en_US");
  });
});

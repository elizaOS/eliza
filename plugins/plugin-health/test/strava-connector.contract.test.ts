// Keyless contract test: replays a REAL-shaped recorded Strava response
// (src/health-bridge/__fixtures__/strava.recorded.json — GET /athlete +
// GET /athlete/activities with the real Strava v3 wire field names) through
// the actual syncStrava normalizer (via the exported syncHealthConnectorData)
// and asserts the produced HealthConnectorSyncPayload is contract-shaped.
// This is what validates the Strava connector against the real API shape:
// the raw->normalized transform (id->sourceExternalId, sport_type->workoutType,
// start_date->startAt + computed endAt, moving_time->durationSeconds,
// distance->distanceMeters, average_heartrate->averageHeartRate) is exercised
// against the real field names with no network. strava-connector.real.test.ts
// re-fetches the live API (with a token) to catch drift from this recording.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncHealthConnectorData } from "../src/health-bridge/health-connectors.js";
import type { StoredHealthConnectorToken } from "../src/health-bridge/health-oauth.js";

const recorded = JSON.parse(
  readFileSync(
    resolve(
      import.meta.dirname,
      "../src/health-bridge/__fixtures__/strava.recorded.json",
    ),
    "utf8",
  ),
) as { athlete: Record<string, unknown>; activities: unknown[] };

const token: StoredHealthConnectorToken = {
  provider: "strava",
  agentId: "agent-strava",
  side: "owner",
  mode: "local",
  clientId: "test-client",
  clientSecret: "test-secret",
  redirectUri: "http://127.0.0.1/redirect",
  accessToken: "test-access-token",
  refreshToken: "test-refresh-token",
  tokenType: "Bearer",
  grantedScopes: ["read", "activity:read_all"],
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
    // Order matters: /athlete/activities must match before the /athlete
    // identity endpoint.
    if (url.includes("/athlete/activities")) {
      return jsonResponse(recorded.activities);
    }
    if (url.includes("/athlete")) {
      return jsonResponse(recorded.athlete);
    }
    throw new Error(`unexpected Strava fetch: ${url}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Strava connector — recorded real API contract", () => {
  it("normalizes the real /athlete/activities shape into a contract-shaped payload", async () => {
    const payload = await syncHealthConnectorData({
      token,
      grantId: "grant-strava",
      startDate: "2026-05-01",
      endDate: "2026-05-02",
    });

    // identity is the raw GET /athlete object, untouched.
    expect(payload.identity).not.toBeNull();
    expect(payload.identity?.id).toBe(13374189);
    expect(payload.identity?.firstname).toBe("Ada");
    // Strava produces no sleep episodes.
    expect(payload.sleepEpisodes).toEqual([]);
    expect(payload.cursor).toBeNull();

    // Two recorded activities -> two normalized workouts.
    expect(payload.workouts).toHaveLength(2);
    const run = payload.workouts[0];
    if (!run) throw new Error("missing run workout");

    // raw->normalized transform assertions (would catch normalizer drift):
    // numeric `id` 11500000001 -> string sourceExternalId.
    expect(run.sourceExternalId).toBe("11500000001");
    expect(typeof run.sourceExternalId).toBe("string");
    // sport_type "Run" -> workoutType.
    expect(run.workoutType).toBe("Run");
    expect(run.title).toBe("Morning Run");
    // start_date "2026-05-01T13:05:11Z" -> normalized ISO startAt.
    expect(run.startAt).toBe("2026-05-01T13:05:11.000Z");
    // moving_time 2520 (preferred over elapsed_time 2640) -> durationSeconds.
    expect(run.durationSeconds).toBe(2520);
    // endAt = startAt + durationSeconds (computed, not on the wire).
    expect(run.endAt).toBe("2026-05-01T13:47:11.000Z");
    expect(Date.parse(run.endAt ?? "") - Date.parse(run.startAt)).toBe(
      2520 * 1000,
    );
    // distance 8042.4 (meters) -> distanceMeters verbatim.
    expect(run.distanceMeters).toBe(8042.4);
    // calories 612 -> calories.
    expect(run.calories).toBe(612);
    // average_heartrate 152.4 -> averageHeartRate; max_heartrate 178 -> maxHeartRate.
    expect(run.averageHeartRate).toBe(152.4);
    expect(run.maxHeartRate).toBe(178);
    // provider is stamped on the normalized record.
    expect(run.provider).toBe("strava");
    expect(run.agentId).toBe("agent-strava");
    expect(run.grantId).toBe("grant-strava");
    // metadata carries the secondary raw fields.
    expect(run.metadata.elapsedSeconds).toBe(2640);
    expect(run.metadata.movingSeconds).toBe(2520);
    expect(run.metadata.averageSpeedMetersPerSecond).toBe(3.191);
    expect(run.metadata.elevationGainMeters).toBe(54);

    // The Ride activity: sport_type "Ride" -> workoutType; watts captured.
    const ride = payload.workouts[1];
    if (!ride) throw new Error("missing ride workout");
    expect(ride.sourceExternalId).toBe("11500000002");
    expect(ride.workoutType).toBe("Ride");
    expect(ride.distanceMeters).toBe(24135);
    expect(ride.durationSeconds).toBe(3600);
    expect(ride.metadata.averageWatts).toBe(187.5);

    // Each activity emits the 4 derived metric samples
    // (distance_meters, active_minutes, calories, heart_rate) when present.
    const runSamples = payload.samples.filter((s) =>
      s.sourceExternalId.startsWith("11500000001:"),
    );
    const runMetrics = runSamples.map((s) => s.metric).sort();
    expect(runMetrics).toEqual([
      "active_minutes",
      "calories",
      "distance_meters",
      "heart_rate",
    ]);

    // distance sample carries the raw meters; active_minutes is durationSeconds/60.
    const distanceSample = runSamples.find(
      (s) => s.metric === "distance_meters",
    );
    expect(distanceSample?.value).toBe(8042.4);
    expect(distanceSample?.unit).toBe("m");
    const activeMinutes = runSamples.find((s) => s.metric === "active_minutes");
    expect(activeMinutes?.value).toBe(2520 / 60);
    expect(activeMinutes?.unit).toBe("min");
    const hrSample = runSamples.find((s) => s.metric === "heart_rate");
    expect(hrSample?.value).toBe(152.4);
    expect(hrSample?.unit).toBe("bpm");

    // Every sample carries the required contract fields.
    for (const s of payload.samples) {
      expect(typeof s.id).toBe("string");
      expect(s.provider).toBe("strava");
      expect(typeof s.value).toBe("number");
      expect(Number.isFinite(s.value)).toBe(true);
      expect(typeof s.startAt).toBe("string");
      expect(s.localDate).toBe(s.startAt.slice(0, 10));
    }
  });
});

// Live drift check against the REAL Strava API (www.strava.com/api/v3).
//
// Drives the actual syncStrava normalizer (via syncHealthConnectorData) against
// the live API with a real access token and asserts the produced
// HealthConnectorSyncPayload is still contract-shaped — catching drift from the
// recorded fixture replayed keyless in strava-connector.contract.test.ts.
//
// Gated: opt-in via STRAVA_LIVE_TEST=1 or the post-merge live lane
// (TEST_LANE=post-merge) AND a token in STRAVA_ACCESS_TOKEN. Skips cleanly
// otherwise, so a token-less run is a no-op rather than a failure.

import { describe, expect, it } from "vitest";
import { syncHealthConnectorData } from "../src/health-bridge/health-connectors.js";
import type { StoredHealthConnectorToken } from "../src/health-bridge/health-oauth.js";

const TOKEN = process.env.STRAVA_ACCESS_TOKEN ?? "";
const LIVE =
  (process.env.STRAVA_LIVE_TEST === "1" ||
    process.env.TEST_LANE === "post-merge") &&
  TOKEN.length > 0;

function isoString(value: string): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

describe.skipIf(!LIVE)("Strava connector — live API parser validation", () => {
  it("live /athlete + /athlete/activities normalize into valid DTOs", async () => {
    const now = new Date();
    const start = new Date(now.getTime() - 30 * 86_400_000);
    const token: StoredHealthConnectorToken = {
      provider: "strava",
      agentId: "live-strava",
      side: "owner",
      mode: "local",
      clientId: "live",
      clientSecret: null,
      redirectUri: "http://127.0.0.1/redirect",
      accessToken: TOKEN,
      refreshToken: null,
      tokenType: "Bearer",
      grantedScopes: ["read", "activity:read_all"],
      expiresAt: null,
      identity: {},
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    const payload = await syncHealthConnectorData({
      token,
      grantId: "live-grant",
      startDate: start.toISOString().slice(0, 10),
      endDate: now.toISOString().slice(0, 10),
    });

    // identity is the raw /athlete object — present and object-shaped.
    expect(payload.identity).not.toBeNull();
    expect(typeof payload.identity).toBe("object");
    // Strava produces no sleep episodes.
    expect(payload.sleepEpisodes).toEqual([]);

    // Assert well-formedness of whatever workouts came back (an account may
    // have zero recent activities; assert shape only when present).
    for (const w of payload.workouts) {
      expect(w.provider).toBe("strava");
      expect(typeof w.sourceExternalId).toBe("string");
      expect(w.sourceExternalId.length).toBeGreaterThan(0);
      expect(typeof w.workoutType).toBe("string");
      expect(isoString(w.startAt)).toBe(true);
      expect(typeof w.durationSeconds).toBe("number");
      if (w.endAt !== null) expect(isoString(w.endAt)).toBe(true);
      if (w.distanceMeters !== null)
        expect(typeof w.distanceMeters).toBe("number");
      if (w.averageHeartRate !== null)
        expect(typeof w.averageHeartRate).toBe("number");
    }

    for (const s of payload.samples) {
      expect(s.provider).toBe("strava");
      expect(typeof s.value).toBe("number");
      expect(Number.isFinite(s.value)).toBe(true);
      expect(isoString(s.startAt)).toBe(true);
      expect(s.localDate).toBe(s.startAt.slice(0, 10));
    }
  }, 30_000);
});

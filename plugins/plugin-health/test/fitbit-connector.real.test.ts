/**
 * Fitbit live drift tests run the real Web API normalizer when an access token
 * and live-test lane are explicitly enabled.
 */

import { describe, expect, it } from "vitest";
import { syncHealthConnectorData } from "../src/health-bridge/health-connectors.js";
import type { StoredHealthConnectorToken } from "../src/health-bridge/health-oauth.js";

const TOKEN = process.env.FITBIT_ACCESS_TOKEN ?? "";
const LIVE =
  (process.env.FITBIT_LIVE_TEST === "1" ||
    process.env.TEST_LANE === "post-merge") &&
  TOKEN.length > 0;

function isoString(value: string): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

describe.skipIf(!LIVE)("Fitbit connector — live API parser validation", () => {
  it("live Fitbit per-date resources normalize into valid DTOs", async () => {
    const now = new Date();
    const start = new Date(now.getTime() - 2 * 86_400_000);
    const token: StoredHealthConnectorToken = {
      provider: "fitbit",
      agentId: "live-fitbit",
      side: "owner",
      mode: "local",
      clientId: "live",
      clientSecret: null,
      redirectUri: "http://127.0.0.1/redirect",
      accessToken: TOKEN,
      refreshToken: null,
      tokenType: "Bearer",
      grantedScopes: ["profile", "activity", "heartrate", "sleep", "weight"],
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

    // identity is the raw profile.user object — present and object-shaped.
    expect(payload.identity).not.toBeNull();
    expect(typeof payload.identity).toBe("object");
    // Fitbit produces no workouts.
    expect(payload.workouts).toEqual([]);

    // Assert well-formedness of whatever sleep episodes came back.
    for (const ep of payload.sleepEpisodes) {
      expect(ep.provider).toBe("fitbit");
      expect(typeof ep.sourceExternalId).toBe("string");
      expect(ep.sourceExternalId.length).toBeGreaterThan(0);
      expect(isoString(ep.startAt)).toBe(true);
      expect(isoString(ep.endAt)).toBe(true);
      expect(typeof ep.localDate).toBe("string");
      expect(typeof ep.isMainSleep).toBe("boolean");
      expect(typeof ep.durationSeconds).toBe("number");
      for (const stage of ep.stageSamples) {
        expect(isoString(stage.startAt)).toBe(true);
        expect(isoString(stage.endAt)).toBe(true);
      }
    }

    for (const s of payload.samples) {
      expect(s.provider).toBe("fitbit");
      expect(typeof s.value).toBe("number");
      expect(Number.isFinite(s.value)).toBe(true);
      expect(isoString(s.startAt)).toBe(true);
      expect(s.localDate).toBe(s.startAt.slice(0, 10));
    }
  }, 30_000);
});

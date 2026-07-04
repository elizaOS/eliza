/**
 * Oura live drift tests run the real v2 API normalizer when an access token and
 * live-test lane are explicitly enabled.
 */

import { describe, expect, it } from "vitest";
import { syncHealthConnectorData } from "../src/health-bridge/health-connectors.js";
import type { StoredHealthConnectorToken } from "../src/health-bridge/health-oauth.js";

const TOKEN = process.env.OURA_ACCESS_TOKEN ?? "";
const LIVE =
  (process.env.OURA_LIVE_TEST === "1" ||
    process.env.TEST_LANE === "post-merge") &&
  TOKEN.length > 0;

function isoString(value: string): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

describe.skipIf(!LIVE)("Oura connector — live API parser validation", () => {
  it("live Oura collections normalize into valid DTOs", async () => {
    const now = new Date();
    const start = new Date(now.getTime() - 14 * 86_400_000);
    const token: StoredHealthConnectorToken = {
      provider: "oura",
      agentId: "live-oura",
      side: "owner",
      mode: "local",
      clientId: "live",
      clientSecret: null,
      redirectUri: "http://127.0.0.1/redirect",
      accessToken: TOKEN,
      refreshToken: null,
      tokenType: "Bearer",
      grantedScopes: ["personal", "daily", "heartrate", "workout"],
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

    // identity is the raw personal_info resource — present and object-shaped.
    expect(payload.identity).not.toBeNull();
    expect(typeof payload.identity).toBe("object");

    // Assert well-formedness of whatever sleep episodes came back.
    for (const ep of payload.sleepEpisodes) {
      expect(ep.provider).toBe("oura");
      expect(typeof ep.sourceExternalId).toBe("string");
      expect(ep.sourceExternalId.length).toBeGreaterThan(0);
      expect(isoString(ep.startAt)).toBe(true);
      expect(isoString(ep.endAt)).toBe(true);
      expect(typeof ep.localDate).toBe("string");
      expect(typeof ep.isMainSleep).toBe("boolean");
      expect(typeof ep.durationSeconds).toBe("number");
      if (ep.sleepScore !== null) expect(typeof ep.sleepScore).toBe("number");
      if (ep.averageHrvMs !== null)
        expect(typeof ep.averageHrvMs).toBe("number");
    }

    for (const w of payload.workouts) {
      expect(w.provider).toBe("oura");
      expect(typeof w.sourceExternalId).toBe("string");
      expect(typeof w.workoutType).toBe("string");
      expect(isoString(w.startAt)).toBe(true);
      expect(typeof w.durationSeconds).toBe("number");
    }

    for (const s of payload.samples) {
      expect(s.provider).toBe("oura");
      expect(typeof s.value).toBe("number");
      expect(Number.isFinite(s.value)).toBe(true);
      expect(isoString(s.startAt)).toBe(true);
      expect(s.localDate).toBe(s.startAt.slice(0, 10));
    }
  }, 30_000);
});

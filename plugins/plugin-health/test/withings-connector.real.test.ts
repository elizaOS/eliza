/**
 * Withings live drift tests run the real API normalizer when an access token
 * and live-test lane are explicitly enabled.
 */

import { describe, expect, it } from "vitest";
import { syncHealthConnectorData } from "../src/health-bridge/health-connectors.js";
import type { StoredHealthConnectorToken } from "../src/health-bridge/health-oauth.js";

const TOKEN = process.env.WITHINGS_ACCESS_TOKEN ?? "";
const LIVE =
  (process.env.WITHINGS_LIVE_TEST === "1" ||
    process.env.TEST_LANE === "post-merge") &&
  TOKEN.length > 0;

function isoString(value: string): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

describe.skipIf(!LIVE)(
  "Withings connector — live API parser validation",
  () => {
    it("live Withings activity/sleep/measures normalize into valid DTOs", async () => {
      const now = new Date();
      const start = new Date(now.getTime() - 7 * 86_400_000);
      const token: StoredHealthConnectorToken = {
        provider: "withings",
        agentId: "live-withings",
        side: "owner",
        mode: "local",
        clientId: "live",
        clientSecret: null,
        redirectUri: "http://127.0.0.1/redirect",
        accessToken: TOKEN,
        refreshToken: null,
        tokenType: "Bearer",
        grantedScopes: [
          "user.info",
          "user.metrics",
          "user.activity",
          "user.sleepevents",
        ],
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

      // Withings produces no workouts.
      expect(payload.workouts).toEqual([]);

      // Assert well-formedness of whatever sleep episodes came back.
      for (const ep of payload.sleepEpisodes) {
        expect(ep.provider).toBe("withings");
        expect(typeof ep.sourceExternalId).toBe("string");
        expect(ep.sourceExternalId.length).toBeGreaterThan(0);
        expect(isoString(ep.startAt)).toBe(true);
        expect(isoString(ep.endAt)).toBe(true);
        expect(typeof ep.localDate).toBe("string");
        expect(typeof ep.isMainSleep).toBe("boolean");
        expect(typeof ep.durationSeconds).toBe("number");
      }

      for (const s of payload.samples) {
        expect(s.provider).toBe("withings");
        expect(typeof s.value).toBe("number");
        expect(Number.isFinite(s.value)).toBe(true);
        expect(isoString(s.startAt)).toBe(true);
        expect(s.localDate).toBe(s.startAt.slice(0, 10));
      }
    }, 30_000);
  },
);

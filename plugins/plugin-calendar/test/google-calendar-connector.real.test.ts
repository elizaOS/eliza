// Live drift check against the REAL Google Calendar API (events.list).
//
// Drives the genuine mapEvent normalizer (via GoogleCalendarClient.listEvents)
// against the live API with a real OAuth access token, then runs each event
// through lifeOpsCalendarEventFromGoogle, asserting the produced
// LifeOpsCalendarEvent stays contract-shaped — catching drift from the recorded
// fixture replayed keyless in google-calendar-connector.contract.test.ts.
//
// Gated: opt-in via GOOGLE_CALENDAR_LIVE_TEST=1 or the post-merge live lane
// (TEST_LANE=post-merge) AND a token in GOOGLE_CALENDAR_ACCESS_TOKEN. Skips
// cleanly otherwise, so a token-less run is a no-op rather than a failure.
//
// NOTE: plugin-calendar's vitest config excludes **/*.real.test.ts from the
// unit lane, so this file only executes when run with that exclude removed /
// the post-merge lane that runs it explicitly. The describe.skipIf guard keeps
// it a clean no-op without a token regardless.

import {
  GoogleApiClientFactory,
  type GoogleAuthClient,
  GoogleCalendarClient,
  type GoogleCredentialResolver,
} from "@elizaos/plugin-google";
import type { LifeOpsConnectorGrant } from "@elizaos/shared";
import { Auth } from "googleapis";
import { describe, expect, it } from "vitest";
import { lifeOpsCalendarEventFromGoogle } from "../src/internal/google-delegates.js";

const TOKEN = process.env.GOOGLE_CALENDAR_ACCESS_TOKEN ?? "";
const LIVE =
  (process.env.GOOGLE_CALENDAR_LIVE_TEST === "1" ||
    process.env.TEST_LANE === "post-merge") &&
  TOKEN.length > 0;

function isoString(value: string): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

// Token-only credential resolver: hands the live access token straight to an
// OAuth2 client. Avoids the full connector-account/vault graph for a
// token-driven smoke against the real API.
class StaticTokenResolver implements GoogleCredentialResolver {
  constructor(private readonly accessToken: string) {}
  async getAuthClient(): Promise<GoogleAuthClient> {
    const client = new Auth.OAuth2Client();
    client.setCredentials({ access_token: this.accessToken });
    return client;
  }
}

const grant: LifeOpsConnectorGrant = {
  id: "connector-account:live-google",
  agentId: "live-google",
  provider: "google",
  connectorAccountId: "live-google",
  side: "owner",
  identity: {},
  identityEmail: null,
  grantedScopes: ["https://www.googleapis.com/auth/calendar.readonly"],
  capabilities: ["google.calendar.read"],
  tokenRef: null,
  mode: "local",
  executionTarget: "local",
  sourceOfTruth: "connector_account",
  preferredByAgent: true,
  cloudConnectionId: null,
  metadata: {},
  lastRefreshAt: "2026-06-16T00:00:00.000Z",
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-16T00:00:00.000Z",
};

describe.skipIf(!LIVE)(
  "Google Calendar connector — live events.list parser validation",
  () => {
    it("live primary-calendar events normalize into valid LifeOps DTOs", async () => {
      const factory = new GoogleApiClientFactory(
        new StaticTokenResolver(TOKEN),
      );
      const client = new GoogleCalendarClient(factory);

      const now = new Date();
      const timeMax = new Date(now.getTime() + 30 * 86_400_000);
      const googleEvents = await client.listEvents({
        accountId: "live-google",
        calendarId: "primary",
        timeMin: now.toISOString(),
        timeMax: timeMax.toISOString(),
        limit: 25,
      });

      const events = googleEvents.map((event) =>
        lifeOpsCalendarEventFromGoogle({
          event,
          grant,
          agentId: "live-google",
          syncedAt: now.toISOString(),
        }),
      );

      // Assert well-formedness of whatever events came back (a calendar may be
      // empty; assert shape only when present).
      for (const event of events) {
        expect(event.provider).toBe("google");
        expect(event.side).toBe("owner");
        expect(typeof event.externalId).toBe("string");
        expect(event.externalId.length).toBeGreaterThan(0);
        expect(typeof event.title).toBe("string");
        expect(isoString(event.startAt)).toBe(true);
        expect(isoString(event.endAt)).toBe(true);
        expect(typeof event.isAllDay).toBe("boolean");
        expect(Array.isArray(event.attendees)).toBe(true);
        for (const attendee of event.attendees) {
          expect(typeof attendee.self).toBe("boolean");
          expect(typeof attendee.organizer).toBe("boolean");
        }
        if (event.timezone !== null) {
          expect(typeof event.timezone).toBe("string");
        }
        expect(event.metadata.googlePlugin).toBe(true);
      }
    }, 30_000);
  },
);

/**
 * Google-to-LifeOps normalization contract, including provider fidelity,
 * multi-account identity, all-day bounds, and malformed-event rejection.
 */

import type {
  GoogleCalendarEvent,
  GoogleCalendarListEntry,
} from "@elizaos/plugin-google-workspace";
import type { LifeOpsConnectorGrant } from "@elizaos/shared";
import { describe, expect, it } from "vitest";

import {
  lifeOpsCalendarEventFromGoogle,
  lifeOpsCalendarSummaryFromGoogle,
} from "../src/internal/google-delegates.js";

const AGENT_ID = "agent-7";

const ownerGrant: LifeOpsConnectorGrant = {
  id: "connector-account:acct-123",
  agentId: AGENT_ID,
  provider: "google",
  connectorAccountId: "acct-123",
  side: "owner",
  identity: { email: "owner@example.com" },
  identityEmail: "owner@example.com",
  grantedScopes: ["https://www.googleapis.com/auth/calendar.events"],
  capabilities: ["google.calendar.read", "google.calendar.write"],
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

// Shape produced by plugin-google-workspace `mapEvent` for a normal timed event.
const timedGoogleEvent: GoogleCalendarEvent = {
  id: "evt_abc123",
  calendarId: "owner@example.com",
  title: "Design sync",
  status: "confirmed",
  start: new Date("2026-06-17T15:00:00.000Z").toISOString(),
  end: new Date("2026-06-17T16:00:00.000Z").toISOString(),
  isAllDay: false,
  timeZone: "America/New_York",
  htmlLink: "https://www.google.com/calendar/event?eid=evt_abc123",
  meetLink: "https://meet.google.com/abc-defg-hij",
  attendees: [
    {
      email: "owner@example.com",
      name: "Owner Person",
      responseStatus: "accepted",
      self: true,
      organizer: true,
      optional: false,
    },
    {
      email: "guest@elsewhere.com",
      name: "Guest",
      responseStatus: "needsAction",
      self: false,
      organizer: false,
      optional: false,
    },
  ],
  location: "Room 4B",
  description: "Weekly design review",
  organizer: { email: "owner@example.com", name: "Owner Person", self: true },
  transparency: "transparent",
  visibility: "private",
  metadata: {
    iCalUID: "evt_abc123@google.com",
    recurringEventId: null,
    createdAt: "2026-06-10T09:00:00.000Z",
    updatedAt: "2026-06-15T12:00:00.000Z",
  },
};

// Shape produced by `mapEvent` for an all-day event (date-only start/end).
const allDayGoogleEvent: GoogleCalendarEvent = {
  id: "evt_holiday",
  calendarId: "owner@example.com",
  title: "Company holiday",
  status: "confirmed",
  start: new Date("2026-07-04T00:00:00.000Z").toISOString(),
  end: new Date("2026-07-05T00:00:00.000Z").toISOString(),
  isAllDay: true,
  timeZone: "America/New_York",
  htmlLink: "https://www.google.com/calendar/event?eid=evt_holiday",
  attendees: [],
  metadata: {
    iCalUID: "evt_holiday@google.com",
    recurringEventId: null,
    createdAt: null,
    updatedAt: null,
  },
};

const minimalGoogleEvent: GoogleCalendarEvent = {
  id: "evt_min",
  calendarId: "primary",
};

describe("lifeOpsCalendarEventFromGoogle (Google -> LifeOps contract)", () => {
  it("maps a timed event to a contract-valid LifeOpsCalendarEvent", () => {
    const result = lifeOpsCalendarEventFromGoogle({
      event: timedGoogleEvent,
      grant: ownerGrant,
      agentId: AGENT_ID,
      syncedAt: "2026-06-16T08:00:00.000Z",
    });

    expect(result.id).toBe(
      "agent-7:google:owner:grant:connector-account:acct-123:calendar:owner@example.com:evt_abc123",
    );
    expect(result.externalId).toBe("evt_abc123");
    expect(result.agentId).toBe(AGENT_ID);
    expect(result.provider).toBe("google");
    expect(result.side).toBe("owner");
    expect(result.calendarId).toBe("owner@example.com");
    expect(result.title).toBe("Design sync");
    expect(result.description).toBe("Weekly design review");
    expect(result.location).toBe("Room 4B");
    expect(result.status).toBe("confirmed");
    expect(result.startAt).toBe("2026-06-17T15:00:00.000Z");
    expect(result.endAt).toBe("2026-06-17T16:00:00.000Z");
    expect(result.isAllDay).toBe(false);
    expect(result.timezone).toBe("America/New_York");
    expect(result.htmlLink).toBe(
      "https://www.google.com/calendar/event?eid=evt_abc123",
    );
    // conferenceLink is sourced from the Google `meetLink` field.
    expect(result.conferenceLink).toBe("https://meet.google.com/abc-defg-hij");
    expect(result.organizer).toEqual({
      email: "owner@example.com",
      name: "Owner Person",
      self: true,
    });

    // RSVP state and attendee roles must survive normalization because conflict
    // policy distinguishes declined, optional, and organizer commitments.
    expect(result.attendees).toEqual([
      {
        email: "owner@example.com",
        displayName: "Owner Person",
        responseStatus: "accepted",
        self: true,
        organizer: true,
        optional: false,
      },
      {
        email: "guest@elsewhere.com",
        displayName: "Guest",
        responseStatus: "needsAction",
        self: false,
        organizer: false,
        optional: false,
      },
    ]);

    // metadata is merged with googlePlugin:true plus the Google metadata block.
    expect(result.metadata.googlePlugin).toBe(true);
    expect(result.metadata.iCalUID).toBe("evt_abc123@google.com");
    expect(result.metadata.updatedAt).toBe("2026-06-15T12:00:00.000Z");
    expect(result.metadata.transparency).toBe("transparent");
    expect(result.metadata.visibility).toBe("private");

    expect(result.syncedAt).toBe("2026-06-16T08:00:00.000Z");
    expect(result.updatedAt).toBe("2026-06-15T12:00:00.000Z");
    expect(result.connectorAccountId).toBe("acct-123");
    expect(result.grantId).toBe("connector-account:acct-123");
    expect(result.accountEmail).toBe("owner@example.com");
  });

  it("maps an all-day event preserving date-only bounds and isAllDay", () => {
    const result = lifeOpsCalendarEventFromGoogle({
      event: allDayGoogleEvent,
      grant: ownerGrant,
      agentId: AGENT_ID,
      syncedAt: "2026-06-16T08:00:00.000Z",
    });

    expect(result.isAllDay).toBe(true);
    expect(result.startAt).toBe("2026-07-04T00:00:00.000Z");
    expect(result.endAt).toBe("2026-07-05T00:00:00.000Z");
    expect(result.title).toBe("Company holiday");
    expect(result.updatedAt).toBe("2026-06-16T08:00:00.000Z");
    // No conference / no attendees for this event.
    expect(result.conferenceLink).toBeNull();
    expect(result.attendees).toEqual([]);
  });

  it("rejects sparse provider rows instead of fabricating event times", () => {
    expect(() =>
      lifeOpsCalendarEventFromGoogle({
        event: minimalGoogleEvent,
        grant: ownerGrant,
        agentId: AGENT_ID,
        syncedAt: "2026-06-16T08:00:00.000Z",
      }),
    ).toThrow("Google Calendar event evt_min is missing its start time.");
  });
});

describe("lifeOpsCalendarSummaryFromGoogle (calendar list contract)", () => {
  const listEntry: GoogleCalendarListEntry = {
    calendarId: "owner@example.com",
    summary: "Owner Person",
    description: "Primary calendar",
    primary: true,
    accessRole: "owner",
    backgroundColor: "#0b8043",
    foregroundColor: "#ffffff",
    timeZone: "America/New_York",
    selected: true,
  };

  it("maps a calendar list entry to a LifeOpsCalendarSummary with feed defaults", () => {
    const summary = lifeOpsCalendarSummaryFromGoogle({
      entry: listEntry,
      grant: ownerGrant,
    });

    expect(summary).toEqual({
      provider: "google",
      side: "owner",
      grantId: "connector-account:acct-123",
      connectorAccountId: "acct-123",
      accountEmail: "owner@example.com",
      calendarId: "owner@example.com",
      summary: "Owner Person",
      description: "Primary calendar",
      primary: true,
      accessRole: "owner",
      backgroundColor: "#0b8043",
      foregroundColor: "#ffffff",
      timeZone: "America/New_York",
      selected: true,
      // includeInFeed defaults to true (opt-out, never opt-in).
      includeInFeed: true,
      selectionVersion: 0,
    });
  });

  it("honors an explicit includeInFeed=false override", () => {
    const summary = lifeOpsCalendarSummaryFromGoogle({
      entry: listEntry,
      grant: ownerGrant,
      includeInFeed: false,
    });
    expect(summary.includeInFeed).toBe(false);
  });
});

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  icsCalendarSummary,
  icsEventIdentity,
  lifeOpsCalendarEventFromIcs,
  publicIcsCalendarSource,
} from "./source.js";

interface IcsAttendee {
  email: string | null;
  displayName: string | null;
  responseStatus: string | null;
  organizer: boolean;
  optional: boolean;
}

interface IcsParsedEvent {
  uid: string;
  recurrenceId: string | null;
  sequence: number;
  revisionAt: string | null;
  title: string;
  description: string;
  location: string;
  status: string;
  startAt: string;
  endAt: string;
  isAllDay: boolean;
  timezone: string;
  url: string | null;
  organizer: IcsAttendee | null;
  attendees: IcsAttendee[];
  recurrence: string[];
  transparency: "opaque" | "transparent";
  classification: "public" | "private" | "confidential" | null;
  sourceTextTrusted: false;
}

interface IcsCalendarSourceRecord {
  id: string;
  agentId: string;
  provider: "ics";
  side: "owner";
  name: string;
  enabled: boolean;
  secretRef: string;
  urlFingerprint: string;
  origin: string;
  etag: string | null;
  lastModified: string | null;
  contentHash: string | null;
  syncStatus: string;
  error: unknown;
  lastSyncedAt: string | null;
  lastAttemptedAt: string | null;
  syncGeneration: number;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function makeSource(
  overrides: Partial<IcsCalendarSourceRecord> = {},
): IcsCalendarSourceRecord {
  return {
    id: "src-1",
    agentId: "agent-1",
    provider: "ics",
    side: "owner",
    name: "Team Calendar",
    enabled: true,
    secretRef: "secret://vault/ics-src-1-url",
    urlFingerprint: "sha256:deadbeef",
    origin: "https://calendar.example.com/team.ics",
    etag: '"abc"',
    lastModified: "Mon, 01 Jan 2024 00:00:00 GMT",
    contentHash: "sha256:content",
    syncStatus: "idle",
    error: null,
    lastSyncedAt: "2024-01-01T00:00:00.000Z",
    lastAttemptedAt: "2024-01-01T00:00:00.000Z",
    syncGeneration: 2,
    leaseToken: "lease-xyz",
    leaseExpiresAt: "2024-01-02T00:00:00.000Z",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeEvent(overrides: Partial<IcsParsedEvent> = {}): IcsParsedEvent {
  return {
    uid: "evt-1",
    recurrenceId: null,
    sequence: 1,
    revisionAt: null,
    title: "Standup",
    description: "Daily standup",
    location: "Zoom",
    status: "CONFIRMED",
    startAt: "2024-01-02T09:00:00.000Z",
    endAt: "2024-01-02T09:30:00.000Z",
    isAllDay: false,
    timezone: "UTC",
    url: null,
    organizer: {
      email: "lead@example.com",
      displayName: "Lead",
      responseStatus: null,
      organizer: true,
      optional: false,
    },
    attendees: [
      {
        email: "dev@example.com",
        displayName: "Dev",
        responseStatus: "ACCEPTED",
        organizer: false,
        optional: false,
      },
    ],
    recurrence: [],
    transparency: "opaque",
    classification: "public",
    sourceTextTrusted: false,
    ...overrides,
  };
}

describe("publicIcsCalendarSource", () => {
  it("exposes only the public whitelist — never the secret ref, URL, lease or etag", () => {
    const record = makeSource();
    const out = publicIcsCalendarSource(record) as Record<string, unknown>;
    expect(out.secretRef).toBeUndefined();
    expect("secretRef" in out).toBe(false);
    expect("etag" in out).toBe(false);
    expect("leaseToken" in out).toBe(false);
    expect("leaseExpiresAt" in out).toBe(false);
    expect("contentHash" in out).toBe(false);
    expect(out.urlFingerprint).toBe("sha256:deadbeef");
    expect(out.origin).toBe("https://calendar.example.com/team.ics");
    expect(out.id).toBe("src-1");
    expect(out.provider).toBe("ics");
    expect(out.name).toBe("Team Calendar");
  });

  it("passes through the sync bookkeeping fields", () => {
    const out = publicIcsCalendarSource(makeSource());
    expect(out.syncStatus).toBe("idle");
    expect(out.lastSyncedAt).toBe("2024-01-01T00:00:00.000Z");
    expect(out.lastAttemptedAt).toBe("2024-01-01T00:00:00.000Z");
    expect(out.enabled).toBe(true);
  });
});

describe("icsEventIdentity", () => {
  it("is deterministic for the same uid and recurrenceId", () => {
    const a = icsEventIdentity(makeEvent());
    const b = icsEventIdentity(makeEvent());
    expect(a).toBe(b);
  });

  it("differentiates recurrences of the same event", () => {
    const base = icsEventIdentity(makeEvent());
    const recurrence = icsEventIdentity(
      makeEvent({ recurrenceId: "2024-01-09T09:00:00Z" }),
    );
    expect(recurrence).not.toBe(base);
  });

  it("normalizes null and empty recurrenceId to the same identity", () => {
    const asNull = icsEventIdentity(makeEvent({ recurrenceId: null }));
    const asEmpty = icsEventIdentity(makeEvent({ recurrenceId: "" }));
    expect(asEmpty).toBe(asNull);
  });

  it("matches the documented sha256 construction (uid + NUL + recurrenceId)", () => {
    const expected = createHash("sha256")
      .update("evt-1")
      .update("\0")
      .update("2024-01-09T09:00:00Z")
      .digest("hex");
    expect(
      icsEventIdentity(makeEvent({ recurrenceId: "2024-01-09T09:00:00Z" })),
    ).toBe(expected);
  });
});

describe("lifeOpsCalendarEventFromIcs", () => {
  it("builds the event id from agent, source and identity", () => {
    const event = lifeOpsCalendarEventFromIcs({
      event: makeEvent(),
      source: makeSource(),
      syncedAt: "2024-01-01T01:00:00.000Z",
    });
    const identity = icsEventIdentity(makeEvent());
    expect(event.id).toBe(`agent-1:ics:src-1:${identity}`);
    expect(event.externalId).toBe(`ics:${identity}`);
    expect(event.provider).toBe("ics");
    expect(event.calendarId).toBe("src-1");
  });

  it("marks feed text as untrusted evidence, never authority", () => {
    const event = lifeOpsCalendarEventFromIcs({
      event: makeEvent(),
      source: makeSource(),
      syncedAt: "2024-01-01T01:00:00.000Z",
    });
    expect(event.metadata.untrustedSource).toBe(true);
    expect(event.metadata.sourceTextTrusted).toBe(false);
    expect(event.metadata.sourceKind).toBe("ics_subscription");
  });

  it("marks attendees as non-self and carries organizer when present", () => {
    const event = lifeOpsCalendarEventFromIcs({
      event: makeEvent(),
      source: makeSource(),
      syncedAt: "2024-01-01T01:00:00.000Z",
    });
    expect(event.attendees[0].self).toBe(false);
    expect(event.organizer?.email).toBe("lead@example.com");
  });

  it("nulls the organizer when the feed has none", () => {
    const event = lifeOpsCalendarEventFromIcs({
      event: makeEvent({ organizer: null }),
      source: makeSource(),
      syncedAt: "2024-01-01T01:00:00.000Z",
    });
    expect(event.organizer).toBeNull();
  });

  it("falls back to syncedAt when the feed has no revision timestamp", () => {
    const event = lifeOpsCalendarEventFromIcs({
      event: makeEvent({ revisionAt: null }),
      source: makeSource(),
      syncedAt: "2024-01-01T01:00:00.000Z",
    });
    expect(event.updatedAt).toBe("2024-01-01T01:00:00.000Z");
    const revised = lifeOpsCalendarEventFromIcs({
      event: makeEvent({ revisionAt: "2024-01-01T00:30:00.000Z" }),
      source: makeSource(),
      syncedAt: "2024-01-01T01:00:00.000Z",
    });
    expect(revised.updatedAt).toBe("2024-01-01T00:30:00.000Z");
  });

  it("normalizes empty timezone to null", () => {
    const event = lifeOpsCalendarEventFromIcs({
      event: makeEvent({ timezone: "" }),
      source: makeSource(),
      syncedAt: "2024-01-01T01:00:00.000Z",
    });
    expect(event.timezone).toBeNull();
  });
});

describe("icsCalendarSummary", () => {
  it("exposes a read-only owner-side summary mirroring enabled state", () => {
    const summary = icsCalendarSummary(makeSource());
    expect(summary.accessRole).toBe("reader");
    expect(summary.primary).toBe(false);
    expect(summary.side).toBe("owner");
    expect(summary.selected).toBe(true);
    expect(summary.includeInFeed).toBe(true);
    expect(summary.calendarId).toBe("src-1");
    const disabled = icsCalendarSummary(makeSource({ enabled: false }));
    expect(disabled.selected).toBe(false);
    expect(disabled.includeInFeed).toBe(false);
  });
});

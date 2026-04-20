import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import type {
  LifeOpsCalendarEvent,
  LifeOpsCalendarEventAttendee,
  LifeOpsCalendarFeed,
} from "@elizaos/shared/contracts/lifeops";
import { describe, expect, it } from "vitest";
import {
  DOSSIER_MEMORY_TABLE,
  DOSSIER_MEMORY_TYPE,
  DossierService,
  type CalendarFeedProviderLike,
  type DossierServiceDeps,
  type GmailSearchProviderLike,
  type RelationshipsServiceLike,
} from "./service.js";

const AGENT_ID = "00000000-0000-0000-0000-000000000099";

function makeAttendee(
  email: string,
  displayName: string | null = null,
): LifeOpsCalendarEventAttendee {
  return {
    email,
    displayName,
    responseStatus: "accepted",
    self: false,
    organizer: false,
    optional: false,
  };
}

function makeEvent(overrides: Partial<LifeOpsCalendarEvent>): LifeOpsCalendarEvent {
  const start = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const end = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  return {
    id: "evt-1",
    externalId: "google-evt-1",
    agentId: AGENT_ID,
    provider: "google",
    side: "owner",
    calendarId: "primary",
    title: "3pm with Alex",
    description: "",
    location: "",
    status: "confirmed",
    startAt: start,
    endAt: end,
    isAllDay: false,
    timezone: "UTC",
    htmlLink: null,
    conferenceLink: null,
    organizer: null,
    attendees: [],
    metadata: {},
    syncedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeCalendar(events: LifeOpsCalendarEvent[]): CalendarFeedProviderLike {
  return {
    async getCalendarFeed(): Promise<LifeOpsCalendarFeed> {
      return {
        calendarId: "primary",
        events,
        source: "cache",
        timeMin: new Date(Date.now() - 86_400_000).toISOString(),
        timeMax: new Date(Date.now() + 86_400_000).toISOString(),
        syncedAt: null,
      };
    },
  };
}

function makeRuntime(memories: Memory[] = []): IAgentRuntime {
  return {
    agentId: AGENT_ID,
    adapter: {
      getMemories: async () => memories,
    },
  } as unknown as IAgentRuntime;
}

function makeDeps(
  overrides: Partial<DossierServiceDeps> & { calendar: CalendarFeedProviderLike },
): DossierServiceDeps {
  return {
    relationships: null,
    gmail: null,
    ...overrides,
  };
}

describe("DossierService", () => {
  it("resolves event by id and renders minimal dossier with no enrichment", async () => {
    const event = makeEvent({
      id: "evt-1",
      title: "3pm with Alex",
      attendees: [makeAttendee("alex@example.com", "Alex")],
    });
    const service = new DossierService(
      makeRuntime(),
      makeDeps({ calendar: makeCalendar([event]) }),
    );
    const result = await service.generateDossier("evt-1");
    expect(result.data.eventId).toBe("evt-1");
    expect(result.data.attendees).toHaveLength(1);
    expect(result.data.attendees[0].email).toBe("alex@example.com");
    expect(result.data.degraded.relationships).toBe(true);
    expect(result.data.degraded.gmail).toBe(true);
    expect(result.text).toContain("3pm with Alex");
  });

  it("fuzzy-matches on title when id does not match exactly", async () => {
    const event = makeEvent({ id: "evt-7", title: "Alex weekly sync" });
    const service = new DossierService(
      makeRuntime(),
      makeDeps({ calendar: makeCalendar([event]) }),
    );
    const result = await service.generateDossier("alex weekly");
    expect(result.data.eventId).toBe("evt-7");
  });

  it("throws when no event matches", async () => {
    const service = new DossierService(
      makeRuntime(),
      makeDeps({ calendar: makeCalendar([]) }),
    );
    await expect(service.generateDossier("nonexistent")).rejects.toThrow(
      /no calendar event matched/,
    );
  });

  it("enriches attendees via relationships service", async () => {
    const contactId = "11111111-1111-1111-1111-111111111111" as UUID;
    const rel: RelationshipsServiceLike = {
      async findByHandle(platform, identifier) {
        if (platform !== "email" || identifier !== "alex@example.com") {
          return null;
        }
        return {
          entityId: contactId,
          categories: ["colleague"],
          tags: ["priority"],
          customFields: {},
          lastInteractionAt: "2026-04-10T00:00:00Z",
        };
      },
      async getRelationshipProgress(id) {
        if (id !== contactId) return null;
        return {
          contactId: id,
          cadenceHealth: "due",
          lastInteractionAt: "2026-04-10T00:00:00Z",
          daysSinceInteraction: 7,
          targetCadenceDays: 7,
        };
      },
    };
    const event = makeEvent({
      attendees: [makeAttendee("alex@example.com", "Alex")],
    });
    const service = new DossierService(
      makeRuntime(),
      makeDeps({ calendar: makeCalendar([event]), relationships: rel }),
    );
    const result = await service.generateDossier("evt-1");
    const attendee = result.data.attendees[0];
    expect(attendee.contactId).toBe(contactId);
    expect(attendee.cadenceHealth).toBe("due");
    expect(attendee.tags).toEqual(["priority"]);
    expect(result.data.degraded.relationships).toBe(false);
  });

  it("includes recent Gmail threads when the provider is supplied", async () => {
    const gmail: GmailSearchProviderLike = {
      async searchThreadsByParticipant({ email }) {
        expect(email).toBe("alex@example.com");
        return [
          {
            threadId: "t-1",
            subject: "Re: product plan",
            snippet: "let's chat tomorrow",
            lastMessageAt: "2026-04-15T12:00:00Z",
          },
        ];
      },
    };
    const event = makeEvent({
      attendees: [makeAttendee("alex@example.com")],
    });
    const service = new DossierService(
      makeRuntime(),
      makeDeps({ calendar: makeCalendar([event]), gmail }),
    );
    const result = await service.generateDossier("evt-1");
    expect(result.data.attendees[0].recentGmailThreads).toHaveLength(1);
    expect(result.data.degraded.gmail).toBe(false);
  });

  it("collects prior dossier memory ids for the attendee", async () => {
    const priorId = "22222222-2222-2222-2222-222222222222" as UUID;
    const memories: Memory[] = [
      {
        id: priorId,
        agentId: AGENT_ID as UUID,
        entityId: AGENT_ID as UUID,
        roomId: AGENT_ID as UUID,
        content: {
          type: DOSSIER_MEMORY_TYPE,
          attendees: ["alex@example.com"],
          text: "prior",
        },
        createdAt: Date.now() - 86_400_000,
      } as unknown as Memory,
      {
        id: "33333333-3333-3333-3333-333333333333" as UUID,
        agentId: AGENT_ID as UUID,
        entityId: AGENT_ID as UUID,
        roomId: AGENT_ID as UUID,
        content: {
          type: "something_else",
          attendees: ["alex@example.com"],
        },
        createdAt: Date.now(),
      } as unknown as Memory,
    ];
    const event = makeEvent({
      attendees: [makeAttendee("alex@example.com")],
    });
    const service = new DossierService(
      makeRuntime(memories),
      makeDeps({ calendar: makeCalendar([event]) }),
    );
    const result = await service.generateDossier("evt-1");
    expect(result.data.priorDossiersCount).toBe(1);
    expect(result.data.attendees[0].priorDossierMemoryIds).toEqual([priorId]);
    expect(result.data.degraded.memories).toBe(false);
  });

  it("flags malformed meeting link", async () => {
    const event = makeEvent({
      conferenceLink: "ftp://bad.example.com/room",
      attendees: [],
    });
    const service = new DossierService(
      makeRuntime(),
      makeDeps({ calendar: makeCalendar([event]) }),
    );
    const result = await service.generateDossier("evt-1");
    expect(result.data.meetingLink?.wellFormed).toBe(false);
    expect(result.data.meetingLink?.reason).toContain("unsupported protocol");
    expect(result.text).toContain("malformed");
  });

  it("accepts a well-formed https meeting link", async () => {
    const event = makeEvent({
      conferenceLink: "https://meet.google.com/abc-defg-hij",
      attendees: [],
    });
    const service = new DossierService(
      makeRuntime(),
      makeDeps({ calendar: makeCalendar([event]) }),
    );
    const result = await service.generateDossier("evt-1");
    expect(result.data.meetingLink?.wellFormed).toBe(true);
  });

  it("marks memories as degraded when lookup throws", async () => {
    const runtime = {
      agentId: AGENT_ID,
      adapter: {
        getMemories: async () => {
          throw new Error("boom");
        },
      },
    } as unknown as IAgentRuntime;
    const event = makeEvent({
      attendees: [makeAttendee("alex@example.com")],
    });
    const service = new DossierService(
      runtime,
      makeDeps({ calendar: makeCalendar([event]) }),
    );
    const result = await service.generateDossier("evt-1");
    expect(result.data.degraded.memories).toBe(true);
    expect(result.data.priorDossiersCount).toBe(0);
  });

  it("verifies memory query uses the meeting_dossier type and reminders table", async () => {
    let capturedTableName: string | null = null;
    const runtime = {
      agentId: AGENT_ID,
      adapter: {
        getMemories: async (p: { tableName: string }) => {
          capturedTableName = p.tableName;
          return [];
        },
      },
    } as unknown as IAgentRuntime;
    const event = makeEvent({
      attendees: [makeAttendee("alex@example.com")],
    });
    const service = new DossierService(
      runtime,
      makeDeps({ calendar: makeCalendar([event]) }),
    );
    await service.generateDossier("evt-1");
    expect(capturedTableName).toBe(DOSSIER_MEMORY_TABLE);
  });
});

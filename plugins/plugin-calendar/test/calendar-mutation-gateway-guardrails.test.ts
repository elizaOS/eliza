/**
 * Conversational calendar writes fail closed when approval or authoritative
 * source context is unavailable; provider CRUD is never a fallback.
 */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import type { LifeOpsCalendarEvent } from "@elizaos/shared";
import { describe, expect, it, vi } from "vitest";
import {
  type CalendarActionDeps,
  createCalendarActionRunner,
} from "../src/index.js";

const TARGET: LifeOpsCalendarEvent = {
  id: "owner:google:primary:event-1",
  externalId: "event-1",
  agentId: "agent-1",
  provider: "google",
  side: "owner",
  grantId: "grant-google-a",
  calendarId: "primary",
  title: "Pediatrician",
  description: "",
  location: "",
  status: "confirmed",
  startAt: "2026-08-04T17:00:00.000Z",
  endAt: "2026-08-04T18:00:00.000Z",
  isAllDay: false,
  timezone: "UTC",
  htmlLink: null,
  conferenceLink: null,
  organizer: { self: true },
  attendees: [],
  metadata: { etag: '"v1"' },
  syncedAt: "2026-07-26T00:00:00.000Z",
  updatedAt: "2026-07-26T00:00:00.000Z",
};

function message(text: string): Memory {
  return {
    id: "00000000-0000-0000-0000-000000000601",
    entityId: "00000000-0000-0000-0000-000000000602",
    roomId: "00000000-0000-0000-0000-000000000603",
    createdAt: 1_780_000_000_000,
    content: { text },
  } as Memory;
}

function runtime(service: Record<string, unknown>): IAgentRuntime {
  return {
    agentId: "agent-1",
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    reportError: vi.fn(),
    getService: (name: string) => (name === "calendar" ? service : null),
  } as unknown as IAgentRuntime;
}

function deps(
  gateway?: CalendarActionDeps["mutationGateway"],
): CalendarActionDeps {
  return {
    runTextModel: vi.fn(async () => null),
    runJsonModel: vi.fn(async () => null),
    recentConversationTexts: vi.fn(async () => []),
    ...(gateway ? { mutationGateway: gateway } : {}),
  };
}

function completeFeed() {
  return {
    calendarId: "primary",
    events: [TARGET],
    source: "synced" as const,
    state: "complete" as const,
    sources: [{ status: "fresh" as const }],
    timeMin: "2026-07-26T00:00:00.000Z",
    timeMax: "2026-08-09T00:00:00.000Z",
    syncedAt: "2026-07-26T00:00:00.000Z",
  };
}

describe("calendar conversational mutation gateway guardrails", () => {
  it("fails explicitly when the approval gateway is missing", async () => {
    const service = {
      getConditionalCalendarMutationTarget: vi.fn(async () => TARGET),
      updateCalendarEvent: vi.fn(),
    };
    const action = createCalendarActionRunner(deps());

    const result = await action.handler(
      runtime(service),
      message("rename the pediatrician appointment"),
      undefined,
      {
        parameters: {
          subaction: "update_event",
          title: "Pediatrician follow-up",
          details: {
            eventId: TARGET.externalId,
            calendarId: TARGET.calendarId,
            grantId: TARGET.grantId,
          },
        },
      },
    );

    expect(result?.success).toBe(false);
    expect(result?.text).toContain("owner-approval gateway is not running");
    expect(service.updateCalendarEvent).not.toHaveBeenCalled();
  });

  it.each([
    {
      state: "partial" as const,
      sourceStatus: "fresh" as const,
      label: "partial feed",
    },
    {
      state: "complete" as const,
      sourceStatus: "stale" as const,
      label: "stale source",
    },
  ])("blocks create on $label without repair fallback", async (fixture) => {
    const feed = {
      ...completeFeed(),
      state: fixture.state,
      sources: [{ status: fixture.sourceStatus }],
    };
    const service = {
      getCalendarFeed: vi.fn(async () => feed),
      prepareCalendarEventCreate: vi.fn(),
      createCalendarEvent: vi.fn(),
    };
    const schedule = vi.fn();
    const runJsonModel = vi.fn(async () => null);
    const action = createCalendarActionRunner({
      ...deps({
        schedule,
        modify: vi.fn(),
        cancel: vi.fn(),
      }),
      runJsonModel,
    });

    const result = await action.handler(
      runtime(service),
      message("add pediatrician tomorrow"),
      undefined,
      {
        parameters: {
          subaction: "create_event",
          title: "Pediatrician",
          details: {
            startAt: "2026-08-04T17:00:00.000Z",
            endAt: "2026-08-04T18:00:00.000Z",
          },
        },
      },
    );

    expect(result?.success).toBe(false);
    expect(result?.text).toContain("complete, fresh view");
    expect(runJsonModel).toHaveBeenCalledTimes(1);
    expect(service.prepareCalendarEventCreate).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
    expect(service.createCalendarEvent).not.toHaveBeenCalled();
  });
});

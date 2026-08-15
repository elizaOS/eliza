/**
 * Exercises CALENDAR through the canonical executor so read, durable approval,
 * replay, and failure callbacks are delivered only after exact receipt binding.
 */

import {
  type Action,
  type Content,
  executePlannedToolCall,
  type IAgentRuntime,
  type Memory,
} from "@elizaos/core";
import type {
  LifeOpsCalendarEvent,
  LifeOpsCalendarFeed,
} from "@elizaos/shared";
import { describe, expect, it, vi } from "vitest";
import {
  type CalendarActionDeps,
  createCalendarActionRunner,
} from "../src/index.js";
import { CalendarServiceError } from "../src/internal/errors.js";

const AGENT_ID = "00000000-0000-0000-0000-000000000501";
const ENTITY_ID = "00000000-0000-0000-0000-000000000502";
const ROOM_ID = "00000000-0000-0000-0000-000000000503";
const MESSAGE_ID = "00000000-0000-0000-0000-000000000504";
const FEED_SYNCED_AT = "2026-07-27T12:00:00.000Z";
const APPROVAL_ACCEPTED_AT = "2026-07-27T12:05:00.000Z";

const EVENT: LifeOpsCalendarEvent = {
  id: "calendar-event-row-1",
  externalId: "provider-event-1",
  agentId: AGENT_ID,
  provider: "google",
  side: "owner",
  grantId: "connector-account:calendar-owner",
  calendarId: "primary",
  title: "School pickup",
  description: "",
  location: "School",
  status: "confirmed",
  startAt: "2026-07-28T22:00:00.000Z",
  endAt: "2026-07-28T22:30:00.000Z",
  isAllDay: false,
  timezone: "UTC",
  htmlLink: null,
  conferenceLink: null,
  organizer: { self: true },
  attendees: [],
  metadata: { etag: '"provider-version-1"' },
  syncedAt: FEED_SYNCED_AT,
  updatedAt: FEED_SYNCED_AT,
};

const ELIZA_EVENT: LifeOpsCalendarEvent = {
  ...EVENT,
  id: `${AGENT_ID}:eliza:owner:grant:eliza-calendar:calendar:primary:event-local-1`,
  externalId: "event-local-1",
  provider: "eliza",
  grantId: "eliza-calendar",
  connectorAccountId: "eliza-calendar",
  title: "Eat a sandwich",
  metadata: { etag: '"eliza-1"', version: 1 },
};

function feed(events: LifeOpsCalendarEvent[] = [EVENT]): LifeOpsCalendarFeed {
  return {
    calendarId: "primary",
    events,
    source: "synced",
    state: "complete",
    sources: [
      {
        key: {
          provider: "google",
          side: "owner",
          grantId: "connector-account:calendar-owner",
          connectorAccountId: "calendar-owner",
          calendarId: "primary",
        },
        summary: "Primary",
        accessRole: "owner",
        visibility: "details",
        status: "fresh",
        syncedAt: FEED_SYNCED_AT,
        error: null,
      },
    ],
    timeMin: "2026-07-27T00:00:00.000Z",
    timeMax: "2026-08-03T00:00:00.000Z",
    syncedAt: FEED_SYNCED_AT,
  };
}

function requireOrderedCalendarWindow(
  request: Record<string, unknown> | undefined,
): void {
  const min = request?.timeMin;
  const max = request?.timeMax;
  if (
    typeof min !== "string" ||
    typeof max !== "string" ||
    !Number.isFinite(Date.parse(min)) ||
    !Number.isFinite(Date.parse(max)) ||
    Date.parse(min) >= Date.parse(max)
  ) {
    throw new CalendarServiceError(
      400,
      "Calendar windows require an ordered pair.",
      "CALENDAR_WINDOW_INVALID",
    );
  }
}

function message(text: string): Memory {
  return {
    id: MESSAGE_ID,
    agentId: AGENT_ID,
    entityId: ENTITY_ID,
    roomId: ROOM_ID,
    createdAt: Date.parse("2026-07-27T11:55:00.000Z"),
    content: { text, source: "test" },
  } as Memory;
}

function deps(overrides: Partial<CalendarActionDeps> = {}): CalendarActionDeps {
  return {
    runTextModel: vi.fn(async () => null),
    runJsonModel: vi.fn(async () => null),
    recentConversationTexts: vi.fn(async () => []),
    ...overrides,
  };
}

function runtime(
  service: Record<string, unknown>,
  action: Action,
  reportError: ReturnType<typeof vi.fn> = vi.fn(),
): IAgentRuntime {
  return {
    actions: [action],
    agentId: AGENT_ID,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    reportError,
    getService: (serviceType: string) =>
      serviceType === "calendar" ? service : null,
  } as unknown as IAgentRuntime;
}

async function execute(args: {
  action: Action;
  service: Record<string, unknown>;
  actor: Memory;
  parameters: Record<string, unknown>;
  delivered: Content[];
  reportError?: ReturnType<typeof vi.fn>;
}) {
  const actorRuntime = runtime(args.service, args.action, args.reportError);
  return executePlannedToolCall(
    actorRuntime,
    {
      message: args.actor,
      userRoles: ["OWNER"],
      activeContexts: ["calendar"],
      callback: async (content) => {
        args.delivered.push(content);
        return [];
      },
    },
    {
      name: args.action.name,
      params: args.parameters,
    },
    {
      actions: [args.action],
    },
  );
}

function expectBoundDelivery(
  delivered: Content[],
  result: Awaited<ReturnType<typeof execute>>,
): void {
  expect(delivered).toHaveLength(1);
  expect(delivered[0]).toEqual(
    expect.objectContaining({
      text: result.userFacingText,
      effectReceiptIds: [result.effectReceipts?.[0]?.receiptId],
    }),
  );
}

describe("CALENDAR effect receipt settlement", () => {
  it("opts the complete mixed read/write surface into strict settlement", () => {
    const action = createCalendarActionRunner(deps());
    expect(action.tags).toContain("effect:receipt-required");
  });

  it("binds a feed read to the authoritative synchronized snapshot", async () => {
    const service = {
      getCalendarFeed: vi.fn(async () => feed()),
    };
    const action = createCalendarActionRunner(deps());
    const delivered: Content[] = [];

    const result = await execute({
      action,
      service,
      actor: message("What is on my calendar this week?"),
      parameters: {
        subaction: "feed",
        details: {
          timeMin: "2026-07-27T00:00:00.000Z",
          timeMax: "2026-08-03T00:00:00.000Z",
        },
      },
      delivered,
    });

    expect(result, JSON.stringify(result)).toMatchObject({
      success: true,
      verifiedUserFacing: true,
      // The delivered feed text IS the turn's answer: the read declares the
      // turn complete so the evaluator cannot paraphrase it into a second
      // user-facing message (the "clear tomorrow." double-speak).
      turnComplete: true,
      effectReceipts: [
        {
          operation: "calendar.feed.read",
          outcome: "noop",
          observedAt: FEED_SYNCED_AT,
          resource: {
            kind: "calendar.feed",
          },
        },
      ],
    });
    expectBoundDelivery(delivered, result);
  });

  it("binds a newly persisted approval to its exact queue proof", async () => {
    const approval = {
      requestId: "calendar-approval-request-1",
      action: "schedule_event" as const,
      state: "pending" as const,
      acceptedAt: APPROVAL_ACCEPTED_AT,
      idempotencyKey: "calendar-conversation:message-1:payload-sha",
      replayed: false,
      text: "Approval request calendar-approval-request-1 is ready.",
    };
    const schedule = vi.fn(async () => approval);
    const getCalendarFeed = vi.fn(async () => feed([]));
    const prepareCalendarEventCreate = vi.fn(
      async (_url: URL, request: Record<string, unknown>) => ({
        ...request,
        side: "owner" as const,
        grantId: "connector-account:calendar-owner",
        calendarId: "primary",
        startAt: "2026-07-28T22:00:00.000Z",
        endAt: "2026-07-28T22:30:00.000Z",
        timeZone: "UTC",
      }),
    );
    const service = {
      getCalendarFeed,
      prepareCalendarEventCreate,
    };
    const action = createCalendarActionRunner(
      deps({
        mutationGateway: {
          schedule,
          modify: vi.fn(),
          cancel: vi.fn(),
        },
      }),
    );
    const delivered: Content[] = [];

    const result = await execute({
      action,
      service,
      actor: message("Add school pickup tomorrow at 10pm."),
      parameters: {
        subaction: "create_event",
        title: "School pickup",
        details: {
          calendarId: "  Default  ",
          startAt: "2026-07-28T22:00:00.000Z",
          endAt: "2026-07-28T22:30:00.000Z",
          timeZone: "UTC",
        },
      },
      delivered,
    });

    expect(schedule, JSON.stringify(result)).toHaveBeenCalledOnce();
    expect(getCalendarFeed).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ calendarId: undefined }),
    );
    expect(prepareCalendarEventCreate).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ calendarId: undefined }),
    );
    expect(result.effectReceipts, JSON.stringify(result)).toEqual([
      expect.objectContaining({
        operation: "calendar.approval.schedule_event",
        outcome: "applied",
        observedAt: APPROVAL_ACCEPTED_AT,
        resource: {
          kind: "calendar.approval_request",
          id: approval.requestId,
          version: "pending",
        },
        idempotency: {
          key: approval.idempotencyKey,
          replayed: false,
        },
        commit: {
          kind: "durable",
          id: approval.requestId,
          committedAt: APPROVAL_ACCEPTED_AT,
        },
      }),
    ]);
    expectBoundDelivery(delivered, result);
  });

  it("creates a built-in event directly without exposing the approval protocol", async () => {
    const schedule = vi.fn();
    const createCalendarEvent = vi.fn(async () => ELIZA_EVENT);
    const service = {
      getCalendarFeed: vi.fn(async () => feed([])),
      prepareCalendarEventCreate: vi.fn(
        async (_url: URL, request: Record<string, unknown>) => ({
          ...request,
          side: "owner" as const,
          grantId: "eliza-calendar",
          calendarId: "primary",
          startAt: ELIZA_EVENT.startAt,
          endAt: ELIZA_EVENT.endAt,
          timeZone: "UTC",
        }),
      ),
      createCalendarEvent,
    };
    const action = createCalendarActionRunner(
      deps({
        mutationGateway: {
          schedule,
          modify: vi.fn(),
          cancel: vi.fn(),
        },
      }),
    );
    const delivered: Content[] = [];

    const result = await execute({
      action,
      service,
      actor: message("Add Eat a sandwich tomorrow at 10pm."),
      parameters: {
        subaction: "create_event",
        title: "Eat a sandwich",
        details: {
          startAt: ELIZA_EVENT.startAt,
          endAt: ELIZA_EVENT.endAt,
          timeZone: "UTC",
        },
      },
      delivered,
    });

    expect(schedule).not.toHaveBeenCalled();
    expect(createCalendarEvent).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        grantId: "eliza-calendar",
        idempotencyKey: expect.stringMatching(/^calendar-local-operation-v1:/),
      }),
    );
    expect(result).toMatchObject({
      success: true,
      data: { approvalRequired: false, event: ELIZA_EVENT },
      effectReceipts: [
        {
          operation: "calendar.event.create",
          outcome: "applied",
          resource: {
            kind: "calendar.event",
            id: ELIZA_EVENT.id,
            version: '"eliza-1"',
          },
        },
      ],
    });
    expect(result.userFacingText).not.toMatch(/approve|reject|request id/i);
    expectBoundDelivery(delivered, result);
  });

  it("updates a built-in event directly with its optimistic version", async () => {
    const modify = vi.fn();
    const updatedEvent: LifeOpsCalendarEvent = {
      ...ELIZA_EVENT,
      title: "Eat two sandwiches",
      metadata: { etag: '"eliza-2"', version: 2 },
      updatedAt: "2026-07-27T12:10:00.000Z",
    };
    const updateCalendarEvent = vi.fn(async () => updatedEvent);
    const service = {
      getConditionalCalendarMutationTarget: vi.fn(async () => ELIZA_EVENT),
      updateCalendarEvent,
    };
    const action = createCalendarActionRunner(
      deps({
        mutationGateway: {
          schedule: vi.fn(),
          modify,
          cancel: vi.fn(),
        },
      }),
    );
    const delivered: Content[] = [];

    const result = await execute({
      action,
      service,
      actor: message("Rename that event to Eat two sandwiches."),
      parameters: {
        subaction: "update_event",
        title: updatedEvent.title,
        details: {
          eventId: ELIZA_EVENT.externalId,
          calendarId: ELIZA_EVENT.calendarId,
        },
      },
      delivered,
    });

    expect(modify).not.toHaveBeenCalled();
    expect(updateCalendarEvent).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        eventId: ELIZA_EVENT.externalId,
        expectedProviderVersion: '"eliza-1"',
        idempotencyKey: expect.stringMatching(/^calendar-local-operation-v1:/),
      }),
    );
    expect(result).toMatchObject({
      success: true,
      data: { approvalRequired: false, event: updatedEvent },
      effectReceipts: [
        {
          operation: "calendar.event.update",
          outcome: "applied",
          resource: { id: ELIZA_EVENT.id, version: '"eliza-2"' },
        },
      ],
    });
    expect(result.userFacingText).not.toMatch(/approve|reject|request id/i);
    expectBoundDelivery(delivered, result);
  });

  it("treats model placeholder identifiers as absent when resolving a built-in update by title", async () => {
    const updatedEvent: LifeOpsCalendarEvent = {
      ...ELIZA_EVENT,
      title: "Eat two sandwiches",
      metadata: { etag: '"eliza-2"', version: 2 },
    };
    const lookupRequests: Record<string, unknown>[] = [];
    const getCalendarFeed = vi.fn(
      async (_url: URL, request?: Record<string, unknown>) => {
        requireOrderedCalendarWindow(request);
        lookupRequests.push(request ?? {});
        return feed([ELIZA_EVENT]);
      },
    );
    const getConditionalCalendarMutationTarget = vi.fn();
    const updateCalendarEvent = vi.fn(async () => updatedEvent);
    const service = {
      getCalendarFeed,
      getConditionalCalendarMutationTarget,
      updateCalendarEvent,
    };
    const action = createCalendarActionRunner(deps());
    const delivered: Content[] = [];

    const result = await execute({
      action,
      service,
      actor: message(
        'Rename the calendar event "Eat a sandwich" to "Eat two sandwiches".',
      ),
      parameters: {
        subaction: "update_event",
        query: "Eat a sandwich",
        title: "Eat a sandwich",
        details: {
          eventId: "unknown",
          grantId: "unknown",
          timeMin: "2026-08-05T10:00:00Z",
          timeMax: "2026-08-05T09:00:00Z",
          oldTitle: "Eat a sandwich",
          newTitle: "Eat two sandwiches",
        },
      },
      delivered,
    });

    expect(getCalendarFeed).toHaveBeenCalledOnce();
    // A rejected planner window is ABSENT, not "provided but unusable": the
    // lookup has to fall through to the wide by-title range (-365d..+5y), not
    // the 30-day search default, or an event a couple of months out silently
    // resolves to "not found".
    expect(
      Date.parse(lookupRequests[0]?.timeMax as string) -
        Date.parse(lookupRequests[0]?.timeMin as string),
    ).toBeGreaterThan(365 * 24 * 60 * 60 * 1000);
    expect(Date.parse(lookupRequests[0]?.timeMin as string)).toBeLessThan(
      Date.now(),
    );
    expect(getConditionalCalendarMutationTarget).not.toHaveBeenCalled();
    expect(updateCalendarEvent).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        eventId: ELIZA_EVENT.externalId,
        grantId: ELIZA_EVENT.grantId,
        expectedProviderVersion: '"eliza-1"',
      }),
    );
    expect(result).toMatchObject({
      success: true,
      data: { approvalRequired: false, event: updatedEvent },
    });
    expect(result.userFacingText).not.toMatch(/approve|reject|request id/i);
    expectBoundDelivery(delivered, result);
  });

  it("deletes a built-in event directly with its optimistic version", async () => {
    const cancel = vi.fn();
    const deleteCalendarEvent = vi.fn(async () => undefined);
    const service = {
      getConditionalCalendarMutationTarget: vi.fn(async () => ELIZA_EVENT),
      deleteCalendarEvent,
    };
    const action = createCalendarActionRunner(
      deps({
        mutationGateway: {
          schedule: vi.fn(),
          modify: vi.fn(),
          cancel,
        },
      }),
    );
    const delivered: Content[] = [];

    const result = await execute({
      action,
      service,
      actor: message("Delete Eat a sandwich."),
      parameters: {
        subaction: "delete_event",
        details: {
          eventId: ELIZA_EVENT.externalId,
          calendarId: ELIZA_EVENT.calendarId,
        },
      },
      delivered,
    });

    expect(cancel).not.toHaveBeenCalled();
    expect(deleteCalendarEvent).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        eventId: ELIZA_EVENT.externalId,
        expectedProviderVersion: '"eliza-1"',
        idempotencyKey: expect.stringMatching(/^calendar-local-operation-v1:/),
      }),
    );
    expect(result).toMatchObject({
      success: true,
      data: { approvalRequired: false, deleted: true },
      effectReceipts: [
        {
          operation: "calendar.event.delete",
          outcome: "applied",
          resource: { id: ELIZA_EVENT.id, version: 'deleted:"eliza-1"' },
        },
      ],
    });
    expect(result.userFacingText).not.toMatch(/approve|reject|request id/i);
    expectBoundDelivery(delivered, result);
  });

  it("drops a partial planner window before resolving a built-in delete by title", async () => {
    const lookupRequests: Record<string, unknown>[] = [];
    const getCalendarFeed = vi.fn(
      async (_url: URL, request?: Record<string, unknown>) => {
        requireOrderedCalendarWindow(request);
        lookupRequests.push(request ?? {});
        return feed([ELIZA_EVENT]);
      },
    );
    const deleteCalendarEvent = vi.fn(async () => undefined);
    const service = { getCalendarFeed, deleteCalendarEvent };
    const action = createCalendarActionRunner(deps());
    const delivered: Content[] = [];

    const result = await execute({
      action,
      service,
      actor: message('Delete the calendar event "Eat a sandwich".'),
      parameters: {
        subaction: "delete_event",
        query: "Eat a sandwich",
        details: {
          eventId: "unknown",
          timeMin: "2026-08-05T09:00:00Z",
          timeMax: "not-a-date",
        },
      },
      delivered,
    });

    expect(getCalendarFeed).toHaveBeenCalledOnce();
    // A rejected planner window is ABSENT, not "provided but unusable": the
    // lookup has to fall through to the wide by-title range (-365d..+5y), not
    // the 30-day search default, or an event a couple of months out silently
    // resolves to "not found".
    expect(
      Date.parse(lookupRequests[0]?.timeMax as string) -
        Date.parse(lookupRequests[0]?.timeMin as string),
    ).toBeGreaterThan(365 * 24 * 60 * 60 * 1000);
    expect(Date.parse(lookupRequests[0]?.timeMin as string)).toBeLessThan(
      Date.now(),
    );
    expect(deleteCalendarEvent).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        eventId: ELIZA_EVENT.externalId,
        grantId: ELIZA_EVENT.grantId,
      }),
    );
    expect(result).toMatchObject({
      success: true,
      data: { approvalRequired: false, deleted: true },
    });
    expectBoundDelivery(delivered, result);
  });

  it("uses timezone-grounded calendar extraction instead of a contradictory outer-planner instant", async () => {
    const approval = {
      requestId: "calendar-timezone-approval",
      action: "schedule_event" as const,
      state: "pending" as const,
      acceptedAt: APPROVAL_ACCEPTED_AT,
      idempotencyKey: "calendar-timezone-proof",
      replayed: false,
      text: "Approval request calendar-timezone-approval is ready.",
    };
    let extractionPrompt = "";
    const runJsonModel = vi.fn(async (args: { prompt: string }) => {
      if (!args.prompt.includes("Extract calendar event creation fields")) {
        return null;
      }
      extractionPrompt = args.prompt;
      return {
        rawResponse: JSON.stringify({
          title: "Demo",
          startAt: "2026-08-05T09:00:00-07:00",
          endAt: "2026-08-05T10:00:00-07:00",
          timeZone: "America/Los_Angeles",
        }),
        parsed: {
          title: "Demo",
          startAt: "2026-08-05T09:00:00-07:00",
          endAt: "2026-08-05T10:00:00-07:00",
          timeZone: "America/Los_Angeles",
        },
      };
    });
    const prepareCalendarEventCreate = vi.fn(
      async (_url: URL, request: Record<string, unknown>) => ({
        ...request,
        side: "owner" as const,
        grantId: "connector-account:calendar-owner",
        calendarId: "primary",
      }),
    );
    const service = {
      getCalendarFeed: vi.fn(async () => feed([])),
      prepareCalendarEventCreate,
    };
    const action = createCalendarActionRunner(
      deps({
        runJsonModel,
        mutationGateway: {
          schedule: vi.fn(async () => approval),
          modify: vi.fn(),
          cancel: vi.fn(),
        },
      }),
    );
    const delivered: Content[] = [];

    const result = await execute({
      action,
      service,
      actor: message("Add demo tomorrow at 9am."),
      parameters: {
        subaction: "create_event",
        title: "Demo",
        details: {
          startAt: "2026-08-05T09:00:00Z",
          endAt: "2026-08-05T10:00:00Z",
          timeZone: "America/Los_Angeles",
        },
      },
      delivered,
    });

    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(extractionPrompt).toContain(
      "for 9am in America/Los_Angeles emit 09:00 with the applicable -07:00/-08:00 offset, never 09:00Z",
    );
    expect(prepareCalendarEventCreate).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        startAt: "2026-08-05T09:00:00-07:00",
        endAt: "2026-08-05T10:00:00-07:00",
        timeZone: "America/Los_Angeles",
      }),
    );
    expectBoundDelivery(delivered, result);
  });

  it("reports an authoritative queue replay as a no-op", async () => {
    const approval = {
      requestId: "calendar-approval-request-existing",
      action: "schedule_event" as const,
      state: "pending" as const,
      acceptedAt: APPROVAL_ACCEPTED_AT,
      idempotencyKey: "calendar-conversation:message-1:payload-sha",
      replayed: true,
      text: "The bound approval request is already pending.",
    };
    const service = {
      getCalendarFeed: vi.fn(async () => feed([])),
      prepareCalendarEventCreate: vi.fn(
        async (_url: URL, request: Record<string, unknown>) => ({
          ...request,
          side: "owner" as const,
          grantId: "connector-account:calendar-owner",
          calendarId: "primary",
          startAt: "2026-07-28T22:00:00.000Z",
          endAt: "2026-07-28T22:30:00.000Z",
          timeZone: "UTC",
        }),
      ),
    };
    const action = createCalendarActionRunner(
      deps({
        mutationGateway: {
          schedule: vi.fn(async () => approval),
          modify: vi.fn(),
          cancel: vi.fn(),
        },
      }),
    );
    const delivered: Content[] = [];

    const result = await execute({
      action,
      service,
      actor: message("Add school pickup tomorrow at 10pm."),
      parameters: {
        subaction: "create_event",
        title: "School pickup",
        details: {
          startAt: "2026-07-28T22:00:00.000Z",
          endAt: "2026-07-28T22:30:00.000Z",
          timeZone: "UTC",
        },
      },
      delivered,
    });

    expect(result.effectReceipts).toEqual([
      expect.objectContaining({
        outcome: "noop",
        idempotency: {
          key: approval.idempotencyKey,
          replayed: true,
        },
      }),
    ]);
    expectBoundDelivery(delivered, result);
  });

  it("binds a typed service rejection without claiming application", async () => {
    const service = {
      getCalendarFeed: vi.fn(async () => {
        throw new CalendarServiceError(
          503,
          "Provider unavailable.",
          "CALENDAR_PROVIDER_UNAVAILABLE",
        );
      }),
    };
    const action = createCalendarActionRunner(deps());
    const delivered: Content[] = [];

    const result = await execute({
      action,
      service,
      actor: message("Show my calendar."),
      parameters: { subaction: "feed" },
      delivered,
    });

    expect(result).toMatchObject({
      success: false,
      effectReceipts: [
        {
          operation: "calendar.feed",
          outcome: "failed",
          failure: {
            code: "CALENDAR_PROVIDER_UNAVAILABLE",
            retryable: true,
            acceptance: "rejected",
          },
        },
      ],
    });
    // The delivered failure text is the turn's complete honest outcome: the
    // stamp routes it through the same single-message gate as successes so
    // the evaluator cannot append a paraphrase bubble.
    expect(result.turnComplete).toBe(true);
    expectBoundDelivery(delivered, result);
  });

  it("sanitizes planner junk connector hints instead of rejecting the read", async () => {
    const getCalendarFeed = vi.fn(
      async (_url: URL, _request?: Record<string, unknown>) => feed(),
    );
    const service = { getCalendarFeed };
    const action = createCalendarActionRunner(deps());
    const delivered: Content[] = [];

    // Live regression 2026-08-09: the planner junk-fills every details key;
    // mode:"read" / grantId:"primary" previously hard-400'd inside
    // CalendarService's enum validation and the user saw "calendar's acting
    // up" for a healthy calendar.
    const result = await execute({
      action,
      service,
      actor: message("whats on my calendar tomorrow"),
      parameters: {
        subaction: "feed",
        details: {
          mode: "read",
          side: "owner",
          grantId: "primary",
          calendarId: "default",
          timeZone: "UTC",
          timeMin: "2026-07-27T00:00:00.000Z",
          timeMax: "2026-08-03T00:00:00.000Z",
        },
      },
      delivered,
    });

    expect(result, JSON.stringify(result)).toMatchObject({
      success: true,
      verifiedUserFacing: true,
      turnComplete: true,
    });
    expect(getCalendarFeed).toHaveBeenCalledOnce();
    const request = getCalendarFeed.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    // The junk hints are dropped, the recognizable ones survive, and the
    // window reaches the service well-formed.
    expect(request.mode).toBeUndefined();
    expect(request.grantId).toBeUndefined();
    expect(request.calendarId).toBeUndefined();
    expect(request.side).toBe("owner");
    expect(request.timeZone).toBe("UTC");
    expect(request.timeMin).toBe("2026-07-27T00:00:00.000Z");
    expect(request.timeMax).toBe("2026-08-03T00:00:00.000Z");
  });

  it.each([
    {
      label: "valid+invalid",
      timeMin: "2026-08-05T09:00:00Z",
      timeMax: "not-a-date",
    },
    {
      label: "invalid+valid",
      timeMin: "not-a-date",
      timeMax: "2026-08-05T10:00:00Z",
    },
    {
      label: "reversed",
      timeMin: "2026-08-05T10:00:00Z",
      timeMax: "2026-08-05T09:00:00Z",
    },
    {
      label: "valid offset pair",
      timeMin: "2026-08-05T09:00:00-07:00",
      timeMax: "2026-08-05T10:00:00-07:00",
      expected: {
        timeMin: "2026-08-05T16:00:00.000Z",
        timeMax: "2026-08-05T17:00:00.000Z",
      },
    },
  ])(
    "sends only a complete ordered service window for $label planner bounds",
    async ({ timeMin, timeMax, expected }) => {
      const requests: Record<string, unknown>[] = [];
      const getCalendarFeed = vi.fn(
        async (_url: URL, request?: Record<string, unknown>) => {
          requireOrderedCalendarWindow(request);
          requests.push(request ?? {});
          return feed();
        },
      );
      const action = createCalendarActionRunner(deps());

      const result = await execute({
        action,
        service: { getCalendarFeed },
        actor: message("Show my calendar."),
        parameters: {
          subaction: "feed",
          details: { timeMin, timeMax, timeZone: "UTC" },
        },
        delivered: [],
      });

      expect(result.success, JSON.stringify(result)).toBe(true);
      expect(requests).toHaveLength(1);
      const request = requests[0];
      if (expected) {
        expect(request).toMatchObject(expected);
      } else {
        expect(
          Date.parse(request.timeMax as string) -
            Date.parse(request.timeMin as string),
        ).toBe(24 * 60 * 60 * 1000);
      }
    },
  );

  it("passes a real grant id through untouched", async () => {
    const getCalendarFeed = vi.fn(
      async (_url: URL, _request?: Record<string, unknown>) => feed(),
    );
    const service = { getCalendarFeed };
    const action = createCalendarActionRunner(deps());

    await execute({
      action,
      service,
      actor: message("whats on my calendar tomorrow"),
      parameters: {
        subaction: "feed",
        details: { grantId: "connector-account:calendar-owner" },
      },
      delivered: [],
    });

    const request = getCalendarFeed.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(request.grantId).toBe("connector-account:calendar-owner");
  });

  it("drops planner key debris only from structured routing controls", async () => {
    const getCalendarFeed = vi.fn(
      async (_url: URL, _request?: Record<string, unknown>) => feed(),
    );
    const action = createCalendarActionRunner(deps());

    const result = await execute({
      action,
      service: { getCalendarFeed },
      actor: message("whats on my calendar tomorrow"),
      parameters: {
        subaction: "feed",
        details: {
          calendar_id: ",calendar_id:",
          grantId: "grantId",
          mode: "mode",
          side: "side",
          timeZone: "timeZone",
        },
      },
      delivered: [],
    });

    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(getCalendarFeed).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        calendarId: undefined,
        grantId: undefined,
        mode: undefined,
        side: undefined,
      }),
    );
  });

  it("preserves a search query literally equal to its field name", async () => {
    const action = createCalendarActionRunner(deps());

    const result = await execute({
      action,
      service: { getCalendarFeed: vi.fn(async () => feed([])) },
      actor: message("find query"),
      parameters: {
        subaction: "search_events",
        details: { query: "query" },
      },
      delivered: [],
    });

    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(result.userFacingText).toContain('"query"');
  });

  it("preserves event content literally equal to its field names", async () => {
    const literalEvent: LifeOpsCalendarEvent = {
      ...ELIZA_EVENT,
      title: "title",
      location: "location",
    };
    const prepareCalendarEventCreate = vi.fn(
      async (_url: URL, request: Record<string, unknown>) => ({
        ...request,
        side: "owner" as const,
        grantId: "eliza-calendar",
        calendarId: "primary",
      }),
    );
    const createCalendarEvent = vi.fn(async () => literalEvent);
    const action = createCalendarActionRunner(
      deps({
        mutationGateway: {
          schedule: vi.fn(),
          modify: vi.fn(),
          cancel: vi.fn(),
        },
      }),
    );

    const result = await execute({
      action,
      service: {
        getCalendarFeed: vi.fn(async () => feed([])),
        prepareCalendarEventCreate,
        createCalendarEvent,
      },
      actor: message("add title at location"),
      parameters: {
        subaction: "create_event",
        details: {
          title: "title",
          location: "location",
          startAt: ELIZA_EVENT.startAt,
          endAt: ELIZA_EVENT.endAt,
          timeZone: "UTC",
        },
      },
      delivered: [],
    });

    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(prepareCalendarEventCreate).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ title: "title", location: "location" }),
    );
    expect(createCalendarEvent).toHaveBeenCalledOnce();
  });

  it("reports the swallowed service-rejection detail with the request hints", async () => {
    const service = {
      getCalendarFeed: vi.fn(async () => {
        throw new CalendarServiceError(
          400,
          "mode must be one of: local, remote, cloud_managed",
        );
      }),
    };
    const action = createCalendarActionRunner(deps());
    const reportError = vi.fn();

    const result = await execute({
      action,
      service,
      actor: message("whats on my calendar tomorrow"),
      parameters: {
        subaction: "feed",
        details: { mode: "definitely-junk", timeZone: "UTC" },
      },
      delivered: [],
      reportError,
    });

    expect(result).toMatchObject({
      success: false,
      effectReceipts: [
        {
          outcome: "failed",
          failure: { code: "CALENDAR_SERVICE_400" },
        },
      ],
    });
    // The operator-facing report carries the actual rejection message and the
    // request hints that produced it — the receipt alone only says 400.
    expect(reportError).toHaveBeenCalledWith(
      "calendar:action",
      expect.any(CalendarServiceError),
      expect.objectContaining({
        subaction: "feed",
        status: 400,
        code: "CALENDAR_SERVICE_400",
        detail: "mode must be one of: local, remote, cloud_managed",
        mode: "definitely-junk",
        timeZone: "UTC",
      }),
    );
  });
});

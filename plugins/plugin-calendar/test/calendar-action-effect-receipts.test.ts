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
}) {
  const actorRuntime = runtime(args.service, args.action);
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
          startAt: "2026-07-28T22:00:00.000Z",
          endAt: "2026-07-28T22:30:00.000Z",
          timeZone: "UTC",
        },
      },
      delivered,
    });

    expect(schedule, JSON.stringify(result)).toHaveBeenCalledOnce();
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
    expectBoundDelivery(delivered, result);
  });
});

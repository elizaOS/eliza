/**
 * The conversational calendar gateway freezes exact provider intent into the
 * owner-approval queue; no provider service participates in this harness.
 */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import type {
  CalendarMutationGatewayDep,
  CalendarTravelBufferResult,
} from "@elizaos/plugin-calendar";
import type { LifeOpsCalendarEvent } from "@elizaos/shared";
import { describe, expect, it, vi } from "vitest";
import { createCalendarMutationApprovalGateway } from "../src/actions/calendar.js";
import type {
  ApprovalEnqueueInput,
  ApprovalRequest,
} from "../src/lifeops/approval-queue.types.js";

const MESSAGE_CREATED_AT = 1_780_000_000_000;

function message(): Memory {
  return {
    id: "00000000-0000-0000-0000-000000000501",
    entityId: "00000000-0000-0000-0000-000000000502",
    roomId: "00000000-0000-0000-0000-000000000503",
    createdAt: MESSAGE_CREATED_AT,
    content: { text: "calendar mutation" },
  } as Memory;
}

function runtime(): IAgentRuntime {
  return {
    agentId: "00000000-0000-0000-0000-000000000504",
  } as IAgentRuntime;
}

function event(role: "organizer" | "invitee"): LifeOpsCalendarEvent {
  return {
    id: `owner:google:primary:${role}`,
    externalId: `provider-${role}`,
    agentId: "agent-1",
    provider: "google",
    side: "owner",
    grantId: "grant-google-a",
    calendarId: "primary",
    title: role === "organizer" ? "School conference" : "Birthday party",
    description: "",
    location: "",
    status: "confirmed",
    startAt: "2026-08-03T17:00:00.000Z",
    endAt: "2026-08-03T18:00:00.000Z",
    isAllDay: false,
    timezone: "America/Los_Angeles",
    htmlLink: null,
    conferenceLink: null,
    organizer:
      role === "organizer"
        ? { self: true, email: "owner@example.com" }
        : { self: false, email: "host@example.com" },
    attendees: [
      {
        email: "owner@example.com",
        displayName: "Owner",
        responseStatus: "accepted",
        self: true,
        organizer: role === "organizer",
        optional: false,
      },
    ],
    metadata: { etag: `"${role}-etag"` },
    syncedAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:00.000Z",
  };
}

function harness(): {
  gateway: CalendarMutationGatewayDep;
  enqueue: ReturnType<typeof vi.fn>;
} {
  const enqueue = vi.fn(async (input: ApprovalEnqueueInput) => {
    const now = new Date(MESSAGE_CREATED_AT);
    return {
      request: {
        id: `approval-${input.action}`,
        createdAt: now,
        updatedAt: now,
        state: "pending",
        requestedBy: input.requestedBy,
        subjectUserId: input.subjectUserId,
        action: input.action,
        payload: input.payload,
        channel: input.channel,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey ?? null,
        expiresAt: input.expiresAt,
        resolvedAt: null,
        resolvedBy: null,
        resolutionReason: null,
      } satisfies ApprovalRequest,
      reused: false,
    };
  });
  return {
    gateway: createCalendarMutationApprovalGateway({
      createQueue: () => ({ enqueueWithResult: enqueue }),
    }),
    enqueue,
  };
}

describe("calendar conversational mutation approval gateway", () => {
  it("binds an exact idempotent create and defaults notifications off", async () => {
    const { gateway, enqueue } = harness();
    const travelBuffer: CalendarTravelBufferResult = {
      bufferMinutes: 25,
      method: "maps-api",
      originAddress: "Home",
      destinationAddress: "School",
    };
    const args: Parameters<typeof gateway.schedule>[0] = {
      runtime: runtime(),
      message: message(),
      request: {
        side: "owner",
        grantId: "grant-google-a",
        calendarId: "primary",
        title: "School conference",
        startAt: "2026-08-03T17:00:00.000Z",
        endAt: "2026-08-03T18:00:00.000Z",
        timeZone: "America/Los_Angeles",
        attendees: [{ email: "teacher@example.com" }],
        recurrence: ["RRULE:FREQ=WEEKLY;COUNT=4"],
      },
      travelBuffer,
    };

    const result = await gateway.schedule(args);
    await gateway.schedule(args);

    const first = enqueue.mock.calls[0]?.[0] as ApprovalEnqueueInput;
    const second = enqueue.mock.calls[1]?.[0] as ApprovalEnqueueInput;
    expect(first).toMatchObject({
      action: "schedule_event",
      channel: "google_calendar",
      requestedBy: "PERSONAL_ASSISTANT:CALENDAR",
      subjectUserId: message().entityId,
      payload: {
        action: "schedule_event",
        side: "owner",
        grantId: "grant-google-a",
        calendarId: "primary",
        title: "School conference",
        startsAtMs: Date.parse("2026-08-03T17:00:00.000Z"),
        endsAtMs: Date.parse("2026-08-03T18:00:00.000Z"),
        attendees: [{ email: "teacher@example.com" }],
        recurrence: ["RRULE:FREQ=WEEKLY;COUNT=4"],
        notifyAttendees: false,
        travelBuffer,
      },
    });
    expect(first.idempotencyKey).toMatch(
      /^calendar-conversation:00000000-0000-0000-0000-000000000501:[a-f0-9]{64}$/,
    );
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(first.expiresAt.toISOString()).toBe(
      new Date(MESSAGE_CREATED_AT + 24 * 60 * 60 * 1000).toISOString(),
    );
    expect(result).toMatchObject({
      requestId: "approval-schedule_event",
      acceptedAt: new Date(MESSAGE_CREATED_AT).toISOString(),
      idempotencyKey: first.idempotencyKey,
      replayed: false,
    });
  });

  it("routes approvals through the provider bound to the mutation target", async () => {
    const { gateway, enqueue } = harness();
    const schedule = async (grantId: string) =>
      gateway.schedule({
        runtime: runtime(),
        message: message(),
        request: {
          side: "owner",
          grantId,
          calendarId: "primary",
          title: "Provider-bound event",
          startAt: "2026-08-03T17:00:00.000Z",
          endAt: "2026-08-03T18:00:00.000Z",
        },
        travelBuffer: null,
      });

    await schedule("apple-calendar");
    await schedule("connector-account:microsoft:account-a");

    const microsoftTarget = {
      ...event("organizer"),
      provider: "microsoft" as const,
      grantId: "connector-account:microsoft:account-a",
    };
    await gateway.modify({
      runtime: runtime(),
      message: message(),
      targetEvent: microsoftTarget,
      request: {
        side: "owner",
        grantId: microsoftTarget.grantId,
        calendarId: "primary",
        eventId: microsoftTarget.externalId,
        title: "Provider-bound event moved",
        recurrenceScope: "instance",
        notifyAttendees: false,
      },
    });
    await gateway.cancel({
      runtime: runtime(),
      message: message(),
      targetEvent: microsoftTarget,
      request: {
        side: "owner",
        grantId: microsoftTarget.grantId,
        calendarId: "primary",
        eventId: microsoftTarget.externalId,
        recurrenceScope: "instance",
        notifyAttendees: false,
      },
    });

    expect(enqueue.mock.calls.map(([input]) => input.channel)).toEqual([
      "apple_calendar",
      "microsoft_calendar",
      "microsoft_calendar",
      "microsoft_calendar",
    ]);
  });

  it("binds the exact update target, patch, scope, and notification choice", async () => {
    const { gateway, enqueue } = harness();
    const target = event("organizer");

    await gateway.modify({
      runtime: runtime(),
      message: message(),
      targetEvent: target,
      request: {
        side: "owner",
        grantId: "grant-google-a",
        calendarId: "primary",
        eventId: target.externalId,
        title: "School conference moved",
        startAt: "2026-08-03T18:00:00.000Z",
        endAt: "2026-08-03T19:00:00.000Z",
        recurrenceScope: "series",
        notifyAttendees: true,
      },
    });

    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({
      action: "modify_event",
      payload: {
        action: "modify_event",
        grantId: "grant-google-a",
        calendarId: "primary",
        eventId: target.externalId,
        expectedProvider: "google",
        expectedEventUpdatedAt: target.updatedAt,
        expectedEventStartAtMs: Date.parse(target.startAt),
        recurrenceScope: "series",
        notifyAttendees: true,
        patch: {
          title: "School conference moved",
          startsAtMs: Date.parse("2026-08-03T18:00:00.000Z"),
          endsAtMs: Date.parse("2026-08-03T19:00:00.000Z"),
        },
      },
    });
  });

  it("binds the exact master and discloses exception reset for a following split", async () => {
    const { gateway, enqueue } = harness();
    const target = {
      ...event("organizer"),
      externalId: "series-instance-3",
      recurringEventId: "series-master",
      metadata: {
        etag: '"instance-etag"',
        recurringEventId: "series-master",
        originalStartTime: "2026-08-03T17:00:00.000Z",
      },
    };
    const master = {
      ...event("organizer"),
      id: "owner:google:primary:series-master",
      externalId: "series-master",
      startAt: "2026-07-20T17:00:00.000Z",
      recurrence: ["RRULE:FREQ=WEEKLY;COUNT=8"],
      recurringEventId: null,
      metadata: {
        etag: '"master-etag"',
        recurrence: ["RRULE:FREQ=WEEKLY;COUNT=8"],
      },
    };
    const runtimeWithCalendar = {
      ...runtime(),
      getService: (name: string) =>
        name === "calendar"
          ? {
              getConditionalCalendarMutationTarget: vi.fn(async () => master),
            }
          : null,
    } as unknown as IAgentRuntime;

    await gateway.modify({
      runtime: runtimeWithCalendar,
      message: message(),
      targetEvent: target,
      request: {
        side: "owner",
        grantId: "grant-google-a",
        calendarId: "primary",
        eventId: target.externalId,
        title: "School conference moved",
        recurrenceScope: "this_and_following",
        notifyAttendees: true,
      },
    });

    const input = enqueue.mock.calls[0]?.[0] as ApprovalEnqueueInput;
    expect(input.payload).toMatchObject({
      action: "modify_event",
      recurrenceScope: "this_and_following",
      expectedProviderVersion: '"instance-etag"',
      seriesMaster: {
        externalId: "series-master",
        startAtMs: Date.parse(master.startAt),
        updatedAt: master.updatedAt,
        etag: '"master-etag"',
      },
    });
    expect(input.reason).toContain(
      "Later per-occurrence exceptions will reset",
    );
    expect(input.reason).toContain("both split update notifications");
  });

  it("maps invitee delete to decline and organizer delete to cancellation", async () => {
    const { gateway, enqueue } = harness();
    for (const role of ["invitee", "organizer"] as const) {
      const target = event(role);
      await gateway.cancel({
        runtime: runtime(),
        message: {
          ...message(),
          id:
            role === "invitee"
              ? "00000000-0000-0000-0000-000000000511"
              : "00000000-0000-0000-0000-000000000512",
        } as Memory,
        targetEvent: target,
        request: {
          side: "owner",
          grantId: "grant-google-a",
          calendarId: "primary",
          eventId: target.externalId,
          recurrenceScope: "instance",
          notifyAttendees: role === "organizer",
        },
      });
    }

    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({
      payload: {
        action: "cancel_event",
        cancellationMode: "decline_invitation",
        notifyAttendees: false,
      },
    });
    expect(enqueue.mock.calls[1]?.[0]).toMatchObject({
      payload: {
        action: "cancel_event",
        cancellationMode: "organizer_cancel",
        notifyAttendees: true,
      },
    });
  });
});

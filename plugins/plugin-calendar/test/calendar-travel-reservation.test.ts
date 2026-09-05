/**
 * Calendar create-event travel tests prove travel intent is frozen into the
 * immutable approval and never causes provider or reservation side effects
 * during the conversational turn.
 */

import type { IAgentRuntime, Memory } from "@elizaos/core";
import type { LifeOpsCalendarEvent } from "@elizaos/shared";
import { describe, expect, it, vi } from "vitest";
import {
  type CalendarActionDeps,
  createCalendarActionRunner,
} from "../src/index.js";
import { detailString } from "../src/internal/detail.js";

const CREATED_EVENT: LifeOpsCalendarEvent = {
  id: "agent-1:google:owner:calendar:primary:event-1",
  externalId: "event-1",
  agentId: "agent-1",
  provider: "google",
  side: "owner",
  calendarId: "primary",
  title: "Soccer practice",
  description: "",
  location: "100 Field Way",
  status: "confirmed",
  startAt: "2026-07-27T16:00:00.000Z",
  endAt: "2026-07-27T17:00:00.000Z",
  isAllDay: false,
  timezone: "UTC",
  htmlLink: null,
  conferenceLink: null,
  organizer: null,
  attendees: [],
  metadata: {},
  syncedAt: "2026-07-26T00:00:00.000Z",
  updatedAt: "2026-07-26T00:00:00.000Z",
};

function message(): Memory {
  return {
    id: "00000000-0000-0000-0000-000000000301",
    entityId: "00000000-0000-0000-0000-000000000302",
    roomId: "00000000-0000-0000-0000-000000000303",
    content: { text: "Add soccer practice with travel from home" },
  } as Memory;
}

async function runCreate(
  computeTravelBuffer: NonNullable<
    CalendarActionDeps["travelBuffer"]
  >["computeTravelBuffer"],
  options: { title?: string; details?: Record<string, unknown> } = {},
) {
  const reserveTravelBuffer = vi.fn(async () => undefined);
  const scheduleApproval = vi.fn(
    async (
      _args: Parameters<
        NonNullable<CalendarActionDeps["mutationGateway"]>["schedule"]
      >[0],
    ) => ({
      requestId: "approval-travel",
      action: "schedule_event" as const,
      state: "pending" as const,
      acceptedAt: "2026-07-27T12:00:00.000Z",
      idempotencyKey: "calendar-approval:travel",
      replayed: false,
      text: "travel schedule approval queued",
    }),
  );
  const service = {
    getCalendarFeed: vi.fn(async () => ({
      calendarId: "primary",
      events: [],
      source: "synced" as const,
      state: "complete" as const,
      sources: [{ status: "fresh" as const }],
      timeMin: "2026-07-26T00:00:00.000Z",
      timeMax: "2026-08-09T00:00:00.000Z",
      syncedAt: "2026-07-26T00:00:00.000Z",
    })),
    prepareCalendarEventCreate: vi.fn(
      async (_url: URL, request: Record<string, unknown>) => ({
        ...request,
        side: "owner" as const,
        grantId: "connector-account:acct-a",
        calendarId: "primary",
        startAt: CREATED_EVENT.startAt,
        endAt: CREATED_EVENT.endAt,
        timeZone: "UTC",
      }),
    ),
    createCalendarEvent: vi.fn(async () => CREATED_EVENT),
  };
  const runtime = {
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
  const deps: CalendarActionDeps = {
    runTextModel: vi.fn(async () => null),
    runJsonModel: vi.fn(async () => null),
    recentConversationTexts: vi.fn(async () => []),
    mutationGateway: {
      schedule: scheduleApproval,
      modify: vi.fn(),
      cancel: vi.fn(),
    },
    travelBuffer: {
      resolveTravelIntent: ({ details, extractedDetails }) => {
        const originAddress =
          detailString(extractedDetails, "travelOriginAddress") ??
          detailString(details, "travelOriginAddress");
        return originAddress ? { originAddress } : null;
      },
      computeTravelBuffer,
      reserveTravelBuffer,
      isTravelTimeUnavailable: (
        error,
      ): error is { code: string; message: string } =>
        error instanceof Error &&
        "code" in error &&
        error.code === "TRAVEL_TIME_UNAVAILABLE",
    },
  };
  const action = createCalendarActionRunner(deps);
  const callback = vi.fn(async () => []);
  const result = await action.handler(
    runtime,
    message(),
    undefined,
    {
      parameters: {
        subaction: "create_event",
        title: options.title ?? CREATED_EVENT.title,
        details: {
          startAt: CREATED_EVENT.startAt,
          endAt: CREATED_EVENT.endAt,
          timeZone: "UTC",
          ...(options.details ?? {
            location: CREATED_EVENT.location,
            travelOriginAddress: "1 Home Road",
          }),
        },
      },
    },
    callback,
  );
  if (!result) throw new Error("Expected a Calendar action result");
  expect(result.effectReceipts).toHaveLength(1);
  if (result.transcriptVisibility === "internal") {
    expect(callback).not.toHaveBeenCalled();
    // Settled internal results omit turnComplete (evaluation delegated); pauses keep false.
    expect(result.turnComplete).not.toBe(true);
    expect(result).not.toHaveProperty("text");
    expect(result).not.toHaveProperty("userFacingText");
    expect(result.data?.replyContext).toMatchObject({
      domain: "calendar",
      intent: message().content.text,
      scenario: expect.any(String),
      facts: expect.stringMatching(/\S/),
      context: expect.any(Object),
    });
  } else {
    expect(result.turnComplete).toBe(true);
    expect(result.userFacingText).toBe("travel schedule approval queued");
    expect(result.userFacingEffectReceiptIds).toEqual([
      result.effectReceipts?.[0]?.receiptId,
    ]);
    expect(callback).toHaveBeenCalledExactlyOnceWith({
      text: "travel schedule approval queued",
      source: "action",
      action: "CALENDAR",
    });
  }
  return {
    result,
    reserveTravelBuffer,
    scheduleApproval,
    service,
    runJsonModel: deps.runJsonModel,
  };
}

describe("calendar travel reservation truth", () => {
  it("does not invent travel intent when native arguments omit origin and location", async () => {
    const computeTravelBuffer = vi.fn(async () => {
      throw new Error(
        "an event without travel must not call the route provider",
      );
    });
    const { result, scheduleApproval, service, runJsonModel } = await runCreate(
      computeTravelBuffer,
      { details: {} },
    );

    expect(result.success).toBe(true);
    expect(scheduleApproval).toHaveBeenCalledOnce();
    const approval = scheduleApproval.mock.calls[0]?.[0];
    expect(approval).not.toHaveProperty("travelBuffer");
    expect(
      service.prepareCalendarEventCreate.mock.calls[0]?.[1],
    ).not.toHaveProperty("travelOriginAddress");
    expect(computeTravelBuffer).not.toHaveBeenCalled();
    expect(runJsonModel).not.toHaveBeenCalled();
    expect(service.createCalendarEvent).not.toHaveBeenCalled();
  });

  it.each(["Unknown", "None", "n/a", "location_missing"])(
    "preserves literal %s titles, descriptions, locations, and explicit travel origins",
    async (literal) => {
      const computeTravelBuffer = vi.fn(async () => ({
        originAddress: literal,
        destinationAddress: literal,
        bufferMinutes: 25,
        method: "driving",
      }));
      const { result, scheduleApproval, service } = await runCreate(
        computeTravelBuffer,
        {
          title: literal,
          details: {
            description: literal,
            location: literal,
            travelOriginAddress: literal,
          },
        },
      );

      expect(result.success).toBe(true);
      expect(service.prepareCalendarEventCreate).toHaveBeenCalledWith(
        expect.any(URL),
        expect.objectContaining({
          title: literal,
          description: literal,
          location: literal,
        }),
      );
      expect(computeTravelBuffer).toHaveBeenCalledWith(
        expect.objectContaining({
          travelIntent: { originAddress: literal },
          event: expect.objectContaining({ location: literal }),
        }),
      );
      expect(scheduleApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({
            title: literal,
            description: literal,
            location: literal,
          }),
          travelBuffer: expect.objectContaining({
            originAddress: literal,
            destinationAddress: literal,
          }),
        }),
      );
    },
  );

  it("binds the computed travel buffer into approval without mutating", async () => {
    const computeTravelBuffer = vi.fn(async () => ({
      originAddress: "1 Home Road",
      destinationAddress: CREATED_EVENT.location,
      bufferMinutes: 25,
      method: "driving",
    }));

    const { result, reserveTravelBuffer, scheduleApproval, service } =
      await runCreate(computeTravelBuffer);

    expect(scheduleApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        travelBuffer: {
          originAddress: "1 Home Road",
          destinationAddress: CREATED_EVENT.location,
          bufferMinutes: 25,
          method: "driving",
        },
      }),
    );
    expect(service.createCalendarEvent).not.toHaveBeenCalled();
    expect(reserveTravelBuffer).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.text).toContain("approval queued");
    expect(result.data?.travelBuffer).toMatchObject({ bufferMinutes: 25 });
  });

  it("blocks approval and provider mutation when travel cannot be prepared", async () => {
    const computeTravelBuffer = vi.fn(async () => {
      throw Object.assign(new Error("route unavailable"), {
        code: "TRAVEL_TIME_UNAVAILABLE",
      });
    });

    const { result, reserveTravelBuffer, scheduleApproval, service } =
      await runCreate(computeTravelBuffer);

    expect(result.success).toBe(false);
    expect(result.data?.replyContext).toMatchObject({
      facts: expect.stringContaining("did not queue or create"),
    });
    expect(result.data).toMatchObject({
      error: "TRAVEL_TIME_UNAVAILABLE",
    });
    expect(scheduleApproval).not.toHaveBeenCalled();
    expect(service.createCalendarEvent).not.toHaveBeenCalled();
    expect(reserveTravelBuffer).not.toHaveBeenCalled();
  });
});

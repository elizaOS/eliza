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
) {
  const reserveTravelBuffer = vi.fn(async () => undefined);
  const scheduleApproval = vi.fn(async () => ({
    requestId: "approval-travel",
    action: "schedule_event" as const,
    state: "pending" as const,
    text: "travel schedule approval queued",
  }));
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
      resolveTravelIntent: () => ({ originAddress: "1 Home Road" }),
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
  const result = await action.handler(
    runtime,
    message(),
    undefined,
    {
      parameters: {
        subaction: "create_event",
        title: CREATED_EVENT.title,
        details: {
          startAt: CREATED_EVENT.startAt,
          endAt: CREATED_EVENT.endAt,
          timeZone: "UTC",
          location: CREATED_EVENT.location,
          travelOriginAddress: "1 Home Road",
        },
      },
    },
    undefined,
  );
  return {
    result: result as {
      success: boolean;
      text: string;
      data: Record<string, unknown>;
    },
    reserveTravelBuffer,
    scheduleApproval,
    service,
  };
}

describe("calendar travel reservation truth", () => {
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
    expect(result.data.travelBuffer).toMatchObject({ bufferMinutes: 25 });
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
    expect(result.text).toContain("did not queue or create");
    expect(result.data).toMatchObject({
      error: "TRAVEL_TIME_UNAVAILABLE",
    });
    expect(scheduleApproval).not.toHaveBeenCalled();
    expect(service.createCalendarEvent).not.toHaveBeenCalled();
    expect(reserveTravelBuffer).not.toHaveBeenCalled();
  });
});

import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { CalendarServiceError } from "../internal/errors.js";
import {
  createCalendarActionRunner,
  rejectedArgumentForCalendarServiceError,
} from "./calendar-handler";

describe("rejectedArgumentForCalendarServiceError", () => {
  it("names the planner argument the built-in calendar rejected", () => {
    expect(
      rejectedArgumentForCalendarServiceError(
        "ELIZA_CALENDAR_RECURRENCE_UNSUPPORTED",
      ),
    ).toBe("details.recurrence");
    expect(
      rejectedArgumentForCalendarServiceError(
        "ELIZA_CALENDAR_ATTENDEE_NOTIFICATIONS_UNSUPPORTED",
      ),
    ).toBe("details.notifyAttendees");
  });

  it("leaves other service errors as ordinary failures", () => {
    expect(
      rejectedArgumentForCalendarServiceError("ELIZA_CALENDAR_NOT_FOUND"),
    ).toBeUndefined();
    expect(rejectedArgumentForCalendarServiceError(undefined)).toBeUndefined();
  });
});

describe("calendar connection failure evidence", () => {
  it("gives the final model connection facts instead of only an ambiguous 409", async () => {
    const getTarget = vi.fn(async () => {
      throw new CalendarServiceError(409, "Google Calendar is not connected.");
    });
    const update = vi.fn();
    const runtime = {
      agentId: "00000000-0000-4000-8000-000000000aaa",
      getSetting: () => undefined,
      getService: (name: string) =>
        name === "calendar"
          ? {
              getConditionalCalendarMutationTarget: getTarget,
              updateCalendarEvent: update,
            }
          : null,
      reportError: vi.fn(),
      character: { name: "Eliza" },
    } as unknown as IAgentRuntime;
    const runner = createCalendarActionRunner({
      runJsonModel: async () => ({ rawResponse: "{}", parsed: {} }),
      runTextModel: async () => null,
      recentConversationTexts: async () => [],
    });
    const result = await runner.handler(
      runtime,
      {
        id: "00000000-0000-4000-8000-000000000aab",
        entityId: "00000000-0000-4000-8000-000000000aac",
        roomId: "00000000-0000-4000-8000-000000000aad",
        createdAt: Date.now(),
        content: { text: "Move the rehearsal to Tuesday at 9 AM." },
      } as Memory,
      undefined,
      {
        parameters: {
          subaction: "update_event",
          targetKind: "eventId",
          target: "provider-event",
        },
      },
    );
    expect(getTarget).toHaveBeenCalledOnce();
    expect(update).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false,
      modelReplyRequired: true,
      data: {
        replyContext: {
          scenario: "service_error",
          facts: expect.stringContaining(
            "Google Calendar account is not connected",
          ),
        },
      },
      effectReceipts: [expect.objectContaining({ outcome: "failed" })],
    });
  });
});

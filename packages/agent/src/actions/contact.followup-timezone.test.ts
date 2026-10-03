/**
 * Exercises CONTACT follow-up confirmation against the canonical calendar
 * timezone resolver with deterministic relationship and scheduler boundaries.
 */
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { registerCalendarTimeZoneResolver } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { contactAction } from "./contact.js";

const contactId = "00000000-0000-4000-8000-000000000123" as UUID;
const scheduledAt = "2026-08-20T23:00:00.000Z";

function followupRuntime(args: {
  scheduleFollowUp: ReturnType<typeof vi.fn>;
}): IAgentRuntime {
  return {
    getSetting: () => "UTC",
    getService: (name: string) => {
      if (name === "relationships") {
        return { getContact: async () => ({ entityId: contactId }) };
      }
      if (name === "follow_up") {
        return { scheduleFollowUp: args.scheduleFollowUp };
      }
      return null;
    },
  } as unknown as IAgentRuntime;
}

async function runFollowup(runtime: IAgentRuntime) {
  return contactAction.handler(runtime, {} as Memory, undefined, {
    parameters: {
      action: "followup",
      entityId: contactId,
      scheduledAt,
    },
  });
}

describe("CONTACT follow-up timezone", () => {
  it("confirms the scheduled instant in the owner's timezone", async () => {
    let scheduledDate: Date | undefined;
    const scheduleFollowUp = vi.fn(async (_entityId: UUID, date: Date) => {
      scheduledDate = date;
      return { id: "task-1" };
    });
    const runtime = followupRuntime({ scheduleFollowUp });
    registerCalendarTimeZoneResolver(
      runtime,
      async () => "America/Los_Angeles",
    );

    const result = await runFollowup(runtime);

    expect(result.text).toBe(
      "Scheduled follow-up with contact for 8/20/2026, 4:00:00 PM.",
    );
    expect(result.data).toMatchObject({ scheduledAt });
    expect(scheduleFollowUp).toHaveBeenCalledWith(
      contactId,
      expect.objectContaining({}),
      "Follow-up",
      "medium",
      undefined,
    );
    expect(scheduledDate).toBeInstanceOf(Date);
    expect(scheduledDate?.toISOString()).toBe(scheduledAt);
  });

  it("resolves the timezone before invoking the scheduler", async () => {
    const scheduleFollowUp = vi.fn(async () => ({ id: "task-1" }));
    const runtime = followupRuntime({ scheduleFollowUp });
    registerCalendarTimeZoneResolver(runtime, async () => {
      throw new Error("owner facts unavailable");
    });

    await expect(runFollowup(runtime)).rejects.toMatchObject({
      code: "CALENDAR_TIME_ZONE_UNAVAILABLE",
    });
    expect(scheduleFollowUp).not.toHaveBeenCalled();
  });
});

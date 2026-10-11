import type {
  HandlerOptions,
  IAgentRuntime,
  Memory,
  UUID,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { createContactActions } from "./contact.ts";

const CONTACT_ID = "00000000-0000-0000-0000-0000000000aa" as UUID;
const TASK_ID = "00000000-0000-0000-0000-0000000000bb" as UUID;

function createHarness(timeZone: string, contacts: unknown[] = []) {
  const scheduled: Date[] = [];
  const runtime = {
    getSetting: (key: string) => (key === "TIMEZONE" ? timeZone : undefined),
    getService: (name: string) => {
      if (name === "relationships") {
        return { searchContacts: async () => contacts };
      }
      if (name === "follow_up") {
        return {
          scheduleFollowUp: async (_entityId: UUID, scheduledAt: Date) => {
            scheduled.push(scheduledAt);
            return { id: TASK_ID };
          },
        };
      }
      return null;
    },
  } as unknown as IAgentRuntime;
  const { contactAction } = createContactActions({
    resolveGraph: async () => null,
    hasContextSignal: () => false,
  });
  const run = (scheduledAt: string) =>
    contactAction.handler(runtime, {} as Memory, undefined, {
      parameters: {
        action: "followup",
        entityId: CONTACT_ID,
        scheduledAt,
      },
    } as HandlerOptions);
  const runByName = (name: string) =>
    contactAction.handler(runtime, {} as Memory, undefined, {
      parameters: {
        action: "followup",
        name,
        scheduledAt: "2026-10-12T09:00",
      },
    } as HandlerOptions);
  return { run, runByName, scheduled };
}

describe("CONTACT follow-up time", () => {
  it("resolves an offset-less time with seconds in the owner's zone", async () => {
    const { run, scheduled } = createHarness("Asia/Kolkata");

    const result = await run("2026-10-12T09:00:30.125");

    expect(result.success).toBe(true);
    expect(scheduled[0]?.toISOString()).toBe("2026-10-12T03:30:30.125Z");
  });

  it("keeps an explicit numeric offset", async () => {
    const { run, scheduled } = createHarness("America/Los_Angeles");

    const result = await run("2026-10-12T09:00:30+05:30");

    expect(result.success).toBe(true);
    expect(scheduled[0]?.toISOString()).toBe("2026-10-12T03:30:30.000Z");
  });

  it("rejects skipped wall time and other offset-less forms", async () => {
    const { run, scheduled } = createHarness("America/Los_Angeles");

    for (const value of [
      "2026-03-08T02:30:30",
      "2026-10-12 09:00",
      "2026-10-12",
      "10-12-2026",
      "12-Oct-2026",
    ]) {
      const result = await run(value);
      expect(result).toMatchObject({
        success: false,
        data: { error: "INVALID_SCHEDULED_AT" },
      });
    }
    expect(scheduled).toHaveLength(0);
  });

  it("schedules nothing when the name matches more than one contact", async () => {
    const john = "00000000-0000-0000-0000-0000000000c1" as UUID;
    const joanna = "00000000-0000-0000-0000-0000000000c2" as UUID;
    const { runByName, scheduled } = createHarness("Asia/Kolkata", [
      { entityId: john, customFields: { displayName: "John" } },
      { entityId: joanna, customFields: { displayName: "Joanna" } },
    ]);

    const result = await runByName("Jo");

    expect(result).toMatchObject({
      success: false,
      data: {
        error: "AMBIGUOUS_CONTACT",
        matches: [
          { entityId: john, displayName: "John" },
          { entityId: joanna, displayName: "Joanna" },
        ],
      },
    });
    expect(scheduled).toHaveLength(0);
  });
});

/** Reminder prompts retain owner timezone; delivery copy preserves saved text. */
import {
  AUTONOMY_NOTIFICATION_DELIVERY,
  type AutonomyNotificationDelivery,
} from "@elizaos/agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildReminderBody,
  buildReminderDispatchPrompt,
  RemindersDomain,
} from "./reminders-service.js";

const ORIGINAL_TZ = process.env.TZ;

// 2026-08-20T23:00:00.000Z is 4:00 PM America/Los_Angeles (PDT) on Aug 20.
const DUE_AT = "2026-08-20T23:00:00.000Z";
const OWNER_TZ = "America/Los_Angeles";

afterEach(() => {
  process.env.TZ = ORIGINAL_TZ;
});

describe("buildReminderDispatchPrompt due line timezone", () => {
  it("anchors the due line to the explicit timezone regardless of host TZ", () => {
    const dueLines: string[] = [];
    for (const hostZone of ["UTC", "America/New_York"]) {
      process.env.TZ = hostZone;
      const prompt = buildReminderDispatchPrompt({
        runtime: { character: {}, getSetting: () => undefined } as never,
        title: "Call dentist",
        reminderAt: DUE_AT,
        channel: "in_app",
        lifecycle: "plan",
        urgency: "medium",
        recentConversation: [],
        timezone: OWNER_TZ,
      });
      dueLines.push(
        prompt.split("\n").find((line) => line.startsWith("- due:")) as string,
      );
    }
    expect(dueLines[0]).toBe("- due: 8/20/2026, 4:00:00 PM");
    expect(dueLines).toEqual([dueLines[0], dueLines[0]]);
    expect(dueLines[0]).not.toContain("11:00:00 PM");
    expect(dueLines[0]).not.toContain("7:00:00 PM");
  });

  it("keeps the host-local rendering when no timezone is supplied", () => {
    process.env.TZ = "UTC";
    const prompt = buildReminderDispatchPrompt({
      runtime: { character: {}, getSetting: () => undefined } as never,
      title: "Call dentist",
      reminderAt: DUE_AT,
      channel: "in_app",
      lifecycle: "plan",
      urgency: "medium",
      recentConversation: [],
    });
    expect(prompt).toContain("- due: 8/20/2026, 11:00:00 PM");
  });
});

describe("buildReminderBody saved message", () => {
  it("preserves the exact saved text regardless of host TZ", () => {
    for (const hostZone of ["UTC", "America/New_York"]) {
      process.env.TZ = hostZone;
      expect(buildReminderBody({ title: 'Call "dentist"  today' })).toBe(
        'Call "dentist"  today',
      );
    }
  });
});

describe("renderReminderBody saved message", () => {
  it("preserves saved text in the deterministic fallback body", async () => {
    process.env.TZ = "UTC";
    const domain = new RemindersDomain(
      {
        agentId: () => "agent-test",
        runtime: { agentId: "agent-test" },
      } as never,
      {
        runDueWorkflows: vi.fn(),
        runDueEventWorkflows: vi.fn(),
        snoozeOccurrence: vi.fn(),
        checkinSource: {},
      } as never,
    );
    // No useModel on the runtime: renderReminderBody must return the fallback,
    // which is the body owners receive when the model is unavailable.
    const body = await domain.renderReminderBody({
      title: "Call dentist",
      scheduledFor: DUE_AT,
      dueAt: DUE_AT,
      channel: "in_app",
      lifecycle: "plan",
      urgency: "medium",
      subjectType: "owner",
      timezone: OWNER_TZ,
    });
    expect(body).toBe("Call dentist");
  });
});

describe("dispatchReminderAttempt saved message", () => {
  it("delivers the exact saved message with separate timing metadata", async () => {
    process.env.TZ = "UTC";
    const createReminderAttempt = vi.fn(async () => undefined);
    const committedMessages: Array<{
      conversationId: string;
      messageId: string;
      text: string;
    }> = [];
    const updateReminderAttemptOutcome = vi.fn(async () => {
      expect(committedMessages).toHaveLength(1);
    });
    const emitAssistantEvent = vi.fn(
      (
        text: string,
        _kind: string,
        metadata: Record<string | symbol, unknown>,
      ) => {
        const handoff = metadata[
          AUTONOMY_NOTIFICATION_DELIVERY
        ] as AutonomyNotificationDelivery;
        handoff.routed = Promise.resolve().then(async () => {
          const committed = {
            conversationId: "conversation-test",
            messageId: "message-test",
            text,
          };
          committedMessages.push(committed);
          await handoff.publish(committed);
        });
      },
    );
    const domain = new RemindersDomain(
      {
        agentId: () => "agent-test",
        runtime: {
          agentId: "agent-test",
          getService: () => null,
        },
        repository: {
          createAuditEvent: vi.fn(async () => undefined),
          createReminderAttempt,
          updateReminderAttemptOutcome,
        },
        emitAssistantEvent,
      } as never,
      {
        runDueWorkflows: vi.fn(),
        runDueEventWorkflows: vi.fn(),
        snoozeOccurrence: vi.fn(),
        checkinSource: {},
      } as never,
    );

    const attempt = await domain.dispatchReminderAttempt({
      plan: { id: "plan-1" } as never,
      ownerType: "occurrence",
      ownerId: "occurrence-1",
      occurrenceId: null,
      subjectType: "owner",
      title: "Call dentist",
      channel: "in_app",
      stepIndex: 0,
      scheduledFor: DUE_AT,
      dueAt: DUE_AT,
      urgency: "medium",
      quietHours: {},
      acknowledged: false,
      attemptedAt: "2026-08-20T23:00:00.000Z",
      lifecycle: "plan",
      timezone: OWNER_TZ,
      definition: null,
    });

    expect(attempt.outcome).toBe("delivered");
    expect(committedMessages).toEqual([
      {
        conversationId: "conversation-test",
        messageId: "message-test",
        text: "Call dentist",
      },
    ]);
    expect(updateReminderAttemptOutcome).toHaveBeenCalledExactlyOnceWith(
      attempt.id,
      "delivered",
      expect.objectContaining({ reason: null, error: null }),
    );
    expect(createReminderAttempt).toHaveBeenCalledTimes(1);
    const delivered = createReminderAttempt.mock.calls[0]?.[0] as {
      scheduledFor: string;
      deliveryMetadata: { message?: string };
    };
    expect(delivered.deliveryMetadata.message).toBe("Call dentist");
    expect(delivered.scheduledFor).toBe(DUE_AT);
  });
});

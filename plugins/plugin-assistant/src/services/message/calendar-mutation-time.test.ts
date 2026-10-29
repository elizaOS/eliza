/** Actual egress/recovery protects a committed Calendar event without re-executing it. */
import {
  type Action,
  type ActionResult,
  type EffectReceipt,
  type Memory,
  ModelType,
  stringToUuid,
} from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { afterEach, expect, it } from "vitest";
import {
  evaluatePlannedReplyEgress,
  resolvePlannedReplyEgress,
} from "./egress-policy.ts";
import { calendarMutationTimeIsUngrounded } from "./time-observations.ts";

const request = "Create an event to meet with Shaw in 20 mins for 1hr";
const wrong = "Done. Meet with Shaw, tonight 5:52 to 6:52 PM.";
const correct = "Created your meeting with Shaw for today, 4:52–5:52 PM.";
const runtimes: ReturnType<typeof createSQLiteTestRuntime>[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    await runtime.stop();
    await runtime.close();
  }
});
function evidence(
  agentId: string,
  startAt = "2026-10-29T23:52:29.000Z",
  endAt = "2026-10-30T00:52:29.000Z",
  timezone = "America/Los_Angeles",
) {
  const receipt: EffectReceipt = {
    receiptId: "calendar-create-receipt",
    operation: "calendar.event.create",
    resource: { kind: "calendar.event", id: "saved-event", version: "1" },
    artifacts: [],
    idempotency: { key: "original-create", replayed: false },
    observedAt: "2026-10-29T23:32:29.000Z",
    outcome: "applied",
    commit: {
      kind: "durable",
      id: "saved-event",
      committedAt: "2026-10-29T23:32:29.000Z",
    },
  };
  const result: ActionResult = {
    success: true,
    transcriptVisibility: "internal",
    modelReplyRequired: true,
    effectReceipts: [receipt],
    data: {
      actionName: "CALENDAR",
      subaction: "create_event",
      event: {
        id: "saved-event",
        agentId,
        startAt,
        endAt,
        timezone,
        isAllDay: false,
        metadata: { etag: "1" },
      },
    },
  };
  return { receipt, result };
}
const calendar: Action = {
  name: "CALENDAR",
  description: "Calendar",
  tags: ["domain:calendar", "capability:write"],
  validate: async () => true,
  handler: async () => {
    throw Error("Egress must not execute a Calendar action");
  },
};
function context(agentId: string) {
  return {
    agentId,
    entityId: stringToUuid("owner"),
    id: stringToUuid("relative-create-message"),
  };
}

it("rejects the observed one-hour-late range but accepts the exact IANA range", () => {
  const { result } = evidence("agent");
  expect(
    calendarMutationTimeIsUngrounded({
      reply: wrong,
      actionResults: [result],
      agentId: "agent",
    }),
  ).toBe(true);
  expect(
    calendarMutationTimeIsUngrounded({
      reply: correct,
      actionResults: [result],
      agentId: "agent",
    }),
  ).toBe(false);
  expect(
    evaluatePlannedReplyEgress({
      reply: wrong,
      request,
      currentScope: context("agent"),
      actionResults: [result],
      actions: [calendar],
    }),
  ).toEqual({ verdict: "reject", kind: "calendar_time" });
});

it.each([
  [
    "2026-11-01T08:30:00.000Z",
    "2026-11-01T10:30:00.000Z",
    "America/Los_Angeles",
    "1:30–2:30 AM",
    "2:30–3:30 AM",
  ],
  [
    "2026-10-29T15:52:29.000Z",
    "2026-10-29T16:52:29.000Z",
    "Asia/Singapore",
    "11:52 PM–12:52 AM",
    "12:52–1:52 AM",
  ],
])("uses real zone transitions for %s", (start, end, zone, right, late) => {
  const { result } = evidence("agent", start, end, zone);
  expect(
    calendarMutationTimeIsUngrounded({
      reply: right,
      actionResults: [result],
      agentId: "agent",
    }),
  ).toBe(false);
  expect(
    calendarMutationTimeIsUngrounded({
      reply: late,
      actionResults: [result],
      agentId: "agent",
    }),
  ).toBe(true);
});

it("does not trust a foreign agent or mismatched event version, and leaves date-free/unrelated replies alone", () => {
  const { result } = evidence("agent");
  expect(
    calendarMutationTimeIsUngrounded({
      reply: wrong,
      actionResults: [result],
      agentId: "other",
    }),
  ).toBe(false);
  const changed = structuredClone(result);
  if (changed.data?.event && typeof changed.data.event === "object")
    Object.assign(changed.data.event, { metadata: { etag: "2" } });
  expect(
    calendarMutationTimeIsUngrounded({
      reply: wrong,
      actionResults: [changed],
      agentId: "agent",
    }),
  ).toBe(false);
  expect(
    calendarMutationTimeIsUngrounded({
      reply: "Your meeting is saved.",
      actionResults: [result],
      agentId: "agent",
    }),
  ).toBe(false);
  expect(
    evaluatePlannedReplyEgress({
      reply: "The train is at 5:52 PM.",
      request: "What time is the train?",
      actionResults: [],
      actions: [],
    }),
  ).toEqual({ verdict: "allow" });
});

it("leaves explicit alternative zones, title clocks and single-clock prose to normal review", () => {
  const { result } = evidence("agent");
  expect(
    calendarMutationTimeIsUngrounded({
      reply: "Created the event 11:52 PM–12:52 AM UTC.",
      actionResults: [result],
      agentId: "agent",
    }),
  ).toBe(false);
  expect(
    calendarMutationTimeIsUngrounded({
      reply: "Created the event 11:52 PM–12:52 AM Etc/UTC.",
      actionResults: [result],
      agentId: "agent",
    }),
  ).toBe(false);
  expect(
    calendarMutationTimeIsUngrounded({
      reply: "The event ends at 5:52 PM.",
      actionResults: [result],
      agentId: "agent",
    }),
  ).toBe(false);
  const titleClock = structuredClone(result);
  if (titleClock.data?.event && typeof titleClock.data.event === "object")
    Object.assign(titleClock.data.event, { title: "Review 5 PM" });
  expect(
    calendarMutationTimeIsUngrounded({
      reply: 'Created "Review 5 PM" for tomorrow.',
      actionResults: [titleClock],
      agentId: "agent",
    }),
  ).toBe(false);
});

function fixture(rewrite = correct) {
  const runtime = createSQLiteTestRuntime({
    character: { name: "Calendar QA", bio: "fixture" },
    logLevel: "fatal",
  });
  runtimes.push(runtime);
  runtime.registerAction(calendar);
  const { result, receipt } = evidence(runtime.agentId);
  let calls = 0;
  runtime.registerModel(
    ModelType.TEXT_SMALL,
    async (_runtime, params) => {
      calls++;
      return params.prompt.startsWith("Review recovered reply grounding.")
        ? JSON.stringify({
            grounded: true,
            claims: [
              {
                quote: rewrite,
                actor: "assistant",
                change: true,
                supported: true,
                evidence: receipt.receiptId,
              },
            ],
          })
        : JSON.stringify({
            response: rewrite,
            effectReceiptIds: [receipt.receiptId],
          });
    },
    "calendar-egress-fixture",
  );
  const message: Memory = {
    ...context(runtime.agentId),
    roomId: stringToUuid("calendar-room"),
    content: { text: request },
  };
  return {
    runtime,
    result,
    receipt,
    message,
    calls: () => calls,
    recover: (reply: string) =>
      resolvePlannedReplyEgress({
        runtime,
        message,
        reply,
        actionResults: [result],
      }),
  };
}

it("correct confirmed time passes whole egress without another model call", async () => {
  const f = fixture();
  const before = structuredClone(f.result);
  const out = await f.recover(correct);
  expect(out.text).toBe(correct);
  expect(f.calls()).toBe(0);
  expect(f.result).toEqual(before);
  expect(f.result.success).toBe(true);
});

it("wrong confirmed time uses existing recovery, keeps the successful receipt, and never replays the save", async () => {
  const f = fixture();
  const before = structuredClone(f.result);
  const out = await f.recover(wrong);
  expect(out.text).toBe(correct);
  expect(out.effectReceiptIds).toContain(f.receipt.receiptId);
  expect(f.calls()).toBe(2);
  expect(f.result).toEqual(before);
  expect(f.result.success).toBe(true);
});

it("a recovery that repeats the wrong clock cannot ship", async () => {
  const f = fixture(wrong);
  const before = structuredClone(f.result);
  await expect(f.recover(wrong)).rejects.toMatchObject({
    code: "REPLY_GROUNDING_FAILED",
  });
  expect(f.result).toEqual(before);
  expect(f.result.success).toBe(true);
});

it("keeps the current-time observation guard independent of Calendar event times", () => {
  const { result } = evidence("agent");
  const providers = {
    CURRENT_TIME: {
      text: "Current time",
      data: {
        humanReadable: "4:32 PM PDT",
        date: "2026-10-29",
        iso: "2026-10-29T23:32:29.000Z",
        timeZone: "America/Los_Angeles",
      },
    },
  };
  expect(
    evaluatePlannedReplyEgress({
      reply: "It's 4:32 PM.",
      request: "What time is it?",
      providers,
      currentScope: context("agent"),
      actionResults: [result],
      actions: [calendar],
    }),
  ).toEqual({ verdict: "allow" });
  expect(
    evaluatePlannedReplyEgress({
      reply: "It's 5:32 PM.",
      request: "What time is it?",
      providers,
      currentScope: context("agent"),
      actionResults: [result],
      actions: [calendar],
    }),
  ).toEqual({ verdict: "reject", kind: "stated_time" });
});

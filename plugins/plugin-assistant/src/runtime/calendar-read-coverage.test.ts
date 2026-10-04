/** Verifies operation substitution, source provenance and future-window proof through real evaluation. */
import type {
  ContextObject,
  EvaluatorOutput,
  PlannerTrajectory,
} from "@elizaos/core";
import type { CalendarReadBinding } from "@elizaos/core/contracts/calendar";
import { describe, expect, it } from "vitest";
import { calendarReadCoverage, runEvaluator } from "./evaluator.ts";

const requestedAt = Date.parse("2026-10-04T01:19:35Z");

function fixture() {
  const binding: CalendarReadBinding = {
    intentId: "intent:1",
    operation: "next_event",
    execution: "required",
    sourceMessageId: "request-now",
    roomId: "owner-room",
    actorId: "owner",
    requestedAt,
  };
  const context: ContextObject = {
    id: "request-now",
    metadata: {
      messageId: binding.sourceMessageId,
      roomId: binding.roomId,
      actorId: binding.actorId,
      calendarReadBindings: [binding],
    },
  };
  const trajectory: PlannerTrajectory = {
    context,
    outcomeIntents: ["Read the next calendar event"],
    steps: [
      {
        iteration: 1,
        toolCall: { id: "lookup-now", name: "CALENDAR_NEXT_EVENT", params: {} },
        result: {
          success: true,
          effectReceipts: [
            {
              receiptId: "next-current",
              operation: "calendar.event.next.read",
              resource: {
                kind: "calendar.next_event",
                id: "event-current",
                version: "current",
              },
              artifacts: [],
              idempotency: { key: "current-read", replayed: false },
              observedAt: "2026-10-04T01:19:36Z",
              outcome: "noop",
              reason: "Read only",
            },
          ],
          data: {
            replyContext: { domain: "calendar", scenario: "next_event" },
            timeReference: { asOf: "2026-10-04T01:19:36Z", timeZone: "UTC" },
            readScope: {
              selection: "next_event",
              timeMin: "2026-10-04T00:00:00Z",
              timeMax: "2026-11-04T00:00:00Z",
              exhaustive: false,
            },
            calendarFeedState: "complete",
            calendarSources: [
              { summary: "Selected Calendar", status: "fresh" },
            ],
            event: {
              id: "earliest",
              startAt: "2026-10-05T10:00:00Z",
              endAt: "2026-10-05T11:00:00Z",
            },
          },
        },
      },
    ],
    evaluatorOutputs: [],
    plannedQueue: [],
  };
  const output: EvaluatorOutput = {
    success: true,
    decision: "FINISH",
    thought: "The selected source returned its next event.",
    requestFullyCovered: true,
    outcomeCoverage: [
      {
        intentId: "intent:1",
        status: "completed",
        evidenceStepIds: ["step:1"],
      },
    ],
    messageToUser: "No upcoming events on any calendar.",
  };
  return { context, trajectory, output };
}

describe("request-bound Calendar read coverage", () => {
  it("preserves the existing false-condition verdict from a current successful Notes read", async () => {
    const f = fixture();
    const bindings = f.context.metadata
      ?.calendarReadBindings as CalendarReadBinding[];
    bindings[0].execution = "conditional";
    f.trajectory.outcomeIntents = [
      "If I have a note, read my next Calendar event",
    ];
    f.trajectory.steps[0].toolCall.name = "NOTES_LIST";
    f.trajectory.steps[0].result.data = {
      count: 0,
      total: 0,
      readOnlyOperation: true,
    };
    f.trajectory.steps[0].result.effectReceipts = [];
    f.output.messageToUser = "No note exists, so I skipped the Calendar read.";
    let calls = 0;
    const result = await runEvaluator({
      runtime: {
        useModel: async () => {
          calls++;
          return JSON.stringify(f.output);
        },
      },
      context: f.context,
      trajectory: f.trajectory,
    });
    expect(result.success).toBe(true);
    expect(result.requestFullyCovered).toBe(true);
    expect(result.messageToUser).toBe(f.output.messageToUser);
    expect(calls).toBe(1);
  });
  it("accepts the fresh next-event producer and its exclusive-window receipt", () => {
    const f = fixture();
    expect(
      calendarReadCoverage(f.output, f.context, f.trajectory).verified,
    ).toBe(true);
  });
  it("accepts the canonical dispatcher only for its explicit next_event discriminator", () => {
    const f = fixture();
    f.trajectory.steps[0].toolCall = {
      id: "next-parent",
      name: "CALENDAR",
      params: { action: "next_event" },
    };
    expect(
      calendarReadCoverage(f.output, f.context, f.trajectory).verified,
    ).toBe(true);
    f.trajectory.steps[0].toolCall.params = { action: "feed" };
    expect(
      calendarReadCoverage(f.output, f.context, f.trajectory).verified,
    ).toBe(false);
  });
  it.each(["sourceMessageId", "roomId", "actorId"])(
    "rejects a binding copied from another %s",
    (key) => {
      const f = fixture();
      const bindings = f.context.metadata
        ?.calendarReadBindings as CalendarReadBinding[];
      bindings[0][key as "sourceMessageId" | "roomId" | "actorId"] =
        "other-scope";
      expect(
        calendarReadCoverage(f.output, f.context, f.trajectory).verified,
      ).toBe(false);
    },
  );
  it("rejects a prior same-day snapshot, missing producer receipt and elapsed event", () => {
    for (const mutate of [
      (data: Record<string, unknown>) => {
        data.timeReference = { asOf: "2026-10-03T23:58:33Z" };
      },
      (data: Record<string, unknown>) => {
        data.event = {
          startAt: "2026-10-03T10:00:00Z",
          endAt: "2026-10-03T11:00:00Z",
        };
      },
      (data: Record<string, unknown>) => {
        data.readScope = {
          selection: "next_event",
          timeMin: "2026-10-04T00:00:00Z",
          timeMax: "2026-10-04T01:19:36Z",
          exhaustive: false,
        };
      },
      (data: Record<string, unknown>) => {
        data.calendarFeedState = "partial";
      },
    ]) {
      const f = fixture();
      mutate(f.trajectory.steps[0].result.data as Record<string, unknown>);
      expect(
        calendarReadCoverage(f.output, f.context, f.trajectory).verified,
      ).toBe(false);
    }
    const f = fixture();
    f.trajectory.steps[0].result.effectReceipts = [];
    expect(
      calendarReadCoverage(f.output, f.context, f.trajectory).verified,
    ).toBe(false);
  });
  it("rejects a feed substituted for next_event even with a copied next-event receipt", () => {
    const f = fixture();
    f.trajectory.steps[0].toolCall.name = "CALENDAR_FEED";
    expect(
      calendarReadCoverage(f.output, f.context, f.trajectory).verified,
    ).toBe(false);
  });
  it("only accepts a cited current next-event step, not an unrelated success", () => {
    const f = fixture();
    f.trajectory.steps.push(structuredClone(f.trajectory.steps[0]));
    f.trajectory.steps[0].toolCall.name = "NOTES_LIST";
    expect(
      calendarReadCoverage(f.output, f.context, f.trajectory).verified,
    ).toBe(false);
    const coverage = f.output.outcomeCoverage?.[0];
    if (!coverage) throw new Error("Missing coverage fixture");
    coverage.evidenceStepIds = ["step:2"];
    expect(
      calendarReadCoverage(f.output, f.context, f.trajectory).verified,
    ).toBe(true);
  });
  it.each(["bounded agenda", "non-exhaustive next-event absence"])(
    "keeps %s honest and terminal without another model call",
    async (kind) => {
      const f = fixture();
      if (kind === "bounded agenda") {
        f.trajectory.steps[0].toolCall.name = "CALENDAR_FEED";
        f.trajectory.steps[0].result.data = {
          replyContext: {
            domain: "calendar",
            scenario: "feed_results",
            context: {
              selection: "bounded_agenda",
              nextEventLookupPerformed: false,
            },
          },
        };
      } else {
        const data = f.trajectory.steps[0].result.data;
        if (!data) throw new Error("Missing result fixture");
        data.event = null;
      }
      let calls = 0;
      const result = await runEvaluator({
        runtime: {
          useModel: async () => {
            calls++;
            return JSON.stringify(f.output);
          },
        },
        context: f.context,
        trajectory: f.trajectory,
      });
      expect(result.success).toBe(false);
      expect(result.requestFullyCovered).toBe(false);
      expect(result.decision).toBe("FINISH");
      expect(result.messageToUser).not.toContain(
        "No upcoming events on any calendar.",
      );
      expect(result.messageToUser).toContain("couldn't confirm");
      expect(calls).toBe(1);
    },
  );
  it("leaves unrelated legacy requests without bindings unchanged", () => {
    const f = fixture();
    if (!f.context.metadata) throw new Error("Missing metadata fixture");
    delete f.context.metadata.calendarReadBindings;
    f.trajectory.steps[0].toolCall.name = "NOTES_LIST";
    expect(
      calendarReadCoverage(f.output, f.context, f.trajectory).verified,
    ).toBe(true);
  });
  it("replaces unsupported prose with cited current Notes/navigation and bounded Calendar facts", async () => {
    const f = fixture();
    const bindings = f.context.metadata
      ?.calendarReadBindings as CalendarReadBinding[];
    bindings[0].intentId = "intent:3";
    f.trajectory.outcomeIntents = [
      "Open Notes",
      "Read latest note",
      "Read next Calendar event",
    ];
    f.trajectory.steps = [
      {
        iteration: 1,
        toolCall: { id: "open", name: "VIEWS_SHOW", params: {} },
        result: {
          success: true,
          data: { navigation: { status: "delivered", label: "Notes" } },
        },
      },
      {
        iteration: 1,
        toolCall: { id: "notes", name: "NOTES_LIST", params: {} },
        result: {
          success: true,
          data: { total: 0, filterApplied: false, lookupMode: "all" },
        },
      },
      {
        iteration: 1,
        toolCall: { id: "feed", name: "CALENDAR_FEED", params: {} },
        result: {
          success: true,
          data: {
            replyContext: {
              domain: "calendar",
              scenario: "feed_results",
              facts: "No events from October 3 through October 10, inclusive.",
              context: {
                asOf: "2026-10-04T01:19:36Z",
                selection: "bounded_agenda",
              },
            },
          },
        },
      },
      {
        iteration: 1,
        toolCall: { id: "unrelated", name: "WRITE", params: {} },
        result: {
          success: true,
          verifiedUserFacing: true,
          userFacingText: "An unrelated mutation completed.",
        },
      },
    ];
    f.output.outcomeCoverage = [1, 2, 3].map((i) => ({
      intentId: `intent:${i}`,
      status: "completed",
      evidenceStepIds: [`step:${i}`],
    }));
    const result = await runEvaluator({
      runtime: { useModel: async () => JSON.stringify(f.output) },
      context: f.context,
      trajectory: f.trajectory,
    });
    expect(result.messageToUser).toContain("Notes view is open.");
    expect(result.messageToUser).toContain("No notes exist in Notes.");
    expect(result.messageToUser).toContain("October 3 through October 10");
    expect(result.messageToUser).not.toContain(
      "No upcoming events on any calendar.",
    );
    expect(result.messageToUser).not.toContain("unrelated mutation");
    expect(result.outcomeCoverage?.[2].status).toBe("blocked");
    expect(result.outcomeCoverage?.[0].status).toBe("completed");
    // Even a successful cited read cannot turn a prior snapshot into fresh facts.
    const data = f.trajectory.steps[2].result.data as Record<string, unknown>;
    data.replyContext = {
      domain: "calendar",
      scenario: "feed_results",
      facts: "STALE SAME-DAY FACT",
      context: { asOf: "2026-10-03T23:58:33Z", selection: "bounded_agenda" },
    };
    const stale = await runEvaluator({
      runtime: { useModel: async () => JSON.stringify(f.output) },
      context: f.context,
      trajectory: f.trajectory,
    });
    expect(stale.messageToUser).not.toContain("STALE SAME-DAY FACT");
    expect(stale.messageToUser).toContain("Notes view is open.");
  });
});

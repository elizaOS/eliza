/** Verifies operation substitution, source provenance and future-window proof through real evaluation. */

import type {
  CalendarReadBinding,
  LifeOpsCalendarFeed,
} from "@elizaos/contracts";
import {
  AgentRuntime,
  type ContextObject,
  type EvaluatorOutput,
  type PlannerTrajectory,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { createCalendarActionRunner } from "../../../plugin-calendar/src/actions/calendar-handler.ts";
import { CalendarService } from "../../../plugin-calendar/src/service/CalendarService.ts";
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
  it("uses the real empty NEXT producer's human channel without exposing its model instructions", async () => {
    const f = fixture();
    const runtime = new AgentRuntime({
      character: { name: "Real bounded NEXT", bio: [] },
      logLevel: "fatal",
    });
    const service = new CalendarService(runtime);
    const now = new Date("2026-10-04T01:19:36Z");
    const feed: LifeOpsCalendarFeed = {
      calendarId: "primary",
      events: [],
      source: "synced",
      state: "complete",
      sources: [
        {
          key: "private-source-key",
          summary: "Eliza Calendar",
          accessRole: "owner",
          visibility: "details",
          status: "fresh",
          syncedAt: now.toISOString(),
          error: null,
        },
      ],
      timeMin: "2026-10-03T07:00:00Z",
      timeMax: "2026-11-02T08:00:00Z",
      syncedAt: now.toISOString(),
    };
    vi.spyOn(service, "getCalendarFeed").mockResolvedValue(feed);
    const context = await service.getNextCalendarEventContext(
      new URL("http://localhost/"),
      { timeZone: "America/Los_Angeles" },
      now,
    );
    vi.spyOn(service, "getNextCalendarEventContext").mockResolvedValue(context);
    runtime.services.set(CalendarService.serviceType, [service]);
    const noModel = async () => {
      throw new Error("Unexpected producer model call");
    };
    const action = createCalendarActionRunner({
      runTextModel: noModel,
      runJsonModel: noModel,
      recentConversationTexts: async () => [],
    });
    const outcome = await action.handler(
      runtime,
      {
        id: "00000000-0000-0000-0000-000000000091",
        entityId: "00000000-0000-0000-0000-000000000092",
        roomId: "00000000-0000-0000-0000-000000000093",
        agentId: runtime.agentId,
        createdAt: requestedAt,
        content: { text: "Read my next Calendar event" },
      },
      undefined,
      {
        parameters: {
          subaction: "next_event",
          details: { timeZone: "America/Los_Angeles" },
        },
      },
    );
    if (!outcome || typeof outcome !== "object")
      throw new Error("Missing real producer result");
    const reply = outcome.data?.replyContext as Record<string, unknown>;
    expect(reply.facts).toContain("Report absence only");
    expect(reply.userFacingFacts).toBe(
      "No upcoming event was found in Eliza Calendar from Oct 3, 2026 to before Nov 2, 2026.",
    );
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
        toolCall: { id: "view", name: "VIEWS_SHOW", params: {} },
        result: {
          success: true,
          data: { navigation: { status: "delivered", label: "Notes" } },
        },
      },
      {
        iteration: 1,
        toolCall: { id: "next", name: "CALENDAR_NEXT_EVENT", params: {} },
        result: outcome,
      },
    ];
    f.output.outcomeCoverage = [1, 2, 3].map((i) => ({
      intentId: `intent:${i}`,
      status: "completed",
      evidenceStepIds: [`step:${i === 3 ? 2 : 1}`],
    }));
    f.output.messageToUser = `Opened Notes. Your latest (and only) note is titled "QA regression 1005-202247" and the body says: "The verification word is cobalt."\n\n${reply.userFacingFacts}`;
    const result = await runEvaluator({
      runtime: { useModel: async () => JSON.stringify(f.output) },
      context: f.context,
      trajectory: f.trajectory,
    });
    expect(result.success).toBe(true);
    expect(result.decision).toBe("FINISH");
    expect(result.messageToUser).toBe(f.output.messageToUser);
    expect(result.messageToUser).toContain(String(reply.userFacingFacts));
    for (const forbidden of [
      "Report absence",
      "do not generalize",
      "non-exhaustive",
      "private-source-key",
      "2026-10-03T07:00:00Z",
      "No upcoming events on any calendar",
    ])
      expect(result.messageToUser).not.toContain(forbidden);
  });
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
  it("still tells the owner the next event it found when one source is not fresh", async () => {
    const f = fixture();
    const data = f.trajectory.steps[0].result.data as Record<string, unknown>;
    data.calendarFeedState = "partial";
    data.calendarSources = [
      { summary: "Work", status: "fresh" },
      { summary: "Family", status: "stale" },
    ];
    data.replyContext = {
      domain: "calendar",
      scenario: "next_event",
      userFacingFacts:
        "Your next event is Design review on October 5 at 10:00.",
    };
    const result = await runEvaluator({
      runtime: { useModel: async () => JSON.stringify(f.output) },
      context: f.context,
      trajectory: f.trajectory,
    });
    // Unverified (a source is not fresh), but the found event is not hidden.
    expect(result.success).toBe(false);
    expect(result.messageToUser).toContain(
      "Your next event is Design review on October 5 at 10:00.",
    );
    expect(result.messageToUser).toContain("Family");
    expect(result.messageToUser).toContain("couldn't confirm");
    expect(result.messageToUser).not.toContain(
      "No upcoming events on any calendar.",
    );
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
  it("preserves the captured scoped empty-result reply and its unrelated note content", async () => {
    const f = fixture();
    const data = f.trajectory.steps[0].result.data;
    if (!data) throw new Error("Missing result fixture");
    data.event = null;
    data.timeReference = {
      asOf: "2026-10-06T02:49:45Z",
      timeZone: "America/Los_Angeles",
    };
    data.readScope = {
      selection: "next_event",
      timeMin: "2026-10-05T07:00:00Z",
      timeMax: "2026-11-04T08:00:00Z",
      exhaustive: false,
    };
    data.calendarSources = [{ summary: "Eliza Calendar", status: "fresh" }];
    f.output.messageToUser =
      'Opened Notes. Your latest (and only) note is titled "QA regression 1005-202247" and the body says: "The verification word is cobalt."\n\nNext calendar event: none found in Eliza Calendar over the next ~30 days (checked through Nov 3).';
    const result = await runEvaluator({
      runtime: { useModel: async () => JSON.stringify(f.output) },
      context: f.context,
      trajectory: f.trajectory,
    });
    expect(result.success).toBe(true);
    expect(result.requestFullyCovered).toBe(true);
    expect(result.decision).toBe("FINISH");
    expect(result.messageToUser).toBe(f.output.messageToUser);
  });

  it.each(["stale", "missing-receipt", "invalid-window", "missing-coverage"])(
    "rejects an empty next-event result with %s evidence",
    (kind) => {
      const f = fixture();
      const result = f.trajectory.steps[0].result;
      const data = result.data as Record<string, unknown>;
      data.event = null;
      if (kind === "stale")
        data.calendarSources = [{ summary: "Calendar", status: "stale" }];
      if (kind === "missing-receipt") result.effectReceipts = [];
      if (kind === "invalid-window")
        data.readScope = {
          selection: "next_event",
          timeMin: "bad",
          timeMax: "bad",
          exhaustive: false,
        };
      if (kind === "missing-coverage")
        data.readScope = {
          selection: "next_event",
          timeMin: "2026-10-04T00:00:00Z",
          timeMax: "2026-11-04T00:00:00Z",
        };
      expect(
        calendarReadCoverage(f.output, f.context, f.trajectory).verified,
      ).toBe(false);
    },
  );

  it("rejects a bounded agenda substituted for a next-event read without another model call", async () => {
    const f = fixture();
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
  });
  it("leaves unrelated legacy requests without bindings unchanged", () => {
    const f = fixture();
    if (!f.context.metadata) throw new Error("Missing metadata fixture");
    delete f.context.metadata.calendarReadBindings;
    f.trajectory.steps[0].toolCall.name = "NOTES_LIST";
    expect(
      calendarReadCoverage(f.output, f.context, f.trajectory).verified,
    ).toBe(true);
  });
  it.each([
    ["One line", ""],
    ["Heading", "\nBody"],
    ["  Heading ", "\n\nBody  \n"],
  ])(
    "preserves exact Notes content when Calendar remains unverified: %j",
    async (title, body) => {
      const f = fixture();
      f.trajectory.outcomeIntents = [
        ...(f.trajectory.outcomeIntents ?? []),
        "Read the saved note",
      ];
      f.trajectory.steps[0].toolCall.name = "CALENDAR_FEED";
      f.trajectory.steps[0].result.data = {
        replyContext: {
          domain: "calendar",
          scenario: "feed_results",
          userFacingFacts: "Only the checked Calendar window was read.",
          context: {
            asOf: "2026-10-04T01:19:36Z",
            selection: "bounded_agenda",
          },
        },
      };
      f.trajectory.steps.push({
        iteration: 1,
        toolCall: { id: "note", name: "NOTES_GET", params: {} },
        result: { success: true, data: { note: { title, body } } },
      });
      f.output.outcomeCoverage?.push({
        intentId: "intent:2",
        status: "completed",
        evidenceStepIds: ["step:2"],
      });
      const model = vi.fn(async () => JSON.stringify(f.output));
      const result = await runEvaluator({
        runtime: { useModel: model },
        context: f.context,
        trajectory: f.trajectory,
      });
      expect(result.success).toBe(false);
      expect(result.requestFullyCovered).toBe(false);
      expect(result.messageToUser).toBe(
        `Only the checked Calendar window was read. ${title}${body} I couldn't confirm that Calendar request. Those Calendar results cover only the connected sources and dates checked.`,
      );
      expect(result.outcomeCoverage?.[0].status).toBe("blocked");
      expect(result.outcomeCoverage?.[1].status).toBe("completed");
      expect(model).toHaveBeenCalledTimes(1);
    },
  );
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
              facts: "INTERNAL MODEL GUIDANCE",
              userFacingFacts:
                "No events from October 3 through October 10, inclusive.",
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
      userFacingFacts: "STALE SAME-DAY FACT",
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

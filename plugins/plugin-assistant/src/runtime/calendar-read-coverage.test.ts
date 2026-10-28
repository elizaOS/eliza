/** Verifies operation substitution, source provenance and future-window proof through real evaluation. */

import type {
  CalendarReadBinding,
  LifeOpsCalendarFeed,
} from "@elizaos/contracts";
import {
  AgentRuntime,
  type ContextObject,
  type EvaluatorOutput,
  executePlannedToolCall,
  type Memory,
  type PlannerTrajectory,
  promoteSubactionsToActions,
} from "@elizaos/core";
import * as collaborator from "@elizaos/plugin-assistant";
import { describe, expect, it, vi } from "vitest";
import { createCalendarActionRunner } from "../../../plugin-calendar/src/actions/calendar-handler.ts";
import { CalendarService } from "../../../plugin-calendar/src/service/CalendarService.ts";
import {
  calendarAction,
  calendarActionPromotionOptions,
} from "../../../plugin-personal-assistant/src/actions/calendar.ts";
import { computeProposedSlots } from "../../../plugin-personal-assistant/src/actions/lib/scheduling-handler.ts";
import { LifeOpsService } from "../../../plugin-personal-assistant/src/lifeops/service.ts";
import { renderGroundedActionReply } from "../actions/grounded-action-reply.ts";

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
      "No upcoming event was found in Eliza Calendar from Saturday, Oct 3, 2026 to before Monday, Nov 2, 2026. This read covers only those sources and dates; it does not establish that the whole calendar is clear.",
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

describe("Calendar proposal and availability outcome evidence", () => {
  function proposalFixture() {
    const f = fixture();
    const bindings = f.context.metadata
      ?.calendarReadBindings as CalendarReadBinding[];
    bindings[0].operation = "propose_times";
    f.trajectory.outcomeIntents = [
      "Find one free 30-minute slot tomorrow afternoon",
    ];
    f.output.messageToUser = "12:00 to 12:30 is available.";
    f.trajectory.steps[0] = {
      iteration: 1,
      toolCall: {
        id: "proposal-now",
        name: "CALENDAR_PROPOSE_TIMES",
        params: {
          duration: { minutes: 30 },
          windowStart: "2026-10-05T12:00:00Z",
          windowEnd: "2026-10-05T17:00:00Z",
          timeZone: "UTC",
        },
      },
      result: {
        success: true,
        effectReceipts: [
          {
            receiptId: "proposal-current",
            operation: "calendar.propose_times.preview",
            resource: {
              kind: "calendar.feed",
              id: "selected-calendar",
              version: "snapshot-current",
            },
            artifacts: [],
            idempotency: { key: null, replayed: false },
            observedAt: "2026-10-04T01:19:36Z",
            outcome: "preview",
          },
        ],
        data: {
          replyContext: {
            domain: "lifeops",
            scenario: "scheduling_proposed_slots",
          },
          calendarSnapshot: {
            resource: {
              kind: "calendar.feed",
              id: "selected-calendar",
              version: "snapshot-current",
            },
            artifacts: [],
            observedAt: "2026-10-04T01:19:36Z",
          },
          durationMinutes: 30,
          windowStart: "2026-10-05T12:00:00Z",
          windowEnd: "2026-10-05T17:00:00Z",
          timeZone: "UTC",
          slots: computeProposedSlots({
            now: new Date("2026-10-04T01:19:36Z"),
            windowStart: new Date("2026-10-05T12:00:00Z"),
            windowEnd: new Date("2026-10-05T17:00:00Z"),
            durationMinutes: 30,
            slotCount: 1,
            preferences: {
              timeZone: "UTC",
              preferredStartLocal: "09:00",
              preferredEndLocal: "17:00",
              defaultDurationMinutes: 30,
              travelBufferMinutes: 0,
              blackoutWindows: [],
              updatedAt: null,
            },
            events: [],
          }),
        },
      },
    };
    const step = f.trajectory.steps[0];
    const result = step.result;
    const data = result?.data;
    const receipt = result?.effectReceipts?.[0];
    const call = step.toolCall;
    const binding = bindings[0];
    if (!result || !data || !receipt || !call || !binding)
      throw new Error("Incomplete scheduling evidence fixture");
    return { ...f, step, result, data, receipt, call, binding };
  }
  it("accepts a source-bound exact-duration slot preview without booking", () => {
    const f = proposalFixture();
    expect(
      calendarReadCoverage(f.output, f.context, f.trajectory).verified,
    ).toBe(true);
  });
  it("does not let agenda evidence finish a slot-proposal request", async () => {
    const f = proposalFixture();
    f.call.name = "CALENDAR_FEED";
    f.result.data = {
      replyContext: {
        domain: "calendar",
        scenario: "feed_results",
        context: { selection: "bounded_agenda" },
      },
    };
    const model = vi.fn(async () => JSON.stringify(f.output));
    const result = await runEvaluator({
      runtime: { useModel: model },
      context: f.context,
      trajectory: f.trajectory,
    });
    expect(result.success).toBe(false);
    expect(result.requestFullyCovered).toBe(false);
    expect(result.outcomeCoverage?.[0].status).toBe("blocked");
    expect(model).toHaveBeenCalledTimes(1);
  });
  it.each([
    "missing-slots",
    "wide-slot",
    "outside-window",
    "wrong-source",
    "applied-write",
  ])("rejects %s as exact-slot preview evidence", (fault) => {
    const f = proposalFixture();
    const data = f.data;
    if (fault === "missing-slots") delete data.slots;
    if (fault === "wide-slot")
      data.slots = [
        {
          startAt: "2026-10-05T12:00:00Z",
          endAt: "2026-10-05T14:30:00Z",
          durationMinutes: 30,
          timeZone: "UTC",
        },
      ];
    if (fault === "outside-window")
      data.slots = [
        {
          startAt: "2026-10-05T18:00:00Z",
          endAt: "2026-10-05T18:30:00Z",
          durationMinutes: 30,
          timeZone: "UTC",
        },
      ];
    if (fault === "wrong-source") f.receipt.resource.id = "other-calendar";
    if (fault === "applied-write")
      f.result.effectReceipts = [
        {
          ...f.receipt,
          outcome: "applied",
          commit: {
            kind: "durable",
            id: "unrequested-write",
            committedAt: "2026-10-04T01:19:36Z",
          },
        },
      ];
    expect(
      calendarReadCoverage(f.output, f.context, f.trajectory).verified,
    ).toBe(false);
  });
  it("preserves a complete bounded search that truthfully finds no slots", () => {
    const f = proposalFixture();
    f.data.slots = [];
    f.output.messageToUser = "No slots fit the requested window.";
    expect(
      calendarReadCoverage(f.output, f.context, f.trajectory).verified,
    ).toBe(true);
  });
  it.each([true, false])(
    "accepts canonical interval availability isFree=%s without a mutation",
    (isFree) => {
      const f = proposalFixture();
      f.binding.operation = "check_availability";
      f.call.name = "CALENDAR_CHECK_AVAILABILITY";
      f.call.params = {
        interval: { startAt: "2026-10-05T12:00:00Z", durationMinutes: 30 },
        timeZone: "UTC",
      };
      f.result.effectReceipts = [
        {
          ...f.receipt,
          operation: "calendar.check_availability.read",
          outcome: "noop",
          reason: "Observed availability only",
        },
      ];
      f.result.data = {
        ...f.data,
        windowEnd: "2026-10-05T12:30:00Z",
        replyContext: {
          domain: "lifeops",
          scenario: isFree
            ? "scheduling_window_free"
            : "scheduling_window_busy",
        },
        isFree,
        conflicts: isFree ? [] : [{ id: "conflict" }],
      };
      expect(
        calendarReadCoverage(f.output, f.context, f.trajectory).verified,
      ).toBe(true);
    },
  );
});

describe("registered scheduling handler to completion coverage", () => {
  it.each(["propose_times", "check_availability"] as const)(
    "accepts actual %s result/receipt without calendar writes or reply model",
    async (operation) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-04T01:19:36Z"));
      const runtime = new AgentRuntime({
        character: {
          name: "Actual scheduling producer",
          bio: [],
          settings: { TIMEZONE: "UTC" },
        },
        logLevel: "fatal",
      });
      const noModel = vi
        .spyOn(runtime, "useModel")
        .mockRejectedValue(new Error("No model may run in handler proof"));
      const tasks = vi.spyOn(runtime, "getTasks").mockResolvedValue([]);
      const feed: LifeOpsCalendarFeed = {
        calendarId: "selected-calendar",
        events: [],
        source: "synced",
        state: "complete",
        syncedAt: "2026-10-04T01:19:36Z",
        timeMin: "2026-10-05T12:00:00Z",
        timeMax: "2026-10-05T17:00:00Z",
        sources: [
          {
            key: "selected-source",
            summary: "Selected Calendar",
            accessRole: "owner",
            visibility: "details",
            status: "fresh",
            syncedAt: "2026-10-04T01:19:36Z",
            error: null,
          },
        ],
      };
      const read = vi
        .spyOn(LifeOpsService.prototype, "getCalendarFeed")
        .mockResolvedValue(feed);
      const create = vi.spyOn(LifeOpsService.prototype, "createCalendarEvent");
      const update = vi.spyOn(LifeOpsService.prototype, "updateCalendarEvent");
      const remove = vi.spyOn(LifeOpsService.prototype, "deleteCalendarEvent");
      vi.spyOn(collaborator, "renderGroundedActionReply").mockImplementation(
        renderGroundedActionReply,
      );
      try {
        const actions = promoteSubactionsToActions(
          calendarAction,
          calendarActionPromotionOptions,
        );
        for (const action of actions) runtime.registerAction(action);
        const name =
          operation === "propose_times"
            ? "CALENDAR_PROPOSE_TIMES"
            : "CALENDAR_CHECK_AVAILABILITY";
        const params =
          operation === "propose_times"
            ? {
                duration: { minutes: 30 },
                slotCount: 1,
                windowStart: "2026-10-05T12:00:00",
                windowEnd: "2026-10-05T17:00:00",
                timeZone: "UTC",
              }
            : {
                interval: {
                  startAt: "2026-10-05T12:00:00Z",
                  durationMinutes: 30,
                },
                timeZone: "UTC",
              };
        const message = {
          id: "00000000-0000-0000-0000-000000000101",
          agentId: runtime.agentId,
          entityId: runtime.agentId,
          roomId: "00000000-0000-0000-0000-000000000102",
          createdAt: requestedAt,
          content: {
            text:
              operation === "propose_times"
                ? "Find one 30-minute opening tomorrow afternoon in UTC."
                : "Check availability tomorrow from noon to 12:30 UTC.",
            source: "test",
          },
        } as Memory;
        const result = await executePlannedToolCall(
          runtime,
          {
            message,
            state: { values: {}, data: {}, text: "" },
            replyOwner: "planner",
            userRoles: ["OWNER"],
            activeContexts: ["calendar"],
          },
          { name, params },
          { actions: runtime.actions },
        );
        expect(result.success).toBe(true);
        expect(result.transcriptVisibility).toBe("internal");
        expect(result.data?.replyGrounding).toEqual(expect.any(String));
        expect(result.effectReceipts).toHaveLength(1);
        expect(result.effectReceipts?.[0]).toMatchObject({
          operation:
            operation === "propose_times"
              ? "calendar.propose_times.preview"
              : "calendar.check_availability.read",
          outcome: operation === "propose_times" ? "preview" : "noop",
          resource: { kind: "calendar.feed", id: feed.calendarId },
        });
        expect(result.data?.calendarSnapshot).toMatchObject({
          resource: { kind: "calendar.feed", id: feed.calendarId },
        });
        if (operation === "propose_times") {
          expect(result.data?.awaitingUserInput).toBe(true);
          expect(result.data?.slots).toHaveLength(1);
          expect(result.data?.durationMinutes).toBe(30);
        }
        const f = fixture();
        const bindings = f.context.metadata
          ?.calendarReadBindings as CalendarReadBinding[];
        bindings[0] = {
          ...bindings[0],
          operation,
          sourceMessageId: message.id,
          roomId: message.roomId,
          actorId: message.entityId,
          requestedAt,
        };
        f.context.metadata = {
          ...f.context.metadata,
          messageId: message.id,
          roomId: message.roomId,
          actorId: message.entityId,
        };
        f.trajectory.outcomeIntents = [message.content.text ?? ""];
        f.trajectory.steps = [
          {
            iteration: 1,
            toolCall: { id: "actual-scheduling", name, params },
            result,
          },
        ];
        expect(
          calendarReadCoverage(f.output, f.context, f.trajectory).verified,
        ).toBe(true);
        expect(read).toHaveBeenCalledOnce();
        expect(tasks).toHaveBeenCalled();
        expect(noModel).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
        expect(remove).not.toHaveBeenCalled();
      } finally {
        vi.restoreAllMocks();
        vi.useRealTimers();
      }
    },
  );
});

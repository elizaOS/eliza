/** Verifies operation substitution, source provenance and future-window proof through real evaluation. */

import type {
  CalendarReadBinding,
  LifeOpsCalendarEvent,
  LifeOpsCalendarFeed,
} from "@elizaos/contracts";
import {
  AgentRuntime,
  type ContextObject,
  type EvaluatorOutput,
  executePlannedToolCall,
  type JSONSchema,
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

import {
  calendarReadCoverage,
  parseEvaluatorOutput,
  runEvaluator,
} from "./evaluator.ts";

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
    // The copy after a shown event never says the event was not read.
    expect(result.messageToUser).toContain(
      "Not up to date: Family. I couldn't confirm your next event.",
    );
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
    expect(result.messageToUser).toBe(
      "I couldn't check your next calendar event just now.",
    );
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
        `Only the checked Calendar window was read. ${title}${body} I couldn't confirm your next event. Those Calendar results cover only the connected sources and dates checked.`,
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

/** tj-6eb9a245fd912d: "move the coffee with Sam to 2pm", search then a committed update. */
function liveMoveFixture() {
  const f = fixture();
  const bindings = f.context.metadata
    ?.calendarReadBindings as CalendarReadBinding[];
  bindings[0].operation = "search_events";
  const id = "agent:eliza:owner:grant:eliza-calendar:calendar:primary:event-1";
  const before = {
    id,
    provider: "eliza",
    grantId: "eliza-calendar",
    calendarId: "primary",
    title: "coffee with Sam",
    startAt: "2026-10-31T17:00:00.000Z",
    endAt: "2026-10-31T18:00:00.000Z",
    metadata: { etag: '"eliza-1"' },
  };
  const after = {
    ...before,
    startAt: "2026-10-31T21:00:00.000Z",
    endAt: "2026-10-31T22:00:00.000Z",
    metadata: { etag: '"eliza-2"' },
  };
  const committedAt = "2026-10-30T10:50:33.794Z";
  f.trajectory.outcomeIntents = [
    "find the coffee-with-Sam event",
    "reschedule it to 2pm",
  ];
  f.trajectory.steps = [
    {
      iteration: 1,
      toolCall: { id: "search", name: "CALENDAR_SEARCH_EVENTS", params: {} },
      result: {
        success: true,
        data: {
          events: [before],
          replyContext: { domain: "calendar", scenario: "search_results" },
        },
      },
    },
    {
      iteration: 2,
      toolCall: { id: "discover", name: "DISCOVER_ACTIONS", params: {} },
      result: {
        success: true,
        data: { loadedTools: ["CALENDAR_UPDATE_EVENT"] },
      },
    },
    {
      iteration: 3,
      toolCall: { id: "move", name: "CALENDAR_UPDATE_EVENT", params: {} },
      result: {
        success: true,
        transcriptVisibility: "internal",
        modelReplyRequired: true,
        effectReceipts: [
          {
            receiptId: "calendar-event-mutation-receipt-v1:move",
            operation: "calendar.event.update",
            resource: { kind: "calendar.event", id, version: '"eliza-2"' },
            artifacts: [],
            idempotency: { key: "move-key", replayed: false },
            observedAt: committedAt,
            outcome: "applied",
            commit: { kind: "durable", id, committedAt },
          },
        ],
        data: { event: after, targetEvent: before },
      },
    },
  ];
  // The live model's verdict, with the intent text it cited as intent IDs.
  const live: EvaluatorOutput = {
    thought: "Locate and time change succeeded.",
    success: true,
    decision: "FINISH",
    requestFullyCovered: true,
    outcomeCoverage: [
      {
        intentId: "find the coffee-with-Sam event",
        status: "completed",
        evidenceStepIds: ["step:1"],
      },
      {
        intentId: "reschedule it to 2pm",
        status: "completed",
        evidenceStepIds: ["step:3"],
      },
    ],
    messageToUser: 'Moved "coffee with Sam" to 2pm on Saturday, Oct 31 PDT.',
    replyEffectStatus: "applied",
    effectReceiptIds: ["calendar-event-mutation-receipt-v1:move"],
  };
  return { ...f, live };
}

describe("committed Calendar mutations behind a read binding", () => {
  it("restricts coverage to the turn's intent IDs so a committed move keeps its reply", async () => {
    const f = liveMoveFixture();
    let intentIds: unknown;
    // Strict structured decoding can emit only values the schema allows.
    const useModel = vi.fn(
      async (_type: unknown, request: { responseSchema: JSONSchema }) => {
        const coverage = request.responseSchema.properties?.outcomeCoverage;
        const item = Array.isArray(coverage?.items)
          ? undefined
          : coverage?.items;
        intentIds = item?.properties?.intentId?.enum;
        return JSON.stringify({
          ...f.live,
          outcomeCoverage: f.live.outcomeCoverage?.map((entry, index) =>
            Array.isArray(intentIds)
              ? { ...entry, intentId: intentIds[index] }
              : entry,
          ),
        });
      },
    );
    const result = await runEvaluator({
      runtime: { useModel },
      context: f.context,
      trajectory: f.trajectory,
    });
    expect(result.messageToUser).toBe(f.live.messageToUser);
    expect(intentIds).toEqual(["intent:1", "intent:2"]);
    expect(result.success).toBe(true);
    expect(result.decision).toBe("FINISH");
    expect(result.effectReceiptIds).toEqual(f.live.effectReceiptIds);
    expect(useModel).toHaveBeenCalledTimes(1);
  });
  it("follows a cited delete to the search that found its unchanged target", async () => {
    const f = liveMoveFixture();
    const [search, , update] = f.trajectory.steps;
    const target = (update.result.data as { targetEvent: { id: string } })
      .targetEvent;
    const receiptId = "calendar-event-mutation-receipt-v1:delete";
    f.trajectory.outcomeIntents = ["delete the coffee with Sam"];
    f.trajectory.steps = [
      search,
      {
        iteration: 2,
        toolCall: { id: "delete", name: "CALENDAR_DELETE_EVENT", params: {} },
        result: {
          ...update.result,
          effectReceipts: update.result.effectReceipts?.map((receipt) => ({
            ...receipt,
            receiptId,
            operation: "calendar.event.delete",
            resource: { ...receipt.resource, version: 'deleted:"eliza-1"' },
          })),
          data: { deleted: true, targetEvent: target },
        },
      },
    ];
    const output = {
      ...f.live,
      outcomeCoverage: [
        {
          intentId: "intent:1",
          status: "completed" as const,
          evidenceStepIds: ["step:2"],
        },
      ],
      messageToUser: "Deleted “coffee with Sam” from your calendar.",
      effectReceiptIds: [receiptId],
    };
    const evaluate = () =>
      runEvaluator({
        runtime: { useModel: async () => JSON.stringify(output) },
        context: f.context,
        trajectory: f.trajectory,
      });
    const result = await evaluate();
    expect(result.messageToUser).toBe(output.messageToUser);
    expect(result.success).toBe(true);
    // A search that saw another version of the event is not the delete's target read.
    const read = search.result.data as { events: object[] };
    read.events = [{ ...target, metadata: { etag: '"eliza-0"' } }];
    expect((await evaluate()).messageToUser).toContain(
      "I couldn't look up that event in your calendar just now.",
    );
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
  it.each([
    ["binding", "CALENDAR_READ_BINDING_IDENTITY_INVALID"],
    ["coverage", "CALENDAR_READ_COVERAGE_MISSING"],
    ["tool", "CALENDAR_READ_OPERATION_MISMATCH"],
    ["snapshot", "CALENDAR_READ_SNAPSHOT_INVALID"],
    ["receipt", "CALENDAR_READ_RECEIPT_MISMATCH"],
    ["interval", "CALENDAR_READ_INTERVAL_INVALID"],
    ["availability", "CALENDAR_READ_AVAILABILITY_INVALID"],
  ])(
    "reports the original %s rejection without private details",
    async (fault, code) => {
      const f = proposalFixture();
      if (fault === "binding") f.binding.actorId = "private-other-owner";
      if (fault === "coverage") f.output.outcomeCoverage = [];
      if (fault === "tool") f.call.name = "CALENDAR_FEED";
      if (fault === "snapshot") delete f.data.calendarSnapshot;
      if (fault === "receipt") f.receipt.resource.id = "private-other-calendar";
      if (fault === "interval") f.data.windowEnd = f.data.windowStart;
      if (fault === "availability") {
        f.binding.operation = "check_availability";
        f.call.name = "CALENDAR_CHECK_AVAILABILITY";
        f.result.effectReceipts = [
          {
            ...f.receipt,
            operation: "calendar.check_availability.read",
            outcome: "noop",
            reason: "Read only",
          },
        ];
        f.data.isFree = false;
        f.data.conflicts = [];
      }
      const coverage = calendarReadCoverage(f.output, f.context, f.trajectory);
      expect(coverage.verified).toBe(false);
      expect(coverage.failureCode).toBe(code);
      const result = await runEvaluator({
        runtime: { useModel: vi.fn(async () => JSON.stringify(f.output)) },
        context: f.context,
        trajectory: f.trajectory,
      });
      const copy =
        fault === "availability"
          ? "I couldn't check whether that time is free just now."
          : "I couldn't check your calendar for open times just now.";
      expect(result.success).toBe(false);
      expect(result.replyFailure).toEqual({
        kind: "reply_generation_error",
        transient: false,
        code,
        message: copy,
      });
      expect(result.messageToUser).toContain(copy);
      expect(JSON.stringify(result.replyFailure)).not.toMatch(
        /private-|selected-calendar|request-now|owner-room/,
      );
    },
  );
  it("does not retain a failed candidate diagnostic when later evidence proves the read", () => {
    const f = proposalFixture();
    const invalid = structuredClone(f.step);
    const invalidCall = invalid.toolCall;
    const coverage = f.output.outcomeCoverage?.[0];
    if (!invalidCall || !coverage) throw new Error("Missing evidence fixture");
    invalidCall.id = "invalid-first";
    invalidCall.name = "CALENDAR_FEED";
    f.trajectory.steps.unshift(invalid);
    coverage.evidenceStepIds = ["step:1", "step:2"];
    expect(calendarReadCoverage(f.output, f.context, f.trajectory)).toEqual({
      verified: true,
      unverifiedIntentIds: [],
    });
  });
  it("rejects model-authored runtime failure diagnostics", () => {
    const f = proposalFixture();
    const parsed = parseEvaluatorOutput(
      JSON.stringify({
        ...f.output,
        replyFailure: {
          kind: "reply_generation_error",
          transient: false,
          code: "CALENDAR_READ_RECEIPT_MISMATCH",
          message: "untrusted",
        },
      }),
    );
    expect(parsed.protocolFailure).toBe(true);
    expect(parsed.replyFailure).toBeUndefined();
  });
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
    [
      "propose_times",
      "I couldn't check your calendar for open times just now.",
    ],
    ["malformed", "I couldn't check your calendar just now."],
  ])(
    "tells the owner plainly which %s read it could not confirm",
    async (kind, copy) => {
      // The :5325 slot run cited CONFLICT_DETECT for a propose_times binding,
      // and the owner got "I couldn't confirm that Calendar request."
      const f = proposalFixture();
      f.call.name = "CONFLICT_DETECT";
      f.result.data = { conflicts: [], checked: true };
      if (kind === "malformed" && f.context.metadata)
        f.context.metadata.calendarReadBindings = { intentId: "intent:1" };
      const result = await runEvaluator({
        runtime: { useModel: vi.fn(async () => JSON.stringify(f.output)) },
        context: f.context,
        trajectory: f.trajectory,
      });
      expect(result.success).toBe(false);
      expect(result.messageToUser).toBe(copy);
      expect(result.replyFailure?.message).toBe(copy);
      expect(result.messageToUser).not.toMatch(
        /planner|scope|intent|tool|receipt|request|—/i,
      );
    },
  );
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

describe("existing-event duration through actual scheduling and coverage", () => {
  async function proposal(
    input: { existingMinutes?: number; newMinutes?: number; legacy?: boolean },
    check: (proof: {
      result: Awaited<ReturnType<typeof executePlannedToolCall>>;
      f: ReturnType<typeof fixture>;
      read: { mock: { calls: unknown[][] } };
      event: LifeOpsCalendarEvent;
    }) => void,
  ) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-04T01:19:36Z"));
    const runtime = new AgentRuntime({
      character: {
        name: "Existing duration producer",
        bio: [],
        settings: { TIMEZONE: "UTC" },
      },
      logLevel: "fatal",
    });
    const noModel = vi
      .spyOn(runtime, "useModel")
      .mockRejectedValue(new Error("No model permitted"));
    vi.spyOn(runtime, "getTasks").mockResolvedValue([
      {
        name: "LIFEOPS_SCHEDULER",
        metadata: {
          lifeopsScheduler: { kind: "runtime_runner", version: 1 },
          meetingPreferences: {
            preferredStartLocal: "08:00",
            preferredEndLocal: "20:00",
          },
        },
      },
    ]);
    const event: LifeOpsCalendarEvent = {
      id: "existing-workshop",
      externalId: "existing-workshop",
      agentId: runtime.agentId,
      provider: "google",
      side: "owner",
      calendarId: "selected-calendar",
      title: "Long workshop",
      description: "",
      location: "",
      status: "confirmed",
      startAt: "2026-10-01T08:00:00.000Z",
      endAt: new Date(
        Date.parse("2026-10-01T08:00:00Z") +
          (input.existingMinutes ?? 30) * 60_000,
      ).toISOString(),
      isAllDay: false,
      timezone: "UTC",
      htmlLink: null,
      conferenceLink: null,
      organizer: null,
      attendees: [],
      metadata: {},
      syncedAt: "2026-10-04T01:19:36Z",
      updatedAt: "2026-10-04T01:19:36Z",
    };
    const before = structuredClone(event);
    const read = vi
      .spyOn(LifeOpsService.prototype, "getCalendarFeed")
      .mockImplementation(async (_url, options) => ({
        calendarId: "selected-calendar",
        events: options?.timeMin === "2026-10-05T08:00:00.000Z" ? [] : [event],
        source: "synced",
        state: "complete",
        syncedAt: "2026-10-04T01:19:36Z",
        timeMin: options?.timeMin ?? "2026-09-01T00:00:00Z",
        timeMax: options?.timeMax ?? "2026-11-01T00:00:00Z",
        sources: [
          {
            key: {
              provider: "google",
              side: "owner",
              grantId: "owner-grant",
              connectorAccountId: "owner-account",
              calendarId: "selected-calendar",
            },
            summary: "Selected calendar",
            accessRole: "owner",
            visibility: "details",
            status: "fresh",
            syncedAt: "2026-10-04T01:19:36Z",
            error: null,
          },
        ],
      }));
    const create = vi.spyOn(LifeOpsService.prototype, "createCalendarEvent"),
      update = vi.spyOn(LifeOpsService.prototype, "updateCalendarEvent"),
      remove = vi.spyOn(LifeOpsService.prototype, "deleteCalendarEvent");
    vi.spyOn(collaborator, "renderGroundedActionReply").mockImplementation(
      renderGroundedActionReply,
    );
    try {
      runtime.registerAction(calendarAction);
      for (const action of promoteSubactionsToActions(
        calendarAction,
        calendarActionPromotionOptions,
      ))
        runtime.registerAction(action);
      const duration =
        input.existingMinutes === undefined
          ? input.legacy
            ? undefined
            : { minutes: input.newMinutes }
          : {
              existingEventQuery: "Long workshop",
              ...(input.newMinutes === undefined || input.legacy
                ? {}
                : { minutes: input.newMinutes }),
            };
      const name = input.legacy ? "CALENDAR" : "CALENDAR_PROPOSE_TIMES";
      const params = {
        ...(input.legacy
          ? { action: "propose_times", durationMinutes: input.newMinutes }
          : {}),
        ...(duration ? { duration } : {}),
        slotCount: 1,
        windowStart: "2026-10-05T08:00:00",
        windowEnd: "2026-10-05T20:00:00",
        timeZone: "UTC",
      };
      const message = {
        id: "00000000-0000-0000-0000-000000000201",
        agentId: runtime.agentId,
        entityId: runtime.agentId,
        roomId: "00000000-0000-0000-0000-000000000202",
        createdAt: requestedAt,
        content: {
          text:
            input.existingMinutes === undefined
              ? "Find a new meeting opening."
              : "Find times to move Long workshop, preserving its duration.",
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
      const f = fixture();
      const bindings = f.context.metadata
        ?.calendarReadBindings as CalendarReadBinding[];
      bindings[0] = {
        ...bindings[0],
        operation: "propose_times",
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
          toolCall: {
            id: "actual-existing-duration",
            name,
            params,
          },
          result,
        },
      ];
      check({ result, f, read, event });
      expect(event).toEqual(before);
      expect(noModel).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  }
  it.each([540.5, 5.5])(
    "preserves %s existing minutes from the canonical handler through completion coverage",
    async (minutes) => {
      await proposal(
        { existingMinutes: minutes },
        ({ result, f, read, event }) => {
          expect(result.success).toBe(true);
          expect(result.data).toMatchObject({
            durationMinutes: minutes,
            existingEvent: event,
            slots: [expect.objectContaining({ durationMinutes: minutes })],
            targetSnapshot: {
              artifacts: expect.arrayContaining([
                expect.objectContaining({
                  kind: "calendar.event",
                  id: event.id,
                  version: event.updatedAt,
                }),
              ]),
            },
          });
          const slots = result.data?.slots;
          if (!Array.isArray(slots) || !slots[0])
            throw new Error("Missing actual proposed slot");
          const slot = slots[0] as { startAt: string; endAt: string };
          expect(Date.parse(slot.endAt) - Date.parse(slot.startAt)).toBe(
            minutes * 60_000,
          );
          expect(
            calendarReadCoverage(f.output, f.context, f.trajectory).verified,
          ).toBe(true);
          expect(read).toHaveBeenCalledTimes(2);
          for (const fault of [
            "duration",
            "source",
            "receipt",
            "window",
            "target",
            "event-duration",
          ]) {
            const bad = structuredClone(f.trajectory);
            const step = bad.steps[0];
            if (!step.result?.data || !step.result.effectReceipts?.[0])
              throw new Error("Missing actual proposal evidence");
            if (fault === "duration")
              step.result.data.durationMinutes = minutes + 1;
            if (fault === "source")
              step.result.effectReceipts[0].resource.id = "other-calendar";
            if (fault === "receipt")
              step.result.effectReceipts[0].outcome = "noop";
            if (fault === "target") delete step.result.data.targetSnapshot;
            if (fault === "event-duration")
              (step.result.data.existingEvent as LifeOpsCalendarEvent).endAt =
                "2026-10-01T08:10:00Z";
            if (fault === "window")
              step.result.data.windowEnd = "2026-10-05T08:00:00Z";
            expect(
              calendarReadCoverage(f.output, f.context, bad).verified,
            ).toBe(false);
          }
        },
      );
    },
  );
  it("retains the existing sub-five-minute event refusal", async () => {
    await proposal({ existingMinutes: 2.5 }, ({ result, read }) => {
      expect(result.success).toBe(false);
      expect(result.data?.error).toBe("INVALID_EVENT_DURATION");
      expect(read).toHaveBeenCalledOnce();
    });
  });
  it.each([4.99, 5, 480, 480.01])(
    "keeps the new-slot bounds for %s requested minutes",
    async (minutes) => {
      await proposal({ newMinutes: minutes }, ({ result, f, read }) => {
        const valid = minutes >= 5 && minutes <= 480;
        expect(result.success).toBe(valid);
        if (valid) {
          expect(result.data?.durationMinutes).toBe(minutes);
          expect(
            calendarReadCoverage(f.output, f.context, f.trajectory).verified,
          ).toBe(true);
          expect(read).toHaveBeenCalledOnce();
        } else {
          expect(result.failureProvenance?.code).toBe(
            "ACTION_ARGUMENTS_INVALID",
          );
          expect(read).not.toHaveBeenCalled();
        }
      });
    },
  );

  it.each([4.99, 480.01])(
    "rejects out-of-range legacy new lengths %s in the actual handler",
    async (minutes) => {
      await proposal(
        { newMinutes: minutes, legacy: true },
        ({ result, read }) => {
          expect(result.success).toBe(false);
          expect(result.data).toMatchObject({
            error: "INVALID_ARGUMENTS",
            outOfRange: ["durationMinutes (5-480)"],
          });
          expect(read).not.toHaveBeenCalled();
        },
      );
    },
  );

  it("reports no choices when the preserved event cannot fit the bounded window", async () => {
    await proposal({ existingMinutes: 900 }, ({ result, f, read }) => {
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        durationMinutes: 900,
        slots: [],
        awaitingUserInput: true,
      });
      expect(
        calendarReadCoverage(f.output, f.context, f.trajectory).verified,
      ).toBe(true);
      expect(read).toHaveBeenCalledTimes(2);
    });
  });
  it("does not use an existing-event query to bypass an explicit new-length limit", async () => {
    await proposal(
      { existingMinutes: 540.5, newMinutes: 540.5, legacy: true },
      ({ result, read }) => {
        expect(result.success).toBe(false);
        expect(result.data).toMatchObject({
          error: "INVALID_ARGUMENTS",
          outOfRange: ["durationMinutes (5-480)"],
        });
        expect(read).not.toHaveBeenCalled();
      },
    );
  });
});

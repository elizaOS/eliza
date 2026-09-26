import {
  completionContextSources,
  type IAgentRuntime,
  type Memory,
} from "@elizaos/core";
import { expect, it } from "vitest";
import { createCalendarActionRunner } from "../../../../plugin-calendar/src/actions/calendar-handler.ts";
import { CalendarService } from "../../../../plugin-calendar/src/service/CalendarService.ts";
import { runEvaluator } from "../../runtime/evaluator.ts";
import {
  applyHistoryRetentionReview,
  prepareHistoryRetention,
} from "../../runtime/history-retention.ts";
import {
  ACTION_CONTEXT_ARG,
  runPlannerLoop,
} from "../../runtime/planner-loop.ts";
import {
  loadHistoryReferences,
  projectBackgroundHistory,
  projectReviewedHistory,
  requestedHistory,
  withBackgroundHistory,
} from "./history-discovery.ts";
import { executeV5PlannedToolCall } from "./planned-tool.ts";
import { renderMessageHandlerModelInput } from "./stage1-input.ts";

function fixture(owner = "owner") {
  const context = {
    id: "turn",
    metadata: { roomId: "room", messageId: "turn" },
    events: Array.from({ length: 30 }, (_, i) => ({
      id: `history:${i}`,
      type: "segment" as const,
      source: "prior-dialogue",
      segment: {
        id: `history:${i}`,
        label: i % 2 ? "prior_message:agent" : "prior_message:user",
        content: `original-${i}: ${i === 0 ? "Never send mail" : "completed unrelated exchange"}`,
        stable: false,
        metadata: { roomId: "room", entityId: i % 2 ? "agent" : owner },
      },
    })),
  };
  const scope = {
    agentId: "agent",
    roomId: "room",
    entityId: owner,
    roles: ["OWNER"],
  };
  const prepared = prepareHistoryRetention(
    context,
    scope,
    null,
    "evidence",
    30,
  );
  const checkpoint = applyHistoryRetentionReview(prepared, {
    sourceSetId: prepared.sourceSetId,
    complete: true,
    retainSourceIds: ["h1"],
    deferSourceIds: prepared.candidates.slice(1).map((s) => s.id),
    uncertainSourceIds: [],
    dependencyGroups: [],
  });
  const history = projectReviewedHistory(context, scope, checkpoint);
  if (!history) throw new Error("Missing validated projection");
  return { context, history, checkpoint, scope };
}
it("renders a validated background checkpoint in plain dialogue without a foreground source-selection task", () => {
  const { context, history } = fixture();
  const before = structuredClone(context);
  const input = renderMessageHandlerModelInput(
    { character: { name: "Eliza" } },
    context,
    [],
    { directMessage: true, nativeTools: true, history },
  );
  const text = JSON.stringify(input.messages);
  expect(text).toContain("Never send mail");
  expect(text).not.toContain("original-2:");
  expect(text).toContain("original-29:");
  expect(text).not.toContain("History source map");
  expect(text).toContain("history:all");
  expect(
    requestedHistory(context, history, { replyText: "hello" }, []),
  ).toEqual([]);
  expect(context).toEqual(before);
  expect(completionContextSources(context).sources).toHaveLength(30);
});

it.each([
  null,
  {},
  { mode: "selected", complete: false },
  { mode: "selected", complete: true, sourceSetId: "stale" },
])(
  "restores complete originals for explicit invalid foreground selections: %j",
  (completionContext) => {
    const { context, history } = fixture();
    expect(
      requestedHistory(context, history, { completionContext }, []),
    ).toEqual(["history:all"]);
  },
);

it("retains canonical originals and restores the first planner view without executing companion calls", async () => {
  const { context, history } = fixture();
  const full = withBackgroundHistory(context, history);
  const before = structuredClone(full);
  const calls: unknown[] = [];
  let effects = 0;
  const result = await runPlannerLoop({
    context: full,
    tools: [{ name: "READ", description: "Read a record" }],
    runtime: {
      useModel: async (_type, params) => {
        calls.push(params);
        if (calls.length === 1)
          return {
            text: "",
            toolCalls: [
              {
                id: "restore",
                name: "RESTORE_CONTEXT",
                arguments: {
                  scope: "history",
                  reason: "Need an older referent",
                },
              },
              { id: "blocked", name: "READ", arguments: {} },
            ],
          };
        return {
          text: "",
          toolCalls: [
            { id: "finish", name: "REPLY", arguments: { text: "Restored." } },
          ],
        };
      },
    },
    executeToolCall: async () => {
      effects++;
      throw new Error("Unexpected effect");
    },
    evaluate: async () => ({
      success: true,
      decision: "FINISH",
      messageToUser: "Restored.",
    }),
  });
  expect(calls).toHaveLength(2);
  expect(JSON.stringify(calls[0])).not.toContain("original-2:");
  expect(JSON.stringify(calls[1])).toContain("original-2:");
  expect(
    result.trajectory.modelBaseContext?.metadata?.backgroundHistory,
  ).toBeUndefined();
  expect(effects).toBe(0);
  expect(full).toEqual(before);
});

it("keeps explicit foreground full/failure semantics and stale views fail open to originals", () => {
  const { context, history } = fixture();
  const full = withBackgroundHistory(context, history);
  for (const completionContext of [
    null,
    {},
    { mode: "full", complete: true },
    { mode: "selected", complete: false },
  ]) {
    expect(
      projectBackgroundHistory({
        ...full,
        metadata: { ...full.metadata, completionContext },
      }).applied,
    ).toBe(false);
  }
  const changed = structuredClone(full);
  changed.events[0].segment.content += "changed";
  expect(projectBackgroundHistory(changed).applied).toBe(false);
});

it("does not retry a background decision after all deferred originals have been loaded", () => {
  const { context, history } = fixture();
  const loaded = loadHistoryReferences(
    context,
    history,
    completionContextSources(context).sources.map((s) => `history:${s.id}`),
  );
  expect(
    projectBackgroundHistory(withBackgroundHistory(context, loaded.projection))
      .applied,
  ).toBe(false);
  expect(
    requestedHistory(
      context,
      loaded.projection,
      { replyText: "Done reading." },
      [],
    ),
  ).toEqual([]);
});

it("keeps non-dialogue committed effects even when an external event ID collides with deferred history", () => {
  const { context, history } = fixture();
  const effect = {
    id: "history:2",
    type: "segment" as const,
    source: "message-service",
    segment: {
      id: "effect",
      label: "runtime:historical_effects",
      content: "Committed effect must not repeat",
      stable: false,
    },
  };
  const full = withBackgroundHistory(
    { ...context, events: [...context.events, effect] },
    history,
  );
  const projected = projectBackgroundHistory(full);
  expect(projected.applied).toBe(true);
  expect(projected.context.events).toContain(effect);
});

it("restores background originals for the evaluator without releasing a premature reply", async () => {
  const { context, history } = fixture();
  const full = withBackgroundHistory(context, history);
  const before = structuredClone(full);
  const trajectory = {
    context: full,
    modelBaseContext: full,
    steps: [],
    archivedSteps: [],
    plannedQueue: [],
    evaluatorOutputs: [],
  };
  const calls: unknown[] = [];
  let effects = 0;
  await runEvaluator({
    context: full,
    trajectory,
    runtime: {
      useModel: async (_type, params) => {
        calls.push(params);
        return JSON.stringify(
          calls.length === 1
            ? {
                thought: "Need older evidence",
                success: false,
                decision: "CONTINUE",
                contextRequest: "history",
              }
            : {
                thought: "Read originals",
                success: false,
                decision: "CONTINUE",
              },
        );
      },
    },
    effects: {
      messageToUser: async () => {
        effects++;
      },
      copyToClipboard: async () => {
        effects++;
      },
    },
  });
  expect(calls).toHaveLength(2);
  expect(JSON.stringify(calls[0])).not.toContain("original-2:");
  expect(JSON.stringify(calls[1])).toContain("original-2:");
  expect(
    trajectory.modelBaseContext.metadata?.backgroundHistory,
  ).toBeUndefined();
  expect(effects).toBe(0);
  expect(full).toEqual(before);
});

it.each([
  "background",
  "null",
  "full",
  "incomplete",
  "stale",
  "wrong-request",
  "restored",
] as const)(
  "passes the authorized history view into real calendar create extraction without writing: %s",
  async (mode) => {
    const owner = "00000000-0000-0000-0000-000000000002";
    const { context, history } = fixture(owner);
    const full = withBackgroundHistory(context, history);
    if (mode === "restored")
      full.metadata = { ...full.metadata, plannerQueryTokensRestored: true };
    const before = structuredClone(full);
    const state = {
      values: { recentMessages: "UNSELECTED_PROVIDER_FALLBACK" },
      data: {},
      text: "other providers",
    };
    const stateBefore = structuredClone(state);
    const prompts: string[] = [];
    let writes = 0;
    const service = {
      getCalendarFeed: async () => ({
        state: "complete",
        events: [],
        sources: [
          {
            status: "fresh",
            key: { grantId: "eliza-calendar", calendarId: "primary" },
          },
        ],
        timeMin: "2026-09-25T00:00:00Z",
        timeMax: "2026-10-09T00:00:00Z",
      }),
      listCalendars: async () => [],
      createCalendarEvent: async () => {
        writes++;
        throw new Error("Forbidden test write");
      },
    };
    const action = createCalendarActionRunner({
      runTextModel: async () => {
        throw new Error("Unexpected text inference");
      },
      runJsonModel: async ({ actionType, prompt }) => {
        expect(actionType).toBe("lifeops.calendar.extract_create_event");
        prompts.push(prompt);
        return {
          rawResponse: "{}",
          parsed: { requiresInput: true, clarification: "What time?" },
        };
      },
      recentConversationTexts: async () => [],
    });
    const runtime = {
      actions: [action],
      agentId: "agent",
      getRoom: async () => ({ id: "room", worldId: "world" }),
      getWorld: async () => ({
        id: "world",
        metadata: {
          ownership: { ownerId: owner },
          roles: { [owner]: "OWNER" },
          roleSources: { [owner]: "owner" },
        },
      }),
      getService: (name: string) =>
        name === CalendarService.serviceType ? service : undefined,
      getSetting: () => undefined,
      reportError: () => {},
      logger: { debug: () => {}, warn: () => {}, error: () => {} },
      useModel: async () => {
        throw new Error("No provider calls allowed");
      },
    } as unknown as IAgentRuntime;
    const message = {
      id: "turn",
      roomId: "room",
      entityId: owner,
      agentId: "agent",
      createdAt: Date.parse("2026-09-25T12:00:00Z"),
      content: {
        text: "CURRENT_REQUEST: Create a calendar appointment, but ask me for its time.",
      },
    } as Memory;
    const foreground =
      mode === "null"
        ? null
        : {
            mode: mode === "full" ? "full" : "selected",
            complete: mode !== "incomplete",
            sourceSetId:
              mode === "stale"
                ? "stale"
                : completionContextSources(full).sourceSetId,
            relevantSourceIds: ["h1"],
            constraintSourceIds: [],
            referentSourceIds: [],
            pendingIntentSourceIds: [],
          };
    if (mode === "wrong-request") message.id = "other-turn";
    const result = await executeV5PlannedToolCall({
      runtime,
      plannerRuntime: runtime,
      plannerContext: full,
      toolCall: {
        ...(["null", "full", "incomplete", "stale"].includes(mode)
          ? { completionContext: foreground }
          : {}),
        id: "proposed-create",
        name: "CALENDAR",
        params: {
          subaction: "create_event",
          title: "Appointment",
          details: { timeZone: "UTC" },
        },
      },
      executorCtx: {
        message,
        state,
        userRoles: ["OWNER"],
        activeContexts: ["calendar"],
      },
      executorOptions: { actions: [action] },
    });
    expect(prompts, JSON.stringify(result)).toHaveLength(1);
    if (mode === "wrong-request")
      expect(prompts[0]).not.toContain("Never send mail");
    else expect(prompts[0]).toContain("Never send mail");
    expect(prompts[0]).toContain("CURRENT_REQUEST:");
    if (mode === "wrong-request")
      expect(prompts[0]).not.toContain("original-29:");
    else expect(prompts[0]).toContain("original-29:");
    if (mode === "background" || mode === "wrong-request")
      expect(prompts[0]).not.toContain("original-2:");
    else expect(prompts[0]).toContain("original-2:");
    expect(prompts[0]).not.toContain("UNSELECTED_PROVIDER_FALLBACK");
    expect(result.success).toBe(false);
    expect(result.effectReceipts).toEqual(
      expect.arrayContaining([expect.objectContaining({ outcome: "noop" })]),
    );
    expect(writes).toBe(0);
    expect(full).toEqual(before);
    expect(state).toEqual(stateBefore);
  },
);

it.each([
  null,
  { complete: true, relevantSourceIds: ["h1"] },
  "valid-unoffered",
])(
  "does not certify an unoffered foreground review or reapply background projection: %j",
  async (review) => {
    const { context, history } = fixture();
    const full = withBackgroundHistory(context, history);
    const submittedReview =
      review === "valid-unoffered"
        ? {
            mode: "selected",
            complete: true,
            sourceSetId: completionContextSources(full).sourceSetId,
            // Valid canonical identity, but this hides the retained standing constraint
            // and selects an original absent from the actual partial model input.
            relevantSourceIds: ["h3"],
            constraintSourceIds: [],
            referentSourceIds: [],
            pendingIntentSourceIds: [],
          }
        : review;
    const calls: unknown[] = [];
    const executed: unknown[] = [];
    const result = await runPlannerLoop({
      context: full,
      tools: [{ name: "READ" }],
      runtime: {
        useModel: async (_type, params) => {
          calls.push(params);
          return {
            text: "",
            toolCalls:
              calls.length === 1
                ? [
                    {
                      id: "read",
                      name: "READ",
                      arguments: { [ACTION_CONTEXT_ARG]: submittedReview },
                    },
                  ]
                : [
                    {
                      id: "reply",
                      name: "REPLY",
                      arguments: { text: "Done." },
                    },
                  ],
          };
        },
      },
      executeToolCall: async (call) => {
        executed.push(call);
        return { success: true, text: "Read." };
      },
      evaluate: async () => ({ success: false, decision: "CONTINUE" }),
    });
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[0])).not.toContain("original-2:");
    expect(JSON.stringify(calls[0])).toContain("Never send mail");
    expect(
      JSON.stringify((calls[0] as { tools: unknown }).tools),
    ).not.toContain(ACTION_CONTEXT_ARG);
    expect(JSON.stringify(calls[1])).toContain("original-2:");
    expect(executed[0]).toMatchObject({ completionContext: null });
    expect(JSON.stringify(calls[1])).toContain("Never send mail");
    expect(
      result.trajectory.modelBaseContext?.metadata?.completionContext,
    ).toBeNull();
    expect(result.trajectory.modelBaseContext?.events).toEqual(full.events);
    expect(
      result.trajectory.modelBaseContext?.metadata?.backgroundHistory,
    ).toBeUndefined();
  },
);

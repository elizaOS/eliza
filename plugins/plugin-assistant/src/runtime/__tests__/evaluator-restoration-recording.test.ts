/** Restoration decisions must remain visible beside the model call that requested them. */
import {
  type ContextObject,
  completionContextSources,
  type PlannerTrajectory,
  type RecordedStage,
  type TrajectoryRecorder,
} from "@elizaos/core";
import { expect, it, vi } from "vitest";
import { EVALUATOR_CONTEXT_ROUTES } from "../../prompts/evaluator";
import { parseEvaluatorOutput, runEvaluator } from "../evaluator";

it.each(
  ["history", "full"].flatMap((scope) =>
    ["legacy", "decision"].map((wire) => ({ scope, wire })),
  ),
)(
  "records the $wire $scope request before the restored evaluation",
  async ({ scope, wire }) => {
    const context: ContextObject = {
      id: "restoration-recording",
      events: [1, 2].map((id) => ({
        id: `history:${id}`,
        type: "segment" as const,
        source: "prior-dialogue",
        createdAt: id,
        segment: {
          id: `history:${id}`,
          label: "prior_message:user",
          content: `Original ${id}`,
          stable: false,
        },
      })),
    };
    context.metadata = {
      completionContext: {
        mode: "selected",
        complete: true,
        sourceSetId: completionContextSources(context).sourceSetId,
        relevantSourceIds: ["h1"],
        constraintSourceIds: [],
        referentSourceIds: [],
        pendingIntentSourceIds: [],
      },
    };
    const trajectory: PlannerTrajectory = {
      context,
      modelBaseContext: context,
      steps: [],
      plannedQueue: [],
      evaluatorOutputs: [],
    };
    const stages: RecordedStage[] = [];
    const recorder: TrajectoryRecorder = {
      startTrajectory: () => "recording",
      recordStage: async (_id, stage) => {
        stages.push(stage);
      },
      endTrajectory: async () => {},
      load: async () => null,
      list: async () => [],
    };
    let calls = 0;
    await runEvaluator({
      context,
      trajectory,
      recorder,
      trajectoryId: "recording",
      runtime: {
        useModel: async () =>
          JSON.stringify(
            ++calls === 1
              ? {
                  success: false,
                  ...(wire === "legacy"
                    ? { decision: "CONTINUE", contextRequest: scope }
                    : { decision: `RESTORE_${scope.toUpperCase()}` }),
                  thought: "An original constraint is needed.",
                }
              : {
                  success: false,
                  decision: "CONTINUE",
                  thought: "Original context inspected.",
                },
          ),
      },
    });
    expect(calls).toBe(2);
    expect(stages).toHaveLength(2);
    expect(stages[0]?.evaluation?.contextRequest).toBe(scope);
    expect(stages[1]?.evaluation).not.toHaveProperty("contextRequest");
    expect(stages[0]?.model?.response).toContain(
      wire === "legacy"
        ? `"contextRequest":"${scope}"`
        : `"decision":"RESTORE_${scope.toUpperCase()}"`,
    );
    expect(trajectory.modelBaseContext?.events).toEqual(context.events);
    expect(
      trajectory.modelBaseContext?.metadata?.plannerQueryTokensRestored,
    ).toBe(true);
  },
);

it.each(Object.keys(EVALUATOR_CONTEXT_ROUTES))(
  "parses %s to the canonical loop route while preserving the wire decision",
  (decision) => {
    const raw = {
      decision,
      success: false,
      thought: "An original constraint is needed.",
      replyEffectStatus: "none",
    };
    const output = parseEvaluatorOutput(JSON.stringify(raw));
    expect(output.decision).toBe("CONTINUE");
    expect(output.protocolFailure).toBeUndefined();
    expect(output.raw).toEqual(raw);
  },
);

it.each([
  { success: true },
  { messageToUser: "Premature answer" },
  { copyToClipboard: { title: "Premature", content: "answer" } },
  { contextRequest: "unknown" },
])("rejects conflicting restoration effects: %j", (conflict) => {
  const output = parseEvaluatorOutput(
    JSON.stringify({
      decision: "RESTORE_HISTORY",
      success: false,
      thought: "Need original constraints.",
      ...conflict,
    }),
  );
  expect(output.protocolFailure).toBe(true);
  expect(output.decision).toBe("CONTINUE");
  expect(output.raw?.decision).toBe("RESTORE_HISTORY");
});

it.each([
  { decision: "RESTORE_HISTORY", scope: "history" },
  { decision: "RESTORE_PROVIDERS", scope: "providers" },
  { decision: "RESTORE_FULL", scope: "full" },
  // Preserve the real captured contradiction's read authority, not its NEXT route.
  { decision: "NEXT_RECOMMENDED", contextRequest: "history", scope: "history" },
  { decision: "RESTORE_HISTORY", route: "RESTORE_PROVIDERS", scope: "full" },
  // A nonconforming provider mixing protocols must not narrow either request.
  { decision: "RESTORE_HISTORY", contextRequest: "providers", scope: "full" },
])("restores $scope before queued execution: $decision", async (request) => {
  const context: ContextObject = {
    id: "restore-before-queue",
    events: [
      ...[1, 2].map((id) => ({
        id: `history:${id}`,
        type: "segment" as const,
        source: "prior-dialogue",
        createdAt: id,
        segment: {
          id: `history:${id}`,
          label: "prior_message:user",
          content: `Original constraint ${id}`,
          stable: false,
        },
      })),
      {
        id: "provider:guide",
        type: "provider",
        name: "GUIDE",
        text: `Stale provider body ${"detail ".repeat(100)}`,
        discoveryText: "Guide reference available.",
      },
    ],
  };
  context.metadata = {
    providerDiscoveryEnabled: true,
    completionContext: {
      mode: "selected",
      complete: true,
      sourceSetId: completionContextSources(context).sourceSetId,
      relevantSourceIds: ["h1"],
      constraintSourceIds: [],
      referentSourceIds: [],
      pendingIntentSourceIds: [],
    },
  };
  const before = structuredClone(context);
  const trajectory: PlannerTrajectory = {
    context,
    modelBaseContext: context,
    steps: [],
    plannedQueue: [
      { id: "read-event", name: "CALENDAR_NEXT_EVENT", params: {} },
    ],
    evaluatorOutputs: [],
  };
  const originalQueue = structuredClone(trajectory.plannedQueue);
  const messages: string[] = [];
  const messageToUser = vi.fn();
  const copyToClipboard = vi.fn();
  const restoreProviderContext = vi.fn(async (original: ContextObject) => ({
    ...original,
    events: original.events.map((event) =>
      event.id === "provider:guide"
        ? { ...event, text: "Fresh authorized guide" }
        : event,
    ),
  }));
  const output = await runEvaluator({
    context,
    trajectory,
    runtime: {
      restoreProviderContext,
      useModel: async (_type, params) => {
        messages.push(JSON.stringify(params.messages));
        expect(messageToUser).not.toHaveBeenCalled();
        expect(copyToClipboard).not.toHaveBeenCalled();
        return JSON.stringify(
          messages.length === 1
            ? {
                thought: "Need the missing original source before deciding.",
                success: request.decision === "NEXT_RECOMMENDED",
                decision: request.decision,
                ...("route" in request ? { route: request.route } : {}),
                ...(request.contextRequest
                  ? { contextRequest: request.contextRequest }
                  : {}),
                replyEffectStatus: "none",
                ...(request.decision === "NEXT_RECOMMENDED"
                  ? { recommendedToolCallId: "read-event" }
                  : {}),
              }
            : {
                thought:
                  "Read complete evidence; queued read remains grounded.",
                success: true,
                decision: "NEXT_RECOMMENDED",
                recommendedToolCallId: "read-event",
                replyEffectStatus: "none",
              },
        );
      },
    },
    effects: { messageToUser, copyToClipboard },
  });
  expect(messages).toHaveLength(2);
  expect(messages[0]).not.toContain("Original constraint 2");
  expect(messages[0]).not.toContain("Stale provider body");
  expect(messages[1]?.includes("Original constraint 2")).toBe(
    request.scope !== "providers",
  );
  expect(messages[1]?.includes("Fresh authorized guide")).toBe(
    request.scope !== "history",
  );
  expect(messages[1]).not.toContain("Stale provider body");
  expect(restoreProviderContext).toHaveBeenCalledTimes(
    request.scope === "history" ? 0 : 1,
  );
  expect(output.decision).toBe("NEXT_RECOMMENDED");
  expect(output.recommendedToolCallId).toBe("read-event");
  expect(trajectory.plannedQueue).toEqual(originalQueue);
  expect(context).toEqual(before);
  expect(messageToUser).not.toHaveBeenCalled();
  expect(copyToClipboard).not.toHaveBeenCalled();
  if (request.scope !== "providers") {
    expect(
      trajectory.modelBaseContext?.metadata?.completionContext,
    ).toBeUndefined();
    expect(
      trajectory.modelBaseContext?.metadata?.plannerQueryTokensRestored,
    ).toBe(true);
  }
});

it("keeps a successful queued decision to one evaluator call", async () => {
  const useModel = vi.fn(async () =>
    JSON.stringify({
      thought: "The queued Calendar read advances the remaining outcome.",
      success: true,
      decision: "NEXT_RECOMMENDED",
      recommendedToolCallId: "read-event",
      replyEffectStatus: "none",
    }),
  );
  const context: ContextObject = { id: "queue-only", events: [] };
  const trajectory: PlannerTrajectory = {
    context,
    steps: [],
    plannedQueue: [
      { id: "read-event", name: "CALENDAR_NEXT_EVENT", params: {} },
    ],
    evaluatorOutputs: [],
  };
  const before = structuredClone(trajectory);
  const output = await runEvaluator({
    runtime: { useModel },
    context,
    trajectory,
  });
  expect(useModel).toHaveBeenCalledTimes(1);
  expect(output.decision).toBe("NEXT_RECOMMENDED");
  expect(output.recommendedToolCallId).toBe("read-event");
  expect(trajectory).toEqual(before);
});

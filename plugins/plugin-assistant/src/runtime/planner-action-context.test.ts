/** Action-only source review rides the existing planner call; reply context remains complete. */
import {
  type ContextObject,
  completionContextSources,
  type PlannerToolCall,
  runWithStreamingContext,
  selectCompletionContext,
} from "@elizaos/core";
import { expect, it, vi } from "vitest";
import {
  ACTION_CONTEXT_ARG,
  parsePlannerOutput,
  runPlannerLoop,
} from "./planner-loop.ts";

it("labels exact originals and binds action selection in one native planner request", async () => {
  const context: ContextObject = {
    id: "request",
    metadata: { roomId: "room", messageId: "message" },
    events: [
      {
        id: "history:one",
        type: "segment",
        source: "prior-dialogue",
        createdAt: 1,
        segment: {
          id: "history:one",
          label: "prior_message:user",
          content: "Owner: No guests.\nKeep this correction.",
          stable: false,
          metadata: { roomId: "room", entityId: "owner" },
        },
      },
      {
        id: "history:two",
        type: "segment",
        source: "prior-dialogue",
        createdAt: 2,
        segment: {
          id: "history:two",
          label: "prior_message:agent",
          content: "Earlier unrelated reply.",
          stable: false,
        },
      },
    ],
  };
  const before = structuredClone(context);
  const selection = {
    mode: "relevant_prior_dialogue",
    complete: true,
    sourceSetId: completionContextSources(context).sourceSetId,
    relevantSourceIds: [],
    constraintSourceIds: ["h1"],
    referentSourceIds: [],
    pendingIntentSourceIds: [],
  };
  const calls: PlannerToolCall[] = [];
  const useModel = vi.fn(async (_type, params) => {
    const tool = params.tools.find((t) => t.name === "SAVE");
    expect(tool.parameters.required).toContain(ACTION_CONTEXT_ARG);
    expect(
      tool.parameters.properties[ACTION_CONTEXT_ARG].properties.sourceSetId
        .enum,
    ).toEqual([selection.sourceSetId]);
    const messages = JSON.stringify(params.messages);
    expect(messages).toContain("[h1]");
    expect(messages).toContain("[h2]");
    expect(messages).toContain("Keep this correction.");
    expect(messages).toContain("Earlier unrelated reply.");
    return {
      text: "",
      toolCalls: [
        {
          id: "save",
          name: "SAVE",
          arguments: {
            value: "record",
            eliza_turn_scope: "final",
            [ACTION_CONTEXT_ARG]: selection,
          },
        },
      ],
    };
  });
  await runPlannerLoop({
    context,
    runtime: { useModel },
    tools: [
      {
        name: "SAVE",
        description: "Save record",
        parameters: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        },
      },
    ],
    executeToolCall: async (call) => {
      calls.push(call);
      return { success: true, continueChain: false, text: "Saved." };
    },
  });
  expect(useModel).toHaveBeenCalledTimes(1);
  expect(calls[0]).toMatchObject({
    name: "SAVE",
    params: { value: "record" },
    completionContext: { ...selection, mode: "selected" },
  });
  expect(calls[0].params).not.toHaveProperty(ACTION_CONTEXT_ARG);
  expect(context).toEqual(before);
});

it("invalid native source metadata selects no reduced context and never reaches domain parameters", () => {
  const parsed = parsePlannerOutput({
    text: "",
    toolCalls: [
      {
        id: "invalid",
        name: "SAVE",
        arguments: {
          value: "record",
          eliza_turn_scope: "final",
          [ACTION_CONTEXT_ARG]: { complete: true, relevantSourceIds: ["h1"] },
        },
      },
    ],
  });
  expect(parsed.toolCalls[0]).toMatchObject({
    params: { value: "record" },
    completionContext: null,
  });
});

it.each([undefined, { complete: true, relevantSourceIds: ["h1"] }])(
  "JSON planner fallback keeps full context for missing or invalid source review",
  (selection) => {
    const params = {
      value: "record",
      eliza_turn_scope: "final",
      ...(selection ? { [ACTION_CONTEXT_ARG]: selection } : {}),
    };
    const parsed = parsePlannerOutput(
      JSON.stringify({
        toolCalls: [{ id: "json", name: "SAVE", params }],
        completed: true,
      }),
    );
    expect(parsed.toolCalls[0].params).toEqual({ value: "record" });
    expect(parsed.toolCalls[0].completionContext).toBe(
      selection ? null : undefined,
    );
  },
);

it.each(["selected", "missing", "incomplete", "stale", "disagreeing"] as const)(
  "whole-turn %s batch review governs later stages without deleting originals",
  async (mode) => {
    const context: ContextObject = {
      id: "batch",
      metadata: { roomId: "room", messageId: "message" },
      events: [0, 1, 2].map((i) => ({
        id: `history:${i}`,
        type: "segment",
        source: "prior-dialogue",
        createdAt: i,
        segment: {
          id: `history:${i}`,
          label: "prior_message:user",
          content: `Original ${i}`,
          stable: false,
        },
      })),
    };
    const selection = {
      mode: "selected",
      complete: mode !== "incomplete",
      sourceSetId:
        mode === "stale"
          ? "0".repeat(64)
          : completionContextSources(context).sourceSetId,
      relevantSourceIds: ["h1"],
      constraintSourceIds: ["h3"],
      referentSourceIds: [],
      pendingIntentSourceIds: [],
    };
    let executed = 0;
    const useModel = vi.fn(async (_type, _params) => ({
      text: "",
      toolCalls: ["READ_ONE", "READ_TWO"].map((name, i) => ({
        id: name,
        name,
        arguments: {
          eliza_turn_scope: "final",
          ...(mode === "missing" && i === 1
            ? {}
            : {
                [ACTION_CONTEXT_ARG]:
                  mode === "disagreeing" && i === 1
                    ? { ...selection, relevantSourceIds: ["h2"] }
                    : selection,
              }),
        },
      })),
    }));
    const result = await runPlannerLoop({
      context,
      runtime: { useModel },
      tools: ["READ_ONE", "READ_TWO"].map((name) => ({
        name,
        description: "Read record",
        parameters: { type: "object", properties: {} },
      })),
      executeToolCall: async (call) => {
        executed++;
        expect(call.completionContext?.relevantSourceIds ?? null).toEqual(
          mode === "selected" ? ["h1"] : null,
        );
        return { success: true, data: { readOnlyOperation: true } };
      },
      evaluate: async ({ trajectory }) => {
        const base = trajectory.modelBaseContext ?? trajectory.context;
        expect(base.events).toEqual(context.events);
        expect(selectCompletionContext(base).context.events).toEqual(
          mode === "selected"
            ? [context.events[0], context.events[2]]
            : context.events,
        );
        return {
          success: executed === 2,
          decision: executed === 2 ? "FINISH" : "CONTINUE",
          messageToUser: executed === 2 ? "Done." : undefined,
          thought: "Review all pending work.",
          raw: {},
        };
      },
    });
    expect(result.terminalFailure).toBeUndefined();
    expect(executed).toBe(2);
    // This harness also runs the existing final-scope release round in every case.
    expect(useModel).toHaveBeenCalledTimes(2);
    const nextWire = JSON.stringify(useModel.mock.calls[1]?.[1]);
    expect(nextWire).toContain("Original 0");
    expect(nextWire).toContain("Original 2");
    if (mode === "selected") expect(nextWire).not.toContain("Original 1");
    else expect(nextWire).toContain("Original 1");
    expect(context.metadata?.completionContext).toBeUndefined();
  },
);

it("cancellation before planning performs no selection call or domain effect", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled before planner"));
  const useModel = vi.fn();
  const executeToolCall = vi.fn();
  await expect(
    runWithStreamingContext({ abortSignal: controller.signal }, () =>
      runPlannerLoop({
        context: { id: "cancelled", events: [] },
        runtime: { useModel },
        executeToolCall,
      }),
    ),
  ).rejects.toThrow("cancelled before planner");
  expect(useModel).not.toHaveBeenCalled();
  expect(executeToolCall).not.toHaveBeenCalled();
});

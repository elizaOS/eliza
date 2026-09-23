/**
 * An umbrella called without its discriminator normally delegates to the
 * sub-planner, a second planner model call over the child tools. When the
 * umbrella declares `inferSubaction` and the arguments can only mean one
 * promoted child, the executor pins that child's discriminator and runs the
 * umbrella directly, reporting the inference on the result; an ambiguous
 * verdict, a name that is not a promoted child, or no hook keep the
 * sub-planner path (live 2026-09-14 tj-22eb87cbbbfac0: `MEMORY {text, kind,
 * tags}` routed through the sub-planner before MEMORY_CREATE ran).
 */

import { type ContextObject, completionContextSources } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  pinnedDiscriminatorForPromotedChild,
  promoteSubactionsToActions,
} from "../../../../packages/core/src/actions/promote-subactions.ts";
import { createContextObject } from "../../../../packages/core/src/runtime/context-object.ts";
import type {
  Action,
  IAgentRuntime,
  Memory,
  State,
  UUID,
} from "../../../../packages/core/src/types/index.ts";
import type {
  PlannerRuntime,
  PlannerToolCall,
} from "../runtime/planner-loop.ts";
import { toolMessageContent } from "../runtime/planner-rendering";
import { runSubPlanner } from "../runtime/sub-planner.ts";
import {
  buildV5ExecutorContext,
  executeV5PlannedToolCall,
  inferPromotedSubactionDispatch,
} from "./message/planned-tool.ts";

vi.mock("../runtime/sub-planner.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../runtime/sub-planner")>();
  return {
    ...actual,
    runSubPlanner: vi.fn(async () => ({
      status: "finished",
      trajectory: { steps: [], archivedSteps: [] },
      finalMessage: "delegated to the sub-planner",
    })),
  };
});

const OPS = ["create", "search", "delete"] as const;

type InferSubaction = NonNullable<Action["inferSubaction"]>;

/** Mirrors a promoted umbrella: enum discriminator, optional operands. */
function ledgerFamily(inferSubaction?: InferSubaction) {
  const handled: Array<Record<string, unknown>> = [];
  const states: Array<State | undefined> = [];
  const parent: Action = {
    name: "LEDGER",
    description: "Manage ledger entries",
    validate: async () => true,
    handler: async (_runtime, _message, _state, options) => {
      const params = (options?.parameters ?? {}) as Record<string, unknown>;
      handled.push(params);
      states.push(_state);
      return { success: true, text: `ran ${String(params.action)}` };
    },
    parameters: [
      {
        name: "action",
        description: "Operation.",
        required: false,
        schema: { type: "string", enum: [...OPS] },
      },
      {
        name: "text",
        description: "Entry text.",
        required: false,
        schema: { type: "string" },
      },
      {
        name: "query",
        description: "Entry filter.",
        required: false,
        schema: { type: "string" },
      },
      {
        name: "confirm",
        description: "Acknowledge a delete.",
        required: false,
        schema: { type: "boolean" },
      },
    ],
    ...(inferSubaction ? { inferSubaction } : {}),
  };
  const actions = [...promoteSubactionsToActions(parent)];
  return { parent, actions, handled, states };
}

function makeRuntime(actions: Action[]) {
  const useModel = vi.fn();
  const runtime = {
    actions,
    agentId: "00000000-0000-0000-0000-00000000a9e7" as UUID,
    getRoom: vi.fn(async () => null),
    getService: vi.fn(() => undefined),
    getSetting: vi.fn(() => undefined),
    reportError: vi.fn(),
    useModel,
    logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  return { runtime: runtime as unknown as IAgentRuntime, useModel };
}

const message = {
  id: "message-id",
  entityId: "entity-id",
  roomId: "room-id",
  content: { text: "record hello" },
} as Memory;

async function execute(args: {
  actions: Action[];
  runtimeActions?: Action[];
  toolCall: PlannerToolCall;
  plannerContext?: ContextObject;
  state?: State;
}) {
  const { runtime, useModel } = makeRuntime(
    args.runtimeActions ?? args.actions,
  );
  const result = await executeV5PlannedToolCall({
    runtime,
    toolCall: args.toolCall,
    plannerContext:
      args.plannerContext ??
      createContextObject({
        id: "umbrella-infer-subaction",
        events: args.actions.map((action) => ({
          id: `tool:${action.name}`,
          type: "tool",
          tool: { name: action.name, action },
        })),
      }),
    executorCtx: buildV5ExecutorContext({
      message,
      state: args.state ?? ({ values: {}, data: {}, text: "" } as State),
      selectedContexts: [],
      senderRole: "OWNER",
      previousResults: [],
    }),
    plannerRuntime: runtime as unknown as PlannerRuntime,
    executorOptions: { actions: args.actions },
  });
  return { result, useModel };
}

describe("executeV5PlannedToolCall umbrella inferSubaction", () => {
  beforeEach(() => {
    vi.mocked(runSubPlanner).mockClear();
  });

  it.each([undefined, "search"])(
    "records a registered named-child dispatch pin (action: %s)",
    async (operation) => {
      const { actions, handled } = ledgerFamily();
      const toolCall: PlannerToolCall = {
        name: "LEDGER_SEARCH",
        params: {
          query: "weather",
          ...(operation ? { action: operation } : {}),
        },
      };
      const original = structuredClone(toolCall);
      const { result, useModel } = await execute({ actions, toolCall });
      expect(result.success).toBe(true);
      expect(result.registeredSubaction).toEqual({
        child: "LEDGER_SEARCH",
        discriminator: "action",
        value: "search",
      });
      expect(result.inferredSubaction).toBeUndefined();
      expect(toolMessageContent(result)).not.toContain("registeredSubaction");
      expect(toolMessageContent(result)).toContain("ran search");
      expect(handled[0]).toMatchObject({ action: "search", query: "weather" });
      expect(toolCall).toEqual(original);
      expect(runSubPlanner).not.toHaveBeenCalled();
      expect(useModel).not.toHaveBeenCalled();
    },
  );

  it("runs the umbrella directly with the inferred child's pinned discriminator and no sub-planner model call", async () => {
    const { actions, handled } = ledgerFamily((params) =>
      typeof params.text === "string" && !params.query
        ? "LEDGER_CREATE"
        : undefined,
    );
    const toolCall: PlannerToolCall = {
      id: "call-1",
      name: "LEDGER",
      params: { text: "hello" },
    };

    const { result, useModel } = await execute({ actions, toolCall });

    expect(runSubPlanner).not.toHaveBeenCalled();
    expect(useModel).not.toHaveBeenCalled();
    expect(handled).toHaveLength(1);
    expect(handled[0]).toMatchObject({ action: "create", text: "hello" });
    expect(result).toMatchObject({
      success: true,
      text: "ran create",
      inferredSubaction: {
        child: "LEDGER_CREATE",
        discriminator: "action",
        value: "create",
      },
    });
    // The planner's own call is untouched: operation keys, hedge dropping
    // and the recorded tool stage all read it.
    expect(toolCall.params).toEqual({ text: "hello" });
  });

  it("keeps the sub-planner when the hook finds the arguments ambiguous", async () => {
    const hook = vi.fn<InferSubaction>(() => undefined);
    const { actions, handled } = ledgerFamily(hook);

    const { result } = await execute({
      actions,
      toolCall: { id: "call-2", name: "LEDGER", params: { confirm: true } },
    });

    expect(hook).toHaveBeenCalledWith({ confirm: true });
    expect(runSubPlanner).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runSubPlanner).mock.calls[0][0].action.name).toBe(
      "LEDGER",
    );
    expect(handled).toEqual([]);
    expect(result.text).toBe("delegated to the sub-planner");
    expect(result.inferredSubaction).toBeUndefined();
  });

  it("keeps the sub-planner when the inferred name is not a promoted child of the umbrella", async () => {
    const { actions, handled } = ledgerFamily(() => "LEDGER_ARCHIVE");

    const { result } = await execute({
      actions,
      toolCall: { id: "call-3", name: "LEDGER", params: { text: "hello" } },
    });

    expect(runSubPlanner).toHaveBeenCalledTimes(1);
    expect(handled).toEqual([]);
    expect(result.inferredSubaction).toBeUndefined();
  });

  it("keeps the sub-planner for an umbrella without the hook", async () => {
    const { actions, handled } = ledgerFamily();

    await execute({
      actions,
      toolCall: { id: "call-4", name: "LEDGER", params: { text: "hello" } },
    });

    expect(runSubPlanner).toHaveBeenCalledTimes(1);
    expect(handled).toEqual([]);
  });

  it("does not consult the hook when the planner passed the discriminator", async () => {
    const hook = vi.fn<InferSubaction>(() => "LEDGER_CREATE");
    const { actions, handled } = ledgerFamily(hook);

    const { result } = await execute({
      actions,
      toolCall: {
        id: "call-5",
        name: "LEDGER",
        params: { action: "search", query: "hello" },
      },
    });

    expect(hook).not.toHaveBeenCalled();
    expect(runSubPlanner).not.toHaveBeenCalled();
    expect(handled[0]).toMatchObject({ action: "search", query: "hello" });
    expect(result.inferredSubaction).toBeUndefined();
  });
});

describe("pinnedDiscriminatorForPromotedChild", () => {
  it("reads the pinned enum of a declared promoted child, by normalized name", () => {
    const { parent, actions } = ledgerFamily();
    const lookup = (name: string) =>
      actions.find((action) => action.name === name);
    const expected = {
      child: "LEDGER_DELETE",
      discriminator: "action",
      value: "delete",
    };

    expect(
      pinnedDiscriminatorForPromotedChild(parent, "LEDGER_DELETE", lookup),
    ).toEqual(expected);
    expect(
      pinnedDiscriminatorForPromotedChild(parent, "ledger delete", lookup),
    ).toEqual(expected);
    expect(
      pinnedDiscriminatorForPromotedChild(parent, "LEDGER_ARCHIVE", lookup),
    ).toBeUndefined();
    expect(
      pinnedDiscriminatorForPromotedChild(
        parent,
        "LEDGER_DELETE",
        () => undefined,
      ),
    ).toBeUndefined();
  });

  it("ignores a declared child that carries no pinned discriminator", () => {
    const child: Action = {
      name: "PLAIN_CHILD",
      description: "No pin",
      validate: async () => true,
      handler: async () => ({ success: true }),
    };
    const parent: Action = {
      name: "PARENT",
      description: "Hand-declared family",
      validate: async () => true,
      handler: async () => ({ success: true }),
      subActions: [child],
    };

    expect(
      pinnedDiscriminatorForPromotedChild(
        parent,
        "PLAIN_CHILD",
        () => undefined,
      ),
    ).toBeUndefined();
  });
});

describe("inferPromotedSubactionDispatch", () => {
  it("returns a fresh pinned call and leaves the planner's call alone", () => {
    const { parent, actions } = ledgerFamily(() => "LEDGER_SEARCH");
    const toolCall: PlannerToolCall = {
      id: "call-6",
      name: "LEDGER",
      params: { query: "hello" },
    };

    const inferred = inferPromotedSubactionDispatch(parent, toolCall, (name) =>
      actions.find((action) => action.name === name),
    );

    expect(inferred).toEqual({
      toolCall: {
        id: "call-6",
        name: "LEDGER",
        params: { query: "hello", action: "search" },
      },
      record: {
        child: "LEDGER_SEARCH",
        discriminator: "action",
        value: "search",
      },
    });
    expect(toolCall.params).toEqual({ query: "hello" });
  });

  it("returns undefined for an empty verdict or a missing hook", () => {
    const lookup = () => undefined;
    const blank = ledgerFamily(() => "   ");
    expect(
      inferPromotedSubactionDispatch(
        blank.parent,
        { name: "LEDGER", params: {} },
        lookup,
      ),
    ).toBeUndefined();
    const none = ledgerFamily();
    expect(
      inferPromotedSubactionDispatch(
        none.parent,
        { name: "LEDGER", params: { text: "hello" } },
        lookup,
      ),
    ).toBeUndefined();
  });
});

it("keeps inference within the supplied action surface", async () => {
  const { parent, actions, handled } = ledgerFamily(() => "LEDGER_CREATE");
  const { result } = await execute({
    actions: [parent],
    runtimeActions: actions,
    toolCall: { name: "LEDGER", params: { text: "hello" } },
  });
  expect(handled).toEqual([]);
  expect(result.inferredSubaction).toBeUndefined();
});

it("does not substitute an umbrella for an independently implemented child", () => {
  const { parent } = ledgerFamily(() => "LEDGER_CREATE");
  const child: Action = {
    name: "LEDGER_CREATE",
    description: "Independent child contract",
    parameters: [
      {
        name: "action",
        description: "Operation",
        required: true,
        schema: { type: "string", enum: ["create"] },
      },
    ],
  };
  parent.subActions = [child];
  expect(
    inferPromotedSubactionDispatch(
      parent,
      { name: "LEDGER", params: { text: "hello" } },
      () => child,
    ),
  ).toBeUndefined();
});

// Domain extraction must see the same reviewed originals as the planner while
// cached provider state stays complete and reusable by later turns.
describe("action-local conversation evidence", () => {
  it.each(["selected", "empty", "stale", "missing"] as const)(
    "supplies %s source selection without mutating cached state",
    async (mode) => {
      const { actions, states } = ledgerFamily();
      const plannerContext: ContextObject = {
        id: message.id,
        metadata: { roomId: message.roomId, messageId: message.id },
        events: [
          "Owner: Keep this exact\nmultiline correction.",
          "Old unrelated task.",
        ].map((content, index) => ({
          id: `history:original-${index}`,
          type: "segment",
          source: "prior-dialogue",
          createdAt: index,
          segment: {
            id: `history:original-${index}`,
            label: "prior_message:user",
            content,
            stable: false,
            metadata: {
              roomId: message.roomId,
              entityId: message.entityId,
              speakerName: "Owner",
            },
          },
        })),
      };
      if (mode !== "missing") {
        plannerContext.metadata = {
          ...plannerContext.metadata,
          completionContext: {
            mode: "selected",
            complete: true,
            sourceSetId:
              mode === "stale"
                ? "stale"
                : completionContextSources(plannerContext).sourceSetId,
            relevantSourceIds: mode === "empty" ? [] : ["h1"],
            constraintSourceIds: [],
            referentSourceIds: [],
            pendingIntentSourceIds: [],
          },
        };
      }
      const state: State = {
        text: "Complete provider history",
        values: {
          recentMessages: "Complete provider history",
          selectedActionConversation: "stale previous turn",
        },
        data: {},
      };
      const before = structuredClone({ state, plannerContext });
      const { result, useModel } = await execute({
        actions,
        state,
        plannerContext,
        toolCall: {
          id: "read-evidence",
          name: "LEDGER",
          params: { action: "create", text: "hello" },
        },
      });
      expect(result.success).toBe(true);
      expect(useModel).not.toHaveBeenCalled();
      expect(states).toHaveLength(1);
      const evidence = states[0]?.values.selectedActionConversation;
      if (mode === "selected" || mode === "empty") {
        expect(typeof evidence).toBe("string");
        expect(JSON.parse(String(evidence))).toEqual(
          mode === "empty" ? [] : [plannerContext.events[0]],
        );
      } else expect(evidence).toBeNull();
      expect({ state, plannerContext }).toEqual(before);
      expect(states[0]).not.toBe(state);
    },
  );
});

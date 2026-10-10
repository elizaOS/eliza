/**
 * A nested planner sees only one umbrella's children. When a child reports a
 * missing capability (nothing ran and no sibling can run it now), the scope
 * returns to the parent planner, whose next round has its full tool surface
 * again.
 */

import type {
  Action,
  ActionResult,
  EvaluatorOutput,
  IAgentRuntime,
  Memory,
  State,
  ToolDefinition,
} from "@elizaos/core";
import {
  CORE_PLANNER_TERMINALS,
  createContextObject,
  promoteSubactionsToActions,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  buildV5ExecutorContext,
  subPlannerResultToPlannerToolResult,
} from "../services/message/planned-tool.ts";
import {
  type PlannerRuntime,
  type PlannerToolCall,
  runPlannerLoop,
} from "./planner-loop.ts";
import { runSubPlanner } from "./sub-planner.ts";

const RELEASES_URL = "https://example.test/releases";

const MISSING_BROWSER = {
  kind: "missing_capability",
  boundary: "capability",
  code: "BROWSER_UNAVAILABLE",
  retryable: false,
} as const;

function browserFamily(): { umbrella: Action; actions: Action[] } {
  const umbrella: Action = {
    name: "BROWSER",
    description: "Drive an interactive browser.",
    validate: async () => true,
    handler: async () => ({ success: true }),
    parameters: [
      {
        name: "action",
        description: "Browser operation.",
        required: false,
        schema: { type: "string", enum: ["navigate", "snapshot"] },
      },
      {
        name: "url",
        description: "Page URL.",
        required: false,
        schema: { type: "string" },
      },
    ],
  };
  return { umbrella, actions: [...promoteSubactionsToActions(umbrella)] };
}

const webFetchTool: ToolDefinition = {
  name: "WEB_FETCH",
  description: "Fetch one URL.",
  parameters: {
    type: "object",
    properties: { url: { type: "string" } },
    required: ["url"],
  },
};

const umbrellaTool: ToolDefinition = {
  name: "BROWSER",
  description: "Drive an interactive browser.",
  parameters: {
    type: "object",
    properties: { url: { type: "string" }, action: { type: "string" } },
  },
};

const message = {
  id: "message-id",
  entityId: "entity-id",
  roomId: "room-id",
  content: { text: "Check the releases page for the newest stable release." },
} as Memory;

function toolNames(params: unknown): string[] {
  const tools = (params as { tools?: Array<{ name?: string }> }).tools ?? [];
  return tools.map((tool) => tool.name ?? "");
}

function call(name: string, args: Record<string, unknown>, scope: string) {
  return {
    text: "",
    toolCalls: [
      {
        id: `${name}-call`,
        name,
        arguments: { ...args, eliza_turn_scope: scope },
      },
    ],
    usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
  };
}

const unavailable: ActionResult = {
  success: false,
  text: 'Browser action failed: No browser target is available for subaction "navigate".',
  failureProvenance: MISSING_BROWSER,
  values: { success: false, error: "UNAVAILABLE", fallbackSafe: true },
  data: {
    actionName: "BROWSER_NAVIGATE",
    dispatchFailure: { kind: "UNAVAILABLE", fallbackSafe: true },
  },
};

function harness() {
  const { umbrella, actions } = browserFamily();
  const surfaces: string[][] = [];
  const runtime = {
    actions,
    agentId: "00000000-0000-0000-0000-00000000b120",
    getService: vi.fn(() => undefined),
    getSetting: vi.fn(() => undefined),
    reportError: vi.fn(),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    useModel: vi.fn(async (_type: unknown, params: unknown) => {
      const names = toolNames(params);
      surfaces.push(names);
      // The parent's closing reply after an earlier failed step is a
      // tool-less synthesis round; it never re-enters a tool scope.
      if (names.length === 0) {
        return { text: "browser is unavailable here; fetched it instead." };
      }
      if (surfaces.length > 3) throw new Error("Unexpected extra model call");
      if (!names.includes("WEB_FETCH")) {
        return call(
          "BROWSER",
          { action: "navigate", url: RELEASES_URL },
          "more_work_pending",
        );
      }
      return surfaces.length === 1
        ? call("BROWSER", { url: RELEASES_URL }, "final")
        : call("WEB_FETCH", { url: RELEASES_URL }, "final");
    }),
  };
  const executorCtx = buildV5ExecutorContext({
    message,
    state: { values: {}, data: {}, text: "" } as State,
    selectedContexts: ["web"],
    senderRole: "OWNER",
    previousResults: [],
  });
  const childCalls: PlannerToolCall[] = [];
  // A nested evaluator that would keep planning after the failure.
  const subEvaluate = vi.fn(
    async (): Promise<EvaluatorOutput> => ({
      success: false,
      decision: "CONTINUE",
      thought: "The requested outcome has not been confirmed.",
    }),
  );
  const context = createContextObject({
    id: "sub-planner-capability-release",
    events: actions.map((action) => ({
      id: `tool:${action.name}`,
      type: "tool" as const,
      tool: { name: action.name, action },
    })),
  });
  const runUmbrella = async () =>
    subPlannerResultToPlannerToolResult(
      await runSubPlanner({
        runtime: runtime as unknown as IAgentRuntime & PlannerRuntime,
        action: umbrella,
        context,
        ctx: executorCtx,
        evaluate: subEvaluate,
        execute: async (_runtime, _ctx, toolCall) => {
          childCalls.push(structuredClone(toolCall));
          return unavailable;
        },
      }),
    );
  return { runtime, surfaces, childCalls, subEvaluate, runUmbrella };
}

describe("sub-planner scope release on a missing capability", () => {
  it("returns the failure to the parent, whose next round offers its own tools again", async () => {
    const { runtime, surfaces, childCalls, subEvaluate, runUmbrella } =
      harness();
    const parentEvaluate = vi.fn(
      async ({ trajectory }): Promise<EvaluatorOutput> =>
        trajectory.steps.at(-1)?.toolCall?.name === "WEB_FETCH"
          ? {
              success: true,
              decision: "FINISH",
              thought: "Fetched the releases page.",
              messageToUser: "newest stable is v2.0.0",
            }
          : {
              success: false,
              decision: "CONTINUE",
              thought: "The browser is unavailable; fetch the page instead.",
            },
    );
    const result = await runPlannerLoop({
      runtime: runtime as unknown as PlannerRuntime,
      context: { id: "parent-planner" },
      tools: [umbrellaTool, webFetchTool, ...CORE_PLANNER_TERMINALS],
      toolChoice: "required",
      evaluate: parentEvaluate,
      executeToolCall: async (toolCall) =>
        toolCall.name === "BROWSER"
          ? runUmbrella()
          : {
              success: true,
              text: "v2.0.0 Latest",
              data: { readOnlyOperation: true },
            },
    });

    // Parent, nested BROWSER scope, then the parent again with WEB_FETCH.
    expect(surfaces.filter((names) => names.length > 0)).toHaveLength(3);
    expect(surfaces[0]).toEqual(
      expect.arrayContaining(["BROWSER", "WEB_FETCH"]),
    );
    expect(surfaces[1]).toContain("BROWSER");
    expect(surfaces[1]).not.toContain("WEB_FETCH");
    expect(surfaces[2]).toEqual(
      expect.arrayContaining(["BROWSER", "WEB_FETCH"]),
    );

    expect(childCalls.map((child) => child.name)).toEqual(["BROWSER_NAVIGATE"]);
    expect(subEvaluate).not.toHaveBeenCalled();

    const [browserStep, fetchStep] = result.trajectory.steps;
    expect(browserStep?.toolCall?.name).toBe("BROWSER");
    expect(browserStep?.result?.success).toBe(false);
    expect(browserStep?.result?.userFacingText).toBeUndefined();
    expect(fetchStep?.toolCall?.name).toBe("WEB_FETCH");
    expect(fetchStep?.result?.success).toBe(true);
    expect(parentEvaluate.mock.calls[0]?.[0].hasUnresolvedToolFailure).toBe(
      true,
    );
  });
});

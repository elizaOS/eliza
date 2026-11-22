/**
 * RESTORE_CONTEXT was offered after REPLY only when something was deferred,
 * with a scope enum chosen per request. A prompt cache reads tool definitions
 * before the system prompt, so its coming and going was the only tool change
 * between about a tenth of consecutive planner requests in the context audit.
 * It is now one definition on every non-coding planner request with tools,
 * after discovery; a read that finds nothing deferred is answered once a turn.
 */
import type {
  Action,
  ContextEvent,
  ContextObject,
  ToolDefinition,
} from "@elizaos/core";
import { DISCOVER_ACTIONS_NAME } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proposeDeviceAction } from "../../services/device-actions/action.ts";
import {
  projectReviewedHistory,
  withBackgroundHistory,
} from "../../services/message/history-discovery.ts";
import { collectPlannerTools } from "../../services/message/planned-tool.ts";
import { createPlannerToolDiscoveryAction } from "../../services/message/tool-discovery.ts";
import { windowHistoryRetention } from "../history-retention.ts";
import { runPlannerLoop } from "../planner-loop.ts";

// A phone: no post-turn review, so no source review changes a domain tool.
beforeEach(() => vi.stubEnv("ELIZA_PLATFORM", "android"));
afterEach(() => vi.unstubAllEnvs());

const discovery = createPlannerToolDiscoveryAction([], () => {}, undefined, {
  deferNameIndex: true,
});
const calendar: Action = {
  name: "CALENDAR",
  description: "CALENDAR records.",
  parameters: [
    {
      name: "query",
      description: "What to find in CALENDAR.",
      required: false,
      schema: { type: "string" },
    },
  ],
  validate: async () => true,
  handler: async () => ({ success: true }),
};
const TOOLS = collectPlannerTools(
  {
    id: "planner-restore-context",
    events: [discovery, proposeDeviceAction, calendar].map((action) => ({
      id: `tool:${action.name}`,
      type: "tool",
      tool: { name: action.name, action },
    })),
  },
  undefined,
  { canonicalFamilies: true },
);

function dialogue(count: number): ContextEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `history:${index}`,
    type: "segment" as const,
    source: "prior-dialogue",
    segment: {
      id: `history:${index}`,
      label: index % 2 ? "prior_message:agent" : "prior_message:user",
      content: `long exchange ${index}: ${"detail ".repeat(40)}`,
      stable: false,
    },
  }));
}

/** One planner turn in the room: the prior dialogue, then the new request. */
function turn(messageId: string, events: ContextEvent[]): ContextObject {
  return {
    id: messageId,
    metadata: { roomId: "room", messageId },
    events: [
      ...events,
      {
        id: `${messageId}:request`,
        type: "message",
        message: {
          id: `${messageId}:request`,
          role: "user",
          content: "What is on my calendar Friday?",
        },
      },
    ],
  };
}

/** Earlier originals deferred by position, as Stage 1 hands a long turn over. */
function windowed(context: ContextObject): ContextObject {
  const scope = {
    agentId: "agent",
    roomId: "room",
    entityId: "owner",
    roles: ["OWNER"],
  };
  const window = windowHistoryRetention(context, scope, null);
  const history = projectReviewedHistory(context, scope, window.checkpoint);
  if (!history || !window.windowed) throw new Error("Missing window");
  history.windowed = true;
  return withBackgroundHistory(context, history);
}

/** A provider whose complete body is deferred behind its notice. */
function withDeferredProvider(context: ContextObject): ContextObject {
  return {
    ...context,
    metadata: { ...context.metadata, providerDiscoveryEnabled: true },
    events: [
      {
        id: "facts",
        type: "provider",
        name: "FACTS",
        text: "Complete provider facts retained in the original context.",
        discoveryText: "Facts available",
      },
      ...context.events,
    ],
  };
}

type Call = { name: string; arguments: Record<string, string> };
const restore = (scope: string): Call => ({
  name: "RESTORE_CONTEXT",
  arguments: { scope, reason: "A referent this request names is not shown" },
});
const reply: Call = {
  name: "REPLY",
  arguments: { text: "Done.", eliza_turn_scope: "final" },
};
const read: Call = {
  name: calendar.name,
  arguments: { query: "Friday", eliza_turn_scope: "more_work_pending" },
};

/** Runs one turn whose planner answers each request with the next calls. */
async function plannerTurn(
  context: ContextObject,
  answers: Call[][],
  options: { codingMode?: boolean } = {},
) {
  const requests: { tools: ToolDefinition[]; input: string }[] = [];
  const executed: string[] = [];
  const result = runPlannerLoop({
    runtime: {
      getService: () => null,
      useModel: async (_type: unknown, params: Record<string, unknown>) => {
        requests.push({
          tools: params.tools as ToolDefinition[],
          input: JSON.stringify(params.messages),
        });
        const calls = answers[requests.length - 1];
        if (!calls) throw new Error("Unexpected planner request");
        return {
          text: "",
          toolCalls: calls.map((call, index) => ({ id: `c${index}`, ...call })),
        };
      },
    },
    context,
    tools: TOOLS,
    ...(options.codingMode ? { codingMode: true } : {}),
    executeToolCall: async (call) => {
      executed.push(call.name ?? "");
      return { success: true, text: "Friday: lunch with Sam." };
    },
    evaluate: async () => ({
      success: false,
      decision: "CONTINUE",
      thought: "The read still needs a reply.",
    }),
  });
  return { result, requests, executed };
}

const names = (tools: readonly ToolDefinition[]) =>
  tools.map((tool) => tool.name);
const restoreTool = (tools: readonly ToolDefinition[]) =>
  JSON.stringify(tools.filter((tool) => tool.name === "RESTORE_CONTEXT"));

describe("RESTORE_CONTEXT on the planner's tool list", () => {
  it("is one definition right after discovery on every planner request in a room, and REPLY stays last", async () => {
    const turns = [
      // Nothing deferred: no notice names a scope.
      await plannerTurn(turn("turn-1", dialogue(4)), [[reply]]),
      // A deferred provider, restored and then answered.
      await plannerTurn(withDeferredProvider(turn("turn-2", dialogue(4))), [
        [restore("providers")],
        [reply],
      ]),
      // Earlier dialogue deferred by position, then a domain read.
      await plannerTurn(windowed(turn("turn-3", dialogue(44))), [
        [read],
        [reply],
      ]),
    ];
    for (const { result } of turns) await result;
    const [nothing, providers, history] = turns.map(({ requests }) => requests);
    expect(
      [nothing, providers, history].map((requests) => requests?.length),
    ).toEqual([1, 2, 2]);
    expect(nothing?.[0]?.input).not.toContain("RESTORE_CONTEXT");
    expect(providers?.[0]?.input).toContain(
      "call RESTORE_CONTEXT alone with scope=providers",
    );
    expect(providers?.[1]?.input).toContain("Complete provider facts retained");
    expect(history?.[0]?.input).toContain(
      "call RESTORE_CONTEXT alone with scope=history",
    );

    const requests = turns.flatMap(({ requests }) => requests);
    const first = requests[0]?.tools ?? [];
    const at = names(first).indexOf("RESTORE_CONTEXT");
    expect(names(first).slice(0, at + 2)).toEqual([
      "IGNORE",
      "STOP",
      DISCOVER_ACTIONS_NAME,
      "RESTORE_CONTEXT",
      proposeDeviceAction.name,
    ]);
    expect(
      JSON.parse(restoreTool(first))[0].parameters.properties.scope.enum,
    ).toEqual(["history", "providers", "full"]);
    for (const { tools } of requests) {
      expect(names(tools).filter((name) => name === "RESTORE_CONTEXT")).toEqual(
        ["RESTORE_CONTEXT"],
      );
      expect(names(tools).indexOf("RESTORE_CONTEXT")).toBe(at);
      expect(names(tools).at(-1)).toBe("REPLY");
      // Everything through the device tool is the same bytes on every request.
      expect(JSON.stringify(tools.slice(0, at + 2))).toBe(
        JSON.stringify(first.slice(0, at + 2)),
      );
    }
  });

  it("is not offered in coding mode, where a restore is still rejected", async () => {
    const { result, requests, executed } = await plannerTurn(
      windowed(turn("turn-1", dialogue(44))),
      [[restore("history")]],
      { codingMode: true },
    );
    await expect(result).rejects.toMatchObject({
      code: "PLANNER_CONTEXT_RESTORE_INVALID",
    });
    expect(requests).toHaveLength(1);
    expect(names(requests[0]?.tools ?? [])).not.toContain("RESTORE_CONTEXT");
    expect(executed).toEqual([]);
  });
});

describe("a restore that finds nothing deferred", () => {
  it("answers a scope with nothing deferred once, then rejects the next one", async () => {
    // Only earlier dialogue is deferred; the read asks for providers.
    const { result, requests, executed } = await plannerTurn(
      windowed(turn("turn-1", dialogue(44))),
      [[restore("providers"), read], [restore("providers")]],
    );
    await expect(result).rejects.toMatchObject({
      code: "PLANNER_CONTEXT_RESTORE_INVALID",
    });
    expect(requests).toHaveLength(2);
    expect(executed).toEqual([]);
    const [first, second] = requests;
    expect(first?.input).not.toContain("nothing deferred for that scope");
    expect(second?.input).toContain(
      "Requested context restore (providers): nothing deferred for that scope. No tool from that response executed.",
    );
    // History is still deferred and still named as restorable.
    expect(second?.input).toContain("deferred by position");
    expect(restoreTool(second?.tools ?? [])).toBe(
      restoreTool(first?.tools ?? []),
    );
  });

  it("answers a repeated restore once and lets the turn finish", async () => {
    const { result, requests, executed } = await plannerTurn(
      windowed(turn("turn-1", dialogue(44))),
      [[restore("history")], [restore("history")], [reply]],
    );
    expect((await result).finalMessage).toBe("Done.");
    expect(requests).toHaveLength(3);
    expect(executed).toEqual([]);
    expect(requests[1]?.input).toContain("Requested context restored: history");
    expect(requests[1]?.input).not.toContain("deferred by position");
    expect(requests[2]?.input).toContain(
      "Requested context restore (history): nothing deferred for that scope.",
    );
  });

  it("stops a planner that keeps restoring after one answer", async () => {
    // Both scopes are deferred: one full read restores them, the repeat is
    // answered, and the next repeat is rejected instead of replanned again.
    const { result, requests, executed } = await plannerTurn(
      withDeferredProvider(windowed(turn("turn-1", dialogue(44)))),
      Array.from({ length: 10 }, () => [restore("full")]),
    );
    await expect(result).rejects.toMatchObject({
      code: "PLANNER_CONTEXT_RESTORE_INVALID",
    });
    expect(requests).toHaveLength(3);
    expect(executed).toEqual([]);
    expect(requests[1]?.input).toContain("Requested context restored: full");
    expect(requests[2]?.input).toContain(
      "Requested context restore (full): nothing deferred for that scope.",
    );
  });
});

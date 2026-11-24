/**
 * RESTORE_CONTEXT is the last tool a planner request carries, and a prompt
 * cache reads tool definitions first: a definition that depended on what is
 * deferred would send the system prompt and the history behind it uncached
 * whenever that changed. So it is one definition on every planner call that
 * offers tools, and a call with nothing to restore is answered instead of
 * failing the turn.
 */
import type {
  ContextEvent,
  ContextObject,
  ToolDefinition,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  projectReviewedHistory,
  withBackgroundHistory,
} from "../../services/message/history-discovery.ts";
import { windowHistoryRetention } from "../history-retention.ts";
import { runPlannerLoop } from "../planner-loop.ts";

// A phone: earlier messages are deferred by position, with no reviewer.
beforeEach(() => vi.stubEnv("ELIZA_PLATFORM", "android"));
afterEach(() => vi.unstubAllEnvs());

const RESTORE = "RESTORE_CONTEXT";
const READ: ToolDefinition = {
  name: "READ",
  description: "Read a record.",
  parameters: { type: "object", properties: {} },
};
const REPLY: ToolDefinition = {
  name: "REPLY",
  description: "Reply to the user.",
  parameters: { type: "object", properties: { text: { type: "string" } } },
};

const dialogue = (count: number): ContextEvent[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `history:${index}`,
    type: "segment" as const,
    source: "prior-dialogue",
    segment: {
      id: `history:${index}`,
      label: index % 2 ? "prior_message:agent" : "prior_message:user",
      content: `exchange ${index}: ${"detail ".repeat(40)}`,
      stable: false,
    },
  }));

/** One planner turn in the room: the prior dialogue, then the new request. */
function turn(count: number, metadata: ContextObject["metadata"] = {}) {
  return {
    id: "turn",
    metadata: { roomId: "room", messageId: "turn", ...metadata },
    events: [
      ...dialogue(count),
      {
        id: "turn:request",
        type: "message" as const,
        message: {
          id: "turn:request",
          role: "user" as const,
          content: "What did we decide?",
        },
      },
    ],
  } satisfies ContextObject;
}

/** The same turn as Stage 1 hands it over: early messages deferred by position. */
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

type Request = { tools?: ToolDefinition[]; input: string };
type Reply = { name: string; arguments: Record<string, unknown> };
const reply: Reply = {
  name: "REPLY",
  arguments: { text: "We settled on Friday.", eliza_turn_scope: "final" },
};
const read: Reply = {
  name: "READ",
  arguments: { eliza_turn_scope: "more_work_pending" },
};
const restore = (scope?: string): Reply => ({
  name: RESTORE,
  arguments: { reason: "Find the decision.", ...(scope ? { scope } : {}) },
});

async function plan(
  context: ContextObject,
  rounds: Reply[],
  options: { tools?: ToolDefinition[]; codingMode?: boolean } = {},
) {
  const requests: Request[] = [];
  let executed = 0;
  const result = await runPlannerLoop({
    runtime: {
      useModel: async (_type: unknown, params: Record<string, unknown>) => {
        requests.push({
          tools: params.tools as ToolDefinition[] | undefined,
          input: JSON.stringify(params.messages),
        });
        const round = rounds[requests.length - 1];
        if (!round) throw new Error("Unexpected planner call");
        return {
          text: "",
          toolCalls: [{ id: `call-${requests.length}`, ...round }],
        };
      },
    },
    context,
    ...("tools" in options
      ? { tools: options.tools }
      : { tools: [READ, REPLY] }),
    ...(options.codingMode ? { codingMode: true } : {}),
    executeToolCall: async () => {
      executed++;
      return { success: true, text: "Read." };
    },
    evaluate: async () => ({
      success: true,
      decision: "FINISH",
      thought: "Replied.",
      messageToUser: "We settled on Friday.",
    }),
  });
  return { result, requests, executed };
}

const restoreTool = (request: Request) =>
  request.tools?.find((tool) => tool.name === RESTORE);

describe("the context-restore tool on a planner request", () => {
  it("has the same bytes with nothing deferred and with deferred history", async () => {
    const whole = await plan(turn(6), [reply]);
    const deferred = await plan(windowed(turn(44)), [reply]);
    expect(whole.requests[0].input).not.toContain("deferred by position");
    expect(deferred.requests[0].input).toContain("deferred by position");

    const offered = restoreTool(deferred.requests[0]);
    expect(offered?.parameters?.properties?.scope).toEqual({
      type: "string",
      enum: ["history", "providers", "full"],
    });
    expect(JSON.stringify(restoreTool(whole.requests[0]))).toBe(
      JSON.stringify(offered),
    );
    // It stays last, so the whole list is the same on both turns.
    expect(whole.requests[0].tools?.at(-1)?.name).toBe(RESTORE);
    expect(JSON.stringify(whole.requests[0].tools)).toBe(
      JSON.stringify(deferred.requests[0].tools),
    );
  });

  it("keeps the same bytes after the history was restored", async () => {
    const { requests, executed } = await plan(windowed(turn(44)), [
      restore("history"),
      reply,
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[0].input).not.toContain("exchange 2:");
    expect(requests[1].input).toContain("exchange 2:");
    expect(requests[1].input).toContain("Requested context restored: history");
    expect(JSON.stringify(requests[1].tools)).toBe(
      JSON.stringify(requests[0].tools),
    );
    expect(restoreTool(requests[1])).toBeDefined();
    expect(executed).toBe(0);
  });

  it("offers a sub-planner the same definition, deferred history or not", async () => {
    const parent = await plan(turn(6), [reply]);
    expect(restoreTool(parent.requests[0])).toBeDefined();
    const nested = { subPlannerParentAction: "CALENDAR" };
    for (const context of [turn(6, nested), windowed(turn(44, nested))]) {
      const child = await plan(context, [reply]);
      expect(JSON.stringify(restoreTool(child.requests[0]))).toBe(
        JSON.stringify(restoreTool(parent.requests[0])),
      );
    }
  });

  it("is not offered in coding mode, where nothing is ever deferred", async () => {
    const { requests } = await plan(windowed(turn(44)), [read, reply], {
      codingMode: true,
    });
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.tools?.map((tool) => tool.name)).toEqual([
        "READ",
        "REPLY",
      ]);
      expect(request.input).toContain("exchange 2:");
    }
  });

  it("is not offered on a request that offers no tools", async () => {
    const { requests } = await plan(turn(6), [reply], { tools: undefined });
    expect(requests[0].tools).toBeUndefined();
  });
});

describe("a context-restore call with nothing deferred", () => {
  it("is answered plainly and the turn goes on", async () => {
    const { result, requests, executed } = await plan(turn(6), [
      restore("history"),
      reply,
    ]);
    expect(requests).toHaveLength(2);
    // The answer follows everything the first request sent.
    expect(requests[1].input.startsWith(requests[0].input.slice(0, -1))).toBe(
      true,
    );
    expect(requests[1].input.slice(requests[0].input.length - 1)).toContain(
      "RESTORE_CONTEXT found nothing deferred",
    );
    expect(JSON.stringify(requests[1].tools)).toBe(
      JSON.stringify(requests[0].tools),
    );
    expect(executed).toBe(0);
    expect(result.status).toBe("finished");
    expect(result.terminalFailure).toBeUndefined();
    expect(result.finalMessage).toBe("We settled on Friday.");
  });

  it("names the scope that still has something deferred", async () => {
    const { requests } = await plan(windowed(turn(44)), [
      restore("providers"),
      restore("history"),
      reply,
    ]);
    expect(requests).toHaveLength(3);
    expect(requests[1].input).toContain("Only scope=history is deferred.");
    expect(requests[1].input).not.toContain("exchange 2:");
    // The named scope is then restored as usual.
    expect(requests[2].input).toContain("exchange 2:");
  });

  it("is refused when the model asks again after that answer", async () => {
    await expect(
      plan(turn(6), [restore(), restore(), reply]),
    ).rejects.toMatchObject({ code: "PLANNER_CONTEXT_RESTORE_INVALID" });
  });
});

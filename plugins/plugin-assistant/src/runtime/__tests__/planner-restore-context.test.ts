/**
 * RESTORE_CONTEXT was offered after REPLY only when something was deferred,
 * with a scope enum chosen per request. A prompt cache reads tool definitions
 * before the system prompt, so its coming and going was the only tool change
 * between about a tenth of consecutive planner requests in the context audit.
 * It is now one definition on every non-coding planner request with tools,
 * after discovery. A restore that finds nothing deferred, or that the Cloud
 * route's non-strict decoding let through without a reason or with a scope
 * outside the enum, is answered once per planner round, after the settled
 * steps.
 */
import type {
  Action,
  ContextEvent,
  ContextObject,
  ContextProviderEvent,
  ToolDefinition,
} from "@elizaos/core";
import {
  DISCOVER_ACTIONS_NAME,
  OWNED_CONTEXT_SOURCE_SCOPE,
} from "@elizaos/core";
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
const plannerTools = (actions: Action[]) =>
  collectPlannerTools(
    {
      id: "planner-restore-context",
      events: actions.map((action) => ({
        id: `tool:${action.name}`,
        type: "tool",
        tool: { name: action.name, action },
      })),
    },
    undefined,
    { canonicalFamilies: true },
  );
const TOOLS = plannerTools([discovery, proposeDeviceAction, calendar]);

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
const restoreWith = (args: Record<string, string>): Call => ({
  name: "RESTORE_CONTEXT",
  arguments: args,
});
const restore = (scope: string): Call =>
  restoreWith({ scope, reason: "A referent this request names is not shown" });
const reply: Call = {
  name: "REPLY",
  arguments: { text: "Done.", eliza_turn_scope: "final" },
};
const read: Call = {
  name: calendar.name,
  arguments: { query: "Friday", eliza_turn_scope: "more_work_pending" },
};

/** Runs one turn whose planner answers each request with the next calls. A
 * reply-only turn starts from a settled read and offers no tools; a turn
 * without tools offers none either. Both answer in the JSON envelope. */
async function plannerTurn(
  context: ContextObject,
  answers: Call[][],
  options: {
    codingMode?: boolean;
    replyOnly?: boolean;
    noTools?: boolean;
    tools?: ToolDefinition[];
  } = {},
) {
  const requests: {
    tools: ToolDefinition[];
    input: string;
    /** Each message's bytes as sent. */
    messages: string[];
  }[] = [];
  const executed: string[] = [];
  const result = runPlannerLoop({
    runtime: {
      getService: () => null,
      useModel: async (_type: unknown, params: Record<string, unknown>) => {
        const messages = params.messages as unknown[];
        requests.push({
          tools: params.tools as ToolDefinition[],
          input: JSON.stringify(messages),
          messages: messages.map((message) => JSON.stringify(message)),
        });
        const calls = answers[requests.length - 1];
        if (!calls) throw new Error("Unexpected planner request");
        if (options.replyOnly || options.noTools)
          return JSON.stringify({
            thought: "Answer from the settled read.",
            completed: false,
            toolCalls: calls.map((call) => ({
              name: call.name,
              params: call.arguments,
            })),
            messageToUser: "",
          });
        return {
          text: "",
          toolCalls: calls.map((call, index) => ({ id: `c${index}`, ...call })),
        };
      },
    },
    context,
    ...(options.replyOnly
      ? {
          postToolReplySeed: {
            toolCall: { name: calendar.name },
            result: {
              success: true,
              modelReplyRequired: true,
              text: "Friday: lunch with Sam.",
            },
          },
        }
      : options.noTools
        ? {}
        : { tools: options.tools ?? TOOLS }),
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
    const [definition] = JSON.parse(restoreTool(first));
    expect(definition.parameters.properties.scope.enum).toEqual([
      "history",
      "providers",
      "full",
    ]);
    // The enum no longer says what is deferred; the notices do.
    expect(definition.description).toContain(
      "Only context a notice in this request names as deferred can be restored: scope=history for earlier dialogue and retrieval diagnostics, scope=providers for provider references, scope=full (default) for all of it. Without such a notice nothing is deferred; do not call it.",
    );
    // One unflagged tool makes a direct Cerebras request non-strict for every
    // tool, and this one is now on every request.
    expect(definition.strict).toBe(true);
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

  it("stays ahead of REPLY when a request has neither the device tool nor a domain tool", async () => {
    // Discovery alone: what a request offers before a domain tool is loaded
    // on a host without the device tool.
    const { result, requests } = await plannerTurn(
      turn("turn-1", dialogue(4)),
      [[reply]],
      { tools: plannerTools([discovery]) },
    );
    expect((await result).finalMessage).toBe("Done.");
    expect(names(requests[0]?.tools ?? [])).toEqual([
      "IGNORE",
      "STOP",
      DISCOVER_ACTIONS_NAME,
      "RESTORE_CONTEXT",
      "REPLY",
    ]);
  });

  it.each([
    [
      "deferred history",
      windowed(turn("turn-1", dialogue(44))),
      restore("history"),
    ],
    ["nothing deferred", turn("turn-1", dialogue(4)), restore("history")],
    [
      "a scope outside the enum",
      turn("turn-1", dialogue(4)),
      restoreWith({ scope: "dialogue", reason: "Earlier turns are needed" }),
    ],
  ])(
    "is not offered in coding mode, where a restore with %s is still rejected at once",
    async (_label, context, call) => {
      const { result, requests, executed } = await plannerTurn(
        context,
        [[call], [call]],
        { codingMode: true },
      );
      await expect(result).rejects.toMatchObject({
        code: "PLANNER_CONTEXT_RESTORE_INVALID",
      });
      expect(requests).toHaveLength(1);
      expect(names(requests[0]?.tools ?? [])).not.toContain("RESTORE_CONTEXT");
      expect(executed).toEqual([]);
    },
  );
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

  it("answers a history restore once when only a provider body is deferred, then rejects the next one", async () => {
    // A history restore consumes no provider state: were it treated as a
    // restore here, every repeat would replan again without bound.
    const { result, requests, executed } = await plannerTurn(
      withDeferredProvider(turn("turn-1", dialogue(4))),
      [[restore("history")], [restore("history")]],
    );
    await expect(result).rejects.toMatchObject({
      code: "PLANNER_CONTEXT_RESTORE_INVALID",
    });
    expect(requests).toHaveLength(2);
    expect(executed).toEqual([]);
    const second = requests[1]?.input ?? "";
    expect(second).toContain(
      "Requested context restore (history): nothing deferred for that scope.",
    );
    // The provider body is still deferred and still named as restorable.
    expect(second).toContain("call RESTORE_CONTEXT alone with scope=providers");
    expect(second).not.toContain("Complete provider facts retained");
  });

  it("restores an owned source that cannot be deferred before an operation outside its scope", async () => {
    // A stale or rebound active view: its owner admits only its own action,
    // and its body cannot be deferred, so nothing names it as deferred.
    const base = turn("turn-1", dialogue(4));
    const view: ContextProviderEvent = {
      id: "active-view:turn-1",
      type: "provider",
      source: "host:active-view",
      name: "ACTIVE_VIEW_SNAPSHOT",
      text: "Active view: Friday agenda with its controls.",
      discoveryText: "Active view: Friday agenda.",
      discoveryRequiresRuntimeBinding: true,
      [OWNED_CONTEXT_SOURCE_SCOPE]: {
        actionNames: ["BRIEF"],
        canDefer: () => false,
      },
    };
    const { result, requests, executed } = await plannerTurn(
      {
        ...base,
        metadata: { ...base.metadata, providerDiscoveryEnabled: true },
        events: [view, ...base.events],
      },
      [[read], [read], [reply]],
    );
    expect((await result).finalMessage).toBe("Done.");
    expect(requests).toHaveLength(3);
    // The first read is replaced by the forced provider restore; the replan
    // runs it once.
    expect(executed).toEqual([calendar.name]);
    expect(requests[1]?.input).toContain(
      "Requested context restored: providers.",
    );
    expect(requests[1]?.input).not.toContain("nothing deferred for that scope");
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

describe("the notice after a restore", () => {
  // The notice stays in the base context for the rest of the turn, so it says
  // nothing about what is still deferred; the request's own notices, rendered
  // from the current context each round, say that. Before, it said other
  // deferred references remained whatever was left, next to a tool that is
  // now always offered.
  const restored = (scope: string) =>
    `Requested context restored: ${scope}. No tool from the restoration response executed. Use the restored sources and existing settled receipts; do not repeat completed effects. Restore more only if a notice in this request names it as deferred.`;
  const historyNotice = "deferred by position";
  const providersNotice = "call RESTORE_CONTEXT alone with scope=providers";
  const cases: [string, ContextObject, string, string[]][] = [
    [
      "the only deferred provider",
      withDeferredProvider(turn("turn-1", dialogue(4))),
      "providers",
      [],
    ],
    [
      "the only deferred history",
      windowed(turn("turn-1", dialogue(44))),
      "history",
      [],
    ],
    [
      "both scopes at once",
      withDeferredProvider(windowed(turn("turn-1", dialogue(44)))),
      "full",
      [],
    ],
    [
      "providers while history stays deferred",
      withDeferredProvider(windowed(turn("turn-1", dialogue(44)))),
      "providers",
      [historyNotice],
    ],
    [
      "history while a provider stays deferred",
      withDeferredProvider(windowed(turn("turn-1", dialogue(44)))),
      "history",
      [providersNotice],
    ],
  ];
  it.each(cases)(
    "after restoring %s, leaves what remains to the request's own notices",
    async (_label, context, scope, remaining) => {
      const { result, requests, executed } = await plannerTurn(context, [
        [restore(scope)],
        [reply],
      ]);
      expect((await result).finalMessage).toBe("Done.");
      expect(requests).toHaveLength(2);
      expect(executed).toEqual([]);
      const replan = requests[1]?.input ?? "";
      expect(replan).toContain(restored(scope));
      expect(replan).not.toContain("remain available if needed");
      for (const notice of [historyNotice, providersNotice]) {
        if (remaining.includes(notice)) expect(replan).toContain(notice);
        else expect(replan).not.toContain(notice);
      }
    },
  );

  it("stays true after a second restore clears what the first left deferred", async () => {
    const { result, requests, executed } = await plannerTurn(
      withDeferredProvider(windowed(turn("turn-1", dialogue(44)))),
      [[restore("history")], [restore("providers")], [reply]],
    );
    expect((await result).finalMessage).toBe("Done.");
    expect(requests).toHaveLength(3);
    expect(executed).toEqual([]);
    expect(requests[1]?.input).toContain(providersNotice);
    const last = requests[2]?.input ?? "";
    expect(last).toContain(restored("history"));
    expect(last).toContain(restored("providers"));
    expect(last).toContain("Complete provider facts retained");
    expect(last).not.toContain(historyNotice);
    expect(last).not.toContain(providersNotice);
  });
});

describe("the answer is bounded per planner round", () => {
  it("answers a spurious restore again in a later round, after an effect ran", async () => {
    const { result, requests, executed } = await plannerTurn(
      turn("turn-1", dialogue(4)),
      [[restore("history")], [read], [restore("providers")], [reply]],
    );
    const output = await result;
    expect(output.finalMessage).toBe("Done.");
    expect(requests).toHaveLength(4);
    expect(executed).toEqual([calendar.name]);
    // One notice per round, each under its own event id, each rendered once.
    const answers = (context?: ContextObject) =>
      (context?.events ?? [])
        .filter((event) => event.id.startsWith("planner-context-restore-empty"))
        .map((event) => event.id);
    expect(answers(output.trajectory.context)).toEqual([
      "planner-context-restore-empty:1",
      "planner-context-restore-empty:2",
    ]);
    // Nothing deferred changed, so the answers stay out of the base context.
    expect(answers(output.trajectory.modelBaseContext)).toEqual([]);
    const last = requests[3]?.input ?? "";
    for (const scope of ["history", "providers"])
      expect(
        last.split(
          `Requested context restore (${scope}): nothing deferred for that scope.`,
        ),
      ).toHaveLength(2);
    expect(restoreTool(requests[3]?.tools ?? [])).toBe(
      restoreTool(requests[0]?.tools ?? []),
    );
  });

  it("still rejects a second spurious restore in the same later round", async () => {
    const { result, requests, executed } = await plannerTurn(
      turn("turn-1", dialogue(4)),
      [[restore("history")], [read], [restore("providers")], [restore("full")]],
    );
    await expect(result).rejects.toMatchObject({
      code: "PLANNER_CONTEXT_RESTORE_INVALID",
    });
    expect(requests).toHaveLength(4);
    expect(executed).toEqual([calendar.name]);
  });

  it("follows the settled steps, so the replan extends the request before it", async () => {
    // A prompt cache reuses only an unchanged prefix. An answer ahead of the
    // settled read would make the replan re-read the read and its result.
    const { result, requests, executed } = await plannerTurn(
      turn("turn-1", dialogue(4)),
      [[read], [restore("history")], [reply]],
    );
    expect((await result).finalMessage).toBe("Done.");
    expect(executed).toEqual([calendar.name]);
    const [, before, replan] = requests.map(({ messages }) => messages);
    expect(before?.some((message) => message.includes("Friday: lunch"))).toBe(
      true,
    );
    expect(replan?.slice(0, before?.length)).toEqual(before);
    expect(replan?.slice(before?.length ?? 0).join("")).toContain(
      "Requested context restore (history): nothing deferred for that scope.",
    );
  });
});

describe("a restore the Cloud route's non-strict decoding let through", () => {
  const invalid = "Requested context restore was not valid:";

  const outsideEnum = restoreWith({
    scope: "dialogue",
    reason: "Earlier turns are needed",
  });
  it.each([
    ["a blank reason", [restoreWith({ scope: "history", reason: "  " })]],
    ["no reason", [restoreWith({ scope: "full" })]],
    ["a scope outside the enum", [outsideEnum]],
    // Several restores in one response are one restoration: one invalid call
    // makes all of it invalid.
    [
      "a valid call and a scope outside the enum",
      [restore("history"), outsideEnum],
    ],
    [
      "a valid call and a blank reason",
      [restore("history"), restoreWith({ scope: "history", reason: " " })],
    ],
  ])(
    "answers a restore with %s once, then rejects a repeat in the same round",
    async (_label, calls) => {
      const { result, requests, executed } = await plannerTurn(
        turn("turn-1", dialogue(4)),
        [[...calls, read], calls],
      );
      await expect(result).rejects.toMatchObject({
        code: "PLANNER_CONTEXT_RESTORE_INVALID",
      });
      expect(requests).toHaveLength(2);
      expect(executed).toEqual([]);
      expect(requests[0]?.input).not.toContain(invalid);
      expect(requests[1]?.input).toContain(
        `${invalid} a restore names scope history, providers or full and gives a nonempty reason. No tool from that response executed. Nothing is deferred unless a notice in this request names it as deferred`,
      );
      expect(restoreTool(requests[1]?.tools ?? [])).toBe(
        restoreTool(requests[0]?.tools ?? []),
      );
    },
  );

  it("lets a corrected restore through after the answer", async () => {
    const { result, requests, executed } = await plannerTurn(
      windowed(turn("turn-1", dialogue(44))),
      [
        [restoreWith({ scope: "history", reason: " " })],
        [restore("history")],
        [reply],
      ],
    );
    expect((await result).finalMessage).toBe("Done.");
    expect(requests).toHaveLength(3);
    expect(executed).toEqual([]);
    expect(requests[1]?.input).toContain(invalid);
    expect(requests[1]?.input).toContain("deferred by position");
    expect(requests[2]?.input).toContain("Requested context restored: history");
  });

  it("counts that answer toward the round after the corrected restore", async () => {
    const { result, requests, executed } = await plannerTurn(
      windowed(turn("turn-1", dialogue(44))),
      [
        [restoreWith({ scope: "history", reason: " " })],
        [restore("history")],
        [restore("history")],
      ],
    );
    await expect(result).rejects.toMatchObject({
      code: "PLANNER_CONTEXT_RESTORE_INVALID",
    });
    expect(requests).toHaveLength(3);
    expect(executed).toEqual([]);
    expect(requests[2]?.input).toContain("Requested context restored: history");
  });
});

describe("a round that offers no restore tool", () => {
  const replyOnly = { replyOnly: true };
  const noTools = { noTools: true };
  const nothing = turn("turn-1", dialogue(4));
  it.each([
    [
      "a reply-only round",
      "nothing deferred",
      replyOnly,
      nothing,
      restore("history"),
    ],
    [
      "a reply-only round",
      "a blank reason",
      replyOnly,
      nothing,
      restoreWith({ scope: "history", reason: " " }),
    ],
    [
      "a reply-only round",
      "a scope outside the enum",
      replyOnly,
      nothing,
      restoreWith({ scope: "dialogue", reason: "Earlier turns are needed" }),
    ],
    [
      "a round without tools",
      "nothing deferred",
      noTools,
      nothing,
      restore("history"),
    ],
    // A round without tools projects nothing, so even windowed history was
    // never hidden from it.
    [
      "a round without tools",
      "deferred history",
      noTools,
      windowed(turn("turn-1", dialogue(44))),
      restore("history"),
    ],
  ])(
    "in %s, rejects a restore with %s after one request",
    async (_round, _label, options, context, call) => {
      const { result, requests, executed } = await plannerTurn(
        context,
        [[call], [call]],
        options,
      );
      await expect(result).rejects.toMatchObject({
        code: "PLANNER_CONTEXT_RESTORE_INVALID",
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.tools).toBeUndefined();
      expect(executed).toEqual([]);
    },
  );
});

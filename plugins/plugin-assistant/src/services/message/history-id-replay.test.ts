/** Replays the 2026-10-18 Discord turns whose READ_CONTEXT calls used the bare
 * hN IDs the runtime prints. Bound IDs read as history:hN; unbound IDs still
 * fail closed. Recorded tool calls only; no model is called. */
import {
  ChannelType,
  ContextRegistry,
  completionContextSources,
  type IAgentRuntime,
  type Memory,
  ResponseHandlerFieldRegistry,
  type State,
  type UUID,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS } from "../../runtime/builtin-field-evaluators.ts";
import {
  applyHistoryRetentionReview,
  prepareHistoryRetention,
} from "../../runtime/history-retention.ts";
import {
  HISTORY_RETENTION_EVALUATOR,
  historyRetentionEvaluator,
} from "../history-retention.ts";
import { resolveStage1SenderRole } from "./addressing.ts";
import { createV5MessageContextObject } from "./context-assembly.ts";
import {
  historyReferenceNotice,
  loadedHistorySegments,
  loadHistoryReferences,
  projectReviewedHistory,
  readHistoryContextRequests,
} from "./history-discovery.ts";
import { runV5MessageRuntimeStage1 } from "./pipeline.ts";

const agentId = "00000000-0000-4000-8000-000000000003" as UUID;
const userId = "00000000-0000-4000-8000-000000000002" as UUID;
const roomId = "00000000-0000-4000-8000-000000000004" as UUID;
const IMAGE_REPLY = "here's your image.";
// The live room had 551 earlier messages; keep every recorded ID bound.
const prior: Memory[] = Array.from({ length: 551 }, (_, i) => {
  const agent = i % 2 === 1;
  return {
    id: `00000000-0000-4000-9000-${String(i + 1).padStart(12, "0")}` as UUID,
    entityId: agent ? agentId : userId,
    agentId,
    roomId,
    createdAt: 1_000 + i,
    content: {
      text: [540, 549, 550].includes(i)
        ? IMAGE_REPLY
        : `${agent ? "reply" : "message"} ${i + 1}`,
      source: "discord",
    },
  };
});
const message: Memory = {
  id: "00000000-0000-4000-8000-000000000001" as UUID,
  entityId: userId,
  agentId,
  roomId,
  content: {
    text: "can you try to find and pull those yourself",
    source: "discord",
    channelType: ChannelType.DM,
  },
  createdAt: 10_000,
};
const state = (): State => ({
  values: {},
  text: "",
  data: {
    providers: { RECENT_MESSAGES: { data: { recentMessages: prior } } },
  },
});

const read = (contextRequests: string[]) => ({
  text: "",
  toolCalls: [{ name: "READ_CONTEXT", arguments: { contextRequests } }],
});
const handle = (args: Record<string, unknown>) => ({
  text: "",
  toolCalls: [
    {
      name: "HANDLE_RESPONSE",
      arguments: {
        shouldRespond: "RESPOND",
        contexts: ["general"],
        contextRequests: [],
        intents: [],
        replyText: "",
        replyEffectStatus: "pending",
        facts: [],
        relationships: [],
        topics: [],
        addressedTo: [],
        emotion: "none",
        ...args,
      },
    },
  ],
});
// Recorded call 0 of step-1792348054626-32b4qi.
const pullLogs = {
  contexts: ["agent_internal"],
  contextRequests: ["h156"],
  intents: [
    "Find and inspect the local Eliza runtime/trace logs from the Discord channel around 2026-10-18 11:27 PDT covering h156 to identify whether image-generation tool calls fired, their payloads, and why the attachment metadata mismatched my 'no image gen' statements",
  ],
  replyText: [],
  addressedTo: ["Sam"],
};

async function fixture(responses: unknown[]) {
  const fields = new ResponseHandlerFieldRegistry();
  for (const field of BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS)
    fields.register(field);
  const useModel = vi.fn(async () => {
    if (!responses.length) throw new Error("Unbounded model retry");
    return responses.shift();
  });
  const runtime = {
    agentId,
    character: { name: "Eliza", system: "Answer.", bio: "" },
    contexts: new ContextRegistry([
      { id: "general", description: "General tasks" },
      { id: "agent_internal", description: "Agent runtime internals" },
    ]),
    actions: [],
    providers: [],
    evaluators: [historyRetentionEvaluator],
    getService: vi.fn(() => null),
    getRoom: vi.fn(async () => null),
    getModelRegistrations: vi.fn(() => []),
    getSetting: vi.fn(),
    getCache: vi.fn(),
    composeState: vi.fn(async () => state()),
    useModel,
    runActionsByMode: vi.fn(async () => undefined),
    emitEvent: vi.fn(async () => undefined),
    reportError: vi.fn(),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      trace: vi.fn(),
    },
    responseHandlerFieldRegistry: fields,
    responseHandlerFieldEvaluators: [
      ...BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS,
    ],
    responseHandlerEvaluators: [],
  } as unknown as IAgentRuntime;
  // The background review deferred everything except the latest exchange.
  const context = await createV5MessageContextObject({
    runtime,
    message,
    state: state(),
  });
  const scope = {
    agentId,
    roomId,
    entityId: userId,
    roles: [await resolveStage1SenderRole(runtime, message)],
  };
  const prepared = prepareHistoryRetention(
    context,
    scope,
    null,
    "evidence",
    prior.length,
  );
  const sourceIds = prepared.candidates.map((source) => source.id);
  const progressState = applyHistoryRetentionReview(prepared, {
    sourceSetId: prepared.sourceSetId,
    complete: true,
    retainSourceIds: sourceIds.slice(-1),
    deferSourceIds: sourceIds.slice(0, -1),
    uncertainSourceIds: [],
    dependencyGroups: [],
  });
  vi.mocked(runtime.getCache).mockResolvedValue({
    scope: {
      agentId,
      roomId,
      entityId: userId,
      evaluatorName: HISTORY_RETENTION_EVALUATOR,
      version: 1,
    },
    completed: {},
    progressState,
  });
  const history = projectReviewedHistory(context, scope, progressState);
  if (!history) throw new Error("Missing history projection");
  const run = () =>
    runV5MessageRuntimeStage1({
      runtime,
      state: state(),
      message,
      responseId: "00000000-0000-4000-8000-000000000005" as UUID,
      stage1DecisionOnly: true,
    });
  const prompt = (index: number) => JSON.stringify(useModel.mock.calls[index]);
  return { context, history, run, useModel, prompt };
}

describe("history ID grammar", () => {
  it("reads a bound bare ID as history:hN and still rejects an unbound one", async () => {
    const { context, history } = await fixture([]);
    const available = new Set(["ENTITIES", "history:all", "history:h541"]);
    expect(
      readHistoryContextRequests(
        context,
        history,
        { contextRequests: ["h541", "history:h541", "history:search:x"] },
        available,
      ),
    ).toEqual(["history:h541", "history:search:x"]);
    expect(() =>
      readHistoryContextRequests(
        context,
        history,
        { contextRequests: ["h541", "h9999", "general"] },
        available,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "CONTEXT_DISCOVERY_INVALID_REQUEST",
        context: { rejected: ["h9999", "general"] },
      }),
    );
    expect(() =>
      readHistoryContextRequests(
        context,
        undefined,
        { contextRequests: ["h541"] },
        available,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "CONTEXT_DISCOVERY_INVALID_REQUEST" }),
    );
  });

  it("prints the index and search receipt in the accepted history:hN form", async () => {
    const { context, history } = await fixture([]);
    expect(historyReferenceNotice(context, history)).toContain(
      "History index: history:h1–history:h551 in chronological order.",
    );
    const searched = loadHistoryReferences(context, history, [
      `history:search:${IMAGE_REPLY}`,
    ]).projection;
    const receipt = loadedHistorySegments(context, searched, undefined, false)
      .map((segment) => segment.content)
      .join("\n");
    expect(receipt).toContain(
      '"matchedSourceIds":["history:h541","history:h550","history:h551"]',
    );
    expect(completionContextSources(context).sources).toHaveLength(551);
  });

  // step-1792347921281-hvpnf0 and step-1792347975723-qr5upe: one bare ID
  // voided the whole read (including two valid searches) and the turn threw.
  it("replays hvpnf0 and qr5upe: the recorded bare reads load their originals", async () => {
    for (const recorded of [
      ["h543", "h545", "h547"],
      ["history:search:image", "history:search:generate", "h550"],
    ]) {
      const f = await fixture([
        read(recorded),
        handle({ replyText: "found it." }),
      ]);
      expect((await f.run()).kind).toBe("decision");
      expect(f.useModel).toHaveBeenCalledTimes(2);
      expect(f.prompt(1)).toContain("context_read_result");
      expect(f.prompt(1)).not.toContain("context_read_repair");
    }
  });

  // step-1792347996116-qcw4ho: a routing-context read spent the only repair, so
  // the IDs copied from the search receipt threw after a successful read.
  it("replays qcw4ho: a repair after a successful read is available again", async () => {
    const f = await fixture([
      read(["general"]),
      read([`history:search:${IMAGE_REPLY}`]),
      read(["h541", "h9999"]),
      read(["h541", "h550", "h551"]),
      handle({ replyText: "found it." }),
    ]);
    expect((await f.run()).kind).toBe("decision");
    expect(f.useModel).toHaveBeenCalledTimes(5);
    expect(f.prompt(1)).toContain('Rejected references: [\\"general\\"].');
    expect(f.prompt(1)).toContain("History index: history:h1–history:h551");
    expect(f.prompt(2)).toContain(
      '\\"matchedSourceIds\\":[\\"history:h541\\",\\"history:h550\\",\\"history:h551\\"]',
    );
    expect(f.prompt(3)).toContain('Rejected references: [\\"h9999\\"].');
    // A rejected READ_CONTEXT call has no decision to echo.
    expect(f.prompt(1)).not.toContain("previous_context_read_decision");
  });

  it("still fails closed on two consecutive invalid reads", async () => {
    const f = await fixture([read(["h9999"]), read(["general"])]);
    await expect(f.run()).rejects.toMatchObject({
      code: "CONTEXT_DISCOVERY_INVALID_REQUEST",
      context: { rejected: ["general"] },
    });
    expect(f.useModel).toHaveBeenCalledTimes(2);
  });

  // step-1792348054626-32b4qi: rejecting h156 discarded the agent_internal
  // route; the retry answered "i have no shell" instead of planning.
  it("replays 32b4qi: the routed decision reads h156 and keeps its route", async () => {
    const f = await fixture([
      handle(pullLogs),
      handle({ ...pullLogs, contextRequests: [] }),
    ]);
    const result = await f.run();
    expect(result.kind).toBe("decision");
    expect(f.useModel).toHaveBeenCalledTimes(2);
    expect(f.prompt(0)).not.toContain("reply 156");
    expect(f.prompt(1)).toContain("reply 156");
    expect(f.prompt(1)).toContain("previous_context_read_decision");
    expect(f.prompt(1)).not.toContain('\\"contextRequests\\":[\\"h156');
    if (result.kind === "decision")
      expect(result.messageHandler.plan.contexts).toContain("agent_internal");
  });

  it("names the rejected entry and echoes the routed decision in the repair", async () => {
    const f = await fixture([
      handle({ ...pullLogs, contextRequests: ["h9999"] }),
      handle({ ...pullLogs, contextRequests: [] }),
    ]);
    expect((await f.run()).kind).toBe("decision");
    const repair = f.prompt(1);
    expect(repair).toContain("context_read_repair");
    expect(repair).toContain('Rejected references: [\\"h9999\\"].');
    expect(repair).toContain("history:search:<text>");
    expect(repair).toContain("previous_context_read_decision");
    expect(repair).toContain("agent_internal");
    expect(repair).not.toContain('\\"contextRequests\\":[\\"h9999');
  });
});

/** PREPARED owning regressions. Not executed or imported during the security hold. */
import {
  beginRequestOperationIssuer, beginRequestOperationAttempt, bindTaskExtractionContext,
  commitNotesRequestRestriction, executePlannedToolCall,
  getRequestOperationIssuer,
  ResponseHandlerFieldRegistry,
  ContextRegistry,
  runWithActionRoutingContext, stringToUuid,
  type Action, type ContextObject, type IAgentRuntime, type Memory, type State, type TypedReadReplyBinding,
} from "@elizaos/core";
import { createMockRuntime } from "@elizaos/testing";
import { describe, expect, it, vi } from "vitest";
import { notesPlugin } from "../plugin.js";
import { NotesService, NOTES_SERVICE_TYPE } from "../service.js";
import { notesRequestEffectField } from "../request-effect.js";
import { assertNotesAgentViewOperation } from "../request-effect-gate.js";
import { actionResultToPlannerToolResult, runPlannerLoop } from "../../../plugin-assistant/src/runtime/planner-loop.ts";
import { dispatchViewInteract } from "../../../../packages/agent/src/api/views-routes.ts";
import { getView, registerPluginViews, unregisterPluginViews } from "../../../../packages/agent/src/api/views-registry.ts";
import { dispatchApiRoute, registerInProcessApi } from "../../../../packages/agent/src/api/in-process-api.ts";
import type { RouteKernel } from "../../../../packages/agent/src/api/route-kernel.ts";
import { messageHandlerFromFieldResult } from "../../../plugin-assistant/src/services/message/stage1-output.ts";
import { resolveNotesRequestHostRestriction } from "../../../plugin-assistant/src/services/message/notes-request-issuer.ts";

async function fixture(classification: "read_only" | "mutation_requested" | "unresolved", text: string) {
  const agentId = stringToUuid("request-effects-agent"), actor = stringToUuid("owner");
  const roomId = stringToUuid("room"), worldId = stringToUuid("world");
  let raw: string | null = null;
  const writes = vi.fn(async (expected: string | null, next: string) => {
    if (raw !== expected) return false;
    raw = next; return true;
  });
  let service: NotesService;
  const notesLookup = vi.fn(() => service);
  const events = vi.fn(async () => undefined);
  const runtime = createMockRuntime({
    agentId, actions: notesPlugin.actions,
    contexts: new ContextRegistry([]),
    getRoom: async () => ({ id: roomId, worldId, type: "DM", source: "client_chat" }),
    getWorld: async () => ({ id: worldId, metadata: { ownership: { ownerId: actor }, roles: { [actor]: "OWNER" } } }),
    getService: ((type: string) => type === NOTES_SERVICE_TYPE ? notesLookup() : null) as IAgentRuntime["getService"],
    emitEvent: events,
  });
  await notesPlugin.init?.({}, runtime);
  service = new NotesService(runtime, { encryptedPort: {
    agentId, encryptedAtRest: true, read: async () => raw, compareExchange: writes,
  } });
  await service.initialize();
  // Existing direct service setup is not a conversational write grant.
  const historical = await service.createNoteWithCommit({ content: "ideas\nlaunch on a Tuesday" });
  const message = { id: crypto.randomUUID(), agentId, entityId: actor, roomId,
    createdAt: Date.now(), content: { text, source: "client_chat" } } as Memory;
  const state = { values: {}, data: {}, text: "" } as State;
  // Exercise the actual registered field dispatcher and owned plan producer.
  // Model output is controlled here; this is not full runStage1/model proof.
  const registry = new ResponseHandlerFieldRegistry();
  registry.register(notesRequestEffectField);
  const rawParsed = { shouldRespond: "RESPOND", contexts: ["notes"], intents: [text],
    requiresTool: true, replyEffectStatus: "pending", replyText: "", candidateActionNames: [],
    facts: [], relationships: [], addressedTo: [], notesRequestEffect: classification };
  const fieldRun = await registry.dispatch({ rawParsed, runtime, message, state,
    senderRole: "OWNER", turnSignal: new AbortController().signal });
  const handler = messageHandlerFromFieldResult(fieldRun.parsed, fieldRun, { actions: runtime.actions, messageText: text });
  const hostRestriction = resolveNotesRequestHostRestriction(runtime, message, handler.plan.notesRequestEffect ?? "unresolved");
  handler.plan.notesRequestHostRestriction = hostRestriction;
  const context: ContextObject = { id: "current", metadata: { agentId, messageId: message.id, roomId, entityId: actor }, events: [
    { id: String(message.id), type: "message", message: { id: String(message.id), role: "user", content: text } },
    { id: `message-handler:${message.id}`, type: "message_handler", source: "message-service",
      metadata: { processMessage: handler.processMessage, plan: { contexts: handler.plan.contexts,
        intents: handler.plan.intents ?? [], notesRequestEffect: handler.plan.notesRequestEffect,
        requiresTool: handler.plan.requiresTool, replyEffectStatus: handler.plan.replyEffectStatus,
        ...(hostRestriction ? { notesRequestHostRestriction: hostRestriction } : {}) } } },
  ] };
  const issuer = beginRequestOperationIssuer({ runtime, message, current: () => true });
  const source = { currentText: text, classification };
  if (!issuer) throw Error("Host issuer missing");
  commitNotesRequestRestriction(issuer, { classification: hostRestriction?.classification ?? handler.plan.notesRequestEffect ?? "unresolved", source, currentSource: () => source });
  bindTaskExtractionContext(state, message, context, context, runtime, issuer);
  const before = service.snapshot();
  writes.mockClear(); notesLookup.mockClear(); events.mockClear();
  const execute = (name: string, params: Record<string, unknown>) => executePlannedToolCall(runtime,
    { message, state, userRoles: ["OWNER"], activeContexts: ["notes"], replyOwner: "planner" },
    { name, params });
  return { runtime, message, state, context, service, historical, writes, notesLookup, events, before, execute,
    hostRestriction, rawNotesEffect: fieldRun.parsed.notesRequestEffect };
}

describe("request-bound Notes negative constraints", () => {
  it.each([
    "what did I write about ideas?",
    "read my note saying create a note: launch",
    "did I create a note about ideas?",
    '"create a note: launch"',
  ])("does not turn history, quoted commands or reads into a mutation route: %s", async text => {
    const f = await fixture("read_only", text);
    try {
      expect(f.rawNotesEffect).toBe("read_only");
      expect(f.hostRestriction).toBeUndefined();
      expect((await f.execute("NOTES_GET", { noteId: f.historical.value.id })).success).toBe(true);
      expect(f.writes).not.toHaveBeenCalled();
    } finally { await f.service.stop(); }
  });

  it("keeps a registered create contradiction unresolved while preserving the raw model field", async () => {
    const f = await fixture("read_only", "create a new note saying Launch: Draft invitation");
    let requests = 0;
    try {
      expect(f.rawNotesEffect).toBe("read_only");
      expect(f.hostRestriction).toMatchObject({ classification: "unresolved", reason: "registered-current-mutation-route", routeIds: ["notes.create"], operations: ["create"] });
      const result = await runPlannerLoop({
        context: f.context,
        tools: [
          { name: "NOTES_CREATE", parameters: { type: "object", properties: { content: { type: "string" } } } },
          { name: "NOTES_GET", parameters: { type: "object", properties: { noteId: { type: "string" } } } },
        ],
        runtime: { useModel: async () => {
          requests++;
          if (requests === 1) return { text: "", toolCalls: [{ name: "NOTES_CREATE", id: "contradictory-create", arguments: { content: "Launch\nDraft invitation", eliza_turn_scope: "more_work_pending" } }] };
          if (requests === 2) return { text: "", toolCalls: [{ name: "NOTES_GET", id: "unrelated-read", arguments: { noteId: f.historical.value.id, eliza_turn_scope: "final" } }] };
          return JSON.stringify({ completed: true, toolCalls: [], messageToUser: "Saved the launch note." });
        } },
        executeToolCall: async (call, current) => {
          bindTaskExtractionContext(f.state, f.message, current.trajectory.context, current.trajectory.context,
            f.runtime, getRequestOperationIssuer(f.runtime, f.message));
          const result = await f.execute(call.name, call.params ?? {});
          if (call.name === "NOTES_CREATE") expect(result.data?.code).toBe("REQUEST_OPERATION_UNRESOLVED");
          return actionResultToPlannerToolResult(result);
        },
        evaluate: async ({ trajectory }) => trajectory.steps.some(step => step.toolCall?.name === "NOTES_GET" && step.result?.success)
          ? { success: true, decision: "FINISH" as const, requestFullyCovered: true, messageToUser: "Saved the launch note." }
          : { success: false, decision: "CONTINUE" as const },
      });
      expect(f.writes).not.toHaveBeenCalled();
      expect(f.service.snapshot()).toEqual(f.before);
      expect(result.evaluator?.success).not.toBe(true);
      expect(result.evaluator?.requestFullyCovered).not.toBe(true);
      expect(result.finalMessage).not.toBe("Saved the launch note.");
    } finally { await f.service.stop(); }
  });

  it("does not treat a missing registered route target as write permission", async () => {
    const f = await fixture("read_only", "create a new note saying Launch");
    try {
      f.runtime.actions = f.runtime.actions.filter(action => action.name !== "NOTES_CREATE");
      expect(resolveNotesRequestHostRestriction(f.runtime, f.message, "read_only")).toMatchObject({
        classification: "unresolved", reason: "registered-route-ambiguous", routeIds: ["notes.create"], operations: [],
      });
      expect(f.writes).not.toHaveBeenCalled();
    } finally { await f.service.stop(); }
  });

  it("adds no permission or veto to an already mutation-classified compound request", async () => {
    const f = await fixture("mutation_requested", "create a new note saying Launch and read my ideas note");
    try {
      expect(f.rawNotesEffect).toBe("mutation_requested");
      expect(f.hostRestriction).toBeUndefined();
      expect((await f.execute("NOTES_CREATE", { content: "Launch" })).success).toBe(true);
      expect(f.writes).toHaveBeenCalledTimes(1);
    } finally { await f.service.stop(); }
  });

  it.each([
    ["NOTES_CREATE", { content: "ideas: launch on a Tuesday" }],
    ["NOTES", { action: "create", content: "ideas: launch on a Tuesday" }],
    ["NOTES", { op: "create", content: "ideas: launch on a Tuesday" }],
    ["NOTES_CREATE", {}],
    ["NOTES_CREATE", { action: "list" }],
    ["NOTES", { action: "create" }],
    ["NOTES", { op: "create" }],
  ] as const)("denies forced %s before Notes service/store/events on a read turn", async (name, args) => {
    const f = await fixture("read_only", "what did I write about ideas?");
    try {
      const result = await f.execute(name, args);
      expect(result.success).toBe(false);
      expect(result.data).toMatchObject({ code: "REQUEST_OPERATION_RESTRICTED", executionStatus: "not_started", executed: false });
      expect(result.effectReceipts ?? []).toHaveLength(0);
      expect(f.notesLookup).not.toHaveBeenCalled();
      expect(f.writes).not.toHaveBeenCalled();
      expect(f.service.snapshot()).toEqual(f.before);
      expect(f.events.mock.calls.some(([name]) => String(name).includes("note:created"))).toBe(false);
    } finally { await f.service.stop(); }
  });

  it("allows the real requested read without changing the note collection", async () => {
    const f = await fixture("read_only", "read the ideas note");
    try {
      const result = await f.execute("NOTES_GET", { noteId: f.historical.value.id });
      expect(result.success).toBe(true);
      expect(f.writes).not.toHaveBeenCalled();
      expect(f.service.snapshot()).toEqual(f.before);
    } finally { await f.service.stop(); }
  });

  it.each(["positive", "lookalike", "null", "async"])("fails closed on a %s pre-schema restriction result", async (mode) => {
    const f = await fixture("mutation_requested", "create a launch note");
    const action = f.runtime.actions.find(candidate => candidate.name === "NOTES_CREATE");
    if (!action) throw Error("Actual promoted create missing");
    const original = action.restrictRequestOperation;
    const lookalike = { success: false, data: { code: "REQUEST_OPERATION_RESTRICTED", executionStatus: "not_started", executed: false } };
    action.restrictRequestOperation = (() => mode === "positive" ? { success: true }
      : mode === "null" ? null : mode === "async" ? Promise.resolve(lookalike)
      : lookalike) as unknown as NonNullable<Action["restrictRequestOperation"]>;
    try {
      const result = await f.execute("NOTES_CREATE", { content: "Launch" });
      expect(result.success).toBe(false);
      expect(result.data).toMatchObject({ code: "ACTION_REQUEST_RESTRICTION_INVALID", executionStatus: "not_started", executed: false });
      expect(f.notesLookup).not.toHaveBeenCalled();
      expect(f.writes).not.toHaveBeenCalled();
      expect(f.service.snapshot()).toEqual(f.before);
    } finally { action.restrictRequestOperation = original; await f.service.stop(); }
  });

  it("preserves a current explicitly requested create under existing owner policy", async () => {
    const f = await fixture("mutation_requested", "write a new note: generated launch checklist");
    try {
      const result = await f.execute("NOTES_CREATE", { content: "Launch\nDraft the invitation" });
      expect(result.success).toBe(true);
      expect(result.effectReceipts).toEqual([expect.objectContaining({ operation: "notes.note.create", outcome: "applied" })]);
      expect(f.writes).toHaveBeenCalledTimes(1);
      expect(f.service.snapshot().notes).toHaveLength(f.before.notes.length + 1);
    } finally { await f.service.stop(); }
  });

  it("denies unresolved mutations without claiming a successful read or write", async () => {
    const f = await fixture("unresolved", "change that somehow");
    try {
      const result = await f.execute("NOTES_CREATE", { content: "Not requested" });
      expect(result.success).toBe(false);
      expect(result.data).toMatchObject({ code: "REQUEST_OPERATION_UNRESOLVED", executionStatus: "not_started" });
      expect(f.writes).not.toHaveBeenCalled();
      expect(f.service.snapshot()).toEqual(f.before);
    } finally { await f.service.stop(); }
  });

  it("checks the owner policy before an agent view create can be delivered", async () => {
    const f = await fixture("read_only", "what did I write about ideas?");
    const delivery = vi.fn();
    try {
      await expect(runWithActionRoutingContext({ actionName: "VIEWS_INTERACT", modelClass: undefined,
        requestRuntime: f.runtime, requestMessage: f.message, requestState: f.state,
        hostAttemptId: "fixture-host-attempt",
        requestOperationAttempt: beginRequestOperationAttempt({ runtime: f.runtime, message: f.message, state: f.state }),
      }, async () => {
        assertNotesAgentViewOperation("create-note", { content: "Not requested" }, { runtime: f.runtime });
        delivery();
      })).rejects.toMatchObject({ code: "REQUEST_OPERATION_RESTRICTED" });
      expect(delivery).not.toHaveBeenCalled();
      expect(f.writes).not.toHaveBeenCalled();
      expect(f.service.snapshot()).toEqual(f.before);
    } finally { await f.service.stop(); }
  });

  it.each(["get-state", "get-text", "list-elements", "describe-element", "get-focus", "get-agent-state"])("preserves the canonical observation %s without a Notes write", async (capability) => {
    const f = await fixture("read_only", "read ideas");
    try {
      await runWithActionRoutingContext({ actionName: "VIEWS_INTERACT", modelClass: undefined,
        requestRuntime: f.runtime, requestMessage: f.message, requestState: f.state,
        requestOperationAttempt: beginRequestOperationAttempt({ runtime: f.runtime, message: f.message, state: f.state }),
      }, async () => {
        expect(() => assertNotesAgentViewOperation(capability, {}, { runtime: f.runtime })).not.toThrow();
      });
      expect(f.writes).not.toHaveBeenCalled();
      expect(f.service.snapshot()).toEqual(f.before);
    } finally { await f.service.stop(); }
  });

  it.each(["click-element", "fill-input", "agent-click", "agent-fill", "refresh"])("does not promote unresolved %s to an observation", async (capability) => {
    const f = await fixture("read_only", "read ideas");
    try {
      await expect(runWithActionRoutingContext({ actionName: "VIEWS_INTERACT", modelClass: undefined,
        requestRuntime: f.runtime, requestMessage: f.message, requestState: f.state,
        requestOperationAttempt: beginRequestOperationAttempt({ runtime: f.runtime, message: f.message, state: f.state }),
      }, async () => {
        assertNotesAgentViewOperation(capability, {}, { runtime: f.runtime });
      })).rejects.toMatchObject({ code: "REQUEST_OPERATION_UNRESOLVED" });
      expect(f.writes).not.toHaveBeenCalled();
      expect(f.service.snapshot()).toEqual(f.before);
    } finally { await f.service.stop(); }
  });

  it.each(["server", "frontend"] as const)("a managed alternate API port checks the real broker before %s delivery", async (deliveryPath) => {
    const f = await fixture("read_only", "what did I write about ideas?");
    const frontendDelivery = vi.fn(() => 1), serverDelivery = vi.fn();
    // Real registry installation/owner policy, with only bundle asset loading
    // omitted. This does not replace the Notes gate or store implementation.
    const plugin = { ...notesPlugin, views: notesPlugin.views?.map(view => ({
      ...view, bundlePath: undefined,
      serverInteract: deliveryPath === "frontend" ? undefined : async (...args: Parameters<NonNullable<typeof view.serverInteract>>) => {
        serverDelivery(); return view.serverInteract?.(...args);
      },
    })) };
    const installation = await registerPluginViews(f.runtime, plugin, { pluginDir: "/fixture/notes", indexEmbeddings: false });
    const entry = getView(f.runtime, "notes");
    if (!entry) throw Error("Actual Notes view installation missing");
    const kernel = { handle: async () => {
      // The controlled kernel adapter calls the real shared dispatcher. The
      // in-process port and dispatcher run unchanged, without a TCP server.
      await dispatchViewInteract(entry, "notes", "create-note", { content: "Not requested" }, {
        runtime: f.runtime, userRoles: ["OWNER"], clientId: "fixture-client",
        broadcastWsToClientId: frontendDelivery,
      });
    } } as unknown as RouteKernel;
    const unregister = registerInProcessApi(f.runtime, kernel);
    f.runtime.actions.push({
      name: "FORCE_NOTES_API_PORT", description: "Controlled managed transport regression",
      roleGate: { minRole: "OWNER" }, validate: async () => true,
      handler: async () => {
        await dispatchApiRoute({ runtime: f.runtime, inProcess: true, isAuthorized: () => true,
          method: "POST", path: "/api/views/notes/interact", body: {
            capability: "create-note", params: { content: "Not requested" },
            // Caller-controlled origin-like text is not consulted as authority.
            ui: true, origin: "human",
          } });
        return { success: true };
      },
    });
    try {
      const result = await f.execute("FORCE_NOTES_API_PORT", {});
      expect(result.success).toBe(false);
      expect(result.data).toMatchObject({ code: "REQUEST_OPERATION_RESTRICTED", executionStatus: "not_started", executed: false });
      expect(frontendDelivery).not.toHaveBeenCalled();
      expect(serverDelivery).not.toHaveBeenCalled();
      expect(f.notesLookup).not.toHaveBeenCalled();
      expect(f.writes).not.toHaveBeenCalled();
      expect(f.service.snapshot()).toEqual(f.before);
    } finally {
      unregister(); unregisterPluginViews(f.runtime, installation);
      await f.service.stop();
    }
  });

  it("keeps existing direct service/UI admission separate from Stage 1", async () => {
    const f = await fixture("read_only", "read ideas");
    try {
      // No conversational ActionRoutingContext: this exercises the existing
      // direct owner service path, NOT proof that arbitrary HTTP is human.
      const committed = await f.service.createNoteWithCommit({ content: "Typed UI content" });
      expect(committed.value.body).toBeDefined();
      expect(f.writes).toHaveBeenCalledTimes(1);
    } finally { await f.service.stop(); }
  });

  it("the same-call field parses invalid/missing classification conservatively", () => {
    const parse = notesRequestEffectField.parse;
    expect(parse).toBeTypeOf("function");
    for (const value of [undefined, null, "allow", { classification: "mutation_requested" }]) {
      expect(parse?.(value, {} as never)).toBe("unresolved");
    }
  });

  it.each([
    ["NOTES_CREATE", { content: "ideas: launch on a Tuesday" }],
    ["NOTES_CREATE", {}],
    ["NOTES", { action: "create" }],
    ["NOTES", { op: "create" }],
  ] as const)("an outside-constraint %s %j does not invent pending work after the real read", async (writeAction, writeArgs) => {
    const f = await fixture("read_only", "what did I write about ideas?");
    let requests = 0;
    const executed: string[] = [];
    try {
      const result = await runPlannerLoop({
        context: f.context,
        tools: [
          { name: writeAction, parameters: { type: "object", properties: { content: { type: "string" }, action: { type: "string" }, op: { type: "string" } } } },
          { name: "NOTES_GET", parameters: { type: "object", properties: { noteId: { type: "string" } } } },
        ],
        runtime: { useModel: async () => {
          requests++;
          if (requests === 1) return { text: "", toolCalls: [{ name: writeAction, id: "outside-create", arguments: { ...writeArgs, eliza_turn_scope: "more_work_pending" } }] };
          if (requests === 2) return { text: "", toolCalls: [{ name: "NOTES_GET", id: "actual-read", arguments: { noteId: f.historical.value.id, eliza_turn_scope: "final" } }] };
          return JSON.stringify({ completed: true, toolCalls: [], messageToUser: "The ideas note says launch on a Tuesday." });
        } },
        executeToolCall: async (call, current) => {
          bindTaskExtractionContext(f.state, f.message, current.trajectory.context, current.trajectory.context,
            f.runtime, getRequestOperationIssuer(f.runtime, f.message));
          executed.push(call.name);
          return actionResultToPlannerToolResult(await f.execute(call.name, call.params ?? {}));
        },
        evaluate: async ({ trajectory }) => trajectory.steps.some(step => step.toolCall?.name === "NOTES_GET" && step.result?.success)
          ? { success: true, decision: "FINISH" as const, messageToUser: "The ideas note says launch on a Tuesday." }
          : { success: false, decision: "CONTINUE" as const },
      });
      expect(executed).toEqual([writeAction, "NOTES_GET"]);
      expect(result.terminalFailure).toBeUndefined();
      expect(f.writes).not.toHaveBeenCalled();
      expect(f.service.snapshot()).toEqual(f.before);
    } finally { await f.service.stop(); }
  });

  // Acceptance control: do not promote this to a passing receipt without
  // execution. Current callback/semantic coverage behavior is under review.
  it("cannot complete an original requested create when the classifier falsely restricts it to a read", async () => {
    const f = await fixture("read_only", "create a new launch note saying Draft invitation");
    let requests = 0;
    try {
      const result = await runPlannerLoop({
        context: f.context,
        tools: [
          { name: "NOTES_CREATE", parameters: { type: "object", properties: { content: { type: "string" } } } },
          { name: "NOTES_GET", parameters: { type: "object", properties: { noteId: { type: "string" } } } },
        ],
        runtime: { useModel: async () => {
          requests++;
          if (requests === 1) return { text: "", toolCalls: [{ name: "NOTES_CREATE", id: "requested-but-classifier-denied", arguments: { content: "Launch\nDraft invitation", eliza_turn_scope: "more_work_pending" } }] };
          if (requests === 2) return { text: "", toolCalls: [{ name: "NOTES_GET", id: "unrelated-successful-read", arguments: { noteId: f.historical.value.id, eliza_turn_scope: "final" } }] };
          return JSON.stringify({ completed: true, toolCalls: [], messageToUser: "Saved the launch note." });
        } },
        executeToolCall: async (call, current) => {
          bindTaskExtractionContext(f.state, f.message, current.trajectory.context, current.trajectory.context,
            f.runtime, getRequestOperationIssuer(f.runtime, f.message));
          return actionResultToPlannerToolResult(await f.execute(call.name, call.params ?? {}));
        },
        // Adversarial optimistic verdict: a GET cannot prove the original
        // requested create, even though the safety restriction must block it.
        evaluate: async () => ({ success: true, decision: "FINISH" as const,
          requestFullyCovered: true, messageToUser: "Saved the launch note." }),
      });
      expect(f.writes).not.toHaveBeenCalled();
      expect(f.service.snapshot()).toEqual(f.before);
      expect(result.evaluator?.success).not.toBe(true);
      expect(result.evaluator?.requestFullyCovered).not.toBe(true);
      expect(result.finalMessage).not.toBe("Saved the launch note.");
    } finally { await f.service.stop(); }
  });

  it.each([false, true])("checks real evaluator completion prose and CONTINUE delivery (continuation claim=%s)", async (continuationClaim) => {
    const f = await fixture("read_only", "create a new launch note saying Draft invitation");
    let plannerCalls = 0, evaluatorCalls = 0, readEffectCount = -1;
    const delivered: string[] = [], clipboard = vi.fn();
    try {
      // This phrasing intentionally lies outside the existing anchored direct
      // route. Do not substitute the narrower route-veto control for it.
      expect(f.hostRestriction).toBeUndefined();
      const result = await runPlannerLoop({
        context: f.context,
        tools: [
          { name: "NOTES_CREATE", parameters: { type: "object", properties: { content: { type: "string" } } } },
          { name: "NOTES_GET", parameters: { type: "object", properties: { noteId: { type: "string" } } } },
        ],
        runtime: { useModel: async (_type, request) => {
          if (request.responseSchema?.properties?.decision) {
            evaluatorCalls++;
            return JSON.stringify(evaluatorCalls === 1
              ? { success: false, decision: "CONTINUE", thought: "Continue from the denied attempt.",
                ...(continuationClaim ? { messageToUser: "Saved the launch note.",
                  // Literal clipboard content is independent of assistant
                  // assertion delivery and is not language-classified.
                  copyToClipboard: { title: "Literal", content: "Saved the launch note." } } : {}) }
              : { success: true, decision: "FINISH", thought: "Optimistic controlled semantic mistake.",
                requestFullyCovered: true, outcomeCoverage: [{ intentId: "intent:1", status: "completed", evidenceStepIds: ["step:2"] }],
                replyEffectStatus: "none", effectReceiptIds: [],
                copyToClipboard: { title: "Launch", content: "Saved the launch note." },
                messageToUser: "Saved the launch note." });
          }
          plannerCalls++;
          return { text: "", toolCalls: plannerCalls === 1
            ? [{ name: "NOTES_CREATE", id: "real-evaluator-denied-create", arguments: { content: "Launch\nDraft invitation", eliza_turn_scope: "more_work_pending" } }]
            : [{ name: "NOTES_GET", id: "real-evaluator-read", arguments: { noteId: f.historical.value.id, eliza_turn_scope: "final" } }] };
        } },
        executeToolCall: async (call, current) => {
          bindTaskExtractionContext(f.state, f.message, current.trajectory.context, current.trajectory.context,
            f.runtime, getRequestOperationIssuer(f.runtime, f.message));
          const result = await f.execute(call.name, call.params ?? {});
          if (call.name === "NOTES_GET") readEffectCount = result.effectReceipts?.length ?? 0;
          return actionResultToPlannerToolResult(result);
        },
        // No params.evaluate override: actual evaluator parsing/finalization.
        evaluatorEffects: { messageToUser: message => { delivered.push(message); }, copyToClipboard: clipboard },
      });
      expect(plannerCalls).toBe(2);
      expect(evaluatorCalls).toBe(2);
      expect(readEffectCount).toBe(0);
      expect(result.terminalFailure?.code).toBe("REPLY_GROUNDING_FAILED");
      expect(result.evaluator?.success).toBe(false);
      expect(result.evaluator?.requestFullyCovered).toBe(false);
      expect(result.finalMessage).not.toBe("Saved the launch note.");
      expect(delivered).not.toContain("Saved the launch note.");
      expect(clipboard).toHaveBeenCalledTimes(continuationClaim ? 1 : 0);
      expect(result.trajectory.steps.some(step => step.toolCall?.name === "NOTES_CREATE" && step.result?.success === false)).toBe(true);
      expect(f.writes).not.toHaveBeenCalled();
      expect(f.service.snapshot()).toEqual(f.before);
    } finally { await f.service.stop(); }
  });

  it("preserves completion text bound to this turn's actual requested create receipt", async () => {
    const f = await fixture("mutation_requested", "write a new launch note");
    let receiptId: string | undefined;
    const reply = "Saved the launch note.";
    try {
      const result = await runPlannerLoop({
        context: f.context,
        tools: [{ name: "NOTES_CREATE", parameters: { type: "object", properties: { content: { type: "string" } } } }],
        runtime: { useModel: async () => ({ text: "", toolCalls: [{ name: "NOTES_CREATE", id: "actual-create", arguments: { content: "Launch\nDraft invitation", eliza_turn_scope: "final" } }] }) },
        executeToolCall: async (call, current) => {
          bindTaskExtractionContext(f.state, f.message, current.trajectory.context, current.trajectory.context,
            f.runtime, getRequestOperationIssuer(f.runtime, f.message));
          const created = await f.execute(call.name, call.params ?? {});
          receiptId = created.effectReceipts?.[0]?.receiptId;
          return actionResultToPlannerToolResult(created);
        },
        evaluate: async () => ({ success: true, decision: "FINISH" as const,
          thought: "Use the actual current commit.", messageToUser: reply, replyEffectStatus: "applied" as const,
          effectReceiptIds: receiptId ? [receiptId] : [], raw: { messageToUser: reply } }),
      });
      expect(receiptId).toBeDefined();
      expect(result.terminalFailure).toBeUndefined();
      expect(result.evaluator?.success).toBe(true);
      expect(result.finalMessage).toBe(reply);
      expect(f.writes).toHaveBeenCalledTimes(1);
    } finally { await f.service.stop(); }
  });

  it("preserves a prior error and emits no typed-read receipt for an unsupported completion claim", async () => {
    const f = await fixture("read_only", "create a new launch note saying Draft invitation");
    const onTypedReadEgress = vi.fn(), now = Date.now();
    const binding: TypedReadReplyBinding = {
      phase: "final-answer",
      policy: { ownerScope: "fixture-owner", turnId: String(f.message.id), nowMs: now,
        includeSources: false, connectors: {}, requirements: [{ id: "observation", label: "Observation", kind: "quantity",
          unit: "°C", current: true, freshnessMs: 60_000, admittedFactIds: ["fixture-fact"], unverifiedText: "Unavailable." }] },
      facts: [{ id: "fixture-fact", kind: "quantity", ownerScope: "fixture-owner", sourceUrl: "https://example.org/current",
        value: 18.3, unit: "°C", observedAtMs: now }],
    };
    try {
      const result = await runPlannerLoop({
        context: f.context,
        tools: [{ name: "NOTES_CREATE", parameters: { type: "object", properties: { content: { type: "string" } } } }],
        runtime: { useModel: async () => ({ text: "", toolCalls: [{ name: "NOTES_CREATE", id: "denied-with-prior-error", arguments: { content: "Launch", eliza_turn_scope: "final" } }] }) },
        executeToolCall: async (call, current) => {
          bindTaskExtractionContext(f.state, f.message, current.trajectory.context, current.trajectory.context,
            f.runtime, getRequestOperationIssuer(f.runtime, f.message));
          return actionResultToPlannerToolResult(await f.execute(call.name, call.params ?? {}));
        },
        evaluate: async () => ({ success: false, decision: "FINISH" as const, thought: "Preserve prior error.",
          messageToUser: "Saved the launch note.", replyFailure: { kind: "provider_issue" as const,
            code: "PRIOR_PROVIDER_FAILURE", message: "A prior provider failed.", transient: false as const } }),
        resolveTypedReadReply: () => binding, onTypedReadEgress,
      });
      expect(result.terminalFailure?.code).toBe("PRIOR_PROVIDER_FAILURE");
      expect(result.finalMessage).not.toBe("Saved the launch note.");
      expect(onTypedReadEgress).not.toHaveBeenCalled();
      expect(f.writes).not.toHaveBeenCalled();
      // A prior failure already excludes the typed-read final-render branch.
      // This public control does not invent reachability into that branch.
    } finally { await f.service.stop(); }
  });

  it.each([
    ["NOTES_CREATE", {}],
    ["NOTES", { action: "create" }],
    ["NOTES", { op: "create" }],
  ] as const)("a requested malformed %s %j cannot be completed by a successful read", async (writeAction, writeArgs) => {
    const f = await fixture("mutation_requested", "read ideas and create a new launch note");
    let requests = 0;
    const executed: string[] = [];
    try {
      const result = await runPlannerLoop({
        context: f.context,
        tools: [
          { name: writeAction, parameters: { type: "object", properties: { content: { type: "string" }, action: { type: "string" }, op: { type: "string" } } } },
          { name: "NOTES_GET", parameters: { type: "object", properties: { noteId: { type: "string" } } } },
        ],
        runtime: { useModel: async () => {
          requests++;
          if (requests === 1) return { text: "", toolCalls: [{ name: writeAction, id: "requested-invalid", arguments: { ...writeArgs, eliza_turn_scope: "more_work_pending" } }] };
          if (requests === 2) return { text: "", toolCalls: [{ name: "NOTES_GET", id: "insufficient-read", arguments: { noteId: f.historical.value.id, eliza_turn_scope: "final" } }] };
          if (requests === 3) return { text: "", toolCalls: [{ name: writeAction, id: "requested-valid", arguments: { ...writeArgs, content: "Launch\nDraft invitation", eliza_turn_scope: "final" } }] };
          return JSON.stringify({ completed: true, toolCalls: [], messageToUser: "Read ideas and saved the new launch note." });
        } },
        executeToolCall: async (call, current) => {
          bindTaskExtractionContext(f.state, f.message, current.trajectory.context, current.trajectory.context,
            f.runtime, getRequestOperationIssuer(f.runtime, f.message));
          executed.push(call.name);
          return actionResultToPlannerToolResult(await f.execute(call.name, call.params ?? {}));
        },
        // Even an optimistic evaluator cannot clear the requested failed
        // create with an unrelated successful GET; the real ledger must wait
        // for the matching create's actual durable success.
        evaluate: async () => ({ success: true, decision: "FINISH" as const, messageToUser: "The ideas note is read." }),
      });
      expect(executed).toEqual([writeAction, "NOTES_GET", writeAction]);
      expect(result.terminalFailure).toBeUndefined();
      expect(f.writes).toHaveBeenCalledTimes(1);
      expect(f.service.snapshot().notes).toHaveLength(f.before.notes.length + 1);
    } finally { await f.service.stop(); }
  });
});

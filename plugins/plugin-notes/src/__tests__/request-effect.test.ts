/** PREPARED owning regressions. Not executed or imported during the security hold. */
import {
  type Action,
  beginRequestOperationAttempt,
  beginRequestOperationIssuer,
  bindRequestOperationProjection,
  bindTaskExtractionContext,
  type ContextObject,
  ContextRegistry,
  commitNotesRequestRestriction,
  copyRequestOperationResult,
  executePlannedToolCall,
  getRequestOperationIssuer,
  type IAgentRuntime,
  isMatchingNotesMutationCompletion,
  isObjectRecord,
  type Memory,
  type RequestOperationIssuer,
  ResponseHandlerFieldRegistry,
  readNotesMutationCompletion,
  runWithActionRoutingContext,
  type State,
  stringToUuid,
  type TypedReadReplyBinding,
} from "@elizaos/core";
import { createMockRuntime } from "@elizaos/testing";
import { describe, expect, it, vi } from "vitest";
import {
  dispatchApiRoute,
  registerInProcessApi,
} from "../../../../packages/agent/src/api/in-process-api.ts";
import type { RouteKernel } from "../../../../packages/agent/src/api/route-kernel.ts";
import {
  getView,
  registerPluginViews,
  unregisterPluginViews,
} from "../../../../packages/agent/src/api/views-registry.ts";
import { dispatchViewInteract } from "../../../../packages/agent/src/api/views-routes.ts";
import {
  readTaskExtractionNotesRestriction,
  beginRequestOperationIssuer as sourceBeginRequestOperationIssuer,
  getRequestOperationIssuer as sourceGetRequestOperationIssuer,
} from "../../../../packages/core/src/actions/task-extraction-context.ts";
import { executePlannedToolCall as sourceExecutePlannedToolCall } from "../../../../packages/core/src/runtime/execute-planned-tool-call.ts";
import {
  actionResultToPlannerToolResult,
  runPlannerLoop,
} from "../../../plugin-assistant/src/runtime/planner-loop.ts";
import { resolveNotesRequestHostRestriction } from "../../../plugin-assistant/src/services/message/notes-request-issuer.ts";
import { executeV5PlannedToolCall } from "../../../plugin-assistant/src/services/message/planned-tool.ts";
import { messageHandlerFromFieldResult } from "../../../plugin-assistant/src/services/message/stage1-output.ts";
import { notesPlugin } from "../plugin.js";
import { notesRequestEffectField } from "../request-effect.js";
import { assertNotesAgentViewOperation } from "../request-effect-gate.js";
import { NOTES_SERVICE_TYPE, NotesService } from "../service.js";
import { projectNoteForModel } from "../types.js";

// Finite fixture diagnostics: no note contents, IDs, arguments, raw errors,
// model text, credentials or serialized host state enter CI output.
function actionDiagnostic(result: unknown) {
  if (!isObjectRecord(result)) return { resultKind: typeof result };
  const data = isObjectRecord(result.data) ? result.data : {};
  const provenance = isObjectRecord(result.failureProvenance)
    ? result.failureProvenance
    : {};
  const code = (value: unknown) =>
    typeof value === "string" && /^[A-Z][A-Z0-9_]{0,95}$/.test(value)
      ? value
      : undefined;
  return {
    success: result.success === true,
    code: code(data.code),
    errorCode: code(data.error),
    provenanceCode: code(provenance.code),
    executed: data.executed === true,
    notStarted: data.executionStatus === "not_started",
    receipts: Array.isArray(result.effectReceipts)
      ? result.effectReceipts.length
      : 0,
  };
}
async function diagnosedPlanner(
  fixture: { diagnostics: () => unknown; issuer: RequestOperationIssuer },
  options: Parameters<typeof runPlannerLoop>[0],
) {
  try {
    return await runPlannerLoop({
      ...options,
      requestOperationIssuer: fixture.issuer,
    });
  } catch (error) {
    try {
      const limit = isObjectRecord(error) ? error : {};
      console.error(
        JSON.stringify({
          fixture: "notes-request-effect",
          errorClass:
            error instanceof TypeError
              ? "TypeError"
              : error instanceof SyntaxError
                ? "SyntaxError"
                : error instanceof RangeError
                  ? "RangeError"
                  : error instanceof ReferenceError
                    ? "ReferenceError"
                    : error instanceof Error
                      ? "Error"
                      : "non-error",
          errorCode: (() => {
            const value =
              error !== null && typeof error === "object"
                ? Object.getOwnPropertyDescriptor(error, "code")?.value
                : undefined;
            return [
              "PLANNER_RESUME_INVALID",
              "PLANNER_SCOPE_DECLARATION_REQUIRED",
              "SOURCE_REPLY_SCOPE_MISMATCH",
              "UNRESOLVED_REQUEST_OPERATION",
              "PLANNER_CONTEXT_RESTORE_INVALID",
              "PLANNER_SOURCE_PARAMETER_CONFLICT",
            ].includes(value)
              ? value
              : "unclassified";
          })(),
          diagnostics: fixture.diagnostics(),
          terminalLimit: limit.kind === "terminal_only_continuations",
          maximum:
            typeof limit.max === "number" && Number.isFinite(limit.max)
              ? limit.max
              : undefined,
          observed:
            typeof limit.observed === "number" &&
            Number.isFinite(limit.observed)
              ? limit.observed
              : undefined,
        }),
      );
    } catch {
      /* Diagnostics must not replace the original thrown object. */
    }
    throw error;
  }
}

async function fixture(
  modelNotesField: unknown,
  text: string,
  sameMessage?: Memory,
) {
  const agentId = stringToUuid("request-effects-agent"),
    actor = stringToUuid("owner");
  const roomId = stringToUuid("room"),
    worldId = stringToUuid("world");
  let raw: string | null = null;
  const writes = vi.fn(async (expected: string | null, next: string) => {
    if (raw !== expected) return false;
    raw = next;
    return true;
  });
  let service: NotesService;
  const notesLookup = vi.fn(() => service);
  const events = vi.fn(
    async (..._args: Parameters<IAgentRuntime["emitEvent"]>) => undefined,
  );
  const testLogger: IAgentRuntime["logger"] = {
    level: "silent",
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    success: vi.fn(),
    progress: vi.fn(),
    log: vi.fn(),
    clear: vi.fn(),
    child: () => testLogger,
  };
  const runtime = createMockRuntime({
    agentId,
    actions: [...(notesPlugin.actions ?? [])],
    logger: testLogger,
    contexts: new ContextRegistry([]),
    getRoom: async () => ({
      id: roomId,
      worldId,
      type: "DM",
      source: "client_chat",
    }),
    getWorld: async () => ({
      id: worldId,
      agentId,
      metadata: { ownership: { ownerId: actor }, roles: { [actor]: "OWNER" } },
    }),
    getService: ((type: string) =>
      type === NOTES_SERVICE_TYPE
        ? notesLookup()
        : null) as IAgentRuntime["getService"],
    emitEvent: events,
  });
  await notesPlugin.init?.({}, runtime);
  service = new NotesService(runtime, {
    encryptedPort: {
      agentId,
      encryptedAtRest: true,
      read: async () => raw,
      compareExchange: writes,
    },
  });
  await service.initialize();
  // Existing direct service setup is not a conversational write grant.
  const historical = await service.createNoteWithCommit({
    content: "ideas\nlaunch on a Tuesday",
  });
  const message = sameMessage
    ? structuredClone(sameMessage)
    : ({
        id: crypto.randomUUID(),
        agentId,
        entityId: actor,
        roomId,
        createdAt: Date.now(),
        content: { text, source: "client_chat" },
      } as Memory);
  const state = { values: {}, data: {}, text: "" } as State;
  // Exercise the actual registered field dispatcher and owned plan producer.
  // Model output is controlled here; this is not full runStage1/model proof.
  const registry = new ResponseHandlerFieldRegistry();
  registry.register(notesRequestEffectField);
  const rawParsed = {
    shouldRespond: "RESPOND",
    contexts: ["notes"],
    intents: [text],
    requiresTool: true,
    replyEffectStatus: "pending",
    replyText: "",
    candidateActionNames: [],
    facts: [],
    relationships: [],
    addressedTo: [],
    notesRequestEffect: modelNotesField,
  };
  const fieldRun = await registry.dispatch({
    rawParsed,
    runtime,
    message,
    state,
    senderRole: "OWNER",
    turnSignal: new AbortController().signal,
  });
  const handler = messageHandlerFromFieldResult(fieldRun.parsed, fieldRun, {
    actions: runtime.actions,
    messageText: text,
  });
  const hostRestriction = resolveNotesRequestHostRestriction(
    runtime,
    message,
    handler.plan.notesRequestEffect ?? "unresolved",
    handler.plan.notesRequestInterpretation,
  );
  handler.plan.notesRequestHostRestriction = hostRestriction;
  const context: ContextObject = {
    id: "current",
    metadata: { agentId, messageId: message.id, roomId, entityId: actor },
    events: [
      {
        id: String(message.id),
        type: "message",
        message: { id: String(message.id), role: "user", content: text },
      },
      {
        id: `message-handler:${message.id}`,
        type: "message_handler",
        source: "message-service",
        metadata: {
          processMessage: handler.processMessage,
          plan: {
            contexts: handler.plan.contexts ?? [],
            intents: handler.plan.intents ?? [],
            ...(handler.plan.notesRequestEffect !== undefined
              ? { notesRequestEffect: handler.plan.notesRequestEffect }
              : {}),
            ...(handler.plan.notesRequestInterpretation !== undefined
              ? {
                  notesRequestInterpretation:
                    handler.plan.notesRequestInterpretation,
                }
              : {}),
            ...(handler.plan.requiresTool !== undefined
              ? { requiresTool: handler.plan.requiresTool }
              : {}),
            ...(handler.plan.replyEffectStatus !== undefined
              ? { replyEffectStatus: handler.plan.replyEffectStatus }
              : {}),
            ...(hostRestriction
              ? { notesRequestHostRestriction: hostRestriction }
              : {}),
          },
        },
      },
    ],
  };
  const lifetime = new AbortController();
  const issuer = beginRequestOperationIssuer({
    runtime,
    message,
    current: () => !lifetime.signal.aborted,
  });
  const source = {
    currentText: text,
    modelNotesField,
    interpretation: handler.plan.notesRequestInterpretation,
    hostRestriction,
  };
  if (!issuer) throw Error("Host issuer missing");
  commitNotesRequestRestriction(issuer, {
    classification:
      hostRestriction?.classification ??
      handler.plan.notesRequestEffect ??
      "unresolved",
    source,
    currentSource: () => source,
    interpretation: hostRestriction
      ? { status: "contradictory", operations: [] }
      : handler.plan.notesRequestInterpretation,
  });
  bindTaskExtractionContext(state, message, context, context, runtime, issuer);
  const before = service.snapshot();
  writes.mockClear();
  notesLookup.mockClear();
  events.mockClear();
  const outcomes: unknown[] = [];
  const diagnostics = () => ({
    executorIsSource: executePlannedToolCall === sourceExecutePlannedToolCall,
    issuerIsSource:
      beginRequestOperationIssuer === sourceBeginRequestOperationIssuer,
    issuerGetterIsSource:
      getRequestOperationIssuer === sourceGetRequestOperationIssuer,
    hostIssuerPresent: !!getRequestOperationIssuer(runtime, message),
    sourceIssuerPresent: !!sourceGetRequestOperationIssuer(runtime, message),
    restriction: readTaskExtractionNotesRestriction(state, message, runtime),
    interpretationStatus:
      handler.plan.notesRequestInterpretation?.status ?? "missing",
    interpretedOperations:
      handler.plan.notesRequestInterpretation?.operations ?? [],
    outcomes,
  });
  const execute = async (name: string, params: Record<string, unknown>) => {
    const result = await executePlannedToolCall(
      runtime,
      {
        message,
        state,
        userRoles: ["OWNER"],
        activeContexts: ["notes"],
        replyOwner: "planner",
      },
      { name, params },
    );
    outcomes.push({
      operation: /^[A-Z][A-Z0-9_]{0,95}$/.test(name) ? name : "UNKNOWN",
      ...actionDiagnostic(result),
    });
    if (outcomes.length > 8) outcomes.shift();
    return result;
  };
  return {
    runtime,
    message,
    state,
    context,
    service,
    historical,
    writes,
    notesLookup,
    events,
    before,
    execute,
    issuer,
    retire: () => lifetime.abort(),
    diagnostics,
    hostRestriction,
    rawNotesEffect: fieldRun.parsed.notesRequestEffect,
  };
}

describe("request-bound Notes negative constraints", () => {
  it("binds completion only to the actual current host and registered canonical operation", async () => {
    const f = await fixture(
      {
        classification: "mutation_requested",
        operations: ["create", "delete"],
      },
      "create a launch note and remove the old note",
    );
    const other = await fixture(
      {
        classification: "mutation_requested",
        operations: ["create", "delete"],
      },
      "create a launch note and remove the old note",
      f.message,
    );
    try {
      const rejected = await f.execute("NOTES", { action: "create" });
      expect(readNotesMutationCompletion(rejected, f.issuer)).toMatchObject({
        rejected: true,
        status: "current",
        dispatch: { child: "NOTES_CREATE" },
      });
      expect(
        readNotesMutationCompletion(rejected, other.issuer),
      ).toBeUndefined();
      const serialized = JSON.parse(JSON.stringify(rejected));
      expect(readNotesMutationCompletion(serialized, f.issuer)).toBeUndefined();
      const projected = actionResultToPlannerToolResult(rejected, {
        requestOperationIssuer: f.issuer,
      });
      const unowned = JSON.parse(JSON.stringify(rejected));
      expect(copyRequestOperationResult(rejected, unowned)).toBe(false);
      expect(
        bindRequestOperationProjection(rejected, unowned, other.issuer),
      ).toBe(false);
      expect(readNotesMutationCompletion(unowned, f.issuer)).toBeUndefined();
      expect(readNotesMutationCompletion(projected, f.issuer)?.rejected).toBe(
        true,
      );
      const differentOperation = await f.execute("NOTES_DELETE", {
        noteId: f.historical.value.id,
      });
      expect(
        isMatchingNotesMutationCompletion(
          projected,
          differentOperation,
          f.issuer,
        ),
      ).toBe(false);
      const foreignSuccess = await other.execute("NOTES_CREATE", {
        content: "Foreign launch",
      });
      expect(
        isMatchingNotesMutationCompletion(projected, foreignSuccess, f.issuer),
      ).toBe(false);
      const corrected = await f.execute("NOTES_CREATE", { content: "Launch" });
      expect(
        isMatchingNotesMutationCompletion(projected, corrected, f.issuer),
      ).toBe(true);
      const replay = await f.execute("NOTES_CREATE", { content: "Launch" });
      expect(
        replay.effectReceipts?.some(
          (receipt) =>
            receipt.outcome === "noop" && receipt.idempotency.replayed,
        ),
      ).toBe(true);
      expect(
        isMatchingNotesMutationCompletion(projected, replay, f.issuer),
      ).toBe(true);
      expect(
        isMatchingNotesMutationCompletion(
          projected,
          JSON.parse(JSON.stringify(corrected)),
          f.issuer,
        ),
      ).toBe(false);
      const wrongTarget = {
        ...corrected,
        data: { ...corrected.data, noteId: "wrong-target" },
      };
      expect(copyRequestOperationResult(corrected, wrongTarget)).toBe(false);
      let getterCalls = 0;
      const accessorTarget = { ...corrected, data: { ...corrected.data } };
      Object.defineProperty(accessorTarget.data, "op", {
        get() {
          getterCalls++;
          return "create";
        },
      });
      expect(copyRequestOperationResult(corrected, accessorTarget)).toBe(false);
      expect(
        bindRequestOperationProjection(corrected, accessorTarget, f.issuer),
      ).toBe(false);
      expect(getterCalls).toBe(0);
    } finally {
      await f.service.stop();
      await other.service.stop();
    }
  });

  it("keeps the actual host adapter's registered-dispatch projection bound to the issuer", async () => {
    const f = await fixture(
      { classification: "mutation_requested", operations: ["create"] },
      "create a launch note",
    );
    const execute = (params: Record<string, unknown>) =>
      executeV5PlannedToolCall({
        runtime: f.runtime,
        toolCall: { name: "NOTES_CREATE", params },
        plannerContext: f.context,
        executorCtx: {
          message: f.message,
          state: f.state,
          userRoles: ["OWNER"],
          activeContexts: ["notes"],
          replyOwner: "planner",
        },
        plannerRuntime: {
          useModel: async () => {
            throw new Error(
              "The explicit registered operation needs no sub-planner",
            );
          },
        },
      });
    try {
      const rejected = await execute({});
      expect(rejected.registeredSubaction?.child).toBe("NOTES_CREATE");
      expect(readNotesMutationCompletion(rejected, f.issuer)).toMatchObject({
        rejected: true,
        status: "current",
      });
      const corrected = await execute({ content: "Launch" });
      expect(
        isMatchingNotesMutationCompletion(rejected, corrected, f.issuer),
      ).toBe(true);
      expect(f.writes).toHaveBeenCalledTimes(1);
    } finally {
      await f.service.stop();
    }
  });

  it("retains the original rejection when a same-key unbound unknown failure follows it", async () => {
    const f = await fixture(
      { classification: "mutation_requested", operations: ["create"] },
      "create a launch note",
    );
    let requests = 0;
    let executions = 0;
    try {
      const result = await diagnosedPlanner(f, {
        context: f.context,
        tools: [
          {
            name: "NOTES_CREATE",
            parameters: {
              type: "object",
              properties: { content: { type: "string" } },
            },
          },
        ],
        runtime: {
          useModel: async () => {
            requests++;
            if (requests > 2) throw new Error("Unknown outcome was replayed");
            return {
              text: "",
              toolCalls: [
                {
                  name: "NOTES_CREATE",
                  id: "same-key-create",
                  arguments: {
                    eliza_turn_scope:
                      requests === 1 ? "more_work_pending" : "final",
                  },
                },
              ],
            };
          },
        },
        executeToolCall: async (call) => {
          executions++;
          const actual = actionResultToPlannerToolResult(
            await f.execute(call.name, call.params ?? {}),
            { requestOperationIssuer: f.issuer },
          );
          return executions === 1
            ? actual
            : {
                ...actual,
                data: {
                  ...actual.data,
                  outcomeUnknown: true,
                  reconciliationRequired: true,
                },
              };
        },
        evaluate: async () => ({
          success: true,
          decision: "FINISH",
          thought:
            "Optimistic output cannot erase the original required refusal.",
          messageToUser: "Saved the launch note.",
        }),
      });
      expect(requests).toBe(2);
      expect(result.evaluator?.success).not.toBe(true);
      expect(result.trajectory.steps).toHaveLength(2);
      expect(
        readNotesMutationCompletion(
          result.trajectory.steps[0].result ?? {},
          f.issuer,
        )?.rejected,
      ).toBe(true);
      expect(result.finalMessage).not.toBe("Saved the launch note.");
      expect(f.writes).not.toHaveBeenCalled();
    } finally {
      await f.service.stop();
    }
  });

  it("keeps a malformed requested patch pending through a read until the same registered patch succeeds", async () => {
    const f = await fixture(
      { classification: "mutation_requested", operations: ["get", "patch"] },
      "patch the ideas note body",
    );
    const target = { kind: "id", value: f.historical.value.id };
    let requests = 0;
    const executed: string[] = [];
    try {
      const result = await diagnosedPlanner(f, {
        context: f.context,
        tools: [
          {
            name: "NOTES_PATCH",
            parameters: { type: "object", properties: {} },
          },
          {
            name: "NOTES_GET",
            parameters: {
              type: "object",
              properties: { noteId: { type: "string" } },
            },
          },
        ],
        runtime: {
          useModel: async () => {
            requests++;
            if (requests === 1)
              return {
                text: "",
                toolCalls: [
                  {
                    name: "NOTES_PATCH",
                    id: "patch-invalid",
                    arguments: {
                      target,
                      changes: [],
                      eliza_turn_scope: "more_work_pending",
                    },
                  },
                ],
              };
            if (requests === 2)
              return {
                text: "",
                toolCalls: [
                  {
                    name: "NOTES_GET",
                    id: "patch-unrelated-read",
                    arguments: {
                      noteId: f.historical.value.id,
                      eliza_turn_scope: "final",
                    },
                  },
                ],
              };
            if (requests === 3)
              return {
                text: "",
                toolCalls: [
                  {
                    name: "NOTES_PATCH",
                    id: "patch-corrected",
                    arguments: {
                      target,
                      changes: [{ field: "body", value: "Updated body" }],
                      expectedRevision: f.service.snapshot().revision,
                      eliza_turn_scope: "final",
                    },
                  },
                ],
              };
            throw new Error("Unexpected patch retry");
          },
        },
        executeToolCall: async (call) => {
          executed.push(call.name);
          return actionResultToPlannerToolResult(
            await f.execute(call.name, call.params ?? {}),
            { requestOperationIssuer: f.issuer },
          );
        },
        evaluate: async () => ({
          success: true,
          decision: "FINISH",
          thought:
            "The host must establish completion before this verdict is accepted.",
          messageToUser: "The note is available.",
        }),
      });
      expect(executed).toEqual(["NOTES_PATCH", "NOTES_GET", "NOTES_PATCH"]);
      expect(result.terminalFailure).toBeUndefined();
      const updated = f.service.getNote(f.historical.value.id);
      expect(updated.body).toBe("\nUpdated body");
      expect(projectNoteForModel(updated)).toMatchObject({
        title: f.historical.value.title,
        bodySeparator: "\n",
        body: "Updated body",
      });
      expect(f.writes).toHaveBeenCalledTimes(1);
      const rejected = result.trajectory.steps[0].result;
      const corrected = result.trajectory.steps[2].result;
      if (!rejected || !corrected)
        throw new Error("Expected actual patch trajectory");
      expect(
        readNotesMutationCompletion(rejected, f.issuer)?.dispatch?.value,
      ).toBe("patch");
      expect(
        isMatchingNotesMutationCompletion(rejected, corrected, f.issuer),
      ).toBe(true);
      const differentSchema = await f.execute("NOTES_UPDATE", {
        noteId: f.historical.value.id,
        textEdit: {
          field: "title",
          oldText: "ideas",
          newText: "ideas revised",
        },
      });
      expect(differentSchema.success).toBe(true);
      expect(
        isMatchingNotesMutationCompletion(rejected, differentSchema, f.issuer),
      ).toBe(false);
    } finally {
      await f.service.stop();
    }
  });

  it("keeps target A pending after an owner-bound patch succeeds for target B", async () => {
    const f = await fixture(
      { classification: "mutation_requested", operations: ["patch"] },
      "patch the ideas note body",
    );
    const other = await f.service.createNoteWithCommit({
      content: "other\nother body",
    });
    const initial = f.service.snapshot();
    f.writes.mockClear();
    const targetA = { kind: "id", value: f.historical.value.id };
    const targetB = { kind: "id", value: other.value.id };
    let requests = 0;
    const executed: string[] = [];
    try {
      const result = await diagnosedPlanner(f, {
        context: f.context,
        tools: [
          {
            name: "NOTES_PATCH",
            parameters: { type: "object", properties: {} },
          },
          {
            name: "NOTES_GET",
            parameters: {
              type: "object",
              properties: { noteId: { type: "string" } },
            },
          },
        ],
        runtime: {
          useModel: async () => {
            requests++;
            if (requests === 1)
              return {
                text: "",
                toolCalls: [
                  {
                    name: "NOTES_PATCH",
                    id: "target-a-invalid",
                    arguments: {
                      target: targetA,
                      changes: [{ field: "body", value: "A updated" }],
                      expectedRevision: -1,
                      eliza_turn_scope: "more_work_pending",
                    },
                  },
                ],
              };
            if (requests === 2)
              return {
                text: "",
                toolCalls: [
                  {
                    name: "NOTES_PATCH",
                    id: "target-b-success",
                    arguments: {
                      target: targetB,
                      changes: [{ field: "body", value: "B updated" }],
                      expectedRevision: initial.revision,
                      eliza_turn_scope: "final",
                    },
                  },
                ],
              };
            if (requests === 3)
              return {
                text: "",
                toolCalls: [
                  {
                    name: "NOTES_GET",
                    id: "target-a-read",
                    arguments: {
                      noteId: f.historical.value.id,
                      eliza_turn_scope: "final",
                    },
                  },
                ],
              };
            if (requests === 4)
              return {
                text: "",
                toolCalls: [
                  {
                    name: "NOTES_PATCH",
                    id: "target-a-corrected",
                    arguments: {
                      target: targetA,
                      changes: [{ field: "body", value: "A updated" }],
                      expectedRevision: f.service.snapshot().revision,
                      eliza_turn_scope: "final",
                    },
                  },
                ],
              };
            throw new Error("Unexpected target repair round");
          },
        },
        executeToolCall: async (call) => {
          executed.push(call.name);
          return actionResultToPlannerToolResult(
            await f.execute(call.name, call.params ?? {}),
            { requestOperationIssuer: f.issuer },
          );
        },
        evaluate: async () => ({
          success: true,
          decision: "FINISH",
          thought: "A different target cannot discharge the rejected target.",
          messageToUser: "The requested note is available.",
        }),
      });
      expect(executed).toEqual([
        "NOTES_PATCH",
        "NOTES_PATCH",
        "NOTES_GET",
        "NOTES_PATCH",
      ]);
      const updatedA = f.service.getNote(f.historical.value.id);
      const updatedB = f.service.getNote(other.value.id);
      expect(updatedA.body).toBe("\nA updated");
      expect(updatedB.body).toBe("\nB updated");
      expect(projectNoteForModel(updatedA)).toMatchObject({
        title: f.historical.value.title,
        bodySeparator: "\n",
        body: "A updated",
      });
      expect(projectNoteForModel(updatedB)).toMatchObject({
        title: other.value.title,
        bodySeparator: "\n",
        body: "B updated",
      });
      expect(result.trajectory.steps[1].result?.success).toBe(true);
      expect(result.trajectory.steps[1].result?.data?.notesRevision).not.toBe(
        result.trajectory.steps[3].result?.data?.notesRevision,
      );
      expect(f.writes).toHaveBeenCalledTimes(2);
    } finally {
      await f.service.stop();
    }
  });

  it("does not turn an accidental DELETE refusal into a requirement on a CREATE request", async () => {
    const f = await fixture(
      { classification: "mutation_requested", operations: ["create"] },
      "create a new launch note",
    );
    let requests = 0;
    const executed: string[] = [];
    try {
      const result = await diagnosedPlanner(f, {
        context: f.context,
        tools: [
          {
            name: "NOTES_DELETE",
            parameters: {
              type: "object",
              properties: { noteId: { type: "string" } },
            },
          },
          {
            name: "NOTES_CREATE",
            parameters: {
              type: "object",
              properties: { content: { type: "string" } },
            },
          },
        ],
        runtime: {
          useModel: async () => {
            requests++;
            if (requests === 1)
              return {
                text: "",
                toolCalls: [
                  {
                    name: "NOTES_DELETE",
                    id: "unrequested-delete",
                    arguments: { eliza_turn_scope: "more_work_pending" },
                  },
                ],
              };
            if (requests === 2)
              return {
                text: "",
                toolCalls: [
                  {
                    name: "NOTES_CREATE",
                    id: "requested-create",
                    arguments: { content: "Launch", eliza_turn_scope: "final" },
                  },
                ],
              };
            throw new Error("An unrequested DELETE became mandatory");
          },
        },
        executeToolCall: async (call) => {
          executed.push(call.name);
          return actionResultToPlannerToolResult(
            await f.execute(call.name, call.params ?? {}),
            { requestOperationIssuer: f.issuer },
          );
        },
        evaluate: async () => ({
          success: true,
          decision: "FINISH",
          thought: "Only the original create outcome belongs to this request.",
          messageToUser: "The launch note is available.",
        }),
      });
      expect(executed).toEqual(["NOTES_DELETE", "NOTES_CREATE"]);
      expect(requests).toBe(2);
      const refused = result.trajectory.steps[0].result;
      expect(
        readNotesMutationCompletion(refused ?? {}, f.issuer),
      ).toMatchObject({
        rejected: false,
        outsideRequestRejection: true,
        status: "current",
      });
      expect(refused?.success).toBe(false);
      expect(f.service.snapshot().notes).toHaveLength(
        f.before.notes.length + 1,
      );
      expect(f.service.getNote(f.historical.value.id)).toBeDefined();
      expect(f.writes).toHaveBeenCalledTimes(1);
    } finally {
      await f.service.stop();
    }
  });

  it("uses registered original-request routes only to veto a contradictory interpretation", async () => {
    const f = await fixture(
      { classification: "mutation_requested", operations: ["delete"] },
      "create a note: launch",
    );
    try {
      expect(f.rawNotesEffect).toBe("mutation_requested");
      expect(f.hostRestriction).toMatchObject({
        classification: "unresolved",
        reason: "registered-current-mutation-route",
        operations: ["create"],
      });
      expect(f.hostRestriction?.routeIds).toContain("notes.create");
      const result = await f.execute("NOTES_DELETE", {});
      expect(result.data?.code).toBe("REQUEST_OPERATION_UNRESOLVED");
      expect(
        readNotesMutationCompletion(result, f.issuer)?.outsideRequestRejection,
      ).not.toBe(true);
      expect(f.writes).not.toHaveBeenCalled();
    } finally {
      await f.service.stop();
    }
  });

  it("accepts a handled compound interpretation without English registered-route coverage", async () => {
    const f = await fixture(
      { classification: "mutation_requested", operations: ["list", "create"] },
      "lee la nota de ideas y crea una nota de lanzamiento",
    );
    try {
      expect(f.hostRestriction).toBeUndefined();
      const result = await f.execute("NOTES_CREATE", {});
      expect(readNotesMutationCompletion(result, f.issuer)).toMatchObject({
        rejected: true,
        status: "current",
      });
      expect(f.writes).not.toHaveBeenCalled();
    } finally {
      await f.service.stop();
    }
  });

  it("does not infer required operations from a legacy classification", async () => {
    const f = await fixture("mutation_requested", "create a new launch note");
    try {
      const refused = await f.execute("NOTES_CREATE", {});
      expect(readNotesMutationCompletion(refused, f.issuer)).toMatchObject({
        rejected: false,
        outsideRequestRejection: false,
        ambiguousRejection: true,
      });
      expect(f.writes).not.toHaveBeenCalled();
    } finally {
      await f.service.stop();
    }
  });

  it("does not label an applied unrequested effect as a harmless refusal", async () => {
    const f = await fixture(
      { classification: "mutation_requested", operations: ["create"] },
      "create a new launch note",
    );
    try {
      // Interpretation is not an execution grant or a replacement permission
      // rule: this exercises the existing owner policy and retains its effect.
      const result = await f.execute("NOTES_DELETE", {
        noteId: f.historical.value.id,
      });
      expect(result.success).toBe(true);
      expect(
        result.effectReceipts?.some((receipt) => receipt.outcome === "applied"),
      ).toBe(true);
      expect(
        readNotesMutationCompletion(result, f.issuer)?.outsideRequestRejection,
      ).toBe(false);
      expect(f.writes).toHaveBeenCalledTimes(1);
    } finally {
      await f.service.stop();
    }
  });

  // Stage 1 names the requested edit as update or patch; the planner may run
  // the other registered entry point for the same stored-note edit.
  async function appliedEditFinishes(
    interpreted: "update" | "patch",
    text: string,
    tool: "NOTES_UPDATE" | "NOTES_PATCH",
    params: (f: Awaited<ReturnType<typeof fixture>>) => Record<string, unknown>,
  ) {
    const f = await fixture(
      { classification: "mutation_requested", operations: [interpreted] },
      text,
    );
    try {
      const result = await diagnosedPlanner(f, {
        context: f.context,
        tools: [{ name: tool, parameters: { type: "object", properties: {} } }],
        runtime: {
          useModel: async () => ({
            text: "",
            toolCalls: [
              {
                name: tool,
                id: "requested-edit",
                arguments: { ...params(f), eliza_turn_scope: "final" },
              },
            ],
          }),
        },
        executeToolCall: async (call) =>
          actionResultToPlannerToolResult(
            await f.execute(call.name, call.params ?? {}),
            { requestOperationIssuer: f.issuer },
          ),
        evaluate: async () => ({
          success: true,
          decision: "FINISH",
          thought: "The requested edit applied.",
          messageToUser: "The ideas note now has the launch date.",
        }),
      });
      const step = result.trajectory.steps[0]?.result;
      if (!step) throw new Error("The edit step did not run");
      expect(step.success).toBe(true);
      expect(
        step.effectReceipts?.some((receipt) => receipt.outcome === "applied"),
      ).toBe(true);
      expect(readNotesMutationCompletion(step, f.issuer)).toMatchObject({
        requested: true,
        rejected: false,
        outsideRequestRejection: false,
        status: "current",
      });
      expect(f.service.getNote(f.historical.value.id).body).toContain(
        "March 3",
      );
      expect(f.writes).toHaveBeenCalledTimes(1);
      expect(result.evaluator?.success).toBe(true);
      expect(result.finalMessage).toBe(
        "The ideas note now has the launch date.",
      );
    } finally {
      await f.service.stop();
    }
  }

  it("finishes an applied append when the request was interpreted as update", async () => {
    await appliedEditFinishes(
      "update",
      "update my ideas note: add the launch date",
      "NOTES_PATCH",
      (f) => ({
        target: { kind: "id", value: f.historical.value.id },
        changes: [],
        textEdit: {
          action: "append",
          field: "body",
          text: "\nlaunch date: March 3",
        },
        expectedRevision: f.before.revision,
      }),
    );
  });

  it("finishes an applied text edit when the request was interpreted as patch", async () => {
    await appliedEditFinishes(
      "patch",
      "append the launch date to my ideas note",
      "NOTES_UPDATE",
      (f) => ({
        noteId: f.historical.value.id,
        textEdit: {
          field: "body",
          oldText: "launch on a Tuesday",
          newText: "launch on a Tuesday, March 3",
        },
      }),
    );
  });

  it("does not dismiss an unrequested operation with an uncertain outcome", async () => {
    const f = await fixture(
      { classification: "mutation_requested", operations: ["create"] },
      "create a new launch note",
    );
    const action = f.runtime.actions.find(
      (candidate) => candidate.name === "NOTES_DELETE",
    );
    if (!action) throw new Error("Registered delete missing");
    const handler = action.handler;
    action.handler = async () => ({
      success: false,
      failureProvenance: {
        kind: "handler_error",
        boundary: "handler",
        code: "UNCERTAIN_DELETE",
        retryable: true,
      },
      data: {
        acceptance: "rejected",
        executionStatus: "not_started",
        executed: false,
        outcomeUnknown: true,
        reconciliationRequired: true,
      },
    });
    try {
      const result = await f.execute("NOTES_DELETE", {
        noteId: f.historical.value.id,
      });
      expect(
        readNotesMutationCompletion(result, f.issuer)?.outsideRequestRejection,
      ).toBe(false);
      expect(f.writes).not.toHaveBeenCalled();
    } finally {
      action.handler = handler;
      await f.service.stop();
    }
  });

  it("retains an issued failure when outcome metadata changes and cannot self-brand a clone", async () => {
    const f = await fixture(
      { classification: "mutation_requested", operations: ["create"] },
      "create a launch note",
    );
    try {
      const rejected = await f.execute("NOTES_CREATE", {});
      const data = rejected.data;
      if (!data) throw new Error("Expected actual schema refusal");
      data.executionStatus = "completed";
      expect(readNotesMutationCompletion(rejected, f.issuer)).toMatchObject({
        rejected: true,
        status: "changed",
      });
      data.executionStatus = "not_started";
      expect(readNotesMutationCompletion(rejected, f.issuer)?.status).toBe(
        "changed",
      );
      expect(
        copyRequestOperationResult(rejected, {
          ...rejected,
          data: { ...data },
        }),
      ).toBe(false);
      const corrected = await f.execute("NOTES_CREATE", { content: "Launch" });
      expect(
        isMatchingNotesMutationCompletion(rejected, corrected, f.issuer),
      ).toBe(false);
    } finally {
      await f.service.stop();
    }
  });

  it.each(["registration", "issuer", "validate"] as const)(
    "does not erase an issued failure after %s retirement",
    async (kind) => {
      const f = await fixture(
        { classification: "mutation_requested", operations: ["create"] },
        "create a launch note",
      );
      const action = f.runtime.actions.find(
        (candidate) => candidate.name === "NOTES_CREATE",
      );
      if (!action) {
        await f.service.stop();
        throw new Error("Expected registered NOTES_CREATE action");
      }
      const validate = action.validate;
      try {
        const rejected = await f.execute("NOTES_CREATE", {});
        expect(readNotesMutationCompletion(rejected, f.issuer)?.status).toBe(
          "current",
        );
        if (kind === "issuer") f.retire();
        else if (kind === "validate") action.validate = async () => true;
        else
          f.runtime.actions = f.runtime.actions.map((candidate) =>
            candidate.name === "NOTES_CREATE" ? { ...candidate } : candidate,
          );
        expect(readNotesMutationCompletion(rejected, f.issuer)).toMatchObject({
          rejected: true,
          status: "stale",
        });
        if (kind === "validate") {
          action.validate = validate;
          expect(readNotesMutationCompletion(rejected, f.issuer)?.status).toBe(
            "stale",
          );
        }
        if (kind === "registration") {
          const replacementSuccess = await f.execute("NOTES_CREATE", {
            content: "Launch",
          });
          expect(
            isMatchingNotesMutationCompletion(
              rejected,
              replacementSuccess,
              f.issuer,
            ),
          ).toBe(false);
        }
      } finally {
        action.validate = validate;
        await f.service.stop();
      }
    },
  );

  it.each(["registration", "issuer", "result"] as const)(
    "stops without another round when a recorded failure loses %s integrity",
    async (kind) => {
      const f = await fixture(
        { classification: "mutation_requested", operations: ["create"] },
        "create a launch note",
      );
      let requests = 0;
      try {
        const result = await diagnosedPlanner(f, {
          context: f.context,
          tools: [
            {
              name: "NOTES_CREATE",
              parameters: {
                type: "object",
                properties: { content: { type: "string" } },
              },
            },
          ],
          runtime: {
            useModel: async () => {
              requests++;
              if (requests > 1) throw new Error("Stale operation was retried");
              return {
                text: "",
                toolCalls: [
                  {
                    name: "NOTES_CREATE",
                    id: "integrity-create",
                    arguments: { eliza_turn_scope: "more_work_pending" },
                  },
                ],
              };
            },
          },
          executeToolCall: async (call) => {
            const projected = actionResultToPlannerToolResult(
              await f.execute(call.name, call.params ?? {}),
              { requestOperationIssuer: f.issuer },
            );
            if (kind === "issuer") f.retire();
            else if (kind === "registration")
              f.runtime.actions = f.runtime.actions.map((action) =>
                action.name === "NOTES_CREATE" ? { ...action } : action,
              );
            else if (projected.data)
              projected.data.executionStatus = "completed";
            return projected;
          },
          evaluate: async () => ({
            success: true,
            decision: "FINISH",
            thought:
              "Optimistic completion must not erase the original refusal.",
            messageToUser: "Saved the launch note.",
          }),
        });
        expect(requests).toBe(1);
        expect(result.evaluator?.success).toBe(false);
        expect(result.evaluator?.requestFullyCovered).toBe(false);
        expect(
          result.trajectory.steps.some(
            (step) => step.toolCall?.name === "NOTES_CREATE",
          ),
        ).toBe(true);
        expect(result.finalMessage).not.toBe("Saved the launch note.");
        expect(f.writes).not.toHaveBeenCalled();
      } finally {
        await f.service.stop();
      }
    },
  );

  it.each(["readOnlyOperation", "coachingFailure"] as const)(
    "does not force another round for an optional %s refusal",
    async (flag) => {
      const f = await fixture("read_only", "explain how to find my notes");
      let requests = 0;
      f.runtime.actions.push({
        name: "OPTIONAL_CONTEXT_READ",
        description: "Optional fixture observation",
        validate: async () => true,
        handler: async () => ({
          success: false,
          failureProvenance: {
            kind: "handler_error",
            boundary: "handler",
            code: "OPTIONAL_CONTEXT_UNAVAILABLE",
            retryable: false,
          },
          data: {
            [flag]: true,
            acceptance: "rejected",
            executionStatus: "not_started",
            executed: false,
          },
        }),
      });
      try {
        const result = await diagnosedPlanner(f, {
          context: f.context,
          tools: [
            {
              name: "OPTIONAL_CONTEXT_READ",
              parameters: { type: "object", properties: {} },
            },
          ],
          runtime: {
            useModel: async () => {
              requests++;
              if (requests > 1) throw new Error("Unnecessary optional retry");
              return {
                text: "",
                toolCalls: [
                  {
                    name: "OPTIONAL_CONTEXT_READ",
                    id: "optional-read",
                    arguments: { eliza_turn_scope: "final" },
                  },
                ],
              };
            },
          },
          executeToolCall: async (call) =>
            actionResultToPlannerToolResult(
              await f.execute(call.name, call.params ?? {}),
              { requestOperationIssuer: f.issuer },
            ),
          evaluate: async () => ({
            success: true,
            decision: "FINISH",
            thought:
              "The optional probe is unnecessary for this coaching answer.",
            messageToUser: "You can open Notes to review your saved notes.",
          }),
        });
        expect(requests).toBe(1);
        expect(result.status).toBe("finished");
        expect(f.writes).not.toHaveBeenCalled();
      } finally {
        await f.service.stop();
      }
    },
  );

  it.each([
    "values-executed",
    "top-unknown",
    "values-status",
    "both-values-unknown",
    "both-values-executed",
  ] as const)(
    "does not qualify contradictory %s evidence for recovery",
    async (kind) => {
      const f = await fixture(
        { classification: "mutation_requested", operations: ["create"] },
        "create a launch note",
      );
      const action = f.runtime.actions.find(
        (candidate) => candidate.name === "NOTES_CREATE",
      );
      if (!action) throw new Error("Actual registered create missing");
      const handler = action.handler;
      action.handler = async () => ({
        success: false,
        failureProvenance: {
          kind: "handler_error",
          boundary: "handler",
          code: "FIXTURE_CONTRADICTION",
          retryable: true,
        },
        ...(kind === "top-unknown" ? { outcomeUnknown: true } : {}),
        ...(kind === "both-values-unknown" || kind === "both-values-executed"
          ? { values: {} }
          : {}),
        data: {
          acceptance: "rejected",
          executionStatus: "not_started",
          executed: false,
          ...(kind === "values-executed" || kind === "both-values-executed"
            ? { values: { executed: true } }
            : kind === "both-values-unknown"
              ? {
                  values: {
                    outcomeUnknown: true,
                    reconciliationRequired: true,
                  },
                }
              : kind === "values-status"
                ? {
                    values: {
                      acceptance: "applied",
                      executionStatus: "completed",
                    },
                  }
                : {}),
        },
      });
      try {
        const result = await f.execute("NOTES_CREATE", { content: "Launch" });
        expect(
          readNotesMutationCompletion(result, f.issuer)?.rejected,
        ).not.toBe(true);
        expect(
          readNotesMutationCompletion(result, f.issuer)
            ?.outsideRequestRejection,
        ).not.toBe(true);
        if (kind === "both-values-unknown" || kind === "both-values-executed") {
          const projected = actionResultToPlannerToolResult(result, {
            requestOperationIssuer: f.issuer,
          });
          expect(readNotesMutationCompletion(projected, f.issuer)?.status).toBe(
            "changed",
          );
        }
        expect(f.writes).not.toHaveBeenCalled();
      } finally {
        action.handler = handler;
        await f.service.stop();
      }
    },
  );

  it.each(["unknown", "input"] as const)(
    "preserves an honest stopped outcome for %s without replay",
    async (kind) => {
      const f = await fixture(
        { classification: "mutation_requested", operations: ["create"] },
        "create a launch note",
      );
      const action = f.runtime.actions.find(
        (candidate) => candidate.name === "NOTES_CREATE",
      );
      if (!action) throw new Error("Actual registered create missing");
      const handler = action.handler;
      let requests = 0;
      action.handler = async () => ({
        success: false,
        failureProvenance: {
          kind: "handler_error",
          boundary: "handler",
          code: "FIXTURE_BLOCKED",
          retryable: true,
        },
        data: {
          acceptance: "rejected",
          executionStatus: "not_started",
          executed: false,
          ...(kind === "unknown"
            ? { outcomeUnknown: true, reconciliationRequired: true }
            : { awaitingUserInput: true }),
        },
      });
      try {
        const result = await diagnosedPlanner(f, {
          context: f.context,
          tools: [
            {
              name: "NOTES_CREATE",
              parameters: {
                type: "object",
                properties: { content: { type: "string" } },
              },
            },
          ],
          runtime: {
            useModel: async () => {
              requests++;
              if (requests > 1) throw new Error("Blocked effect replay");
              return {
                text: "",
                toolCalls: [
                  {
                    name: "NOTES_CREATE",
                    id: "stopped-create",
                    arguments: { content: "Launch", eliza_turn_scope: "final" },
                  },
                ],
              };
            },
          },
          executeToolCall: async (call) =>
            actionResultToPlannerToolResult(
              await f.execute(call.name, call.params ?? {}),
              { requestOperationIssuer: f.issuer },
            ),
          evaluate: async () => ({
            success: false,
            decision: "FINISH",
            thought: "The owner must resolve this blocker before any effect.",
            messageToUser: "I couldn’t complete that Notes change.",
          }),
        });
        expect(requests).toBe(1);
        expect(result.evaluator?.success).toBe(false);
        expect(f.writes).not.toHaveBeenCalled();
      } finally {
        action.handler = handler;
        await f.service.stop();
      }
    },
  );

  it.each([
    "what did I write about ideas?",
    "read my note saying create a note: launch",
    "did I create a note about ideas?",
    '"create a note: launch"',
  ])(
    "does not turn history, quoted commands or reads into a mutation route: %s",
    async (text) => {
      const f = await fixture("read_only", text);
      try {
        expect(f.rawNotesEffect).toBe("read_only");
        expect(f.hostRestriction).toBeUndefined();
        const read = await f.execute("NOTES_GET", {
          noteId: f.historical.value.id,
        });
        expect(read.success, JSON.stringify(f.diagnostics())).toBe(true);
        expect(f.writes).not.toHaveBeenCalled();
      } finally {
        await f.service.stop();
      }
    },
  );

  it("keeps a registered create contradiction unresolved while preserving the raw model field", async () => {
    const f = await fixture(
      "read_only",
      "create a new note saying Launch: Draft invitation",
    );
    let requests = 0;
    try {
      expect(f.rawNotesEffect).toBe("read_only");
      expect(f.hostRestriction).toMatchObject({
        classification: "unresolved",
        reason: "registered-current-mutation-route",
        routeIds: ["notes.create"],
        operations: ["create"],
      });
      const result = await diagnosedPlanner(f, {
        context: f.context,
        tools: [
          {
            name: "NOTES_CREATE",
            parameters: {
              type: "object",
              properties: { content: { type: "string" } },
            },
          },
          {
            name: "NOTES_GET",
            parameters: {
              type: "object",
              properties: { noteId: { type: "string" } },
            },
          },
        ],
        runtime: {
          useModel: async () => {
            requests++;
            if (requests === 1)
              return {
                text: "",
                toolCalls: [
                  {
                    name: "NOTES_CREATE",
                    id: "contradictory-create",
                    arguments: {
                      content: "Launch\nDraft invitation",
                      eliza_turn_scope: "more_work_pending",
                    },
                  },
                ],
              };
            if (requests === 2)
              return {
                text: "",
                toolCalls: [
                  {
                    name: "NOTES_GET",
                    id: "unrelated-read",
                    arguments: {
                      noteId: f.historical.value.id,
                      eliza_turn_scope: "final",
                    },
                  },
                ],
              };
            return JSON.stringify({
              completed: true,
              toolCalls: [],
              messageToUser: "Saved the launch note.",
            });
          },
        },
        executeToolCall: async (call, current) => {
          bindTaskExtractionContext(
            f.state,
            f.message,
            current.trajectory.context,
            current.trajectory.context,
            f.runtime,
            getRequestOperationIssuer(f.runtime, f.message),
          );
          const result = await f.execute(call.name, call.params ?? {});
          if (call.name === "NOTES_CREATE")
            expect(result.data?.code).toBe("REQUEST_OPERATION_UNRESOLVED");
          return actionResultToPlannerToolResult(result, {
            requestOperationIssuer: f.issuer,
          });
        },
        evaluate: async ({ trajectory }) =>
          trajectory.steps.some(
            (step) =>
              step.toolCall?.name === "NOTES_GET" && step.result?.success,
          )
            ? {
                success: true,
                decision: "FINISH" as const,
                thought: "Controlled optimistic verdict after the read.",
                requestFullyCovered: true,
                messageToUser: "Saved the launch note.",
              }
            : {
                success: false,
                decision: "CONTINUE" as const,
                thought: "Continue to the read.",
              },
      });
      expect(f.writes).not.toHaveBeenCalled();
      expect(f.service.snapshot()).toEqual(f.before);
      expect(result.evaluator?.success).not.toBe(true);
      expect(result.evaluator?.requestFullyCovered).not.toBe(true);
      expect(result.finalMessage).not.toBe("Saved the launch note.");
    } finally {
      await f.service.stop();
    }
  });

  it("does not treat a missing registered route target as write permission", async () => {
    const f = await fixture("read_only", "create a new note saying Launch");
    try {
      f.runtime.actions = f.runtime.actions.filter(
        (action) => action.name !== "NOTES_CREATE",
      );
      expect(
        resolveNotesRequestHostRestriction(f.runtime, f.message, "read_only"),
      ).toMatchObject({
        classification: "unresolved",
        reason: "registered-route-ambiguous",
        routeIds: ["notes.create"],
        operations: [],
      });
      expect(f.writes).not.toHaveBeenCalled();
    } finally {
      await f.service.stop();
    }
  });

  it("adds no permission or veto to an already mutation-classified compound request", async () => {
    const f = await fixture(
      "mutation_requested",
      "create a new note saying Launch and read my ideas note",
    );
    try {
      expect(f.rawNotesEffect).toBe("mutation_requested");
      expect(f.hostRestriction).toBeUndefined();
      expect(
        (await f.execute("NOTES_CREATE", { content: "Launch" })).success,
      ).toBe(true);
      expect(f.writes).toHaveBeenCalledTimes(1);
    } finally {
      await f.service.stop();
    }
  });

  it.each([
    ["NOTES_CREATE", { content: "ideas: launch on a Tuesday" }],
    ["NOTES", { action: "create", content: "ideas: launch on a Tuesday" }],
    ["NOTES", { op: "create", content: "ideas: launch on a Tuesday" }],
    ["NOTES_CREATE", {}],
    ["NOTES_CREATE", { action: "list" }],
    ["NOTES", { action: "create" }],
    ["NOTES", { op: "create" }],
  ] as const)(
    "denies forced %s before Notes service/store/events on a read turn",
    async (name, args) => {
      const f = await fixture("read_only", "what did I write about ideas?");
      try {
        const result = await f.execute(name, args);
        expect(result.success, JSON.stringify(f.diagnostics())).toBe(false);
        expect(result.data).toMatchObject({
          code: "REQUEST_OPERATION_RESTRICTED",
          executionStatus: "not_started",
          executed: false,
        });
        expect(result.effectReceipts ?? []).toHaveLength(0);
        expect(f.notesLookup).not.toHaveBeenCalled();
        expect(f.writes).not.toHaveBeenCalled();
        expect(f.service.snapshot()).toEqual(f.before);
        expect(
          f.events.mock.calls.some(([name]) =>
            String(name).includes("note:created"),
          ),
        ).toBe(false);
      } finally {
        await f.service.stop();
      }
    },
  );

  it("allows the real requested read without changing the note collection", async () => {
    const f = await fixture("read_only", "read the ideas note");
    try {
      const result = await f.execute("NOTES_GET", {
        noteId: f.historical.value.id,
      });
      expect(result.success, JSON.stringify(f.diagnostics())).toBe(true);
      expect(f.writes).not.toHaveBeenCalled();
      expect(f.service.snapshot()).toEqual(f.before);
    } finally {
      await f.service.stop();
    }
  });

  it.each(["positive", "lookalike", "null", "async"])(
    "fails closed on a %s pre-schema restriction result",
    async (mode) => {
      const f = await fixture("mutation_requested", "create a launch note");
      const action = f.runtime.actions.find(
        (candidate) => candidate.name === "NOTES_CREATE",
      );
      if (!action) throw Error("Actual promoted create missing");
      const original = action.restrictRequestOperation;
      const lookalike = {
        success: false,
        data: {
          code: "REQUEST_OPERATION_RESTRICTED",
          executionStatus: "not_started",
          executed: false,
        },
      };
      action.restrictRequestOperation = (() =>
        mode === "positive"
          ? { success: true }
          : mode === "null"
            ? null
            : mode === "async"
              ? Promise.resolve(lookalike)
              : lookalike) as unknown as NonNullable<
        Action["restrictRequestOperation"]
      >;
      try {
        const result = await f.execute("NOTES_CREATE", { content: "Launch" });
        expect(result.success, JSON.stringify(f.diagnostics())).toBe(false);
        expect(result.data).toMatchObject({
          code: "ACTION_REQUEST_RESTRICTION_INVALID",
          executionStatus: "not_started",
          executed: false,
        });
        expect(f.notesLookup).not.toHaveBeenCalled();
        expect(f.writes).not.toHaveBeenCalled();
        expect(f.service.snapshot()).toEqual(f.before);
      } finally {
        action.restrictRequestOperation = original;
        await f.service.stop();
      }
    },
  );

  it("preserves a current explicitly requested create under existing owner policy", async () => {
    const f = await fixture(
      "mutation_requested",
      "write a new note: generated launch checklist",
    );
    try {
      const result = await f.execute("NOTES_CREATE", {
        content: "Launch\nDraft the invitation",
      });
      expect(result.success, JSON.stringify(f.diagnostics())).toBe(true);
      expect(result.effectReceipts).toEqual([
        expect.objectContaining({
          operation: "notes.note.create",
          outcome: "applied",
        }),
      ]);
      expect(f.writes).toHaveBeenCalledTimes(1);
      expect(f.service.snapshot().notes).toHaveLength(
        f.before.notes.length + 1,
      );
    } finally {
      await f.service.stop();
    }
  });

  it("denies unresolved mutations without claiming a successful read or write", async () => {
    const f = await fixture("unresolved", "change that somehow");
    try {
      const result = await f.execute("NOTES_CREATE", {
        content: "Not requested",
      });
      expect(result.success, JSON.stringify(f.diagnostics())).toBe(false);
      expect(result.data).toMatchObject({
        code: "REQUEST_OPERATION_UNRESOLVED",
        executionStatus: "not_started",
      });
      expect(f.writes).not.toHaveBeenCalled();
      expect(f.service.snapshot()).toEqual(f.before);
    } finally {
      await f.service.stop();
    }
  });

  it("checks the owner policy before an agent view create can be delivered", async () => {
    const f = await fixture("read_only", "what did I write about ideas?");
    const delivery = vi.fn();
    try {
      await expect(
        runWithActionRoutingContext(
          {
            actionName: "VIEWS_INTERACT",
            modelClass: undefined,
            requestRuntime: f.runtime,
            requestMessage: f.message,
            requestState: f.state,
            hostAttemptId: "fixture-host-attempt",
            requestOperationAttempt: beginRequestOperationAttempt({
              runtime: f.runtime,
              message: f.message,
              state: f.state,
            }),
          },
          async () => {
            assertNotesAgentViewOperation(
              "create-note",
              { content: "Not requested" },
              { runtime: f.runtime },
            );
            delivery();
          },
        ),
      ).rejects.toMatchObject({ code: "REQUEST_OPERATION_RESTRICTED" });
      expect(delivery).not.toHaveBeenCalled();
      expect(f.writes).not.toHaveBeenCalled();
      expect(f.service.snapshot()).toEqual(f.before);
    } finally {
      await f.service.stop();
    }
  });

  it.each([
    "get-state",
    "get-text",
    "list-elements",
    "describe-element",
    "get-focus",
    "get-agent-state",
  ])(
    "preserves the canonical observation %s without a Notes write",
    async (capability) => {
      const f = await fixture("read_only", "read ideas");
      try {
        await runWithActionRoutingContext(
          {
            actionName: "VIEWS_INTERACT",
            modelClass: undefined,
            requestRuntime: f.runtime,
            requestMessage: f.message,
            requestState: f.state,
            requestOperationAttempt: beginRequestOperationAttempt({
              runtime: f.runtime,
              message: f.message,
              state: f.state,
            }),
          },
          async () => {
            expect(() =>
              assertNotesAgentViewOperation(
                capability,
                {},
                { runtime: f.runtime },
              ),
            ).not.toThrow();
          },
        );
        expect(f.writes).not.toHaveBeenCalled();
        expect(f.service.snapshot()).toEqual(f.before);
      } finally {
        await f.service.stop();
      }
    },
  );

  it.each([
    "click-element",
    "fill-input",
    "agent-click",
    "agent-fill",
    "refresh",
  ])("does not promote unresolved %s to an observation", async (capability) => {
    const f = await fixture("read_only", "read ideas");
    try {
      await expect(
        runWithActionRoutingContext(
          {
            actionName: "VIEWS_INTERACT",
            modelClass: undefined,
            requestRuntime: f.runtime,
            requestMessage: f.message,
            requestState: f.state,
            requestOperationAttempt: beginRequestOperationAttempt({
              runtime: f.runtime,
              message: f.message,
              state: f.state,
            }),
          },
          async () => {
            assertNotesAgentViewOperation(
              capability,
              {},
              { runtime: f.runtime },
            );
          },
        ),
      ).rejects.toMatchObject({ code: "REQUEST_OPERATION_UNRESOLVED" });
      expect(f.writes).not.toHaveBeenCalled();
      expect(f.service.snapshot()).toEqual(f.before);
    } finally {
      await f.service.stop();
    }
  });

  it.each(["server", "frontend"] as const)(
    "a managed alternate API port checks the real broker before %s delivery",
    async (deliveryPath) => {
      const f = await fixture("read_only", "what did I write about ideas?");
      const frontendDelivery = vi.fn(() => 1),
        serverDelivery = vi.fn();
      // Real registry installation/owner policy, with only bundle asset loading
      // omitted. This does not replace the Notes gate or store implementation.
      const plugin = {
        ...notesPlugin,
        views: notesPlugin.views?.map((view) => ({
          ...view,
          bundlePath: undefined,
          serverInteract:
            deliveryPath === "frontend"
              ? undefined
              : async (
                  ...args: Parameters<NonNullable<typeof view.serverInteract>>
                ) => {
                  serverDelivery();
                  return view.serverInteract?.(...args);
                },
        })),
      };
      const installation = await registerPluginViews(f.runtime, plugin, {
        pluginDir: "/fixture/notes",
        indexEmbeddings: false,
      });
      const entry = getView(f.runtime, "notes");
      if (!entry) throw Error("Actual Notes view installation missing");
      let kernelEntries = 0;
      let transportStatus: number | null = null;
      const brokerDiagnostics = () =>
        JSON.stringify({
          ...f.diagnostics(),
          kernelEntries,
          transportStatus,
          brokerHookPresent: typeof entry.beforeAgentInteract === "function",
        });
      const kernel = {
        handle: async () => {
          kernelEntries++;
          // The controlled kernel adapter calls the real shared dispatcher. The
          // in-process port and dispatcher run unchanged, without a TCP server.
          await dispatchViewInteract(
            entry,
            "notes",
            "create-note",
            { content: "Not requested" },
            {
              runtime: f.runtime,
              userRoles: ["OWNER"],
              clientId: "fixture-client",
              broadcastWsToClientId: frontendDelivery,
            },
          );
        },
      } as unknown as RouteKernel;
      const unregister = registerInProcessApi(f.runtime, kernel);
      f.runtime.actions.push({
        name: "FORCE_NOTES_API_PORT",
        description: "Controlled managed transport regression",
        roleGate: { minRole: "OWNER" },
        validate: async () => true,
        handler: async () => {
          const response = await dispatchApiRoute({
            runtime: f.runtime,
            inProcess: true,
            isAuthorized: () => true,
            headers: {},
            method: "POST",
            path: "/api/views/notes/interact",
            body: {
              capability: "create-note",
              params: { content: "Not requested" },
              // Caller-controlled origin-like text is not consulted as authority.
              ui: true,
              origin: "human",
            },
          });
          transportStatus =
            Number.isInteger(response.status) &&
            response.status >= 100 &&
            response.status <= 599
              ? response.status
              : null;
          if (response.status < 200 || response.status >= 300)
            return {
              success: false,
              data: {
                code: "FIXTURE_API_TRANSPORT_REFUSED",
                httpStatus: transportStatus,
              },
            };
          return { success: true };
        },
      });
      try {
        expect(
          f.runtime.actions.filter(
            (action) => action.name === "FORCE_NOTES_API_PORT",
          ),
        ).toHaveLength(1);
        const result = await f.execute("FORCE_NOTES_API_PORT", {});
        expect(result.success, brokerDiagnostics()).toBe(false);
        expect(result.data, brokerDiagnostics()).toMatchObject({
          code: "REQUEST_OPERATION_RESTRICTED",
          executionStatus: "not_started",
          executed: false,
        });
        expect(frontendDelivery).not.toHaveBeenCalled();
        expect(serverDelivery).not.toHaveBeenCalled();
        expect(f.notesLookup).not.toHaveBeenCalled();
        expect(f.writes).not.toHaveBeenCalled();
        expect(f.service.snapshot()).toEqual(f.before);
      } finally {
        unregister();
        unregisterPluginViews(f.runtime, installation);
        await f.service.stop();
      }
    },
  );

  it("keeps existing direct service/UI admission separate from Stage 1", async () => {
    const f = await fixture("read_only", "read ideas");
    try {
      // No conversational ActionRoutingContext: this exercises the existing
      // direct owner service path, NOT proof that arbitrary HTTP is human.
      const committed = await f.service.createNoteWithCommit({
        content: "Typed UI content",
      });
      expect(committed.value.body).toBeDefined();
      expect(f.writes).toHaveBeenCalledTimes(1);
    } finally {
      await f.service.stop();
    }
  });

  it("the same-call field parses invalid/missing classification conservatively", () => {
    const parse = notesRequestEffectField.parse;
    expect(parse).toBeTypeOf("function");
    for (const value of [
      undefined,
      null,
      "allow",
      { classification: "mutation_requested" },
    ]) {
      expect(parse?.(value, {} as never)).toBe("unresolved");
    }
  });

  it.each([
    ["NOTES_CREATE", { content: "ideas: launch on a Tuesday" }],
    ["NOTES_CREATE", {}],
    ["NOTES", { action: "create" }],
    ["NOTES", { op: "create" }],
  ] as const)(
    "an outside-constraint %s %j does not invent pending work after the real read",
    async (writeAction, writeArgs) => {
      const f = await fixture("read_only", "what did I write about ideas?");
      let requests = 0;
      const executed: string[] = [];
      try {
        const result = await diagnosedPlanner(f, {
          context: f.context,
          tools: [
            {
              name: writeAction,
              parameters: {
                type: "object",
                properties: {
                  content: { type: "string" },
                  action: { type: "string" },
                  op: { type: "string" },
                },
              },
            },
            {
              name: "NOTES_GET",
              parameters: {
                type: "object",
                properties: { noteId: { type: "string" } },
              },
            },
          ],
          runtime: {
            useModel: async () => {
              requests++;
              if (requests === 1)
                return {
                  text: "",
                  toolCalls: [
                    {
                      name: writeAction,
                      id: "outside-create",
                      arguments: {
                        ...writeArgs,
                        eliza_turn_scope: "more_work_pending",
                      },
                    },
                  ],
                };
              if (requests === 2)
                return {
                  text: "",
                  toolCalls: [
                    {
                      name: "NOTES_GET",
                      id: "actual-read",
                      arguments: {
                        noteId: f.historical.value.id,
                        eliza_turn_scope: "final",
                      },
                    },
                  ],
                };
              return JSON.stringify({
                completed: true,
                toolCalls: [],
                messageToUser: "The ideas note says launch on a Tuesday.",
              });
            },
          },
          executeToolCall: async (call, current) => {
            bindTaskExtractionContext(
              f.state,
              f.message,
              current.trajectory.context,
              current.trajectory.context,
              f.runtime,
              getRequestOperationIssuer(f.runtime, f.message),
            );
            executed.push(call.name);
            return actionResultToPlannerToolResult(
              await f.execute(call.name, call.params ?? {}),
              { requestOperationIssuer: f.issuer },
            );
          },
          evaluate: async ({ trajectory }) =>
            trajectory.steps.some(
              (step) =>
                step.toolCall?.name === "NOTES_GET" && step.result?.success,
            )
              ? {
                  success: true,
                  decision: "FINISH" as const,
                  thought: "Return the actual read.",
                  messageToUser: "The ideas note says launch on a Tuesday.",
                }
              : {
                  success: false,
                  decision: "CONTINUE" as const,
                  thought: "Continue to the read.",
                },
        });
        expect(executed, JSON.stringify(f.diagnostics())).toEqual([
          writeAction,
          "NOTES_GET",
        ]);
        expect(result.terminalFailure).toBeUndefined();
        expect(f.writes).not.toHaveBeenCalled();
        expect(f.service.snapshot()).toEqual(f.before);
      } finally {
        await f.service.stop();
      }
    },
  );

  // Acceptance control: do not promote this to a passing receipt without
  // execution. Current callback/semantic coverage behavior is under review.
  it("cannot complete an original requested create when the classifier falsely restricts it to a read", async () => {
    const f = await fixture(
      "read_only",
      "create a new launch note saying Draft invitation",
    );
    let requests = 0;
    try {
      const result = await diagnosedPlanner(f, {
        context: f.context,
        tools: [
          {
            name: "NOTES_CREATE",
            parameters: {
              type: "object",
              properties: { content: { type: "string" } },
            },
          },
          {
            name: "NOTES_GET",
            parameters: {
              type: "object",
              properties: { noteId: { type: "string" } },
            },
          },
        ],
        runtime: {
          useModel: async () => {
            requests++;
            if (requests === 1)
              return {
                text: "",
                toolCalls: [
                  {
                    name: "NOTES_CREATE",
                    id: "requested-but-classifier-denied",
                    arguments: {
                      content: "Launch\nDraft invitation",
                      eliza_turn_scope: "more_work_pending",
                    },
                  },
                ],
              };
            if (requests === 2)
              return {
                text: "",
                toolCalls: [
                  {
                    name: "NOTES_GET",
                    id: "unrelated-successful-read",
                    arguments: {
                      noteId: f.historical.value.id,
                      eliza_turn_scope: "final",
                    },
                  },
                ],
              };
            return JSON.stringify({
              completed: true,
              toolCalls: [],
              messageToUser: "Saved the launch note.",
            });
          },
        },
        executeToolCall: async (call, current) => {
          bindTaskExtractionContext(
            f.state,
            f.message,
            current.trajectory.context,
            current.trajectory.context,
            f.runtime,
            getRequestOperationIssuer(f.runtime, f.message),
          );
          return actionResultToPlannerToolResult(
            await f.execute(call.name, call.params ?? {}),
            { requestOperationIssuer: f.issuer },
          );
        },
        // Adversarial optimistic verdict: a GET cannot prove the original
        // requested create, even though the safety restriction must block it.
        evaluate: async () => ({
          success: true,
          decision: "FINISH" as const,
          thought: "Controlled optimistic claim without a create receipt.",
          requestFullyCovered: true,
          messageToUser: "Saved the launch note.",
        }),
      });
      expect(f.writes).not.toHaveBeenCalled();
      expect(f.service.snapshot()).toEqual(f.before);
      expect(result.evaluator?.success).not.toBe(true);
      expect(result.evaluator?.requestFullyCovered).not.toBe(true);
      expect(result.finalMessage).not.toBe("Saved the launch note.");
    } finally {
      await f.service.stop();
    }
  });

  it.each([false, true])(
    "checks real evaluator completion prose and CONTINUE delivery (continuation claim=%s)",
    async (continuationClaim) => {
      const f = await fixture(
        "read_only",
        "create a new launch note saying Draft invitation",
      );
      let plannerCalls = 0,
        evaluatorCalls = 0,
        readEffectCount = -1;
      const delivered: string[] = [],
        clipboard = vi.fn();
      try {
        // This phrasing intentionally lies outside the existing anchored direct
        // route. Do not substitute the narrower route-veto control for it.
        expect(f.hostRestriction).toBeUndefined();
        const result = await diagnosedPlanner(f, {
          context: f.context,
          tools: [
            {
              name: "NOTES_CREATE",
              parameters: {
                type: "object",
                properties: { content: { type: "string" } },
              },
            },
            {
              name: "NOTES_GET",
              parameters: {
                type: "object",
                properties: { noteId: { type: "string" } },
              },
            },
          ],
          runtime: {
            useModel: async (_type, request) => {
              if (
                isObjectRecord(request.responseSchema) &&
                isObjectRecord(request.responseSchema.properties) &&
                request.responseSchema.properties.decision !== undefined
              ) {
                evaluatorCalls++;
                return JSON.stringify(
                  evaluatorCalls === 1
                    ? {
                        success: false,
                        decision: "CONTINUE",
                        thought: "Continue from the denied attempt.",
                        ...(continuationClaim
                          ? {
                              messageToUser: "Saved the launch note.",
                              // Literal clipboard content is independent of assistant
                              // assertion delivery and is not language-classified.
                              copyToClipboard: {
                                title: "Literal",
                                content: "Saved the launch note.",
                              },
                            }
                          : {}),
                      }
                    : {
                        success: true,
                        decision: "FINISH",
                        thought: "Optimistic controlled semantic mistake.",
                        requestFullyCovered: true,
                        outcomeCoverage: [
                          {
                            intentId: "intent:1",
                            status: "completed",
                            evidenceStepIds: ["step:2"],
                          },
                        ],
                        replyEffectStatus: "none",
                        effectReceiptIds: [],
                        copyToClipboard: {
                          title: "Launch",
                          content: "Saved the launch note.",
                        },
                        messageToUser: "Saved the launch note.",
                      },
                );
              }
              plannerCalls++;
              return {
                text: "",
                toolCalls:
                  plannerCalls === 1
                    ? [
                        {
                          name: "NOTES_CREATE",
                          id: "real-evaluator-denied-create",
                          arguments: {
                            content: "Launch\nDraft invitation",
                            eliza_turn_scope: "more_work_pending",
                          },
                        },
                      ]
                    : [
                        {
                          name: "NOTES_GET",
                          id: "real-evaluator-read",
                          arguments: {
                            noteId: f.historical.value.id,
                            eliza_turn_scope: "final",
                          },
                        },
                      ],
              };
            },
          },
          executeToolCall: async (call, current) => {
            bindTaskExtractionContext(
              f.state,
              f.message,
              current.trajectory.context,
              current.trajectory.context,
              f.runtime,
              getRequestOperationIssuer(f.runtime, f.message),
            );
            const result = await f.execute(call.name, call.params ?? {});
            if (call.name === "NOTES_GET")
              readEffectCount = result.effectReceipts?.length ?? 0;
            return actionResultToPlannerToolResult(result, {
              requestOperationIssuer: f.issuer,
            });
          },
          // No params.evaluate override: actual evaluator parsing/finalization.
          evaluatorEffects: {
            messageToUser: (message) => {
              delivered.push(message);
            },
            copyToClipboard: clipboard,
          },
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
        expect(
          result.trajectory.steps.some(
            (step) =>
              step.toolCall?.name === "NOTES_CREATE" &&
              step.result?.success === false,
          ),
        ).toBe(true);
        expect(f.writes).not.toHaveBeenCalled();
        expect(f.service.snapshot()).toEqual(f.before);
      } finally {
        await f.service.stop();
      }
    },
  );

  it("preserves completion text bound to this turn's actual requested create receipt", async () => {
    const f = await fixture("mutation_requested", "write a new launch note");
    let receiptId: string | undefined;
    const reply = "Saved the launch note.";
    try {
      const result = await diagnosedPlanner(f, {
        context: f.context,
        tools: [
          {
            name: "NOTES_CREATE",
            parameters: {
              type: "object",
              properties: { content: { type: "string" } },
            },
          },
        ],
        runtime: {
          useModel: async () => ({
            text: "",
            toolCalls: [
              {
                name: "NOTES_CREATE",
                id: "actual-create",
                arguments: {
                  content: "Launch\nDraft invitation",
                  eliza_turn_scope: "final",
                },
              },
            ],
          }),
        },
        executeToolCall: async (call, current) => {
          bindTaskExtractionContext(
            f.state,
            f.message,
            current.trajectory.context,
            current.trajectory.context,
            f.runtime,
            getRequestOperationIssuer(f.runtime, f.message),
          );
          const created = await f.execute(call.name, call.params ?? {});
          receiptId = created.effectReceipts?.[0]?.receiptId;
          return actionResultToPlannerToolResult(created, {
            requestOperationIssuer: f.issuer,
          });
        },
        evaluate: async () => ({
          success: true,
          decision: "FINISH" as const,
          thought: "Use the actual current commit.",
          messageToUser: reply,
          replyEffectStatus: "applied" as const,
          effectReceiptIds: receiptId ? [receiptId] : [],
          raw: { messageToUser: reply },
        }),
      });
      expect(receiptId).toBeDefined();
      expect(result.terminalFailure).toBeUndefined();
      expect(result.evaluator?.success).toBe(true);
      expect(result.finalMessage).toBe(reply);
      expect(f.writes).toHaveBeenCalledTimes(1);
    } finally {
      await f.service.stop();
    }
  });

  it("preserves a prior error and emits no typed-read receipt for an unsupported completion claim", async () => {
    const f = await fixture(
      "read_only",
      "create a new launch note saying Draft invitation",
    );
    const onTypedReadEgress = vi.fn(),
      now = Date.now();
    const binding: TypedReadReplyBinding = {
      phase: "final-answer",
      policy: {
        ownerScope: "fixture-owner",
        turnId: String(f.message.id),
        nowMs: now,
        includeSources: false,
        connectors: {},
        requirements: [
          {
            id: "observation",
            label: "Observation",
            kind: "quantity",
            unit: "°C",
            current: true,
            freshnessMs: 60_000,
            admittedFactIds: ["fixture-fact"],
            unverifiedText: "Unavailable.",
          },
        ],
      },
      facts: [
        {
          id: "fixture-fact",
          kind: "quantity",
          ownerScope: "fixture-owner",
          sourceUrl: "https://example.org/current",
          value: 18.3,
          unit: "°C",
          observedAtMs: now,
        },
      ],
    };
    try {
      const result = await diagnosedPlanner(f, {
        context: f.context,
        tools: [
          {
            name: "NOTES_CREATE",
            parameters: {
              type: "object",
              properties: { content: { type: "string" } },
            },
          },
        ],
        runtime: {
          useModel: async () => ({
            text: "",
            toolCalls: [
              {
                name: "NOTES_CREATE",
                id: "denied-with-prior-error",
                arguments: { content: "Launch", eliza_turn_scope: "final" },
              },
            ],
          }),
        },
        executeToolCall: async (call, current) => {
          bindTaskExtractionContext(
            f.state,
            f.message,
            current.trajectory.context,
            current.trajectory.context,
            f.runtime,
            getRequestOperationIssuer(f.runtime, f.message),
          );
          return actionResultToPlannerToolResult(
            await f.execute(call.name, call.params ?? {}),
            { requestOperationIssuer: f.issuer },
          );
        },
        evaluate: async () => ({
          success: false,
          decision: "FINISH" as const,
          thought: "Preserve prior error.",
          messageToUser: "Saved the launch note.",
          replyFailure: {
            kind: "provider_issue" as const,
            code: "PRIOR_PROVIDER_FAILURE",
            message: "A prior provider failed.",
            transient: false as const,
          },
        }),
        resolveTypedReadReply: () => binding,
        onTypedReadEgress,
      });
      expect(result.terminalFailure?.code).toBe("PRIOR_PROVIDER_FAILURE");
      expect(result.finalMessage).not.toBe("Saved the launch note.");
      expect(onTypedReadEgress).not.toHaveBeenCalled();
      expect(f.writes).not.toHaveBeenCalled();
      // A prior failure already excludes the typed-read final-render branch.
      // This public control does not invent reachability into that branch.
    } finally {
      await f.service.stop();
    }
  });

  it.each([
    ["NOTES_CREATE", {}],
    ["NOTES", { action: "create" }],
    ["NOTES", { op: "create" }],
  ] as const)(
    "a requested malformed %s %j cannot be completed by a successful read",
    async (writeAction, writeArgs) => {
      const f = await fixture(
        {
          classification: "mutation_requested",
          operations: ["list", "create"],
        },
        "read ideas and create a new launch note",
      );
      let requests = 0;
      const executed: string[] = [];
      const variant =
        writeAction === "NOTES_CREATE"
          ? "canonical"
          : "action" in writeArgs
            ? "action-alias"
            : "op-alias";
      const phase = (
        value:
          | "planner-enter"
          | "planner-return"
          | "cleanup-enter"
          | "cleanup-return",
      ) => {
        try {
          console.error(
            JSON.stringify({
              fixture: "notes-malformed-create-phase",
              variant,
              phase: value,
            }),
          );
        } catch {
          /* Diagnostics cannot replace the original result or error. */
        }
      };
      try {
        phase("planner-enter");
        const result = await diagnosedPlanner(f, {
          context: f.context,
          tools: [
            {
              name: writeAction,
              parameters: {
                type: "object",
                properties: {
                  content: { type: "string" },
                  action: { type: "string" },
                  op: { type: "string" },
                },
              },
            },
            {
              name: "NOTES_GET",
              parameters: {
                type: "object",
                properties: { noteId: { type: "string" } },
              },
            },
          ],
          runtime: {
            useModel: async () => {
              requests++;
              if (requests === 1)
                return {
                  text: "",
                  toolCalls: [
                    {
                      name: writeAction,
                      id: "requested-invalid",
                      arguments: {
                        ...writeArgs,
                        eliza_turn_scope: "more_work_pending",
                      },
                    },
                  ],
                };
              if (requests === 2)
                return {
                  text: "",
                  toolCalls: [
                    {
                      name: "NOTES_GET",
                      id: "insufficient-read",
                      arguments: {
                        noteId: f.historical.value.id,
                        eliza_turn_scope: "final",
                      },
                    },
                  ],
                };
              if (requests === 3)
                return {
                  text: "",
                  toolCalls: [
                    {
                      name: writeAction,
                      id: "requested-valid",
                      arguments: {
                        ...(writeAction === "NOTES"
                          ? { action: "create" }
                          : writeArgs),
                        content: "Launch\nDraft invitation",
                        eliza_turn_scope: "final",
                      },
                    },
                  ],
                };
              return JSON.stringify({
                completed: true,
                toolCalls: [],
                messageToUser: "Read ideas and saved the new launch note.",
              });
            },
          },
          executeToolCall: async (call, current) => {
            bindTaskExtractionContext(
              f.state,
              f.message,
              current.trajectory.context,
              current.trajectory.context,
              f.runtime,
              getRequestOperationIssuer(f.runtime, f.message),
            );
            executed.push(call.name);
            return actionResultToPlannerToolResult(
              await f.execute(call.name, call.params ?? {}),
              { requestOperationIssuer: f.issuer },
            );
          },
          // Even an optimistic evaluator cannot clear the requested failed
          // create with an unrelated successful GET; the real ledger must wait
          // for the matching create's actual durable success.
          evaluate: async () => ({
            success: true,
            decision: "FINISH" as const,
            thought:
              "Controlled optimistic verdict before the requested create.",
            messageToUser: "The ideas note is read.",
          }),
        });
        phase("planner-return");
        expect(executed, JSON.stringify(f.diagnostics())).toEqual([
          writeAction,
          "NOTES_GET",
          writeAction,
        ]);
        expect(result.terminalFailure).toBeUndefined();
        expect(f.writes).toHaveBeenCalledTimes(1);
        expect(f.service.snapshot().notes).toHaveLength(
          f.before.notes.length + 1,
        );
      } finally {
        phase("cleanup-enter");
        await f.service.stop();
        phase("cleanup-return");
      }
    },
  );

  it("bounds false terminal completions while an unsupported op draft remains rejected", async () => {
    const f = await fixture(
      { classification: "mutation_requested", operations: ["create"] },
      "create a new launch note",
    );
    let requests = 0;
    const executed: string[] = [];
    try {
      await expect(
        diagnosedPlanner(f, {
          context: f.context,
          tools: [
            {
              name: "NOTES",
              parameters: {
                type: "object",
                properties: {
                  op: { type: "string" },
                  content: { type: "string" },
                },
              },
            },
          ],
          runtime: {
            useModel: async () => {
              requests++;
              if (requests === 1)
                return {
                  text: "",
                  toolCalls: [
                    {
                      id: "unsupported-op-draft",
                      name: "NOTES",
                      arguments: {
                        op: "create",
                        eliza_turn_scope: "more_work_pending",
                      },
                    },
                  ],
                };
              return JSON.stringify({
                completed: true,
                toolCalls: [],
                messageToUser: "Saved the launch note.",
              });
            },
          },
          executeToolCall: async (call, current) => {
            bindTaskExtractionContext(
              f.state,
              f.message,
              current.trajectory.context,
              current.trajectory.context,
              f.runtime,
              getRequestOperationIssuer(f.runtime, f.message),
            );
            executed.push(call.name);
            return actionResultToPlannerToolResult(
              await f.execute(call.name, call.params ?? {}),
              { requestOperationIssuer: f.issuer },
            );
          },
          evaluate: async () => ({
            success: true,
            decision: "FINISH" as const,
            thought:
              "Controlled false completion over the unresolved rejection.",
            messageToUser: "Saved the launch note.",
          }),
          config: { maxTerminalOnlyContinuations: 2 },
        }),
      ).rejects.toMatchObject({
        kind: "terminal_only_continuations",
        max: 2,
        observed: 3,
      });
      expect(requests).toBe(4);
      expect(executed).toEqual(["NOTES"]);
      expect(f.writes).not.toHaveBeenCalled();
      expect(f.service.snapshot()).toEqual(f.before);
    } finally {
      await f.service.stop();
    }
  });
});

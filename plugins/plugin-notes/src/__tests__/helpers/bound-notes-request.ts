/** Test-owned current request, passed through the real restrictive field/issuer path.
 * Operations are supplied by the case, never inferred from planner arguments.
 * This adds no permission: executor role/schema and Notes service guards remain real.
 */
import {
  type Action,
  type ActionResult,
  type ContextObject,
  type IAgentRuntime,
  type Memory,
  type NotesRequestOperation,
  type State,
  type HandlerCallback,
  beginRequestOperationAttempt,
  beginRequestOperationIssuer,
  bindTaskExtractionContext,
  commitNotesRequestRestriction,
  executePlannedToolCall,
  ResponseHandlerFieldRegistry,
  runWithActionRoutingContext,
  stringToUuid,
} from "@elizaos/core";
import { afterEach } from "vitest";
import { resolveNotesRequestHostRestriction } from "../../../../plugin-assistant/src/services/message/notes-request-issuer.ts";
import { messageHandlerFromFieldResult } from "../../../../plugin-assistant/src/services/message/stage1-output.ts";
import { notesRequestEffectField } from "../../request-effect.js";

const lifetimes = new Set<AbortController>();
afterEach(() => {
  for (const lifetime of lifetimes) lifetime.abort();
  lifetimes.clear();
});

export const notesFixtureText: Record<NotesRequestOperation, string> = {
  create: "Create the note requested in this test.",
  get: "Read the requested saved note without changing anything.",
  list: "List the requested saved notes without changing anything.",
  update: "Edit the requested saved note.",
  patch: "Apply the requested patch to the saved note.",
  delete: "Delete the requested saved note.",
};

export async function boundNotesRequest(
  runtime: IAgentRuntime,
  input: {
    text: string;
    operations: readonly NotesRequestOperation[];
    message?: Partial<Memory>;
  },
) {
  if (!runtime.agentId)
    throw Error("Fixture must own its actual runtime identity");
  const message = {
    ...input.message,
    id: input.message?.id ?? crypto.randomUUID(),
    agentId: runtime.agentId,
    entityId: input.message?.entityId ?? stringToUuid("notes-fixture-owner"),
    roomId: input.message?.roomId ?? stringToUuid("notes-fixture-room"),
    createdAt: input.message?.createdAt ?? Date.now(),
    content: {
      ...input.message?.content,
      text: input.text,
      source: "client_chat",
    },
  } as Memory;
  const state = { values: {}, data: {}, text: "" } as State;
  const modelNotesField = {
    classification: input.operations.some((op) => op !== "get" && op !== "list")
      ? "mutation_requested"
      : input.operations.length
        ? "read_only"
        : "unresolved",
    operations: [...input.operations],
  };
  const registry = new ResponseHandlerFieldRegistry();
  registry.register(notesRequestEffectField);
  const fieldRun = await registry.dispatch({
    rawParsed: {
      shouldRespond: "RESPOND",
      contexts: ["notes"],
      intents: [input.text],
      requiresTool: true,
      replyEffectStatus: "pending",
      replyText: "",
      candidateActionNames: [],
      facts: [],
      relationships: [],
      addressedTo: [],
      notesRequestEffect: modelNotesField,
    },
    runtime,
    message,
    state,
    senderRole: "OWNER",
    turnSignal: new AbortController().signal,
  });
  const handler = messageHandlerFromFieldResult(fieldRun.parsed, fieldRun, {
    actions: runtime.actions,
    messageText: input.text,
  });
  const hostRestriction = resolveNotesRequestHostRestriction(
    runtime,
    message,
    handler.plan.notesRequestEffect ?? "unresolved",
    handler.plan.notesRequestInterpretation,
  );
  handler.plan.notesRequestHostRestriction = hostRestriction;
  const context: ContextObject = {
    id: "notes-fixture-current",
    metadata: {
      agentId: runtime.agentId,
      messageId: message.id,
      roomId: message.roomId,
      entityId: message.entityId,
    },
    events: [
      {
        id: String(message.id),
        type: "message",
        message: { id: String(message.id), role: "user", content: input.text },
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
  lifetimes.add(lifetime);
  const issuer = beginRequestOperationIssuer({
    runtime,
    message,
    current: () => !lifetime.signal.aborted,
  });
  if (!issuer) throw Error("Actual Notes fixture issuer unavailable");
  const source = {
    currentText: input.text,
    modelNotesField,
    interpretation: handler.plan.notesRequestInterpretation,
    hostRestriction,
  };
  if (
    !commitNotesRequestRestriction(issuer, {
      classification:
        hostRestriction?.classification ??
        handler.plan.notesRequestEffect ??
        "unresolved",
      source,
      currentSource: () => source,
      interpretation: hostRestriction
        ? { status: "contradictory", operations: [] }
        : handler.plan.notesRequestInterpretation,
    })
  )
    throw Error("Actual Notes fixture field commitment failed");
  bindTaskExtractionContext(state, message, context, context, runtime, issuer);
  return {
    message,
    state,
    context,
    issuer,
    retire: () => lifetime.abort(),
    execute: (
      call: Parameters<typeof executePlannedToolCall>[2],
      userRoles: Parameters<typeof executePlannedToolCall>[1]["userRoles"] = [
        "OWNER",
      ],
    ) =>
      executePlannedToolCall(
        runtime,
        {
          message,
          state,
          userRoles,
          activeContexts: ["notes"],
          replyOwner: "planner",
        },
        call,
      ),
    // A handler-unit case deliberately bypasses executor schema parsing, not request binding.
    // Valid-schema admission/owner cases below use execute(), preserving their original boundary.
    handler: async (
      action: Action,
      parameters: Record<string, unknown>,
      callback?: HandlerCallback,
    ): Promise<ActionResult> => {
      const attempt = beginRequestOperationAttempt({
        runtime,
        message,
        state,
        action,
      });
      if (!attempt)
        throw Error("Actual Notes handler fixture attempt unavailable");
      const handler = action.handler;
      if (!handler) throw Error("Missing actual action handler");
      const result = await runWithActionRoutingContext(
        {
          actionName: action.name,
          modelClass: action.modelClass,
          messageId: message.id,
          requestMessage: message,
          requestState: state,
          requestRuntime: runtime,
          requestOperationAttempt: attempt,
        },
        () =>
          handler(
            runtime,
            message,
            state,
            { parameters } as Parameters<typeof handler>[3],
            callback,
          ),
      );
      if (!result || typeof result !== "object")
        throw Error("Actual Notes handler returned no result");
      return result;
    },
  };
}

/**
 * Keyless end-to-end coverage for Notes CRUD through the real action, service,
 * and durable store on a PGLite-backed scenario runtime.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import {
  type Action,
  beginRequestOperationAttempt,
  beginRequestOperationIssuer,
  bindTaskExtractionContext,
  type ContextObject,
  commitNotesRequestRestriction,
  type IAgentRuntime,
  isObjectRecord,
  type NotesRequestOperation,
  runWithActionRoutingContext,
  type State,
} from "@elizaos/core";
import type {
  CapturedAction,
  ScenarioCheckResult,
  ScenarioContext,
  ScenarioTurnExecution,
} from "@elizaos/testing";
import { scenario } from "@elizaos/testing";
import notesPlugin, {
  NotesService,
  notesAction,
  type StickyNote,
} from "../../../../../plugins/plugin-notes/src/index.ts";

const notesHandler = notesAction.handler;

const title = "Workflow launch checklist";
const originalBody = "\nConfirm the native run output.\nKeep  two spaces.";
const updatedBody =
  "Confirm the native run and widget output.\nKeep  two spaces.";
let notesFilePath: string;
let notesAgentId: string;
let createdNote: StickyNote | undefined;
// Authored request interpretations, independent of the action's parameters.
// Direct action turns do not run Stage 1, so this model-free host fixture
// supplies its request binding without relaxing the production Notes gate.
const requestOperations = new Map<string, NotesRequestOperation>([
  ["save a note", "create"],
  ["show my workflow note", "list"],
  ["read my workflow note without changing it", "get"],
  ["update my workflow note", "patch"],
  ["read my updated workflow note", "list"],
  ["delete my workflow note", "delete"],
]);

function bindScenarioNotesRequests(original: Action): Action {
  const action = { ...original };
  action.handler = async (runtime, message, _state, options, callback) => {
    const operation = requestOperations.get(message.content.text ?? "");
    if (!operation)
      return notesHandler(runtime, message, _state, options, callback);
    const lifetime = new AbortController();
    const issuer = beginRequestOperationIssuer({
      runtime,
      message,
      current: () => !lifetime.signal.aborted,
    });
    if (!issuer) throw new Error("Scenario Notes request issuer unavailable");
    const source = { text: message.content.text, operation };
    try {
      if (
        !commitNotesRequestRestriction(issuer, {
          classification:
            operation === "get" || operation === "list"
              ? "read_only"
              : "mutation_requested",
          interpretation: { status: "explicit", operations: [operation] },
          source,
          currentSource: () => source,
        })
      )
        throw new Error("Scenario Notes request commitment failed");
      const state = { values: {}, data: {}, text: "" } as State;
      const context: ContextObject = {
        id: String(message.id),
        metadata: { messageId: message.id, roomId: message.roomId },
        events: [],
      };
      bindTaskExtractionContext(
        state,
        message,
        context,
        context,
        runtime,
        issuer,
      );
      const attempt = beginRequestOperationAttempt({
        runtime,
        message,
        state,
        action,
      });
      if (!attempt)
        throw new Error("Scenario Notes request attempt unavailable");
      return await runWithActionRoutingContext(
        {
          actionName: action.name,
          modelClass: action.modelClass,
          messageId: message.id,
          requestMessage: message,
          requestState: state,
          requestRuntime: runtime,
          requestOperationAttempt: attempt,
        },
        () => notesHandler(runtime, message, state, options, callback),
      );
    } finally {
      lifetime.abort();
    }
  };
  return action;
}
const replacementParameters: {
  action: "patch";
  target: { kind: "text"; value: string };
  changes: Array<{ field: "body"; value: string }>;
  expectedRevision?: number;
} = {
  action: "patch",
  target: { kind: "text", value: title },
  changes: [{ field: "body", value: updatedBody }],
};

type ScenarioRuntime = IAgentRuntime & {
  plugins?: Array<{ name?: unknown }>;
  registerPlugin?: (plugin: unknown) => Promise<void>;
  getServiceLoadPromise?: (serviceType: string) => Promise<unknown>;
};

function capturedNotesAction(
  execution: ScenarioTurnExecution,
): CapturedAction | undefined {
  return execution.actionsCalled.find(
    (candidate) => candidate.actionName === "NOTES",
  );
}

function expectNotesResult(
  op: "create" | "list" | "update" | "delete",
  expectedBody: string,
): (execution: ScenarioTurnExecution) => ScenarioCheckResult {
  return async (execution) => {
    const action = capturedNotesAction(execution);
    if (!action) return "NOTES action was not captured";
    if (action.result?.success !== true) {
      return `NOTES action failed: ${JSON.stringify(action.result)}`;
    }
    const data = action.result.data;
    if (
      !data ||
      typeof data !== "object" ||
      !("op" in data) ||
      data.op !== op
    ) {
      return `expected NOTES op=${op}, saw ${JSON.stringify(data)}`;
    }
    const result = data as Record<string, unknown>;
    const stored = JSON.parse(await readFile(notesFilePath, "utf8"));
    const notes: StickyNote[] = stored.notes;
    if (op === "delete") {
      return notes.length === 0 &&
        result.noteId === createdNote?.id &&
        result.removedCount === 1
        ? undefined
        : "delete did not remove exactly the created note from disk";
    }
    if (
      notes.length !== 1 ||
      notes[0]?.title !== title ||
      notes[0]?.body !== expectedBody
    ) {
      return `unexpected persisted note content: ${JSON.stringify(notes)}`;
    }
    const note = notes[0];
    if (op === "create") createdNote = note;
    if (
      !createdNote ||
      note.id !== createdNote.id ||
      note.createdAt !== createdNote.createdAt
    ) {
      return "the operation replaced the note identity or creation timestamp";
    }
    if (op === "list") {
      if (
        result.readOnlyOperation !== true ||
        result.count !== 1 ||
        result.lookupMode !== "text" ||
        !isDeepStrictEqual(
          result.notes,
          notes.map((note) => ({
            ...note,
            sourceNote: {
              agentId: notesAgentId,
              noteId: note.id,
              contentHash: createHash("sha256")
                .update(
                  JSON.stringify([
                    notesAgentId,
                    note.id,
                    note.title,
                    note.body,
                  ]),
                )
                .digest("hex"),
            },
          })),
        ) ||
        typeof result.notesRevision !== "number" ||
        result.notesRevision !== stored.revision
      ) {
        return "topic lookup did not return the exact persisted note and revision";
      }
      replacementParameters.expectedRevision = result.notesRevision;
      return undefined;
    }
    return result.noteId === note.id && isDeepStrictEqual(result.note, note)
      ? undefined
      : "write result does not match the persisted note";
  };
}

function notesService(ctx: ScenarioContext): NotesService | null {
  return (
    (ctx.runtime as ScenarioRuntime).getService<NotesService>(
      NotesService.serviceType,
    ) ?? null
  );
}

export default scenario({
  id: "deterministic-notes-actions",
  lane: "pr-deterministic",
  modelFixtures: {
    mode: "model-free",
    reason:
      "Direct action turns exercise runtime contracts without model calls.",
  },
  title: "Deterministic Notes CRUD through the shared durable service",
  domain: "notes",
  status: "active",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-notes"],
  },
  seed: [
    {
      type: "custom",
      name: "register the real Notes plugin",
      apply: async (ctx) => {
        const runtime = ctx.runtime as ScenarioRuntime;
        if (
          !(runtime.plugins ?? []).some(
            (plugin) => plugin.name === notesPlugin.name,
          )
        ) {
          await runtime.registerPlugin?.(notesPlugin);
        }
        await runtime.getServiceLoadPromise?.(NotesService.serviceType);
        const service = notesService(ctx);
        if (!service) return "NotesService did not start";
        await service.clearNotes();
        const actionIndex = runtime.actions.findIndex(
          (candidate) => candidate.name === "NOTES",
        );
        const action = runtime.actions[actionIndex];
        if (!action) return "Notes action did not register";
        // The runner reattaches its interceptor after seeds. Use a scenario-local
        // action object so detaching the old interceptor cannot undo this binding.
        runtime.actions[actionIndex] = bindScenarioNotesRequests(action);
        notesFilePath = service.store.filePath;
        notesAgentId = String(runtime.agentId);
        createdNote = undefined;
        delete replacementParameters.expectedRevision;
        return undefined;
      },
    },
  ],
  turns: [
    {
      kind: "action",
      name: "create a durable note",
      actionName: "NOTES",
      text: "save a note",
      options: {
        parameters: {
          action: "create",
          content: `${title}${originalBody}`,
        },
      },
      assertTurn: expectNotesResult("create", originalBody),
    },
    {
      kind: "action",
      name: "refuse a write during the authored read-only request",
      actionName: "NOTES",
      text: "read my workflow note without changing it",
      options: {
        parameters: { action: "create", content: "Unrequested duplicate" },
      },
      assertTurn: async (execution) => {
        const result = capturedNotesAction(execution)?.result;
        const data = result?.data;
        if (
          result?.success !== false ||
          !isObjectRecord(data) ||
          data.code !== "REQUEST_OPERATION_RESTRICTED" ||
          data.executionStatus !== "not_started"
        )
          return "read-only request did not reject the attempted write";
        const stored = JSON.parse(await readFile(notesFilePath, "utf8"));
        return isDeepStrictEqual(stored.notes, [createdNote])
          ? undefined
          : "read-only request changed the durable Notes store";
      },
    },
    {
      kind: "action",
      name: "read the note from the same service",
      actionName: "NOTES",
      text: "show my workflow note",
      options: {
        parameters: { action: "list", content: "Workflow launch" },
      },
      assertTurn: expectNotesResult("list", originalBody),
    },
    {
      kind: "action",
      name: "update the note by its user-visible text",
      actionName: "NOTES",
      text: "update my workflow note",
      options: {
        parameters: replacementParameters,
      },
      assertTurn: expectNotesResult("update", `\n${updatedBody}`),
    },
    {
      kind: "action",
      name: "read back the edited note",
      actionName: "NOTES",
      text: "read my updated workflow note",
      options: {
        parameters: { action: "list", content: "Workflow launch" },
      },
      assertTurn: expectNotesResult("list", `\n${updatedBody}`),
    },
    {
      kind: "action",
      name: "delete the updated note",
      actionName: "NOTES",
      text: "delete my workflow note",
      options: {
        parameters: { action: "delete", content: "Workflow launch checklist" },
      },
      assertTurn: expectNotesResult("delete", `\n${updatedBody}`),
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "the durable Notes store is empty after the CRUD round trip",
      predicate: (ctx) => {
        const service = notesService(ctx);
        if (!service) return "NotesService was unavailable in the final check";
        return service.listNotes().length === 0
          ? undefined
          : "the deleted note remained in the durable store";
      },
    },
  ],
});

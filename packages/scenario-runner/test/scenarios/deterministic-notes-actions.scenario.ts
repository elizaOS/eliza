/**
 * Keyless end-to-end coverage for Notes CRUD through the real action, service,
 * and durable store on a PGLite-backed scenario runtime.
 */
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type { IAgentRuntime } from "@elizaos/core";
import type {
  CapturedAction,
  ScenarioCheckResult,
  ScenarioContext,
  ScenarioTurnExecution,
} from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import notesPlugin, {
  NotesService,
  type StickyNote,
} from "../../../../plugins/plugin-notes/src/index.ts";

const title = "Workflow launch checklist";
const originalBody = "Confirm the native run output.\nKeep  two spaces.";
const updatedBody =
  "Confirm the native run and widget output.\nKeep  two spaces.";
let notesFilePath: string;
let createdNote: StickyNote | undefined;

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
      return result.readOnlyOperation === true &&
        result.count === 1 &&
        result.lookupMode === "text" &&
        isDeepStrictEqual(result.notes, notes)
        ? undefined
        : "topic lookup did not return the exact persisted note";
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
        notesFilePath = service.store.filePath;
        createdNote = undefined;
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
          content: `${title}\n${originalBody}`,
        },
      },
      assertTurn: expectNotesResult("create", originalBody),
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
        parameters: {
          action: "patch",
          target: { kind: "text", value: title },
          changes: [{ field: "body", value: updatedBody }],
        },
      },
      assertTurn: expectNotesResult("update", updatedBody),
    },
    {
      kind: "action",
      name: "read back the edited note",
      actionName: "NOTES",
      text: "read my updated workflow note",
      options: {
        parameters: { action: "list", content: "Workflow launch" },
      },
      assertTurn: expectNotesResult("list", updatedBody),
    },
    {
      kind: "action",
      name: "delete the updated note",
      actionName: "NOTES",
      text: "delete my workflow note",
      options: {
        parameters: { action: "delete", content: "Workflow launch checklist" },
      },
      assertTurn: expectNotesResult("delete", updatedBody),
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

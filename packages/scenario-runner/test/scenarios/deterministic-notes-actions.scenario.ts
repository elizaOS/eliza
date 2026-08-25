/**
 * Keyless end-to-end coverage for Notes CRUD through the real action, service,
 * and durable store on a PGLite-backed scenario runtime.
 */
import type { IAgentRuntime } from "@elizaos/core";
import type {
  CapturedAction,
  ScenarioContext,
  ScenarioTurnExecution,
} from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import notesPlugin, {
  NotesService,
} from "../../../../plugins/plugin-notes/src/index.ts";

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
  expectedText: string,
): (execution: ScenarioTurnExecution) => string | undefined {
  return (execution) => {
    const action = capturedNotesAction(execution);
    if (!action) return "NOTES action was not captured";
    if (action.result?.success !== true) {
      return `NOTES action failed: ${JSON.stringify(action.result)}`;
    }
    const data = action.result.data;
    if (!data || typeof data !== "object" || data.op !== op) {
      return `expected NOTES op=${op}, saw ${JSON.stringify(data)}`;
    }
    const text =
      typeof action.result.text === "string" ? action.result.text : "";
    return text.includes(expectedText)
      ? undefined
      : `expected NOTES text to include ${JSON.stringify(expectedText)}, saw ${JSON.stringify(text)}`;
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
          content: "Workflow launch checklist\nConfirm the native run output.",
        },
      },
      assertTurn: expectNotesResult("create", "saved a note"),
    },
    {
      kind: "action",
      name: "read the note from the same service",
      actionName: "NOTES",
      text: "show my workflow note",
      options: {
        parameters: { action: "list", content: "Workflow launch" },
      },
      assertTurn: expectNotesResult("list", "Workflow launch checklist"),
    },
    {
      kind: "action",
      name: "update the note by its user-visible text",
      actionName: "NOTES",
      text: "update my workflow note",
      options: {
        parameters: {
          action: "update",
          content: "Workflow launch checklist",
          body: "Workflow launch checklist\nConfirm the native run and widget output.",
        },
      },
      assertTurn: expectNotesResult("update", "updated the note"),
    },
    {
      kind: "action",
      name: "delete the updated note",
      actionName: "NOTES",
      text: "delete my workflow note",
      options: {
        parameters: { action: "delete", content: "Workflow launch checklist" },
      },
      assertTurn: expectNotesResult("delete", "deleted the note"),
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

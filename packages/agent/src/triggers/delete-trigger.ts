/**
 * DELETE_TRIGGER_TASK action — removes a trigger by id.
 *
 * Mirrors the DELETE /api/triggers/:id route used by AutomationsView's
 * delete-trigger handler. Validates the trigger exists before destructively
 * deleting the underlying task.
 */

import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
  Task,
} from "@elizaos/core";
import {
  listTriggerTasks,
  readTriggerConfig,
  taskToTriggerSummary,
  triggersFeatureEnabled,
} from "./runtime.js";

const DELETE_TRIGGER_TASK_ACTION = "DELETE_TRIGGER_TASK";

interface DeleteTriggerParameters {
  triggerId?: unknown;
  cascade?: unknown;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
    if (v === "false" || v === "0" || v === "no" || v === "off") return false;
  }
  return undefined;
}

async function findTriggerTask(
  runtime: IAgentRuntime,
  triggerId: string,
): Promise<Task | null> {
  const tasks = await listTriggerTasks(runtime);
  for (const task of tasks) {
    const trigger = readTriggerConfig(task);
    if (!trigger) continue;
    if (trigger.triggerId === triggerId) return task;
    if (task.id === triggerId) return task;
  }
  return null;
}

export const deleteTriggerTaskAction: Action = {
  name: DELETE_TRIGGER_TASK_ACTION,
  contexts: ["automation", "tasks", "agent_internal"],
  roleGate: { minRole: "OWNER" },
  similes: [
    "DELETE_TRIGGER",
    "REMOVE_TRIGGER",
    "CANCEL_TRIGGER",
    "DELETE_HEARTBEAT",
    "REMOVE_HEARTBEAT",
    "DELETE_AUTOMATION",
    "REMOVE_AUTOMATION",
    "CANCEL_AUTOMATION",
    "STOP_TRIGGER_FOREVER",
  ],
  description:
    "Permanently delete a trigger by id. Use when the user wants to remove a recurring or scheduled trigger entirely. Pair with cascade=true to also remove sibling schedules sharing the same workflow.",
  validate: async (runtime, _message) => {
    if (!triggersFeatureEnabled(runtime)) return false;
    return true;
  },
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult | undefined> => {
    if (!triggersFeatureEnabled(runtime)) {
      return {
        success: false,
        text: "Triggers are disabled by configuration.",
      };
    }

    const params = (options?.parameters ?? {}) as DeleteTriggerParameters;
    const triggerId = readString(params.triggerId);
    if (!triggerId) {
      return { success: false, text: "triggerId parameter is required." };
    }

    const task = await findTriggerTask(runtime, triggerId);
    if (!task?.id) {
      return { success: false, text: `Trigger not found: ${triggerId}` };
    }
    const summary = taskToTriggerSummary(task);
    const cascade = readBoolean(params.cascade) === true;

    const cascadeIds: string[] = [];
    if (cascade && summary?.workflowId) {
      const allTasks = await listTriggerTasks(runtime);
      for (const sibling of allTasks) {
        if (sibling.id === task.id) continue;
        const siblingTrigger = readTriggerConfig(sibling);
        if (
          siblingTrigger &&
          siblingTrigger.workflowId === summary.workflowId
        ) {
          cascadeIds.push(String(sibling.id));
        }
      }
    }

    await runtime.deleteTask(task.id);
    for (const siblingId of cascadeIds) {
      await runtime.deleteTask(
        siblingId as `${string}-${string}-${string}-${string}-${string}`,
      );
    }

    const cascadeNote = cascadeIds.length
      ? ` (and ${cascadeIds.length} sibling schedule${cascadeIds.length === 1 ? "" : "s"})`
      : "";
    const successText = `Deleted trigger "${summary?.displayName ?? triggerId}"${cascadeNote}.`;
    if (callback) {
      await callback({
        text: successText,
        action: DELETE_TRIGGER_TASK_ACTION,
        metadata: { triggerId, cascadeIds },
      });
    }
    return {
      success: true,
      text: successText,
      data: { triggerId, cascadeIds },
    };
  },

  parameters: [
    {
      name: "triggerId",
      description: "ID of the trigger to delete.",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "cascade",
      description:
        "When true, also delete sibling triggers attached to the same workflow.",
      required: false,
      schema: { type: "boolean" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Delete the morning standup trigger." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Deleted trigger "Morning standup".',
          action: DELETE_TRIGGER_TASK_ACTION,
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Cancel that recurring trigger entirely." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Deleted trigger "Inbox sweep".',
          action: DELETE_TRIGGER_TASK_ACTION,
        },
      },
    ],
  ] as ActionExample[][],
};

/**
 * RUN_TRIGGER_NOW action — manually fires a trigger by id.
 *
 * Mirrors the POST /api/triggers/:id/execute route used by AutomationsView's
 * manual run button. The trigger's instructions are dispatched immediately
 * regardless of its schedule, and the trigger remains scheduled for its next
 * normal run.
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
  executeTriggerTask,
  listTriggerTasks,
  readTriggerConfig,
  taskToTriggerSummary,
  triggersFeatureEnabled,
} from "./runtime.js";

const RUN_TRIGGER_NOW_ACTION = "RUN_TRIGGER_NOW";

interface RunTriggerParameters {
  triggerId?: unknown;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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

export const runTriggerNowAction: Action = {
  name: RUN_TRIGGER_NOW_ACTION,
  contexts: ["automation", "tasks", "agent_internal"],
  roleGate: { minRole: "OWNER" },
  similes: [
    "RUN_TRIGGER",
    "EXECUTE_TRIGGER",
    "FIRE_TRIGGER",
    "RUN_HEARTBEAT_NOW",
    "EXECUTE_HEARTBEAT",
    "RUN_AUTOMATION_NOW",
    "TEST_TRIGGER",
    "TRIGGER_NOW",
  ],
  description:
    "Run a trigger immediately, regardless of its schedule. Use when the user wants to fire or test an existing trigger right now.",
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

    const params = (options?.parameters ?? {}) as RunTriggerParameters;
    const triggerId = readString(params.triggerId);
    if (!triggerId) {
      return { success: false, text: "triggerId parameter is required." };
    }

    const task = await findTriggerTask(runtime, triggerId);
    if (!task?.id) {
      return { success: false, text: `Trigger not found: ${triggerId}` };
    }
    const summary = taskToTriggerSummary(task);

    const result = await executeTriggerTask(runtime, task, {
      source: "manual",
      force: true,
    });

    const refreshed = await runtime.getTask(task.id);
    const refreshedSummary = refreshed
      ? taskToTriggerSummary(refreshed)
      : (result.trigger ?? summary ?? null);

    const successText =
      result.status === "success"
        ? `Ran trigger "${summary?.displayName ?? triggerId}".`
        : result.status === "skipped"
          ? `Trigger "${summary?.displayName ?? triggerId}" skipped: ${result.error ?? "no reason given"}.`
          : `Trigger "${summary?.displayName ?? triggerId}" failed: ${result.error ?? "unknown error"}.`;

    if (callback) {
      await callback({
        text: successText,
        action: RUN_TRIGGER_NOW_ACTION,
        metadata: {
          triggerId,
          status: result.status,
          executionId: result.executionId,
        },
      });
    }

    return {
      success: result.status !== "error",
      text: successText,
      data: {
        triggerId,
        status: result.status,
        error: result.error,
        executionId: result.executionId,
        taskDeleted: result.taskDeleted,
        trigger: refreshedSummary,
      },
    };
  },

  parameters: [
    {
      name: "triggerId",
      description: "ID of the trigger to fire immediately.",
      required: true,
      schema: { type: "string" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Run my morning standup trigger now." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Ran trigger "Morning standup".',
          action: RUN_TRIGGER_NOW_ACTION,
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Fire the inbox sweep trigger right now." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Ran trigger "Inbox sweep".',
          action: RUN_TRIGGER_NOW_ACTION,
        },
      },
    ],
  ] as ActionExample[][],
};

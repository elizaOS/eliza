/**
 * Ongoing tasks provider — injects active task context into the agent prompt.
 *
 * Gives the agent awareness of pending workbench tasks and active scheduled
 * automations so it can reference, update, or act on them in conversation.
 */

import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
  Task,
} from "@elizaos/core";
import {
  isWorkbenchTodoTask,
  readTaskCompleted,
} from "../api/workbench-helpers.ts";
import { listTriggerTasks, readTriggerConfig } from "../triggers/runtime.ts";

const MAX_TASKS_IN_CONTEXT = 20;
const MAX_TRIGGERS_IN_CONTEXT = 10;

function formatTaskForContext(task: Task): string {
  const completed = readTaskCompleted(task);
  const status = completed ? "completed" : "active";
  const desc =
    typeof task.description === "string" && task.description.trim()
      ? ` — ${task.description.trim()}`
      : "";
  return `- [${status}] ${task.name}${desc} (id: ${task.id})`;
}

function formatTriggerForContext(task: Task): string | null {
  const trigger = readTriggerConfig(task);
  if (!trigger) return null;

  const status = trigger.enabled ? "active" : "paused";
  let schedule = "";
  if (trigger.triggerType === "interval" && trigger.intervalMs) {
    const mins = Math.round(trigger.intervalMs / 60_000);
    schedule =
      mins >= 60 ? `every ${Math.round(mins / 60)}h` : `every ${mins}m`;
  } else if (trigger.triggerType === "cron" && trigger.cronExpression) {
    schedule = `cron: ${trigger.cronExpression}`;
  } else if (trigger.triggerType === "once") {
    schedule = "one-time";
  }

  return `- [${status}] ${trigger.displayName} (${schedule}) — ${trigger.instructions} (id: ${task.id})`;
}

export function createOngoingTasksProvider(): Provider {
  return {
    name: "ongoingTasks",
    description:
      "Provides context about the user's active tasks and scheduled tasks.",
    position: 20,
    contexts: ["tasks", "automation"],
    contextGate: { anyOf: ["tasks", "automation"] },
    cacheStable: false,
    cacheScope: "turn",
    roleGate: { minRole: "USER" },

    async get(
      runtime: IAgentRuntime,
      _message: Memory,
      _state: State,
    ): Promise<ProviderResult> {
      const sections: string[] = [];

      try {
        // Fetch all tasks
        const allTasks = await runtime.getTasks({
          agentIds: [runtime.agentId],
        });

        // Separate workbench tasks from triggers and todos
        const workbenchTasks: Task[] = [];
        for (const task of allTasks) {
          if (readTriggerConfig(task)) continue; // skip triggers
          if (isWorkbenchTodoTask(task)) continue; // skip todos
          workbenchTasks.push(task);
        }

        // Active (non-completed) tasks first
        const activeTasks = workbenchTasks
          .filter((t) => !readTaskCompleted(t))
          .slice(0, MAX_TASKS_IN_CONTEXT);
        const completedTasks = workbenchTasks
          .filter((t) => readTaskCompleted(t))
          .slice(0, 5);

        if (activeTasks.length > 0 || completedTasks.length > 0) {
          sections.push("## Active Tasks");
          for (const task of activeTasks) {
            sections.push(formatTaskForContext(task));
          }
          if (completedTasks.length > 0) {
            sections.push("");
            sections.push("## Recently Completed Tasks");
            for (const task of completedTasks) {
              sections.push(formatTaskForContext(task));
            }
          }
        }

        // Fetch trigger tasks
        const triggerTasks = await listTriggerTasks(runtime);
        const activeTriggers = triggerTasks
          .filter((t) => {
            const cfg = readTriggerConfig(t);
            return cfg?.enabled;
          })
          .slice(0, MAX_TRIGGERS_IN_CONTEXT);

        if (activeTriggers.length > 0) {
          if (sections.length > 0) sections.push("");
          sections.push("## Active Automations");
          for (const task of activeTriggers) {
            const line = formatTriggerForContext(task);
            if (line) sections.push(line);
          }
        }
      } catch (err) {
        runtime.logger.debug(
          { src: "tasks-provider", error: String(err) },
          "Failed to load tasks for context",
        );
        return { text: "" };
      }

      if (sections.length === 0) {
        return { text: "" };
      }

      return {
        text: sections.join("\n"),
        values: {
          hasActiveTasks: true,
        },
      };
    },
  };
}

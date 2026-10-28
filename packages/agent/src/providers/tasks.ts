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
import { readTaskCompleted, toWorkbenchTask } from "@elizaos/host/protocol";
import { listTriggerTasks, readTriggerConfig } from "../triggers/runtime.ts";

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
      message: Memory,
      _state: State,
    ): Promise<ProviderResult> {
      const sections: string[] = [];

      try {
        // Fetch all tasks
        const allTasks = await runtime.getTasks({
          agentIds: [runtime.agentId],
        });

        // Match the automation feed's owner-work contract. Internal queue and
        // maintenance records are not workbench tasks merely because they lack
        // trigger or todo metadata. Their execution and stored rows are unchanged.
        const workbenchTasks = allTasks.filter(
          (task) => toWorkbenchTask(task) !== null,
        );

        // Active (non-completed) tasks first
        const activeTasks = workbenchTasks.filter((t) => !readTaskCompleted(t));
        const completedTasks = workbenchTasks.filter((t) =>
          readTaskCompleted(t),
        );

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
        const activeTriggers = triggerTasks.filter((t) => {
          const cfg = readTriggerConfig(t);
          return cfg?.enabled;
        });

        if (activeTriggers.length > 0) {
          if (sections.length > 0) sections.push("");
          sections.push("## Active Automations");
          for (const task of activeTriggers) {
            const line = formatTriggerForContext(task);
            if (line) sections.push(line);
          }
        }
      } catch (err) {
        // error-policy:J4 a failed task read must not read as "no tasks":
        // surface it and tell the model the context is missing.
        runtime.reportError("OngoingTasksProvider.get", err, {
          roomId: message.roomId,
        });
        return {
          text: "Task and automation context is unavailable because the task store read failed. Do not infer that there are no tasks or automations; state the gap.",
          values: { tasksUnavailable: true },
          data: { tasksUnavailable: true },
        };
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

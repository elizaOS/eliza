/**
 * PROMOTE_TASK_TO_WORKFLOW action — generates an n8n workflow from an
 * existing task or trigger.
 *
 * Mirrors AutomationsView.promoteAutomationToWorkflow, which seeds
 * createWorkflowDraft with a compilation prompt built from the task's
 * coordinator instructions and schedule. Here we build the same prompt and
 * call POST /api/n8n/workflows/generate directly.
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
  UUID,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  readTriggerConfig,
  taskToTriggerSummary,
} from "../../triggers/runtime.js";
import type { TriggerConfig, TriggerSummary } from "../../triggers/types.js";
import { fetchJson, getApiBase, type N8nWorkflowResponse } from "./api.js";

const PROMOTE_TASK_TO_WORKFLOW_ACTION = "PROMOTE_TASK_TO_WORKFLOW";

interface PromoteTaskParameters {
  taskId?: unknown;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function buildSchedulePrompt(trigger: TriggerConfig | TriggerSummary): string {
  if (trigger.triggerType === "interval") {
    return `Schedule: every ${trigger.intervalMs ?? 0} ms.`;
  }
  if (trigger.triggerType === "once") {
    return `One-shot at ${trigger.scheduledAtIso ?? "unknown time"}.`;
  }
  if (trigger.triggerType === "cron") {
    return `Cron: ${trigger.cronExpression ?? "unknown"}.`;
  }
  if (trigger.triggerType === "event") {
    return `Event: ${trigger.eventKind ?? "event"}.`;
  }
  return `Schedule type: ${trigger.triggerType}.`;
}

function buildPromotePrompt(
  task: Task,
  trigger: TriggerConfig | null,
  summary: TriggerSummary | null,
): { prompt: string; title: string } {
  const title = (
    summary?.displayName ??
    task.name ??
    "Promoted automation"
  ).trim();
  const lines = [
    "Compile this coordinator automation into an n8n workflow.",
    `Automation title: ${title}`,
    `Description: ${task.description?.trim() || "No additional description provided."}`,
    "Keep the workflow in this dedicated automation room.",
    "Use runtime actions and providers as workflow nodes when they fit the job.",
    "Use owner-scoped LifeOps nodes for Gmail, Calendar, Signal, Telegram, Discord, and GitHub when they are set up. If not, request the required setup or keys.",
  ];

  if (trigger) {
    lines.push(`Coordinator instructions: ${trigger.instructions}`);
    lines.push(buildSchedulePrompt(trigger));
  }

  lines.push(
    "Ask follow-up questions only when workflow intent is genuinely ambiguous.",
  );
  return { prompt: lines.join("\n"), title: `${title} Workflow` };
}

export const promoteTaskToWorkflowAction: Action = {
  name: PROMOTE_TASK_TO_WORKFLOW_ACTION,
  contexts: ["automation", "tasks", "agent_internal"],
  roleGate: { minRole: "OWNER" },
  similes: [
    "PROMOTE_TASK",
    "PROMOTE_TO_WORKFLOW",
    "COMPILE_TO_WORKFLOW",
    "COMPILE_TASK_TO_WORKFLOW",
    "CONVERT_TASK_TO_WORKFLOW",
    "TASK_TO_WORKFLOW",
    "PROMOTE_AUTOMATION",
  ],
  description:
    "Promote an existing task or trigger into a full n8n workflow. Builds a compilation prompt from the task's instructions and schedule, then generates a new workflow.",
  descriptionCompressed:
    "promote exist task trigger full n8n workflow build compilation prompt task instruction schedule, generate new workflow",
  validate: async () => true,
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult | undefined> => {
    const params = (options?.parameters ?? {}) as PromoteTaskParameters;
    const taskId = readString(params.taskId);
    if (!taskId) {
      return { success: false, text: "taskId parameter is required." };
    }

    const task = await runtime.getTask(taskId as UUID);
    if (!task?.id) {
      return { success: false, text: `Task not found: ${taskId}` };
    }

    const trigger = readTriggerConfig(task);
    const summary = taskToTriggerSummary(task);
    const { prompt, title } = buildPromotePrompt(task, trigger, summary);

    const base = getApiBase();
    const result = await fetchJson<N8nWorkflowResponse>(
      `${base}/api/n8n/workflows/generate`,
      {
        method: "POST",
        body: JSON.stringify({ prompt, name: title }),
      },
    );

    if (!result.ok || !result.data?.id) {
      const errMsg =
        result.raw || `Failed to generate workflow (${result.status})`;
      logger.warn(`[promote-task-to-workflow] failed: ${errMsg}`);
      return { success: false, text: errMsg };
    }

    const workflow = result.data;
    const successText = `Promoted "${task.name}" to workflow "${workflow.name}".`;
    if (callback) {
      await callback({
        text: successText,
        action: PROMOTE_TASK_TO_WORKFLOW_ACTION,
        metadata: {
          taskId,
          workflowId: workflow.id,
          workflowName: workflow.name,
        },
      });
    }
    return {
      success: true,
      text: successText,
      values: { taskId, workflowId: workflow.id, workflowName: workflow.name },
      data: { task: { id: task.id, name: task.name }, workflow },
    };
  },

  parameters: [
    {
      name: "taskId",
      description: "ID of the task or trigger to compile into a workflow.",
      required: true,
      schema: { type: "string" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Promote my morning standup task into a real workflow.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Promoted "Morning standup" to workflow "Morning standup Workflow".',
          action: PROMOTE_TASK_TO_WORKFLOW_ACTION,
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Compile that inbox sweep trigger into an n8n workflow.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Promoted "Inbox sweep" to workflow "Inbox sweep Workflow".',
          action: PROMOTE_TASK_TO_WORKFLOW_ACTION,
        },
      },
    ],
  ] as ActionExample[][],
};

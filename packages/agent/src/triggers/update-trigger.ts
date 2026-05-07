/**
 * UPDATE_TRIGGER_TASK action — mutates an existing trigger by id.
 *
 * Mirrors the PUT /api/triggers/:id route used by AutomationsView.HeartbeatForm
 * save path. Accepts partial updates: any field omitted from `parameters`
 * keeps its previous value.
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
  TriggerKind,
  TriggerType,
  TriggerWakeMode,
} from "@elizaos/core";
import { hasOwnerAccess } from "../security/access.js";
import {
  listTriggerTasks,
  readTriggerConfig,
  readTriggerRuns,
  taskToTriggerSummary,
  triggersFeatureEnabled,
} from "./runtime.js";
import {
  buildTriggerConfig,
  buildTriggerMetadata,
  DISABLED_TRIGGER_INTERVAL_MS,
  normalizeTriggerDraft,
} from "./scheduling.js";
import type { TriggerTaskMetadata } from "./types.js";

const UPDATE_TRIGGER_TASK_ACTION = "UPDATE_TRIGGER_TASK";

interface UpdateTriggerParameters {
  triggerId?: unknown;
  displayName?: unknown;
  instructions?: unknown;
  triggerType?: unknown;
  intervalMs?: unknown;
  scheduledAtIso?: unknown;
  cronExpression?: unknown;
  eventKind?: unknown;
  maxRuns?: unknown;
  enabled?: unknown;
  wakeMode?: unknown;
  timezone?: unknown;
  kind?: unknown;
  workflowId?: unknown;
  workflowName?: unknown;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
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

function readTriggerType(value: unknown): TriggerType | undefined {
  const s = readString(value)?.toLowerCase();
  if (s === "interval" || s === "once" || s === "cron" || s === "event") {
    return s;
  }
  return undefined;
}

function readWakeMode(value: unknown): TriggerWakeMode | undefined {
  const s = readString(value);
  if (s === "inject_now" || s === "next_autonomy_cycle") return s;
  return undefined;
}

function readKind(value: unknown): TriggerKind | undefined {
  const s = readString(value);
  if (s === "text" || s === "workflow") return s;
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

export const updateTriggerTaskAction: Action = {
  name: UPDATE_TRIGGER_TASK_ACTION,
  contexts: ["automation", "tasks", "agent_internal"],
  roleGate: { minRole: "OWNER" },
  similes: [
    "UPDATE_TRIGGER",
    "EDIT_TRIGGER",
    "MODIFY_TRIGGER",
    "UPDATE_HEARTBEAT",
    "EDIT_HEARTBEAT",
    "UPDATE_AUTOMATION",
    "EDIT_AUTOMATION",
    "RESCHEDULE_TRIGGER",
    "TOGGLE_TRIGGER",
    "ENABLE_TRIGGER",
    "DISABLE_TRIGGER",
  ],
  description:
    "Update an existing scheduled trigger by id. Use to change a trigger's schedule, instructions, name, or enabled state. Accepts partial updates — only the fields you provide change.",
  validate: async (runtime, message) => {
    if (!triggersFeatureEnabled(runtime)) return false;
    return hasOwnerAccess(runtime, message);
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
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
    if (!(await hasOwnerAccess(runtime, message))) {
      return {
        success: false,
        text: "Permission denied: only the owner may update triggers.",
      };
    }

    const params = (options?.parameters ?? {}) as UpdateTriggerParameters;
    const triggerId = readString(params.triggerId);
    if (!triggerId) {
      return { success: false, text: "triggerId parameter is required." };
    }

    const task = await findTriggerTask(runtime, triggerId);
    if (!task?.id) {
      return { success: false, text: `Trigger not found: ${triggerId}` };
    }

    const current = readTriggerConfig(task);
    if (!current) {
      return { success: false, text: "Trigger metadata is invalid." };
    }

    const enabledOverride = readBoolean(params.enabled);
    const nextKind = readKind(params.kind) ?? current.kind;
    const nextWorkflowId = readString(params.workflowId) ?? current.workflowId;
    const nextWorkflowName =
      readString(params.workflowName) ?? current.workflowName;
    if (nextKind === "workflow" && !nextWorkflowId) {
      return {
        success: false,
        text: "workflowId is required when kind is 'workflow'.",
      };
    }

    const normalized = normalizeTriggerDraft({
      input: {
        displayName: readString(params.displayName),
        instructions: readString(params.instructions),
        triggerType: readTriggerType(params.triggerType),
        wakeMode: readWakeMode(params.wakeMode),
        enabled:
          enabledOverride === undefined ? current.enabled : enabledOverride,
        createdBy: current.createdBy,
        timezone: readString(params.timezone),
        intervalMs: readNumber(params.intervalMs) ?? current.intervalMs,
        scheduledAtIso:
          readString(params.scheduledAtIso) ?? current.scheduledAtIso,
        cronExpression:
          readString(params.cronExpression) ?? current.cronExpression,
        eventKind: readString(params.eventKind) ?? current.eventKind,
        maxRuns: readNumber(params.maxRuns) ?? current.maxRuns,
        kind: nextKind,
        workflowId: nextWorkflowId,
        workflowName: nextWorkflowName,
      },
      fallback: {
        displayName: current.displayName,
        instructions: current.instructions,
        triggerType: current.triggerType,
        wakeMode: current.wakeMode,
        enabled:
          enabledOverride === undefined ? current.enabled : enabledOverride,
        createdBy: current.createdBy,
      },
    });
    if (!normalized.draft) {
      return {
        success: false,
        text: normalized.error ?? "Invalid trigger update.",
      };
    }

    const nextTrigger = buildTriggerConfig({
      draft: normalized.draft,
      triggerId: current.triggerId,
      previous: current,
    });
    const existingMeta = (task.metadata ?? {}) as TriggerTaskMetadata;
    const existingRuns = readTriggerRuns(task);

    let nextMeta: TriggerTaskMetadata;
    const nowMs = Date.now();
    if (!nextTrigger.enabled) {
      nextMeta = {
        ...existingMeta,
        updatedAt: nowMs,
        updateInterval: DISABLED_TRIGGER_INTERVAL_MS,
        trigger: {
          ...nextTrigger,
          nextRunAtMs: nowMs + DISABLED_TRIGGER_INTERVAL_MS,
        },
        triggerRuns: existingRuns,
      };
    } else {
      const built = buildTriggerMetadata({
        existingMetadata: existingMeta,
        trigger: nextTrigger,
        nowMs,
      });
      if (!built) {
        return { success: false, text: "Unable to compute trigger schedule." };
      }
      nextMeta = built;
    }

    await runtime.updateTask(task.id, {
      description: nextTrigger.displayName,
      metadata: nextMeta as Task["metadata"],
    });
    const refreshed = await runtime.getTask(task.id);
    const summary = refreshed ? taskToTriggerSummary(refreshed) : null;
    const successText = `Updated trigger "${nextTrigger.displayName}".`;
    if (callback) {
      await callback({
        text: successText,
        action: UPDATE_TRIGGER_TASK_ACTION,
        metadata: { triggerId: nextTrigger.triggerId, taskId: String(task.id) },
      });
    }
    return {
      success: true,
      text: successText,
      values: { triggerId: nextTrigger.triggerId, taskId: String(task.id) },
      data: {
        triggerId: nextTrigger.triggerId,
        taskId: String(task.id),
        trigger: summary,
      },
    };
  },

  parameters: [
    {
      name: "triggerId",
      description: "ID of the trigger to update.",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "displayName",
      description: "New display name for the trigger.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "instructions",
      description: "New instructions text the trigger executes.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "triggerType",
      description: "Trigger type: interval, once, cron, or event.",
      required: false,
      schema: {
        type: "string" as const,
        enum: ["interval", "once", "cron", "event"],
      },
    },
    {
      name: "intervalMs",
      description: "Interval in milliseconds (for interval triggers).",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "scheduledAtIso",
      description: "ISO datetime to run once (for once triggers).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "cronExpression",
      description: "Cron expression (for cron triggers).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "eventKind",
      description: "Event kind name (for event triggers).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "maxRuns",
      description: "Maximum number of runs before the trigger auto-disables.",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "enabled",
      description: "Enable or disable the trigger without deleting it.",
      required: false,
      schema: { type: "boolean" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Pause my morning standup trigger." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Updated trigger "Morning standup".',
          action: UPDATE_TRIGGER_TASK_ACTION,
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Change that trigger to run every 10 minutes." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Updated trigger "Inbox sweep".',
          action: UPDATE_TRIGGER_TASK_ACTION,
        },
      },
    ],
  ] as ActionExample[][],
};

/**
 * Minimal reminder action for Shared edge runtimes. The host supplies the
 * canonical runner and a trusted current-DM destination; model parameters can
 * choose reminder content and timing but can never redirect delivery.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  Memory,
  Plugin,
} from "@elizaos/core/edge";
import type {
  ScheduledTask,
  ScheduledTaskRunner,
  ScheduledTaskTrigger,
} from "./scheduled-task/types.js";

/** Dedicated runtimes route imported Shared reminders through Cloud's trusted gateway. */
export const SHARED_CUTOVER_GATEWAY_CHANNEL = "shared_gateway_dm";

export const SHARED_REMINDERS_EDGE_COMPATIBILITY = {
  target: "edge",
  state: "scheduled-task",
  effects: ["tenant-postgres-write", "connector-send"],
  requiredBindings: ["HYPERDRIVE", "GATEWAY_INTERNAL_SECRET"],
  requiredSecrets: [],
} as const;

export interface SharedReminderDelivery {
  platform: "telegram";
  project: string;
  chatId: string;
}

export interface SharedRemindersEdgePluginOptions {
  runner: ScheduledTaskRunner;
  agentId: string;
  delivery: SharedReminderDelivery;
  now?: () => Date;
}

function parameters(options: unknown): Record<string, unknown> {
  if (!options || typeof options !== "object") return {};
  const record = options as Record<string, unknown>;
  return record.parameters && typeof record.parameters === "object"
    ? (record.parameters as Record<string, unknown>)
    : record;
}

function textParameter(
  input: Record<string, unknown>,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const value = input[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function positiveNumber(
  input: Record<string, unknown>,
  ...names: string[]
): number | undefined {
  for (const name of names) {
    const raw = input[name];
    const value = typeof raw === "number" ? raw : Number(raw);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

async function actionFailure(
  text: string,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  await callback?.({ text });
  return {
    success: false,
    text,
    error: text,
    data: { actionName: "REMINDERS" },
  };
}

function reminderTrigger(
  input: Record<string, unknown>,
  now: Date,
): ScheduledTaskTrigger | undefined {
  const inMinutes = positiveNumber(input, "inMinutes", "minutesFromNow");
  if (inMinutes !== undefined) {
    return {
      kind: "once",
      atIso: new Date(now.getTime() + inMinutes * 60_000).toISOString(),
    };
  }
  const atIso = textParameter(input, "atIso", "at");
  if (atIso && Number.isFinite(Date.parse(atIso))) {
    return { kind: "once", atIso: new Date(atIso).toISOString() };
  }
  const everyMinutes = positiveNumber(input, "everyMinutes");
  if (everyMinutes !== undefined) {
    return { kind: "interval", everyMinutes };
  }
  const expression = textParameter(input, "cronExpression", "cron");
  const tz = textParameter(input, "timezone", "tz");
  if (expression && tz) return { kind: "cron", expression, tz };
  return undefined;
}

function taskSummary(task: ScheduledTask): string {
  const when =
    task.trigger.kind === "once"
      ? task.trigger.atIso
      : task.trigger.kind === "interval"
        ? `every ${task.trigger.everyMinutes} minutes`
        : task.trigger.kind === "cron"
          ? `${task.trigger.expression} (${task.trigger.tz})`
          : task.trigger.kind;
  return `${task.taskId}: ${task.output?.fallback?.body ?? task.promptInstructions} — ${when} [${task.state.status}]`;
}

export function createSharedRemindersEdgeAction(
  options: SharedRemindersEdgePluginOptions,
): Action {
  const now = options.now ?? (() => new Date());
  const delivery = {
    platform: options.delivery.platform,
    project: options.delivery.project.trim(),
    chatId: options.delivery.chatId.trim(),
  };
  if (!delivery.project || !delivery.chatId) {
    throw new Error(
      "Shared reminders require a trusted current-DM destination",
    );
  }

  return {
    name: "REMINDERS",
    similes: [
      "REMIND_ME",
      "SET_REMINDER",
      "LIST_REMINDERS",
      "SNOOZE_REMINDER",
      "DISMISS_REMINDER",
    ],
    tags: ["resource:scheduled-item", "capability:read", "capability:write"],
    contexts: ["reminders", "general"],
    roleGate: { minRole: "GUEST" },
    description:
      "Create, list, snooze, complete, or dismiss free reminders delivered only to this current verified private chat. For create, supply reminderText and one schedule: inMinutes, atIso, everyMinutes, or cronExpression plus timezone.",
    parameters: [
      {
        name: "operation",
        description: "Reminder operation.",
        required: true,
        schema: {
          type: "string",
          enum: ["create", "list", "snooze", "complete", "dismiss"],
        },
      },
      {
        name: "reminderText",
        description: "What Eliza should remind the user about.",
        schema: { type: "string" },
      },
      {
        name: "taskId",
        description: "Reminder id for snooze, complete, or dismiss.",
        schema: { type: "string" },
      },
      {
        name: "inMinutes",
        description: "One-off delay from now in minutes.",
        schema: { type: "number" },
      },
      {
        name: "atIso",
        description: "One-off absolute ISO-8601 timestamp.",
        schema: { type: "string" },
      },
      {
        name: "everyMinutes",
        description: "Recurring interval in minutes.",
        schema: { type: "number" },
      },
      {
        name: "cronExpression",
        description: "Five-field cron expression for a recurring reminder.",
        schema: { type: "string" },
      },
      {
        name: "timezone",
        description: "IANA timezone required with cronExpression.",
        schema: { type: "string" },
      },
      {
        name: "snoozeMinutes",
        description: "Positive snooze duration in minutes.",
        schema: { type: "number" },
      },
    ],
    validate: async () => true,
    handler: async (
      _runtime,
      message: Memory,
      _state,
      rawOptions,
      callback?: HandlerCallback,
    ): Promise<ActionResult> => {
      const input = parameters(rawOptions);
      const operation = textParameter(
        input,
        "operation",
        "action",
      )?.toLowerCase();
      if (operation === "list") {
        const tasks = await options.runner.list({
          kind: "reminder",
          ownerVisibleOnly: true,
        });
        const text =
          tasks.length === 0
            ? "You have no reminders."
            : tasks.map(taskSummary).join("\n");
        await callback?.({ text });
        return {
          success: true,
          text,
          data: { actionName: "REMINDERS", operation, tasks },
        };
      }

      if (operation === "create") {
        const body = textParameter(input, "reminderText", "text", "body");
        if (!body)
          return await actionFailure("Reminder text is required.", callback);
        const trigger = reminderTrigger(input, now());
        if (!trigger) {
          return await actionFailure(
            "A reminder time is required: inMinutes, atIso, everyMinutes, or cronExpression with timezone.",
            callback,
          );
        }
        const task = await options.runner.schedule({
          kind: "reminder",
          promptInstructions: body,
          trigger,
          priority: "medium",
          escalation: {
            steps: [{ delayMinutes: 0, channelKey: "current_dm" }],
          },
          output: {
            destination: "channel",
            target: "current_dm",
            fallback: { body },
          },
          subject: { kind: "self", id: options.agentId },
          idempotencyKey: `shared-reminder:${String(message.id)}:create`,
          respectsGlobalPause: true,
          source: "user_chat",
          createdBy: options.agentId,
          ownerVisible: true,
          metadata: { delivery },
          executionProfile: "notify-only",
        });
        const text = `Reminder set for ${taskSummary(task)}`;
        await callback?.({ text });
        return {
          success: true,
          text,
          data: { actionName: "REMINDERS", operation, task },
        };
      }

      if (operation === "snooze") {
        const taskId = textParameter(input, "taskId");
        const minutes = positiveNumber(input, "snoozeMinutes", "minutes");
        if (!taskId || minutes === undefined) {
          return await actionFailure(
            "Snoozing requires taskId and snoozeMinutes.",
            callback,
          );
        }
        const task = await options.runner.apply(taskId, "snooze", { minutes });
        const text = `Reminder ${task.taskId} snoozed for ${minutes} minutes.`;
        await callback?.({ text });
        return {
          success: true,
          text,
          data: { actionName: "REMINDERS", operation, task },
        };
      }

      if (operation === "complete" || operation === "dismiss") {
        const taskId = textParameter(input, "taskId");
        if (!taskId)
          return await actionFailure(
            "A reminder taskId is required.",
            callback,
          );
        const task = await options.runner.apply(taskId, operation);
        const text = `Reminder ${task.taskId} ${operation === "complete" ? "completed" : "dismissed"}.`;
        await callback?.({ text });
        return {
          success: true,
          text,
          data: { actionName: "REMINDERS", operation, task },
        };
      }

      return await actionFailure(
        "Choose create, list, snooze, complete, or dismiss.",
        callback,
      );
    },
  };
}

export function createSharedRemindersEdgePlugin(
  options: SharedRemindersEdgePluginOptions,
): Plugin {
  return {
    name: "shared-reminders-edge",
    description:
      "Free reminders persisted by the canonical scheduler and locked to the current verified private chat.",
    actions: [createSharedRemindersEdgeAction(options)],
  };
}

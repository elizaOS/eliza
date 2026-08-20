/**
 * Minimal reminder action for Shared edge runtimes. The host supplies the
 * canonical runner and a trusted current-DM destination; model parameters can
 * choose reminder content and timing but can never redirect delivery.
 */

import type {
  Action,
  ActionResult,
  EffectReceipt,
  HandlerCallback,
  Memory,
  Plugin,
} from "@elizaos/core/edge";
import type {
  ScheduledTask,
  ScheduledTaskApplyResult,
  ScheduledTaskRunner,
  ScheduledTaskTrigger,
} from "./scheduled-task/types.js";
import { resolveExplicitSharedReminderDelay } from "./shared-reminder-relative-delay.js";

/** Dedicated runtimes route imported Shared reminders through Cloud's trusted gateway. */
export const SHARED_CUTOVER_GATEWAY_CHANNEL = "shared_gateway_dm";
export const SHARED_REMINDER_MAX_TEXT_LENGTH = 2000;
const MAX_DATE_TIMESTAMP_MS = 8_640_000_000_000_000;

export const SHARED_REMINDERS_EDGE_COMPATIBILITY = {
  target: "edge",
  state: "scheduled-task",
  effects: ["tenant-postgres-write", "connector-send"],
  requiredBindings: ["HYPERDRIVE", "GATEWAY_INTERNAL_SECRET"],
  requiredSecrets: [],
} as const;

export type SharedReminderDelivery =
  | {
      platform: "telegram";
      project: string;
      chatId: string;
    }
  | {
      platform: "blooio";
      project: string;
      phoneNumber: string;
    }
  | {
      platform: "discord";
      discordUserId: string;
    };

/** Validates the server-owned private destination stored with a Shared reminder. */
export function parseSharedReminderDelivery(
  value: unknown,
): SharedReminderDelivery | undefined {
  if (!value || typeof value !== "object") return undefined;
  const delivery = value as Record<string, unknown>;
  if (
    delivery.platform === "telegram" &&
    typeof delivery.project === "string" &&
    /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(delivery.project) &&
    typeof delivery.chatId === "string" &&
    /^-?\d{1,20}$/.test(delivery.chatId)
  ) {
    return {
      platform: "telegram",
      project: delivery.project,
      chatId: delivery.chatId,
    };
  }
  if (
    delivery.platform === "blooio" &&
    typeof delivery.project === "string" &&
    /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(delivery.project) &&
    typeof delivery.phoneNumber === "string" &&
    /^\+[1-9]\d{6,14}$/.test(delivery.phoneNumber)
  ) {
    return {
      platform: "blooio",
      project: delivery.project,
      phoneNumber: delivery.phoneNumber,
    };
  }
  if (
    delivery.platform === "discord" &&
    typeof delivery.discordUserId === "string" &&
    /^\d{1,32}$/.test(delivery.discordUserId)
  ) {
    return {
      platform: "discord",
      discordUserId: delivery.discordUserId,
    };
  }
  return undefined;
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
  explicitDelayMilliseconds?: number,
): ScheduledTaskTrigger | undefined {
  if (explicitDelayMilliseconds !== undefined) {
    const at = now.getTime() + explicitDelayMilliseconds;
    if (Number.isFinite(at) && Math.abs(at) <= MAX_DATE_TIMESTAMP_MS) {
      return { kind: "once", atIso: new Date(at).toISOString() };
    }
    return undefined;
  }
  const inMinutes = positiveNumber(input, "inMinutes", "minutesFromNow");
  if (inMinutes !== undefined) {
    const milliseconds = minuteDurationMilliseconds(inMinutes);
    if (milliseconds === undefined) return undefined;
    const at = now.getTime() + milliseconds;
    if (!Number.isFinite(at) || Math.abs(at) > MAX_DATE_TIMESTAMP_MS) {
      return undefined;
    }
    return {
      kind: "once",
      atIso: new Date(at).toISOString(),
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

const UTC_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const CRON_WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

function reminderText(task: ScheduledTask): string {
  return task.output?.fallback?.body ?? task.promptInstructions;
}

function formatUtcInstant(atIso: string): string {
  const instant = new Date(atIso);
  if (!Number.isFinite(instant.getTime())) {
    throw new Error("Shared reminder has an invalid one-off schedule");
  }
  const hour = instant.getUTCHours();
  const hour12 = hour % 12 || 12;
  const minute = String(instant.getUTCMinutes()).padStart(2, "0");
  const seconds = instant.getUTCSeconds();
  const milliseconds = instant.getUTCMilliseconds();
  const preciseTime =
    seconds === 0 && milliseconds === 0
      ? `${hour12}:${minute}`
      : `${hour12}:${minute}:${String(seconds).padStart(2, "0")}${
          milliseconds === 0 ? "" : `.${String(milliseconds).padStart(3, "0")}`
        }`;
  const meridiem = hour < 12 ? "AM" : "PM";
  return `on ${UTC_MONTHS[instant.getUTCMonth()]} ${instant.getUTCDate()}, ${instant.getUTCFullYear()} at ${preciseTime} ${meridiem} UTC`;
}

function formatDuration(milliseconds: number): string {
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new Error(
      "Shared reminder duration must be a positive whole millisecond",
    );
  }
  const minutes = Math.floor(milliseconds / 60_000);
  const remainder = milliseconds % 60_000;
  const parts: string[] = [];
  if (minutes > 0)
    parts.push(`${minutes} ${minutes === 1 ? "minute" : "minutes"}`);
  if (remainder >= 1_000) {
    const seconds = Math.floor(remainder / 1_000);
    const fraction = remainder % 1_000;
    const amount =
      fraction === 0
        ? String(seconds)
        : `${seconds}.${String(fraction).padStart(3, "0").replace(/0+$/, "")}`;
    parts.push(`${amount} ${amount === "1" ? "second" : "seconds"}`);
  } else if (remainder > 0) {
    parts.push(
      `${remainder} ${remainder === 1 ? "millisecond" : "milliseconds"}`,
    );
  }
  return parts.join(" and ");
}

function minuteDurationMilliseconds(minutes: number): number | undefined {
  const milliseconds = minutes * 60_000;
  return Number.isSafeInteger(milliseconds) && milliseconds > 0
    ? milliseconds
    : undefined;
}

function formatClockTime(hour: number, minute: number): string {
  const hour12 = hour % 12 || 12;
  const meridiem = hour < 12 ? "AM" : "PM";
  return `${hour12}:${String(minute).padStart(2, "0")} ${meridiem}`;
}

function cronScheduleDescription(expression: string, timezone: string): string {
  const fields = expression.trim().split(/\s+/);
  if (fields.length === 5) {
    const [minuteField, hourField, dayOfMonth, month, dayOfWeek] = fields;
    const minute = Number(minuteField);
    const hour = Number(hourField);
    const simpleTime =
      /^\d{1,2}$/.test(minuteField ?? "") &&
      /^\d{1,2}$/.test(hourField ?? "") &&
      minute >= 0 &&
      minute <= 59 &&
      hour >= 0 &&
      hour <= 23;
    if (simpleTime && dayOfMonth === "*" && month === "*") {
      if (dayOfWeek === "*") {
        return `every day at ${formatClockTime(hour, minute)} in ${timezone}`;
      }
      if (/^[0-7]$/.test(dayOfWeek ?? "")) {
        const weekday = CRON_WEEKDAYS[Number(dayOfWeek) % 7];
        return `every ${weekday} at ${formatClockTime(hour, minute)} in ${timezone}`;
      }
    }
  }
  return `on its recurring schedule in ${timezone}`;
}

function scheduleDescription(trigger: ScheduledTaskTrigger): string {
  switch (trigger.kind) {
    case "once":
      return formatUtcInstant(trigger.atIso);
    case "interval":
      return `every ${trigger.everyMinutes} ${trigger.everyMinutes === 1 ? "minute" : "minutes"}`;
    case "cron":
      return cronScheduleDescription(trigger.expression, trigger.tz);
    case "event":
      return "when its scheduled event occurs";
    case "after_task":
      return "after its linked task";
    case "manual":
      return "when you ask it to run";
    case "relative_to_anchor":
      return "relative to its scheduled anchor";
    case "during_window":
      return "during its scheduled window";
  }
}

function requestedScheduleDescription(
  input: Record<string, unknown>,
  trigger: ScheduledTaskTrigger,
  explicitDelayMilliseconds?: number,
): string {
  if (explicitDelayMilliseconds !== undefined) {
    return `in ${formatDuration(explicitDelayMilliseconds)}`;
  }
  const inMinutes = positiveNumber(input, "inMinutes", "minutesFromNow");
  const inMilliseconds =
    inMinutes === undefined ? undefined : minuteDurationMilliseconds(inMinutes);
  return inMilliseconds === undefined
    ? scheduleDescription(trigger)
    : `in ${formatDuration(inMilliseconds)}`;
}

function taskSummary(task: ScheduledTask): string {
  return `${reminderText(task)} — ${taskScheduleDescription(task)}`;
}

function taskScheduleDescription(task: ScheduledTask): string {
  if (task.state.status === "scheduled" && task.state.firedAt) {
    return formatUtcInstant(task.state.firedAt);
  }
  return scheduleDescription(task.trigger);
}

function creationReceipt(args: {
  task: ScheduledTask;
  commit: { logId: string; occurredAtIso: string };
  replayed: boolean;
}): EffectReceipt {
  const base = {
    receiptId: `shared-reminder:create:${args.commit.logId}`,
    operation: "shared.reminder.create",
    resource: {
      kind: "shared.reminder",
      id: args.task.taskId,
      version: args.commit.logId,
    },
    artifacts: [
      {
        kind: "shared.reminder.log",
        id: args.commit.logId,
        version: "scheduled",
      },
    ],
    idempotency: {
      key: args.task.idempotencyKey ?? null,
      replayed: args.replayed,
    },
    observedAt: args.commit.occurredAtIso,
  } as const;
  return args.replayed
    ? {
        ...base,
        outcome: "noop",
        idempotency: {
          key: args.task.idempotencyKey ?? null,
          replayed: true,
        },
        reason:
          "The persisted reminder already satisfies this idempotent request.",
      }
    : {
        ...base,
        outcome: "applied",
        commit: {
          kind: "durable",
          id: args.commit.logId,
          committedAt: args.commit.occurredAtIso,
        },
      };
}

function lifecycleReceipt(
  operation: "snooze" | "complete" | "dismiss",
  result: ScheduledTaskApplyResult,
): EffectReceipt {
  const base = {
    receiptId: `shared-reminder:${operation}:${result.commit.logId}`,
    operation: `shared.reminder.${operation}`,
    resource: {
      kind: "shared.reminder",
      id: result.task.taskId,
      version: result.commit.logId,
    },
    artifacts: [
      {
        kind: "shared.reminder.log",
        id: result.commit.logId,
        version: result.commit.transition,
      },
    ],
    idempotency: {
      key: result.idempotencyKey,
      replayed: result.replayed,
    },
    observedAt: result.commit.occurredAtIso,
  } as const;
  return result.replayed
    ? {
        ...base,
        outcome: "noop",
        reason:
          "The persisted reminder already records this idempotent lifecycle request.",
      }
    : {
        ...base,
        outcome: "applied",
        commit: {
          kind: "durable",
          id: result.commit.logId,
          committedAt: result.commit.occurredAtIso,
        },
      };
}

export function createSharedRemindersEdgeAction(
  options: SharedRemindersEdgePluginOptions,
): Action {
  const now = options.now ?? (() => new Date());
  const delivery = parseSharedReminderDelivery(options.delivery);
  if (!delivery) {
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
          status: ["scheduled", "fired", "acknowledged"],
        });
        const text =
          tasks.length === 0
            ? "You have no reminders."
            : `Your reminders:\n${tasks.map((task) => `• ${taskSummary(task)}`).join("\n")}`;
        await callback?.({ text });
        return {
          success: true,
          text,
          data: { actionName: "REMINDERS", operation, tasks },
          verifiedUserFacing: true,
          userFacingText: text,
          turnComplete: true,
        };
      }

      if (operation === "create") {
        const body = textParameter(input, "reminderText", "text", "body");
        if (!body)
          return await actionFailure("Reminder text is required.", callback);
        if (body.length > SHARED_REMINDER_MAX_TEXT_LENGTH) {
          return await actionFailure(
            `Reminder text must be ${SHARED_REMINDER_MAX_TEXT_LENGTH} characters or fewer.`,
            callback,
          );
        }
        const explicitDelay = resolveExplicitSharedReminderDelay(
          message.content?.text,
        );
        if (explicitDelay.kind === "invalid") {
          return await actionFailure(explicitDelay.reason, callback);
        }
        const inputMinutes = positiveNumber(
          input,
          "inMinutes",
          "minutesFromNow",
        );
        if (
          explicitDelay.kind === "absent" &&
          inputMinutes !== undefined &&
          minuteDurationMilliseconds(inputMinutes) === undefined
        ) {
          return await actionFailure(
            "Reminder delay must resolve to a positive whole millisecond.",
            callback,
          );
        }
        const trigger = reminderTrigger(
          input,
          now(),
          explicitDelay.kind === "resolved"
            ? explicitDelay.milliseconds
            : undefined,
        );
        if (!trigger) {
          return await actionFailure(
            "A reminder time is required: inMinutes, atIso, everyMinutes, or cronExpression with timezone.",
            callback,
          );
        }
        const scheduled = await options.runner.scheduleWithResult({
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
        const schedule = scheduled.replayed
          ? taskScheduleDescription(scheduled.task)
          : requestedScheduleDescription(
              input,
              scheduled.task.trigger,
              explicitDelay.kind === "resolved"
                ? explicitDelay.milliseconds
                : undefined,
            );
        const persistedBody = reminderText(scheduled.task);
        const text = scheduled.replayed
          ? `That reminder is already set ${schedule}: ${persistedBody}`
          : `Got it — I'll remind you ${schedule}: ${persistedBody}`;
        const receipt = creationReceipt(scheduled);
        await callback?.({ text });
        return {
          success: true,
          text,
          data: {
            actionName: "REMINDERS",
            operation,
            task: scheduled.task,
            replayed: scheduled.replayed,
          },
          verifiedUserFacing: true,
          userFacingText: text,
          effectReceipts: [receipt],
          userFacingEffectReceiptIds: [receipt.receiptId],
          turnComplete: true,
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
        const snoozeMilliseconds = minuteDurationMilliseconds(minutes);
        if (snoozeMilliseconds === undefined) {
          return await actionFailure(
            "Snooze duration must resolve to a positive whole millisecond.",
            callback,
          );
        }
        const applied = await options.runner.applyWithResult(
          taskId,
          "snooze",
          { minutes },
          {
            idempotencyKey: `shared-reminder:${String(message.id)}:snooze:${taskId}`,
          },
        );
        const text = `Reminder snoozed for ${formatDuration(snoozeMilliseconds)}: ${reminderText(applied.task)}`;
        const receipt = lifecycleReceipt("snooze", applied);
        await callback?.({ text });
        return {
          success: true,
          text,
          data: {
            actionName: "REMINDERS",
            operation,
            task: applied.task,
            replayed: applied.replayed,
          },
          verifiedUserFacing: true,
          userFacingText: text,
          effectReceipts: [receipt],
          userFacingEffectReceiptIds: [receipt.receiptId],
          turnComplete: true,
        };
      }

      if (operation === "complete" || operation === "dismiss") {
        const taskId = textParameter(input, "taskId");
        if (!taskId)
          return await actionFailure(
            "A reminder taskId is required.",
            callback,
          );
        const applied = await options.runner.applyWithResult(
          taskId,
          operation,
          undefined,
          {
            idempotencyKey: `shared-reminder:${String(message.id)}:${operation}:${taskId}`,
          },
        );
        const text = `Reminder ${operation === "complete" ? "completed" : "dismissed"}: ${reminderText(applied.task)}`;
        const receipt = lifecycleReceipt(operation, applied);
        await callback?.({ text });
        return {
          success: true,
          text,
          data: {
            actionName: "REMINDERS",
            operation,
            task: applied.task,
            replayed: applied.replayed,
          },
          verifiedUserFacing: true,
          userFacingText: text,
          effectReceipts: [receipt],
          userFacingEffectReceiptIds: [receipt.receiptId],
          turnComplete: true,
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

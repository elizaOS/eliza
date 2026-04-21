import type {
  Action,
  ActionResult,
  IAgentRuntime,
  Memory,
  State,
  UUID,
} from "@elizaos/core";
import {
  ModelType,
  parseJSONObjectFromText,
  parseKeyValueXml,
} from "@elizaos/core";
import { recentConversationTexts } from "./life-recent-context.js";
import { hasLifeOpsAccess, messageText } from "./lifeops-google-helpers.js";
import { scheduleOnceTriggerTask } from "./scheduled-trigger-task.js";

type ScheduleXDmReplyParams = {
  recipient?: string;
  text?: string;
  sendAtIso?: string;
};

type ScheduleXDmReplyPlan = {
  recipient?: string;
  text?: string;
  sendAtIso?: string;
  shouldAct?: boolean | null;
  response?: string;
};

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeShouldAct(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return null;
}

async function resolveSchedulePlan(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
}): Promise<ScheduleXDmReplyPlan> {
  const currentText = messageText(args.message).trim();
  const recent = await recentConversationTexts({
    runtime: args.runtime,
    message: args.message,
    state: args.state,
    limit: 8,
  });
  const nowIso = new Date().toISOString();
  const prompt = [
    "Plan a scheduled X/Twitter DM reply.",
    "Return ONLY valid JSON with exactly these fields:",
    "  recipient: X handle or user id without a leading @ when possible",
    "  text: the DM reply body",
    "  sendAtIso: the delivery time as an ISO-8601 timestamp",
    "  shouldAct: boolean",
    "  response: short follow-up if shouldAct is false or details are missing",
    "",
    "Interpret relative time phrases against the provided current time.",
    "If the user says '9am tomorrow', convert it to the correct ISO timestamp.",
    "",
    "Examples:",
    '  "Schedule a reply to @devfriend\'s Twitter DM for 9am tomorrow saying thanks for the intro." -> {"recipient":"devfriend","text":"thanks for the intro","sendAtIso":"<tomorrow at 09:00 local time as ISO>","shouldAct":true,"response":null}',
    '  "Queue an X DM reply to alice at 2pm saying I\'ll send the deck tonight." -> {"recipient":"alice","text":"I\'ll send the deck tonight.","sendAtIso":"<today at 14:00 local time as ISO>","shouldAct":true,"response":null}',
    '  "Schedule an X DM for later." -> {"recipient":null,"text":null,"sendAtIso":null,"shouldAct":false,"response":"Who should receive the X DM, what should it say, and when should I send it?"}',
    "",
    `Current time: ${nowIso}`,
    `Current request: ${JSON.stringify(currentText)}`,
    `Recent conversation: ${JSON.stringify(recent.join("\n"))}`,
  ].join("\n");

  try {
    const raw = await args.runtime.useModel(ModelType.TEXT_SMALL, { prompt });
    const parsed =
      parseKeyValueXml<Record<string, unknown>>(
        typeof raw === "string" ? raw : "",
      ) ?? parseJSONObjectFromText(typeof raw === "string" ? raw : "");
    if (!parsed) {
      return { shouldAct: null };
    }
    return {
      recipient: normalizeString(parsed.recipient),
      text: normalizeString(parsed.text),
      sendAtIso: normalizeString(parsed.sendAtIso),
      shouldAct: normalizeShouldAct(parsed.shouldAct),
      response: normalizeString(parsed.response),
    };
  } catch (error) {
    args.runtime.logger?.warn?.(
      {
        src: "action:schedule-x-dm-reply",
        error: error instanceof Error ? error.message : String(error),
      },
      "scheduled X DM planning failed",
    );
    return { shouldAct: null };
  }
}

export const scheduleXDmReplyAction: Action = {
  name: "SCHEDULE_X_DM_REPLY",
  similes: [
    "QUEUE_X_DM_REPLY",
    "SCHEDULE_TWITTER_DM_REPLY",
    "SCHEDULE_X_REPLY",
  ],
  description:
    "Schedule a Twitter/X DM reply to send later by creating a real trigger task. " +
    "Use this for requests like 'schedule a reply to @devfriend's Twitter DM for 9am tomorrow saying thanks for the intro'. " +
    "Do not use immediate REPLY_X_DM when the owner asks for future delivery.",
  validate: async (runtime, message) => hasLifeOpsAccess(runtime, message),
  handler: async (runtime, message, state, options): Promise<ActionResult> => {
    const params = ((options as { parameters?: ScheduleXDmReplyParams } | undefined)
      ?.parameters ?? {}) as ScheduleXDmReplyParams;
    const planned = await resolveSchedulePlan({ runtime, message, state });
    const recipient = normalizeString(params.recipient) ?? planned.recipient;
    const text = normalizeString(params.text) ?? planned.text;
    const sendAtIso = normalizeString(params.sendAtIso) ?? planned.sendAtIso;

    if (!recipient || !text || !sendAtIso || planned.shouldAct === false) {
      return {
        success: false,
        text:
          planned.response ??
          "Who should receive the X DM, what should it say, and when should I send it?",
        data: {
          actionName: "SCHEDULE_X_DM_REPLY",
          needsClarification: true,
        },
      };
    }

    const schedule = await scheduleOnceTriggerTask({
      runtime,
      message,
      displayName: `Send X DM to ${recipient}`,
      instructions: [
        "Send the queued X/Twitter DM reply now.",
        "Use REPLY_X_DM with confirmed=true.",
        `recipient: ${recipient}`,
        `text: ${text}`,
        "confirmed: true",
      ].join("\n"),
      scheduledAtIso: sendAtIso,
      dedupeKey: `schedule-x-dm-reply:${recipient}:${sendAtIso}:${text}`,
    });

    const taskId = schedule.taskId ?? schedule.duplicateTaskId;
    return {
      success: true,
      text: `Scheduled an X DM reply to ${recipient} for ${sendAtIso}.`,
      data: {
        actionName: "SCHEDULE_X_DM_REPLY",
        recipient,
        text,
        sendAtIso,
        taskId: taskId ?? null,
        triggerId: schedule.triggerId ?? null,
      },
    };
  },
};

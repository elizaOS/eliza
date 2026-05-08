import { randomUUID } from "node:crypto";
import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
} from "@elizaos/core";
import {
  type HelperRunOptions,
  MacosAlarmHelperUnavailableError,
  runHelper,
} from "./helper";
import type {
  CancelAlarmParams,
  MacosAlarmHelperCancelResponse,
  MacosAlarmHelperListResponse,
  MacosAlarmHelperScheduleResponse,
  ScheduleAlarmParams,
} from "./types";

export interface MacosAlarmActionDeps {
  helperOptions?: HelperRunOptions;
}

const ALARM_SUBACTIONS = ["set", "cancel", "list"] as const;
type AlarmSubaction = (typeof ALARM_SUBACTIONS)[number];

const NOT_SUPPORTED: ActionResult = {
  success: false,
  text: "I can only use native alarms on macOS.",
  error: "macos-only",
};
const ALARM_CONTEXTS = ["tasks", "calendar", "automation"] as const;
const ALARM_TERMS = [
  "alarm",
  "alarms",
  "wake",
  "despertador",
  "alarma",
  "alarmas",
  "reveil",
  "réveil",
  "alarme",
  "wecker",
  "alarm anzeigen",
  "闹钟",
  "提醒",
  "アラーム",
  "알람",
  "báo thức",
  "bao thuc",
];

function isDarwin(): boolean {
  return process.platform === "darwin";
}

function getText(message: Memory): string {
  return (message.content.text ?? "").toLowerCase();
}

function normalizeContextList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((item) => (typeof item === "string" ? [item.toLowerCase()] : []))
    .filter(Boolean);
}

function hasAlarmContext(message: Memory, state?: State): boolean {
  const values = state?.values ?? {};
  const content = message.content as Record<string, unknown>;
  const contexts = [
    ...normalizeContextList(values.activeContexts),
    ...normalizeContextList(values.selectedContexts),
    ...normalizeContextList(content.activeContexts),
    ...normalizeContextList(content.selectedContexts),
    ...normalizeContextList(content.contexts),
  ];
  return contexts.some((context) =>
    ALARM_CONTEXTS.includes(context as (typeof ALARM_CONTEXTS)[number]),
  );
}

function hasAlarmSignal(message: Memory, state?: State): boolean {
  if (hasAlarmContext(message, state)) return true;
  const text = getText(message);
  return ALARM_TERMS.some((term) => text.includes(term.toLowerCase()));
}

function readParameters(
  options: HandlerOptions | undefined,
): Record<string, unknown> {
  const params = (
    options as { parameters?: Record<string, unknown> } | undefined
  )?.parameters;
  return params && typeof params === "object" ? params : {};
}

function normalizeSubactionValue(value: unknown): AlarmSubaction | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const aliases: Record<string, AlarmSubaction> = {
    schedule: "set",
    create: "set",
    add: "set",
    remove: "cancel",
    delete: "cancel",
    show: "list",
    pending: "list",
  };
  if (aliases[normalized]) return aliases[normalized];
  return (ALARM_SUBACTIONS as readonly string[]).includes(normalized)
    ? (normalized as AlarmSubaction)
    : null;
}

function inferSubactionFromText(text: string): AlarmSubaction | null {
  const lower = text.toLowerCase();
  if (
    /\b(list|show|pending|view|see|what)\b.*\balarm/.test(lower) ||
    /\balarms?\s*(?:list|pending)\b/.test(lower)
  ) {
    return "list";
  }
  if (
    /\b(cancel|stop|remove|delete|kill|clear)\b.*\balarm/.test(lower) ||
    /\balarm\b.*\b(cancel|stop|remove|delete|kill|clear)\b/.test(lower)
  ) {
    return "cancel";
  }
  if (
    /\b(set|schedule|create|add|new|wake)\b.*\balarm/.test(lower) ||
    /\balarm\b.*\b(set|schedule|create|add|for)\b/.test(lower) ||
    /\bwake me\b/.test(lower)
  ) {
    return "set";
  }
  if (lower.includes("alarm")) {
    // Default to list when alarm mentioned without a clear verb.
    return "list";
  }
  return null;
}

function parseSchedule(
  params: Record<string, unknown>,
): ScheduleAlarmParams | null {
  const timeIso = typeof params.timeIso === "string" ? params.timeIso : null;
  const title = typeof params.title === "string" ? params.title : null;
  if (!timeIso || !title) return null;
  const body = typeof params.body === "string" ? params.body : undefined;
  const id = typeof params.id === "string" ? params.id : undefined;
  const sound = typeof params.sound === "string" ? params.sound : undefined;
  return { timeIso, title, body, id, sound };
}

function parseCancel(
  params: Record<string, unknown>,
): CancelAlarmParams | null {
  const id =
    typeof params.id === "string"
      ? params.id
      : typeof params.alarmId === "string"
        ? params.alarmId
        : null;
  if (!id) return null;
  return { id };
}

async function runSet(
  message: Memory,
  params: Record<string, unknown>,
  deps: MacosAlarmActionDeps,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  const parsed = parseSchedule(params);
  if (!parsed) {
    const err = "ALARM set requires timeIso and title parameters.";
    logger.warn(`[ALARM/set] ${err}`);
    if (callback) {
      await callback({ text: err, source: message.content.source });
    }
    return {
      success: false,
      error: err,
      data: { actionName: "ALARM", subaction: "set" },
    };
  }

  const id = parsed.id ?? `alarm-${randomUUID()}`;

  try {
    const response = await runHelper(
      {
        action: "schedule",
        id,
        timeIso: parsed.timeIso,
        title: parsed.title,
        body: parsed.body,
        sound: parsed.sound,
      },
      deps.helperOptions,
    );

    if (!response.success) {
      logger.error(`[ALARM/set] helper returned error: ${response.error}`);
      if (callback) {
        await callback({
          text: `Could not set alarm: ${response.error}`,
          source: message.content.source,
        });
      }
      return {
        success: false,
        error: response.error,
        data: { actionName: "ALARM", subaction: "set" },
      };
    }

    const scheduled = response as MacosAlarmHelperScheduleResponse;
    logger.info(
      `[ALARM/set] scheduled id=${scheduled.id} fireAt=${scheduled.fireAt}`,
    );
    if (callback) {
      await callback({
        text: `Alarm set for ${scheduled.fireAt}: "${parsed.title}".`,
        source: message.content.source,
      });
    }
    return {
      success: true,
      data: {
        actionName: "ALARM",
        subaction: "set",
        id: scheduled.id,
        fireAt: scheduled.fireAt,
      },
    };
  } catch (err) {
    if (err instanceof MacosAlarmHelperUnavailableError) {
      logger.warn(`[ALARM/set] helper unavailable: ${err.reason}`);
      if (callback) {
        await callback({
          text: "The macOS alarm helper is not installed on this machine.",
          source: message.content.source,
        });
      }
      return {
        success: false,
        error: err.reason,
        data: { actionName: "ALARM", subaction: "set" },
      };
    }
    const failureMessage =
      err instanceof Error ? err.message : "Unknown macOS alarm failure.";
    logger.error(`[ALARM/set] helper failed: ${failureMessage}`);
    return {
      success: false,
      text: `Could not set alarm: ${failureMessage}`,
      error: failureMessage,
      data: { actionName: "ALARM", subaction: "set" },
    };
  }
}

async function runCancel(
  message: Memory,
  params: Record<string, unknown>,
  deps: MacosAlarmActionDeps,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  const parsed = parseCancel(params);
  if (!parsed) {
    const err = "ALARM cancel requires an id parameter.";
    logger.warn(`[ALARM/cancel] ${err}`);
    return {
      success: false,
      error: err,
      data: { actionName: "ALARM", subaction: "cancel" },
    };
  }

  try {
    const response = await runHelper(
      { action: "cancel", id: parsed.id },
      deps.helperOptions,
    );
    if (!response.success) {
      return {
        success: false,
        error: response.error,
        data: { actionName: "ALARM", subaction: "cancel" },
      };
    }
    const cancelled = response as MacosAlarmHelperCancelResponse;
    logger.info(`[ALARM/cancel] cancelled id=${cancelled.id}`);
    if (callback) {
      await callback({
        text: `Alarm ${cancelled.id} cancelled.`,
        source: message.content.source,
      });
    }
    return {
      success: true,
      data: { actionName: "ALARM", subaction: "cancel", id: cancelled.id },
    };
  } catch (err) {
    if (err instanceof MacosAlarmHelperUnavailableError) {
      logger.warn(`[ALARM/cancel] helper unavailable: ${err.reason}`);
      return {
        success: false,
        error: err.reason,
        data: { actionName: "ALARM", subaction: "cancel" },
      };
    }
    const failureMessage =
      err instanceof Error ? err.message : "Unknown macOS alarm failure.";
    logger.error(`[ALARM/cancel] helper failed: ${failureMessage}`);
    return {
      success: false,
      text: `Could not cancel alarm: ${failureMessage}`,
      error: failureMessage,
      data: { actionName: "ALARM", subaction: "cancel" },
    };
  }
}

async function runList(
  message: Memory,
  deps: MacosAlarmActionDeps,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  try {
    const response = await runHelper({ action: "list" }, deps.helperOptions);
    if (!response.success) {
      return {
        success: false,
        error: response.error,
        data: { actionName: "ALARM", subaction: "list" },
      };
    }
    const list = response as MacosAlarmHelperListResponse;
    logger.info(`[ALARM/list] pending count=${list.alarms.length}`);
    if (callback) {
      const summary =
        list.alarms.length === 0
          ? "No macOS alarms are pending."
          : `Pending macOS alarms: ${list.alarms
              .map((a) => `${a.id} @ ${a.fireAt ?? "unknown"}`)
              .join(", ")}`;
      await callback({ text: summary, source: message.content.source });
    }
    return {
      success: true,
      data: {
        actionName: "ALARM",
        subaction: "list",
        alarms: list.alarms,
      },
    };
  } catch (err) {
    if (err instanceof MacosAlarmHelperUnavailableError) {
      logger.warn(`[ALARM/list] helper unavailable: ${err.reason}`);
      return {
        success: false,
        error: err.reason,
        data: { actionName: "ALARM", subaction: "list" },
      };
    }
    const failureMessage =
      err instanceof Error ? err.message : "Unknown macOS alarm failure.";
    logger.error(`[ALARM/list] helper failed: ${failureMessage}`);
    return {
      success: false,
      text: `Could not list alarms: ${failureMessage}`,
      error: failureMessage,
      data: { actionName: "ALARM", subaction: "list" },
    };
  }
}

export function createAlarmAction(deps: MacosAlarmActionDeps = {}): Action {
  return {
    name: "ALARM",
    description:
      "Manage native macOS alarms via UNUserNotificationCenter. Subactions: set (schedule a new alarm), cancel (remove a scheduled alarm by id), list (show pending alarms). Subaction inferred from message text when not explicitly provided.",
    descriptionCompressed:
      "macOS alarm: set / cancel / list (UNUserNotificationCenter).",
    contexts: [...ALARM_CONTEXTS],
    contextGate: { anyOf: [...ALARM_CONTEXTS] },
    roleGate: { minRole: "ADMIN" },
    similes: [
      "SET_ALARM_MACOS",
      "CANCEL_ALARM_MACOS",
      "LIST_ALARMS_MACOS",
      "schedule macos alarm",
      "create mac alarm",
      "set a mac alarm",
      "wake me up on mac",
      "cancel macos alarm",
      "remove mac alarm",
      "list macos alarms",
      "show pending alarms",
    ],
    parameters: [
      {
        name: "subaction",
        description:
          "Operation to perform: set, cancel, or list. Inferred from message text when omitted.",
        required: false,
        schema: { type: "string", enum: [...ALARM_SUBACTIONS] },
      },
      {
        name: "timeIso",
        description:
          "For subaction=set: ISO-8601 timestamp when the alarm should fire.",
        required: false,
        schema: { type: "string" },
      },
      {
        name: "title",
        description:
          "For subaction=set: short title displayed in the notification.",
        required: false,
        schema: { type: "string" },
      },
      {
        name: "body",
        description:
          "For subaction=set: optional longer body text for the notification.",
        required: false,
        schema: { type: "string" },
      },
      {
        name: "sound",
        description: "For subaction=set: optional notification sound name.",
        required: false,
        schema: { type: "string" },
      },
      {
        name: "id",
        description:
          "For subaction=set: optional explicit alarm id; for subaction=cancel: required alarm id returned from a previous set operation.",
        required: false,
        schema: { type: "string" },
      },
    ],
    validate: async (
      _runtime: IAgentRuntime,
      message: Memory,
      state?: State,
    ): Promise<boolean> => {
      if (!isDarwin()) return false;
      return hasAlarmSignal(message, state);
    },
    handler: async (
      _runtime: IAgentRuntime,
      message: Memory,
      _state?: State,
      options?: HandlerOptions,
      callback?: HandlerCallback,
    ): Promise<ActionResult> => {
      if (!isDarwin()) {
        logger.info(
          "[ALARM] skipping on non-darwin platform; returning macos-only",
        );
        if (callback) {
          await callback({
            text: "I can only set native alarms on macOS.",
            source: message.content.source,
          });
        }
        return NOT_SUPPORTED;
      }

      const params = readParameters(options);
      const explicit =
        normalizeSubactionValue(params.subaction) ??
        normalizeSubactionValue(params.op);
      const subaction = explicit ?? inferSubactionFromText(getText(message));

      if (!subaction) {
        const text = `ALARM could not determine the subaction. Specify one of: ${ALARM_SUBACTIONS.join(", ")}.`;
        if (callback) {
          await callback({ text, source: message.content.source });
        }
        return {
          success: false,
          text,
          values: { error: "MISSING_SUBACTION" },
          data: {
            actionName: "ALARM",
            availableSubactions: [...ALARM_SUBACTIONS],
          },
        };
      }

      switch (subaction) {
        case "set":
          return runSet(message, params, deps, callback);
        case "cancel":
          return runCancel(message, params, deps, callback);
        case "list":
          return runList(message, deps, callback);
      }
    },
    examples: [
      [
        { name: "{{user}}", content: { text: "set an alarm for 7am tomorrow" } },
        {
          name: "{{agent}}",
          content: {
            actions: ["ALARM"],
            text: "Alarm set for 2026-05-08T07:00:00-07:00: \"Wake up\".",
          },
        },
      ],
      [
        { name: "{{user}}", content: { text: "cancel alarm alarm-1234" } },
        {
          name: "{{agent}}",
          content: {
            actions: ["ALARM"],
            text: "Alarm alarm-1234 cancelled.",
          },
        },
      ],
      [
        { name: "{{user}}", content: { text: "list pending alarms" } },
        {
          name: "{{agent}}",
          content: {
            actions: ["ALARM"],
            text: "Pending macOS alarms: alarm-1234 @ 2026-05-08T07:00:00-07:00",
          },
        },
      ],
    ],
  };
}

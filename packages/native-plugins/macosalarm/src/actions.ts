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
  MacosAlarmHelperUnavailableError,
  type HelperRunOptions,
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

const NOT_SUPPORTED: ActionResult = {
  success: false,
  error: "macos-only",
};

function isDarwin(): boolean {
  return process.platform === "darwin";
}

function getText(message: Memory): string {
  return (message.content.text ?? "").toLowerCase();
}

function parseSchedule(options: HandlerOptions | undefined): ScheduleAlarmParams | null {
  const params = (options as { parameters?: Record<string, unknown> } | undefined)?.parameters;
  if (!params) return null;
  const timeIso = typeof params.timeIso === "string" ? params.timeIso : null;
  const title = typeof params.title === "string" ? params.title : null;
  if (!timeIso || !title) return null;
  const body = typeof params.body === "string" ? params.body : undefined;
  const id = typeof params.id === "string" ? params.id : undefined;
  const sound = typeof params.sound === "string" ? params.sound : undefined;
  return { timeIso, title, body, id, sound };
}

function parseCancel(options: HandlerOptions | undefined): CancelAlarmParams | null {
  const params = (options as { parameters?: Record<string, unknown> } | undefined)?.parameters;
  if (!params) return null;
  const id = typeof params.id === "string" ? params.id : null;
  if (!id) return null;
  return { id };
}

export function createSetAlarmAction(deps: MacosAlarmActionDeps = {}): Action {
  return {
    name: "SET_ALARM_MACOS",
    description:
      "Schedule a native macOS alarm via UNUserNotificationCenter. Use for user-requested alarms, wake-ups, and meeting reminders on a Mac.",
    similes: [
      "schedule macos alarm",
      "create mac alarm",
      "set a mac alarm",
      "wake me up on mac",
    ],
    parameters: [
      {
        name: "timeIso",
        description: "ISO-8601 timestamp when the alarm should fire.",
        required: true,
        schema: { type: "string" },
      },
      {
        name: "title",
        description: "Short title displayed in the notification.",
        required: true,
        schema: { type: "string" },
      },
      {
        name: "body",
        description: "Optional longer body text for the notification.",
        required: false,
        schema: { type: "string" },
      },
    ],
    validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
      if (!isDarwin()) return false;
      const text = getText(message);
      return text.includes("alarm") || text.includes("wake");
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
          "[SetAlarmMacos] skipping on non-darwin platform; returning macos-only",
        );
        if (callback) {
          await callback({
            text: "I can only set native alarms on macOS.",
            source: message.content.source,
          });
        }
        return NOT_SUPPORTED;
      }

      const parsed = parseSchedule(options);
      if (!parsed) {
        const err = "SET_ALARM_MACOS requires timeIso and title parameters.";
        logger.warn(`[SetAlarmMacos] ${err}`);
        if (callback) {
          await callback({ text: err, source: message.content.source });
        }
        return { success: false, error: err };
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
          logger.error(
            `[SetAlarmMacos] helper returned error: ${response.error}`,
          );
          if (callback) {
            await callback({
              text: `Could not set alarm: ${response.error}`,
              source: message.content.source,
            });
          }
          return { success: false, error: response.error };
        }

        const scheduled = response as MacosAlarmHelperScheduleResponse;
        logger.info(
          `[SetAlarmMacos] scheduled id=${scheduled.id} fireAt=${scheduled.fireAt}`,
        );
        if (callback) {
          await callback({
            text: `Alarm set for ${scheduled.fireAt}: "${parsed.title}".`,
            source: message.content.source,
          });
        }
        return {
          success: true,
          data: { id: scheduled.id, fireAt: scheduled.fireAt },
        };
      } catch (err) {
        if (err instanceof MacosAlarmHelperUnavailableError) {
          logger.warn(`[SetAlarmMacos] helper unavailable: ${err.reason}`);
          if (callback) {
            await callback({
              text: "The macOS alarm helper is not installed on this machine.",
              source: message.content.source,
            });
          }
          return { success: false, error: err.reason };
        }
        throw err;
      }
    },
    examples: [],
  };
}

export function createCancelAlarmAction(deps: MacosAlarmActionDeps = {}): Action {
  return {
    name: "CANCEL_ALARM_MACOS",
    description: "Cancel a previously scheduled macOS alarm by its id.",
    similes: ["cancel macos alarm", "remove mac alarm"],
    parameters: [
      {
        name: "id",
        description: "The alarm identifier returned from SET_ALARM_MACOS.",
        required: true,
        schema: { type: "string" },
      },
    ],
    validate: async (): Promise<boolean> => isDarwin(),
    handler: async (
      _runtime: IAgentRuntime,
      message: Memory,
      _state?: State,
      options?: HandlerOptions,
      callback?: HandlerCallback,
    ): Promise<ActionResult> => {
      if (!isDarwin()) return NOT_SUPPORTED;

      const parsed = parseCancel(options);
      if (!parsed) {
        const err = "CANCEL_ALARM_MACOS requires an id parameter.";
        logger.warn(`[CancelAlarmMacos] ${err}`);
        return { success: false, error: err };
      }

      try {
        const response = await runHelper(
          { action: "cancel", id: parsed.id },
          deps.helperOptions,
        );
        if (!response.success) {
          return { success: false, error: response.error };
        }
        const cancelled = response as MacosAlarmHelperCancelResponse;
        logger.info(`[CancelAlarmMacos] cancelled id=${cancelled.id}`);
        if (callback) {
          await callback({
            text: `Alarm ${cancelled.id} cancelled.`,
            source: message.content.source,
          });
        }
        return { success: true, data: { id: cancelled.id } };
      } catch (err) {
        if (err instanceof MacosAlarmHelperUnavailableError) {
          logger.warn(`[CancelAlarmMacos] helper unavailable: ${err.reason}`);
          return { success: false, error: err.reason };
        }
        throw err;
      }
    },
    examples: [],
  };
}

export function createListAlarmsAction(deps: MacosAlarmActionDeps = {}): Action {
  return {
    name: "LIST_ALARMS_MACOS",
    description: "List pending macOS alarms scheduled via SET_ALARM_MACOS.",
    similes: ["list macos alarms", "show pending alarms"],
    validate: async (): Promise<boolean> => isDarwin(),
    handler: async (
      _runtime: IAgentRuntime,
      message: Memory,
      _state?: State,
      _options?: HandlerOptions,
      callback?: HandlerCallback,
    ): Promise<ActionResult> => {
      if (!isDarwin()) return NOT_SUPPORTED;

      try {
        const response = await runHelper(
          { action: "list" },
          deps.helperOptions,
        );
        if (!response.success) {
          return { success: false, error: response.error };
        }
        const list = response as MacosAlarmHelperListResponse;
        logger.info(`[ListAlarmsMacos] pending count=${list.alarms.length}`);
        if (callback) {
          const summary =
            list.alarms.length === 0
              ? "No macOS alarms are pending."
              : `Pending macOS alarms: ${list.alarms
                  .map((a) => `${a.id} @ ${a.fireAt ?? "unknown"}`)
                  .join(", ")}`;
          await callback({ text: summary, source: message.content.source });
        }
        return { success: true, data: { alarms: list.alarms } };
      } catch (err) {
        if (err instanceof MacosAlarmHelperUnavailableError) {
          logger.warn(`[ListAlarmsMacos] helper unavailable: ${err.reason}`);
          return { success: false, error: err.reason };
        }
        throw err;
      }
    },
    examples: [],
  };
}

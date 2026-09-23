/**
 * Planner actions for the companion device: SET_COMPANION_MOOD forwards a mood
 * to the device and waits for the correlated confirmation;
 * GET_COMPANION_STATUS reads the live device status. Both fail closed with the
 * service's typed error text when the device is disconnected or rejects the
 * command — a failure is never rendered as a healthy result. The device
 * firmware is the authority on valid moods; the action passes the requested
 * mood through and surfaces the device's rejection verbatim.
 */
import {
  type Action,
  type ActionResult,
  ElizaError,
  type IAgentRuntime,
} from "@elizaos/core";
import { CompanionService } from "./service";

function companionService(runtime: IAgentRuntime): CompanionService | null {
  return runtime.getService<CompanionService>(CompanionService.serviceType);
}

function failureText(error: unknown): string {
  if (error instanceof ElizaError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Extracts the requested mood from the runtime's validated `parameters`
 * envelope. The last quoted or trailing word of the message text is NOT
 * guessed — a missing parameter is an explicit failure, not a default mood.
 */
function requestedMood(options?: Record<string, unknown>): string | undefined {
  const parameters = options?.parameters;
  const mood =
    parameters !== null &&
    typeof parameters === "object" &&
    !Array.isArray(parameters)
      ? (parameters as Record<string, unknown>).mood
      : undefined;
  return typeof mood === "string" && mood.trim().length > 0
    ? mood.trim()
    : undefined;
}

export const setCompanionMoodAction: Action = {
  name: "SET_COMPANION_MOOD",
  description:
    "Set the companion device's displayed mood. Requires the `mood` parameter; the device confirms or rejects the mood.",
  descriptionCompressed: "Set the companion device mood.",
  tags: ["capability:send"],
  parameters: [
    {
      name: "mood",
      description:
        "Mood identifier accepted by the companion firmware, such as happy, sleepy, or curious.",
      descriptionCompressed: "Firmware mood identifier.",
      required: true,
      schema: { type: "string", minLength: 1, pattern: "\\S" },
      examples: ["happy", "sleepy", "curious"],
    },
  ],
  validate: async (runtime) => companionService(runtime) !== null,
  handler: async (
    runtime,
    _message,
    _state,
    options,
  ): Promise<ActionResult> => {
    const service = companionService(runtime);
    if (!service) {
      return {
        success: false,
        text: "COMPANION_NOT_CONNECTED: companion service is not running",
      };
    }
    const mood = requestedMood(options as Record<string, unknown> | undefined);
    if (!mood) {
      return {
        success: false,
        text: "SET_COMPANION_MOOD requires a `mood` parameter (e.g. happy, sleepy).",
      };
    }
    try {
      const confirmed = await service.setMood(mood);
      return {
        success: true,
        text: `Companion mood set to ${confirmed}.`,
        userFacingText: `Companion mood set to ${confirmed}.`,
        data: { mood: confirmed },
      };
    } catch (error) {
      // error-policy:J1 action boundary: typed service failure becomes a
      // structured failed ActionResult for the planner.
      return { success: false, text: failureText(error) };
    }
  },
};

export const getCompanionStatusAction: Action = {
  name: "GET_COMPANION_STATUS",
  description:
    "Read the companion device status: deviceId, mood, connection state, firmware, and capabilities. Fails when the device is disconnected.",
  descriptionCompressed: "Read companion device status.",
  validate: async (runtime) => companionService(runtime) !== null,
  handler: async (runtime): Promise<ActionResult> => {
    const service = companionService(runtime);
    if (!service) {
      return {
        success: false,
        text: "COMPANION_NOT_CONNECTED: companion service is not running",
      };
    }
    try {
      const status = await service.getStatus();
      return {
        success: true,
        text: `Companion ${status.deviceId} connected (mood: ${status.mood ?? "unknown"}, firmware: ${status.firmware ?? "unknown"}).`,
        data: JSON.parse(JSON.stringify(status)),
      };
    } catch (error) {
      // error-policy:J1 action boundary: a disconnected or rejecting device is
      // a structured failure, never an empty-healthy status.
      return { success: false, text: failureText(error) };
    }
  },
};

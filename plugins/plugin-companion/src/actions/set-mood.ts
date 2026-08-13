/**
 * SET_COMPANION_MOOD — drive the ESP32 face mood over the companion bridge.
 */

import type {
  Action,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { CompanionClientError } from "../companion-client";
import type { CompanionService } from "../companion-service";
import { COMPANION_MOODS, COMPANION_SERVICE_TYPE, normalizeMood } from "../protocol";

function getService(runtime: IAgentRuntime): CompanionService | null {
  return runtime.getService<CompanionService>(COMPANION_SERVICE_TYPE) ?? null;
}

export const setCompanionMoodAction: Action = {
  name: "SET_COMPANION_MOOD",
  description:
    "Set the ESP32 companion face mood (idle, listening, thinking, happy). Use when the user asks the device to look, listen, think, or smile.",
  descriptionCompressed: "Set companion device mood.",
  routingHint:
    "look/listen/think/smile on the ESP32 companion -> SET_COMPANION_MOOD; device status -> GET_COMPANION_STATUS",
  similes: ["COMPANION_SET_MOOD", "SET_DEVICE_MOOD"],
  parameters: [
    {
      name: "mood",
      description: "Target mood: idle, listening, thinking, or happy (ready aliases to happy).",
      required: true,
      schema: { type: "string", enum: [...COMPANION_MOODS, "ready"] },
    },
  ],
  validate: async (runtime) => runtime.getService(COMPANION_SERVICE_TYPE) != null,
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: HandlerOptions
  ): Promise<ActionResult> => {
    const service = getService(runtime);
    if (!service) {
      return {
        success: false,
        text: "Companion service is not registered.",
        error: "not-connected",
      };
    }
    const raw = String(options?.parameters?.mood ?? "");
    if (!normalizeMood(raw)) {
      return {
        success: false,
        text: `Invalid mood "${raw}". Use idle, listening, thinking, or happy.`,
        error: "invalid-mood",
      };
    }
    try {
      const mood = await service.setMood(raw);
      return {
        success: true,
        text: `Companion mood set to ${mood}.`,
        userFacingText: `Companion mood set to ${mood}.`,
        data: { mood },
      };
    } catch (error) {
      const err = error instanceof CompanionClientError ? error : null;
      return {
        success: false,
        text: err?.message ?? (error instanceof Error ? error.message : String(error)),
        error: err?.code ?? "command-failed",
      };
    }
  },
};

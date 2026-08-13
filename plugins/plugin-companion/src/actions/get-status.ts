/**
 * GET_COMPANION_STATUS — read connected ESP32 companion identity and mood.
 */

import type { Action, ActionResult, IAgentRuntime, Memory, State } from "@elizaos/core";
import { CompanionClientError } from "../companion-client";
import type { CompanionService } from "../companion-service";
import { COMPANION_SERVICE_TYPE } from "../protocol";

export const getCompanionStatusAction: Action = {
  name: "GET_COMPANION_STATUS",
  description:
    "Read the ESP32 companion connection, deviceId, firmware, capabilities, and current mood. Fails if the device is disconnected.",
  descriptionCompressed: "Read companion device status.",
  routingHint:
    "companion/device status or is it connected -> GET_COMPANION_STATUS; change face -> SET_COMPANION_MOOD",
  similes: ["COMPANION_STATUS", "GET_DEVICE_STATUS"],
  validate: async (runtime) => runtime.getService(COMPANION_SERVICE_TYPE) != null,
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State
  ): Promise<ActionResult> => {
    const service = runtime.getService<CompanionService>(COMPANION_SERVICE_TYPE);
    if (!service) {
      return {
        success: false,
        text: "Companion service is not registered.",
        error: "not-connected",
      };
    }
    try {
      const status = await service.getStatus();
      return {
        success: true,
        text: `Companion ${status.deviceId} mood=${status.mood ?? "unknown"} firmware=${status.firmware ?? "unknown"}`,
        userFacingText: `Companion ${status.deviceId} is ${status.mood ?? "unknown"}.`,
        data: { ...status },
      };
    } catch (error) {
      const err = error instanceof CompanionClientError ? error : null;
      return {
        success: false,
        text: err?.message ?? (error instanceof Error ? error.message : String(error)),
        error: err?.code ?? "not-connected",
      };
    }
  },
};

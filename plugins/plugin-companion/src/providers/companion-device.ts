/**
 * companionDevice provider — read-only connection, mood, and last device event.
 */

import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";
import type { CompanionService } from "../companion-service";
import { COMPANION_SERVICE_TYPE } from "../protocol";

export const companionDeviceProvider: Provider = {
  name: "companionDevice",
  description:
    "ESP32 companion connection snapshot: connected, deviceId, mood, firmware, lastEvent (touch/mood_changed).",
  descriptionCompressed: "Companion device: connected, mood, lastEvent.",
  dynamic: true,
  contexts: ["system"],
  contextGate: { anyOf: ["system"] },
  cacheStable: false,
  cacheScope: "turn",

  get: async (runtime: IAgentRuntime, _message: Memory, _state: State): Promise<ProviderResult> => {
    const service = runtime.getService<CompanionService>(COMPANION_SERVICE_TYPE);
    if (!service) {
      return {
        text: JSON.stringify({ companion: { connected: false } }),
        values: { companionConnected: false },
        data: { connected: false },
      };
    }
    const snapshot = service.getSnapshot();
    return {
      text: JSON.stringify({
        companion: {
          connected: snapshot.connected,
          deviceId: snapshot.deviceId,
          mood: snapshot.mood,
          firmware: snapshot.firmware,
          lastEvent: snapshot.lastEvent?.name ?? null,
        },
      }),
      values: {
        companionConnected: snapshot.connected,
        companionDeviceId: snapshot.deviceId,
        companionMood: snapshot.mood,
        companionLastEvent: snapshot.lastEvent?.name ?? null,
      },
      data: { ...snapshot },
    };
  },
};

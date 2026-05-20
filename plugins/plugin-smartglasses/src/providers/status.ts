import type { Provider } from "@elizaos/core";
import { getSmartglassesService } from "../services/smartglasses-service.js";

export const smartglassesStatusProvider: Provider = {
  name: "smartglassesStatus",
  description:
    "Current Even Realities smartglasses connection, microphone, event, and audio status.",
  get: async (runtime) => {
    const service = getSmartglassesService(runtime);
    if (!service) {
      return {
        text: "Smartglasses service not loaded.",
        values: { available: false },
      };
    }
    const status = service.getStatus();
    return {
      text:
        `Smartglasses: connected=${status.connected}, ` +
        `transport=${status.transport ?? "none"}, ` +
        `microphone=${status.microphoneEnabled ? "enabled" : "disabled"}, ` +
        `heartbeat=${status.heartbeatRunning ? "running" : "stopped"}, ` +
        `lastEvent=${status.lastEvent?.label ?? "none"}, ` +
        `physical=${status.physicalState ?? "none"}, ` +
        `battery=${status.batteryState ?? "none"}, ` +
        `device=${status.deviceState ?? "none"}, ` +
        `serial=${status.lastSerialNumber ?? "none"}, ` +
        `wifi=${status.wifiAvailable ? "available" : "unavailable"}, ` +
        `wifiStatus=${status.lastWifiStatus?.status ?? "none"}, ` +
        `transcript=${status.lastTranscript ?? "none"}, ` +
        `audioChunks=${status.audioChunksReceived}, ` +
        `audioEncoding=${status.lastAudioEncoding ?? "none"}, ` +
        `audioSequence=${status.lastAudioSequence ?? "none"}, ` +
        `audioSequenceGaps=${status.audioSequenceGaps}`,
      values: { ...status },
    };
  },
};

/**
 * Smartglasses status provider injects Even Realities connection, lens,
 * microphone, event, and audio state into the agent prompt.
 */
import type { Provider } from "@elizaos/core";
import { getSmartglassesService } from "../services/smartglasses-service.ts";
import {
  formatConnectedLensesForProvider,
  setupSummaryForStatus,
} from "../status-format.ts";

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
    const setup = setupSummaryForStatus(status);
    return {
      text:
        `Smartglasses: connected=${status.connected}, ` +
        `transport=${status.transport ?? "none"}, ` +
        `lenses=${formatConnectedLensesForProvider(status.connectedLenses)}, ` +
        `microphone=${status.microphoneEnabled ? "enabled" : "disabled"}, ` +
        `heartbeat=${status.heartbeatRunning ? "running" : "stopped"}, ` +
        `lastEvent=${status.lastEvent?.label ?? "none"}, ` +
        `physical=${status.physicalState ?? "none"}, ` +
        `battery=${status.batteryState ?? "none"}, ` +
        `batteryLevels=${formatBatteryLevels(status.batteryLevels)}, ` +
        `device=${status.deviceState ?? "none"}, ` +
        `setup=${setup.setupHint ?? "none"}, ` +
        `wholeHeadset=${setup.wholeHeadsetConnected}, ` +
        `wearingReady=${setup.wearingReady}, ` +
        `physicalBlocker=${setup.physicalBlocker ?? "none"}, ` +
        `serial=${status.lastSerialNumber ?? "none"}, ` +
        `wifi=${status.wifiAvailable ? "available" : "unavailable"}, ` +
        `wifiStatus=${status.lastWifiStatus?.status ?? "none"}, ` +
        `transcript=${status.lastTranscript ?? "none"}, ` +
        `audioChunks=${status.audioChunksReceived}, ` +
        `audioEncoding=${status.lastAudioEncoding ?? "none"}, ` +
        `audioSequence=${status.lastAudioSequence ?? "none"}, ` +
        `audioSequenceGaps=${status.audioSequenceGaps}`,
      values: { ...status, setup },
    };
  },
};

function formatBatteryLevels(
  levels: Partial<Record<"left" | "right", number>>,
): string {
  const left = levels.left === undefined ? "unknown" : `${levels.left}%`;
  const right = levels.right === undefined ? "unknown" : `${levels.right}%`;
  return `left:${left} right:${right}`;
}

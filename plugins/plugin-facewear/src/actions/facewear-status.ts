/**
 * Smartglasses status action formats Even Realities connection, lens,
 * microphone, Wi-Fi, and audio state for chat responses.
 */
import type { Action, ActionResult, IAgentRuntime } from "@elizaos/core";
import { getSmartglassesService } from "../services/smartglasses-service.ts";
import {
  formatConnectedLensesForAction,
  setupSummaryForStatus,
} from "../status-format.ts";

export const smartglassesStatusAction: Action = {
  name: "SMARTGLASSES_STATUS",
  similes: ["EVEN_GLASSES_STATUS", "GLASSES_STATUS"],
  description:
    "Report smartglasses connection, transport, microphone, Wi-Fi bridge capability/status, latest event, and audio streaming status.",
  descriptionCompressed:
    "smartglasses-status: connection, mic, Wi-Fi, last event, audio chunks",
  contexts: ["smartglasses", "debug", "operations"],
  validate: async () => true,
  handler: async (runtime: IAgentRuntime): Promise<ActionResult> => {
    const service = getSmartglassesService(runtime);
    if (!service) {
      return {
        success: false,
        text: "Smartglasses service not loaded",
        values: { available: false },
      };
    }
    const status = service.getStatus();
    const setup = setupSummaryForStatus(status);
    const lines = [
      `available: ${status.available}`,
      `connected: ${status.connected}`,
      `transport: ${status.transport ?? "(none)"}`,
      `connectedLenses: ${formatConnectedLensesForAction(
        status.connectedLenses,
      )}`,
      `microphoneEnabled: ${status.microphoneEnabled}`,
      `heartbeatRunning: ${status.heartbeatRunning}`,
      `heartbeatIntervalMs: ${status.heartbeatIntervalMs ?? "(none)"}`,
      `lastHeartbeatAt: ${status.lastHeartbeatAt ?? "(none)"}`,
      `audioChunksReceived: ${status.audioChunksReceived}`,
      `lastAudioEncoding: ${status.lastAudioEncoding ?? "(none)"}`,
      `lastAudioSequence: ${status.lastAudioSequence ?? "(none)"}`,
      `audioSequenceGaps: ${status.audioSequenceGaps}`,
      `lastTranscript: ${status.lastTranscript ?? "(none)"}`,
      `physicalState: ${status.physicalState ?? "(none)"}`,
      `batteryState: ${status.batteryState ?? "(none)"}`,
      `deviceState: ${status.deviceState ?? "(none)"}`,
      `setupHint: ${setup.setupHint ?? "(none)"}`,
      `wholeHeadsetConnected: ${setup.wholeHeadsetConnected}`,
      `wearingReady: ${setup.wearingReady}`,
      `physicalBlocker: ${setup.physicalBlocker ?? "(none)"}`,
      `lastSerialNumber: ${status.lastSerialNumber ?? "(none)"}`,
      `wifiAvailable: ${status.wifiAvailable}`,
      `lastWifiStatus: ${status.lastWifiStatus?.status ?? "(none)"}`,
      `lastWifiNetworks: ${
        status.lastWifiStatus?.networks.join(", ") || "(none)"
      }`,
      `lastEvent: ${status.lastEvent?.label ?? "(none)"}`,
    ];
    return {
      success: true,
      text: lines.join("\n"),
      values: { ...status, setup },
    };
  },
  examples: [],
};

// Alias for facewear plugin consumers
export const facewearStatusAction = smartglassesStatusAction;

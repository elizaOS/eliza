import type { Action, ActionResult, IAgentRuntime } from "@elizaos/core";
import { getSmartglassesService } from "../services/smartglasses-service.js";

export const smartglassesStatusAction: Action = {
  name: "SMARTGLASSES_STATUS",
  similes: ["EVEN_GLASSES_STATUS", "GLASSES_STATUS"],
  description:
    "Report smartglasses connection, transport, microphone, latest event, and audio streaming status.",
  descriptionCompressed:
    "smartglasses-status: connection, mic, last event, audio chunks",
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
    const lines = [
      `available: ${status.available}`,
      `connected: ${status.connected}`,
      `transport: ${status.transport ?? "(none)"}`,
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
      `lastSerialNumber: ${status.lastSerialNumber ?? "(none)"}`,
      `lastEvent: ${status.lastEvent?.label ?? "(none)"}`,
    ];
    return { success: true, text: lines.join("\n"), values: { ...status } };
  },
  examples: [],
};

/**
 * Context provider surfacing the companion device's live state — connection,
 * identity, current mood, and the last spontaneous device event (touch /
 * mood_changed) — so the agent can react to physical interaction. Read-only:
 * it snapshots service state and never touches the socket.
 */
import type { IAgentRuntime, Provider, ProviderResult } from "@elizaos/core";
import { CompanionService } from "./service";

export const companionDeviceProvider: Provider = {
  name: "companionDevice",
  description:
    "Live companion-device state: connection, mood, and last touch event.",
  descriptionCompressed: "Companion device state.",
  dynamic: true,
  get: async (runtime: IAgentRuntime): Promise<ProviderResult> => {
    const service = runtime.getService<CompanionService>(
      CompanionService.serviceType,
    );
    if (!service) {
      return { text: "Companion device: service not running." };
    }
    const snapshot = service.snapshot();
    if (!snapshot.connected) {
      return {
        text: "Companion device: disconnected.",
        values: { companionConnected: false },
      };
    }
    const lastEvent = snapshot.lastEvent
      ? `; lastEvent=${snapshot.lastEvent.event} at ${new Date(snapshot.lastEvent.at).toISOString()}`
      : "";
    return {
      text: `Companion device ${snapshot.deviceId} connected (mood: ${snapshot.mood ?? "unknown"})${lastEvent}.`,
      values: {
        companionConnected: true,
        companionDeviceId: snapshot.deviceId ?? "",
        companionMood: snapshot.mood ?? "",
        companionLastEvent: snapshot.lastEvent?.event ?? "",
      },
    };
  },
};

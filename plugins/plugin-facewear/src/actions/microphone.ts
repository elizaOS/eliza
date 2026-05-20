import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  parseJSONObjectFromText,
  type State,
} from "@elizaos/core";
import { getSmartglassesService } from "../services/smartglasses-service.ts";

function enabledFromMessage(message: Memory): boolean | null {
  const text = (
    (message.content as { text?: string } | undefined)?.text ?? ""
  ).toLowerCase();
  const parsed = parseJSONObjectFromText(text) as Record<
    string,
    unknown
  > | null;
  if (typeof parsed?.enabled === "boolean") return parsed.enabled;
  if (/\b(disable|stop|close|off|mute)\b/.test(text)) return false;
  if (/\b(enable|start|open|on|unmute|listen)\b/.test(text)) return true;
  return null;
}

export const smartglassesMicrophoneAction: Action = {
  name: "SMARTGLASSES_MICROPHONE",
  similes: [
    "EVEN_MICROPHONE",
    "OPEN_GLASSES_MIC",
    "CLOSE_GLASSES_MIC",
    "TOGGLE_GLASSES_MIC",
  ],
  description:
    "Enable or disable microphone capture on Even Realities smartglasses. Long press / Even AI start and single tap enable, while double tap / recording stop disable automatically when events arrive.",
  descriptionCompressed:
    "smartglasses-microphone: enable, disable, or toggle Even G1/G2 microphone",
  contexts: ["smartglasses", "wearable", "microphone"],
  validate: async (runtime: IAgentRuntime) =>
    Boolean(getSmartglassesService(runtime)),
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const service = getSmartglassesService(runtime);
    if (!service)
      return { success: false, text: "Smartglasses service not loaded" };
    const requested = enabledFromMessage(message);
    const enabled = requested ?? !service.getStatus().microphoneEnabled;
    await service.setMicrophoneEnabled(enabled);
    const response = `Smartglasses microphone ${enabled ? "enabled" : "disabled"}.`;
    await callback?.({ text: response });
    return {
      success: true,
      text: response,
      values: { microphoneEnabled: enabled },
    };
  },
  examples: [],
};

// Alias for facewear plugin consumers
export const facewearMicrophoneAction = smartglassesMicrophoneAction;

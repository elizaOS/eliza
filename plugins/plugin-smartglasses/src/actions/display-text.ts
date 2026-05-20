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
import {
  getSmartglassesService,
  type SmartglassesDisplayMode,
} from "../services/smartglasses-service.js";

function displayParamsFromMessage(message: Memory): {
  text: string | null;
  mode?: SmartglassesDisplayMode;
} {
  const content = message.content as { text?: string } | undefined;
  const raw = content?.text ?? "";
  const parsed = parseJSONObjectFromText(raw) as Record<string, unknown> | null;
  if (parsed) {
    return {
      text: typeof parsed.text === "string" ? parsed.text : null,
      mode: normalizeMode(parsed.mode),
    };
  }
  return { text: raw.trim() || null };
}

function normalizeMode(value: unknown): SmartglassesDisplayMode | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "text" ||
    normalized === "text_show" ||
    normalized === "direct"
  )
    return "text";
  if (
    normalized === "ai" ||
    normalized === "even_ai" ||
    normalized === "stream"
  )
    return "ai";
  return undefined;
}

export const displaySmartglassesTextAction: Action = {
  name: "SMARTGLASSES_DISPLAY_TEXT",
  similes: ["DISPLAY_ON_GLASSES", "EVEN_DISPLAY_TEXT", "SHOW_ON_SMARTGLASSES"],
  description:
    "Display text on connected Even Realities G1/G2 smartglasses, wrapping text into five-line pages and sending the correct G1 display packets.",
  descriptionCompressed:
    "smartglasses-display-text: show wrapped text on Even G1/G2 display",
  contexts: ["smartglasses", "wearable", "display"],
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
    const { text, mode } = displayParamsFromMessage(message);
    if (!text) return { success: false, text: "No display text provided" };
    const result = await service.displayText(text, { mode });
    const response = `Displayed ${result.pages} page${result.pages === 1 ? "" : "s"} on smartglasses.`;
    await callback?.({ text: response });
    return {
      success: true,
      text: response,
      values: { ...result, mode: mode ?? "ai" },
    };
  },
  examples: [],
};

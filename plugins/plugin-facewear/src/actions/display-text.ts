/**
 * Smartglasses display action parses text requests and sends paginated content
 * to Even Realities G1 lenses.
 */
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
} from "../services/smartglasses-service.ts";

function displayParamsFromMessage(message: Memory): {
  text: string | null;
  mode?: SmartglassesDisplayMode;
  pageHoldMs?: number;
  completionDelayMs?: number;
} {
  const content = message.content as { text?: string } | undefined;
  const raw = content?.text ?? "";
  const parsed = parseJSONObjectFromText(raw) as Record<string, unknown> | null;
  if (parsed) {
    return {
      text: typeof parsed.text === "string" ? parsed.text : null,
      mode: normalizeMode(parsed.mode),
      pageHoldMs: optionalNonNegativeNumber(parsed.pageHoldMs),
      completionDelayMs: optionalNonNegativeNumber(parsed.completionDelayMs),
    };
  }
  return { text: raw.trim() || null };
}

function optionalNonNegativeNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
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

function actionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const displaySmartglassesTextAction: Action = {
  name: "SMARTGLASSES_DISPLAY_TEXT",
  similes: ["DISPLAY_ON_GLASSES", "EVEN_DISPLAY_TEXT", "SHOW_ON_SMARTGLASSES"],
  description:
    "Display text on connected Even Realities G1/G2 smartglasses, wrapping text into five-line pages and sending the correct G1 display packets. JSON input may include mode, pageHoldMs, and completionDelayMs.",
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
    const { text, mode, pageHoldMs, completionDelayMs } =
      displayParamsFromMessage(message);
    if (!text) return { success: false, text: "No display text provided" };
    let result: { pages: number };
    try {
      result = await service.displayText(text, {
        mode,
        pageHoldMs,
        completionDelayMs,
      });
    } catch (error) {
      const response = `Smartglasses display command failed: ${actionErrorMessage(error)}`;
      await callback?.({ text: response });
      return {
        success: false,
        text: response,
        values: {
          error: actionErrorMessage(error),
        },
      };
    }
    const response = `Displayed ${result.pages} page${result.pages === 1 ? "" : "s"} on smartglasses.`;
    await callback?.({ text: response });
    return {
      success: true,
      text: response,
      values: {
        ...result,
        mode: mode ?? "ai",
        pageHoldMs,
        completionDelayMs,
      },
    };
  },
  examples: [],
};

// Alias for facewear plugin consumers
export const displayFacewearTextAction = displaySmartglassesTextAction;

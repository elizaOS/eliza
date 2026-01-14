import type {
  Action,
  ActionResult,
  Content,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import type { ComputerUseService } from "../services/computeruse-service.js";
import { getBooleanParam, getNumberParam, getStringParam } from "../utils/params.js";

export const computeruseTypeAction: Action = {
  name: "COMPUTERUSE_TYPE",
  description:
    "Types text into a UI element on the computer using a ComputerUse selector (optionally clearing the field).",
  similes: ["TYPE_UI", "ENTER_TEXT", "FILL_FIELD"],
  parameters: [
    {
      name: "process",
      description:
        "Process name to scope the typing when using MCP mode (e.g. 'chrome', 'notepad'). Optional if selector is prefixed with 'process:<name> >> ...'.",
      required: false,
      schema: { type: "string" },
      examples: ["chrome", "notepad"],
    },
    {
      name: "selector",
      description: "ComputerUse selector string for the target element",
      required: true,
      schema: { type: "string" },
      examples: ["role:Edit && name:Search"],
    },
    {
      name: "text",
      description: "Text to type",
      required: true,
      schema: { type: "string" },
      examples: ["hello world", "user@example.com{Enter}"],
    },
    {
      name: "timeoutMs",
      description: "Timeout in milliseconds to find the element",
      required: false,
      schema: { type: "number", default: 5000, minimum: 0 },
    },
    {
      name: "clearBeforeTyping",
      description: "Whether to clear existing text before typing (default: true)",
      required: false,
      schema: { type: "boolean", default: true },
    },
  ],

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const service = runtime.getService<ComputerUseService>("computeruse");
    if (!service || !service.isEnabled()) return false;

    const text = message.content?.text?.toLowerCase() ?? "";
    return text.includes("type") || text.includes("enter") || text.includes("fill");
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const service = runtime.getService<ComputerUseService>("computeruse");
    if (!service) {
      return { success: false, text: "ComputerUse service not available" };
    }

    const params = options?.parameters;
    const process = getStringParam(params, "process");
    const selector = getStringParam(params, "selector");
    const text = getStringParam(params, "text");
    const timeoutMs = getNumberParam(params, "timeoutMs") ?? 5000;
    const clearBeforeTyping = getBooleanParam(params, "clearBeforeTyping") ?? true;

    if (!selector) return { success: false, text: "Missing required parameter: selector" };
    if (!text) return { success: false, text: "Missing required parameter: text" };

    try {
      await service.typeText(selector, text, timeoutMs, clearBeforeTyping, process);
      const response: Content = {
        text: `Typed into element: ${selector}`,
        actions: ["COMPUTERUSE_TYPE"],
        source: message.content?.source ?? "action",
      };
      await callback?.(response);
      return {
        success: true,
        text: response.text ?? "",
        values: { process, selector, timeoutMs, clearBeforeTyping },
        data: {
          process,
          selector,
          timeoutMs,
          clearBeforeTyping,
          backend: service.getBackendName(),
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[computeruse] type failed: ${msg}`);
      return {
        success: false,
        text: `ComputerUse type failed: ${msg}`,
        values: { process, selector, timeoutMs, clearBeforeTyping },
        data: {
          process,
          selector,
          timeoutMs,
          clearBeforeTyping,
          backend: service.getBackendName(),
        },
      };
    }
  },
};

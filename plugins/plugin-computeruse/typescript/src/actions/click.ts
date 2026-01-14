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
import { getNumberParam, getStringParam } from "../utils/params.js";

export const computeruseClickAction: Action = {
  name: "COMPUTERUSE_CLICK",
  description: "Clicks a UI element on the computer using a ComputerUse selector.",
  similes: ["CLICK_UI", "CLICK_ELEMENT", "TAP_UI"],
  parameters: [
    {
      name: "process",
      description:
        "Process name to scope the click when using MCP mode (e.g. 'chrome', 'notepad'). Optional if selector is prefixed with 'process:<name> >> ...'.",
      required: false,
      schema: { type: "string" },
      examples: ["chrome", "notepad"],
    },
    {
      name: "selector",
      description: "ComputerUse selector string for the target element",
      required: true,
      schema: { type: "string" },
      examples: ["role:Button && name:Submit", "role:Edit && name:Search"],
    },
    {
      name: "timeoutMs",
      description: "Timeout in milliseconds to find the element",
      required: false,
      schema: { type: "number", default: 5000, minimum: 0 },
      examples: [5000],
    },
  ],

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const service = runtime.getService<ComputerUseService>("computeruse");
    if (!service || !service.isEnabled()) return false;

    const text = message.content?.text?.toLowerCase() ?? "";
    return text.includes("click") || text.includes("tap");
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
    const timeoutMs = getNumberParam(params, "timeoutMs") ?? 5000;
    if (!selector) {
      return { success: false, text: "Missing required parameter: selector" };
    }

    try {
      await service.click(selector, timeoutMs, process);
      const response: Content = {
        text: `Clicked element: ${selector}`,
        actions: ["COMPUTERUSE_CLICK"],
        source: message.content?.source ?? "action",
      };
      await callback?.(response);
      return {
        success: true,
        text: response.text ?? "",
        values: { process, selector, timeoutMs },
        data: { process, selector, timeoutMs, backend: service.getBackendName() },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[computeruse] click failed: ${msg}`);
      return {
        success: false,
        text: `ComputerUse click failed: ${msg}`,
        values: { process, selector, timeoutMs },
        data: { process, selector, timeoutMs, backend: service.getBackendName() },
      };
    }
  },
};

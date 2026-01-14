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

export const computeruseGetWindowTreeAction: Action = {
  name: "COMPUTERUSE_GET_WINDOW_TREE",
  description:
    "Gets the UI tree for a running application (useful for understanding what is currently on screen).",
  similes: ["GET_UI_TREE", "WINDOW_TREE", "DUMP_UI_TREE"],
  parameters: [
    {
      name: "process",
      description: "Process name of the target application (e.g. 'chrome', 'notepad')",
      required: true,
      schema: { type: "string" },
      examples: ["chrome", "notepad"],
    },
    {
      name: "title",
      description: "Optional window title filter",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "maxDepth",
      description: "Optional max tree depth (MCP mode only)",
      required: false,
      schema: { type: "number", minimum: 0 },
      examples: [6],
    },
  ],

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const service = runtime.getService<ComputerUseService>("computeruse");
    if (!service || !service.isEnabled()) return false;

    const text = message.content?.text?.toLowerCase() ?? "";
    return text.includes("window tree") || text.includes("ui tree") || text.includes("dump tree");
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const service = runtime.getService<ComputerUseService>("computeruse");
    if (!service) return { success: false, text: "ComputerUse service not available" };

    const params = options?.parameters;
    const process = getStringParam(params, "process");
    const title = getStringParam(params, "title");
    const maxDepth = getNumberParam(params, "maxDepth");

    if (!process) return { success: false, text: "Missing required parameter: process" };

    try {
      const treeText = await service.getWindowTree(process, title, maxDepth);
      const response: Content = {
        text: treeText.length > 0 ? treeText : "(empty tree result)",
        actions: ["COMPUTERUSE_GET_WINDOW_TREE"],
        source: message.content?.source ?? "action",
      };
      await callback?.(response);
      return {
        success: true,
        text: response.text ?? "",
        values: { process, title, maxDepth },
        data: { process, title, maxDepth, backend: service.getBackendName() },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[computeruse] get window tree failed: ${msg}`);
      return {
        success: false,
        text: `ComputerUse get window tree failed: ${msg}`,
        values: { process, title, maxDepth },
        data: { process, title, maxDepth, backend: service.getBackendName() },
      };
    }
  },
};

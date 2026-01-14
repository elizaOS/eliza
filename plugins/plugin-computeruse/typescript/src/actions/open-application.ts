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
import { getStringParam } from "../utils/params.js";

export const computeruseOpenApplicationAction: Action = {
  name: "COMPUTERUSE_OPEN_APPLICATION",
  description: "Opens an application on the target machine (local or MCP).",
  similes: ["OPEN_APP", "LAUNCH_APP", "START_APPLICATION"],
  parameters: [
    {
      name: "name",
      description: "Application name or executable path (e.g. 'calc', 'notepad', 'chrome')",
      required: true,
      schema: { type: "string" },
      examples: ["calc", "notepad", "chrome"],
    },
  ],

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const service = runtime.getService<ComputerUseService>("computeruse");
    if (!service || !service.isEnabled()) return false;

    const text = message.content?.text?.toLowerCase() ?? "";
    return text.includes("open") || text.includes("launch") || text.includes("start");
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

    const name = getStringParam(options?.parameters, "name");
    if (!name) return { success: false, text: "Missing required parameter: name" };

    try {
      await service.openApplication(name);
      const response: Content = {
        text: `Opened application: ${name}`,
        actions: ["COMPUTERUSE_OPEN_APPLICATION"],
        source: message.content?.source ?? "action",
      };
      await callback?.(response);
      return {
        success: true,
        text: response.text ?? "",
        values: { name },
        data: { name, backend: service.getBackendName() },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[computeruse] open application failed: ${msg}`);
      return {
        success: false,
        text: `ComputerUse open application failed: ${msg}`,
        values: { name },
        data: { name, backend: service.getBackendName() },
      };
    }
  },
};

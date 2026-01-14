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

export const computeruseGetApplicationsAction: Action = {
  name: "COMPUTERUSE_GET_APPLICATIONS",
  description: "Lists currently running applications on the target machine.",
  similes: ["LIST_APPS", "LIST_APPLICATIONS", "SHOW_RUNNING_APPS"],

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const service = runtime.getService<ComputerUseService>("computeruse");
    if (!service || !service.isEnabled()) return false;

    const text = message.content?.text?.toLowerCase() ?? "";
    return text.includes("applications") || text.includes("apps") || text.includes("running");
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const service = runtime.getService<ComputerUseService>("computeruse");
    if (!service) return { success: false, text: "ComputerUse service not available" };

    try {
      const apps = await service.getApplications();
      const text = Array.isArray(apps)
        ? `Applications:\n${apps.map((a) => `- ${a}`).join("\n")}`
        : "Applications: (see output)";
      const response: Content = {
        text,
        actions: ["COMPUTERUSE_GET_APPLICATIONS"],
        source: message.content?.source ?? "action",
      };
      await callback?.(response);
      return {
        success: true,
        text,
        values: { count: apps.length },
        data: { apps, backend: service.getBackendName() },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[computeruse] get applications failed: ${msg}`);
      return { success: false, text: `ComputerUse get applications failed: ${msg}` };
    }
  },
};

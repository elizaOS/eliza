import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { CoderService } from "../services/coderService";

function getCommand(options: HandlerOptions | undefined): string {
  const opt = options as { command?: string } | undefined;
  return opt?.command?.trim() ?? "";
}

export const executeShell: Action = {
  name: "EXECUTE_SHELL",
  similes: ["SHELL", "RUN_COMMAND", "EXEC", "TERMINAL"],
  description:
    "Execute a shell command in the current working directory (restricted).",
  validate: async (runtime: IAgentRuntime): Promise<boolean> =>
    runtime.getService<CoderService>("coder") !== null,
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    options: HandlerOptions | undefined,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const svc = runtime.getService<CoderService>("coder");
    if (!svc) {
      const msg = "Coder service is not available.";
      if (callback) await callback({ content: { text: msg } });
      return { success: false, text: msg };
    }

    const cmd = getCommand(options);
    if (!cmd) {
      const msg = "Missing command.";
      if (callback) await callback({ content: { text: msg } });
      return { success: false, text: msg };
    }

    const conv = message.roomId || message.agentId;
    const result = await svc.executeShell(cmd, conv);
    const out = result.success ? result.stdout : result.stderr;
    if (callback) await callback({ content: { text: out } });
    return { success: result.success, text: out };
  },
};

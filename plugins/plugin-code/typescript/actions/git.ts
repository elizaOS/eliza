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

function getArgs(options: HandlerOptions | undefined): string {
  const opt = options as { args?: string } | undefined;
  return opt?.args?.trim() ?? "";
}

export const git: Action = {
  name: "GIT",
  similes: ["GIT_COMMAND", "GIT_RUN"],
  description: "Run a git command (restricted).",
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

    const args = getArgs(options);
    if (!args) {
      const msg = 'Missing args (provide options.args, e.g. "status").';
      if (callback) await callback({ content: { text: msg } });
      return { success: false, text: msg };
    }

    const conv = message.roomId || message.agentId;
    const result = await svc.git(args, conv);
    const out = result.success ? result.stdout : result.stderr;
    if (callback) await callback({ content: { text: out } });
    return { success: result.success, text: out };
  },
};

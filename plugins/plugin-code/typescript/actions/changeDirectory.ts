import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { requireActionSpec } from "../generated/specs/spec-helpers";
import type { CoderService } from "../services/coderService";

function getTarget(options: HandlerOptions | undefined): string {
  const opt = options as { path?: string } | undefined;
  return opt?.path?.trim() ?? "";
}

const spec = requireActionSpec("CHANGE_DIRECTORY");

export const changeDirectory: Action = {
  name: spec.name,
  similes: spec.similes ? [...spec.similes] : [],
  description: spec.description,
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

    const target = getTarget(options);
    if (!target) {
      const msg = "Missing path.";
      if (callback) await callback({ content: { text: msg } });
      return { success: false, text: msg };
    }

    const conv = message.roomId ?? message.agentId ?? runtime.agentId;
    const result = await svc.changeDirectory(conv, target);
    const out = result.success ? result.stdout : result.stderr;
    if (callback) await callback({ content: { text: out } });
    return { success: result.success, text: out };
  },
};

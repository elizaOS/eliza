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

function getDir(options: HandlerOptions | undefined): string {
  const opt = options as { path?: string } | undefined;
  return opt?.path?.trim() ?? ".";
}

const spec = requireActionSpec("LIST_FILES");

export const listFiles: Action = {
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

    const conv = message.roomId ?? message.agentId ?? runtime.agentId;
    const dir = getDir(options);
    const result = await svc.listFiles(conv, dir);
    if (!result.ok) {
      if (callback) await callback({ content: { text: result.error } });
      return { success: false, text: result.error };
    }

    const out = result.items.length > 0 ? result.items.join("\n") : "(empty)";
    if (callback) await callback({ content: { text: out } });
    return { success: true, text: out };
  },
};

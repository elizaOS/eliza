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

function getInputs(
  options: HandlerOptions | undefined,
  message: Memory,
): { filepath: string; content: string } {
  const opt = options as { filepath?: string; content?: string } | undefined;
  const filepath = opt?.filepath?.trim() ?? "";
  const content = opt?.content ?? "";

  if (filepath) return { filepath, content };

  const text = message.content.text ?? "";
  const m = text.match(/["'`]([^"'`]+)["'`]/);
  const inferred = m?.[1]?.trim() ?? "";
  return { filepath: inferred, content };
}

const spec = requireActionSpec("WRITE_FILE");

export const writeFile: Action = {
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

    const { filepath, content } = getInputs(options, message);
    if (!filepath) {
      const msg = "Missing filepath.";
      if (callback) await callback({ content: { text: msg } });
      return { success: false, text: msg };
    }

    const conv = message.roomId ?? message.agentId ?? runtime.agentId;
    const result = await svc.writeFile(conv, filepath, content);
    if (!result.ok) {
      if (callback) await callback({ content: { text: result.error } });
      return { success: false, text: result.error };
    }

    const msg = `Wrote ${filepath} (${content.length} chars)`;
    if (callback) await callback({ content: { text: msg } });
    return { success: true, text: msg };
  },
};

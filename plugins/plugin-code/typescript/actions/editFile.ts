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

function getInputs(
  options: HandlerOptions | undefined,
  message: Memory,
): { filepath: string; oldStr: string; newStr: string } {
  const opt = options as
    | { filepath?: string; old_str?: string; new_str?: string }
    | undefined;
  const filepath = opt?.filepath?.trim() ?? "";
  const oldStr = opt?.old_str ?? "";
  const newStr = opt?.new_str ?? "";
  if (filepath) return { filepath, oldStr, newStr };

  const text = message.content.text ?? "";
  const m = text.match(/["'`]([^"'`]+)["'`]/);
  const inferred = m?.[1]?.trim() ?? "";
  return { filepath: inferred, oldStr, newStr };
}

export const editFile: Action = {
  name: "EDIT_FILE",
  similes: ["REPLACE_IN_FILE", "PATCH_FILE", "MODIFY_FILE"],
  description: "Replace a substring in a file (single replacement).",
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

    const { filepath, oldStr, newStr } = getInputs(options, message);
    if (!filepath || oldStr.length === 0) {
      const msg = "Missing filepath or old_str.";
      if (callback) await callback({ content: { text: msg } });
      return { success: false, text: msg };
    }

    const conv = message.roomId || message.agentId;
    const result = await svc.editFile(conv, filepath, oldStr, newStr);
    if (!result.ok) {
      if (callback) await callback({ content: { text: result.error } });
      return { success: false, text: result.error };
    }

    const msg = `Edited ${filepath}`;
    if (callback) await callback({ content: { text: msg } });
    return { success: true, text: msg };
  },
};

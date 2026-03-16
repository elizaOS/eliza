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

function getInputs(options: HandlerOptions | undefined): {
  pattern: string;
  path: string;
  maxMatches: number;
} {
  const opt = options as
    | {
        pattern?: string;
        path?: string;
        max_matches?: string;
        maxMatches?: number;
      }
    | undefined;
  const pattern = (opt?.pattern ?? "").trim();
  const p = (opt?.path ?? ".").trim() || ".";
  const mm =
    typeof opt?.maxMatches === "number"
      ? opt.maxMatches
      : Number.parseInt((opt?.max_matches ?? "").trim(), 10);
  const maxMatches = Number.isFinite(mm) && mm > 0 ? mm : 50;
  return { pattern, path: p, maxMatches };
}

const spec = requireActionSpec("SEARCH_FILES");

export const searchFiles: Action = {
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
    const { pattern, path, maxMatches } = getInputs(options);
    if (!pattern) {
      const msg = "Missing pattern.";
      if (callback) await callback({ content: { text: msg } });
      return { success: false, text: msg };
    }

    const result = await svc.searchFiles(conv, pattern, path, maxMatches);
    if (!result.ok) {
      if (callback) await callback({ content: { text: result.error } });
      return { success: false, text: result.error };
    }

    const out =
      result.matches.length === 0
        ? `No matches for "${pattern}".`
        : result.matches
            .map((m) => `${m.file}:L${m.line}: ${m.content}`)
            .join("\n");
    if (callback) await callback({ content: { text: out } });
    return { success: true, text: out };
  },
};

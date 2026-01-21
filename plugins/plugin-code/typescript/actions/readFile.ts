import * as path from "node:path";
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

function extToLang(ext: string): string {
  const e = ext.toLowerCase();
  if (e === ".ts" || e === ".tsx") return "ts";
  if (e === ".js" || e === ".jsx") return "js";
  if (e === ".json") return "json";
  if (e === ".md") return "md";
  if (e === ".py") return "py";
  if (e === ".rs") return "rs";
  if (e === ".go") return "go";
  if (e === ".toml") return "toml";
  if (e === ".yml" || e === ".yaml") return "yaml";
  if (e === ".sh" || e === ".bash" || e === ".zsh") return "bash";
  return "";
}

function getFilepath(
  options: HandlerOptions | undefined,
  message: Memory,
): string {
  const opt = options as { filepath?: string } | undefined;
  if (opt?.filepath && opt.filepath.trim().length > 0)
    return opt.filepath.trim();
  const text = message.content.text ?? "";
  const m = text.match(/["'`]([^"'`]+)["'`]/);
  if (m?.[1]) return m[1].trim();
  const loose = text.match(/(?:\.\/|\/)?[\w\-./]+\.[a-zA-Z0-9]+/);
  return loose?.[0]?.trim() ?? "";
}

const spec = requireActionSpec("READ_FILE");

export const readFile: Action = {
  name: spec.name,
  similes: spec.similes ? [...spec.similes] : [],
  description: `${spec.description} Reads a file's contents.`,
  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
  ): Promise<boolean> => runtime.getService<CoderService>("coder") !== null,
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

    const filepath = getFilepath(options, message);
    if (!filepath) {
      const msg = "Missing filepath.";
      if (callback) await callback({ content: { text: msg } });
      return { success: false, text: msg };
    }

    const conv = message.roomId ?? message.agentId ?? runtime.agentId;
    const result = await svc.readFile(conv, filepath);
    if (!result.ok) {
      if (callback) await callback({ content: { text: result.error } });
      return { success: false, text: result.error };
    }

    const lang = extToLang(path.extname(filepath));
    const fenced = `\`\`\`${lang}\n${result.content}\n\`\`\``;
    if (callback) await callback({ content: { text: fenced } });
    return { success: true, text: fenced };
  },
};

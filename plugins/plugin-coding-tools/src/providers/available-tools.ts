/**
 * AVAILABLE_CODING_TOOLS provider: injects the list of tool names the plugin
 * exposes into agent state at position -10 so the model
 * knows which coding actions it can call.
 */
import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { CODING_TOOLS_CONTEXTS } from "../types.js";

const TOOL_NAMES = [
  "FILE",
  "SHELL",
  "WEB_FETCH",
  "WEB_SEARCH",
  "WORKTREE",
] as const;

/**
 * Surface the coding-tools toolkit to the planner. Mirrors the
 * `enabled_skills` provider pattern. Position -10 keeps it close to the front
 * of the rendered state.
 */
export const availableToolsProvider: Provider = {
  name: "AVAILABLE_CODING_TOOLS",
  description: "Lists the native coding, web, and worktree tools.",
  position: -10,
  contexts: [...CODING_TOOLS_CONTEXTS],
  contextGate: { anyOf: [...CODING_TOOLS_CONTEXTS] },
  cacheStable: true,
  cacheScope: "agent",
  get: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<ProviderResult> => {
    const lines = [
      "# Native coding tools",
      "",
      "FILE reads/writes/searches, SHELL runs commands plus background sessions, WEB_FETCH reads public HTTPS pages, WEB_SEARCH researches the web, and WORKTREE manages git worktrees.",
      "Use absolute workspace paths unless a tool says it defaults to session cwd. Configured private/system paths are blocked.",
      "SHELL background subactions: start_background returns a stable handle; poll_background reads incremental stdout/stderr with offsets and truncation markers; write_background sends stdin; kill_background terminates; list_background shows sessions.",
      "",
      ...TOOL_NAMES.map((n) => `- ${n}`),
    ];
    return {
      text: lines.join("\n"),
      data: { codingTools: TOOL_NAMES.slice() },
    };
  },
};

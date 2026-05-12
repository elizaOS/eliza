import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { CODING_TOOLS_CONTEXTS } from "../types.js";

const TOOL_NAMES = ["FILE", "SHELL", "WORKTREE"] as const;

/**
 * Surface the coding-tools toolkit to the planner. Mirrors the
 * `enabled_skills` provider pattern. Position -10 keeps it close to the front
 * of the rendered state.
 */
export const availableToolsProvider: Provider = {
  name: "AVAILABLE_CODING_TOOLS",
  description:
    "Lists native Claude-Code-style coding tools registered by @elizaos/plugin-coding-tools.",
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
      "These actions read/write files, search the workspace, run shell commands, and manage git worktrees. The TODO umbrella action is provided by @elizaos/plugin-todos when that plugin is enabled.",
      "All file paths must be absolute. Anything is reachable except paths under the configured blocklist (defaults: ~/pvt, ~/Library, ~/.ssh, ~/.aws, ~/.gnupg, ~/.docker, ~/.kube, ~/.netrc, plus per-OS system paths).",
      "",
      ...TOOL_NAMES.map((n) => `- ${n}`),
    ];
    return {
      text: lines.join("\n"),
      data: { codingTools: TOOL_NAMES.slice() },
    };
  },
};

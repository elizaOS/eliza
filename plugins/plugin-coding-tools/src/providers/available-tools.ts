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
  "READ",
  "WRITE",
  "EDIT",
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
      "READ, WRITE, and EDIT provide focused file operations; FILE retains grep/glob/list and compatibility operations. SHELL runs commands plus background sessions, WEB_FETCH reads public HTTPS pages, WEB_SEARCH researches the web, and WORKTREE manages git worktrees.",
      "Use absolute workspace paths unless a tool says it defaults to session cwd. Configured private/system paths are blocked.",
      "For a code change: inspect the relevant implementation and project instructions, make a coherent patch, then run the project’s focused tests or typecheck and fix the observed failures. Avoid repeated reads without a specific unresolved question. Commit only when the task requests it, after checking the diff and validation results.",
      "For the first READ of a file, omit offset and expectedRevision. Revisions belong to one file version: never guess them or carry an old revision across WRITE or EDIT. Only the tools exposed for this turn are callable; the toolkit below may include tools unavailable in the current profile.",
      "SHELL background subactions: start_background returns a stable handle; poll_background reads complete incremental stdout/stderr with offsets and rejects if the complete-capture ceiling is exceeded; write_background sends stdin; kill_background terminates; list_background shows sessions.",
      "",
      "Discover relevant source paths with git ls-files or rg --files when available, then search those paths. Avoid unbounded recursive listings such as ls -R that include node_modules, dependency caches, or generated build output. Inspect dependency or generated files by explicit path when the task requires them; do not dump the whole repository to find a few source files.",
      ...TOOL_NAMES.map((n) => `- ${n}`),
    ];
    return {
      text: lines.join("\n"),
      data: { codingTools: TOOL_NAMES.slice() },
    };
  },
};

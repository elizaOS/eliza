/** Provides shared runtime assembly for interactive and ACP Code agents. */
import { AgentRuntime, type Character, type Plugin } from "@elizaos/core";
import {
  applyCerebrasProviderEnv,
  applyOpencodeProviderEnv,
  hasModelProviderCredential,
  resolveModelProvider,
} from "./model-provider.js";
import { CODE_ASSISTANT_SYSTEM_PROMPT } from "./prompts.js";

/**
 * Eliza Code Character Configuration (Direct Code Agent)
 */
const elizaCodeCharacter: Character = {
  name: "Eliza",
  bio: [
    "A coding assistant that directly helps users with implementation tasks.",
    "Capable of reading, writing, and editing files directly.",
    "Executes shell commands to run tests, linters, and other tools.",
  ],
  system: `${CODE_ASSISTANT_SYSTEM_PROMPT}

You are the direct worker; do not delegate or create sub-agents. The current
working directory is supplied dynamically.`,

  topics: [
    "coding",
    "programming",
    "software development",
    "debugging",
    "testing",
    "refactoring",
    "file operations",
    "shell commands",
    "git",
    "TypeScript",
    "JavaScript",
    "Python",
    "Rust",
  ],

  style: {
    all: [
      "Be thorough but concise",
      "Keep reasoning internal and report only concise verified results",
      "Proactively identify potential issues",
      "Use code blocks for all code examples",
    ],
    chat: [
      "Engage naturally in conversation",
      "Report completed actions and their real results",
    ],
  },

  settings: {
    secrets: {},
  },
};

/**
 * Initialize the Eliza runtime with coding capabilities
 */
export interface InitializeAgentOptions {
  /** Load the interactive entrypoint's repository-local `.env` (default true). */
  loadDotenv?: boolean;
  /**
   * Load `@elizaos/plugin-agent-orchestrator` (default true). Set false when
   * eliza-code itself runs AS a coding sub-agent (e.g. the ACP server) so it
   * cannot recursively spawn its own sub-agents.
   */
  includeOrchestrator?: boolean;
  /**
   * Load only the plugins a headless coding sub-agent needs: sql + provider +
   * shell + coding-tools. Drops mcp, goals, and the orchestrator. (default false)
   * Used by the ACP server variant to avoid goal/mcp surface a sub-agent doesn't
   * use.
   */
  codingOnly?: boolean;
}

export async function initializeAgent(
  options: InitializeAgentOptions = {},
): Promise<AgentRuntime> {
  if (options.loadDotenv !== false) await import("dotenv/config");
  const includeOrchestrator = options.includeOrchestrator !== false;
  applyCerebrasProviderEnv(process.env);
  applyOpencodeProviderEnv(process.env);
  const provider = resolveModelProvider(process.env);
  if (!hasModelProviderCredential(provider, process.env)) {
    throw new Error(
      provider === "anthropic"
        ? "ANTHROPIC_API_KEY is required (ELIZA_CODE_PROVIDER=anthropic)."
        : provider === "cerebras"
          ? "CEREBRAS_API_KEY is required (ELIZA_CODE_PROVIDER=cerebras)."
          : "OPENAI_API_KEY is required (ELIZA_CODE_PROVIDER=openai).",
    );
  }

  const providerPlugin =
    provider === "anthropic"
      ? (await import("@elizaos/plugin-anthropic")).default
      : (await import("@elizaos/plugin-openai")).default;

  if (!process.env.CODING_TOOLS_WORKSPACE_ROOTS) {
    process.env.CODING_TOOLS_WORKSPACE_ROOTS = process.cwd();
  }
  if (!process.env.SHELL_ALLOWED_DIRECTORY) {
    process.env.SHELL_ALLOWED_DIRECTORY = process.cwd();
  }

  const codingOnly = options.codingOnly === true;

  // plugin-shell was consolidated into plugin-coding-tools (the runtime's
  // collector aliases the old name); coding-tools alone now carries the
  // shell/background-process surface this agent needs.
  const [{ plugin: sqlPlugin }, { default: codingToolsPlugin }] =
    await Promise.all([
      import("@elizaos/plugin-sql"),
      import("@elizaos/plugin-coding-tools"),
    ]);

  const plugins: Plugin[] = [sqlPlugin, providerPlugin, codingToolsPlugin];

  // The full agent also loads mcp + goals + (optionally) the orchestrator. A
  // headless coding sub-agent (codingOnly) skips them — it just reads/writes/runs.
  if (!codingOnly) {
    const [{ default: mcpPlugin }, { default: goalsPlugin }] =
      await Promise.all([
        import("@elizaos/plugin-mcp"),
        import("@elizaos/plugin-goals"),
      ]);
    plugins.push(mcpPlugin, goalsPlugin);
    if (includeOrchestrator) {
      const { agentOrchestratorPlugin } = await import(
        "@elizaos/plugin-agent-orchestrator"
      );
      plugins.push(agentOrchestratorPlugin);
    }
  }

  const runtime = new AgentRuntime({
    character: elizaCodeCharacter,
    plugins,
  });

  await runtime.initialize();

  return runtime;
}

export async function shutdownAgent(runtime: AgentRuntime): Promise<void> {
  await runtime.stop();
}

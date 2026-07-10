// Provides shared support logic for the Code example.
import "dotenv/config";
import { AgentRuntime, type Character, type Plugin } from "@elizaos/core";
import {
  applyOpencodeProviderEnv,
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

You are a direct coding agent. You have tools to READ, WRITE, and EDIT files directly.
You also have tools to execute SHELL commands.
When the user asks for code changes, CALL the provided tools to implement them
immediately — do NOT just describe what you would do. Take the action: emit the
tool call (FILE/WRITE/EDIT/SHELL), don't narrate "I'll create the file" and stop.
You do NOT need to create sub-agents or delegate tasks. You are the worker.
After making changes, verify them if possible (e.g. run a test), then give a one
line summary of what you did.
The current working directory is dynamically provided.`,

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
      "Explain your reasoning and actions",
      "Proactively identify potential issues",
      "Use code blocks for all code examples",
    ],
    chat: [
      "Engage naturally in conversation",
      "Provide updates on actions taken",
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
  const includeOrchestrator = options.includeOrchestrator !== false;
  applyOpencodeProviderEnv(process.env);
  const provider = resolveModelProvider(process.env);
  if (provider === "anthropic" && !process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY is required (ELIZA_CODE_PROVIDER=anthropic).",
    );
  }
  if (provider === "openai" && !process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required (ELIZA_CODE_PROVIDER=openai).");
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

  const [
    { plugin: sqlPlugin },
    { shellPlugin },
    { default: codingToolsPlugin },
  ] = await Promise.all([
    import("@elizaos/plugin-sql"),
    import("@elizaos/plugin-shell"),
    import("@elizaos/plugin-coding-tools"),
  ]);

  const plugins: Plugin[] = [
    sqlPlugin,
    providerPlugin,
    shellPlugin,
    codingToolsPlugin,
  ];

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

import "dotenv/config";
import { AgentRuntime, type Character, type Plugin } from "@elizaos/core";
import { resolveModelProvider } from "./model-provider.js";
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
You also have tools to executing SHELL commands.
When the user asks for code changes, use the provided tools to implement them immediately.
You do NOT need to create sub-agents or delegate tasks. You are the worker.
Always explain what you are about to do before doing it.
After making changes, verify them if possible (e.g. run a test).
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
export async function initializeAgent(): Promise<AgentRuntime> {
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

  const [
    { plugin: sqlPlugin },
    { default: mcpPlugin },
    { default: goalsPlugin },
    { shellPlugin },
    { default: codingToolsPlugin },
    { agentOrchestratorPlugin },
  ] = await Promise.all([
    import("@elizaos/plugin-sql"),
    import("@elizaos/plugin-mcp"),
    import("@elizaos/plugin-goals"),
    import("@elizaos/plugin-shell"),
    import("@elizaos/plugin-coding-tools"),
    import("@elizaos/plugin-agent-orchestrator"),
  ]);

  const plugins: Plugin[] = [
    sqlPlugin,
    providerPlugin,
    mcpPlugin,
    goalsPlugin,
    shellPlugin,
    codingToolsPlugin,
    agentOrchestratorPlugin,
  ];

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

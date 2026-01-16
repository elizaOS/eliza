import "dotenv/config";
import { AgentRuntime, type Character, type Plugin } from "@elizaos/core";
import type {
  AgentProvider,
  OrchestratedTask,
  ProviderTaskExecutionContext,
  TaskResult,
} from "@elizaos/plugin-agent-orchestrator";
import {
  agentOrchestratorPlugin,
  configureAgentOrchestratorPlugin,
} from "@elizaos/plugin-agent-orchestrator";
import anthropicPlugin from "@elizaos/plugin-anthropic";
import { CoderService } from "@elizaos/plugin-code";
import goalsPlugin from "@elizaos/plugin-goals";
import mcpPlugin from "@elizaos/plugin-mcp";
import openaiPlugin from "@elizaos/plugin-openai";
import { shellPlugin } from "@elizaos/plugin-shell";
import { plugin as sqlPlugin } from "@elizaos/plugin-sql";
import todoPlugin from "@elizaos/plugin-todo";
import trajectoryLoggerPlugin from "@elizaos/plugin-trajectory-logger";
import type { CodeTask, CodeTaskMetadata, SubAgentType } from "../types.js";
import { resolveModelProvider } from "./model-provider.js";
import { CODE_ASSISTANT_SYSTEM_PROMPT } from "./prompts.js";
import { createSubAgent } from "./sub-agents/registry.js";
import { createTools } from "./sub-agents/tools.js";
import type { SubAgentTool, ToolResult } from "./sub-agents/types.js";

/**
 * Eliza Code Character Configuration
 */
const elizaCodeCharacter: Character = {
  name: "Eliza",
  bio: [
    "An orchestrator that helps users with coding by delegating implementation to specialized worker sub-agents",
  ],
  system: `${CODE_ASSISTANT_SYSTEM_PROMPT}

You are an orchestrator. You MUST NOT read/write/edit project files directly.
All implementation work (reading files, searching, edits, refactors) must be done via background tasks delegated to worker agents.
The user selects which worker sub-agent runs tasks via the /agent command. You MUST NOT choose or suggest a sub-agent type unless the user asks; assume the currently selected worker.
Avoid outputting large code blocks in chat. Instead, create a task and describe what it should change.
When the user asks for code changes, create a task with a clear title and a detailed description, and let the task worker do the implementation.
You MAY run safe shell commands when explicitly requested, but prefer delegating codebase work to tasks.
The current working directory is provided dynamically.`,

  topics: [
    "coding",
    "programming",
    "software development",
    "debugging",
    "testing",
    "code review",
    "refactoring",
    "file operations",
    "shell commands",
    "git",
    "npm",
    "TypeScript",
    "JavaScript",
    "Python",
    "Rust",
    "Go",
  ],

  style: {
    all: [
      "Be thorough but concise",
      "Explain your reasoning and actions",
      "Proactively identify potential issues",
      "Suggest improvements and next steps",
      "Use code blocks for all code examples",
    ],
    chat: [
      "Engage naturally in conversation",
      "Ask clarifying questions when needed",
      "Provide status updates on tasks",
      "Celebrate successes and learn from failures",
    ],
  },

  messageExamples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Can you read the package.json?" },
      },
      {
        name: "Eliza Code",
        content: {
          text: "I'll create a task to inspect package.json and summarize it.",
          actions: ["CREATE_TASK"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Review src/auth.ts for security issues" },
      },
      {
        name: "Eliza Code",
        content: {
          text: "I'll create a task to review src/auth.ts for security issues.",
          actions: ["CREATE_TASK"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Explain what this function does" },
      },
      {
        name: "Eliza Code",
        content: {
          text: "I'll create a task to inspect the function and explain it.",
          actions: ["CREATE_TASK"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Generate a quicksort implementation" },
      },
      {
        name: "Eliza Code",
        content: {
          text: "I'll create a task to generate a quicksort implementation.",
          actions: ["CREATE_TASK"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "sudo rm -rf /" },
      },
      {
        name: "Eliza Code",
        content: {
          text: "I can't help with destructive commands like that.",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Implement a REST API for users" },
      },
      {
        name: "Eliza Code",
        content: {
          text: "I'll create a task to implement the REST API. This will run in the background while we chat.",
          actions: ["CREATE_TASK"],
        },
      },
    ],
  ],
  settings: {
    mcp: {
      servers: {
        context7: {
          type: "streamable-http",
          url: "https://mcp.context7.com/mcp",
          timeout: 30,
        },
      },
    },
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
    provider === "anthropic" ? anthropicPlugin : openaiPlugin;

  // plugin-shell is disabled by default, but it may still validate configuration.
  // Ensure it always has a safe boundary by defaulting to the current directory.
  if (!process.env.SHELL_ALLOWED_DIRECTORY) {
    process.env.SHELL_ALLOWED_DIRECTORY = process.cwd();
  }

  let runtime: AgentRuntime | null = null;
  let coderService: CoderService | null = null;

  // Configure agent providers for the orchestrator plugin.
  // These providers run "worker" sub-agents that have the actual coding tools.
  const providers: AgentProvider[] = [
    {
      id: "eliza",
      label: "Eliza (plugin-code)",
      executeTask: async (
        task: OrchestratedTask,
        ctx: ProviderTaskExecutionContext,
      ): Promise<TaskResult> => {
        if (!runtime) throw new Error("Runtime not initialized");
        return runSubAgentTask(runtime, "eliza", task, ctx, coderService);
      },
    },
    {
      id: "claude-code",
      label: "Claude Code",
      executeTask: async (
        task: OrchestratedTask,
        ctx: ProviderTaskExecutionContext,
      ): Promise<TaskResult> => {
        if (!runtime) throw new Error("Runtime not initialized");
        return runSubAgentTask(runtime, "claude-code", task, ctx, coderService);
      },
    },
    {
      id: "codex",
      label: "Codex",
      executeTask: async (
        task: OrchestratedTask,
        ctx: ProviderTaskExecutionContext,
      ): Promise<TaskResult> => {
        if (!runtime) throw new Error("Runtime not initialized");
        return runSubAgentTask(runtime, "codex", task, ctx, coderService);
      },
    },
    {
      id: "opencode",
      label: "OpenCode",
      executeTask: async (
        task: OrchestratedTask,
        ctx: ProviderTaskExecutionContext,
      ): Promise<TaskResult> => {
        if (!runtime) throw new Error("Runtime not initialized");
        return runSubAgentTask(runtime, "opencode", task, ctx, coderService);
      },
    },
    {
      id: "sweagent",
      label: "SWE-agent",
      executeTask: async (
        task: OrchestratedTask,
        ctx: ProviderTaskExecutionContext,
      ): Promise<TaskResult> => {
        if (!runtime) throw new Error("Runtime not initialized");
        return runSubAgentTask(runtime, "sweagent", task, ctx, coderService);
      },
    },
    {
      id: "elizaos-native",
      label: "ElizaOS Native",
      executeTask: async (
        task: OrchestratedTask,
        ctx: ProviderTaskExecutionContext,
      ): Promise<TaskResult> => {
        if (!runtime) throw new Error("Runtime not initialized");
        return runSubAgentTask(
          runtime,
          "elizaos-native",
          task,
          ctx,
          coderService,
        );
      },
    },
  ];

  configureAgentOrchestratorPlugin({
    providers,
    defaultProviderId: "eliza",
    getWorkingDirectory: () => process.cwd(),
    // Keep env var name for backward compatibility with the /agent UX in the TUI.
    activeProviderEnvVar: "ELIZA_CODE_ACTIVE_SUB_AGENT",
  });

  const plugins: Plugin[] = [
    sqlPlugin,
    providerPlugin,
    mcpPlugin,
    goalsPlugin,
    todoPlugin,
    trajectoryLoggerPlugin,
    shellPlugin,
    agentOrchestratorPlugin,
  ];

  runtime = new AgentRuntime({
    character: elizaCodeCharacter,
    plugins,
  });

  await runtime.initialize();

  // Enable plugin-code style restrictions for worker tool calls (sub-agents only).
  // This does NOT register the plugin’s actions on the orchestrator.
  if (!process.env.CODER_ALLOWED_DIRECTORY) {
    process.env.CODER_ALLOWED_DIRECTORY = process.cwd();
  }
  if (!process.env.CODER_ENABLED) {
    process.env.CODER_ENABLED = "true";
  }
  coderService = new CoderService(runtime);

  return runtime;
}

function toCodeTask(task: OrchestratedTask): CodeTask {
  const m = task.metadata;

  const metadata: CodeTaskMetadata = {
    status: m.status,
    progress: m.progress,
    output: m.output,
    steps: m.steps,
    trace: [],
    workingDirectory: m.workingDirectory,
    subAgentType: (m.subAgentType ?? m.providerId) as SubAgentType,
    createdAt: m.createdAt,
    startedAt: m.startedAt,
    completedAt: m.completedAt,
    userStatus: m.userStatus ?? "open",
    userStatusUpdatedAt: m.userStatusUpdatedAt,
    filesCreated: m.filesCreated ?? [],
    filesModified: m.filesModified ?? [],
    result: m.result,
    error: m.error,
  };

  return {
    id: task.id,
    name: task.name,
    description: task.description,
    tags: task.tags,
    roomId: task.roomId,
    worldId: task.worldId,
    metadata,
  } satisfies CodeTask;
}

async function runSubAgentTask(
  runtime: AgentRuntime,
  type: SubAgentType,
  task: OrchestratedTask,
  ctx: ProviderTaskExecutionContext,
  coderService: CoderService | null,
): Promise<TaskResult> {
  const subAgent = createSubAgent(type);
  const conversationId =
    typeof task.id === "string" && task.id.length > 0 ? task.id : task.name;
  const tools = coderService
    ? createCoderTools(coderService, conversationId)
    : createTools(ctx.workingDirectory);

  return subAgent.execute(toCodeTask(task), {
    runtime,
    workingDirectory: ctx.workingDirectory,
    tools,
    onProgress: (u) => {
      void ctx.updateProgress(u.progress);
      if (u.message) void ctx.appendOutput(u.message);
    },
    onMessage: (msg, _priority) => {
      void ctx.appendOutput(msg);
    },
    isCancelled: ctx.isCancelled,
    isPaused: ctx.isPaused,
  });
}

function createCoderTools(
  coder: CoderService,
  conversationId: string,
): SubAgentTool[] {
  const truncate = (text: string, maxLen: number): string =>
    text.length > maxLen ? `${text.slice(0, maxLen)}\n...(truncated)` : text;

  const ok = (output: string, data?: ToolResult["data"]): ToolResult => ({
    success: true,
    output,
    data,
  });
  const fail = (output: string): ToolResult => ({ success: false, output });

  return [
    {
      name: "read_file",
      description:
        "Read the contents of a file (restricted by CODER_ALLOWED_DIRECTORY)",
      parameters: [
        { name: "filepath", description: "Path to file", required: true },
      ],
      execute: async (args) => {
        const filepath = (args.filepath ?? "").trim();
        const res = await coder.readFile(conversationId, filepath);
        if (!res.ok) return fail(res.error);
        return ok(`File ${filepath}:\n${truncate(res.content, 5000)}`, {
          filepath,
          size: res.content.length,
        });
      },
    },
    {
      name: "write_file",
      description:
        "Create or overwrite a file (restricted by CODER_ALLOWED_DIRECTORY)",
      parameters: [
        { name: "filepath", description: "Path to file", required: true },
        { name: "content", description: "File content", required: true },
      ],
      execute: async (args) => {
        const filepath = (args.filepath ?? "").trim();
        const content = args.content ?? "";
        const res = await coder.writeFile(conversationId, filepath, content);
        if (!res.ok) return fail(res.error);
        return ok(`Wrote ${filepath} (${content.length} chars)`, {
          filepath,
          size: content.length,
        });
      },
    },
    {
      name: "edit_file",
      description:
        "Edit a file by replacing text (restricted by CODER_ALLOWED_DIRECTORY)",
      parameters: [
        { name: "filepath", description: "Path to file", required: true },
        { name: "old_str", description: "Text to find", required: true },
        {
          name: "new_str",
          description: "Text to replace with",
          required: true,
        },
      ],
      execute: async (args) => {
        const filepath = (args.filepath ?? "").trim();
        const oldStr = args.old_str ?? "";
        const newStr = args.new_str ?? "";
        const res = await coder.editFile(
          conversationId,
          filepath,
          oldStr,
          newStr,
        );
        if (!res.ok) return fail(res.error);
        return ok(`Edited ${filepath}`, { filepath });
      },
    },
    {
      name: "list_files",
      description:
        "List files in a directory (restricted by CODER_ALLOWED_DIRECTORY)",
      parameters: [
        { name: "path", description: "Directory path", required: false },
      ],
      execute: async (args) => {
        const dir = (args.path ?? ".").trim() || ".";
        const res = await coder.listFiles(conversationId, dir);
        if (!res.ok) return fail(res.error);
        return ok(`Contents of ${dir}:\n${res.items.join("\n")}`, {
          path: dir,
          count: res.items.length,
        });
      },
    },
    {
      name: "search_files",
      description:
        "Search for a string across files (restricted by CODER_ALLOWED_DIRECTORY)",
      parameters: [
        { name: "pattern", description: "Text to search for", required: true },
        {
          name: "path",
          description: "Directory to search (default: .)",
          required: false,
        },
        {
          name: "max_matches",
          description: "Max matches (default: 50)",
          required: false,
        },
      ],
      execute: async (args) => {
        const pattern = (args.pattern ?? "").trim();
        const dir = (args.path ?? ".").trim() || ".";
        const maxMatchesRaw = (args.max_matches ?? "").trim();
        const maxMatchesParsed = maxMatchesRaw
          ? Number.parseInt(maxMatchesRaw, 10)
          : 50;
        const maxMatches = Number.isFinite(maxMatchesParsed)
          ? maxMatchesParsed
          : 50;
        const res = await coder.searchFiles(
          conversationId,
          pattern,
          dir,
          maxMatches,
        );
        if (!res.ok) return fail(res.error);
        const byFile = new Map<
          string,
          Array<{ line: number; content: string }>
        >();
        for (const m of res.matches) {
          const list = byFile.get(m.file) ?? [];
          list.push({ line: m.line, content: m.content });
          byFile.set(m.file, list);
        }
        const lines: string[] = [
          `Search "${pattern}" in ${dir} (${res.matches.length} matches):`,
        ];
        for (const [file, matches] of byFile) {
          lines.push(`\n${file}`);
          for (const m of matches.slice(0, 5)) {
            lines.push(`  L${m.line}: ${m.content}`);
          }
          if (matches.length > 5)
            lines.push(`  ... +${matches.length - 5} more`);
        }
        return ok(lines.join("\n"));
      },
    },
    {
      name: "shell",
      description:
        "Execute a shell command (restricted by CODER_ALLOWED_DIRECTORY)",
      parameters: [
        { name: "command", description: "Command to run", required: true },
      ],
      execute: async (args) => {
        const command = (args.command ?? "").trim();
        const res = await coder.executeShell(command, conversationId);
        const out = `$ ${command}\n${truncate(res.stdout ?? "", 5000)}${res.stderr ? `\nstderr:\n${truncate(res.stderr, 2000)}` : ""}`;
        return res.success
          ? ok(out, { exitCode: res.exitCode ?? 0, executedIn: res.executedIn })
          : fail(out);
      },
    },
  ];
}

/**
 * Gracefully shutdown the agent
 */
export async function shutdownAgent(runtime: AgentRuntime): Promise<void> {
  await runtime.stop();
}

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import {
  AbstractModel,
  DefaultAgent,
  type History,
  type ModelConfig,
  type ModelOutput,
  type TemplateConfig,
  TextProblemStatement,
  type ToolConfig,
  ToolHandler,
} from "@elizaos/sweagent-root";
import type {
  CodeTask,
  JsonValue,
  TaskResult,
  TaskTraceEvent,
} from "../../types.js";
import type { SubAgent, SubAgentContext, SubAgentTool } from "./types.js";

const SUBMISSION_MARKER = "<<SWE_AGENT_SUBMISSION>>";

function getEnvInt(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return defaultValue;
  return parsed;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function redactSensitiveText(text: string): string {
  let out = text;
  out = out.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[REDACTED:PRIVATE_KEY]",
  );
  out = out.replace(/\bsk-[A-Za-z0-9]{16,}\b/g, "[REDACTED:API_KEY]");
  out = out.replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED:AWS_ACCESS_KEY_ID]");
  out = out.replace(/\bASIA[0-9A-Z]{16}\b/g, "[REDACTED:AWS_ACCESS_KEY_ID]");
  out = out.replace(/\bghp_[A-Za-z0-9]{20,}\b/g, "[REDACTED:GITHUB_TOKEN]");
  out = out.replace(
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    "[REDACTED:GITHUB_TOKEN]",
  );
  out = out.replace(
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    "[REDACTED:SLACK_TOKEN]",
  );
  out = out.replace(/\bBearer\s+[A-Za-z0-9._-]{10,}\b/g, "Bearer [REDACTED]");
  out = out.replace(/\bBasic\s+[A-Za-z0-9+/=]{10,}\b/g, "Basic [REDACTED]");
  out = out.replace(/(password\s*[:=]\s*)(\S+)/gi, "$1[REDACTED]");
  for (const [key, value] of Object.entries(process.env)) {
    if (!value || value.length < 12) continue;
    const upper = key.toUpperCase();
    if (
      upper.includes("KEY") ||
      upper.includes("TOKEN") ||
      upper.includes("SECRET") ||
      upper.includes("PASSWORD") ||
      upper.includes("PASSWD") ||
      upper.includes("AUTH")
    ) {
      out = out.split(value).join(`[REDACTED:${key}]`);
    }
  }
  return out;
}

/**
 * Ensures a directory exists, creating it and parent directories if necessary.
 * @param dir - The directory path to ensure exists
 * @throws Error if the directory path is empty or whitespace-only
 */
async function ensureDir(dir: string): Promise<void> {
  if (!dir || dir.trim() === "") {
    throw new Error("Directory path cannot be empty");
  }
  await fs.mkdir(dir, { recursive: true });
}

function findTool(tools: SubAgentTool[], name: string): SubAgentTool {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Required tool not available: ${name}`);
  return tool;
}

function parseGitStatusPorcelain(output: string): {
  created: string[];
  modified: string[];
} {
  const created: string[] = [];
  const modified: string[] = [];
  const lines = output.split("\n").map((l) => l.trimEnd());
  for (const line of lines) {
    if (!line) continue;
    const status = line.slice(0, 2);
    const file = line.slice(3).trim();
    if (!file) continue;
    if (status.includes("?") || status.includes("A")) {
      created.push(file);
    } else {
      modified.push(file);
    }
  }
  return { created, modified };
}

async function isGitRepo(shellTool: SubAgentTool): Promise<boolean> {
  const res = await shellTool.execute({
    command: "git rev-parse --is-inside-work-tree",
  });
  return res.success && res.output.includes("true");
}

function extractShellStdout(toolOutput: string): string {
  // shell tool returns `$ cmd\nstdout...`; return everything after first newline.
  const idx = toolOutput.indexOf("\n");
  return idx === -1 ? "" : toolOutput.slice(idx + 1);
}

async function getGitStatus(shellTool: SubAgentTool): Promise<string> {
  const res = await shellTool.execute({ command: "git status --porcelain" });
  if (!res.success) throw new Error(`git status failed: ${res.output}`);
  return extractShellStdout(res.output);
}

async function buildPatch(shellTool: SubAgentTool): Promise<string> {
  const unstaged = await shellTool.execute({ command: "git diff" });
  const staged = await shellTool.execute({ command: "git diff --cached" });
  const parts: string[] = [];
  if (unstaged.success) parts.push(extractShellStdout(unstaged.output));
  if (staged.success) parts.push(extractShellStdout(staged.output));
  return parts.join("\n").trim();
}

class RuntimeModel extends AbstractModel {
  private readonly runtime: IAgentRuntime;
  private readonly modelType: string;
  stats = { apiCalls: 0, inputTokens: 0, outputTokens: 0 };

  constructor(runtime: IAgentRuntime, config: ModelConfig, tools: ToolConfig) {
    super(config, tools);
    this.runtime = runtime;
    // Prefer reasoning model when available, but keep this implementation generic.
    this.modelType = runtime.getModel("TEXT_REASONING_LARGE")
      ? "TEXT_REASONING_LARGE"
      : "TEXT_LARGE";
  }

  async query(history: History): Promise<ModelOutput> {
    this.stats.apiCalls += 1;
    const prompt = history
      .map((m: { role: string; content: string | Record<string, unknown> }) => {
        const content =
          typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return `${m.role.toUpperCase()}: ${content}`;
      })
      .join("\n\n");
    const response = await this.runtime.useModel(this.modelType, {
      prompt,
      maxTokens: 4096,
      temperature: 0.1,
    });
    return { message: response };
  }
}

interface SweAgentEnvironment {
  communicate: (
    command: string,
    timeout?: number | Record<string, JsonValue>,
    options?: Record<string, JsonValue>,
  ) => Promise<string>;
  readFile: (p: string, encoding?: string) => Promise<string>;
  writeFile: (p: string, content: string) => Promise<void>;
  setEnvVariables: (vars: Record<string, string>) => Promise<void>;
  executeCommand: (
    command: string,
    options?: Record<string, JsonValue>,
  ) => Promise<void>;
  interruptSession: () => Promise<void>;
  getCwd?: () => string;
  repo?: { repoName: string };
  name?: string;
}

class LocalToolEnvironment implements SweAgentEnvironment {
  private readonly workingDirectory: string;
  private readonly shellTool: SubAgentTool;
  private readonly patchPath: string;
  private readonly submitCommand: string;

  constructor(args: {
    workingDirectory: string;
    shellTool: SubAgentTool;
    patchPath: string;
    submitCommand: string;
  }) {
    this.workingDirectory = args.workingDirectory;
    this.shellTool = args.shellTool;
    this.patchPath = args.patchPath;
    this.submitCommand = args.submitCommand;
    this.repo = { repoName: path.basename(this.workingDirectory) };
    this.name = "local";
  }

  repo?: { repoName: string };
  name?: string;

  getCwd = (): string => this.workingDirectory;

  async communicate(command: string): Promise<string> {
    const cmd = command.trim();
    if (cmd === this.submitCommand) {
      const patch = await buildPatch(this.shellTool);
      await ensureDir(path.dirname(this.patchPath));
      await fs.writeFile(this.patchPath, patch, "utf-8");
      return SUBMISSION_MARKER;
    }
    const result = await this.shellTool.execute({ command: cmd });
    return result.output;
  }

  async readFile(
    p: string,
    encoding: BufferEncoding = "utf-8",
  ): Promise<string> {
    const resolved =
      p === "/root/model.patch"
        ? this.patchPath
        : path.resolve(this.workingDirectory, p);
    return await fs.readFile(resolved, encoding);
  }

  async writeFile(p: string, content: string): Promise<void> {
    const resolved =
      p === "/root/model.patch"
        ? this.patchPath
        : path.resolve(this.workingDirectory, p);
    await ensureDir(path.dirname(resolved));
    await fs.writeFile(resolved, content, "utf-8");
  }

  async setEnvVariables(_vars: Record<string, string>): Promise<void> {
    // This adapter intentionally does not mutate the host process environment.
    return;
  }

  async executeCommand(command: string): Promise<void> {
    await this.communicate(command);
  }

  async interruptSession(): Promise<void> {
    // No persistent shell session to interrupt (commands are per-call).
    return;
  }
}

const DEFAULT_TEMPLATES: TemplateConfig = {
  systemTemplate:
    "You are SWE-agent. Follow the format strictly.\n\nDISCUSSION\nExplain what you will do.\n\n```\n<one shell command>\n```\n\nWhen finished, run:\n\n```\nsubmit\n```\n",
  instanceTemplate:
    "Task:\n{{problemStatement}}\n\nRepository: {{repo}}\nWorking directory: {{workingDir}}\n",
  nextStepTemplate: "Observation: {{observation}}",
  nextStepTruncatedObservationTemplate:
    "Observation: {{observation[:max_observation_length]}}<response clipped>",
  maxObservationLength: 50000,
  demonstrations: [],
  putDemosInHistory: false,
  disableImageProcessing: true,
  shellCheckErrorTemplate:
    "Your command contains syntax errors. Please fix them.\nError: {{error_message}}\nHint: {{hint}}",
  commandCancelledTimeoutTemplate:
    "Command cancelled after {{timeout}} seconds. The command was: {{command}}",
  nextStepNoOutputTemplate: "Observation: (no output)",
  strategyTemplate: undefined,
  demonstrationTemplate: undefined,
};

export class SweAgentSubAgent implements SubAgent {
  readonly name = "SWE-agent Worker";
  readonly type = "sweagent" as const;

  private cancelled = false;
  private readonly maxIterations: number;
  private readonly debug: boolean;

  constructor(config?: { maxIterations?: number; debug?: boolean }) {
    this.maxIterations =
      config?.maxIterations ??
      getEnvInt("ELIZA_CODE_SWEAGENT_MAX_ITERATIONS", 30);
    this.debug = config?.debug ?? process.env.ELIZA_CODE_DEBUG === "1";
  }

  cancel(): void {
    this.cancelled = true;
  }

  async execute(task: CodeTask, context: SubAgentContext): Promise<TaskResult> {
    this.cancelled = false;

    const {
      runtime,
      workingDirectory,
      tools,
      onProgress,
      onMessage,
      onTrace,
      isCancelled,
      isPaused,
    } = context;

    const shellTool = findTool(tools, "shell");

    if (!(await isGitRepo(shellTool))) {
      return {
        success: false,
        summary: "SWE-agent requires a git repository",
        filesCreated: [],
        filesModified: [],
        error:
          "Not a git repository (git rev-parse --is-inside-work-tree returned false)",
      };
    }

    const beforeStatus = await getGitStatus(shellTool);

    const patchPath = path.resolve(
      workingDirectory,
      ".eliza/sweagent/model.patch",
    );
    const env = new LocalToolEnvironment({
      workingDirectory,
      shellTool,
      patchPath,
      submitCommand: "submit",
    });

    const toolConfig: ToolConfig = {
      commands: [],
      parseFunction: "thought_action",
      executionTimeout: 55,
      maxConsecutiveExecutionTimeouts: 2,
      totalExecutionTimeout: 60 * 60,
      submitCommand: "submit",
      useFunctionCalling: false,
      formatErrorTemplate:
        "Your output was not formatted correctly. Use DISCUSSION then one command in a code block.",
      filter: {
        blocklistErrorTemplate:
          "That command is not allowed. Choose a safer alternative.",
        blocklist: ["rm -rf", "sudo rm", "mkfs", "dd "],
        blocklistStandalone: ["shutdown", "reboot"],
      },
      envVariables: {},
    };

    const modelConfig: ModelConfig = {
      name: "runtime",
      perInstanceCostLimit: 0,
      totalCostLimit: 0,
      perInstanceCallLimit: 0,
      temperature: 0.1,
      topP: 1,
      apiBase: null,
      apiVersion: null,
      apiKey: null,
      stop: [],
      completionKwargs: {},
      convertSystemToUser: false,
      retry: { retries: 0, minWait: 0, maxWait: 0 },
      delay: 0,
      fallbacks: [],
      chooseApiKeyByThread: false,
      maxInputTokens: null,
      maxOutputTokens: null,
      litellmModelRegistry: null,
      customTokenizer: null,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const model = new RuntimeModel(runtime, modelConfig, toolConfig as any);
    const agent = new DefaultAgent({
      templates: DEFAULT_TEMPLATES,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: new ToolHandler(toolConfig) as any,
      historyProcessors: [],
      model,
      maxRequeries: 3,
      name: "sweagent",
    });

    const outputDir = path.resolve(workingDirectory, ".eliza/sweagent/runs");
    await ensureDir(outputDir);

    const ps = new TextProblemStatement({
      text: `${task.name}\n\n${task.description ?? ""}`.trim(),
      id: task.id ?? "task",
    });

    await agent.setup(env, ps, outputDir);

    let iteration = 0;
    while (!this.cancelled) {
      if (isCancelled()) {
        return {
          success: false,
          summary: "Cancelled",
          filesCreated: [],
          filesModified: [],
          error: "Cancelled by user",
        };
      }

      if (isPaused?.()) {
        await new Promise((r) => setTimeout(r, 250));
        continue;
      }

      iteration += 1;
      onProgress({
        taskId: task.id ?? "",
        progress: Math.min(
          90,
          Math.round((iteration / this.maxIterations) * 80),
        ),
      });

      const step = await agent.step();

      const thoughtPreview = truncate(step.thought ?? "", 220);
      const actionPreview = truncate(step.action ?? "", 220);

      if (this.debug) {
        onMessage(`DISCUSSION: ${thoughtPreview}`, "info");
        onMessage(`COMMAND: ${actionPreview}`, "info");
      }

      onTrace?.({
        kind: "note",
        level: "info",
        message: `step ${iteration}: ${truncate(redactSensitiveText(thoughtPreview), 160)}`,
        ts: Date.now(),
        seq: iteration,
      } as TaskTraceEvent);

      if (step.done) break;
      if (iteration >= this.maxIterations) break;
    }

    const afterStatus = await getGitStatus(shellTool);
    const delta = parseGitStatusPorcelain(afterStatus);

    let patchExists = false;
    try {
      await fs.stat(patchPath);
      patchExists = true;
    } catch {
      patchExists = false;
    }

    const success =
      patchExists || delta.created.length + delta.modified.length > 0;
    if (!success) {
      return {
        success: false,
        summary: "No patch produced",
        filesCreated: delta.created,
        filesModified: delta.modified,
        error: `No submission patch produced.\nBefore status:\n${beforeStatus}\nAfter status:\n${afterStatus}`,
      };
    }

    return {
      success: true,
      summary: "Submitted patch",
      filesCreated: delta.created,
      filesModified: delta.modified,
    };
  }
}

export function createSweAgentSubAgent(config?: {
  maxIterations?: number;
  debug?: boolean;
}): SubAgent {
  return new SweAgentSubAgent(config);
}

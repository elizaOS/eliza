import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type IAgentRuntime, Service } from "@elizaos/core";
import {
  type ClaudeCodeWorkbenchConfig,
  isWorkflowAllowed,
  loadClaudeCodeWorkbenchConfig,
} from "../config.ts";
import {
  listDefaultWorkflows,
  normalizeWorkflowId,
  type WorkbenchWorkflow,
} from "../workflows.ts";

export interface WorkbenchWorkflowSummary {
  id: string;
  title: string;
  description: string;
  category: string;
  mutatesRepo: boolean;
  enabled: boolean;
  commandPreview: string;
}

export interface WorkbenchRunInput {
  workflow: string;
  cwd?: string;
  stdin?: string;
}

export interface WorkbenchRunResult {
  ok: boolean;
  workflow: string;
  command: string;
  args: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface WorkbenchStatus {
  available: boolean;
  running: boolean;
  workspaceRoot: string;
  timeoutMs: number;
  maxOutputChars: number;
  maxStdinBytes: number;
  allowedWorkflowIds: string[];
  enableMutatingWorkflows: boolean;
  workflows: WorkbenchWorkflowSummary[];
  lastRunAt?: number;
  lastWorkflow?: string;
  lastExitCode?: number | null;
  lastDurationMs?: number;
  lastError?: string;
}

function appendWithLimit(
  current: string,
  chunk: Buffer | string,
  limit: number,
): { value: string; truncated: boolean } {
  if (current.length >= limit) {
    return { value: current, truncated: true };
  }

  const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  const remaining = limit - current.length;

  if (text.length <= remaining) {
    return { value: current + text, truncated: false };
  }

  return {
    value: current + text.slice(0, remaining),
    truncated: true,
  };
}

function withTruncationSuffix(value: string, truncated: boolean): string {
  if (!truncated) {
    return value;
  }

  const suffix = "\n...[truncated by plugin-claude-code-workbench]";
  return value.endsWith(suffix) ? value : `${value}${suffix}`;
}

function cleanOptionalValue(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned && cleaned.length > 0 ? cleaned : undefined;
}

function isPathInside(baseDir: string, targetDir: string): boolean {
  if (baseDir === targetDir) {
    return true;
  }

  const normalizedBase =
    process.platform === "win32" ? baseDir.toLowerCase() : baseDir;
  const normalizedTarget =
    process.platform === "win32" ? targetDir.toLowerCase() : targetDir;
  return normalizedTarget.startsWith(`${normalizedBase}${path.sep}`);
}

function toSummary(
  workflow: WorkbenchWorkflow,
  enableMutatingWorkflows: boolean,
): WorkbenchWorkflowSummary {
  return {
    id: workflow.id,
    title: workflow.title,
    description: workflow.description,
    category: workflow.category,
    mutatesRepo: workflow.mutatesRepo,
    enabled: !workflow.mutatesRepo || enableMutatingWorkflows,
    commandPreview: `${workflow.command} ${workflow.args.join(" ")}`.trim(),
  };
}

export class ClaudeCodeWorkbenchService extends Service {
  static override serviceType = "claude_code_workbench";

  override capabilityDescription =
    "Run allowlisted repository workflows for this monorepo with safe process controls.";

  private readonly runtimeConfig: ClaudeCodeWorkbenchConfig;
  private readonly workflows: Map<string, WorkbenchWorkflow>;
  private runQueue: Promise<unknown> = Promise.resolve();
  private running = false;
  private available = true;
  private lastRunAt?: number;
  private lastWorkflow?: string;
  private lastExitCode?: number | null;
  private lastDurationMs?: number;
  private lastError?: string;

  constructor(
    runtime?: IAgentRuntime,
    config?: ClaudeCodeWorkbenchConfig,
    workflows?: WorkbenchWorkflow[],
  ) {
    super(runtime);
    this.runtimeConfig = config ?? loadClaudeCodeWorkbenchConfig(process.env);

    const sourceWorkflows = workflows ?? listDefaultWorkflows();
    const filtered = sourceWorkflows.filter((workflow) =>
      isWorkflowAllowed(workflow.id, this.runtimeConfig.allowedWorkflowIds),
    );

    this.workflows = new Map(
      filtered.map((workflow) => [
        normalizeWorkflowId(workflow.id),
        {
          ...workflow,
          id: normalizeWorkflowId(workflow.id),
          args: [...workflow.args],
        },
      ]),
    );
  }

  static async start(runtime: IAgentRuntime): Promise<Service> {
    return new ClaudeCodeWorkbenchService(runtime);
  }

  static async stop(runtime: IAgentRuntime): Promise<void> {
    const service = runtime.getService(ClaudeCodeWorkbenchService.serviceType);
    if (service && "stop" in service && typeof service.stop === "function") {
      await service.stop();
    }
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  listWorkflows(): WorkbenchWorkflowSummary[] {
    return Array.from(this.workflows.values())
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((workflow) =>
        toSummary(workflow, this.runtimeConfig.enableMutatingWorkflows),
      );
  }

  getStatus(): WorkbenchStatus {
    return {
      available: this.available,
      running: this.running,
      workspaceRoot: this.runtimeConfig.workspaceRoot,
      timeoutMs: this.runtimeConfig.timeoutMs,
      maxOutputChars: this.runtimeConfig.maxOutputChars,
      maxStdinBytes: this.runtimeConfig.maxStdinBytes,
      allowedWorkflowIds: [...this.runtimeConfig.allowedWorkflowIds],
      enableMutatingWorkflows: this.runtimeConfig.enableMutatingWorkflows,
      workflows: this.listWorkflows(),
      lastRunAt: this.lastRunAt,
      lastWorkflow: this.lastWorkflow,
      lastExitCode: this.lastExitCode,
      lastDurationMs: this.lastDurationMs,
      lastError: this.lastError,
    };
  }

  async run(input: WorkbenchRunInput): Promise<WorkbenchRunResult> {
    const task = this.runQueue.then(
      () => this.executeRun(input),
      () => this.executeRun(input),
    );

    this.runQueue = task.then(
      () => undefined,
      () => undefined,
    );

    return task;
  }

  private resolveWorkingDirectory(inputCwd?: string): string {
    const workspaceRootPath = path.resolve(this.runtimeConfig.workspaceRoot);
    const requestedPath = path.resolve(
      cleanOptionalValue(inputCwd) ?? workspaceRootPath,
    );

    let workspaceRoot: string;
    let requested: string;

    try {
      workspaceRoot = fs.realpathSync(workspaceRootPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `CLAUDE_CODE_WORKBENCH_WORKSPACE_ROOT is not accessible (${workspaceRootPath}): ${message}`,
      );
    }

    try {
      requested = fs.realpathSync(requestedPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Workbench cwd is not accessible (${requestedPath}): ${message}`,
      );
    }

    if (!isPathInside(workspaceRoot, requested)) {
      throw new Error(
        `Workbench cwd must stay within CLAUDE_CODE_WORKBENCH_WORKSPACE_ROOT (${workspaceRoot}). Received: ${requested}`,
      );
    }

    return requested;
  }

  private buildChildEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    const baseKeys = [
      "PATH",
      "HOME",
      "USERPROFILE",
      "SHELL",
      "COMSPEC",
      "PATHEXT",
      "SystemRoot",
      "TMP",
      "TEMP",
      "TERM",
      "CI",
      "FORCE_COLOR",
    ];

    for (const key of baseKeys) {
      const value = process.env[key];
      if (typeof value === "string" && value.length > 0) {
        env[key] = value;
      }
    }

    for (const [key, value] of Object.entries(process.env)) {
      if (
        key.startsWith("CLAUDE_CODE_WORKBENCH_") &&
        typeof value === "string" &&
        value.length > 0
      ) {
        env[key] = value;
      }
    }

    return env;
  }

  private resolveWorkflow(workflowId: string): WorkbenchWorkflow {
    const normalized = normalizeWorkflowId(workflowId);
    const workflow = this.workflows.get(normalized);

    if (!workflow) {
      const allowed = this.listWorkflows()
        .map((entry) => entry.id)
        .join(", ");
      throw new Error(
        `Unknown workflow "${workflowId}". Allowed workflows: ${allowed || "none"}.`,
      );
    }

    if (workflow.mutatesRepo && !this.runtimeConfig.enableMutatingWorkflows) {
      throw new Error(
        `Workflow "${workflow.id}" mutates the repository and is disabled. Set CLAUDE_CODE_WORKBENCH_ENABLE_MUTATING_WORKFLOWS=true to enable it.`,
      );
    }

    return workflow;
  }

  private async executeRun(
    input: WorkbenchRunInput,
  ): Promise<WorkbenchRunResult> {
    const workflow = this.resolveWorkflow(input.workflow);

    if (
      input.stdin &&
      Buffer.byteLength(input.stdin, "utf8") > this.runtimeConfig.maxStdinBytes
    ) {
      throw new Error(
        `Workbench stdin exceeds limit (${this.runtimeConfig.maxStdinBytes} bytes).`,
      );
    }

    const cwd = this.resolveWorkingDirectory(input.cwd);
    this.running = true;
    this.lastWorkflow = workflow.id;

    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;

    try {
      const child = spawn(workflow.command, workflow.args, {
        cwd,
        env: this.buildChildEnv(),
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      });

      if (input.stdin) {
        child.stdin?.write(input.stdin);
      }
      child.stdin?.end();

      child.stdout?.on("data", (chunk) => {
        const next = appendWithLimit(
          stdout,
          chunk,
          this.runtimeConfig.maxOutputChars,
        );
        stdout = next.value;
        stdoutTruncated = stdoutTruncated || next.truncated;
      });

      child.stderr?.on("data", (chunk) => {
        const next = appendWithLimit(
          stderr,
          chunk,
          this.runtimeConfig.maxOutputChars,
        );
        stderr = next.value;
        stderrTruncated = stderrTruncated || next.truncated;
      });

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }

        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore
          }
        }, 250);
      }, this.runtimeConfig.timeoutMs);

      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code));
      }).finally(() => {
        clearTimeout(timeoutHandle);
      });

      if (timedOut) {
        const timeoutMessage = `Workflow timed out after ${this.runtimeConfig.timeoutMs}ms.`;
        const next = appendWithLimit(
          stderr,
          timeoutMessage,
          this.runtimeConfig.maxOutputChars,
        );
        stderr = next.value;
        stderrTruncated = stderrTruncated || next.truncated;
      }

      const durationMs = Date.now() - startedAt;
      const ok = !timedOut && exitCode === 0;

      this.available = true;
      this.lastRunAt = startedAt;
      this.lastExitCode = exitCode;
      this.lastDurationMs = durationMs;
      this.lastError = ok
        ? undefined
        : stderr || `Process exited with code ${String(exitCode)}`;

      return {
        ok,
        workflow: workflow.id,
        command: workflow.command,
        args: [...workflow.args],
        exitCode,
        stdout: withTruncationSuffix(stdout, stdoutTruncated),
        stderr: withTruncationSuffix(stderr, stderrTruncated),
        durationMs,
        timedOut,
        stdoutTruncated,
        stderrTruncated,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastRunAt = startedAt;
      this.lastExitCode = null;
      this.lastDurationMs = Date.now() - startedAt;
      this.lastError = message;

      const maybeErrno = error as NodeJS.ErrnoException;
      if (maybeErrno?.code === "ENOENT") {
        this.available = false;
      }

      throw error;
    } finally {
      this.running = false;
    }
  }
}

import { randomUUID } from "node:crypto";
import nodePath from "node:path";
import {
  CAPABILITY_ROUTER_SERVICE_TYPE,
  CapabilityError,
  logger,
  Service,
  type CapabilityAvailability,
  type CapabilityName,
  type ElizaCapabilityRouter,
  type FileListParams,
  type FileListResult,
  type FileReadTextParams,
  type FileReadTextResult,
  type FileStat,
  type FileWriteTextParams,
  type FileWriteTextResult,
  type GitCommandRunParams,
  type GitCommandRunResult,
  type GitDiffParams,
  type GitDiffResult,
  type GitOperation,
  type GitStatusParams,
  type GitStatusResult,
  type IAgentRuntime,
  type JsonObject,
  type LocalModelStatusResult,
  type TerminalRunParams,
  type TerminalRunResult,
} from "@elizaos/core";
import type {
  CommandResult,
  CommandStartOpts,
  EntryInfo,
  SandboxConnectOpts,
  SandboxOpts,
} from "e2b";

const LOG_CONTEXT = { src: "service:e2b_satellite_runner" } as const;
const DEFAULT_WORKDIR = "/workspace";
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60 * 1000;
const MAX_READ_BYTES = 5 * 1024 * 1024;
const MAX_LIST_LIMIT = 1000;

export interface E2BSatelliteRunnerConfig {
  enabled: boolean;
  apiKey?: string;
  accessToken?: string;
  domain?: string;
  sandboxId?: string;
  template?: string;
  workdir: string;
  hostWorkspaceRoot: string;
  timeoutMs: number;
  requestTimeoutMs: number;
  keepAlive: boolean;
  allowInternetAccess: boolean;
  bootstrapGitUrl?: string;
  bootstrapGitRef?: string;
  envs: Record<string, string>;
  metadata: Record<string, string>;
}

export interface E2BSandboxFactory {
  create(config: E2BSatelliteRunnerConfig): Promise<E2BSandboxClient>;
}

export interface E2BSandboxClient {
  readonly sandboxId: string;
  readonly files: {
    list(
      path: string,
      opts?: { depth?: number; requestTimeoutMs?: number },
    ): Promise<EntryInfo[]>;
    read(
      path: string,
      opts?: { format?: "text"; requestTimeoutMs?: number },
    ): Promise<string>;
    read(
      path: string,
      opts: { format: "bytes"; requestTimeoutMs?: number },
    ): Promise<Uint8Array>;
    write(
      path: string,
      data: string,
      opts?: { requestTimeoutMs?: number },
    ): Promise<{ path: string; name: string }>;
  };
  readonly commands: {
    run(
      cmd: string,
      opts?: CommandStartOpts & { background?: false },
    ): Promise<CommandResult>;
  };
  kill(opts?: { requestTimeoutMs?: number }): Promise<void>;
}

class DefaultE2BSandboxFactory implements E2BSandboxFactory {
  async create(config: E2BSatelliteRunnerConfig): Promise<E2BSandboxClient> {
    const { Sandbox } = await import("e2b");
    if (config.sandboxId) {
      return Sandbox.connect(config.sandboxId, connectOptions(config));
    }
    if (config.template) {
      return Sandbox.create(config.template, createOptions(config));
    }
    return Sandbox.create(createOptions(config));
  }
}

export class E2BSatelliteCapabilityRouterService
  extends Service
  implements ElizaCapabilityRouter
{
  static serviceType = CAPABILITY_ROUTER_SERVICE_TYPE;
  capabilityDescription =
    "Routes filesystem, terminal, and local Git capabilities to an E2B Satellite runner.";

  readonly environment = "server";
  readonly fs = {
    list: (params?: FileListParams) => this.list(params),
    readText: (params: FileReadTextParams) => this.readText(params),
    writeText: (params: FileWriteTextParams) => this.writeText(params),
  };
  readonly pty = {
    runCommand: (params: TerminalRunParams) => this.runCommand(params),
  };
  readonly git = {
    status: (params: GitStatusParams) => this.gitStatus(params),
    diff: (params: GitDiffParams) => this.gitDiff(params),
    commandRun: (params: GitCommandRunParams) => this.gitCommandRun(params),
  };
  readonly model = {
    status: () => this.modelStatus(),
  };

  private sandboxPromise: Promise<E2BSandboxClient> | null = null;
  private preparePromise: Promise<void> | null = null;
  private createdSandbox = false;
  private readonly routerConfig: E2BSatelliteRunnerConfig;

  constructor(
    runtime?: IAgentRuntime,
    routerConfig?: E2BSatelliteRunnerConfig,
    private readonly factory: E2BSandboxFactory = new DefaultE2BSandboxFactory(),
  ) {
    if (!runtime) {
      throw new Error(
        "E2BSatelliteCapabilityRouterService requires a runtime.",
      );
    }
    super(runtime);
    this.routerConfig =
      routerConfig ?? resolveE2BSatelliteRunnerConfig(runtime);
  }

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const config = resolveE2BSatelliteRunnerConfig(runtime);
    const service = new E2BSatelliteCapabilityRouterService(runtime, config);
    logger.info(
      {
        ...LOG_CONTEXT,
        workdir: config.workdir,
        template: config.template ?? null,
        hasSandboxId: Boolean(config.sandboxId),
        hasBootstrapGitUrl: Boolean(config.bootstrapGitUrl),
      },
      "[E2BSatelliteCapabilityRouter] Service started",
    );
    return service;
  }

  async stop(): Promise<void> {
    const sandbox = await this.sandboxPromise?.catch(() => null);
    this.sandboxPromise = null;
    this.preparePromise = null;
    if (!sandbox || this.routerConfig.keepAlive || !this.createdSandbox) return;
    await sandbox.kill({
      requestTimeoutMs: this.routerConfig.requestTimeoutMs,
    });
  }

  async availability(): Promise<CapabilityAvailability> {
    const available = hasE2BCredentials(this.routerConfig);
    return {
      environment: this.environment,
      available,
      capabilities: {
        fs: available,
        pty: available,
        git: available,
        model: false,
      },
      ...(available
        ? {}
        : {
            reason:
              "E2B Satellite runner requires E2B_API_KEY, E2B_ACCESS_TOKEN, or matching runtime setting.",
          }),
    };
  }

  private async list(params: FileListParams = {}): Promise<FileListResult> {
    await this.requireAvailable("fs", "fs.list");
    const sandbox = await this.getSandbox();
    const target = this.mapPath(params.path ?? this.routerConfig.workdir);
    const limit = Math.max(
      1,
      Math.min(params.limit ?? MAX_LIST_LIMIT, MAX_LIST_LIMIT),
    );
    const entries = await sandbox.files.list(target, {
      depth: 1,
      requestTimeoutMs: this.routerConfig.requestTimeoutMs,
    });
    const filtered = filterEntries(entries, params.ignore ?? []);
    const visible =
      params.includeHidden === true
        ? filtered
        : filtered.filter((entry) => !entry.name.startsWith("."));
    const capped = visible.slice(0, limit);
    return {
      root: this.rootObject(target),
      path: target,
      entries: capped.map(toFileStat),
      truncated: visible.length > capped.length,
      totalAfterIgnore: visible.length,
    };
  }

  private async readText(
    params: FileReadTextParams,
  ): Promise<FileReadTextResult> {
    await this.requireAvailable("fs", "fs.readText");
    const sandbox = await this.getSandbox();
    const target = this.mapPath(params.path);
    const text = await sandbox.files.read(target, {
      format: "text",
      requestTimeoutMs: this.routerConfig.requestTimeoutMs,
    });
    const maxBytes = Math.max(0, params.maxBytes ?? MAX_READ_BYTES);
    const bytes = Buffer.byteLength(text, "utf8");
    if (maxBytes > 0 && bytes > maxBytes) {
      const truncated = Buffer.from(text, "utf8")
        .subarray(0, maxBytes)
        .toString("utf8");
      return { path: target, text: truncated, size: bytes, truncated: true };
    }
    return { path: target, text, size: bytes, truncated: false };
  }

  private async writeText(
    params: FileWriteTextParams,
  ): Promise<FileWriteTextResult> {
    await this.requireAvailable("fs", "fs.writeText");
    if (params.overwrite === false) {
      const exists = await this.pathExists(params.path);
      if (exists) {
        throw new CapabilityError({
          code: "CAPABILITY_REQUEST_FAILED",
          capability: "fs",
          method: "fs.writeText",
          message: `Refusing to overwrite existing file: ${params.path}`,
        });
      }
    }
    const sandbox = await this.getSandbox();
    const target = this.mapPath(params.path);
    await sandbox.files.write(target, params.text, {
      requestTimeoutMs: this.routerConfig.requestTimeoutMs,
    });
    return {
      path: target,
      bytesWritten: Buffer.byteLength(params.text, "utf8"),
    };
  }

  private async runCommand(
    params: TerminalRunParams,
  ): Promise<TerminalRunResult> {
    await this.requireAvailable("pty", "pty.command.run");
    const sandbox = await this.getSandbox();
    const command = commandLine(params.command, params.args ?? []);
    const cwd = this.mapPath(params.cwd ?? this.routerConfig.workdir);
    const opts: CommandStartOpts & { background?: false } = {
      cwd,
      timeoutMs: params.timeoutMs ?? this.routerConfig.timeoutMs,
      requestTimeoutMs: params.timeoutMs ?? this.routerConfig.requestTimeoutMs,
      ...(params.env === undefined ? {} : { envs: params.env }),
    };
    try {
      const result = await sandbox.commands.run(command, opts);
      return commandRunResult(result, false);
    } catch (error) {
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      const commandResult = commandResultFromError(normalized);
      if (commandResult) return commandRunResult(commandResult, false);
      if (isTimeoutError(normalized)) {
        return {
          output: normalized.message,
          exitCode: null,
          timedOut: true,
        };
      }
      throw new CapabilityError({
        code: "CAPABILITY_REQUEST_FAILED",
        capability: "pty",
        method: "pty.command.run",
        message: normalized.message,
      });
    }
  }

  private async gitStatus(params: GitStatusParams): Promise<GitStatusResult> {
    const root = this.mapPath(params.root);
    const result = await this.runGit(root, [
      "status",
      "--porcelain=v1",
      "--branch",
    ]);
    const parsed = parseGitStatus(result.output);
    return {
      repo: this.rootObject(root),
      ...(parsed.branch === undefined ? {} : { branch: parsed.branch }),
      ...(parsed.ahead === undefined ? {} : { ahead: parsed.ahead }),
      ...(parsed.behind === undefined ? {} : { behind: parsed.behind }),
      files: parsed.files,
      raw: result.output,
    };
  }

  private async gitDiff(params: GitDiffParams): Promise<GitDiffResult> {
    const args = ["diff"];
    if (params.staged) args.push("--staged");
    if (params.path) args.push("--", params.path);
    const result = await this.runGit(this.mapPath(params.root), args);
    return { raw: result.output };
  }

  private async gitCommandRun(
    params: GitCommandRunParams,
  ): Promise<GitCommandRunResult> {
    const cwd = this.mapPath(params.root);
    const startedAt = new Date().toISOString();
    const id = randomUUID();
    try {
      const result = await this.runGit(cwd, params.args);
      return {
        operation: {
          id,
          name: "git.command.run",
          cwd,
          command: ["git", ...params.args],
          status: result.exitCode === 0 ? "completed" : "failed",
          stdout: result.output,
          stderr: "",
          exitCode: result.exitCode,
          signal: null,
          startedAt,
          completedAt: new Date().toISOString(),
        },
      };
    } catch (error) {
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      return {
        operation: {
          id,
          name: "git.command.run",
          cwd,
          command: ["git", ...params.args],
          status: "failed",
          stdout: "",
          stderr: "",
          exitCode: null,
          signal: null,
          startedAt,
          completedAt: new Date().toISOString(),
          error: normalized.message,
        },
      };
    }
  }

  private async modelStatus(): Promise<LocalModelStatusResult> {
    throw new CapabilityError({
      code: "CAPABILITY_UNAVAILABLE",
      capability: "model",
      method: "model.status",
      message: "E2B Satellite runner does not own local model control.",
    });
  }

  private async runGit(
    root: string,
    args: string[],
  ): Promise<TerminalRunResult> {
    return this.runCommand({
      command: "git",
      args,
      cwd: root,
      timeoutMs: this.routerConfig.timeoutMs,
    });
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      const sandbox = await this.getSandbox();
      await sandbox.files.read(this.mapPath(path), {
        format: "bytes",
        requestTimeoutMs: this.routerConfig.requestTimeoutMs,
      });
      return true;
    } catch (error) {
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      if (
        normalized.name === "FileNotFoundError" ||
        /not found/i.test(normalized.message)
      ) {
        return false;
      }
      throw normalized;
    }
  }

  private async requireAvailable(
    capability: CapabilityName,
    method: string,
  ): Promise<void> {
    const availability = await this.availability();
    if (availability.available) return;
    throw new CapabilityError({
      code: "CAPABILITY_UNAVAILABLE",
      capability,
      method,
      message: availability.reason ?? "E2B Satellite runner is unavailable.",
    });
  }

  private async getSandbox(): Promise<E2BSandboxClient> {
    if (!this.sandboxPromise) {
      this.sandboxPromise = this.factory.create(this.routerConfig);
      this.createdSandbox = !this.routerConfig.sandboxId;
    }
    const sandbox = await this.sandboxPromise;
    if (!this.preparePromise) {
      this.preparePromise = this.prepareSandbox(sandbox);
    }
    await this.preparePromise;
    return sandbox;
  }

  private async prepareSandbox(sandbox: E2BSandboxClient): Promise<void> {
    await sandbox.commands.run(
      `mkdir -p ${shellQuote(this.routerConfig.workdir)}`,
      {
        timeoutMs: this.routerConfig.requestTimeoutMs,
        requestTimeoutMs: this.routerConfig.requestTimeoutMs,
      },
    );
    if (!this.routerConfig.bootstrapGitUrl) return;
    const exists = await sandbox.commands
      .run(
        `test -d ${shellQuote(posixJoin(this.routerConfig.workdir, ".git"))}`,
        {
          timeoutMs: this.routerConfig.requestTimeoutMs,
          requestTimeoutMs: this.routerConfig.requestTimeoutMs,
        },
      )
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      await sandbox.commands.run(
        `git clone ${shellQuote(this.routerConfig.bootstrapGitUrl)} ${shellQuote(this.routerConfig.workdir)}`,
        {
          timeoutMs: this.routerConfig.timeoutMs,
          requestTimeoutMs: this.routerConfig.timeoutMs,
        },
      );
    }
    if (this.routerConfig.bootstrapGitRef) {
      await sandbox.commands.run(
        `git fetch --all --tags && git checkout ${shellQuote(this.routerConfig.bootstrapGitRef)}`,
        {
          cwd: this.routerConfig.workdir,
          timeoutMs: this.routerConfig.timeoutMs,
          requestTimeoutMs: this.routerConfig.timeoutMs,
        },
      );
    }
  }

  private mapPath(input: string): string {
    const trimmed = input.trim();
    if (trimmed.length === 0) return this.routerConfig.workdir;
    if (trimmed.startsWith("e2b://")) {
      const parsed = new URL(trimmed);
      return normalizeSandboxPath(parsed.pathname || this.routerConfig.workdir);
    }
    if (isWithinSandboxPath(trimmed, this.routerConfig.workdir)) {
      return normalizeSandboxPath(trimmed);
    }
    if (!nodePath.isAbsolute(trimmed)) {
      return posixJoin(this.routerConfig.workdir, trimmed);
    }
    const resolved = nodePath.resolve(trimmed);
    if (isWithinHostPath(resolved, this.routerConfig.hostWorkspaceRoot)) {
      const relative = nodePath.relative(
        this.routerConfig.hostWorkspaceRoot,
        resolved,
      );
      return relative
        ? posixJoin(this.routerConfig.workdir, ...relative.split(nodePath.sep))
        : this.routerConfig.workdir;
    }
    throw new CapabilityError({
      code: "CAPABILITY_UNAVAILABLE",
      capability: "fs",
      method: "path.map",
      message: `Path is outside the E2B mapped workspace: ${input}`,
      details: {
        hostWorkspaceRoot: this.routerConfig.hostWorkspaceRoot,
        workdir: this.routerConfig.workdir,
      },
    });
  }

  private rootObject(path: string): JsonObject {
    return {
      id: "e2b",
      provider: "satellite:e2b",
      path,
      hostWorkspaceRoot: this.routerConfig.hostWorkspaceRoot,
      sandboxId: this.routerConfig.sandboxId ?? null,
    };
  }
}

export type E2BRegistrationResult =
  | { registered: true }
  | { registered: false; reason: "disabled" | "already-registered" };

export async function registerE2BSatelliteCapabilityRouterIfEnabled(
  runtime: IAgentRuntime,
): Promise<E2BRegistrationResult> {
  const config = resolveE2BSatelliteRunnerConfig(runtime);
  if (!config.enabled) return { registered: false, reason: "disabled" };
  if (runtime.getService(CAPABILITY_ROUTER_SERVICE_TYPE)) {
    return { registered: false, reason: "already-registered" };
  }
  await runtime.registerService(E2BSatelliteCapabilityRouterService);
  return { registered: true };
}

export function resolveE2BSatelliteRunnerConfig(
  runtime: IAgentRuntime,
): E2BSatelliteRunnerConfig {
  const codingRunner = readSetting(
    runtime,
    "ELIZA_CODING_SATELLITE_RUNNER",
  )?.toLowerCase();
  const runner = readSetting(runtime, "ELIZA_SATELLITE_RUNNER")?.toLowerCase();
  const direct = readSetting(runtime, "ELIZA_E2B_SATELLITE_RUNNER");
  const enabled =
    codingRunner === "e2b" || runner === "e2b" || isTruthy(direct);
  const workdir = normalizeSandboxPath(
    readSetting(runtime, "ELIZA_E2B_WORKDIR") ?? DEFAULT_WORKDIR,
  );
  const agentId = String(runtime.agentId);
  const agentName = runtime.character?.name ?? "eliza";
  return {
    enabled,
    apiKey: readSetting(runtime, "E2B_API_KEY"),
    accessToken: readSetting(runtime, "E2B_ACCESS_TOKEN"),
    domain: readSetting(runtime, "E2B_DOMAIN"),
    sandboxId: readSetting(runtime, "E2B_SANDBOX_ID"),
    template:
      readSetting(runtime, "E2B_TEMPLATE") ??
      readSetting(runtime, "ELIZA_E2B_TEMPLATE"),
    workdir,
    hostWorkspaceRoot: nodePath.resolve(
      readSetting(runtime, "ELIZA_E2B_HOST_WORKSPACE_ROOT") ?? process.cwd(),
    ),
    timeoutMs: positiveIntSetting(
      runtime,
      "ELIZA_E2B_TIMEOUT_MS",
      DEFAULT_TIMEOUT_MS,
    ),
    requestTimeoutMs: positiveIntSetting(
      runtime,
      "ELIZA_E2B_REQUEST_TIMEOUT_MS",
      DEFAULT_REQUEST_TIMEOUT_MS,
    ),
    keepAlive: isTruthy(readSetting(runtime, "ELIZA_E2B_KEEP_ALIVE")),
    allowInternetAccess: !isFalsey(
      readSetting(runtime, "ELIZA_E2B_ALLOW_INTERNET"),
    ),
    bootstrapGitUrl: readSetting(runtime, "ELIZA_E2B_BOOTSTRAP_GIT_URL"),
    bootstrapGitRef: readSetting(runtime, "ELIZA_E2B_BOOTSTRAP_GIT_REF"),
    envs: {
      ELIZA_AGENT_ID: agentId,
      ELIZA_AGENT_NAME: agentName,
    },
    metadata: {
      app: "elizaos",
      provider: "satellite:e2b",
      agentId,
      agentName,
    },
  };
}

function createOptions(config: E2BSatelliteRunnerConfig): SandboxOpts {
  return {
    apiKey: config.apiKey,
    accessToken: config.accessToken,
    domain: config.domain,
    envs: config.envs,
    metadata: config.metadata,
    timeoutMs: config.timeoutMs,
    requestTimeoutMs: config.requestTimeoutMs,
    allowInternetAccess: config.allowInternetAccess,
    secure: true,
  };
}

function connectOptions(config: E2BSatelliteRunnerConfig): SandboxConnectOpts {
  return {
    apiKey: config.apiKey,
    accessToken: config.accessToken,
    domain: config.domain,
    timeoutMs: config.timeoutMs,
    requestTimeoutMs: config.requestTimeoutMs,
  };
}

function hasE2BCredentials(config: E2BSatelliteRunnerConfig): boolean {
  return Boolean(config.apiKey || config.accessToken);
}

function readSetting(runtime: IAgentRuntime, key: string): string | undefined {
  const fromRuntime = runtime.getSetting(key);
  if (typeof fromRuntime === "string" && fromRuntime.trim().length > 0) {
    return fromRuntime.trim();
  }
  const fromEnv = process.env[key];
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  return undefined;
}

function positiveIntSetting(
  runtime: IAgentRuntime,
  key: string,
  fallback: number,
): number {
  const value = readSetting(runtime, key);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  throw new Error(`${key} must be a positive integer.`);
}

function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function isFalsey(value: string | undefined): boolean {
  if (!value) return false;
  return ["0", "false", "no", "off"].includes(value.toLowerCase());
}

function commandLine(command: string, args: string[]): string {
  if (args.length === 0) return command;
  return [command, ...args.map(shellQuote)].join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function commandRunResult(
  result: CommandResult,
  timedOut: boolean,
): TerminalRunResult {
  const stderr = result.stderr.length > 0 ? `\n${result.stderr}` : "";
  return {
    output: `${result.stdout}${stderr}`,
    exitCode: result.exitCode,
    timedOut,
  };
}

function commandResultFromError(error: Error): CommandResult | null {
  const candidate = error as Partial<CommandResult>;
  if (
    typeof candidate.exitCode === "number" &&
    typeof candidate.stdout === "string" &&
    typeof candidate.stderr === "string"
  ) {
    return {
      exitCode: candidate.exitCode,
      stdout: candidate.stdout,
      stderr: candidate.stderr,
      ...(typeof candidate.error === "string"
        ? { error: candidate.error }
        : {}),
    };
  }
  return null;
}

function isTimeoutError(error: Error): boolean {
  return (
    error.name === "TimeoutError" || /timed? out|timeout/i.test(error.message)
  );
}

function normalizeSandboxPath(input: string): string {
  const normalized = nodePath.posix.normalize(input.replace(/\\/g, "/"));
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function posixJoin(...parts: string[]): string {
  return nodePath.posix.normalize(nodePath.posix.join(...parts));
}

function isWithinSandboxPath(candidate: string, root: string): boolean {
  if (!candidate.startsWith("/")) return false;
  const normalized = normalizeSandboxPath(candidate);
  const normalizedRoot = normalizeSandboxPath(root);
  const relative = nodePath.posix.relative(normalizedRoot, normalized);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !nodePath.posix.isAbsolute(relative))
  );
}

function isWithinHostPath(candidate: string, root: string): boolean {
  const relative = nodePath.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !nodePath.isAbsolute(relative))
  );
}

function filterEntries(entries: EntryInfo[], ignore: string[]): EntryInfo[] {
  if (ignore.length === 0) return entries;
  const matchers = ignore.map(globToRegExp);
  return entries.filter(
    (entry) =>
      !matchers.some(
        (matcher) => matcher.test(entry.name) || matcher.test(entry.path),
      ),
  );
}

function globToRegExp(pattern: string): RegExp {
  let regex = "";
  let index = 0;
  while (index < pattern.length) {
    const ch = pattern[index];
    if (ch === "*") {
      if (pattern[index + 1] === "*") {
        regex += ".*";
        index += 2;
      } else {
        regex += "[^/]*";
        index += 1;
      }
    } else if (ch === "?") {
      regex += "[^/]";
      index += 1;
    } else if (".+^$()|[]{}\\".includes(ch ?? "")) {
      regex += `\\${ch}`;
      index += 1;
    } else {
      regex += ch;
      index += 1;
    }
  }
  return new RegExp(`^${regex}$`);
}

function toFileStat(entry: EntryInfo): FileStat {
  const kind = entry.symlinkTarget
    ? "symlink"
    : entry.type === "dir"
      ? "directory"
      : entry.type === "file"
        ? "file"
        : "other";
  return {
    path: entry.path,
    name: entry.name,
    kind,
    size: entry.size,
    ...(entry.modifiedTime
      ? { modifiedAt: entry.modifiedTime.toISOString() }
      : {}),
  };
}

function parseGitStatus(raw: string): {
  branch?: string;
  ahead?: number;
  behind?: number;
  files: JsonObject[];
} {
  const lines = raw.split("\n").filter((line) => line.length > 0);
  let branch: string | undefined;
  let ahead: number | undefined;
  let behind: number | undefined;
  const files: JsonObject[] = [];
  for (const line of lines) {
    if (line.startsWith("## ")) {
      const parsed = parseBranchLine(line.slice(3));
      branch = parsed.branch;
      ahead = parsed.ahead;
      behind = parsed.behind;
      continue;
    }
    files.push({
      status: line.slice(0, 2),
      path: line.slice(3),
    });
  }
  return { branch, ahead, behind, files };
}

function parseBranchLine(line: string): {
  branch?: string;
  ahead?: number;
  behind?: number;
} {
  const [branchPart, metaPart] = line.split("...");
  const branch = branchPart === "HEAD (no branch)" ? undefined : branchPart;
  if (!metaPart) return { branch };
  const aheadMatch = metaPart.match(/ahead (\d+)/);
  const behindMatch = metaPart.match(/behind (\d+)/);
  return {
    branch,
    ...(aheadMatch ? { ahead: Number(aheadMatch[1]) } : {}),
    ...(behindMatch ? { behind: Number(behindMatch[1]) } : {}),
  };
}

import type { ChildProcessByStdio } from "node:child_process";
import { spawn as spawnNodeProcess } from "node:child_process";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import nodePath from "node:path";
import type { Readable } from "node:stream";

type JsonPrimitive = boolean | number | string | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonRecord = { [key: string]: JsonValue };
type LogLevel = "debug" | "info" | "warn" | "error";

export type RunnerConfig = {
  hostname: string;
  port: number;
  workspaceRoot: string;
  containerWorkspaceRoot: string;
  token: string | null;
  allowUnauthenticated: boolean;
  maxReadBytes: number;
  commandTimeoutMs: number;
  maxCommandOutputBytes: number;
};

export type CommandPayload = {
  command: string;
  args: string[];
  cwd: string;
  envs: Record<string, string>;
  timeoutMs: number;
};

export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
};
export type CodingRemoteRunnerCommandRunner = (
  payload: CommandPayload,
  config: RunnerConfig,
) => Promise<CommandResult>;
type RunnerContext = {
  config: RunnerConfig;
  commandRunner: CodingRemoteRunnerCommandRunner;
};
type CodingRemoteRunnerRouteHandler = (
  request: Request,
  url: URL,
  context: RunnerContext,
) => Promise<Response> | Response;
type BunSpawnedProcess = {
  exited: Promise<number>;
  kill(signal?: string): void;
  stderr: ReadableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
};
type BunRuntime = {
  spawn(
    command: string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      stderr: "pipe";
      stdin: "ignore";
      stdout: "pipe";
    },
  ): BunSpawnedProcess;
};

const DEFAULT_PORT = 3000;
const DEFAULT_WORKSPACE_ROOT = "/workspace";
const DEFAULT_MAX_READ_BYTES = 5 * 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const workspaceRoot =
    readEnv(env, "ELIZA_CODING_WORKSPACE") ??
    readEnv(env, "ELIZA_SANDBOX_WORKDIR") ??
    readEnv(env, "WORKSPACE_DIR") ??
    DEFAULT_WORKSPACE_ROOT;
  return {
    hostname: readEnv(env, "HOST") ?? "0.0.0.0",
    port: readPositiveInt(env, "PORT", DEFAULT_PORT),
    workspaceRoot: nodePath.resolve(workspaceRoot),
    containerWorkspaceRoot: normalizeContainerPath(
      readEnv(env, "ELIZA_CODING_CONTAINER_WORKSPACE") ??
        DEFAULT_WORKSPACE_ROOT,
    ),
    token:
      readEnv(env, "ELIZA_REMOTE_RUNNER_HTTP_TOKEN") ??
      readEnv(env, "REMOTE_RUNNER_HTTP_TOKEN") ??
      null,
    allowUnauthenticated:
      readEnv(env, "ELIZA_REMOTE_RUNNER_ALLOW_UNAUTHENTICATED") === "1",
    maxReadBytes: readPositiveInt(
      env,
      "ELIZA_REMOTE_RUNNER_MAX_READ_BYTES",
      DEFAULT_MAX_READ_BYTES,
    ),
    commandTimeoutMs: readPositiveInt(
      env,
      "ELIZA_REMOTE_RUNNER_COMMAND_TIMEOUT_MS",
      DEFAULT_COMMAND_TIMEOUT_MS,
    ),
    maxCommandOutputBytes: readPositiveInt(
      env,
      "ELIZA_REMOTE_RUNNER_MAX_COMMAND_OUTPUT_BYTES",
      DEFAULT_MAX_COMMAND_OUTPUT_BYTES,
    ),
  };
}

export async function ensureWorkspace(config: RunnerConfig): Promise<void> {
  await mkdir(config.workspaceRoot, { recursive: true });
}

export function createHandler(
  config: RunnerConfig,
  options: { commandRunner?: CodingRemoteRunnerCommandRunner } = {},
): (request: Request) => Promise<Response> {
  const context: RunnerContext = {
    config,
    commandRunner: options.commandRunner ?? runCommand,
  };
  return async (request) => {
    const url = new URL(request.url);
    try {
      return await routeRequest(request, url, context);
    } catch (error) {
      return errorResponse(error, url);
    }
  };
}

const PRIVATE_ROUTE_HANDLERS: Record<string, CodingRemoteRunnerRouteHandler> = {
  "GET /v1/health": (_request, _url, context) =>
    privateHealthResponse(context.config),
  "GET /v1/fs/entries": (_request, url, context) =>
    listEntries(url, context.config),
  "GET /v1/fs/file": (_request, url, context) =>
    readFileResponse(url, context.config),
  "PUT /v1/fs/file": (request, url, context) =>
    writeFileResponse(request, url, context.config),
  "POST /v1/processes/run": (request, _url, context) =>
    runProcessResponse(request, context),
};

async function routeRequest(
  request: Request,
  url: URL,
  context: RunnerContext,
): Promise<Response> {
  if (request.method === "GET" && url.pathname === "/health") {
    return publicHealthResponse(context.config);
  }

  const authError = authorize(request, context.config);
  if (authError) return authError;

  const handler = PRIVATE_ROUTE_HANDLERS[`${request.method} ${url.pathname}`];
  return handler
    ? await handler(request, url, context)
    : jsonResponse(404, { error: "not found" });
}

function publicHealthResponse(config: RunnerConfig): Response {
  return jsonResponse(200, {
    ok: true,
    workspaceRoot: config.workspaceRoot,
    containerWorkspaceRoot: config.containerWorkspaceRoot,
    authConfigured: Boolean(config.token),
  });
}

function privateHealthResponse(config: RunnerConfig): Response {
  return jsonResponse(200, {
    ok: true,
    id: "eliza.coding-remote-runner",
    workspaceRoot: config.workspaceRoot,
    containerWorkspaceRoot: config.containerWorkspaceRoot,
    capabilities: ["fs.list", "fs.read", "fs.write", "process.run"],
  });
}

function errorResponse(error: unknown, url: URL): Response {
  const status = error instanceof HttpError ? error.status : 500;
  const message = error instanceof Error ? error.message : String(error);
  if (status >= 500) {
    log("error", "[CodingRemoteRunner] request failed", {
      path: url.pathname,
      status,
      error: message,
    });
  }
  return jsonResponse(status, { error: message });
}

async function listEntries(url: URL, config: RunnerConfig): Promise<Response> {
  const resolved = await resolveExistingPath(
    config,
    url.searchParams.get("path"),
  );
  const entries = await readdir(resolved.fsPath, { withFileTypes: true });
  const payload = await Promise.all(
    entries.map(async (entry) => {
      const fsPath = nodePath.join(resolved.fsPath, entry.name);
      const info = await lstat(fsPath);
      return {
        path: nodePath.join(resolved.containerPath, entry.name),
        name: entry.name,
        type: entry.isDirectory()
          ? "dir"
          : entry.isFile()
            ? "file"
            : entry.isSymbolicLink()
              ? "symlink"
              : "other",
        size: info.size,
        mode: info.mode,
        modifiedAt: info.mtime.toISOString(),
      };
    }),
  );
  return jsonResponse(200, { entries: payload });
}

async function readFileResponse(
  url: URL,
  config: RunnerConfig,
): Promise<Response> {
  const resolved = await resolveExistingPath(
    config,
    requiredQuery(url, "path"),
  );
  const info = await stat(resolved.fsPath);
  if (!info.isFile()) throw new HttpError(400, "Path is not a file");
  if (info.size > config.maxReadBytes) {
    throw new HttpError(413, "File exceeds max read size");
  }
  const bytes = await readFile(resolved.fsPath);
  return new Response(bytes, {
    status: 200,
    headers: { "content-type": "application/octet-stream" },
  });
}

async function writeFileResponse(
  request: Request,
  url: URL,
  config: RunnerConfig,
): Promise<Response> {
  const resolved = await resolveWritablePath(
    config,
    requiredQuery(url, "path"),
  );
  const text = await request.text();
  await mkdir(nodePath.dirname(resolved.fsPath), { recursive: true });
  await writeFile(resolved.fsPath, text, "utf8");
  return jsonResponse(200, {
    path: resolved.containerPath,
    name: nodePath.basename(resolved.containerPath),
    bytesWritten: Buffer.byteLength(text, "utf8"),
  });
}

async function runProcessResponse(
  request: Request,
  context: RunnerContext,
): Promise<Response> {
  const body = await readJsonBody(request);
  const payload = await parseCommandPayload(body, context.config);
  const result = await context.commandRunner(payload, context.config);
  return jsonResponse(200, {
    ...result,
    output: `${result.stdout}${result.stderr}`,
  });
}

async function parseCommandPayload(
  body: JsonRecord,
  config: RunnerConfig,
): Promise<CommandPayload> {
  const command = stringField(body, "command");
  if (!command) throw new HttpError(400, "command is required");
  const args = stringArrayField(body, "args");
  const cwdValue = stringField(body, "cwd") ?? config.containerWorkspaceRoot;
  const cwd = (await resolveExistingPath(config, cwdValue)).fsPath;
  const envs =
    recordOfStringsField(body, "env") ??
    recordOfStringsField(body, "envs") ??
    {};
  const timeoutMs =
    positiveNumberField(body, "timeoutMs") ?? config.commandTimeoutMs;
  return { command, args, cwd, envs, timeoutMs };
}

async function runCommand(
  payload: CommandPayload,
  config: RunnerConfig,
): Promise<CommandResult> {
  const bun = getBunRuntime();
  return bun
    ? await runCommandWithBun(payload, config, bun)
    : await runCommandWithNode(payload, config);
}

function getBunRuntime(): BunRuntime | null {
  const runtime = (globalThis as typeof globalThis & { Bun?: BunRuntime }).Bun;
  return typeof runtime?.spawn === "function" ? runtime : null;
}

async function runCommandWithBun(
  payload: CommandPayload,
  config: RunnerConfig,
  bun: BunRuntime,
): Promise<CommandResult> {
  const child = bun.spawn([payload.command, ...payload.args], {
    cwd: payload.cwd,
    env: { ...process.env, ...payload.envs },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new BoundedOutput(config.maxCommandOutputBytes);
  const stderr = new BoundedOutput(config.maxCommandOutputBytes);
  let timedOut = false;

  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, payload.timeoutMs);

  try {
    const [exitCode] = await Promise.all([
      child.exited,
      collectOutput(child.stdout, stdout),
      collectOutput(child.stderr, stderr),
    ]);
    return {
      stdout: stdout.toString(),
      stderr: stderr.toString(),
      exitCode: timedOut ? 124 : exitCode,
      timedOut,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function runCommandWithNode(
  payload: CommandPayload,
  config: RunnerConfig,
): Promise<CommandResult> {
  const child = spawnNodeProcess(payload.command, payload.args, {
    cwd: payload.cwd,
    env: { ...process.env, ...payload.envs },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = new BoundedOutput(config.maxCommandOutputBytes);
  const stderr = new BoundedOutput(config.maxCommandOutputBytes);
  let timedOut = false;

  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, payload.timeoutMs);

  try {
    const exitCode = await waitForNodeChild(child, stdout, stderr);
    return {
      stdout: stdout.toString(),
      stderr: stderr.toString(),
      exitCode: timedOut ? 124 : exitCode,
      timedOut,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function collectOutput(
  stream: ReadableStream<Uint8Array>,
  output: BoundedOutput,
): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      const read = await reader.read();
      if (read.done) return;
      output.append(read.value);
    }
  } finally {
    reader.releaseLock();
  }
}

function waitForNodeChild(
  child: ChildProcessByStdio<null, Readable, Readable>,
  stdout: BoundedOutput,
  stderr: BoundedOutput,
): Promise<number> {
  return new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => stdout.append(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

class BoundedOutput {
  private chunks: Buffer[] = [];
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  append(chunk: Uint8Array): void {
    const buffer = Buffer.from(chunk);
    this.chunks.push(buffer);
    this.bytes += buffer.byteLength;
    while (this.bytes > this.maxBytes && this.chunks.length > 0) {
      const removed = this.chunks.shift();
      this.bytes -= removed?.byteLength ?? 0;
    }
  }

  toString(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

async function readJsonBody(request: Request): Promise<JsonRecord> {
  const parsed = (await request.json().catch(() => null)) as JsonValue | null;
  if (!isRecord(parsed)) throw new HttpError(400, "Expected JSON object body");
  return parsed;
}

async function resolveExistingPath(
  config: RunnerConfig,
  rawPath: string | null,
): Promise<{ fsPath: string; containerPath: string }> {
  const resolved = resolveCandidatePath(
    config,
    rawPath ?? config.containerWorkspaceRoot,
  );
  const real = await realpath(resolved.fsPath).catch(() => {
    throw new HttpError(404, "Path not found");
  });
  const root = await realpath(config.workspaceRoot);
  ensureInsideRoot(root, real);
  return { fsPath: real, containerPath: resolved.containerPath };
}

async function resolveWritablePath(
  config: RunnerConfig,
  rawPath: string,
): Promise<{ fsPath: string; containerPath: string }> {
  const resolved = resolveCandidatePath(config, rawPath);
  const root = await realpath(config.workspaceRoot);
  const parent = nodePath.dirname(resolved.fsPath);
  await mkdir(parent, { recursive: true });
  const parentReal = await realpath(parent);
  ensureInsideRoot(root, parentReal);
  const target = nodePath.join(parentReal, nodePath.basename(resolved.fsPath));
  const existing = await lstat(target).catch(() => null);
  if (existing?.isSymbolicLink()) throw new HttpError(403, "Path is a symlink");
  return {
    fsPath: target,
    containerPath: resolved.containerPath,
  };
}

function resolveCandidatePath(
  config: RunnerConfig,
  rawPath: string,
): { fsPath: string; containerPath: string } {
  if (rawPath.includes("\0")) throw new HttpError(400, "Invalid path");
  const normalizedRaw = rawPath.trim() || config.containerWorkspaceRoot;
  if (normalizedRaw.startsWith("/")) {
    const containerPath = normalizeContainerPath(normalizedRaw);
    const relative = relativeContainerPath(
      config.containerWorkspaceRoot,
      containerPath,
    );
    if (relative !== null) {
      return {
        fsPath: relative
          ? nodePath.resolve(config.workspaceRoot, ...relative.split("/"))
          : nodePath.resolve(config.workspaceRoot),
        containerPath,
      };
    }
    const fsPath = nodePath.resolve(normalizedRaw);
    return { fsPath, containerPath: normalizeContainerPath(fsPath) };
  }
  const fsPath = nodePath.resolve(config.workspaceRoot, normalizedRaw);
  return {
    fsPath,
    containerPath: normalizeContainerPath(
      nodePath.posix.join(
        config.containerWorkspaceRoot,
        normalizedRaw.replace(/\\/g, "/"),
      ),
    ),
  };
}

function normalizeContainerPath(value: string): string {
  const normalized = nodePath.posix.normalize(value.replace(/\\/g, "/"));
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function relativeContainerPath(root: string, candidate: string): string | null {
  const normalizedRoot = normalizeContainerPath(root);
  const normalizedCandidate = normalizeContainerPath(candidate);
  if (normalizedCandidate === normalizedRoot) return "";
  if (!normalizedCandidate.startsWith(`${normalizedRoot}/`)) return null;
  return normalizedCandidate.slice(normalizedRoot.length + 1);
}

function ensureInsideRoot(root: string, candidate: string): void {
  if (candidate === root) return;
  if (candidate.startsWith(`${root}${nodePath.sep}`)) return;
  throw new HttpError(403, "Path is outside the workspace");
}

function authorize(request: Request, config: RunnerConfig): Response | null {
  if (!config.token) {
    return config.allowUnauthenticated
      ? null
      : jsonResponse(503, { error: "Remote runner token is not configured" });
  }
  const expected = `Bearer ${config.token}`;
  if (request.headers.get("authorization") === expected) return null;
  return jsonResponse(401, { error: "Unauthorized" });
}

function requiredQuery(url: URL, key: string): string {
  const value = url.searchParams.get(key);
  if (!value?.trim()) throw new HttpError(400, `${key} is required`);
  return value;
}

function stringField(record: JsonRecord, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArrayField(record: JsonRecord, key: string): string[] {
  const value = record[key];
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new HttpError(400, `${key} must be an array`);
  return value.map((item) => {
    if (typeof item !== "string") {
      throw new HttpError(400, `${key} entries must be strings`);
    }
    return item;
  });
}

function recordOfStringsField(
  record: JsonRecord,
  key: string,
): Record<string, string> | null {
  const value = record[key];
  if (value === undefined) return null;
  if (!isRecord(value)) throw new HttpError(400, `${key} must be an object`);
  const out: Record<string, string> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (typeof entryValue !== "string") {
      throw new HttpError(400, `${key}.${entryKey} must be a string`);
    }
    out[entryKey] = entryValue;
  }
  return out;
}

function positiveNumberField(record: JsonRecord, key: string): number | null {
  const value = record[key];
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new HttpError(400, `${key} must be a positive number`);
  }
  return value;
}

function isRecord(value: JsonValue | null): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readEnv(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readPositiveInt(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const value = readEnv(env, key);
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function jsonResponse(status: number, payload: JsonRecord): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function log(level: LogLevel, message: string, meta: JsonRecord = {}): void {
  const line = `${JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...meta,
  })}\n`;
  const stream =
    level === "error" || level === "warn" ? process.stderr : process.stdout;
  stream.write(line);
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

if (import.meta.main) {
  const config = loadConfig();
  await ensureWorkspace(config);
  Bun.serve({
    hostname: config.hostname,
    port: config.port,
    fetch: createHandler(config),
  });
  log("info", "[CodingRemoteRunner] listening", {
    hostname: config.hostname,
    port: config.port,
    workspaceRoot: config.workspaceRoot,
    authConfigured: Boolean(config.token),
  });
}

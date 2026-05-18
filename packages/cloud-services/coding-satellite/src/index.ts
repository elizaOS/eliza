import type { ChildProcessByStdio } from "node:child_process";
import { spawn } from "node:child_process";
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

type RunnerConfig = {
  hostname: string;
  port: number;
  workspaceRoot: string;
  token: string | null;
  allowUnauthenticated: boolean;
  maxReadBytes: number;
  commandTimeoutMs: number;
  maxCommandOutputBytes: number;
};

type CommandPayload = {
  command: string;
  args: string[];
  cwd: string;
  envs: Record<string, string>;
  timeoutMs: number;
};

type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
};
type CommandChildProcess = ChildProcessByStdio<null, Readable, Readable>;

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
    token:
      readEnv(env, "ELIZA_SATELLITE_HTTP_TOKEN") ??
      readEnv(env, "SATELLITE_HTTP_TOKEN") ??
      null,
    allowUnauthenticated:
      readEnv(env, "ELIZA_SATELLITE_ALLOW_UNAUTHENTICATED") === "1",
    maxReadBytes: readPositiveInt(
      env,
      "ELIZA_SATELLITE_MAX_READ_BYTES",
      DEFAULT_MAX_READ_BYTES,
    ),
    commandTimeoutMs: readPositiveInt(
      env,
      "ELIZA_SATELLITE_COMMAND_TIMEOUT_MS",
      DEFAULT_COMMAND_TIMEOUT_MS,
    ),
    maxCommandOutputBytes: readPositiveInt(
      env,
      "ELIZA_SATELLITE_MAX_COMMAND_OUTPUT_BYTES",
      DEFAULT_MAX_COMMAND_OUTPUT_BYTES,
    ),
  };
}

export async function ensureWorkspace(config: RunnerConfig): Promise<void> {
  await mkdir(config.workspaceRoot, { recursive: true });
}

export function createHandler(
  config: RunnerConfig,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    try {
      return await routeRequest(request, url, config);
    } catch (error) {
      return errorResponse(error, url);
    }
  };
}

async function routeRequest(
  request: Request,
  url: URL,
  config: RunnerConfig,
): Promise<Response> {
  if (request.method === "GET" && url.pathname === "/health") {
    return publicHealthResponse(config);
  }

  const authError = authorize(request, config);
  if (authError) return authError;

  if (request.method === "GET" && url.pathname === "/v1/health") {
    return privateHealthResponse(config);
  }
  if (request.method === "GET" && url.pathname === "/v1/fs/entries") {
    return await listEntries(url, config);
  }
  if (request.method === "GET" && url.pathname === "/v1/fs/file") {
    return await readFileResponse(url, config);
  }
  if (request.method === "PUT" && url.pathname === "/v1/fs/file") {
    return await writeFileResponse(request, url, config);
  }
  if (request.method === "POST" && url.pathname === "/v1/processes/run") {
    return await runProcessResponse(request, config);
  }
  return jsonResponse(404, { error: "not found" });
}

function publicHealthResponse(config: RunnerConfig): Response {
  return jsonResponse(200, {
    ok: true,
    workspaceRoot: config.workspaceRoot,
    authConfigured: Boolean(config.token),
  });
}

function privateHealthResponse(config: RunnerConfig): Response {
  return jsonResponse(200, {
    ok: true,
    id: "eliza.coding-satellite",
    workspaceRoot: config.workspaceRoot,
    capabilities: ["fs.list", "fs.read", "fs.write", "process.run"],
  });
}

function errorResponse(error: unknown, url: URL): Response {
  const status = error instanceof HttpError ? error.status : 500;
  const message = error instanceof Error ? error.message : String(error);
  if (status >= 500) {
    log("error", "[CodingSatellite] request failed", {
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
  config: RunnerConfig,
): Promise<Response> {
  const body = await readJsonBody(request);
  const payload = await parseCommandPayload(body, config);
  const result = await runCommand(payload, config);
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
  const cwdValue = stringField(body, "cwd") ?? config.workspaceRoot;
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
  const child = spawn(payload.command, payload.args, {
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
    const result = await waitForChild(child, stdout, stderr);
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: timedOut ? 124 : result.exitCode,
      timedOut,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function waitForChild(
  child: CommandChildProcess,
  stdout: BoundedOutput,
  stderr: BoundedOutput,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => stdout.append(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        exitCode: code ?? 1,
      });
    });
  });
}

class BoundedOutput {
  private chunks: Buffer[] = [];
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  append(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.bytes += chunk.byteLength;
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
    rawPath ?? config.workspaceRoot,
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
  const fsPath = rawPath.startsWith("/")
    ? nodePath.resolve(rawPath)
    : nodePath.resolve(config.workspaceRoot, rawPath);
  const containerPath = fsPath;
  return { fsPath, containerPath };
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
      : jsonResponse(503, { error: "Satellite token is not configured" });
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
  log("info", "[CodingSatellite] listening", {
    hostname: config.hostname,
    port: config.port,
    workspaceRoot: config.workspaceRoot,
    authConfigured: Boolean(config.token),
  });
}

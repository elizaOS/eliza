/**
 * Native ACP client: speaks the Agent Client Protocol as JSON-RPC over a
 * spawned agent subprocess's stdio — the default transport for `AcpService`
 * (the alternative is the legacy `acpx` CLI wrapper). Owns the child-process
 * lifecycle, the `initialize` / `session/new` / `session/prompt` handshake, MCP
 * server forwarding so a sub-agent inherits the parent's tools, and permission
 * prompts resolved against the session's approval preset.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AcpJsonRpcMessage, ApprovalPreset } from "./types.js";

export type NativeAcpEventCallback = (
  event: AcpJsonRpcMessage,
  sessionId?: string,
) => void;

/**
 * An MCP server entry for ACP `session/new.mcpServers`, so a spawned sub-agent
 * inherits the parent's MCP tools (Codex / Claude-Code parity). Either a stdio
 * server (`command` + `args`) or an HTTP server (`type: "http"` + `url`).
 */
export type AcpMcpServerConfig =
  | {
      name: string;
      command: string;
      args?: string[];
      env?: Array<{ name: string; value: string }>;
    }
  | {
      name: string;
      type: "http";
      url: string;
      headers?: Array<{ name: string; value: string }>;
    };

export type NativeAcpClientOptions = {
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  approvalPreset: ApprovalPreset;
  terminal?: boolean;
  timeoutMs?: number;
  onEvent?: NativeAcpEventCallback;
  onStderr?: (chunk: string) => void;
  /**
   * MCP servers to expose to the spawned sub-agent. Defaults to the opt-in
   * `ELIZA_ACP_MCP_SERVERS` env var (see `parseAcpMcpServersEnv`); when unset,
   * sub-agents start with no MCP servers (the prior behavior).
   */
  mcpServers?: AcpMcpServerConfig[];
};

/**
 * Parse the opt-in `ELIZA_ACP_MCP_SERVERS` env var — a JSON array of
 * `AcpMcpServerConfig` — into the list forwarded to ACP `session/new`. This
 * closes the parity gap where sub-agents couldn't use the parent's MCP tools.
 *
 * Defaults to `[]` so the common path is unchanged and a malformed value can
 * never break sub-agent spawning: anything that isn't a well-formed array of
 * `{name, command}` / `{name, type:"http", url}` entries is dropped.
 */
export function parseAcpMcpServersEnv(
  raw: string | undefined = process.env.ELIZA_ACP_MCP_SERVERS,
): AcpMcpServerConfig[] {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((s): s is AcpMcpServerConfig => {
    if (!s || typeof s !== "object") return false;
    const r = s as Record<string, unknown>;
    if (typeof r.name !== "string" || !r.name) return false;
    if (r.type === "http") return typeof r.url === "string" && r.url.length > 0;
    return typeof r.command === "string" && r.command.length > 0;
  });
}

export type NativeAcpSession = {
  sessionId: string;
  agentSessionId?: string;
};

export type NativeAcpPromptResult = {
  stopReason: string;
};

type JsonRpcId = string | number | null;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
};

type TerminalRecord = {
  proc: ChildProcessWithoutNullStreams;
  output: string;
  truncated: boolean;
  limit: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  exitPromise: Promise<void>;
  killTimer?: ReturnType<typeof setTimeout>;
};

const ACP_PROTOCOL_VERSION = 1;
// Default ACP request timeout. 30 s was too short for real coding-sub-agent
// work — a single `session/prompt` round-trip for non-trivial tasks (PDF
// generation, multi-file refactors, dependency install + run) routinely
// took 60-200 s in live trajectories on 2026-05-25, blowing the 30 s
// budget. The framework then aborted via the timeout, the planner retried
// the spawn, and the orchestrator accumulated 44 sub-agent trajectories
// for one user prompt while leaving 20+ orphaned opencode processes.
// 300 s (5 min) is the conservative new default that covers the observed
// completion-time distribution (max ~14 s on `task_complete`, ~270 s tail
// on what would otherwise have been timeouts) without letting genuinely
// hung sessions linger forever. Deployments that want faster fail-fast or
// longer waits can override via `ACPX_DEFAULT_TIMEOUT_MS` or
// `ELIZA_ACP_PROMPT_TIMEOUT_MS` env vars.
const DEFAULT_TIMEOUT_MS = 300_000;
const TERMINAL_OUTPUT_LIMIT = 512 * 1024;
const AGENT_CLOSE_TERM_GRACE_MS = 1_500;
const TERMINAL_KILL_GRACE_MS = 1_500;
const TERMINAL_CLOSE_TIMEOUT_MS = 3_500;
const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INVALID_PARAMS = -32602;
const JSONRPC_INTERNAL_ERROR = -32603;
const JSONRPC_PERMISSION_DENIED = -32071;

export class NativeAcpClient {
  private proc?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readBuffer = "";
  private stderrBuffer = "";
  private pending = new Map<JsonRpcId, PendingRequest>();
  private terminals = new Map<string, TerminalRecord>();
  private closed = false;

  constructor(private readonly opts: NativeAcpClientOptions) {}

  setEventHandler(handler: NativeAcpEventCallback | undefined): void {
    this.opts.onEvent = handler;
  }

  setTimeoutMs(timeoutMs: number | undefined): void {
    this.opts.timeoutMs = timeoutMs;
  }

  async start(): Promise<void> {
    if (this.proc) return;
    const { command, args } = splitCommandLine(this.opts.command);
    const proc = spawn(command, args, {
      cwd: this.opts.cwd,
      env: this.opts.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;

    proc.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk));
    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      this.stderrBuffer = `${this.stderrBuffer}${text}`.slice(-16_384);
      // Observer callback — a consumer throw here must not surface as a stream
      // 'error' event that tears down stderr for the whole agent.
      try {
        this.opts.onStderr?.(text);
      } catch {
        // best-effort observability; swallow
      }
    });
    proc.on("error", (err) => this.rejectAll(err));
    proc.on("close", (code, signal) => {
      this.closed = true;
      const stderr = this.stderrBuffer.trim();
      this.rejectAll(
        new Error(
          `ACP agent exited with code ${code ?? "unknown"}${signal ? ` signal ${signal}` : ""}${stderr ? `: ${stderr}` : ""}`,
        ),
      );
    });

    await this.request(
      "initialize",
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: this.opts.terminal !== false,
        },
        clientInfo: {
          name: "@elizaos/plugin-agent-orchestrator",
          version: "2.0.0",
        },
      },
      // The first opencode spawn compiles its TS tree and installs the provider
      // npm package (e.g. @ai-sdk/cerebras), which can exceed the 300s default.
      // Honor the configured session timeout for the handshake too.
      this.opts.timeoutMs && this.opts.timeoutMs > 0
        ? this.opts.timeoutMs
        : DEFAULT_TIMEOUT_MS,
    );
  }

  async createSession(cwd = this.opts.cwd): Promise<NativeAcpSession> {
    const result = asRecord(
      await this.request("session/new", {
        cwd,
        // Forward the parent's MCP servers so the sub-agent has the same tools
        // (Codex / Claude-Code parity). Opt-in via ELIZA_ACP_MCP_SERVERS;
        // defaults to [] (prior behavior) so spawning never regresses.
        mcpServers: this.opts.mcpServers ?? parseAcpMcpServersEnv(),
      }),
    );
    const sessionId = stringValue(result?.sessionId);
    if (!sessionId) throw new Error("ACP agent did not return a sessionId");
    return {
      sessionId,
      agentSessionId: extractAgentSessionId(result?._meta),
    };
  }

  async prompt(
    sessionId: string,
    text: string,
  ): Promise<NativeAcpPromptResult> {
    const result = asRecord(
      await this.request(
        "session/prompt",
        {
          sessionId,
          prompt: [{ type: "text", text }],
        },
        this.opts.timeoutMs,
        () => {
          void this.cancel(sessionId).catch(() => undefined);
        },
      ),
    );
    return {
      stopReason: stringValue(result?.stopReason) ?? "end_turn",
    };
  }

  async cancel(sessionId: string): Promise<void> {
    await this.request("session/cancel", { sessionId }, 5_000).catch(() => {
      void this.notify("session/cancel", { sessionId }).catch(() => undefined);
    });
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.request("session/close", { sessionId }, 5_000).catch(
      () => undefined,
    );
  }

  async close(): Promise<void> {
    this.closed = true;
    const terminals = Array.from(this.terminals.values());
    for (const terminal of terminals) this.terminateTerminal(terminal);
    await Promise.allSettled(
      terminals.map((terminal) =>
        withTimeout(terminal.exitPromise, TERMINAL_CLOSE_TIMEOUT_MS),
      ),
    );
    this.terminals.clear();
    const proc = this.proc;
    this.proc = undefined;
    if (!proc) return;
    if (!proc.stdin.destroyed) proc.stdin.end();
    const exited = await waitForExit(proc, AGENT_CLOSE_TERM_GRACE_MS);
    if (exited) return;
    if (!proc.killed) proc.kill("SIGTERM");
    const terminated = await waitForExit(proc, AGENT_CLOSE_TERM_GRACE_MS);
    if (!terminated) proc.kill("SIGKILL");
    await waitForExit(proc, AGENT_CLOSE_TERM_GRACE_MS);
  }

  private request(
    method: string,
    params: unknown,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onTimeout?: () => void,
  ): Promise<unknown> {
    if (this.closed) throw new Error("ACP client is closed");
    const id = this.nextId++;
    const proc = this.requireProcess();
    const payload = { jsonrpc: "2.0", id, method, params };
    this.emitEvent(payload as AcpJsonRpcMessage);
    proc.stdin.write(`${JSON.stringify(payload)}\n`);
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              onTimeout?.();
              reject(new Error(`ACP request timed out: ${method}`));
            }, timeoutMs)
          : undefined;
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  private async notify(method: string, params: unknown): Promise<void> {
    const proc = this.requireProcess();
    const payload = { jsonrpc: "2.0", method, params };
    this.emitEvent(payload as AcpJsonRpcMessage);
    proc.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  /**
   * Fire the onEvent observer without letting a consumer's throw derail the
   * transport. onEvent is best-effort observability (trajectory capture); a
   * throw used to propagate — synchronously breaking `request`/`notify`, or as
   * an unhandled rejection out of the un-awaited `handleLine` — instead of being
   * contained here.
   */
  private emitEvent(message: AcpJsonRpcMessage): void {
    try {
      this.opts.onEvent?.(message);
    } catch {
      // best-effort observer; swallow so ACP I/O keeps flowing
    }
  }

  private requireProcess(): ChildProcessWithoutNullStreams {
    if (!this.proc) throw new Error("ACP client has not been started");
    return this.proc;
  }

  private handleStdout(chunk: Buffer): void {
    this.readBuffer += chunk.toString("utf8");
    let newline = this.readBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.readBuffer.slice(0, newline).trim();
      this.readBuffer = this.readBuffer.slice(newline + 1);
      if (line) void this.handleLine(line);
      newline = this.readBuffer.indexOf("\n");
    }
  }

  private async handleLine(line: string): Promise<void> {
    let message: AcpJsonRpcMessage;
    try {
      message = JSON.parse(line) as AcpJsonRpcMessage;
    } catch {
      return;
    }
    this.emitEvent(message);

    const id = (message as { id?: JsonRpcId }).id;
    if (id !== undefined && ("result" in message || "error" in message)) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      if ("error" in message && message.error) {
        pending.reject(jsonRpcError(message.error));
      } else {
        pending.resolve((message as { result?: unknown }).result);
      }
      return;
    }

    const method = (message as { method?: unknown }).method;
    if (typeof method !== "string") return;
    if (id === undefined) return;
    try {
      const result = await this.handleClientRequest(
        method,
        (message as { params?: unknown }).params,
      );
      this.respond(id, result ?? {});
    } catch (err) {
      this.respondError(id, err, jsonRpcCodeForError(err, method));
    }
  }

  private async handleClientRequest(
    method: string,
    params: unknown,
  ): Promise<unknown> {
    switch (method) {
      case "session/update":
        return {};
      case "session/request_permission":
        return this.resolvePermission(asRecord(params));
      case "fs/read_text_file":
        return this.readTextFile(asRecord(params));
      case "fs/write_text_file":
        return this.writeTextFile(asRecord(params));
      case "terminal/create":
        return this.createTerminal(asRecord(params));
      case "terminal/output":
        return this.terminalOutput(asRecord(params));
      case "terminal/wait_for_exit":
        return this.waitForTerminalExit(asRecord(params));
      case "terminal/kill":
        return this.killTerminal(asRecord(params));
      case "terminal/release":
        return this.releaseTerminal(asRecord(params));
      default:
        throw new MethodNotFoundError(
          `Unsupported ACP client method: ${method}`,
        );
    }
  }

  private resolvePermission(params: Record<string, unknown> | undefined) {
    const options = Array.isArray(params?.options) ? params.options : [];
    const toolCall = asRecord(params?.toolCall);
    const approve = this.isOperationApproved(inferToolKind(toolCall));
    const option = pickPermissionOption(options, approve);
    if (option) return selectedPermission(option);
    return cancelledPermission();
  }

  private async readTextFile(params: Record<string, unknown> | undefined) {
    if (!this.isOperationApproved("read")) {
      throw new PermissionDeniedError(
        "Permission denied for fs/read_text_file",
      );
    }
    const filePath = await this.resolveReadablePath(stringValue(params?.path));
    const content = await readFile(filePath, "utf8");
    const line = numberValue(params?.line);
    const limit = numberValue(params?.limit);
    if (!line && !limit) return { content };
    const lines = content.split(/\r?\n/u);
    const start = Math.max((line ?? 1) - 1, 0);
    const end = limit ? start + limit : undefined;
    return { content: lines.slice(start, end).join("\n") };
  }

  private async writeTextFile(params: Record<string, unknown> | undefined) {
    if (!this.isOperationApproved("edit")) {
      throw new PermissionDeniedError(
        "Permission denied for fs/write_text_file",
      );
    }
    const filePath = await this.resolveWritablePath(stringValue(params?.path));
    const content = stringValue(params?.content) ?? "";
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");
    return {};
  }

  private async createTerminal(params: Record<string, unknown> | undefined) {
    if (this.opts.terminal === false) {
      throw new PermissionDeniedError("ACP terminal capability is disabled");
    }
    if (!this.isOperationApproved("execute")) {
      throw new PermissionDeniedError("Permission denied for terminal/create");
    }
    const command = stringValue(params?.command);
    if (!command) throw new Error("terminal/create requires command");
    const args = Array.isArray(params?.args)
      ? params.args.map((arg) => String(arg))
      : undefined;
    const cwd = await this.resolveDirectoryPath(
      stringValue(params?.cwd) ?? this.opts.cwd,
    );
    const spawnCommand = terminalSpawnCommand(command, args);
    const proc = spawn(spawnCommand.command, spawnCommand.args, {
      cwd,
      env: {
        ...this.opts.env,
        ...envArrayToRecord(params?.env),
      },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const terminalId = `terminal-${this.nextId++}`;
    const record: TerminalRecord = {
      proc,
      output: "",
      truncated: false,
      limit: numberValue(params?.outputByteLimit) ?? TERMINAL_OUTPUT_LIMIT,
      exitPromise: Promise.resolve(),
    };
    record.exitPromise = new Promise((resolve) => {
      proc.on("close", (code, signal) => {
        record.exitCode = code;
        record.signal = signal;
        if (record.killTimer) clearTimeout(record.killTimer);
        resolve();
      });
    });
    const capture = (chunk: Buffer) => {
      record.output += chunk.toString("utf8");
      if (Buffer.byteLength(record.output, "utf8") > record.limit) {
        record.truncated = true;
        // Keep the last `limit` BYTES, not characters. `String.slice(-limit)`
        // keeps `limit` CHARACTERS, so multi-byte UTF-8 output could exceed the
        // byte budget by up to 4×. Slice the encoded buffer to the last `limit`
        // bytes, then drop any leading UTF-8 continuation bytes so we decode on
        // a character boundary.
        const tail = Buffer.from(record.output, "utf8").subarray(-record.limit);
        let start = 0;
        while (start < tail.length && (tail[start] & 0xc0) === 0x80) start += 1;
        record.output = tail.subarray(start).toString("utf8");
      }
    };
    proc.stdout.on("data", capture);
    proc.stderr.on("data", capture);
    await waitForSpawn(proc);
    this.terminals.set(terminalId, record);
    return { terminalId };
  }

  private terminalOutput(params: Record<string, unknown> | undefined) {
    const terminal = this.requireTerminal(stringValue(params?.terminalId));
    return {
      output: terminal.output,
      truncated: terminal.truncated,
      ...(terminal.exitCode !== undefined || terminal.signal !== undefined
        ? {
            exitStatus: {
              exitCode: terminal.exitCode ?? null,
              signal: terminal.signal ?? null,
            },
          }
        : {}),
    };
  }

  private async waitForTerminalExit(
    params: Record<string, unknown> | undefined,
  ) {
    const terminal = this.requireTerminal(stringValue(params?.terminalId));
    await terminal.exitPromise;
    return {
      exitCode: terminal.exitCode ?? null,
      signal: terminal.signal ?? null,
    };
  }

  private killTerminal(params: Record<string, unknown> | undefined) {
    const terminal = this.requireTerminal(stringValue(params?.terminalId));
    this.terminateTerminal(terminal);
    return {};
  }

  private async releaseTerminal(params: Record<string, unknown> | undefined) {
    const terminalId = stringValue(params?.terminalId);
    const terminal = terminalId ? this.terminals.get(terminalId) : undefined;
    if (!terminal) return {};
    this.terminateTerminal(terminal);
    await withTimeout(terminal.exitPromise, TERMINAL_CLOSE_TIMEOUT_MS);
    if (terminalId) this.terminals.delete(terminalId);
    return {};
  }

  private requireTerminal(terminalId: string | undefined): TerminalRecord {
    const terminal = terminalId ? this.terminals.get(terminalId) : undefined;
    if (!terminal) throw new Error(`Unknown ACP terminal: ${terminalId ?? ""}`);
    return terminal;
  }

  private respond(id: JsonRpcId, result: unknown): void {
    this.requireProcess().stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`,
    );
  }

  private respondError(
    id: JsonRpcId,
    err: unknown,
    code = JSONRPC_INTERNAL_ERROR,
  ): void {
    this.requireProcess().stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code, message: errorMessage(err) },
      })}\n`,
    );
  }

  private rejectAll(err: unknown): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(err);
    }
  }

  private isOperationApproved(kind: string | undefined): boolean {
    if (
      this.opts.approvalPreset === "autonomous" ||
      this.opts.approvalPreset === "permissive"
    ) {
      return true;
    }
    if (this.opts.approvalPreset === "standard") {
      return kind === "read" || kind === "search";
    }
    // Independent verifier (#8898): may read, search, and EXECUTE (run tests /
    // build / git diff) but is hard-blocked from edit/write/delete — writeTextFile
    // throws PermissionDeniedError off this gate, so read-only is enforced at the
    // transport, not by prompt text.
    if (this.opts.approvalPreset === "verifier") {
      return kind === "read" || kind === "search" || kind === "execute";
    }
    return false;
  }

  /** Whether a `session/request_permission` will be auto-approved without user
   *  interaction — mirrors `resolvePermission`'s decision exactly. AcpService
   *  uses this to avoid surfacing a phantom "blocked" for a request the
   *  transport immediately approves under the session's preset. The op being
   *  approved is necessary but not sufficient: `resolvePermission` only counts
   *  it as approved when a concrete option is selectable; an empty/malformed
   *  `options` list makes the transport cancel, which is a genuine block. */
  approvesPermissionRequest(
    params: Record<string, unknown> | undefined,
  ): boolean {
    const options = Array.isArray(params?.options) ? params.options : [];
    const approve = this.isOperationApproved(
      inferToolKind(asRecord(params?.toolCall)),
    );
    return approve && pickPermissionOption(options, approve) !== undefined;
  }

  private async resolveReadablePath(
    requested: string | undefined,
  ): Promise<string> {
    const filePath = ensureInsideCwd(this.opts.cwd, requested);
    const [root, resolved] = await Promise.all([
      realpath(this.opts.cwd),
      realpath(filePath),
    ]);
    ensureResolvedInsideRoot(root, resolved, requested ?? filePath);
    return resolved;
  }

  private async resolveWritablePath(
    requested: string | undefined,
  ): Promise<string> {
    const filePath = ensureInsideCwd(this.opts.cwd, requested);
    await mkdir(path.dirname(filePath), { recursive: true });
    const [root, parent] = await Promise.all([
      realpath(this.opts.cwd),
      realpath(path.dirname(filePath)),
    ]);
    ensureResolvedInsideRoot(root, parent, requested ?? filePath);
    const existing = await lstat(filePath).catch(
      (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return undefined;
        throw err;
      },
    );
    if (existing?.isSymbolicLink()) {
      throw new Error(`ACP refusing to write through symlink: ${requested}`);
    }
    return path.join(parent, path.basename(filePath));
  }

  private async resolveDirectoryPath(requested: string): Promise<string> {
    const dirPath = ensureInsideCwd(this.opts.cwd, requested);
    const [root, resolved] = await Promise.all([
      realpath(this.opts.cwd),
      realpath(dirPath),
    ]);
    ensureResolvedInsideRoot(root, resolved, requested);
    return resolved;
  }

  private terminateTerminal(terminal: TerminalRecord): void {
    if (terminal.exitCode !== undefined || terminal.signal !== undefined)
      return;
    signalTerminal(terminal.proc, "SIGTERM");
    if (!terminal.killTimer) {
      terminal.killTimer = setTimeout(() => {
        if (terminal.exitCode === undefined && terminal.signal === undefined) {
          signalTerminal(terminal.proc, "SIGKILL");
        }
      }, TERMINAL_KILL_GRACE_MS);
      terminal.killTimer.unref();
    }
  }
}

export function splitCommandLine(input: string): {
  command: string;
  args: string[];
} {
  const parts = input.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/gu) ?? [];
  const [command = "", ...args] = parts.map((part) =>
    part.replace(/^(['"])(.*)\1$/u, "$2"),
  );
  return { command, args };
}

function pickPermissionOption(
  options: unknown[],
  approve: boolean,
): string | undefined {
  const preferred = approve
    ? ["allow_once", "allow_always"]
    : ["reject_once", "reject_always"];
  for (const kind of preferred) {
    for (const option of options) {
      const record = asRecord(option);
      if (record?.kind === kind && typeof record.optionId === "string") {
        return record.optionId;
      }
    }
  }
  const first = asRecord(options[0]);
  return approve && typeof first?.optionId === "string"
    ? first.optionId
    : undefined;
}

function selectedPermission(optionId: string): {
  outcome: { outcome: "selected"; optionId: string };
} {
  return { outcome: { outcome: "selected", optionId } };
}

function cancelledPermission(): { outcome: { outcome: "cancelled" } } {
  return { outcome: { outcome: "cancelled" } };
}

function envArrayToRecord(value: unknown): Record<string, string> {
  if (!Array.isArray(value)) return {};
  const env: Record<string, string> = {};
  for (const entry of value) {
    const record = asRecord(entry);
    const name = stringValue(record?.name);
    if (!name) continue;
    env[name] = stringValue(record?.value) ?? "";
  }
  return env;
}

function ensureInsideCwd(cwd: string, requested: string | undefined): string {
  if (!requested) throw new Error("ACP file path is required");
  const root = path.resolve(cwd);
  const resolved = path.isAbsolute(requested)
    ? path.resolve(requested)
    : path.resolve(root, requested);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`ACP path is outside the session workspace: ${requested}`);
  }
  return resolved;
}

function ensureResolvedInsideRoot(
  root: string,
  resolved: string,
  requested: string,
): void {
  const relative = path.relative(root, resolved);
  if (relative && (relative.startsWith("..") || path.isAbsolute(relative))) {
    throw new Error(`ACP path is outside the session workspace: ${requested}`);
  }
}

class AcpRequestError extends Error {
  readonly code?: number;
  readonly data?: unknown;

  constructor(message: string, code?: number, data?: unknown) {
    super(message);
    this.name = "AcpRequestError";
    this.code = code;
    this.data = data;
  }
}

function jsonRpcError(error: unknown): Error {
  const record = asRecord(error);
  const baseMessage = stringValue(record?.message) ?? "ACP request failed";
  const code = numberValue(record?.code);
  const data = record?.data;
  // JSON-RPC error.data carries the diagnostic detail (e.g. a ZodError for
  // -32602 "Invalid params"). Surface a compact form of it in the message so
  // failures stay debuggable, and keep the structured value on the error.
  if (data === undefined) {
    return new AcpRequestError(baseMessage, code);
  }
  const detail = compactJson(data);
  const message = detail ? `${baseMessage} (data: ${detail})` : baseMessage;
  return new AcpRequestError(message, code, data);
}

function compactJson(value: unknown): string | undefined {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      return undefined;
    }
    const limit = 2000;
    return serialized.length > limit
      ? `${serialized.slice(0, limit)}…`
      : serialized;
  } catch {
    return undefined;
  }
}

function extractAgentSessionId(meta: unknown): string | undefined {
  const record = asRecord(meta);
  return (
    stringValue(record?.agentSessionId) ??
    stringValue(asRecord(record?.acp)?.agentSessionId)
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function inferToolKind(
  toolCall: Record<string, unknown> | undefined,
): string | undefined {
  const explicit = stringValue(toolCall?.kind)?.trim().toLowerCase();
  if (explicit) return explicit;
  const rawInput = asRecord(toolCall?.rawInput);
  const title = stringValue(toolCall?.title)?.trim().toLowerCase();
  const rawName =
    stringValue(rawInput?.toolName) ??
    stringValue(rawInput?.tool_name) ??
    stringValue(rawInput?.tool) ??
    stringValue(rawInput?.name);
  const candidate = (rawName ?? title ?? "").trim().toLowerCase();
  const head = candidate.split(/[:\s]/u, 1)[0] ?? candidate;
  if (!head) return undefined;
  if (tokenMatches(head, "read") || tokenMatches(head, "cat")) return "read";
  if (
    tokenMatches(head, "search") ||
    tokenMatches(head, "find") ||
    tokenMatches(head, "grep")
  ) {
    return "search";
  }
  if (
    tokenMatches(head, "write") ||
    tokenMatches(head, "edit") ||
    tokenMatches(head, "patch")
  ) {
    return "edit";
  }
  if (tokenMatches(head, "delete") || tokenMatches(head, "remove")) {
    return "delete";
  }
  if (tokenMatches(head, "move") || tokenMatches(head, "rename")) {
    return "move";
  }
  if (
    tokenMatches(head, "run") ||
    tokenMatches(head, "exec") ||
    tokenMatches(head, "execute") ||
    tokenMatches(head, "bash") ||
    tokenMatches(head, "terminal")
  ) {
    return "execute";
  }
  if (tokenMatches(head, "fetch") || tokenMatches(head, "http")) return "fetch";
  return "other";
}

function tokenMatches(value: string, token: string): boolean {
  return new RegExp(`(?:^|[._-])${token}(?:$|[._-])`, "u").test(value);
}

function terminalSpawnCommand(
  command: string,
  args: string[] | undefined,
): { command: string; args: string[] } {
  if (args !== undefined) return { command, args };
  if (shouldRunTerminalCommandInShell(command)) {
    return process.platform === "win32"
      ? { command: "cmd.exe", args: ["/d", "/s", "/c", command] }
      : { command: "/bin/sh", args: ["-c", command] };
  }
  return { command, args: [] };
}

function shouldRunTerminalCommandInShell(command: string): boolean {
  if (/\s/u.test(command)) return true;
  if (process.platform === "win32") {
    return /[|&;<>()>$`*?[\]{}'"\r\n]/u.test(command);
  }
  return /[|&;<>()>$`*?[\]{}'"\\\r\n]/u.test(command);
}

function waitForSpawn(proc: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      proc.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      proc.off("spawn", onSpawn);
      reject(error);
    };
    proc.once("spawn", onSpawn);
    proc.once("error", onError);
  });
}

function signalTerminal(
  proc: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void {
  const pid = proc.pid;
  try {
    if (pid && process.platform !== "win32") {
      process.kill(-pid, signal);
      return;
    }
  } catch {
    // Fall back to signaling the direct child below.
  }
  if (!proc.killed) proc.kill(signal);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function jsonRpcCodeForError(err: unknown, method: string): number {
  if (err instanceof MethodNotFoundError) return JSONRPC_METHOD_NOT_FOUND;
  if (err instanceof PermissionDeniedError) return JSONRPC_PERMISSION_DENIED;
  if (/requires|required|invalid/i.test(errorMessage(err))) {
    return JSONRPC_INVALID_PARAMS;
  }
  if (/unknown/i.test(errorMessage(err)) && !method.startsWith("terminal/")) {
    return JSONRPC_INVALID_PARAMS;
  }
  return JSONRPC_INTERNAL_ERROR;
}

class MethodNotFoundError extends Error {}

class PermissionDeniedError extends Error {}

async function waitForExit(
  proc: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode !== null) return true;
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      proc.off("close", onClose);
      resolve(false);
    }, timeoutMs);
    const onClose = () => {
      clearTimeout(timer);
      resolve(true);
    };
    proc.once("close", onClose);
  });
}

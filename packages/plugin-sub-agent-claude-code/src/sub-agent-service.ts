/**
 * ClaudeCodeSubAgentService — spawns `claude` CLI as a subprocess and
 * exposes session/prompt/output/terminate over host-RPC.
 *
 * SOC2 hardening (A-2 / A-3 / O-8):
 *   - Env passed to the child is a strict allowlist (`SAFE_ENV_KEYS`),
 *     with a defensive credential/token regex blocklist on top.
 *   - `cwd` is resolved via `realpath` and must live under the agent
 *     workspace (or `/tmp`).
 *   - `binary` is resolved via PATH-restricted lookup; only paths under
 *     a static dir whitelist are accepted.
 *   - Spawn is wrapped in `sandbox-exec` (macOS) or bwrap (Linux). When
 *     the helper is missing we log a WARN and fall through to
 *     allowlist-only spawn — dev boxes still work, prod deploys treat
 *     the WARN as a P1 fix.
 *   - A redacted transcript is recorded per session for audit; the
 *     transcript hash + byte count are emitted to the audit pipeline.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonValue } from "@elizaos/plugin-remote-manifest";
import type { AuditDispatcher } from "@elizaos/security";
import {
  buildSandboxedCommand,
  filterEnv,
  locateBundledProfiles,
  resolveSafeBinary,
  resolveSafeCwd,
  SAFE_ENV_KEYS,
} from "./sandbox.js";
import { pruneOldSessions, SessionRecorder } from "./session-recorder.js";

export interface ClaudeCodeSession {
  sessionId: string;
  createdAt: number;
  cwd: string;
  model?: string;
  binary: string;
  proc: ReturnType<typeof Bun.spawn>;
  output: string[];
  recorder: SessionRecorder;
  sandbox: string;
}

export interface CreateSessionParams {
  cwd: string;
  model?: string;
  /** Override the claude CLI binary name/path. Default: "claude". */
  binary?: string;
  /** Initial prompt to send after the session boots. */
  initialPrompt?: string;
  /** Explicit, pre-validated env overrides (must not contain sensitive keys). */
  extraEnv?: Record<string, string>;
}

export interface SendPromptParams {
  sessionId: string;
  prompt: string;
}

export interface GetOutputParams {
  sessionId: string;
  /** Drain mode: return all output, or just the new lines since last call. */
  mode?: "all" | "since-last";
}

export interface TerminateParams {
  sessionId: string;
}

export interface ServiceOptions {
  /** Allowed workspace roots for `cwd` validation. */
  workspaceRoots?: readonly string[];
  /** Audit sink for spawn / session-record events. */
  auditDispatcher?: AuditDispatcher;
  /** Actor id captured on audit events. */
  actorId?: string;
}

/**
 * Compute the package root (parent of `src/` or `dist/`) so we can find
 * the bundled sandbox profiles regardless of build vs source mode.
 */
function packageRoot(): string {
  const here = fileURLToPath(import.meta.url);
  return dirname(dirname(here));
}

export class ClaudeCodeSubAgentService {
  static readonly serviceType = "sub-agent.claude-code";
  static readonly rpcMethods = [
    "createSession",
    "sendPrompt",
    "getOutput",
    "terminate",
    "listSessions",
  ] as const;
  static readonly capabilityDescription =
    "Drives the Claude Code CLI in an isolated subprocess.";

  readonly capabilityDescription =
    ClaudeCodeSubAgentService.capabilityDescription;

  private readonly sessions = new Map<string, ClaudeCodeSession>();
  private readonly outputCursors = new Map<string, number>();
  private nextSessionId = 1;
  private workspaceRoots: readonly string[];
  private auditDispatcher: AuditDispatcher | undefined;
  private actorId: string | undefined;
  private bundledProfiles = locateBundledProfiles(packageRoot());

  constructor(opts: ServiceOptions = {}) {
    this.workspaceRoots = opts.workspaceRoots ?? defaultWorkspaceRoots();
    this.auditDispatcher = opts.auditDispatcher;
    this.actorId = opts.actorId;
  }

  static async start(runtime: unknown): Promise<ClaudeCodeSubAgentService> {
    const opts = extractServiceOptions(runtime);
    const svc = new ClaudeCodeSubAgentService(opts);
    // Fire-and-forget retention sweep at boot.
    try {
      pruneOldSessions();
    } catch {
      // Non-critical.
    }
    return svc;
  }

  async stop(): Promise<void> {
    for (const session of this.sessions.values()) {
      try {
        session.proc.kill("SIGTERM");
      } catch {
        // already dead
      }
      await session.recorder.finalize();
    }
    this.sessions.clear();
    this.outputCursors.clear();
  }

  async createSession(params: CreateSessionParams): Promise<JsonValue> {
    const sessionId = `cc-${this.nextSessionId++}-${Date.now()}`;
    const safeCwd = resolveSafeCwd(params.cwd, this.workspaceRoots);
    const safeBinary = resolveSafeBinary(params.binary ?? "claude");

    const args = ["--print"];
    if (params.model) args.push("--model", params.model);

    const sandboxPlan = buildSandboxedCommand([safeBinary, ...args], {
      workspaceRoot: safeCwd,
      sessionId,
      ...this.bundledProfiles,
    });
    if (sandboxPlan.sandbox === "none") {
      process.stderr.write(
        `[sub-agent] WARN: no OS sandbox available on ${process.platform}; spawning with env-allowlist only.\n`,
      );
    }

    const env = filterEnv(process.env, SAFE_ENV_KEYS, params.extraEnv ?? {});

    const recorder = new SessionRecorder({
      sessionId,
      ...(this.auditDispatcher
        ? { auditDispatcher: this.auditDispatcher }
        : {}),
      ...(this.actorId ? { actorId: this.actorId } : {}),
    });

    if (this.auditDispatcher) {
      await this.auditDispatcher.emit({
        actor: {
          type: this.actorId ? "user" : "system",
          id: this.actorId ?? "agent",
        },
        action: "agent.spawn",
        result: "success",
        resource: { type: "sub-agent.session", id: sessionId },
        metadata: {
          session_id: sessionId,
          binary: safeBinary,
          cwd: safeCwd,
          sandbox: sandboxPlan.sandbox,
        },
      });
    }

    const [cmd0, ...cmdRest] = sandboxPlan.cmd;
    if (!cmd0) throw new Error("Empty sandbox command");
    const proc = Bun.spawn({
      cmd: [cmd0, ...cmdRest],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: safeCwd,
      env,
    });

    const session: ClaudeCodeSession = {
      sessionId,
      createdAt: Date.now(),
      cwd: safeCwd,
      ...(params.model ? { model: params.model } : {}),
      binary: safeBinary,
      proc,
      output: [],
      recorder,
      sandbox: sandboxPlan.sandbox,
    };
    this.sessions.set(sessionId, session);
    this.outputCursors.set(sessionId, 0);

    // Pump stdout into the session's output buffer.
    void this.pumpStdout(session);

    if (params.initialPrompt) {
      await this.sendPrompt({ sessionId, prompt: params.initialPrompt });
    }

    return {
      sessionId,
      createdAt: session.createdAt,
      sandbox: sandboxPlan.sandbox,
    };
  }

  async sendPrompt(params: SendPromptParams): Promise<JsonValue> {
    const session = this.requireSession(params.sessionId);
    session.recorder.record(`> ${params.prompt}`);
    const writer = session.proc.stdin as unknown as {
      write(data: string): void;
    };
    writer.write(`${params.prompt}\n`);
    return { ok: true };
  }

  async getOutput(params: GetOutputParams): Promise<JsonValue> {
    const session = this.requireSession(params.sessionId);
    const mode = params.mode ?? "since-last";
    if (mode === "all") {
      return { lines: [...session.output] };
    }
    const cursor = this.outputCursors.get(params.sessionId) ?? 0;
    const newLines = session.output.slice(cursor);
    this.outputCursors.set(params.sessionId, session.output.length);
    return { lines: newLines };
  }

  async terminate(params: TerminateParams): Promise<JsonValue> {
    const session = this.sessions.get(params.sessionId);
    if (!session) return { terminated: false };
    try {
      session.proc.kill("SIGTERM");
    } catch {
      // already dead
    }
    await session.recorder.finalize();
    this.sessions.delete(params.sessionId);
    this.outputCursors.delete(params.sessionId);
    return { terminated: true };
  }

  async listSessions(): Promise<JsonValue> {
    return {
      sessions: Array.from(this.sessions.values()).map((s) => ({
        sessionId: s.sessionId,
        createdAt: s.createdAt,
        cwd: s.cwd,
        model: s.model ?? null,
        sandbox: s.sandbox,
      })),
    };
  }

  private requireSession(id: string): ClaudeCodeSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Unknown session: ${id}`);
    return session;
  }

  private async pumpStdout(session: ClaudeCodeSession): Promise<void> {
    if (!session.proc.stdout) return;
    const reader = (
      session.proc.stdout as unknown as ReadableStream<Uint8Array>
    ).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        buffer += decoder.decode(value, { stream: true });
        let nl = buffer.indexOf("\n");
        while (nl !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          session.output.push(line);
          session.recorder.record(line);
          nl = buffer.indexOf("\n");
        }
      }
      if (buffer.length > 0) {
        session.output.push(buffer);
        session.recorder.record(buffer);
      }
    } finally {
      reader.releaseLock?.();
    }
  }
}

function defaultWorkspaceRoots(): readonly string[] {
  const roots: string[] = [];
  const env = process.env;
  for (const key of ["ELIZA_WORKSPACE_DIR", "ELIZA_STATE_DIR"]) {
    const v = env[key];
    if (v) roots.push(resolve(v));
  }
  // Fallback: process cwd.
  roots.push(process.cwd());
  return roots;
}

function extractServiceOptions(runtime: unknown): ServiceOptions {
  if (!runtime || typeof runtime !== "object") return {};
  const r = runtime as {
    getSetting?: (key: string) => unknown;
    auditDispatcher?: AuditDispatcher;
    actorId?: string;
  };
  return {
    ...(r.auditDispatcher ? { auditDispatcher: r.auditDispatcher } : {}),
    ...(typeof r.actorId === "string" ? { actorId: r.actorId } : {}),
  };
}

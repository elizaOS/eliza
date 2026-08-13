/**
 * Service registration for interactive PTY terminal sessions.
 * It exposes the `PTY_SERVICE` console bridge that the agent server's WebSocket layer uses for output, keystrokes, resize events, and session lifecycle.
 */

import { ElizaError, type IAgentRuntime, logger, Service } from "@elizaos/core";
import {
  PtyConsoleBridge,
  PtySessionStore,
  type PtySpawnResolver,
} from "./pty-session-store";
import type { PtySessionInfo, PtySpawnSpec } from "./pty-types";

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const PTY_IDLE_TIMEOUT_SETTING = "PTY_IDLE_TIMEOUT_MS";

function resolveAllowedRoot(runtime?: IAgentRuntime): string {
  const fromSetting = runtime?.getSetting?.("PTY_ALLOWED_DIRECTORY");
  const raw =
    (typeof fromSetting === "string" && fromSetting.trim()) ||
    process.env.PTY_ALLOWED_DIRECTORY?.trim() ||
    process.cwd();
  return raw;
}

function resolveIdleTimeoutMs(runtime?: IAgentRuntime): number | undefined {
  const fromSetting = runtime?.getSetting?.(PTY_IDLE_TIMEOUT_SETTING);
  const normalizedSetting =
    typeof fromSetting === "string" ? fromSetting.trim() : fromSetting;
  const usesRuntimeSetting =
    normalizedSetting != null && normalizedSetting !== "";
  const configured = usesRuntimeSetting
    ? normalizedSetting
    : process.env[PTY_IDLE_TIMEOUT_SETTING]?.trim();
  if (configured == null || configured === "") return undefined;

  const parsed =
    typeof configured === "number"
      ? configured
      : typeof configured === "string" && /^\d+$/.test(configured)
        ? Number(configured)
        : Number.NaN;
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 0 ||
    parsed > MAX_TIMER_DELAY_MS
  ) {
    throw new ElizaError(
      `${PTY_IDLE_TIMEOUT_SETTING} must be an integer from 0 to ${MAX_TIMER_DELAY_MS}`,
      {
        code: "PTY_IDLE_TIMEOUT_INVALID",
        context: {
          setting: PTY_IDLE_TIMEOUT_SETTING,
          source: usesRuntimeSetting ? "runtime" : "environment",
          configured,
          minimum: 0,
          maximum: MAX_TIMER_DELAY_MS,
        },
        severity: "fatal",
      },
    );
  }
  return parsed;
}

export class PtyService extends Service {
  public static serviceType = "PTY_SERVICE";

  /** Consumed by the agent server (`getPtyConsoleBridge`). */
  readonly consoleBridge: PtyConsoleBridge;
  private readonly store: PtySessionStore;

  constructor(
    runtime?: IAgentRuntime,
    spawnResolver?: PtySpawnResolver,
    opts?: {
      allowedRoot?: string;
      maxSessions?: number;
      idleTimeoutMs?: number;
    },
  ) {
    super(runtime);
    this.consoleBridge = new PtyConsoleBridge();
    this.store = new PtySessionStore(this.consoleBridge, spawnResolver, opts);
  }

  static async start(runtime: IAgentRuntime): Promise<PtyService> {
    const allowedRoot = resolveAllowedRoot(runtime);
    const idleTimeoutMs = resolveIdleTimeoutMs(runtime);
    const instance = new PtyService(runtime, undefined, {
      allowedRoot,
      ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
    });
    logger.info(
      `[plugin-pty] PTY_SERVICE started (allowedRoot=${allowedRoot})`,
    );
    return instance;
  }

  get capabilityDescription(): string {
    return "Interactive PTY terminal sessions bridged to the web terminal (real CLI I/O).";
  }

  /** Spawn a new interactive session; returns its serializable info. */
  async startSession(spec: PtySpawnSpec): Promise<PtySessionInfo> {
    return this.store.start(spec);
  }

  /** Kill a session's process and drop its record (PTYService contract). */
  async stopSession(sessionId: string): Promise<void> {
    return this.store.stop(sessionId);
  }

  /** Serializable metadata for every live session. */
  listSessions(): PtySessionInfo[] {
    return this.store.list();
  }

  /** Whether a session currently exists. */
  hasSession(sessionId: string): boolean {
    return this.store.has(sessionId);
  }

  /** Captured terminal output for clients that subscribe after spawn. */
  getBufferedOutput(sessionId: string): string | undefined {
    return this.store.getBufferedOutput(sessionId);
  }

  async stop(): Promise<void> {
    await this.store.stopAll();
    logger.info("[plugin-pty] PTY_SERVICE stopped; all sessions killed");
  }
}

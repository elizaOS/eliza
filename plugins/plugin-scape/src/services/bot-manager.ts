/**
 * BotManager — thin lifecycle wrapper around {@link BotSdk}.
 *
 * Separates "connection lifecycle + config resolution" from the
 * `ScapeGameService` that owns the LLM loop. That lets the game
 * service stay focused on prompting / action dispatch and lets the
 * BotManager evolve independently (e.g. multi-agent support later,
 * SDK swap-in for testing).
 *
 * PR 3 scope: connect + passive state caching. No LLM loop, no
 * automatic action dispatch — the game service will push actions
 * through `sendAction` in PR 4.
 */

import {
  BotSdk,
  type BotSdkCallbacks,
  type BotSdkOptions,
  type SdkConnectionStatus,
} from "../sdk/index.js";
import type {
  ActionFramePayload,
  ErrorFrame,
  OperatorCommandFrame,
  PerceptionSnapshot,
  SpawnOkFrame,
} from "../sdk/types.js";

export interface BotManagerConfig {
  url: string;
  token: string;
  agentId: string;
  displayName: string;
  password: string;
  controller?: "llm" | "user" | "hybrid";
  persona?: string;
}

export interface BotManagerCallbacks {
  onStatusChange?: (status: SdkConnectionStatus) => void;
  onPerception?: (snapshot: PerceptionSnapshot) => void;
  onSpawn?: (spawn: SpawnOkFrame) => void;
  onServerError?: (error: ErrorFrame) => void;
  onOperatorCommand?: (frame: OperatorCommandFrame) => void;
  onLog?: (line: string) => void;
}

export class BotManager {
  private sdk: BotSdk | null = null;
  private latestPerception: PerceptionSnapshot | null = null;
  private latestSpawn: SpawnOkFrame | null = null;
  private latestStatus: SdkConnectionStatus = "idle";

  constructor(
    private readonly config: BotManagerConfig,
    private readonly callbacks: BotManagerCallbacks = {},
  ) {}

  connect(): void {
    if (
      this.sdk &&
      this.latestStatus !== "closed" &&
      this.latestStatus !== "failed"
    ) {
      return;
    }

    // Plaintext credentials (scrypt password, bot-SDK token) ride
    // on the spawn frame, so the only safe non-TLS transport is
    // loopback. A remote host over ws:// leaks the password to
    // anything on the network path. Refuse to connect unless the
    // operator has explicitly opted in with
    // SCAPE_ALLOW_INSECURE_WS=1.
    const insecureCheck = assessTransportSecurity(this.config.url);
    if (insecureCheck.risk === "block") {
      this.log(
        `refusing to connect: ${insecureCheck.reason}. Use wss:// or set SCAPE_ALLOW_INSECURE_WS=1 to override (dev only).`,
      );
      this.latestStatus = "failed";
      this.callbacks.onStatusChange?.("failed");
      return;
    }
    if (insecureCheck.risk === "warn") {
      this.log(`WARNING: ${insecureCheck.reason}`);
    }

    const options: BotSdkOptions = {
      url: this.config.url,
      token: this.config.token,
      agentId: this.config.agentId,
      displayName: this.config.displayName,
      password: this.config.password,
      controller: this.config.controller ?? "hybrid",
      persona: this.config.persona,
      autoReconnect: true,
    };
    const sdkCallbacks: BotSdkCallbacks = {
      onStatusChange: (status) => {
        this.latestStatus = status;
        this.callbacks.onStatusChange?.(status);
        this.log(`status → ${status}`);
      },
      onPerception: (snapshot) => {
        this.latestPerception = snapshot;
        this.callbacks.onPerception?.(snapshot);
      },
      onSpawn: (spawn) => {
        this.latestSpawn = spawn;
        this.callbacks.onSpawn?.(spawn);
        this.log(
          `spawnOk playerId=${spawn.playerId} at (${spawn.x}, ${spawn.z})`,
        );
      },
      onServerError: (error) => {
        this.callbacks.onServerError?.(error);
        this.log(`server error ${error.code}: ${error.message}`);
      },
      onOperatorCommand: (frame) => {
        this.callbacks.onOperatorCommand?.(frame);
        const from = frame.fromPlayerName ?? frame.source;
        this.log(`operator command from ${from}: "${frame.text.slice(0, 80)}"`);
      },
      onLog: (direction, summary) => {
        this.log(`[${direction}] ${summary}`);
      },
    };
    this.sdk = new BotSdk(options, sdkCallbacks);
    this.sdk.connect();
  }

  disconnect(reason?: string): void {
    this.sdk?.disconnect(reason);
    this.sdk = null;
  }

  getStatus(): SdkConnectionStatus {
    return this.latestStatus;
  }

  getPerception(): PerceptionSnapshot | null {
    return this.latestPerception;
  }

  getSpawnState(): SpawnOkFrame | null {
    return this.latestSpawn;
  }

  isConnected(): boolean {
    return this.sdk?.isConnected() ?? false;
  }

  async sendAction(
    action: ActionFramePayload,
    awaitAck = true,
  ): Promise<{ success: boolean; message?: string }> {
    if (!this.sdk) {
      return { success: false, message: "bot manager not connected" };
    }
    try {
      return await this.sdk.sendAction(action, awaitAck);
    } catch (err) {
      return {
        success: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private log(line: string): void {
    this.callbacks.onLog?.(line);
  }
}

/**
 * Classify a bot-SDK URL's transport as safe, warn, or block.
 *
 *   - `safe`   — wss://, or ws:// against a loopback host
 *   - `warn`   — ws:// against a non-loopback host AND
 *                SCAPE_ALLOW_INSECURE_WS=1 is set (operator opt-in)
 *   - `block`  — ws:// against a non-loopback host with no opt-in;
 *                connect() will refuse and surface a failed status
 *
 * Exported for tests; lives here rather than in sdk/ because it's a
 * lifecycle concern, not a protocol one.
 */
export function assessTransportSecurity(rawUrl: string): {
  risk: "safe" | "warn" | "block";
  reason?: string;
} {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return {
      risk: "block",
      reason: `invalid SCAPE_BOT_SDK_URL "${rawUrl}"`,
    };
  }

  if (parsed.protocol === "wss:") {
    return { risk: "safe" };
  }
  if (parsed.protocol !== "ws:") {
    return {
      risk: "block",
      reason: `unsupported protocol "${parsed.protocol}" (expected ws: or wss:)`,
    };
  }

  const host = parsed.hostname.toLowerCase();
  const isLoopback =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host.endsWith(".localhost");
  if (isLoopback) {
    return { risk: "safe" };
  }

  const optIn = (process.env.SCAPE_ALLOW_INSECURE_WS ?? "").trim();
  if (optIn === "1" || optIn.toLowerCase() === "true") {
    return {
      risk: "warn",
      reason: `connecting to non-loopback host "${host}" over plaintext ws:// — the scrypt password will be sent in the clear. Set SCAPE_BOT_SDK_URL to wss:// in production.`,
    };
  }

  return {
    risk: "block",
    reason: `non-loopback host "${host}" requires wss:// (ws:// would send the password in plaintext)`,
  };
}

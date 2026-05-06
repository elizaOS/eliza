/**
 * Device-side half of the agent↔device inference bridge.
 *
 * Runs inside the mobile app (Capacitor iOS / Android) and dials out to
 * the agent container over WebSocket. Receives `generate` requests,
 * forwards to `capacitorLlama`, returns results. Auto-reconnects with
 * exponential backoff when the link drops.
 *
 * Mirrors the message envelope defined in
 * `@elizaos/app-core/src/services/local-inference/device-bridge.ts`.
 * Keep the two in sync by hand — the message shape is the bridge
 * contract.
 */

import { loadCapacitorLlama } from "./load-capacitor-llama";

interface DeviceCapabilities {
  platform: "ios" | "android" | "web";
  deviceModel: string;
  totalRamGb: number;
  cpuCores: number;
  gpu: {
    backend: "metal" | "vulkan" | "gpu-delegate";
    available: boolean;
  } | null;
}

type AgentInbound =
  | {
      type: "load";
      correlationId: string;
      modelPath: string;
      contextSize?: number;
      useGpu?: boolean;
    }
  | { type: "unload"; correlationId: string }
  | {
      type: "generate";
      correlationId: string;
      prompt: string;
      stopSequences?: string[];
      maxTokens?: number;
      temperature?: number;
    }
  | { type: "embed"; correlationId: string; input: string }
  | { type: "ping"; at: number };

type DeviceOutbound =
  | {
      type: "register";
      payload: {
        deviceId: string;
        pairingToken?: string;
        capabilities: DeviceCapabilities;
        loadedPath: string | null;
      };
    }
  | { type: "loadResult"; correlationId: string; ok: true; loadedPath: string }
  | { type: "loadResult"; correlationId: string; ok: false; error: string }
  | { type: "unloadResult"; correlationId: string; ok: true }
  | { type: "unloadResult"; correlationId: string; ok: false; error: string }
  | {
      type: "generateResult";
      correlationId: string;
      ok: true;
      text: string;
      promptTokens: number;
      outputTokens: number;
      durationMs: number;
    }
  | { type: "generateResult"; correlationId: string; ok: false; error: string }
  | {
      type: "embedResult";
      correlationId: string;
      ok: true;
      embedding: number[];
      tokens: number;
    }
  | { type: "embedResult"; correlationId: string; ok: false; error: string }
  | { type: "pong"; at: number };

export interface DeviceBridgeClientConfig {
  /** Absolute WS URL of the agent: `wss://agent.example.com/api/local-inference/device-bridge`. */
  agentUrl: string;
  /** Shared pairing secret. Passed both as a `?token=` query param and in the register payload. */
  pairingToken?: string;
  /** Stable device identifier. Survives reinstalls when persisted by the host app. */
  deviceId: string;
  /** Called on state transitions so the host app can show a pairing UI. */
  onStateChange?: (
    state: "connecting" | "connected" | "disconnected" | "error",
    detail?: string,
  ) => void;
}

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const CONNECT_TIMEOUT_MS = 5_000;

export class DeviceBridgeClient {
  private socket: WebSocket | null = null;
  private reconnectAttempt = 0;
  private stopped = false;
  private readonly config: DeviceBridgeClientConfig;

  constructor(config: DeviceBridgeClientConfig) {
    this.config = config;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.socket) {
      try {
        this.socket.close(1000, "client-stop");
      } catch {
        /* best effort */
      }
      this.socket = null;
    }
  }

  private computeBackoffMs(): number {
    const exp = Math.min(
      MAX_BACKOFF_MS,
      INITIAL_BACKOFF_MS * 2 ** Math.min(this.reconnectAttempt, 6),
    );
    // Full jitter: uniform random in [0, exp).
    return Math.floor(Math.random() * exp);
  }

  private connect(): void {
    if (this.stopped) return;
    this.config.onStateChange?.("connecting");

    const url = this.buildUrl();
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.config.onStateChange?.(
        "error",
        err instanceof Error ? err.message : String(err),
      );
      this.scheduleReconnect();
      return;
    }
    this.socket = ws;
    let timedOut = false;
    const connectTimeout = setTimeout(() => {
      if (
        this.stopped ||
        this.socket !== ws ||
        ws.readyState !== WebSocket.CONNECTING
      ) {
        return;
      }
      timedOut = true;
      this.socket = null;
      this.config.onStateChange?.("error", "websocket connect timeout");
      try {
        ws.close();
      } catch {
        /* best effort */
      }
      this.scheduleReconnect();
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      clearTimeout(connectTimeout);
      this.reconnectAttempt = 0;
      void this.sendRegister(ws);
    };

    ws.onmessage = (event) => {
      let msg: AgentInbound;
      try {
        msg = JSON.parse(String(event.data)) as AgentInbound;
      } catch {
        return;
      }
      void this.handleAgentMessage(ws, msg);
    };

    ws.onerror = () => {
      this.config.onStateChange?.("error", "websocket error");
    };

    ws.onclose = () => {
      clearTimeout(connectTimeout);
      if (this.socket === ws) this.socket = null;
      this.config.onStateChange?.("disconnected");
      if (timedOut) return;
      this.scheduleReconnect();
    };
  }

  private buildUrl(): string {
    if (!this.config.pairingToken) return this.config.agentUrl;
    const hasQuery = this.config.agentUrl.includes("?");
    const sep = hasQuery ? "&" : "?";
    return `${this.config.agentUrl}${sep}token=${encodeURIComponent(
      this.config.pairingToken,
    )}`;
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = this.computeBackoffMs();
    this.reconnectAttempt += 1;
    setTimeout(() => this.connect(), delay);
  }

  private async sendRegister(ws: WebSocket): Promise<void> {
    const capacitorLlama = await loadCapacitorLlama();
    const hardware = await capacitorLlama.getHardwareInfo();
    const loaded = await capacitorLlama.isLoaded();
    const msg: DeviceOutbound = {
      type: "register",
      payload: {
        deviceId: this.config.deviceId,
        pairingToken: this.config.pairingToken,
        capabilities: {
          platform: hardware.platform,
          deviceModel: hardware.deviceModel,
          totalRamGb: hardware.totalRamGb,
          cpuCores: hardware.cpuCores,
          gpu: hardware.gpu,
        },
        loadedPath: loaded.modelPath,
      },
    };
    this.send(ws, msg);
    this.config.onStateChange?.("connected");
  }

  private send(ws: WebSocket, msg: DeviceOutbound): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(msg));
  }

  private async handleAgentMessage(
    ws: WebSocket,
    msg: AgentInbound,
  ): Promise<void> {
    if (msg.type === "ping") {
      this.send(ws, { type: "pong", at: Date.now() });
      return;
    }

    if (msg.type === "load") {
      try {
        const capacitorLlama = await loadCapacitorLlama();
        await capacitorLlama.load({
          modelPath: msg.modelPath,
          contextSize: msg.contextSize,
          useGpu: msg.useGpu,
        });
        this.send(ws, {
          type: "loadResult",
          correlationId: msg.correlationId,
          ok: true,
          loadedPath: msg.modelPath,
        });
      } catch (err) {
        this.send(ws, {
          type: "loadResult",
          correlationId: msg.correlationId,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    if (msg.type === "unload") {
      try {
        const capacitorLlama = await loadCapacitorLlama();
        await capacitorLlama.unload();
        this.send(ws, {
          type: "unloadResult",
          correlationId: msg.correlationId,
          ok: true,
        });
      } catch (err) {
        this.send(ws, {
          type: "unloadResult",
          correlationId: msg.correlationId,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    if (msg.type === "generate") {
      try {
        const capacitorLlama = await loadCapacitorLlama();
        const result = await capacitorLlama.generate({
          prompt: msg.prompt,
          stopSequences: msg.stopSequences,
          maxTokens: msg.maxTokens,
          temperature: msg.temperature,
        });
        this.send(ws, {
          type: "generateResult",
          correlationId: msg.correlationId,
          ok: true,
          text: result.text,
          promptTokens: result.promptTokens,
          outputTokens: result.outputTokens,
          durationMs: result.durationMs,
        });
      } catch (err) {
        this.send(ws, {
          type: "generateResult",
          correlationId: msg.correlationId,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    if (msg.type === "embed") {
      try {
        const capacitorLlama = await loadCapacitorLlama();
        const result = await capacitorLlama.embed({ input: msg.input });
        this.send(ws, {
          type: "embedResult",
          correlationId: msg.correlationId,
          ok: true,
          embedding: result.embedding,
          tokens: result.tokens,
        });
      } catch (err) {
        this.send(ws, {
          type: "embedResult",
          correlationId: msg.correlationId,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
  }
}

/**
 * Convenience helper for the mobile bootstrap: starts a bridge client
 * using values from the Eliza config or hardcoded env.
 *
 * The host app is expected to call this once during Capacitor bootstrap.
 * `agentUrl` and `pairingToken` come from the user's pairing flow and
 * should be persisted across launches.
 */
export function startDeviceBridgeClient(
  config: DeviceBridgeClientConfig,
): DeviceBridgeClient {
  const client = new DeviceBridgeClient(config);
  client.start();
  return client;
}

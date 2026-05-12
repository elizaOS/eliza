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
 *
 * Hardware probe (iOS):
 *   `llama-cpp-capacitor` does not implement `getHardwareInfo` on iOS,
 *   so the underlying adapter would return a fallback with
 *   `deviceModel="ios"`, `totalRamGb=0`, no GPU. That breaks
 *   `scoreDevice()` on the agent side — RAM gets a zero weighting and
 *   iOS never wins routing.
 *
 *   To fix this, the bridge client probes the host app's
 *   `ElizaIntent` / `ElizaIntent` Capacitor plugin (whichever is
 *   registered) for a `getDeviceCapabilities()` method and merges the
 *   real values (`utsname.machine`, `ProcessInfo.physicalMemory`,
 *   thermal state, low-power mode, OS version) into the register
 *   payload before we send. The merge takes precedence over the
 *   adapter fallback but is overridden by any field the native llama
 *   plugin does report — so when `llama-cpp-capacitor` gains real
 *   probe support, that path wins automatically.
 */

import { loadCapacitorLlama } from "./load-capacitor-llama";

interface DeviceCapabilities {
  platform: "ios" | "android" | "web";
  deviceModel: string;
  machineId?: string;
  osVersion?: string;
  isSimulator?: boolean;
  totalRamGb: number;
  availableRamGb?: number | null;
  freeStorageGb?: number | null;
  cpuCores: number;
  gpu: {
    backend: "metal" | "vulkan" | "gpu-delegate";
    available: boolean;
  } | null;
  gpuSupported?: boolean;
  lowPowerMode?: boolean;
  thermalState?: "nominal" | "fair" | "serious" | "critical" | "unknown";
  dflashSupported?: boolean;
  dflashReason?: string;
}

type AgentInbound =
  | {
      type: "load";
      correlationId: string;
      modelPath: string;
      contextSize?: number;
      useGpu?: boolean;
      maxThreads?: number;
      draftModelPath?: string;
      draftContextSize?: number;
      draftMin?: number;
      draftMax?: number;
      speculativeSamples?: number;
      mobileSpeculative?: boolean;
      cacheTypeK?: string;
      cacheTypeV?: string;
      disableThinking?: boolean;
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

/** Result returned by the iOS `ElizaIntent.getDeviceCapabilities()` /
 * `ElizaIntent.getDeviceCapabilities()` plugin method. Matches the Swift
 * `call.resolve([...])` shape — every field is optional from the JS side
 * because we feature-detect at runtime and want to tolerate older app
 * builds that ship without the method. */
interface NativeIosCapabilities {
  platform?: "ios";
  deviceModel?: string;
  machineId?: string;
  osVersion?: string;
  isSimulator?: boolean;
  totalRamGb?: number;
  availableRamGb?: number | null;
  cpuCores?: number;
  gpu?: { backend?: string; available?: boolean } | null;
  gpuSupported?: boolean;
  lowPowerMode?: boolean;
  thermalState?: "nominal" | "fair" | "serious" | "critical" | "unknown";
}

interface CapacitorBridge {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: Record<
    string,
    { getDeviceCapabilities?: () => Promise<NativeIosCapabilities> } | undefined
  >;
}

function getCapacitorBridge(): CapacitorBridge | undefined {
  return (globalThis as { Capacitor?: CapacitorBridge }).Capacitor;
}

/**
 * Probe the host iOS app for real device capabilities. Returns `null` on
 * non-iOS, non-native, or when the plugin is not registered (e.g. older
 * builds that ship without `getDeviceCapabilities`). Never throws — the
 * caller treats `null` as "nothing to merge".
 */
async function probeNativeIosCapabilities(): Promise<NativeIosCapabilities | null> {
  const cap = getCapacitorBridge();
  if (!cap?.isNativePlatform?.()) return null;
  if (cap.getPlatform?.() !== "ios") return null;
  const plugins = cap.Plugins ?? {};
  // Try the eliza-branded plugin first, then the legacy eliza-branded
  // one. Both ship with the same `getDeviceCapabilities` surface in this
  // repo; whichever is registered first wins.
  for (const name of ["ElizaIntent", "ElizaIntent"]) {
    const plugin = plugins[name];
    if (typeof plugin?.getDeviceCapabilities === "function") {
      try {
        return await plugin.getDeviceCapabilities();
      } catch {
        // Plugin call failed at runtime — fall through and try the next
        // candidate, then drop to null so the adapter fallback wins.
      }
    }
  }
  return null;
}

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

    // On iOS, `llama-cpp-capacitor` does not implement `getHardwareInfo`,
    // so the adapter returned a fallback with `deviceModel="ios"` /
    // `totalRamGb=0` / no `isSimulator` flag. Probe our own native
    // `ElizaIntent` plugin for real values and merge them on top of the
    // adapter result. The adapter fallback is the floor — when the
    // upstream plugin gains a real probe path that returns trustworthy
    // values (`source === "native"`), we let it win.
    const native = await probeNativeIosCapabilities();
    const useNativeOverride =
      native !== null && hardware.source !== "native";

    const platform = useNativeOverride
      ? (native?.platform ?? hardware.platform)
      : hardware.platform;
    const deviceModel = useNativeOverride
      ? (native?.deviceModel ?? hardware.deviceModel)
      : hardware.deviceModel;
    const machineId = useNativeOverride
      ? (native?.machineId ?? hardware.machineId)
      : hardware.machineId;
    const osVersion = useNativeOverride
      ? (native?.osVersion ?? hardware.osVersion)
      : hardware.osVersion;
    const isSimulator = useNativeOverride
      ? typeof native?.isSimulator === "boolean"
        ? native.isSimulator
        : hardware.isSimulator
      : hardware.isSimulator;
    const totalRamGb = useNativeOverride
      ? typeof native?.totalRamGb === "number" && native.totalRamGb > 0
        ? native.totalRamGb
        : hardware.totalRamGb
      : hardware.totalRamGb;
    const availableRamGb = useNativeOverride
      ? native?.availableRamGb !== undefined
        ? native.availableRamGb
        : hardware.availableRamGb
      : hardware.availableRamGb;
    const cpuCores = useNativeOverride
      ? typeof native?.cpuCores === "number" && native.cpuCores > 0
        ? native.cpuCores
        : hardware.cpuCores
      : hardware.cpuCores;
    const gpu = useNativeOverride
      ? native?.gpu && native.gpu.available
        ? ({
            backend:
              native.gpu.backend === "metal" ||
              native.gpu.backend === "vulkan" ||
              native.gpu.backend === "gpu-delegate"
                ? native.gpu.backend
                : "metal",
            available: true,
          } as const)
        : hardware.gpu
      : hardware.gpu;
    const gpuSupported = useNativeOverride
      ? typeof native?.gpuSupported === "boolean"
        ? native.gpuSupported
        : hardware.gpuSupported
      : hardware.gpuSupported;
    const lowPowerMode = useNativeOverride
      ? typeof native?.lowPowerMode === "boolean"
        ? native.lowPowerMode
        : hardware.lowPowerMode
      : hardware.lowPowerMode;
    const thermalState = useNativeOverride
      ? (native?.thermalState ?? hardware.thermalState)
      : hardware.thermalState;

    const msg: DeviceOutbound = {
      type: "register",
      payload: {
        deviceId: this.config.deviceId,
        pairingToken: this.config.pairingToken,
        capabilities: {
          platform,
          deviceModel,
          ...(machineId ? { machineId } : {}),
          ...(osVersion ? { osVersion } : {}),
          ...(typeof isSimulator === "boolean" ? { isSimulator } : {}),
          totalRamGb,
          availableRamGb,
          ...(typeof hardware.freeStorageGb === "number"
            ? { freeStorageGb: hardware.freeStorageGb }
            : {}),
          cpuCores,
          gpu,
          gpuSupported,
          ...(typeof lowPowerMode === "boolean" ? { lowPowerMode } : {}),
          ...(thermalState ? { thermalState } : {}),
          dflashSupported: hardware.dflashSupported,
          ...(hardware.dflashReason
            ? { dflashReason: hardware.dflashReason }
            : {}),
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
          maxThreads: msg.maxThreads,
          draftModelPath: msg.draftModelPath,
          draftContextSize: msg.draftContextSize,
          draftMin: msg.draftMin,
          draftMax: msg.draftMax,
          speculativeSamples: msg.speculativeSamples,
          mobileSpeculative: msg.mobileSpeculative,
          cacheTypeK: msg.cacheTypeK,
          cacheTypeV: msg.cacheTypeV,
          disableThinking: msg.disableThinking,
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

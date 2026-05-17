/**
 * Device-bridge: agent-side half of the "inference on the user's phone,
 * agent in a container" architecture.
 *
 * Multi-device aware. Any number of devices can dial in; each `generate`
 * is routed to the highest-scoring connected device at call time. A phone
 * and a Mac paired to the same agent → requests go to the Mac; when the
 * Mac disconnects, new requests fall through to the phone automatically.
 *
 * Scoring (higher = preferred):
 *   - desktop / electrobun: 100 base
 *   - ios / android:        10 base
 *   - per GB of total RAM:  +2
 *   - per GB of VRAM:       +5 (dedicated GPU wins big)
 *   - has loaded the right model already: +50 (avoid a swap)
 *
 * Disconnect tolerance
 * --------------------
 * A pending request stays in `pendingGenerates` until either (a) a device
 * (same or different) returns a matching correlation-id, or (b) the
 * timeout fires. On any device (re)connect we re-route orphaned
 * generates to the new best device.
 *
 * Durability
 * ----------
 * Pending requests are best-effort persisted to a JSON log under
 * `$ELIZA_STATE_DIR/local-inference/pending-requests.json` so a brief
 * agent restart doesn't lose the queue. Persistence is async and
 * non-blocking — failures fall back to in-memory only.
 */
import type { Server as HttpServer } from "node:http";
import type { AgentRuntime } from "@elizaos/core";
import type { LocalInferenceLoadArgs } from "./active-model";

interface DeviceCapabilities {
  platform: "ios" | "android" | "web" | "electrobun" | "desktop";
  deviceModel: string;
  machineId?: string;
  osVersion?: string;
  isSimulator?: boolean;
  totalRamGb: number;
  availableRamGb?: number | null;
  freeStorageGb?: number | null;
  cpuCores: number;
  gpu: {
    backend: "metal" | "vulkan" | "gpu-delegate" | "cuda";
    available: boolean;
    totalVramGb?: number;
  } | null;
  gpuSupported?: boolean;
  lowPowerMode?: boolean;
  thermalState?: "nominal" | "fair" | "serious" | "critical" | "unknown";
  dflashSupported?: boolean;
  dflashReason?: string;
}
export interface DeviceSummary {
  deviceId: string;
  capabilities: DeviceCapabilities;
  loadedPath: string | null;
  connectedSince: string;
  score: number;
  activeRequests: number;
  isPrimary: boolean;
}
export interface DeviceBridgeStatus {
  /** True if any device is currently connected. */
  connected: boolean;
  devices: DeviceSummary[];
  /** Device id of the current best-score device, or null when none. */
  primaryDeviceId: string | null;
  /** Total generates/loads/unloads queued (either in-flight or awaiting a device). */
  pendingRequests: number;
  deviceId: string | null;
  capabilities: DeviceCapabilities | null;
  loadedPath: string | null;
  connectedSince: string | null;
}
export declare class DeviceBridge {
  private readonly devices;
  private wss;
  private restored;
  private readonly pendingLoads;
  private readonly pendingUnloads;
  private readonly pendingGenerates;
  private readonly pendingEmbeds;
  private readonly statusListeners;
  private readonly expectedPairingToken;
  status(): DeviceBridgeStatus;
  private countRouted;
  subscribeStatus(listener: (status: DeviceBridgeStatus) => void): () => void;
  private emitStatus;
  attachToHttpServer(server: HttpServer): Promise<void>;
  private handleConnection;
  private onDeviceRegistered;
  private onDeviceDisconnected;
  private handleDeviceMessage;
  private sendToDevice;
  /** Highest-scoring connected device, optionally boosted for an already-loaded model. */
  private pickBestDevice;
  loadModel(args: LocalInferenceLoadArgs): Promise<void>;
  unloadModel(): Promise<void>;
  currentModelPath(): string | null;
  embed(args: { input: string }): Promise<{
    embedding: number[];
    tokens: number;
  }>;
  generate(args: {
    prompt: string;
    stopSequences?: string[];
    maxTokens?: number;
    temperature?: number;
  }): Promise<string>;
  private pendingLogPath;
  /**
   * Rewrite the pending-generate log. Called after every mutation to the
   * pendingGenerates map. We only persist `generate` — loads/unloads are
   * bound to a specific device's current state and aren't safely replayable
   * across restart.
   */
  private persistPendingGenerates;
  /**
   * On startup, read persisted pending requests back into memory. Their
   * promises are gone (the original caller's process is dead) so they can
   * only be resolved externally — for now we just re-queue them with a
   * fresh timeout, and the first device that connects will process them.
   * If nothing consumes them within the timeout they reject quietly.
   *
   * Stale entries older than 24h are purged rather than resurrected.
   */
  private restorePendingGenerates;
}
export declare const deviceBridge: DeviceBridge;
export declare function registerDeviceBridgeLoader(
  runtime: AgentRuntime & {
    registerService?: (name: string, impl: unknown) => unknown;
  },
): void;
//# sourceMappingURL=device-bridge.d.ts.map

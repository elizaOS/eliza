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

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";
import type { AgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import type {
  LocalInferenceLoadArgs,
  LocalInferenceLoader,
} from "./active-model";
import { localInferenceRoot } from "./paths";

const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const DEFAULT_LOAD_TIMEOUT_MS = 120_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const PENDING_LOG_FILENAME = "pending-requests.json";

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

interface DeviceRegistration {
  deviceId: string;
  pairingToken?: string;
  capabilities: DeviceCapabilities;
  loadedPath: string | null;
}

// Wire types — kept in sync by hand with the device-side bridge client.

type DeviceOutbound =
  | { type: "register"; payload: DeviceRegistration }
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

type AgentOutbound =
  | ({ type: "load"; correlationId: string } & LocalInferenceLoadArgs)
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

interface MinimalWebSocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: Buffer | string) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "pong", listener: () => void): unknown;
}

interface WsConstructor {
  readonly OPEN: number;
  readonly CLOSED: number;
}

interface WssInstance {
  handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    cb: (ws: MinimalWebSocket) => void,
  ): void;
  on(event: "error", listener: (err: Error) => void): unknown;
}

interface WssConstructor {
  new (options: { noServer: boolean; maxPayload?: number }): WssInstance;
}

interface WsModule {
  WebSocketServer: WssConstructor;
  WebSocket: WsConstructor;
}

interface PendingLoad {
  correlationId: string;
  modelPath: string;
  resolve: () => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  routedDeviceId: string;
}

interface PendingUnload {
  correlationId: string;
  resolve: () => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  routedDeviceId: string;
}

interface PendingGenerate {
  correlationId: string;
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  request: AgentOutbound;
  /**
   * Device the request was routed to most recently. On device disconnect
   * this is cleared; the request sits orphaned until another device
   * connects, at which point it's re-routed.
   */
  routedDeviceId: string | null;
  /** ISO timestamp captured on first submission; used to purge stale entries on restart. */
  submittedAt: string;
}

interface PendingEmbed {
  correlationId: string;
  resolve: (result: { embedding: number[]; tokens: number }) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  request: AgentOutbound;
  /** Same disconnect semantics as PendingGenerate — null when orphaned. */
  routedDeviceId: string | null;
  /**
   * ISO timestamp captured on first submission. Mirrors PendingGenerate
   * for symmetry; embeds are NOT persisted to disk (they're short-lived
   * and the caller's process holding the result promise has to be alive
   * for the answer to mean anything), so this field is purely
   * observational (status snapshots, debugging) today.
   */
  submittedAt: string;
}

interface ConnectedDevice {
  deviceId: string;
  socket: MinimalWebSocket;
  capabilities: DeviceCapabilities;
  loadedPath: string | null;
  connectedAt: number;
  lastHeartbeatAt: number;
  heartbeatTimer: ReturnType<typeof setInterval>;
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
  // Legacy single-device fields — kept for UI backward compat. These mirror
  // the primary device so old `DeviceBridgeStatusBar` code keeps working.
  deviceId: string | null;
  capabilities: DeviceCapabilities | null;
  loadedPath: string | null;
  connectedSince: string | null;
}

interface PersistedGenerateRequest {
  correlationId: string;
  request: AgentOutbound;
  submittedAt: string;
}

/**
 * Scoring function — pick the most powerful device available.
 * Pure, synchronous, and easy to test.
 */
function scoreDevice(
  device: ConnectedDevice,
  opts: { preferLoadedPath?: string } = {},
): number {
  const cap = device.capabilities;
  const platformBase =
    cap.platform === "desktop" || cap.platform === "electrobun"
      ? 100
      : cap.platform === "ios" || cap.platform === "android"
        ? 10
        : 0;
  const usableRamGb =
    typeof cap.availableRamGb === "number" && cap.availableRamGb > 0
      ? Math.min(
          cap.totalRamGb,
          Math.max(cap.availableRamGb, cap.totalRamGb * 0.6),
        )
      : cap.totalRamGb;
  const ramScore = usableRamGb * 2;
  const vramScore = cap.gpu?.available
    ? (cap.gpu.totalVramGb ?? cap.totalRamGb) * 5
    : 0;
  const healthPenalty =
    cap.lowPowerMode || cap.thermalState === "serious"
      ? 15
      : cap.thermalState === "critical"
        ? 100
        : 0;
  const loadedBonus =
    opts.preferLoadedPath && device.loadedPath === opts.preferLoadedPath
      ? 50
      : 0;
  return platformBase + ramScore + vramScore + loadedBonus - healthPenalty;
}

export class DeviceBridge {
  private readonly devices = new Map<string, ConnectedDevice>();
  private wss: WssInstance | null = null;
  private restored = false;

  private readonly pendingLoads = new Map<string, PendingLoad>();
  private readonly pendingUnloads = new Map<string, PendingUnload>();
  private readonly pendingGenerates = new Map<string, PendingGenerate>();
  private readonly pendingEmbeds = new Map<string, PendingEmbed>();

  private readonly statusListeners = new Set<
    (status: DeviceBridgeStatus) => void
  >();

  private readonly expectedPairingToken: string | null =
    process.env.ELIZA_DEVICE_PAIRING_TOKEN?.trim() || null;

  status(): DeviceBridgeStatus {
    const summaries: DeviceSummary[] = [];
    for (const device of this.devices.values()) {
      const score = scoreDevice(device);
      const activeRequests =
        this.countRouted(this.pendingGenerates, device.deviceId) +
        this.countRouted(this.pendingEmbeds, device.deviceId) +
        this.countRouted(this.pendingLoads, device.deviceId) +
        this.countRouted(this.pendingUnloads, device.deviceId);
      summaries.push({
        deviceId: device.deviceId,
        capabilities: device.capabilities,
        loadedPath: device.loadedPath,
        connectedSince: new Date(device.connectedAt).toISOString(),
        score,
        activeRequests,
        isPrimary: false,
      });
    }
    // Sort desc by score so the UI can just render in order.
    summaries.sort((a, b) => b.score - a.score);
    if (summaries[0]) summaries[0].isPrimary = true;

    const primary = summaries[0] ?? null;
    const pendingRequests =
      this.pendingGenerates.size +
      this.pendingEmbeds.size +
      this.pendingLoads.size +
      this.pendingUnloads.size;

    return {
      connected: summaries.length > 0,
      devices: summaries,
      primaryDeviceId: primary?.deviceId ?? null,
      pendingRequests,
      deviceId: primary?.deviceId ?? null,
      capabilities: primary?.capabilities ?? null,
      loadedPath: primary?.loadedPath ?? null,
      connectedSince: primary?.connectedSince ?? null,
    };
  }

  private countRouted<T extends { routedDeviceId: string | null }>(
    map: Map<string, T>,
    deviceId: string,
  ): number {
    let n = 0;
    for (const value of map.values()) {
      if (value.routedDeviceId === deviceId) n += 1;
    }
    return n;
  }

  subscribeStatus(listener: (status: DeviceBridgeStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  private emitStatus(): void {
    const snapshot = this.status();
    for (const listener of this.statusListeners) {
      try {
        listener(snapshot);
      } catch {
        this.statusListeners.delete(listener);
      }
    }
  }

  async attachToHttpServer(server: HttpServer): Promise<void> {
    if (this.wss) return;
    const ws = (await import("ws")) as unknown as WsModule;
    const wss = new ws.WebSocketServer({
      noServer: true,
      maxPayload: 1024 * 1024,
    });
    this.wss = wss;

    wss.on("error", (err) => {
      logger.warn("[device-bridge] WSS error:", err.message);
    });

    server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== "/api/local-inference/device-bridge") return;
      wss.handleUpgrade(request, socket, head, (client) => {
        this.handleConnection(client, ws.WebSocket, url);
      });
    });

    // Restore persisted pending generates the first time a server attaches.
    // We only restore once per process — avoids double-resubmit on repeated
    // server restarts inside the same worker.
    if (!this.restored) {
      this.restored = true;
      await this.restorePendingGenerates();
    }
  }

  private handleConnection(
    socket: MinimalWebSocket,
    WsCtor: WsConstructor,
    url: URL,
  ): void {
    const queryToken = url.searchParams.get("token")?.trim();
    if (this.expectedPairingToken && queryToken !== this.expectedPairingToken) {
      logger.warn("[device-bridge] Rejecting connection: bad query token");
      socket.close(4001, "unauthorized");
      return;
    }

    let registered = false;
    let registeredDeviceId: string | null = null;

    socket.on("message", (raw) => {
      let msg: DeviceOutbound;
      try {
        const text = typeof raw === "string" ? raw : raw.toString("utf8");
        msg = JSON.parse(text) as DeviceOutbound;
      } catch {
        logger.warn("[device-bridge] Ignoring non-JSON frame");
        return;
      }

      if (!registered) {
        if (msg.type !== "register") {
          logger.warn("[device-bridge] First frame must be register");
          socket.close(4002, "must-register-first");
          return;
        }
        if (
          this.expectedPairingToken &&
          msg.payload.pairingToken !== this.expectedPairingToken
        ) {
          logger.warn("[device-bridge] Rejecting register: bad pairing token");
          socket.close(4001, "unauthorized");
          return;
        }
        registered = true;
        registeredDeviceId = msg.payload.deviceId;
        this.onDeviceRegistered(socket, WsCtor, msg.payload);
        return;
      }

      this.handleDeviceMessage(msg);
    });

    socket.on("close", () => {
      if (!registered || !registeredDeviceId) return;
      // Only evict if THIS socket is still the current one for the
      // deviceId. When a newer connection supersedes us, its registration
      // already replaced the map entry; the delayed close event from our
      // superseded socket must not tear that down.
      const current = this.devices.get(registeredDeviceId);
      if (current && current.socket === socket) {
        this.onDeviceDisconnected(registeredDeviceId);
      }
    });

    socket.on("error", (err) => {
      logger.warn("[device-bridge] Socket error:", err.message);
    });
  }

  private onDeviceRegistered(
    socket: MinimalWebSocket,
    WsCtor: WsConstructor,
    registration: DeviceRegistration,
  ): void {
    // Supersede any existing connection under the same deviceId.
    const existing = this.devices.get(registration.deviceId);
    if (existing) {
      try {
        existing.socket.close(4003, "superseded");
      } catch {
        /* best effort */
      }
      clearInterval(existing.heartbeatTimer);
    }

    const device: ConnectedDevice = {
      deviceId: registration.deviceId,
      socket,
      capabilities: registration.capabilities,
      loadedPath: registration.loadedPath,
      connectedAt: Date.now(),
      lastHeartbeatAt: Date.now(),
      heartbeatTimer: setInterval(() => {
        if (socket.readyState !== WsCtor.OPEN) return;
        try {
          this.sendToDevice(device.deviceId, { type: "ping", at: Date.now() });
        } catch {
          /* ignore after close */
        }
      }, HEARTBEAT_INTERVAL_MS),
    };
    if (
      typeof device.heartbeatTimer === "object" &&
      device.heartbeatTimer &&
      "unref" in device.heartbeatTimer
    ) {
      (device.heartbeatTimer as { unref(): void }).unref();
    }
    this.devices.set(device.deviceId, device);

    logger.info(
      `[device-bridge] Device connected: ${device.deviceId} (${device.capabilities.platform}, score=${scoreDevice(device)})`,
    );

    // Re-route any orphaned generates (the ones whose prior routed device
    // disconnected). Load/unload orphans reject — device-specific state.
    for (const pending of this.pendingLoads.values()) {
      if (pending.routedDeviceId === device.deviceId) continue;
      if (!this.devices.has(pending.routedDeviceId)) {
        clearTimeout(pending.timeout);
        this.pendingLoads.delete(pending.correlationId);
        pending.reject(
          new Error("DEVICE_RECONNECTED: retry model load after reconnect"),
        );
      }
    }
    for (const pending of this.pendingUnloads.values()) {
      if (!this.devices.has(pending.routedDeviceId)) {
        clearTimeout(pending.timeout);
        this.pendingUnloads.delete(pending.correlationId);
        pending.reject(
          new Error("DEVICE_RECONNECTED: retry model unload after reconnect"),
        );
      }
    }

    for (const pending of this.pendingGenerates.values()) {
      if (pending.routedDeviceId === null) {
        const best = this.pickBestDevice();
        if (best) {
          pending.routedDeviceId = best.deviceId;
          try {
            this.sendToDevice(best.deviceId, pending.request);
          } catch (err) {
            pending.reject(
              err instanceof Error
                ? err
                : new Error("Failed to re-route after reconnect"),
            );
          }
        }
      }
    }

    // Same re-route logic for orphaned embeds. Embeds are short-lived and
    // idempotent (the device just runs llama_get_embeddings), so we can
    // safely retarget them on reconnect.
    for (const pending of this.pendingEmbeds.values()) {
      if (pending.routedDeviceId === null) {
        const best = this.pickBestDevice();
        if (best) {
          pending.routedDeviceId = best.deviceId;
          try {
            this.sendToDevice(best.deviceId, pending.request);
          } catch (err) {
            pending.reject(
              err instanceof Error
                ? err
                : new Error("Failed to re-route after reconnect"),
            );
          }
        }
      }
    }

    this.emitStatus();
  }

  private onDeviceDisconnected(deviceId: string): void {
    const device = this.devices.get(deviceId);
    if (!device) return;
    clearInterval(device.heartbeatTimer);
    this.devices.delete(deviceId);

    // Orphan any generates / embeds routed to this device so they can be
    // re-routed to a surviving device (or await a reconnect).
    let orphaned = 0;
    for (const pending of this.pendingGenerates.values()) {
      if (pending.routedDeviceId === deviceId) {
        pending.routedDeviceId = null;
        orphaned += 1;
      }
    }
    for (const pending of this.pendingEmbeds.values()) {
      if (pending.routedDeviceId === deviceId) {
        pending.routedDeviceId = null;
        orphaned += 1;
      }
    }

    logger.info(
      `[device-bridge] Device disconnected: ${deviceId}; ${orphaned} request(s) orphaned`,
    );

    // Fast-path: if there are other connected devices, re-route now.
    if (this.devices.size > 0) {
      for (const pending of this.pendingGenerates.values()) {
        if (pending.routedDeviceId === null) {
          const best = this.pickBestDevice();
          if (best) {
            pending.routedDeviceId = best.deviceId;
            try {
              this.sendToDevice(best.deviceId, pending.request);
            } catch {
              /* will be retried on the next reconnect */
            }
          }
        }
      }
      for (const pending of this.pendingEmbeds.values()) {
        if (pending.routedDeviceId === null) {
          const best = this.pickBestDevice();
          if (best) {
            pending.routedDeviceId = best.deviceId;
            try {
              this.sendToDevice(best.deviceId, pending.request);
            } catch {
              /* will be retried on the next reconnect */
            }
          }
        }
      }
    }

    this.emitStatus();
  }

  private handleDeviceMessage(msg: DeviceOutbound): void {
    if (msg.type === "pong") {
      // Heartbeat round-trip — could update lastHeartbeatAt per device, but
      // we don't currently use it for eviction.
      return;
    }

    if (msg.type === "loadResult") {
      const pending = this.pendingLoads.get(msg.correlationId);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pendingLoads.delete(msg.correlationId);
      if (msg.ok === false) {
        pending.reject(new Error(msg.error));
      } else {
        const device = this.devices.get(pending.routedDeviceId);
        if (device) device.loadedPath = msg.loadedPath;
        pending.resolve();
        this.emitStatus();
      }
      return;
    }

    if (msg.type === "unloadResult") {
      const pending = this.pendingUnloads.get(msg.correlationId);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pendingUnloads.delete(msg.correlationId);
      if (msg.ok === false) {
        pending.reject(new Error(msg.error));
      } else {
        const device = this.devices.get(pending.routedDeviceId);
        if (device) device.loadedPath = null;
        pending.resolve();
        this.emitStatus();
      }
      return;
    }

    if (msg.type === "generateResult") {
      const pending = this.pendingGenerates.get(msg.correlationId);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pendingGenerates.delete(msg.correlationId);
      // Best-effort purge the persisted copy.
      void this.persistPendingGenerates();
      if (msg.ok === false) {
        pending.reject(new Error(msg.error));
      } else {
        pending.resolve(msg.text);
      }
      return;
    }

    if (msg.type === "embedResult") {
      const pending = this.pendingEmbeds.get(msg.correlationId);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pendingEmbeds.delete(msg.correlationId);
      if (msg.ok === false) {
        pending.reject(new Error(msg.error));
      } else {
        pending.resolve({ embedding: msg.embedding, tokens: msg.tokens });
      }
      return;
    }
  }

  private sendToDevice(deviceId: string, msg: AgentOutbound): void {
    const device = this.devices.get(deviceId);
    if (!device) throw new Error(`DEVICE_DISCONNECTED: ${deviceId}`);
    device.socket.send(JSON.stringify(msg));
  }

  /** Highest-scoring connected device, optionally boosted for an already-loaded model. */
  private pickBestDevice(opts?: {
    preferLoadedPath?: string;
  }): ConnectedDevice | null {
    let best: ConnectedDevice | null = null;
    let bestScore = -Infinity;
    for (const device of this.devices.values()) {
      const score = scoreDevice(device, opts);
      if (score > bestScore) {
        best = device;
        bestScore = score;
      }
    }
    return best;
  }

  // ── LocalInferenceLoader surface ──────────────────────────────────────

  async loadModel(args: LocalInferenceLoadArgs): Promise<void> {
    const best = this.pickBestDevice({ preferLoadedPath: args.modelPath });
    if (!best) {
      throw new Error(
        "DEVICE_DISCONNECTED: no mobile / desktop bridge device attached",
      );
    }
    const correlationId = randomUUID();
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingLoads.delete(correlationId);
        reject(new Error("DEVICE_TIMEOUT: model load exceeded deadline"));
      }, DEFAULT_LOAD_TIMEOUT_MS);
      if (typeof timeout === "object" && timeout && "unref" in timeout) {
        (timeout as { unref(): void }).unref();
      }
      this.pendingLoads.set(correlationId, {
        correlationId,
        modelPath: args.modelPath,
        resolve,
        reject,
        timeout,
        routedDeviceId: best.deviceId,
      });
      try {
        this.sendToDevice(best.deviceId, {
          type: "load",
          correlationId,
          ...args,
        });
      } catch (err) {
        clearTimeout(timeout);
        this.pendingLoads.delete(correlationId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async unloadModel(): Promise<void> {
    // Unload every device that currently has a model loaded. Best-effort —
    // individual failures don't block the others.
    const targets = [...this.devices.values()].filter((d) => d.loadedPath);
    if (targets.length === 0) return;
    await Promise.allSettled(
      targets.map(
        (device) =>
          new Promise<void>((resolve, reject) => {
            const correlationId = randomUUID();
            const timeout = setTimeout(() => {
              this.pendingUnloads.delete(correlationId);
              reject(new Error("DEVICE_TIMEOUT: unload exceeded deadline"));
            }, DEFAULT_CALL_TIMEOUT_MS);
            if (typeof timeout === "object" && timeout && "unref" in timeout) {
              (timeout as { unref(): void }).unref();
            }
            this.pendingUnloads.set(correlationId, {
              correlationId,
              resolve,
              reject,
              timeout,
              routedDeviceId: device.deviceId,
            });
            try {
              this.sendToDevice(device.deviceId, {
                type: "unload",
                correlationId,
              });
            } catch (err) {
              clearTimeout(timeout);
              this.pendingUnloads.delete(correlationId);
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          }),
      ),
    );
  }

  currentModelPath(): string | null {
    // The primary device's loaded path wins — consistent with which device
    // would actually run the next generate.
    const best = this.pickBestDevice();
    return best?.loadedPath ?? null;
  }

  async embed(args: {
    input: string;
  }): Promise<{ embedding: number[]; tokens: number }> {
    const envTimeout = Number.parseInt(
      process.env.ELIZA_DEVICE_GENERATE_TIMEOUT_MS?.trim() ?? "",
      10,
    );
    const timeoutMs =
      Number.isFinite(envTimeout) && envTimeout > 0
        ? envTimeout
        : DEFAULT_CALL_TIMEOUT_MS;

    const correlationId = randomUUID();
    const request: AgentOutbound = {
      type: "embed",
      correlationId,
      input: args.input,
    };

    const best = this.pickBestDevice();

    return new Promise<{ embedding: number[]; tokens: number }>(
      (resolve, reject) => {
        const timeout = setTimeout(() => {
          this.pendingEmbeds.delete(correlationId);
          reject(
            new Error(
              `DEVICE_TIMEOUT: no device responded to embed within ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs);
        if (typeof timeout === "object" && timeout && "unref" in timeout) {
          (timeout as { unref(): void }).unref();
        }
        const pending: PendingEmbed = {
          correlationId,
          resolve,
          reject,
          timeout,
          request,
          routedDeviceId: best?.deviceId ?? null,
          submittedAt: new Date().toISOString(),
        };
        this.pendingEmbeds.set(correlationId, pending);

        if (best) {
          try {
            this.sendToDevice(best.deviceId, request);
          } catch {
            // Routed device went away between pickBestDevice and send.
            // Mark as orphaned; reroute logic will pick it up on the next
            // device (re)connect.
            pending.routedDeviceId = null;
          }
        } else {
          logger.debug(
            `[device-bridge] No device available; parking embed ${correlationId} pending connection`,
          );
        }
      },
    );
  }

  async generate(args: {
    prompt: string;
    stopSequences?: string[];
    maxTokens?: number;
    temperature?: number;
  }): Promise<string> {
    const envTimeout = Number.parseInt(
      process.env.ELIZA_DEVICE_GENERATE_TIMEOUT_MS?.trim() ?? "",
      10,
    );
    const timeoutMs =
      Number.isFinite(envTimeout) && envTimeout > 0
        ? envTimeout
        : DEFAULT_CALL_TIMEOUT_MS;

    const correlationId = randomUUID();
    const request: AgentOutbound = {
      type: "generate",
      correlationId,
      prompt: args.prompt,
      stopSequences: args.stopSequences,
      maxTokens: args.maxTokens,
      temperature: args.temperature,
    };

    const best = this.pickBestDevice();

    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingGenerates.delete(correlationId);
        void this.persistPendingGenerates();
        reject(
          new Error(
            `DEVICE_TIMEOUT: no device responded within ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      if (typeof timeout === "object" && timeout && "unref" in timeout) {
        (timeout as { unref(): void }).unref();
      }
      const pending: PendingGenerate = {
        correlationId,
        resolve,
        reject,
        timeout,
        request,
        routedDeviceId: best?.deviceId ?? null,
        submittedAt: new Date().toISOString(),
      };
      this.pendingGenerates.set(correlationId, pending);
      void this.persistPendingGenerates();

      if (best) {
        try {
          this.sendToDevice(best.deviceId, request);
        } catch {
          pending.routedDeviceId = null;
        }
      } else {
        logger.debug(
          `[device-bridge] No device available; parking generate ${correlationId} pending connection`,
        );
      }
    });
  }

  // ── Durability ────────────────────────────────────────────────────────

  private pendingLogPath(): string {
    return path.join(localInferenceRoot(), PENDING_LOG_FILENAME);
  }

  /**
   * Rewrite the pending-generate log. Called after every mutation to the
   * pendingGenerates map. We only persist `generate` — loads/unloads are
   * bound to a specific device's current state and aren't safely replayable
   * across restart.
   */
  private async persistPendingGenerates(): Promise<void> {
    try {
      await fs.mkdir(localInferenceRoot(), { recursive: true });
      const payload: PersistedGenerateRequest[] = [
        ...this.pendingGenerates.values(),
      ].map((p) => ({
        correlationId: p.correlationId,
        request: p.request,
        submittedAt: p.submittedAt,
      }));
      const tmp = `${this.pendingLogPath()}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
      await fs.rename(tmp, this.pendingLogPath());
    } catch (err) {
      logger.debug(
        "[device-bridge] Failed to persist pending generates:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * On startup, read persisted pending requests back into memory. Their
   * promises are gone (the original caller's process is dead) so they can
   * only be resolved externally — for now we just re-queue them with a
   * fresh timeout, and the first device that connects will process them.
   * If nothing consumes them within the timeout they reject quietly.
   *
   * Stale entries older than 24h are purged rather than resurrected.
   */
  private async restorePendingGenerates(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.pendingLogPath(), "utf8");
    } catch {
      return;
    }
    let items: PersistedGenerateRequest[];
    try {
      items = JSON.parse(raw) as PersistedGenerateRequest[];
      if (!Array.isArray(items)) return;
    } catch {
      return;
    }
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    let restored = 0;
    for (const item of items) {
      if (
        !item.correlationId ||
        !item.request ||
        item.request.type !== "generate"
      ) {
        continue;
      }
      const submittedAt = Date.parse(item.submittedAt);
      if (!Number.isFinite(submittedAt) || submittedAt < cutoff) continue;
      if (this.pendingGenerates.has(item.correlationId)) continue;

      // The original caller's promise is gone. Queue the request so the
      // first connecting device processes it; if nobody picks it up within
      // the default timeout, drop it.
      const timeout = setTimeout(() => {
        this.pendingGenerates.delete(item.correlationId);
        void this.persistPendingGenerates();
      }, DEFAULT_CALL_TIMEOUT_MS);
      if (typeof timeout === "object" && timeout && "unref" in timeout) {
        (timeout as { unref(): void }).unref();
      }
      this.pendingGenerates.set(item.correlationId, {
        correlationId: item.correlationId,
        request: item.request,
        submittedAt: item.submittedAt,
        routedDeviceId: null,
        timeout,
        resolve: () => {
          /* no caller to resolve */
        },
        reject: () => {
          /* no caller to reject */
        },
      });
      restored += 1;
    }
    if (restored > 0) {
      logger.info(
        `[device-bridge] Restored ${restored} pending generate(s) from persistent log`,
      );
    }
  }
}

export const deviceBridge = new DeviceBridge();

export function registerDeviceBridgeLoader(
  runtime: AgentRuntime & {
    registerService?: (name: string, impl: unknown) => unknown;
  },
): void {
  if (typeof runtime.registerService !== "function") return;
  const loader: LocalInferenceLoader = {
    async loadModel(args: LocalInferenceLoadArgs) {
      await deviceBridge.loadModel(args);
    },
    async unloadModel() {
      await deviceBridge.unloadModel();
    },
    currentModelPath() {
      return deviceBridge.currentModelPath();
    },
    async generate(args) {
      return deviceBridge.generate(args);
    },
    async embed(args) {
      return deviceBridge.embed(args);
    },
  };
  runtime.registerService("localInferenceLoader", loader);
  logger.info(
    "[device-bridge] Registered device-bridge loader for remote on-device inference",
  );
}

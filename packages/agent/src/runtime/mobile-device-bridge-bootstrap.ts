/**
 * Stock Capacitor mobile local-inference bridge.
 *
 * AOSP builds run llama.cpp inside the agent process via bun:ffi. Stock
 * Capacitor Android/iOS builds cannot do that: llama.cpp is exposed to the
 * WebView through the native Capacitor plugin. This module is the agent-side
 * half of that path. It accepts a loopback WebSocket from the WebView,
 * forwards TEXT_SMALL / TEXT_LARGE requests to the device, and lets the
 * normal conversation routes keep using runtime model handlers.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";
import {
  type AgentRuntime,
  type GenerateTextParams,
  type IAgentRuntime,
  logger,
  ModelType,
  type TextEmbeddingParams,
} from "@elizaos/core";

const DEVICE_BRIDGE_PATH = "/api/local-inference/device-bridge";
const PROVIDER = "capacitor-llama";
const LOCAL_INFERENCE_PRIORITY = 0;
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const DEFAULT_LOAD_TIMEOUT_MS = 180_000;
const SERVICE_ENABLED = process.env.ELIZA_DEVICE_BRIDGE_ENABLED?.trim() === "1";
const registeredRuntimes = new WeakSet<AgentRuntime>();
const KNOWN_EMBEDDING_DIMENSIONS: Record<string, number> = {
  "bge-small-en-v1.5": 384,
};

const DFLASH_LOAD_METADATA: Record<
  string,
  {
    drafterModelId: string;
    contextSize: number;
    draftContextSize: number;
    draftMin: number;
    draftMax: number;
    disableThinking: boolean;
  }
> = {
  "qwen3.5-4b-dflash": {
    drafterModelId: "qwen3.5-4b-dflash-drafter-q4",
    contextSize: 8192,
    draftContextSize: 256,
    draftMin: 1,
    draftMax: 16,
    disableThinking: true,
  },
  "qwen3.5-9b-dflash": {
    drafterModelId: "qwen3.5-9b-dflash-drafter-q4",
    contextSize: 8192,
    draftContextSize: 256,
    draftMin: 1,
    draftMax: 16,
    disableThinking: true,
  },
  "qwen3.6-27b-dflash": {
    drafterModelId: "qwen3.6-27b-dflash-drafter-q8",
    contextSize: 8192,
    draftContextSize: 256,
    draftMin: 1,
    draftMax: 16,
    disableThinking: true,
  },
};

type GenerateTextHandler = (
  runtime: IAgentRuntime,
  params: GenerateTextParams,
) => Promise<string>;

type EmbeddingHandler = (
  runtime: IAgentRuntime,
  params: TextEmbeddingParams | string | null,
) => Promise<number[]>;

interface LocalInferenceLoadArgs {
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

type RuntimeWithModelRegistration = AgentRuntime & {
  getModel: (
    modelType: string | number,
  ) => GenerateTextHandler | EmbeddingHandler | undefined;
  registerModel: (
    modelType: string | number,
    handler: GenerateTextHandler | EmbeddingHandler,
    provider: string,
    priority?: number,
  ) => void;
};

interface MinimalWebSocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: Buffer | string) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
}

interface WsConstructor {
  readonly OPEN: number;
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

interface WsModule {
  WebSocketServer: new (options: {
    noServer: boolean;
    maxPayload?: number;
  }) => WssInstance;
  WebSocket: WsConstructor;
}

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

interface ConnectedDevice {
  deviceId: string;
  socket: MinimalWebSocket;
  capabilities: DeviceCapabilities;
  loadedPath: string | null;
  connectedAt: number;
}

interface Pending<T> {
  resolve: (value: T) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  routedDeviceId: string;
}

interface RegistryModelEntry {
  id?: unknown;
  path?: unknown;
  dimensions?: unknown;
  embeddingDimension?: unknown;
  embeddingDimensions?: unknown;
}

interface RegistryFile {
  version?: number;
  models?: RegistryModelEntry[];
}

interface AssignmentsFile {
  version?: number;
  assignments?: Record<string, unknown>;
}

interface BundledModelManifestEntry {
  ggufFile?: string;
  filename?: string;
  role?: "chat" | "embedding";
}

interface BundledModelManifest {
  models?: BundledModelManifestEntry[];
}

export interface MobileDeviceBridgeStatus {
  enabled: boolean;
  connected: boolean;
  devices: Array<{
    deviceId: string;
    capabilities: DeviceCapabilities;
    loadedPath: string | null;
    connectedSince: string;
  }>;
  primaryDeviceId: string | null;
  pendingRequests: number;
  modelPath: string | null;
}

class MobileDeviceBridge {
  private wss: WssInstance | null = null;
  private readonly devices = new Map<string, ConnectedDevice>();
  private readonly pendingLoads = new Map<string, Pending<void>>();
  private readonly pendingUnloads = new Map<string, Pending<void>>();
  private readonly pendingGenerates = new Map<string, Pending<string>>();
  private readonly pendingEmbeds = new Map<string, Pending<number[]>>();

  status(): MobileDeviceBridgeStatus {
    const devices = [...this.devices.values()].map((device) => ({
      deviceId: device.deviceId,
      capabilities: device.capabilities,
      loadedPath: device.loadedPath,
      connectedSince: new Date(device.connectedAt).toISOString(),
    }));
    return {
      enabled: SERVICE_ENABLED,
      connected: devices.length > 0,
      devices,
      primaryDeviceId: devices[0]?.deviceId ?? null,
      pendingRequests:
        this.pendingLoads.size +
        this.pendingUnloads.size +
        this.pendingGenerates.size +
        this.pendingEmbeds.size,
      modelPath: resolveLocalModelPath("TEXT_LARGE"),
    };
  }

  async attachToHttpServer(server: HttpServer): Promise<void> {
    if (!SERVICE_ENABLED || this.wss) return;
    const ws: WsModule = await import("ws");
    const wss = new ws.WebSocketServer({
      noServer: true,
      maxPayload: 1024 * 1024,
    });
    this.wss = wss;

    wss.on("error", (err) => {
      logger.warn("[mobile-device-bridge] WSS error:", err.message);
    });

    server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== DEVICE_BRIDGE_PATH) return;
      wss.handleUpgrade(request, socket, head, (client) => {
        this.handleConnection(client, ws.WebSocket);
      });
    });

    logger.info(
      `[mobile-device-bridge] Listening for Capacitor device bridge at ${DEVICE_BRIDGE_PATH}`,
    );
  }

  private handleConnection(socket: MinimalWebSocket, WsCtor: WsConstructor) {
    let registeredDeviceId: string | null = null;

    socket.on("message", (raw) => {
      let msg: DeviceOutbound;
      try {
        const text = typeof raw === "string" ? raw : raw.toString("utf8");
        msg = JSON.parse(text) as DeviceOutbound;
      } catch {
        logger.warn("[mobile-device-bridge] Ignoring non-JSON frame");
        return;
      }

      if (!registeredDeviceId) {
        if (msg.type !== "register") {
          socket.close(4002, "must-register-first");
          return;
        }
        registeredDeviceId = msg.payload.deviceId;
        this.devices.set(registeredDeviceId, {
          deviceId: registeredDeviceId,
          socket,
          capabilities: msg.payload.capabilities,
          loadedPath: msg.payload.loadedPath,
          connectedAt: Date.now(),
        });
        logger.info(
          `[mobile-device-bridge] Device connected: ${registeredDeviceId} (${msg.payload.capabilities.platform})`,
        );
        return;
      }

      this.handleDeviceMessage(msg);
    });

    socket.on("close", () => {
      if (!registeredDeviceId) return;
      const current = this.devices.get(registeredDeviceId);
      if (current?.socket === socket) {
        this.devices.delete(registeredDeviceId);
        logger.info(
          `[mobile-device-bridge] Device disconnected: ${registeredDeviceId}`,
        );
      }
    });

    socket.on("error", (err) => {
      logger.warn("[mobile-device-bridge] Socket error:", err.message);
    });

    const heartbeat = setInterval(() => {
      if (!registeredDeviceId || socket.readyState !== WsCtor.OPEN) return;
      try {
        socket.send(JSON.stringify({ type: "ping", at: Date.now() }));
      } catch {
        clearInterval(heartbeat);
      }
    }, 15_000);
    if (typeof heartbeat === "object" && "unref" in heartbeat) {
      (heartbeat as { unref(): void }).unref();
    }
  }

  private handleDeviceMessage(msg: DeviceOutbound): void {
    if (msg.type === "pong" || msg.type === "register") return;

    if (msg.type === "loadResult") {
      const pending = this.pendingLoads.get(msg.correlationId);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pendingLoads.delete(msg.correlationId);
      if (msg.ok === true) {
        const device = this.devices.get(pending.routedDeviceId);
        if (device) device.loadedPath = msg.loadedPath;
        pending.resolve(undefined);
      } else {
        pending.reject(new Error(msg.error));
      }
      return;
    }

    if (msg.type === "unloadResult") {
      const pending = this.pendingUnloads.get(msg.correlationId);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pendingUnloads.delete(msg.correlationId);
      if (msg.ok === true) {
        const device = this.devices.get(pending.routedDeviceId);
        if (device) device.loadedPath = null;
        pending.resolve(undefined);
      } else {
        pending.reject(new Error(msg.error));
      }
      return;
    }

    if (msg.type === "generateResult") {
      const pending = this.pendingGenerates.get(msg.correlationId);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pendingGenerates.delete(msg.correlationId);
      if (msg.ok === true) {
        pending.resolve(msg.text);
      } else {
        pending.reject(new Error(msg.error));
      }
      return;
    }

    if (msg.type === "embedResult") {
      const pending = this.pendingEmbeds.get(msg.correlationId);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pendingEmbeds.delete(msg.correlationId);
      if (msg.ok === true) {
        pending.resolve(msg.embedding);
      } else {
        pending.reject(new Error(msg.error));
      }
    }
  }

  private primaryDevice(): ConnectedDevice | null {
    return this.devices.values().next().value ?? null;
  }

  private sendToPrimary<T>(
    pendingMap: Map<string, Pending<T>>,
    makeMessage: (correlationId: string) => AgentOutbound,
    timeoutMs: number,
    timeoutMessage: string,
  ): Promise<T> {
    const device = this.primaryDevice();
    if (!device) {
      return Promise.reject(
        new Error(
          "DEVICE_DISCONNECTED: no Capacitor llama device bridge attached",
        ),
      );
    }

    const correlationId = randomUUID();
    const message = makeMessage(correlationId);

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingMap.delete(correlationId);
        reject(new Error(timeoutMessage));
      }, timeoutMs);
      if (typeof timeout === "object" && "unref" in timeout) {
        (timeout as { unref(): void }).unref();
      }
      pendingMap.set(correlationId, {
        resolve,
        reject,
        timeout,
        routedDeviceId: device.deviceId,
      });
      try {
        device.socket.send(JSON.stringify(message));
      } catch (err) {
        clearTimeout(timeout);
        pendingMap.delete(correlationId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async loadModel(args: LocalInferenceLoadArgs): Promise<void> {
    const device = this.primaryDevice();
    if (device?.loadedPath === args.modelPath) return;
    return this.sendToPrimary<void>(
      this.pendingLoads,
      (correlationId) => ({
        type: "load",
        correlationId,
        ...args,
      }),
      readTimeoutMs("ELIZA_DEVICE_LOAD_TIMEOUT_MS", DEFAULT_LOAD_TIMEOUT_MS),
      "DEVICE_TIMEOUT: model load exceeded deadline",
    );
  }

  async unloadModel(): Promise<void> {
    const device = this.primaryDevice();
    if (!device?.loadedPath) return;
    return this.sendToPrimary<void>(
      this.pendingUnloads,
      (correlationId) => ({ type: "unload", correlationId }),
      readTimeoutMs(
        "ELIZA_DEVICE_GENERATE_TIMEOUT_MS",
        DEFAULT_CALL_TIMEOUT_MS,
      ),
      "DEVICE_TIMEOUT: unload exceeded deadline",
    );
  }

  generate(args: {
    prompt: string;
    stopSequences?: string[];
    maxTokens?: number;
    temperature?: number;
  }): Promise<string> {
    return this.sendToPrimary<string>(
      this.pendingGenerates,
      (correlationId) => ({
        type: "generate",
        correlationId,
        prompt: args.prompt,
        stopSequences: args.stopSequences,
        maxTokens: args.maxTokens,
        temperature: args.temperature,
      }),
      readTimeoutMs(
        "ELIZA_DEVICE_GENERATE_TIMEOUT_MS",
        DEFAULT_CALL_TIMEOUT_MS,
      ),
      "DEVICE_TIMEOUT: no device responded within deadline",
    );
  }

  embed(args: { input: string }): Promise<number[]> {
    return this.sendToPrimary<number[]>(
      this.pendingEmbeds,
      (correlationId) => ({
        type: "embed",
        correlationId,
        input: args.input,
      }),
      readTimeoutMs("ELIZA_DEVICE_EMBED_TIMEOUT_MS", DEFAULT_CALL_TIMEOUT_MS),
      "DEVICE_TIMEOUT: no device returned embeddings within deadline",
    );
  }
}

export const mobileDeviceBridge = new MobileDeviceBridge();

function readTimeoutMs(envKey: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[envKey]?.trim() ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveStateDir(): string {
  const explicit = process.env.ELIZA_STATE_DIR?.trim();
  if (explicit) return explicit;
  const home = process.env.HOME ?? process.cwd();
  return path.join(home, ".eliza");
}

function modelsDir(): string {
  return path.join(resolveStateDir(), "local-inference", "models");
}

function registryPath(): string {
  return path.join(resolveStateDir(), "local-inference", "registry.json");
}

function assignmentsPath(): string {
  return path.join(resolveStateDir(), "local-inference", "assignments.json");
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function positiveInteger(value: unknown): number | null {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function resolveFromEnv(slot: string): string | null {
  const key =
    slot === "TEXT_EMBEDDING"
      ? "ELIZA_LOCAL_EMBEDDING_MODEL_PATH"
      : "ELIZA_LOCAL_CHAT_MODEL_PATH";
  const specific = process.env[key]?.trim();
  if (specific && existsSync(specific)) return specific;
  const fallback = process.env.ELIZA_LOCAL_MODEL_PATH?.trim();
  if (fallback && existsSync(fallback)) return fallback;
  return null;
}

function resolveFromRegistry(slot: string): string | null {
  const assignments = readJsonFile<AssignmentsFile>(
    assignmentsPath(),
  )?.assignments;
  const assigned = assignments?.[slot];
  if (typeof assigned !== "string" || !assigned.trim()) return null;

  const models = readRegistryModels();
  const matched = models.find((model) => model.id === assigned);
  return typeof matched?.path === "string" && existsSync(matched.path)
    ? matched.path
    : null;
}

function readRegistryModels(): RegistryModelEntry[] {
  return readJsonFile<RegistryFile>(registryPath())?.models ?? [];
}

function resolveAssignedRegistryModel(slot: string): {
  id: string;
  path: string;
  dimensions?: unknown;
  embeddingDimension?: unknown;
  embeddingDimensions?: unknown;
} | null {
  const assignments = readJsonFile<AssignmentsFile>(
    assignmentsPath(),
  )?.assignments;
  const assigned = assignments?.[slot];
  if (typeof assigned !== "string" || !assigned.trim()) return null;

  const models = readRegistryModels();
  const matched = models.find((model) => model.id === assigned);
  if (typeof matched?.path !== "string" || !existsSync(matched.path)) {
    return null;
  }
  return {
    id: assigned,
    path: matched.path,
    dimensions: matched.dimensions,
    embeddingDimension: matched.embeddingDimension,
    embeddingDimensions: matched.embeddingDimensions,
  };
}

function resolveRegistryModelById(id: string): {
  id: string;
  path: string;
} | null {
  const matched = readRegistryModels().find((model) => model.id === id);
  if (typeof matched?.path !== "string" || !existsSync(matched.path)) {
    return null;
  }
  return { id, path: matched.path };
}

function resolveFromManifest(slot: string): string | null {
  const manifest = readJsonFile<BundledModelManifest>(
    path.join(modelsDir(), "manifest.json"),
  );
  const targetRole = slot === "TEXT_EMBEDDING" ? "embedding" : "chat";
  for (const entry of manifest?.models ?? []) {
    if (entry.role !== targetRole) continue;
    const fileName = entry.ggufFile ?? entry.filename;
    if (!fileName) continue;
    const absolute = path.join(modelsDir(), fileName);
    if (existsSync(absolute)) return absolute;
  }
  return null;
}

function resolveFirstGguf(): string | null {
  const dir = modelsDir();
  if (!existsSync(dir)) return null;
  for (const name of readdirSync(dir)) {
    if (!name.toLowerCase().endsWith(".gguf")) continue;
    const absolute = path.join(dir, name);
    if (existsSync(absolute)) return absolute;
  }
  return null;
}

function resolveLocalModelPath(slot: string): string | null {
  return (
    resolveFromEnv(slot) ??
    resolveFromRegistry(slot) ??
    resolveFromManifest(slot) ??
    resolveFirstGguf()
  );
}

function buildLoadArgsFromRegistryModel(model: {
  id: string;
  path: string;
}): LocalInferenceLoadArgs {
  const args: LocalInferenceLoadArgs = { modelPath: model.path };
  const dflash = DFLASH_LOAD_METADATA[model.id];
  if (dflash) {
    const drafter = resolveRegistryModelById(dflash.drafterModelId);
    args.contextSize = dflash.contextSize;
    args.useGpu = true;
    args.draftContextSize = dflash.draftContextSize;
    args.draftMin = dflash.draftMin;
    args.draftMax = dflash.draftMax;
    args.speculativeSamples = dflash.draftMax;
    args.mobileSpeculative = true;
    args.disableThinking = dflash.disableThinking;
    if (drafter) args.draftModelPath = drafter.path;
  }
  if (model.id === "bonsai-8b-1bit") {
    args.cacheTypeK = "tbq4_0";
    args.cacheTypeV = "tbq3_0";
  }
  return args;
}

function resolveLocalLoadArgs(slot: string): LocalInferenceLoadArgs | null {
  const envPath = resolveFromEnv(slot);
  if (envPath) return { modelPath: envPath };
  const registryModel = resolveAssignedRegistryModel(slot);
  if (registryModel) return buildLoadArgsFromRegistryModel(registryModel);
  const manifestPath = resolveFromManifest(slot);
  if (manifestPath) return { modelPath: manifestPath };
  const firstGguf = resolveFirstGguf();
  return firstGguf ? { modelPath: firstGguf } : null;
}

function resolveEmbeddingDimension(): number {
  const assigned = resolveAssignedRegistryModel("TEXT_EMBEDDING");
  return (
    positiveInteger(process.env.ELIZA_LOCAL_EMBEDDING_DIMENSIONS) ??
    positiveInteger(process.env.TEXT_EMBEDDING_DIMENSIONS) ??
    positiveInteger(assigned?.dimensions) ??
    positiveInteger(assigned?.embeddingDimension) ??
    positiveInteger(assigned?.embeddingDimensions) ??
    (assigned?.id ? KNOWN_EMBEDDING_DIMENSIONS[assigned.id] : null) ??
    384
  );
}

function makeGenerateHandler(slot: "TEXT_SMALL" | "TEXT_LARGE") {
  return async (_runtime: IAgentRuntime, params: GenerateTextParams) => {
    const loadArgs = resolveLocalLoadArgs(slot);
    if (!loadArgs) {
      throw new Error(
        `[mobile-device-bridge] No local GGUF model installed under ${modelsDir()}. Download a local model before using the on-device agent.`,
      );
    }
    await mobileDeviceBridge.loadModel(loadArgs);
    return mobileDeviceBridge.generate({
      prompt: params.prompt ?? "",
      stopSequences: params.stopSequences,
      maxTokens: params.maxTokens,
      temperature: params.temperature,
    });
  };
}

function extractEmbeddingText(
  params: TextEmbeddingParams | string | null,
): string {
  if (params === null) return "";
  if (typeof params === "string") return params;
  return params.text;
}

function makeEmbeddingHandler(): EmbeddingHandler {
  return async (_runtime, params) => {
    if (params === null) {
      // Runtime initialization uses a null embedding request only to size
      // the vector column. On stock Capacitor, the WebView cannot attach to
      // the device bridge until the agent HTTP server is already listening,
      // so this startup probe must not try to load the native model.
      return new Array(resolveEmbeddingDimension()).fill(0);
    }
    const modelPath = resolveLocalModelPath("TEXT_EMBEDDING");
    if (!modelPath) {
      throw new Error(
        `[mobile-device-bridge] No local GGUF embedding model installed under ${modelsDir()}. Download a local embedding model before using the on-device agent.`,
      );
    }
    await mobileDeviceBridge.loadModel({ modelPath });
    return mobileDeviceBridge.embed({
      input: extractEmbeddingText(params),
    });
  };
}

export function getMobileDeviceBridgeStatus(): MobileDeviceBridgeStatus {
  return mobileDeviceBridge.status();
}

export async function loadMobileDeviceBridgeModel(
  modelPath: string,
  modelId?: string,
): Promise<void> {
  await mobileDeviceBridge.loadModel(
    modelId
      ? buildLoadArgsFromRegistryModel({ id: modelId, path: modelPath })
      : { modelPath },
  );
}

export async function unloadMobileDeviceBridgeModel(): Promise<void> {
  await mobileDeviceBridge.unloadModel();
}

export async function attachMobileDeviceBridgeToServer(
  server: HttpServer,
): Promise<void> {
  await mobileDeviceBridge.attachToHttpServer(server);
}

export async function ensureMobileDeviceBridgeInferenceHandlers(
  runtime: AgentRuntime,
): Promise<boolean> {
  logger.debug("[mobile-device-bridge] Bootstrap entered");
  if (!SERVICE_ENABLED || process.env.ELIZA_LOCAL_LLAMA?.trim() === "1") {
    logger.debug("[mobile-device-bridge] Disabled or AOSP local llama active");
    return false;
  }
  if (registeredRuntimes.has(runtime)) {
    logger.debug("[mobile-device-bridge] Handlers already registered");
    return true;
  }

  const runtimeWithRegistration = runtime as RuntimeWithModelRegistration;
  if (
    typeof runtimeWithRegistration.getModel !== "function" ||
    typeof runtimeWithRegistration.registerModel !== "function"
  ) {
    logger.error(
      "[mobile-device-bridge] Runtime is missing getModel/registerModel; cannot wire handlers.",
    );
    return false;
  }

  runtimeWithRegistration.registerModel(
    ModelType.TEXT_SMALL,
    makeGenerateHandler("TEXT_SMALL"),
    PROVIDER,
    LOCAL_INFERENCE_PRIORITY,
  );
  runtimeWithRegistration.registerModel(
    ModelType.TEXT_LARGE,
    makeGenerateHandler("TEXT_LARGE"),
    PROVIDER,
    LOCAL_INFERENCE_PRIORITY,
  );
  const embeddingModelPath = resolveLocalModelPath("TEXT_EMBEDDING");
  if (embeddingModelPath) {
    runtimeWithRegistration.registerModel(
      ModelType.TEXT_EMBEDDING,
      makeEmbeddingHandler(),
      PROVIDER,
      LOCAL_INFERENCE_PRIORITY,
    );
  } else {
    logger.warn(
      `[mobile-device-bridge] No local GGUF embedding model installed under ${modelsDir()}; TEXT_EMBEDDING will stay unregistered until a local model is installed and the agent restarts.`,
    );
  }

  logger.info(
    `[mobile-device-bridge] Registered ${PROVIDER} handlers for TEXT_SMALL / TEXT_LARGE${embeddingModelPath ? " / TEXT_EMBEDDING" : ""} at priority ${LOCAL_INFERENCE_PRIORITY}`,
  );
  registeredRuntimes.add(runtime);
  return true;
}

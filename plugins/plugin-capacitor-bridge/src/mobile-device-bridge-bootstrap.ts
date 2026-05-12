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
import {
	createWriteStream,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
} from "node:fs";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
	type AgentRuntime,
	type GenerateTextParams,
	type IAgentRuntime,
	logger,
	ModelType,
	resolveStateDir,
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
	"eliza-1-lite-0_6b": 1024,
	"eliza-1-mobile-1_7b": 2048,
};

const ELIZA_1_LOAD_METADATA: Record<
	string,
	{
		contextSize: number;
	}
> = {
	"eliza-1-lite-0_6b": { contextSize: 32768 },
	"eliza-1-mobile-1_7b": { contextSize: 32768 },
	"eliza-1-desktop-9b": { contextSize: 65536 },
	"eliza-1-pro-27b": { contextSize: 131072 },
	"eliza-1-server-h200": { contextSize: 262144 },
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

function isWsModule(value: unknown): value is WsModule {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { WebSocketServer?: unknown }).WebSocketServer ===
			"function" &&
		typeof (value as { WebSocket?: unknown }).WebSocket === "function"
	);
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
	| {
			type: "formatChatResult";
			correlationId: string;
			ok: true;
			prompt: string | null;
	  }
	| {
			type: "formatChatResult";
			correlationId: string;
			ok: false;
			error: string;
	  }
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
	| {
			type: "formatChat";
			correlationId: string;
			messages: { role: string; content: string }[];
	  }
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
	private readonly pendingFormatChats = new Map<
		string,
		Pending<string | null>
	>();

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
		const wsModule = await import("ws");
		if (!isWsModule(wsModule)) {
			throw new Error("ws module did not expose WebSocketServer/WebSocket");
		}
		const ws = wsModule;
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
			return;
		}

		if (msg.type === "formatChatResult") {
			const pending = this.pendingFormatChats.get(msg.correlationId);
			if (!pending) return;
			clearTimeout(pending.timeout);
			this.pendingFormatChats.delete(msg.correlationId);
			if (msg.ok === true) {
				pending.resolve(msg.prompt);
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

	/**
	 * Apply the model's native chat template (Jinja, from the GGUF) to the
	 * given message list. Round-trips to the WebView so the Capacitor
	 * `LlamaCpp.getFormattedChat()` plugin call can invoke llama.cpp's
	 * `llama_chat_apply_template`. Returns the fully tokenized chat
	 * prompt string ready to feed back into `generate()`. Returns `null`
	 * when the loaded model has no chat template baked in (caller should
	 * fall back to a manual flatten in that case).
	 */
	formatChat(
		messages: { role: string; content: string }[],
	): Promise<string | null> {
		return this.sendToPrimary<string | null>(
			this.pendingFormatChats,
			(correlationId) => ({
				type: "formatChat",
				correlationId,
				messages,
			}),
			readTimeoutMs("ELIZA_DEVICE_LOAD_TIMEOUT_MS", DEFAULT_LOAD_TIMEOUT_MS),
			"DEVICE_TIMEOUT: chat template format exceeded deadline",
		);
	}
}

export const mobileDeviceBridge = new MobileDeviceBridge();

function readTimeoutMs(envKey: string, fallback: number): number {
	const parsed = Number.parseInt(process.env[envKey]?.trim() ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
	const eliza1 = ELIZA_1_LOAD_METADATA[model.id];
	if (eliza1) args.contextSize = eliza1.contextSize;
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

// Recommended-model auto-download. The downloader in app-core
// (services/local-inference/downloader.ts) is the canonical
// implementation, but this plugin doesn't import from app-core to keep the
// dependency graph one-directional. A minimal in-process resumable HF
// fetch is enough for first-run UX: pick a known-good default for the
// slot, download under the agent's state dir, and let
// resolveLocalModelPath() pick it up on the next pass.
//
// Models are tracked in a per-slot map so concurrent generate() calls
// share the in-flight download instead of racing.
type RecommendedModel = {
	id: string;
	hfRepo: string;
	ggufFile: string;
	localFile?: string;
	expectedSizeBytes?: number;
};

const RECOMMENDED_MODELS: Record<
	"TEXT_SMALL" | "TEXT_LARGE" | "TEXT_EMBEDDING",
	RecommendedModel
> = {
	TEXT_SMALL: {
		id: "eliza-1-lite-0_6b",
		hfRepo: "elizaos/eliza-1-lite-0_6b",
		ggufFile: "text/eliza-1-lite-0_6b-32k.gguf",
		localFile: "eliza-1-lite-0_6b-32k.gguf",
	},
	TEXT_LARGE: {
		id: "eliza-1-mobile-1_7b",
		hfRepo: "elizaos/eliza-1-mobile-1_7b",
		ggufFile: "text/eliza-1-mobile-1_7b-32k.gguf",
		localFile: "eliza-1-mobile-1_7b-32k.gguf",
	},
	TEXT_EMBEDDING: {
		id: "eliza-1-lite-0_6b",
		hfRepo: "elizaos/eliza-1-lite-0_6b",
		ggufFile: "text/eliza-1-lite-0_6b-32k.gguf",
		localFile: "eliza-1-lite-0_6b-32k.gguf",
	},
};

const inflightDownloads = new Map<string, Promise<string>>();

function buildHfResolveUrl(model: RecommendedModel): string {
	const encodedPath = model.ggufFile
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/");
	return `https://huggingface.co/${model.hfRepo}/resolve/main/${encodedPath}?download=true`;
}

function buildRecommendedLoadArgs(
	slot: "TEXT_SMALL" | "TEXT_LARGE" | "TEXT_EMBEDDING",
	modelPath: string,
): LocalInferenceLoadArgs {
	const model = RECOMMENDED_MODELS[slot];
	return buildLoadArgsFromRegistryModel({ id: model.id, path: modelPath });
}

async function downloadRecommendedModelFor(
	slot: "TEXT_SMALL" | "TEXT_LARGE" | "TEXT_EMBEDDING",
): Promise<string> {
	const model = RECOMMENDED_MODELS[slot];
	const dir = modelsDir();
	mkdirSync(dir, { recursive: true });
	const finalPath = path.join(
		dir,
		model.localFile ?? path.basename(model.ggufFile),
	);
	if (existsSync(finalPath)) {
		const sz = statSync(finalPath).size;
		if (!model.expectedSizeBytes || sz === model.expectedSizeBytes) {
			return finalPath;
		}
		// Size mismatch — bad partial. Treat as not-installed and re-download.
		logger.warn(
			`[mobile-device-bridge] ${model.ggufFile} present but size ${sz} != expected ${model.expectedSizeBytes}; re-downloading.`,
		);
		try {
			unlinkSync(finalPath);
		} catch {}
	}

	const dedupKey = model.id;
	const existing = inflightDownloads.get(dedupKey);
	if (existing) return existing;

	const promise = (async () => {
		const url = buildHfResolveUrl(model);
		const stagingPath = `${finalPath}.part`;
		try {
			unlinkSync(stagingPath);
		} catch {}
		logger.info(
			`[mobile-device-bridge] Auto-downloading recommended ${slot} model ${model.id} from ${url}`,
		);
		const response = await fetch(url, { redirect: "follow" });
		if (!response.ok || !response.body) {
			throw new Error(
				`[mobile-device-bridge] Recommended-model download failed (${slot}): HTTP ${response.status} ${response.statusText} from ${url}`,
			);
		}
		await pipeline(
			Readable.fromWeb(response.body as never),
			createWriteStream(stagingPath),
		);
		const stagedSize = statSync(stagingPath).size;
		if (model.expectedSizeBytes && stagedSize !== model.expectedSizeBytes) {
			try {
				unlinkSync(stagingPath);
			} catch {}
			throw new Error(
				`[mobile-device-bridge] Downloaded ${model.ggufFile} size ${stagedSize} != expected ${model.expectedSizeBytes}; aborting and removing partial file.`,
			);
		}
		renameSync(stagingPath, finalPath);
		logger.info(
			`[mobile-device-bridge] Auto-download complete: ${finalPath} (${stagedSize} bytes)`,
		);
		return finalPath;
	})();
	inflightDownloads.set(dedupKey, promise);
	try {
		return await promise;
	} finally {
		inflightDownloads.delete(dedupKey);
	}
}

async function resolveLoadArgsWithAutoDownload(
	slot: "TEXT_SMALL" | "TEXT_LARGE" | "TEXT_EMBEDDING",
): Promise<LocalInferenceLoadArgs | null> {
	const existing = resolveLocalLoadArgs(slot);
	if (existing) return existing;
	if (process.env.ELIZA_DISABLE_MODEL_AUTO_DOWNLOAD?.trim() === "1") {
		return null;
	}
	const downloaded = await downloadRecommendedModelFor(slot);
	return buildRecommendedLoadArgs(slot, downloaded);
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
		KNOWN_EMBEDDING_DIMENSIONS[RECOMMENDED_MODELS.TEXT_EMBEDDING.id] ??
		1024
	);
}

// elizaOS v5 message-pipeline calls `runtime.useModel(TEXT_LARGE, params)`
// with `params.messages` set and `params.prompt` undefined. The native
// Capacitor llama plugin only accepts a flat string prompt, so we have
// to render the conversation into the model's chat template ourselves.
// This path is only reached when `getFormattedChat` is unavailable or
// the model has no baked-in Jinja template. Use model-agnostic plain-text
// role labels (`role:\ncontent`) — hardcoding Llama-3 special tokens here
// breaks Qwen3 / Eliza-1 GGUFs whose templates use <|im_start|>/<|im_end|>
// (#7612). When params include a legacy `prompt`, pass it through unchanged.
function flattenChatParamsForPrompt(params: GenerateTextParams): string {
	if (typeof params.prompt === "string" && params.prompt.length > 0) {
		return params.prompt;
	}
	const messages = params.messages ?? [];
	const blocks: string[] = [];
	const hasSystemMessage = messages.some(
		(m: { role?: string }) => m.role === "system",
	);
	if (!hasSystemMessage && typeof params.system === "string" && params.system) {
		blocks.push(`system:\n${params.system}`);
	}
	for (const m of messages) {
		const content =
			typeof (m as { content?: unknown }).content === "string"
				? (m as { content: string }).content
				: "";
		if (!content) continue;
		const role = ((m as { role?: string }).role ?? "user").toLowerCase();
		const safeRole =
			role === "system" || role === "assistant" || role === "user"
				? role
				: "user";
		blocks.push(`${safeRole}:\n${content}`);
	}
	blocks.push("assistant:");
	return blocks.join("\n\n");
}

function makeGenerateHandler(slot: "TEXT_SMALL" | "TEXT_LARGE") {
	return async (_runtime: IAgentRuntime, params: GenerateTextParams) => {
		const loadArgs = await resolveLoadArgsWithAutoDownload(slot);
		if (!loadArgs) {
			throw new Error(
				`[mobile-device-bridge] No local GGUF model installed under ${modelsDir()} and auto-download is disabled (ELIZA_DISABLE_MODEL_AUTO_DOWNLOAD=1). Install a model or unset the disable flag.`,
			);
		}
		await mobileDeviceBridge.loadModel(loadArgs);
		// Prefer the model's native chat template via the Capacitor
		// `LlamaCpp.getFormattedChat()` round-trip. That path invokes
		// `llama_chat_apply_template()` on the loaded GGUF, which:
		//   * honours the model's own Jinja template (Llama-3, Qwen,
		//     Mistral, Phi, …) without per-model code on our side,
		//   * sets up llama.cpp's internal antiprompt list against the
		//     model's true stop tokens so generation terminates at the
		//     natural assistant-turn boundary (`<|eot_id|>` etc.),
		//   * handles BOS, EOT, system-message edge cases correctly.
		// Fall back to the plain-text flatten when the model has no chat
		// template baked in (older or non-instruct GGUFs) or when the legacy
		// `params.prompt` is already set. The fallback is model-agnostic —
		// no Llama-3 special tokens — so it works across Qwen3, Eliza-1, etc.
		const messagesForTemplate = collectMessagesForNativeTemplate(params);
		let nativePrompt: string | null = null;
		if (messagesForTemplate) {
			try {
				nativePrompt = await mobileDeviceBridge.formatChat(messagesForTemplate);
			} catch (err) {
				logger.warn(
					`[mobile-device-bridge] getFormattedChat failed, falling back to plain-text flatten: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
		const prompt = nativePrompt ?? flattenChatParamsForPrompt(params);
		return mobileDeviceBridge.generate({
			prompt,
			stopSequences: params.stopSequences,
			maxTokens: params.maxTokens,
			temperature: params.temperature,
		});
	};
}

// Reshape `params` into the `[{role, content}, ...]` list the native
// `getFormattedChat` call expects. Returns null if `params.messages` is
// empty (caller falls back to plain-text flatten).
function collectMessagesForNativeTemplate(
	params: GenerateTextParams,
): { role: string; content: string }[] | null {
	const messages = params.messages ?? [];
	const result: { role: string; content: string }[] = [];
	const hasSystemMessage = messages.some(
		(m: { role?: string }) => m.role === "system",
	);
	if (!hasSystemMessage && typeof params.system === "string" && params.system) {
		result.push({ role: "system", content: params.system });
	}
	for (const m of messages) {
		const content =
			typeof (m as { content?: unknown }).content === "string"
				? (m as { content: string }).content
				: "";
		if (!content) continue;
		const role = ((m as { role?: string }).role ?? "user").toLowerCase();
		const safeRole =
			role === "system" || role === "assistant" || role === "user"
				? role
				: "user";
		result.push({ role: safeRole, content });
	}
	return result.length > 0 ? result : null;
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
		let modelPath = resolveLocalModelPath("TEXT_EMBEDDING");
		let loadArgs: LocalInferenceLoadArgs | null = modelPath
			? { modelPath }
			: null;
		if (!modelPath) {
			if (process.env.ELIZA_DISABLE_MODEL_AUTO_DOWNLOAD?.trim() === "1") {
				throw new Error(
					`[mobile-device-bridge] No local GGUF embedding model installed under ${modelsDir()} and auto-download is disabled.`,
				);
			}
			modelPath = await downloadRecommendedModelFor("TEXT_EMBEDDING");
			loadArgs = buildRecommendedLoadArgs("TEXT_EMBEDDING", modelPath);
		}
		if (!loadArgs) {
			throw new Error(
				`[mobile-device-bridge] No local GGUF embedding model resolved for ${modelsDir()}.`,
			);
		}
		await mobileDeviceBridge.loadModel(loadArgs);
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

	// Pre-warm the chat-model download in the background so the user
	// doesn't pay the multi-hundred-MB latency on their first turn. Same
	// idempotency guard inside downloadRecommendedModelFor() prevents a
	// duplicate fetch if a real generate() call races us.
	if (
		!resolveLocalLoadArgs("TEXT_SMALL") &&
		process.env.ELIZA_DISABLE_MODEL_AUTO_DOWNLOAD?.trim() !== "1"
	) {
		downloadRecommendedModelFor("TEXT_SMALL").catch((err) =>
			logger.warn(
				`[mobile-device-bridge] Background chat-model download failed: ${(err as Error).message}`,
			),
		);
	}
	// Always register the TEXT_EMBEDDING handler. If the GGUF isn't on disk
	// yet, the handler itself will trigger the auto-downloader on first
	// real call (the null-params startup probe still returns zeros). This
	// way the embedding slot becomes available without an agent restart.
	runtimeWithRegistration.registerModel(
		ModelType.TEXT_EMBEDDING,
		makeEmbeddingHandler(),
		PROVIDER,
		LOCAL_INFERENCE_PRIORITY,
	);
	const embeddingModelPath = resolveLocalModelPath("TEXT_EMBEDDING");
	if (
		!embeddingModelPath &&
		process.env.ELIZA_DISABLE_MODEL_AUTO_DOWNLOAD?.trim() !== "1"
	) {
		// Kick off the embedding-model download in the background so it's
		// ready by the time the WebView issues a real embed request.
		downloadRecommendedModelFor("TEXT_EMBEDDING").catch((err) =>
			logger.warn(
				`[mobile-device-bridge] Background embedding-model download failed: ${(err as Error).message}`,
			),
		);
	}

	logger.info(
		`[mobile-device-bridge] Registered ${PROVIDER} handlers for TEXT_SMALL / TEXT_LARGE${embeddingModelPath ? " / TEXT_EMBEDDING" : ""} at priority ${LOCAL_INFERENCE_PRIORITY}`,
	);
	registeredRuntimes.add(runtime);
	return true;
}

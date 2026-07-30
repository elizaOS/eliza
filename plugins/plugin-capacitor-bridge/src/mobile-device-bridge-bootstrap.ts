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
import net from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
	type AgentRuntime,
	applyBackgroundInferenceBudget,
	type GenerateTextParams,
	getInferencePriorityGate,
	type IAgentRuntime,
	inferenceRamClassFromEnv,
	type LocalInferencePriority,
	logger,
	MobileDeviceBridgeService,
	type MobileDeviceBridgeStatus,
	type ModelRegistrationMetadata,
	ModelType,
	resolveBackgroundInferenceBudget,
	resolveStateDir,
	type TextEmbeddingParams,
} from "@elizaos/core";
import { deriveBionicBundleDir as deriveSharedBionicBundleDir } from "@elizaos/shared/bionic-bundle-view";
import {
	type Eliza1TierId,
	FIRST_RUN_DEFAULT_MODEL_ID,
	findCatalogModel,
} from "@elizaos/shared/local-inference";
import { resolveStoredModelPath } from "./shared/local-inference-stored-path.ts";

const DEVICE_BRIDGE_PATH = "/api/local-inference/device-bridge";
const PROVIDER = "capacitor-llama";
const LOCAL_INFERENCE_PRIORITY = 0;
const SERVICE_ENABLED = process.env.ELIZA_DEVICE_BRIDGE_ENABLED?.trim() === "1";
const registeredRuntimes = new WeakSet<AgentRuntime>();
/**
 * The trigger that actually bound the capacitor-llama handlers, or null while
 * nothing registered them. "bionic-host" is the true in-process serving signal
 * the readiness surfaces key on (#11498): it is set ONLY by
 * registerMobileDeviceBridgeModels, never by mere plugin presence.
 */
let registeredModelTrigger: "bionic-host" | "device-bridge" | null = null;
const KNOWN_EMBEDDING_DIMENSIONS: Record<string, number> = {
	"eliza-1-embedding": 1024,
	// 2B reuses the text backbone for embeddings (--pooling last), so its dim is the
	// model's embedding_length = 2048 (device-verified: EMBED -> dim 2048), NOT 1536.
	"eliza-1-2b": 2048,
	"eliza-1-4b": 2560,
};

function requireCatalogModel(modelId: Eliza1TierId) {
	const model = findCatalogModel(modelId);
	if (!model) {
		throw new Error(
			`[mobile-device-bridge] Shared catalog has no model ${modelId}`,
		);
	}
	return model;
}

function catalogLoadMetadata(modelId: Eliza1TierId): {
	contextSize: number;
	mtp?: { drafterFile: string; draftMin: number; draftMax: number };
} {
	const model = requireCatalogModel(modelId);
	const mtp = model.runtime?.mtp;
	const drafterFile = mtp?.drafterFile;
	if (!model.contextLength) {
		throw new Error(
			`[mobile-device-bridge] Shared catalog model ${modelId} has no context length`,
		);
	}
	return {
		contextSize: model.contextLength,
		...(mtp && drafterFile
			? {
					mtp: {
						drafterFile,
						draftMin: mtp.draftMin,
						draftMax: mtp.draftMax,
					},
				}
			: {}),
	};
}

const ELIZA_1_LOAD_METADATA: Record<
	string,
	ReturnType<typeof catalogLoadMetadata>
> = {
	"eliza-1-2b": catalogLoadMetadata("eliza-1-2b"),
	"eliza-1-4b": catalogLoadMetadata("eliza-1-4b"),
	"eliza-1-9b": catalogLoadMetadata("eliza-1-9b"),
	"eliza-1-27b": catalogLoadMetadata("eliza-1-27b"),
	"eliza-1-27b-256k": catalogLoadMetadata("eliza-1-27b-256k"),
};

// Native bionic-host override for Gemma separate-drafter MTP. When
// ELIZA_BIONIC_MTP is set this forces speculative decoding on/off when a
// drafter GGUF is available (the JNI keystone path reads the same env). "0"/
// "false"/"no"/"off" → force OFF; "1"/"true"/"yes"/"on" → force ON; absent →
// fall back to the tier default. Mirrors arm_bionic_text_cfg() in
// elizavoice-jni.cpp.
function bionicMtpOverride(): boolean | undefined {
	const raw = process.env.ELIZA_BIONIC_MTP?.trim().toLowerCase();
	if (!raw) return undefined;
	if (raw === "0" || raw === "false" || raw === "no" || raw === "off") {
		return false;
	}
	if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") {
		return true;
	}
	return undefined;
}

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
	signal?: AbortSignal;
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
		metadata?: ModelRegistrationMetadata,
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

function isDeviceGpu(
	value: unknown,
): value is NonNullable<DeviceCapabilities["gpu"]> {
	return (
		isRecord(value) &&
		(value.backend === "metal" ||
			value.backend === "vulkan" ||
			value.backend === "gpu-delegate") &&
		typeof value.available === "boolean"
	);
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDeviceOutbound(text: string): DeviceOutbound {
	const value: unknown = JSON.parse(text);
	if (!isRecord(value) || typeof value.type !== "string") {
		throw new TypeError("frame must be an object with a string type");
	}
	if (value.type === "register") {
		if (
			!isRecord(value.payload) ||
			typeof value.payload.deviceId !== "string" ||
			(value.payload.pairingToken !== undefined &&
				typeof value.payload.pairingToken !== "string") ||
			!isRecord(value.payload.capabilities)
		) {
			throw new TypeError("register frame has invalid payload");
		}
		const capabilities = value.payload.capabilities;
		const gpu = capabilities.gpu;
		if (
			(capabilities.platform !== "ios" &&
				capabilities.platform !== "android" &&
				capabilities.platform !== "web") ||
			typeof capabilities.deviceModel !== "string" ||
			typeof capabilities.totalRamGb !== "number" ||
			typeof capabilities.cpuCores !== "number" ||
			(gpu !== null && !isDeviceGpu(gpu)) ||
			(value.payload.loadedPath !== null &&
				typeof value.payload.loadedPath !== "string")
		) {
			throw new TypeError("register frame has invalid capabilities");
		}
		return {
			type: "register",
			payload: {
				deviceId: value.payload.deviceId,
				...(value.payload.pairingToken !== undefined
					? { pairingToken: value.payload.pairingToken }
					: {}),
				capabilities: {
					platform: capabilities.platform,
					deviceModel: capabilities.deviceModel,
					totalRamGb: capabilities.totalRamGb,
					cpuCores: capabilities.cpuCores,
					gpu:
						gpu === null
							? null
							: {
									backend: gpu.backend,
									available: gpu.available,
								},
				},
				loadedPath: value.payload.loadedPath,
			},
		};
	}
	if (value.type === "pong") {
		if (typeof value.at !== "number") {
			throw new TypeError("pong frame requires numeric at");
		}
		return { type: "pong", at: value.at };
	}
	if (
		typeof value.correlationId !== "string" ||
		typeof value.ok !== "boolean"
	) {
		throw new TypeError("result frame requires correlationId and ok");
	}
	if (!value.ok) {
		if (typeof value.error !== "string") {
			throw new TypeError("failed result frame requires error");
		}
		if (
			value.type !== "loadResult" &&
			value.type !== "unloadResult" &&
			value.type !== "generateResult" &&
			value.type !== "embedResult" &&
			value.type !== "formatChatResult"
		) {
			throw new TypeError(`unknown result frame type ${value.type}`);
		}
		return {
			type: value.type,
			correlationId: value.correlationId,
			ok: false,
			error: value.error,
		};
	}
	if (value.type === "loadResult" && typeof value.loadedPath === "string") {
		return {
			type: "loadResult",
			correlationId: value.correlationId,
			ok: true,
			loadedPath: value.loadedPath,
		};
	}
	if (value.type === "unloadResult") {
		return {
			type: "unloadResult",
			correlationId: value.correlationId,
			ok: true,
		};
	}
	if (
		value.type === "generateResult" &&
		typeof value.text === "string" &&
		typeof value.promptTokens === "number" &&
		typeof value.outputTokens === "number" &&
		typeof value.durationMs === "number"
	) {
		return {
			type: "generateResult",
			correlationId: value.correlationId,
			ok: true,
			text: value.text,
			promptTokens: value.promptTokens,
			outputTokens: value.outputTokens,
			durationMs: value.durationMs,
		};
	}
	if (
		value.type === "embedResult" &&
		Array.isArray(value.embedding) &&
		value.embedding.every((entry) => typeof entry === "number") &&
		typeof value.tokens === "number"
	) {
		return {
			type: "embedResult",
			correlationId: value.correlationId,
			ok: true,
			embedding: value.embedding,
			tokens: value.tokens,
		};
	}
	if (
		value.type === "formatChatResult" &&
		(value.prompt === null || typeof value.prompt === "string")
	) {
		return {
			type: "formatChatResult",
			correlationId: value.correlationId,
			ok: true,
			prompt: value.prompt,
		};
	}
	throw new TypeError(`invalid successful result frame ${value.type}`);
}

type AgentOutbound =
	| ({
			type: "load";
			correlationId: string;
	  } & Omit<LocalInferenceLoadArgs, "signal">)
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
	| { type: "cancel"; correlationId: string }
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
	cleanup: () => void;
	routedDeviceId: string;
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new DOMException("The operation was aborted", "AbortError");
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
	id?: string;
	ggufFile?: string;
	filename?: string;
	role?: "chat" | "embedding";
	contextSize?: number | string;
	useGpu?: boolean;
	maxThreads?: number | string;
	draftModelPath?: string;
	draftContextSize?: number | string;
	draftMin?: number | string;
	draftMax?: number | string;
	speculativeSamples?: number | string;
	mobileSpeculative?: boolean;
	cacheTypeK?: string;
	cacheTypeV?: string;
	disableThinking?: boolean;
}

interface BundledModelManifest {
	models?: BundledModelManifestEntry[];
}

export type { MobileDeviceBridgeStatus };

export class MobileDeviceBridge {
	private wss: WssInstance | null = null;
	private readonly devices = new Map<string, ConnectedDevice>();
	private readonly attachListeners = new Set<() => void>();
	private readonly pendingLoads = new Map<string, Pending<void>>();
	private readonly pendingUnloads = new Map<string, Pending<void>>();
	private readonly pendingGenerates = new Map<string, Pending<string>>();
	private readonly pendingEmbeds = new Map<string, Pending<number[]>>();
	private readonly pendingFormatChats = new Map<
		string,
		Pending<string | null>
	>();
	private readonly expectedPairingToken =
		process.env.ELIZA_DEVICE_PAIRING_TOKEN?.trim() ||
		process.env.ELIZA_DEVICE_BRIDGE_TOKEN?.trim() ||
		null;

	status(): MobileDeviceBridgeStatus {
		const devices = [...this.devices.values()].map((device) => ({
			deviceId: device.deviceId,
			capabilities: device.capabilities,
			loadedPath: device.loadedPath,
			connectedSince: new Date(device.connectedAt).toISOString(),
		}));
		return {
			enabled: SERVICE_ENABLED && Boolean(this.expectedPairingToken),
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
		if (!this.expectedPairingToken) {
			logger.warn(
				"[mobile-device-bridge] Disabled: ELIZA_DEVICE_PAIRING_TOKEN is required when ELIZA_DEVICE_BRIDGE_ENABLED=1",
			);
			return;
		}
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

		wss.on("error", (err: Error) => {
			logger.warn("[mobile-device-bridge] WSS error:", err.message);
		});

		server.on("upgrade", (request, socket, head) => {
			const url = new URL(request.url ?? "/", "http://localhost");
			if (url.pathname !== DEVICE_BRIDGE_PATH) return;
			wss.handleUpgrade(request, socket, head, (client: MinimalWebSocket) => {
				this.handleConnection(client, ws.WebSocket, url);
			});
		});

		logger.info(
			`[mobile-device-bridge] Listening for Capacitor device bridge at ${DEVICE_BRIDGE_PATH}`,
		);
	}

	private handleConnection(
		socket: MinimalWebSocket,
		WsCtor: WsConstructor,
		url: URL,
	) {
		const queryToken = url.searchParams.get("token")?.trim();
		if (
			!this.expectedPairingToken ||
			queryToken !== this.expectedPairingToken
		) {
			logger.warn(
				"[mobile-device-bridge] Rejecting connection: bad query token",
			);
			socket.close(4001, "unauthorized");
			return;
		}

		let registeredDeviceId: string | null = null;

		socket.on("message", (raw) => {
			let msg: DeviceOutbound;
			try {
				const text = typeof raw === "string" ? raw : raw.toString("utf8");
				msg = parseDeviceOutbound(text);
			} catch (error) {
				// error-policy:J3 untrusted websocket input is rejected as invalid
				// instead of being interpreted as a successful empty message.
				logger.warn(
					`[mobile-device-bridge] Rejecting invalid device frame: ${error instanceof Error ? error.message : String(error)}`,
				);
				socket.close(4004, "invalid-frame");
				return;
			}

			if (!registeredDeviceId) {
				if (msg.type !== "register") {
					socket.close(4002, "must-register-first");
					return;
				}
				if (msg.payload.capabilities.platform === "ios") {
					logger.warn(
						"[mobile-device-bridge] Rejecting iOS registration: use native IPC",
					);
					socket.close(4003, "ios-ipc-required");
					return;
				}
				if (
					!this.expectedPairingToken ||
					msg.payload.pairingToken !== this.expectedPairingToken
				) {
					logger.warn(
						"[mobile-device-bridge] Rejecting register: bad pairing token",
					);
					socket.close(4001, "unauthorized");
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
				this.notifyDeviceAttached();
				return;
			}

			this.handleDeviceMessage(msg);
		});

		socket.on("close", () => {
			clearInterval(heartbeat);
			if (!registeredDeviceId) return;
			const current = this.devices.get(registeredDeviceId);
			if (current?.socket === socket) {
				this.devices.delete(registeredDeviceId);
				this.rejectPendingForDevice(
					this.pendingLoads,
					registeredDeviceId,
					"model load",
				);
				this.rejectPendingForDevice(
					this.pendingUnloads,
					registeredDeviceId,
					"model unload",
				);
				this.rejectPendingForDevice(
					this.pendingGenerates,
					registeredDeviceId,
					"generation",
				);
				this.rejectPendingForDevice(
					this.pendingEmbeds,
					registeredDeviceId,
					"embedding",
				);
				this.rejectPendingForDevice(
					this.pendingFormatChats,
					registeredDeviceId,
					"chat formatting",
				);
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
			} catch (error) {
				// error-policy:J6 heartbeat teardown is best effort; the socket
				// close/error handlers own request rejection and diagnostics.
				logger.warn(
					`[mobile-device-bridge] Heartbeat send failed: ${error instanceof Error ? error.message : String(error)}`,
				);
				clearInterval(heartbeat);
			}
		}, 15_000);
		if (typeof heartbeat === "object" && "unref" in heartbeat) {
			(heartbeat as { unref(): void }).unref();
		}
	}

	private rejectPendingForDevice<T>(
		pendingMap: Map<string, Pending<T>>,
		deviceId: string,
		operation: string,
	): void {
		for (const [correlationId, pending] of pendingMap) {
			if (pending.routedDeviceId !== deviceId) continue;
			pendingMap.delete(correlationId);
			pending.cleanup();
			pending.reject(
				new Error(`DEVICE_DISCONNECTED: ${deviceId} during ${operation}`),
			);
		}
	}

	private handleDeviceMessage(msg: DeviceOutbound): void {
		if (msg.type === "pong" || msg.type === "register") return;

		if (msg.type === "loadResult") {
			const pending = this.pendingLoads.get(msg.correlationId);
			if (!pending) return;
			this.pendingLoads.delete(msg.correlationId);
			pending.cleanup();
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
			this.pendingUnloads.delete(msg.correlationId);
			pending.cleanup();
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
			this.pendingGenerates.delete(msg.correlationId);
			pending.cleanup();
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
			this.pendingEmbeds.delete(msg.correlationId);
			pending.cleanup();
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
			this.pendingFormatChats.delete(msg.correlationId);
			pending.cleanup();
			if (msg.ok === true) {
				pending.resolve(msg.prompt);
			} else {
				pending.reject(new Error(msg.error));
			}
		}
	}

	/**
	 * Subscribe to real device-bridge attachment. Model handlers are only
	 * registered once a bridge that can actually serve them exists, so the
	 * bootstrap defers registration through this hook when neither the bionic
	 * host nor a connected device is available at boot.
	 */
	onDeviceAttached(listener: () => void): void {
		this.attachListeners.add(listener);
	}

	private notifyDeviceAttached(): void {
		for (const listener of this.attachListeners) {
			listener();
		}
	}

	private primaryDevice(): ConnectedDevice | null {
		return this.devices.values().next().value ?? null;
	}

	private sendToPrimary<T>(
		pendingMap: Map<string, Pending<T>>,
		makeMessage: (correlationId: string) => AgentOutbound,
		options: { signal?: AbortSignal; cancelGeneration?: boolean } = {},
	): Promise<T> {
		if (options.signal?.aborted) {
			return Promise.reject(abortError(options.signal));
		}
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
			let abort = () => {};
			const cleanup = () => options.signal?.removeEventListener("abort", abort);
			abort = () => {
				if (!pendingMap.delete(correlationId)) return;
				cleanup();
				if (options.cancelGeneration) {
					try {
						device.socket.send(
							JSON.stringify({ type: "cancel", correlationId }),
						);
					} catch {
						// error-policy:J5 the caller observes cancellation; socket
						// failure is independently observed by the close/error handlers.
					}
				}
				reject(abortError(options.signal as AbortSignal));
			};
			pendingMap.set(correlationId, {
				resolve,
				reject,
				cleanup,
				routedDeviceId: device.deviceId,
			});
			options.signal?.addEventListener("abort", abort, { once: true });
			if (options.signal?.aborted) {
				abort();
				return;
			}
			try {
				device.socket.send(JSON.stringify(message));
			} catch (err) {
				pendingMap.delete(correlationId);
				cleanup();
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}

	async loadModel(args: LocalInferenceLoadArgs): Promise<void> {
		const device = this.primaryDevice();
		if (device?.loadedPath === args.modelPath) return;
		const { signal, ...wireArgs } = args;
		return this.sendToPrimary<void>(
			this.pendingLoads,
			(correlationId) => ({
				type: "load",
				correlationId,
				...wireArgs,
			}),
			{ signal },
		);
	}

	async unloadModel(signal?: AbortSignal): Promise<void> {
		const device = this.primaryDevice();
		if (!device?.loadedPath) return;
		return this.sendToPrimary<void>(
			this.pendingUnloads,
			(correlationId) => ({ type: "unload", correlationId }),
			{ signal },
		);
	}

	generate(args: {
		prompt: string;
		stopSequences?: string[];
		maxTokens?: number;
		temperature?: number;
		signal?: AbortSignal;
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
			{ signal: args.signal, cancelGeneration: true },
		);
	}

	embed(args: { input: string; signal?: AbortSignal }): Promise<number[]> {
		return this.sendToPrimary<number[]>(
			this.pendingEmbeds,
			(correlationId) => ({
				type: "embed",
				correlationId,
				input: args.input,
			}),
			{ signal: args.signal },
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
		signal?: AbortSignal,
	): Promise<string | null> {
		return this.sendToPrimary<string | null>(
			this.pendingFormatChats,
			(correlationId) => ({
				type: "formatChat",
				correlationId,
				messages,
			}),
			{ signal },
		);
	}
}

export const mobileDeviceBridge = new MobileDeviceBridge();

function localInferenceRoot(): string {
	return path.join(resolveStateDir(), "local-inference");
}

function modelsDir(): string {
	return path.join(localInferenceRoot(), "models");
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
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "ENOENT"
		) {
			return null;
		}
		// error-policy:J2 registry corruption is configuration failure, not an
		// empty registry; preserve the parser/read error for the owner.
		throw new Error(
			`[mobile-device-bridge] Could not read JSON registry ${filePath}`,
			{ cause: error },
		);
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

function nonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: null;
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
	const assigned = resolveAssignedModelId(slot);
	if (!assigned) return null;

	const models = readRegistryModels();
	const matched = models.find((model) => model.id === assigned);
	if (typeof matched?.path !== "string") return null;
	// Rows are stored relative to the local-inference root; legacy rows may
	// hold absolute paths from a dead app container (#11669).
	return resolveStoredModelPath(matched.path, localInferenceRoot());
}

function readRegistryModels(): RegistryModelEntry[] {
	const registry = readJsonFile<RegistryFile>(registryPath());
	if (!registry) return [];
	if (!Array.isArray(registry.models)) {
		throw new TypeError(
			`[mobile-device-bridge] Invalid model registry at ${registryPath()}: models must be an array`,
		);
	}
	return registry.models;
}

function resolveAssignedModelId(slot: string): string | null {
	const assignmentFile = readJsonFile<AssignmentsFile>(assignmentsPath());
	if (!assignmentFile) return null;
	if (
		!assignmentFile.assignments ||
		typeof assignmentFile.assignments !== "object" ||
		Array.isArray(assignmentFile.assignments)
	) {
		throw new TypeError(
			`[mobile-device-bridge] Invalid model assignments at ${assignmentsPath()}: assignments must be an object`,
		);
	}
	const assigned = assignmentFile.assignments[slot];
	return typeof assigned === "string" && assigned.trim().length > 0
		? assigned.trim()
		: null;
}

function resolveAssignedRegistryModel(slot: string): {
	id: string;
	path: string;
	dimensions?: unknown;
	embeddingDimension?: unknown;
	embeddingDimensions?: unknown;
} | null {
	const assigned = resolveAssignedModelId(slot);
	if (!assigned) return null;

	const models = readRegistryModels();
	const matched = models.find((model) => model.id === assigned);
	if (typeof matched?.path !== "string") return null;
	const resolvedPath = resolveStoredModelPath(
		matched.path,
		localInferenceRoot(),
	);
	if (!resolvedPath) return null;
	return {
		id: assigned,
		path: resolvedPath,
		dimensions: matched.dimensions,
		embeddingDimension: matched.embeddingDimension,
		embeddingDimensions: matched.embeddingDimensions,
	};
}

function resolveManifestModel(slot: string): {
	path: string;
	entry: BundledModelManifestEntry;
} | null {
	const manifest = readJsonFile<BundledModelManifest>(
		path.join(modelsDir(), "manifest.json"),
	);
	const targetRole = slot === "TEXT_EMBEDDING" ? "embedding" : "chat";
	for (const entry of manifest?.models ?? []) {
		if (entry.role !== targetRole) continue;
		const fileName = entry.ggufFile ?? entry.filename;
		if (!fileName) continue;
		const absolute = path.join(modelsDir(), fileName);
		if (existsSync(absolute)) return { path: absolute, entry };
	}
	return null;
}

function resolveFromManifest(slot: string): string | null {
	return resolveManifestModel(slot)?.path ?? null;
}

function drafterCandidates(modelPath: string, drafterFile: string): string[] {
	const modelDir = path.dirname(modelPath);
	const basename = path.basename(drafterFile);
	const candidates = new Set<string>();
	if (path.basename(modelDir) === "text") {
		const bundleRoot = path.dirname(modelDir);
		candidates.add(path.join(bundleRoot, drafterFile));
	}
	candidates.add(path.join(modelDir, drafterFile));
	candidates.add(path.join(modelDir, basename));
	candidates.add(path.join(modelsDir(), drafterFile));
	candidates.add(path.join(modelsDir(), basename));
	return [...candidates];
}

function resolveGemmaDrafterPath(
	modelPath: string,
	drafterFile: string,
): string | null {
	for (const candidate of drafterCandidates(modelPath, drafterFile)) {
		if (existsSync(candidate)) return candidate;
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

export function buildLoadArgsFromRegistryModel(model: {
	id: string;
	path: string;
}): LocalInferenceLoadArgs {
	const args: LocalInferenceLoadArgs = { modelPath: model.path };
	const eliza1 = ELIZA_1_LOAD_METADATA[model.id];
	if (eliza1) {
		args.contextSize = eliza1.contextSize;
		// Keep stock KV by default for shipped Gemma 4 Eliza-1 tiers. Their
		// MQA + windowed-SWA + shared-KV setup is already compact, while the
		// QJL1_256/TBQ lab path is only for compatible non-shipping test bundles.
		if (process.env.ELIZA_BIONIC_KV_QUANT?.trim() === "1") {
			args.cacheTypeK = "qjl1_256";
			args.cacheTypeV = "tbq3_0";
		}
		// Gemma 4 MTP requires a separate assistant/drafter GGUF. Only pass MTP
		// hints when that companion is physically present; otherwise generation
		// remains non-speculative instead of accidentally selecting same-file MTP.
		const mtpOverride = bionicMtpOverride();
		const mtpEnabled = mtpOverride ?? eliza1.mtp !== undefined;
		const drafterPath = eliza1.mtp
			? resolveGemmaDrafterPath(model.path, eliza1.mtp.drafterFile)
			: null;
		if (mtpEnabled && eliza1.mtp && drafterPath) {
			args.draftModelPath = drafterPath;
			args.draftMin = eliza1.mtp.draftMin;
			args.draftMax = eliza1.mtp.draftMax;
			args.mobileSpeculative = true;
		}
	}
	return args;
}

function applyManifestLoadHints(
	args: LocalInferenceLoadArgs,
	entry: BundledModelManifestEntry,
): LocalInferenceLoadArgs {
	const contextSize = positiveInteger(entry.contextSize);
	if (contextSize !== null) args.contextSize = contextSize;
	if (typeof entry.useGpu === "boolean") args.useGpu = entry.useGpu;
	const maxThreads = positiveInteger(entry.maxThreads);
	if (maxThreads !== null) args.maxThreads = maxThreads;
	const draftContextSize = positiveInteger(entry.draftContextSize);
	if (draftContextSize !== null) args.draftContextSize = draftContextSize;
	const draftMin = positiveInteger(entry.draftMin);
	if (draftMin !== null) args.draftMin = draftMin;
	const draftMax = positiveInteger(entry.draftMax);
	if (draftMax !== null) args.draftMax = draftMax;
	const speculativeSamples = positiveInteger(entry.speculativeSamples);
	if (speculativeSamples !== null) {
		args.speculativeSamples = speculativeSamples;
	}
	const draftModelPath = nonEmptyString(entry.draftModelPath);
	if (draftModelPath) args.draftModelPath = draftModelPath;
	const cacheTypeK = nonEmptyString(entry.cacheTypeK);
	if (cacheTypeK) args.cacheTypeK = cacheTypeK;
	const cacheTypeV = nonEmptyString(entry.cacheTypeV);
	if (cacheTypeV) args.cacheTypeV = cacheTypeV;
	if (typeof entry.mobileSpeculative === "boolean") {
		args.mobileSpeculative = entry.mobileSpeculative;
	}
	if (typeof entry.disableThinking === "boolean") {
		args.disableThinking = entry.disableThinking;
	}
	return args;
}

function buildLoadArgsFromManifestModel(model: {
	path: string;
	entry: BundledModelManifestEntry;
}): LocalInferenceLoadArgs {
	const id = nonEmptyString(model.entry.id);
	const args = id
		? buildLoadArgsFromRegistryModel({ id, path: model.path })
		: { modelPath: model.path };
	return applyManifestLoadHints(args, model.entry);
}

function resolveLocalLoadArgs(slot: string): LocalInferenceLoadArgs | null {
	const envPath = resolveFromEnv(slot);
	if (envPath) return { modelPath: envPath };
	const registryModel = resolveAssignedRegistryModel(slot);
	if (registryModel) return buildLoadArgsFromRegistryModel(registryModel);
	const manifestModel = resolveManifestModel(slot);
	if (manifestModel) return buildLoadArgsFromManifestModel(manifestModel);
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

function catalogRecommendedModel(
	modelId: Eliza1TierId,
	role: "text" | "embedding",
	publicId: string = modelId,
): RecommendedModel {
	const component =
		requireCatalogModel(modelId).sourceModel?.components?.[role];
	if (!component?.file) {
		throw new Error(
			`[mobile-device-bridge] Shared catalog model ${modelId} has no ${role} artifact`,
		);
	}
	return {
		id: publicId,
		hfRepo: component.repo,
		ggufFile: component.file,
		localFile: path.basename(component.file),
	};
}

const RECOMMENDED_MODELS: Record<
	"TEXT_SMALL" | "TEXT_LARGE" | "TEXT_EMBEDDING",
	RecommendedModel
> = {
	// Both chat slots use the published first-run tier. Artifact paths come
	// from the shared catalog because stable product ids (2b/4b) intentionally
	// differ from the Gemma-4 repository slugs (e2b/e4b).
	TEXT_SMALL: catalogRecommendedModel(FIRST_RUN_DEFAULT_MODEL_ID, "text"),
	TEXT_LARGE: catalogRecommendedModel(FIRST_RUN_DEFAULT_MODEL_ID, "text"),
	TEXT_EMBEDDING: catalogRecommendedModel(
		"eliza-1-4b",
		"embedding",
		"eliza-1-embedding",
	),
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
		} catch {
			// error-policy:J6 best-effort teardown — removing a bad partial before
			// re-download; if it is already gone the re-download proceeds anyway.
		}
	}

	const dedupKey = model.id;
	const existing = inflightDownloads.get(dedupKey);
	if (existing) return existing;

	const promise = (async () => {
		const url = buildHfResolveUrl(model);
		const stagingPath = `${finalPath}.part`;
		try {
			unlinkSync(stagingPath);
		} catch {
			// error-policy:J6 best-effort teardown — clear a leftover `.part` from a
			// prior interrupted download before staging; absent is fine.
		}
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
			} catch {
				// error-policy:J6 best-effort teardown — remove the size-mismatched
				// partial before throwing; the throw below is the real failure.
			}
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
	const assigned =
		resolveAssignedRegistryModel("TEXT_EMBEDDING") ??
		(bionicSocketName() ? resolveAssignedRegistryModel("TEXT_SMALL") : null);
	const assignedId =
		assigned?.id ??
		resolveAssignedModelId("TEXT_EMBEDDING") ??
		(bionicSocketName() ? resolveAssignedModelId("TEXT_SMALL") : null);
	return (
		positiveInteger(process.env.ELIZA_LOCAL_EMBEDDING_DIMENSIONS) ??
		positiveInteger(process.env.TEXT_EMBEDDING_DIMENSIONS) ??
		positiveInteger(assigned?.dimensions) ??
		positiveInteger(assigned?.embeddingDimension) ??
		positiveInteger(assigned?.embeddingDimensions) ??
		(assignedId ? KNOWN_EMBEDDING_DIMENSIONS[assignedId] : null) ??
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
// breaks non-Llama GGUFs, including current Gemma 4 Eliza-1 bundles whose
// templates may not use Llama-style turn markers.
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

// ── Bionic-host GPU delegation (abstract-namespace UDS) ────────────────────
// When the dynamic-Vulkan fused lib is staged, the GPU is reachable only from
// the bionic app process (ElizaBionicInferenceServer). Route the TEXT decode
// there over an abstract AF_UNIX socket instead of the device-bridge WebSocket
// (which can't reach Vulkan and adds a pairing-token hop). The wire framing
// matches ElizaBionicInferenceServer.java + BionicHostLoader.ts:
// [int32 BE length][UTF-8 JSON] each direction.

const BIONIC_MAX_FRAME_BYTES = 64 * 1024 * 1024;

interface BionicGenerateResponse {
	ok: boolean;
	text?: string;
	error?: string;
	tokens?: number;
	ms?: number;
	tokS?: number;
	embedding?: number[];
	dim?: number;
}

/** Abstract-namespace socket name set by ElizaAgentService, or null. */
function bionicSocketName(): string | null {
	if (process.env.ELIZA_BIONIC_HOST_DELEGATED?.trim() !== "1") return null;
	const sock = process.env.ELIZA_BIONIC_INFERENCE_SOCK?.trim();
	return sock ? sock : null;
}

/**
 * Per-native-call token budget hint for the host's streaming decode
 * (#11913). Reads the shared agent-side streaming knob
 * (`ELIZA_LOCAL_STREAM_TOKENS_PER_STEP`, the same one the desktop FFI runner
 * honors); undefined lets the bionic host apply its own default (8, the
 * #9174 user-visible streaming knee). The host clamps whatever we send to
 * its JNI token buffer (1..256).
 */
export function resolveBionicStreamStep(): number | undefined {
	const raw = process.env.ELIZA_LOCAL_STREAM_TOKENS_PER_STEP?.trim();
	if (!raw) return undefined;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

// A flat on-device model (…/models/eliza-1-2b-128k.gguf) is not the bundle
// layout `libelizainference`'s eliza_pick_text_file() globs (<bundle>/text/
// *.gguf), so a delegated generate fails with "bundle_dir does not exist". We
// stage a hardlinked text/ view under `.bionic-bundles/<name>/` — matching the
// BionicHostLoader path (bionic-host-loader.ts, #11335) so both delegated
// entrypoints resolve the same bundle. This path (mobile-device-bridge) is the
// one the WebView chat "(via bionic-host)" delegation actually uses.
/** Bundle root the host's eliza_inference_create expects (…/text/<model>.gguf → …). */
export function deriveBionicBundleDir(modelPath: string): string {
	try {
		return deriveSharedBionicBundleDir(modelPath);
	} catch (err) {
		logger.warn(
			`[mobile-device-bridge] could not stage bionic bundle view for flat model "${modelPath}": ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	return "";
}

function roleForGemmaPrompt(role: string): "system" | "user" | "model" {
	if (role === "assistant") return "model";
	if (role === "system") return "system";
	return "user";
}

function collectChatMlPromptMessages(
	prompt: string,
	system?: string,
): { role: string; content: string }[] | null {
	const headerPattern = /<\|im_start\|>(system|user|assistant)(?:\n|$)/g;
	const headers: Array<{ index: number; role: string; bodyStart: number }> = [];
	let match = headerPattern.exec(prompt);
	while (match !== null) {
		headers.push({
			index: match.index,
			role: match[1],
			bodyStart: match.index + match[0].length,
		});
		match = headerPattern.exec(prompt);
	}
	if (headers.length === 0) return null;

	const result: { role: string; content: string }[] = [];
	if (system?.trim() && headers[0]?.role !== "system") {
		result.push({ role: "system", content: system.trim() });
	}
	for (let i = 0; i < headers.length; i += 1) {
		const current = headers[i];
		const next = headers[i + 1];
		const rawContent = prompt
			.slice(current.bodyStart, next ? next.index : prompt.length)
			.replace(/<\|im_end\|>\s*$/g, "")
			.trim();
		if (!rawContent) continue;
		result.push({ role: current.role, content: rawContent });
	}
	return result.length > 0 ? result : null;
}

function renderGemmaPromptMessages(
	messages: Array<{ role: string; content: string }>,
): string {
	let out = "";
	for (const m of messages) {
		const content = m.content.trim();
		if (!content) continue;
		out += `<start_of_turn>${roleForGemmaPrompt(m.role)}\n${content}<end_of_turn>\n`;
	}
	return `${out}<start_of_turn>model\n`;
}

/** Gemma fallback prompt for bionic paths built without device-bridge templating. */
export function buildGemmaBionicPrompt(params: GenerateTextParams): string {
	const prompt = typeof params.prompt === "string" ? params.prompt : "";
	const trimmedPrompt = prompt.trimEnd();
	// If the caller already handed us a complete Gemma prompt, use it verbatim.
	if (
		trimmedPrompt.includes("<start_of_turn>") &&
		trimmedPrompt.includes("<start_of_turn>model")
	) {
		return trimmedPrompt;
	}
	const msgs = prompt.includes("<|im_start|>")
		? collectChatMlPromptMessages(prompt, params.system)
		: collectMessagesForNativeTemplate(params);
	if (!msgs || msgs.length === 0) {
		return `<start_of_turn>user\n${flattenChatParamsForPrompt(params).trim()}<end_of_turn>\n<start_of_turn>model\n`;
	}
	return renderGemmaPromptMessages(msgs);
}

function bionicHostGenerate(
	socketName: string,
	request: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<BionicGenerateResponse> {
	const payload = Buffer.from(JSON.stringify(request), "utf8");
	const frame = Buffer.allocUnsafe(4 + payload.length);
	frame.writeUInt32BE(payload.length, 0);
	payload.copy(frame, 4);
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortError(signal));
			return;
		}
		const sock = net.connect({ path: `\0${socketName}` });
		let settled = false;
		let chunks = Buffer.alloc(0);
		let expected = -1;
		let abort = () => {};
		const finish = (err: Error | null, value?: BionicGenerateResponse) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", abort);
			sock.destroy();
			err ? reject(err) : resolve(value as BionicGenerateResponse);
		};
		abort = () => finish(abortError(signal as AbortSignal));
		signal?.addEventListener("abort", abort, { once: true });
		sock.on("connect", () => sock.write(frame));
		sock.on("data", (d: Buffer) => {
			chunks = Buffer.concat([chunks, d]);
			if (expected < 0 && chunks.length >= 4) {
				expected = chunks.readUInt32BE(0);
				if (expected < 0 || expected > BIONIC_MAX_FRAME_BYTES) {
					finish(
						new Error(`[mobile-device-bridge] bad bionic frame ${expected}`),
					);
					return;
				}
			}
			if (expected >= 0 && chunks.length >= 4 + expected) {
				try {
					finish(
						null,
						JSON.parse(chunks.subarray(4, 4 + expected).toString("utf8")),
					);
				} catch (e) {
					finish(
						new Error(
							`[mobile-device-bridge] bad bionic JSON: ${(e as Error).message}`,
						),
					);
				}
			}
		});
		sock.on("error", (e: Error) =>
			finish(
				new Error(`[mobile-device-bridge] bionic socket error: ${e.message}`),
			),
		);
		sock.on("close", () => {
			if (!settled)
				finish(new Error("[mobile-device-bridge] bionic host closed early"));
		});
	});
}

/**
 * Streaming variant of {@link bionicHostGenerate}: sends op="generateStream" and
 * reads MANY length-prefixed frames over the same connection — one
 * {type:"token",text} per decode step (forwarded to {@link onToken}) until a
 * terminal {type:"done",ok,tokens,ms,tokS,text} frame, which resolves the
 * buffered final result. Lets the chat SSE render tokens as the GPU host decodes
 * them (first paint at the first token) instead of waiting for the whole reply.
 */
function bionicHostGenerateStream(
	socketName: string,
	request: Record<string, unknown>,
	onToken: (text: string) => void,
	signal?: AbortSignal,
): Promise<BionicGenerateResponse> {
	const payload = Buffer.from(
		JSON.stringify({ ...request, op: "generateStream" }),
		"utf8",
	);
	const frame = Buffer.allocUnsafe(4 + payload.length);
	frame.writeUInt32BE(payload.length, 0);
	payload.copy(frame, 4);
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortError(signal));
			return;
		}
		const sock = net.connect({ path: `\0${socketName}` });
		let settled = false;
		let chunks = Buffer.alloc(0);
		let abort = () => {};
		const finish = (err: Error | null, value?: BionicGenerateResponse) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", abort);
			sock.destroy();
			err ? reject(err) : resolve(value as BionicGenerateResponse);
		};
		abort = () => finish(abortError(signal as AbortSignal));
		signal?.addEventListener("abort", abort, { once: true });
		sock.on("connect", () => sock.write(frame));
		sock.on("data", (d: Buffer) => {
			chunks = Buffer.concat([chunks, d]);
			// Drain every complete frame currently buffered (>=1 per data event).
			for (;;) {
				if (chunks.length < 4) break;
				const expected = chunks.readUInt32BE(0);
				if (expected < 0 || expected > BIONIC_MAX_FRAME_BYTES) {
					finish(
						new Error(`[mobile-device-bridge] bad bionic frame ${expected}`),
					);
					return;
				}
				if (chunks.length < 4 + expected) break;
				const json = chunks.subarray(4, 4 + expected).toString("utf8");
				chunks = chunks.subarray(4 + expected);
				let msg: { type?: string; text?: string } & BionicGenerateResponse;
				try {
					msg = JSON.parse(json);
				} catch (e) {
					finish(
						new Error(
							`[mobile-device-bridge] bad bionic JSON: ${(e as Error).message}`,
						),
					);
					return;
				}
				if (msg.type === "token") {
					if (typeof msg.text === "string" && msg.text) onToken(msg.text);
					continue;
				}
				// Terminal {type:"done"} frame (or any non-token frame) ends the stream.
				finish(null, msg);
				return;
			}
		});
		sock.on("error", (e: Error) =>
			finish(
				new Error(`[mobile-device-bridge] bionic socket error: ${e.message}`),
			),
		);
		sock.on("close", () => {
			if (!settled)
				finish(new Error("[mobile-device-bridge] bionic host closed early"));
		});
	});
}

/**
 * Clamp a background-priority request to the device-class budget and resolve
 * its bounded lane wait (#11914). Interactive requests pass through untouched
 * with an unbounded lane wait; their owner signal governs operation lifetime.
 */
function resolveMobileLaneBudget(
	priority: LocalInferencePriority,
	prompt: string,
	maxTokens: number | undefined,
): { prompt: string; maxTokens: number | undefined; lockWaitMs?: number } {
	if (priority !== "background") {
		return { prompt, maxTokens };
	}
	const budget = resolveBackgroundInferenceBudget(
		inferenceRamClassFromEnv() ?? "standard",
	);
	const clamped = applyBackgroundInferenceBudget({ prompt, maxTokens }, budget);
	if (clamped.clamped.length > 0) {
		logger.info(
			`[mobile-device-bridge] background generate clamped to the device-class budget: ${clamped.clamped.join(", ")} (#11914)`,
		);
	}
	return {
		prompt: clamped.prompt,
		maxTokens: clamped.maxTokens,
		lockWaitMs: budget.lockWaitMs,
	};
}

function makeGenerateHandler(slot: "TEXT_SMALL" | "TEXT_LARGE") {
	return async (_runtime: IAgentRuntime, params: GenerateTextParams) => {
		// The bionic host decodes ONE request at a time on its resident-model
		// lock, and the device-bridge path shares one loaded model — so every
		// generate goes through the process-wide interactive-over-background
		// lane (#11914): interactive turns dispatch ahead of queued background
		// jobs; background jobs run only when the lane is idle, wait a bounded
		// time, and are clamped to the device-class budget. Without this, one
		// long autonomous job self-queues on the host lock and starves chat.
		const priority = params.priority ?? "interactive";

		// GPU delegation: run the whole decode in the bionic app process over the
		// abstract UDS (the device-bridge renderer path can't reach Vulkan). The
		// in-process host OWNS its default bundle (filesDir/eliza-1/bundle), so a
		// JS-side model file is NOT required here — it is the source of truth for
		// what is loadable on the GPU. If an installed model IS registered
		// (multi-tier / sideloaded) forward its bundle dir; otherwise send empty
		// and let the host load its default bundle. This decouples on-device
		// generation from the JS download registry (a wiped/empty registry must
		// not block a host that already has a model staged).
		const bionicSock = bionicSocketName();
		if (bionicSock) {
			const installed = resolveLocalLoadArgs(slot);
			const lane = resolveMobileLaneBudget(
				priority,
				buildGemmaBionicPrompt(params),
				params.maxTokens ?? 256,
			);
			const baseRequest = {
				bundleDir: installed ? deriveBionicBundleDir(installed.modelPath) : "",
				drafterPath: installed?.draftModelPath ?? "",
				prompt: lane.prompt,
				maxTokens: lane.maxTokens ?? 256,
			};
			const res = await getInferencePriorityGate().runExclusive(
				{
					priority,
					label: `${slot} bionic-host (${lane.prompt.length} chars, maxTokens=${baseRequest.maxTokens})`,
					...(lane.lockWaitMs !== undefined ? { waitMs: lane.lockWaitMs } : {}),
					...(params.signal ? { signal: params.signal } : {}),
				},
				async () => {
					// Always use the streaming host operation. Besides improving TTFT
					// when the caller consumes chunks, each flushed frame observes a
					// disconnected owner so cancellation interrupts native decode
					// instead of waiting for a buffered response to finish.
					const onChunk = params.onStreamChunk;
					const streamStep = resolveBionicStreamStep();
					let accumulated = "";
					return bionicHostGenerateStream(
						bionicSock,
						streamStep !== undefined
							? { ...baseRequest, streamStep }
							: baseRequest,
						(text) => {
							if (typeof onChunk !== "function") return;
							accumulated += text;
							Promise.resolve(onChunk(text, undefined, accumulated)).catch(
								(error) => {
									// error-policy:J5 the returned generation promise remains
									// observable; chunk-consumer failure is reported separately.
									_runtime.reportError(
										"mobile-device-bridge.streamChunk",
										error,
									);
								},
							);
						},
						params.signal,
					);
				},
			);
			if (!res.ok) {
				throw new Error(
					`[mobile-device-bridge] bionic host generate failed: ${res.error ?? "unknown"}`,
				);
			}
			if (typeof res.tokS === "number") {
				logger.info(
					`[mobile-device-bridge] bionic GPU generate: ${res.tokens ?? "?"} tok @ ${res.tokS.toFixed(1)} tok/s`,
				);
			}
			return res.text ?? "";
		}

		// Device-bridge (renderer WebSocket) path: needs a real on-device model
		// file to load + format-chat against, so resolve (with auto-download) here.
		const loadArgs = await resolveLoadArgsWithAutoDownload(slot);
		if (!loadArgs) {
			throw new Error(
				`[mobile-device-bridge] No local GGUF model installed under ${modelsDir()} and auto-download is disabled (ELIZA_DISABLE_MODEL_AUTO_DOWNLOAD=1). Install a model or unset the disable flag.`,
			);
		}

		await mobileDeviceBridge.loadModel({ ...loadArgs, signal: params.signal });
		// Prefer the model's native chat template via the Capacitor
		// `LlamaCpp.getFormattedChat()` round-trip. That path invokes
		// `llama_chat_apply_template()` on the loaded GGUF, which:
		//   * honours the model's own Jinja template (Gemma, Llama-3,
		//     Mistral, Phi, …) without per-model code on our side,
		//   * sets up llama.cpp's internal antiprompt list against the
		//     model's true stop tokens so generation terminates at the
		//     natural assistant-turn boundary (`<|eot_id|>` etc.),
		//   * handles BOS, EOT, system-message edge cases correctly.
		// Fall back to the plain-text flatten when the model has no chat
		// template baked in (older or non-instruct GGUFs) or when the legacy
		// `params.prompt` is already set. The fallback is model-agnostic —
		// no Llama-3 special tokens — so it works across Gemma, Eliza-1, etc.
		const messagesForTemplate = collectMessagesForNativeTemplate(params);
		let nativePrompt: string | null = null;
		if (messagesForTemplate) {
			try {
				nativePrompt = await mobileDeviceBridge.formatChat(
					messagesForTemplate,
					params.signal,
				);
			} catch (err) {
				logger.warn(
					`[mobile-device-bridge] getFormattedChat failed, falling back to plain-text flatten: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
		const prompt = nativePrompt ?? flattenChatParamsForPrompt(params);
		const lane = resolveMobileLaneBudget(priority, prompt, params.maxTokens);
		return getInferencePriorityGate().runExclusive(
			{
				priority,
				label: `${slot} device-bridge (${lane.prompt.length} chars)`,
				...(lane.lockWaitMs !== undefined ? { waitMs: lane.lockWaitMs } : {}),
				...(params.signal ? { signal: params.signal } : {}),
			},
			() =>
				mobileDeviceBridge.generate({
					prompt: lane.prompt,
					stopSequences: params.stopSequences,
					maxTokens: lane.maxTokens,
					temperature: params.temperature,
					signal: params.signal,
				}),
		);
	};
}

// Reshape `params` into the `[{role, content}, ...]` list the native
// `getFormattedChat` call expects. Returns null if `params.messages` is
// empty (caller falls back to plain-text flatten).
function collectMessagesForNativeTemplate(
	params: GenerateTextParams,
): { role: string; content: string }[] | null {
	const messages = params.messages ?? [];
	if (messages.length === 0 && typeof params.prompt === "string") {
		return collectRoleLabeledPromptMessages(params.prompt, params.system);
	}
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

function collectRoleLabeledPromptMessages(
	prompt: string,
	system?: string,
): { role: string; content: string }[] | null {
	if (!/^(system|user|assistant):\n/.test(prompt)) return null;

	const headerPattern = /(^|\n{2,})(system|user|assistant):\n/g;
	const headers: Array<{ index: number; role: string; bodyStart: number }> = [];
	let match = headerPattern.exec(prompt);
	while (match !== null) {
		headers.push({
			index: match.index,
			role: match[2],
			bodyStart: match.index + match[0].length,
		});
		match = headerPattern.exec(prompt);
	}
	if (headers.length === 0) return null;

	const result: { role: string; content: string }[] = [];
	if (system?.trim() && headers[0]?.role !== "system") {
		result.push({ role: "system", content: system.trim() });
	}
	for (let i = 0; i < headers.length; i += 1) {
		const current = headers[i];
		const next = headers[i + 1];
		const rawContent = prompt
			.slice(current.bodyStart, next ? next.index : prompt.length)
			.trim();
		if (!rawContent) continue;
		result.push({ role: current.role, content: rawContent });
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
			throw new Error(
				"[mobile-device-bridge] TEXT_EMBEDDING requires real input; the output width is declared in model registration metadata",
			);
		}
		let loadArgs: LocalInferenceLoadArgs | null =
			resolveLocalLoadArgs("TEXT_EMBEDDING");
		let modelPath = loadArgs?.modelPath ?? null;
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

		// GPU delegation: embed on the in-process bionic host (--pooling last over
		// the fused text model), bypassing the device-bridge. This is what makes
		// on-device memory + doc-seeding run locally instead of failing over to
		// cloud BatchEmbeddings (401 on a fresh local install).
		const bionicSock = bionicSocketName();
		if (bionicSock) {
			const signal = typeof params === "string" ? undefined : params.signal;
			const res = await bionicHostGenerate(
				bionicSock,
				{
					op: "embed",
					bundleDir: deriveBionicBundleDir(loadArgs.modelPath),
					text: extractEmbeddingText(params),
				},
				signal,
			);
			if (!res.ok || !Array.isArray(res.embedding)) {
				throw new Error(
					`[mobile-device-bridge] bionic embed failed: ${res.error ?? "no embedding"}`,
				);
			}
			return res.embedding;
		}

		const signal = typeof params === "string" ? undefined : params.signal;
		await mobileDeviceBridge.loadModel({ ...loadArgs, signal });
		return mobileDeviceBridge.embed({
			input: extractEmbeddingText(params),
			signal,
		});
	};
}

export function getMobileDeviceBridgeStatus(): MobileDeviceBridgeStatus {
	return mobileDeviceBridge.status();
}

export interface MobileDeviceBridgeServingStatus {
	/** Which path bound the capacitor-llama handlers (null = not registered). */
	registeredTrigger: "bionic-host" | "device-bridge" | null;
	/**
	 * True ONLY when the handlers were bound via the in-process bionic host
	 * AND its abstract UDS accepts a connection right now — i.e. the host can
	 * actually serve a generate/embed call (#11498). Never true from mere
	 * plugin presence or env configuration alone.
	 */
	bionicHostServing: boolean;
}

/** True when the bionic host's abstract UDS accepts a connection right now. */
function probeBionicHostSocket(socketName: string): Promise<boolean> {
	return new Promise((resolve) => {
		const sock = net.connect({ path: `\0${socketName}` });
		const finish = (ok: boolean) => {
			sock.destroy();
			resolve(ok);
		};
		sock.on("connect", () => finish(true));
		sock.on("error", () => finish(false));
	});
}

/**
 * The true "in-process bionic host can serve" signal for readiness surfaces
 * (GET /api/local-inference/providers → capacitor-llama.servingVia). The
 * mobile-local-chat-smoke readiness gate accepts this as its third branch
 * alongside hub.active.status==="ready" and device.connected (#11498).
 */
export async function getMobileDeviceBridgeServingStatus(): Promise<MobileDeviceBridgeServingStatus> {
	const socketName = bionicSocketName();
	const bionicHostServing =
		registeredModelTrigger === "bionic-host" &&
		socketName !== null &&
		(await probeBionicHostSocket(socketName));
	return { registeredTrigger: registeredModelTrigger, bionicHostServing };
}

export async function loadMobileDeviceBridgeModel(
	modelPath: string,
	modelId?: string,
): Promise<void> {
	const bionicSock = bionicSocketName();
	if (bionicSock) {
		const bundleDir = deriveBionicBundleDir(modelPath);
		const response = await bionicHostGenerate(bionicSock, {
			op: "load",
			bundleDir,
		});
		if (!response.ok) {
			throw new Error(
				`[mobile-device-bridge] bionic model load failed: ${response.error ?? "unknown error"}`,
			);
		}
		return;
	}
	await mobileDeviceBridge.loadModel(
		modelId
			? buildLoadArgsFromRegistryModel({ id: modelId, path: modelPath })
			: { modelPath },
	);
}

export async function unloadMobileDeviceBridgeModel(): Promise<void> {
	const bionicSock = bionicSocketName();
	if (bionicSock) {
		const response = await bionicHostGenerate(bionicSock, { op: "unload" });
		if (!response.ok) {
			throw new Error(
				`[mobile-device-bridge] bionic model unload failed: ${response.error ?? "unknown error"}`,
			);
		}
		return;
	}
	await mobileDeviceBridge.unloadModel();
}

/**
 * Runtime service wrapper over the module-level {@link mobileDeviceBridge}
 * singleton. Registering this via a plugin `services` array lets consumers
 * resolve the bridge with
 * `runtime.getService(ServiceType.MOBILE_DEVICE_BRIDGE)` instead of reaching a
 * global `Symbol.for` slot or dynamically importing this module by name.
 */
export class CapacitorMobileDeviceBridgeService extends MobileDeviceBridgeService {
	capabilityDescription =
		"Relays on-device GPU inference to a paired mobile device over the device bridge.";

	static async start(
		runtime: IAgentRuntime,
	): Promise<CapacitorMobileDeviceBridgeService> {
		return new CapacitorMobileDeviceBridgeService(runtime);
	}

	getMobileDeviceBridgeStatus(): MobileDeviceBridgeStatus {
		return mobileDeviceBridge.status();
	}

	async loadMobileDeviceBridgeModel(
		modelPath: string,
		modelId?: string,
	): Promise<void> {
		await loadMobileDeviceBridgeModel(modelPath, modelId);
	}

	async unloadMobileDeviceBridgeModel(): Promise<void> {
		await unloadMobileDeviceBridgeModel();
	}

	async stop(): Promise<void> {}
}

export async function attachMobileDeviceBridgeToServer(
	server: HttpServer,
): Promise<void> {
	await mobileDeviceBridge.attachToHttpServer(server);
}

/** Resolve a data:/http(s)/file image URL to base64 image bytes for the host. */
async function imageUrlToBase64(url: string): Promise<string> {
	if (url.startsWith("data:")) {
		const comma = url.indexOf(",");
		return comma >= 0 ? url.slice(comma + 1) : url;
	}
	const resp = await fetch(url);
	if (!resp.ok) {
		throw new Error(
			`[mobile-device-bridge] IMAGE_DESCRIPTION failed to fetch ${url}: ${resp.status}`,
		);
	}
	return Buffer.from(await resp.arrayBuffer()).toString("base64");
}

/**
 * Collapse the degenerate repetition the small on-device vision model emits on
 * sparse UI screenshots (e.g. "…text input field at the bottom." repeated for
 * the whole token budget). We keep the first occurrence of each distinct
 * sentence in order and cap the result, so the agent sees a bounded, low-token
 * description — the EPIC #9105 "continuous low-token screen understanding"
 * shape — without paying for a native generation-loop rebuild.
 */
function collapseDescriptionRepetition(text: string): string {
	const sentences = text
		.replace(/\s+/g, " ")
		.split(/(?<=[.!?])\s+/)
		.map((s) => s.trim())
		.filter(Boolean);
	const seen = new Set<string>();
	const kept: string[] = [];
	for (const sentence of sentences) {
		const key = sentence
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, " ")
			.trim();
		if (key && seen.has(key)) {
			continue;
		}
		seen.add(key);
		kept.push(sentence);
		if (kept.length >= 6) {
			break;
		}
	}
	return kept.join(" ").trim() || text.trim();
}

/**
 * On-device IMAGE_DESCRIPTION via the bionic host (op="image"). The EPIC #9105
 * GET_SCREEN describe loop — and any agent vision-describe — routes here on a
 * bionic-delegated phone: the image bytes go to the in-process GPU host's mmproj
 * describe (`eliza_inference_describe_image`) and come back as text. Without
 * this the mobile build registered NO on-device IMAGE_DESCRIPTION provider
 * (PR #9219's handler lives in `ensureLocalInferenceHandler`, which the mobile
 * agent bundle never reaches), so vision-describe silently fell through to the
 * cloud handler. bundleDir is "" so the host uses its own default bundle (which
 * owns `vision/<mmproj>.gguf` + the resident text model).
 */
function makeBionicImageDescriptionHandler() {
	return async (
		_runtime: IAgentRuntime,
		params: string | { imageUrl?: string; prompt?: string },
	) => {
		const socketName = bionicSocketName();
		if (!socketName) {
			throw new Error(
				"[mobile-device-bridge] IMAGE_DESCRIPTION requires the bionic host (ELIZA_BIONIC_HOST_DELEGATED=1)",
			);
		}
		const url = typeof params === "string" ? params : params?.imageUrl;
		if (typeof url !== "string" || url.length === 0) {
			throw new Error(
				"[mobile-device-bridge] IMAGE_DESCRIPTION requires a non-empty imageUrl",
			);
		}
		const prompt =
			typeof params === "object" && params ? params.prompt : undefined;
		const imageBase64 = await imageUrlToBase64(url);
		const res = await bionicHostGenerate(socketName, {
			op: "image",
			bundleDir: "",
			imageBase64,
			mmprojPath: "",
			prompt: prompt ?? "",
		});
		if (!res.ok) {
			throw new Error(
				`[mobile-device-bridge] bionic image describe failed: ${res.error ?? "unknown error"}`,
			);
		}
		const raw = (res.text ?? "").trim();
		if (!raw) {
			throw new Error(
				"[mobile-device-bridge] bionic image describe returned empty text",
			);
		}
		const description = collapseDescriptionRepetition(raw);
		return {
			title: description.split(/[.!?]/, 1)[0]?.trim() || "Image",
			description,
		};
	};
}

/**
 * Register the capacitor-llama TEXT/embedding handlers on the runtime.
 *
 * Callers must ensure a serving path actually exists first (bionic host
 * delegation, or an attached device bridge): registering these handlers
 * while nothing can serve them makes the dead provider win `useModel`
 * routing and every chat turn fails with DEVICE_DISCONNECTED (#11277).
 */
function registerMobileDeviceBridgeModels(
	runtime: AgentRuntime,
	trigger: "bionic-host" | "device-bridge",
): boolean {
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
		// error-policy:J5 fire-and-forget pre-warm; the failure is surfaced via
		// logger.warn and the real generate() call retries the download on demand
		// (same idempotency guard), so registration must not block on it.
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
		{
			embeddingDimension: resolveEmbeddingDimension(),
			local: true,
		},
	);
	// On-device vision describe (EPIC #9105): route IMAGE_DESCRIPTION to the
	// bionic host op="image" so the GET_SCREEN describe loop runs on the GPU
	// instead of degrading to the cloud handler. Only meaningful when bionic
	// delegation is active; the handler self-checks the socket and throws
	// cleanly otherwise (so a non-bionic build just falls through to the next
	// registered provider).
	if (bionicSocketName()) {
		runtimeWithRegistration.registerModel(
			ModelType.IMAGE_DESCRIPTION,
			makeBionicImageDescriptionHandler(),
			PROVIDER,
			LOCAL_INFERENCE_PRIORITY,
		);
		logger.info(
			"[mobile-device-bridge] Registered bionic IMAGE_DESCRIPTION handler (op=image)",
		);
	}
	const embeddingModelPath = resolveLocalModelPath("TEXT_EMBEDDING");
	if (
		!embeddingModelPath &&
		process.env.ELIZA_DISABLE_MODEL_AUTO_DOWNLOAD?.trim() !== "1"
	) {
		// Kick off the embedding-model download in the background so it's
		// ready by the time the WebView issues a real embed request.
		// error-policy:J5 fire-and-forget pre-warm; surfaced via logger.warn and the
		// first real embed request re-triggers the download, so registration of the
		// TEXT_EMBEDDING handler must not block on it.
		downloadRecommendedModelFor("TEXT_EMBEDDING").catch((err) =>
			logger.warn(
				`[mobile-device-bridge] Background embedding-model download failed: ${(err as Error).message}`,
			),
		);
	}

	logger.info(
		`[mobile-device-bridge] Registered ${PROVIDER} handlers for TEXT_SMALL / TEXT_LARGE${embeddingModelPath ? " / TEXT_EMBEDDING" : ""} at priority ${LOCAL_INFERENCE_PRIORITY} (via ${trigger})`,
	);
	registeredRuntimes.add(runtime);
	registeredModelTrigger = trigger;
	return true;
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

	// Bionic-host delegation: the in-process GPU host serves TEXT/embed over
	// the abstract UDS, so the handlers are live from boot.
	if (bionicSocketName()) {
		return registerMobileDeviceBridgeModels(runtime, "bionic-host");
	}

	// A device bridge is already attached (agent restart while the WebView
	// stayed connected): the handlers can serve immediately.
	if (mobileDeviceBridge.status().connected) {
		return registerMobileDeviceBridgeModels(runtime, "device-bridge");
	}

	// Neither the bionic host nor a device bridge can serve a call right now.
	// Do NOT register the handlers: a registered-but-dead capacitor-llama
	// provider owns the TEXT slots, wins `useModel` routing, and turns every
	// chat turn into "DEVICE_DISCONNECTED: no Capacitor llama device bridge
	// attached" (#11277 — on Android the WebView-side llama-cpp-capacitor
	// plugin is retired, so the WS bridge can never attach). Instead, defer
	// registration until a device genuinely attaches; until then `useModel`
	// fails loud with NoModelProviderConfiguredError, which the chat UI
	// renders as an actionable "no provider configured" hint.
	logger.warn(
		"[mobile-device-bridge] No bionic host delegation and no device bridge attached — " +
			`${PROVIDER} TEXT handlers stay unregistered until a device bridge connects`,
	);
	mobileDeviceBridge.onDeviceAttached(() => {
		registerMobileDeviceBridgeModels(runtime, "device-bridge");
	});
	return false;
}

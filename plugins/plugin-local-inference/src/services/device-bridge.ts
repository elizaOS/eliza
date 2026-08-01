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
 * In-flight generation and embedding requests move to another already-connected
 * device when their device disconnects. Without a surviving device they fail
 * immediately: replaying after reconnect or process restart cannot deliver a
 * useful answer to the original caller and only wastes inference work.
 */

import { randomUUID } from "node:crypto";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { AgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
	computeGenerationThroughput,
	type GenerationThroughput,
} from "@elizaos/shared/local-inference";
import type {
	LocalInferenceLoadArgs,
	LocalInferenceLoader,
} from "./active-model";

const HEARTBEAT_INTERVAL_MS = 15_000;

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
	mtpSupported?: boolean;
	mtpReason?: string;
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
			/**
			 * Time-to-first-token in ms, when the device measured it. Equals the
			 * prefill wall-clock; lets the agent difference prefill vs decode tok/s.
			 * Optional — absent on the non-streaming path (older device clients).
			 */
			ttftMs?: number;
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireOptionalType(
	value: unknown,
	type: "string" | "number" | "boolean",
	field: string,
): void {
	if (value !== undefined && typeof value !== type) {
		throw new TypeError(`${field} must be ${type}`);
	}
}

function parseRegistration(value: Record<string, unknown>): DeviceRegistration {
	if (
		typeof value.deviceId !== "string" ||
		(value.pairingToken !== undefined &&
			typeof value.pairingToken !== "string") ||
		!isRecord(value.capabilities)
	) {
		throw new TypeError("register frame has invalid payload");
	}
	const cap = value.capabilities;
	if (
		(cap.platform !== "ios" &&
			cap.platform !== "android" &&
			cap.platform !== "web" &&
			cap.platform !== "electrobun" &&
			cap.platform !== "desktop") ||
		typeof cap.deviceModel !== "string" ||
		typeof cap.totalRamGb !== "number" ||
		typeof cap.cpuCores !== "number" ||
		(value.loadedPath !== null && typeof value.loadedPath !== "string")
	) {
		throw new TypeError("register frame has invalid capabilities");
	}
	requireOptionalType(cap.machineId, "string", "machineId");
	requireOptionalType(cap.osVersion, "string", "osVersion");
	requireOptionalType(cap.isSimulator, "boolean", "isSimulator");
	if (cap.availableRamGb !== null) {
		requireOptionalType(cap.availableRamGb, "number", "availableRamGb");
	}
	if (cap.freeStorageGb !== null) {
		requireOptionalType(cap.freeStorageGb, "number", "freeStorageGb");
	}
	requireOptionalType(cap.gpuSupported, "boolean", "gpuSupported");
	requireOptionalType(cap.lowPowerMode, "boolean", "lowPowerMode");
	requireOptionalType(cap.mtpSupported, "boolean", "mtpSupported");
	requireOptionalType(cap.mtpReason, "string", "mtpReason");
	if (
		cap.thermalState !== undefined &&
		cap.thermalState !== "nominal" &&
		cap.thermalState !== "fair" &&
		cap.thermalState !== "serious" &&
		cap.thermalState !== "critical" &&
		cap.thermalState !== "unknown"
	) {
		throw new TypeError("thermalState is invalid");
	}
	let gpu: DeviceCapabilities["gpu"] = null;
	if (cap.gpu !== null) {
		if (
			!isRecord(cap.gpu) ||
			(cap.gpu.backend !== "metal" &&
				cap.gpu.backend !== "vulkan" &&
				cap.gpu.backend !== "gpu-delegate" &&
				cap.gpu.backend !== "cuda") ||
			typeof cap.gpu.available !== "boolean" ||
			(cap.gpu.totalVramGb !== undefined &&
				typeof cap.gpu.totalVramGb !== "number")
		) {
			throw new TypeError("gpu capabilities are invalid");
		}
		gpu = {
			backend: cap.gpu.backend,
			available: cap.gpu.available,
			...(typeof cap.gpu.totalVramGb === "number"
				? { totalVramGb: cap.gpu.totalVramGb }
				: {}),
		};
	}
	return {
		deviceId: value.deviceId,
		...(typeof value.pairingToken === "string"
			? { pairingToken: value.pairingToken }
			: {}),
		capabilities: {
			platform: cap.platform,
			deviceModel: cap.deviceModel,
			...(typeof cap.machineId === "string"
				? { machineId: cap.machineId }
				: {}),
			...(typeof cap.osVersion === "string"
				? { osVersion: cap.osVersion }
				: {}),
			...(typeof cap.isSimulator === "boolean"
				? { isSimulator: cap.isSimulator }
				: {}),
			totalRamGb: cap.totalRamGb,
			...(typeof cap.availableRamGb === "number" || cap.availableRamGb === null
				? { availableRamGb: cap.availableRamGb }
				: {}),
			...(typeof cap.freeStorageGb === "number" || cap.freeStorageGb === null
				? { freeStorageGb: cap.freeStorageGb }
				: {}),
			cpuCores: cap.cpuCores,
			gpu,
			...(typeof cap.gpuSupported === "boolean"
				? { gpuSupported: cap.gpuSupported }
				: {}),
			...(typeof cap.lowPowerMode === "boolean"
				? { lowPowerMode: cap.lowPowerMode }
				: {}),
			...(typeof cap.thermalState === "string"
				? { thermalState: cap.thermalState }
				: {}),
			...(typeof cap.mtpSupported === "boolean"
				? { mtpSupported: cap.mtpSupported }
				: {}),
			...(typeof cap.mtpReason === "string"
				? { mtpReason: cap.mtpReason }
				: {}),
		},
		loadedPath: value.loadedPath,
	};
}

function parseDeviceOutbound(text: string): DeviceOutbound {
	const value: unknown = JSON.parse(text);
	if (!isRecord(value) || typeof value.type !== "string") {
		throw new TypeError("frame must be an object with a string type");
	}
	if (value.type === "register") {
		if (!isRecord(value.payload)) {
			throw new TypeError("register frame requires payload");
		}
		return { type: "register", payload: parseRegistration(value.payload) };
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
			value.type !== "embedResult"
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
		typeof value.durationMs === "number" &&
		(value.ttftMs === undefined || typeof value.ttftMs === "number")
	) {
		return {
			type: "generateResult",
			correlationId: value.correlationId,
			ok: true,
			text: value.text,
			promptTokens: value.promptTokens,
			outputTokens: value.outputTokens,
			durationMs: value.durationMs,
			...(typeof value.ttftMs === "number" ? { ttftMs: value.ttftMs } : {}),
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
			/**
			 * Forwarded promptCacheKey from `ProviderCachePlan`. The receiving
			 * device's local-inference layer can use this to derive a stable
			 * slot_id (llama-server) or to look up a session in its session
			 * pool (node-llama-cpp). Old clients ignore the field; new clients
			 * get prefix-cache reuse across calls with the same key.
			 */
			cacheKey?: string;
	  }
	| { type: "embed"; correlationId: string; input: string }
	| { type: "cancel"; correlationId: string }
	| { type: "ping"; at: number };

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new DOMException("The operation was aborted", "AbortError");
}

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

function isWsModule(value: unknown): value is WsModule {
	if (!value || typeof value !== "object") return false;
	const WebSocketServer = Reflect.get(value, "WebSocketServer");
	const WebSocket = Reflect.get(value, "WebSocket");
	if (
		typeof WebSocketServer !== "function" ||
		typeof WebSocket !== "function"
	) {
		return false;
	}
	return (
		typeof Reflect.get(WebSocket, "OPEN") === "number" &&
		typeof Reflect.get(WebSocket, "CLOSED") === "number"
	);
}

async function importWsModule(): Promise<WsModule> {
	const mod: unknown = await import("ws");
	if (!isWsModule(mod)) {
		throw new Error("ws module did not expose WebSocketServer/WebSocket");
	}
	return mod;
}

interface PendingLoad {
	correlationId: string;
	modelPath: string;
	resolve: () => void;
	reject: (err: Error) => void;
	cleanup: () => void;
	routedDeviceId: string;
}

interface PendingUnload {
	correlationId: string;
	resolve: () => void;
	reject: (err: Error) => void;
	cleanup: () => void;
	routedDeviceId: string;
}

interface PendingGenerate {
	correlationId: string;
	resolve: (text: string) => void;
	reject: (err: Error) => void;
	cleanup: () => void;
	request: AgentOutbound;
	/** Device the request is currently owned by after any live reroute. */
	routedDeviceId: string | null;
	/** ISO timestamp captured on first submission for status and diagnostics. */
	submittedAt: string;
}

interface PendingEmbed {
	correlationId: string;
	resolve: (result: { embedding: number[]; tokens: number }) => void;
	reject: (err: Error) => void;
	cleanup: () => void;
	request: AgentOutbound;
	/** Device the request is currently owned by after any live reroute. */
	routedDeviceId: string | null;
	/** ISO timestamp captured on first submission for status and diagnostics. */
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

/**
 * One on-device generation's measured resource signal, emitted to
 * `subscribeGenerationMetrics` listeners after every successful `generateResult`.
 * The Mobile Resource Workbench folds these into a `DeviceResourceMetrics`
 * accumulator (prefill/decode tok/s, TTFT, per-tier aggregation). All
 * throughput fields are `null` when the device could not measure the inputs.
 */
export interface DeviceGenerationMetrics {
	deviceId: string;
	platform: DeviceCapabilities["platform"] | null;
	/** Device model identifier (e.g. `iPhone17,2`) for per-device baselines. */
	deviceModel: string | null;
	promptTokens: number;
	outputTokens: number;
	durationMs: number;
	ttftMs: number | null;
	throughput: GenerationThroughput;
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

	private readonly pendingLoads = new Map<string, PendingLoad>();
	private readonly pendingUnloads = new Map<string, PendingUnload>();
	private readonly pendingGenerates = new Map<string, PendingGenerate>();
	private readonly pendingEmbeds = new Map<string, PendingEmbed>();

	private readonly statusListeners = new Set<
		(status: DeviceBridgeStatus) => void
	>();

	private readonly generationMetricsListeners = new Set<
		(metrics: DeviceGenerationMetrics) => void
	>();

	/** The most recent successful generation's metrics, or null. */
	private lastGenerationMetrics: DeviceGenerationMetrics | null = null;

	/** Bounded ring buffer of recent generation metrics for the dev endpoint. */
	private readonly recentGenerations: DeviceGenerationMetrics[] = [];
	private static readonly RECENT_GENERATIONS_CAP = 200;

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
			primaryDeviceId: primary?.deviceId,
			pendingRequests,
			deviceId: primary?.deviceId,
			capabilities: primary?.capabilities,
			loadedPath: primary?.loadedPath ?? null,
			connectedSince: primary?.connectedSince,
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
			} catch (error) {
				// error-policy:J7 one diagnostic subscriber must not suppress
				// bridge status for every other subscriber.
				logger.warn(
					`[device-bridge] Removing failed status listener: ${error instanceof Error ? error.message : String(error)}`,
				);
				this.statusListeners.delete(listener);
			}
		}
	}

	/**
	 * Subscribe to per-generation throughput metrics. Fires once per successful
	 * on-device generation with the differenced prefill/decode tok/s. Returns an
	 * unsubscribe function.
	 */
	subscribeGenerationMetrics(
		listener: (metrics: DeviceGenerationMetrics) => void,
	): () => void {
		this.generationMetricsListeners.add(listener);
		return () => {
			this.generationMetricsListeners.delete(listener);
		};
	}

	/** The most recent successful generation's measured metrics, or null. */
	latestGenerationMetrics(): DeviceGenerationMetrics | null {
		return this.lastGenerationMetrics;
	}

	/** Most recent generation metrics (newest last), capped at `limit`. */
	recentGenerationMetrics(limit = 50): DeviceGenerationMetrics[] {
		const n = Math.max(0, Math.trunc(limit));
		return this.recentGenerations.slice(-n);
	}

	private emitGenerationMetrics(metrics: DeviceGenerationMetrics): void {
		this.lastGenerationMetrics = metrics;
		this.recentGenerations.push(metrics);
		if (this.recentGenerations.length > DeviceBridge.RECENT_GENERATIONS_CAP) {
			this.recentGenerations.shift();
		}
		for (const listener of this.generationMetricsListeners) {
			try {
				listener(metrics);
			} catch (error) {
				// error-policy:J7 metrics are diagnostics; report and remove a
				// broken subscriber without failing the completed generation.
				logger.warn(
					`[device-bridge] Removing failed metrics listener: ${error instanceof Error ? error.message : String(error)}`,
				);
				this.generationMetricsListeners.delete(listener);
			}
		}
	}

	async attachToHttpServer(server: HttpServer): Promise<void> {
		if (this.wss) return;
		const ws = await importWsModule();
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
				msg = parseDeviceOutbound(text);
			} catch (error) {
				// error-policy:J3 untrusted websocket input is explicitly invalid
				// rather than a healthy empty result.
				logger.warn(
					`[device-bridge] Rejecting invalid device frame: ${error instanceof Error ? error.message : String(error)}`,
				);
				socket.close(4004, "invalid-frame");
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
			} catch (error) {
				// error-policy:J6 the replacement socket already owns this device;
				// warn if the superseded transport cannot be closed.
				logger.warn(
					`[device-bridge] Failed to close superseded socket: ${error instanceof Error ? error.message : String(error)}`,
				);
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
				} catch (error) {
					// error-policy:J6 socket close owns pending-request rejection;
					// heartbeat failure only stops this best-effort timer.
					logger.warn(
						`[device-bridge] Heartbeat send failed: ${error instanceof Error ? error.message : String(error)}`,
					);
					clearInterval(device.heartbeatTimer);
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

		this.emitStatus();
	}

	private onDeviceDisconnected(deviceId: string): void {
		const device = this.devices.get(deviceId);
		if (!device) return;
		clearInterval(device.heartbeatTimer);
		this.devices.delete(deviceId);

		for (const [correlationId, pending] of this.pendingLoads) {
			if (pending.routedDeviceId !== deviceId) continue;
			this.pendingLoads.delete(correlationId);
			pending.cleanup();
			pending.reject(
				new Error(`DEVICE_DISCONNECTED: ${deviceId} during model load`),
			);
		}
		for (const [correlationId, pending] of this.pendingUnloads) {
			if (pending.routedDeviceId !== deviceId) continue;
			this.pendingUnloads.delete(correlationId);
			pending.cleanup();
			pending.reject(
				new Error(`DEVICE_DISCONNECTED: ${deviceId} during model unload`),
			);
		}

		const replacement = this.pickBestDevice();
		let rerouted = 0;
		let rejected = 0;
		for (const [correlationId, pending] of this.pendingGenerates) {
			if (pending.routedDeviceId !== deviceId) continue;
			if (replacement) {
				try {
					this.sendToDevice(replacement.deviceId, pending.request);
					pending.routedDeviceId = replacement.deviceId;
					rerouted += 1;
					continue;
				} catch (err) {
					// error-policy:J1 reroute boundary rejects the owning call.
					this.pendingGenerates.delete(correlationId);
					pending.cleanup();
					pending.reject(err instanceof Error ? err : new Error(String(err)));
					rejected += 1;
					continue;
				}
			}
			this.pendingGenerates.delete(correlationId);
			pending.cleanup();
			pending.reject(
				new Error(`DEVICE_DISCONNECTED: ${deviceId} during generation`),
			);
			rejected += 1;
		}
		for (const [correlationId, pending] of this.pendingEmbeds) {
			if (pending.routedDeviceId !== deviceId) continue;
			if (replacement) {
				try {
					this.sendToDevice(replacement.deviceId, pending.request);
					pending.routedDeviceId = replacement.deviceId;
					rerouted += 1;
					continue;
				} catch (err) {
					// error-policy:J1 reroute boundary rejects the owning call.
					this.pendingEmbeds.delete(correlationId);
					pending.cleanup();
					pending.reject(err instanceof Error ? err : new Error(String(err)));
					rejected += 1;
					continue;
				}
			}
			this.pendingEmbeds.delete(correlationId);
			pending.cleanup();
			pending.reject(
				new Error(`DEVICE_DISCONNECTED: ${deviceId} during embedding`),
			);
			rejected += 1;
		}

		logger.info(
			`[device-bridge] Device disconnected: ${deviceId}; rerouted=${rerouted} rejected=${rejected}`,
		);

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
			this.pendingLoads.delete(msg.correlationId);
			pending.cleanup();
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
			this.pendingUnloads.delete(msg.correlationId);
			pending.cleanup();
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
			this.pendingGenerates.delete(msg.correlationId);
			pending.cleanup();
			if (msg.ok === false) {
				pending.reject(new Error(msg.error));
			} else {
				// Difference the raw counters into prefill/decode tok/s and surface
				// them to profiling subscribers. The loader contract is unchanged —
				// callers still get the text; metrics are a side channel.
				const ttftMs = typeof msg.ttftMs === "number" ? msg.ttftMs : null;
				const throughput = computeGenerationThroughput({
					promptTokens: msg.promptTokens,
					outputTokens: msg.outputTokens,
					durationMs: msg.durationMs,
					ttftMs,
				});
				const device = pending.routedDeviceId
					? this.devices.get(pending.routedDeviceId)
					: null;
				this.emitGenerationMetrics({
					deviceId: pending.routedDeviceId ?? "unknown",
					platform: device?.capabilities.platform ?? null,
					deviceModel: device?.capabilities.deviceModel ?? null,
					promptTokens: msg.promptTokens,
					outputTokens: msg.outputTokens,
					durationMs: msg.durationMs,
					ttftMs,
					throughput,
				});
				pending.resolve(msg.text);
			}
			return;
		}

		if (msg.type === "embedResult") {
			const pending = this.pendingEmbeds.get(msg.correlationId);
			if (!pending) return;
			this.pendingEmbeds.delete(msg.correlationId);
			pending.cleanup();
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
		args.signal?.throwIfAborted();
		const best = this.pickBestDevice({ preferLoadedPath: args.modelPath });
		if (!best) {
			throw new Error(
				"DEVICE_DISCONNECTED: no mobile / desktop bridge device attached",
			);
		}
		const { signal, ...wireArgs } = args;
		const correlationId = randomUUID();
		return new Promise<void>((resolve, reject) => {
			let abort = () => {};
			const cleanup = () => signal?.removeEventListener("abort", abort);
			abort = () => {
				if (!this.pendingLoads.delete(correlationId)) return;
				cleanup();
				reject(abortError(signal as AbortSignal));
			};
			this.pendingLoads.set(correlationId, {
				correlationId,
				modelPath: args.modelPath,
				resolve,
				reject,
				cleanup,
				routedDeviceId: best.deviceId,
			});
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) {
				abort();
				return;
			}
			try {
				this.sendToDevice(best.deviceId, {
					type: "load",
					correlationId,
					...wireArgs,
				});
			} catch (err) {
				// error-policy:J1 transport boundary rejects the owning load.
				this.pendingLoads.delete(correlationId);
				cleanup();
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}

	async unloadModel(signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		// Unload every device concurrently while preserving any failure.
		const targets = [...this.devices.values()].filter((d) => d.loadedPath);
		if (targets.length === 0) return;
		await Promise.all(
			targets.map(
				(device) =>
					new Promise<void>((resolve, reject) => {
						const correlationId = randomUUID();
						let abort = () => {};
						const cleanup = () => signal?.removeEventListener("abort", abort);
						abort = () => {
							if (!this.pendingUnloads.delete(correlationId)) return;
							cleanup();
							reject(abortError(signal as AbortSignal));
						};
						this.pendingUnloads.set(correlationId, {
							correlationId,
							resolve,
							reject,
							cleanup,
							routedDeviceId: device.deviceId,
						});
						signal?.addEventListener("abort", abort, { once: true });
						if (signal?.aborted) {
							abort();
							return;
						}
						try {
							this.sendToDevice(device.deviceId, {
								type: "unload",
								correlationId,
							});
						} catch (err) {
							// error-policy:J1 transport boundary rejects the owning unload.
							this.pendingUnloads.delete(correlationId);
							cleanup();
							reject(err instanceof Error ? err : new Error(String(err)));
						}
					}),
			),
		);
		signal?.throwIfAborted();
	}

	currentModelPath(): string | null {
		// The primary device's loaded path wins — consistent with which device
		// would actually run the next generate.
		const best = this.pickBestDevice();
		return best?.loadedPath ?? null;
	}

	async embed(args: {
		input: string;
		signal?: AbortSignal;
	}): Promise<{ embedding: number[]; tokens: number }> {
		args.signal?.throwIfAborted();
		const correlationId = randomUUID();
		const request: AgentOutbound = {
			type: "embed",
			correlationId,
			input: args.input,
		};

		const best = this.pickBestDevice();
		if (!best) {
			throw new Error(
				"DEVICE_DISCONNECTED: no mobile / desktop bridge device attached",
			);
		}

		return new Promise<{ embedding: number[]; tokens: number }>(
			(resolve, reject) => {
				let abort = () => {};
				const cleanup = () => args.signal?.removeEventListener("abort", abort);
				abort = () => {
					if (!this.pendingEmbeds.delete(correlationId)) return;
					cleanup();
					reject(abortError(args.signal as AbortSignal));
				};
				const pending: PendingEmbed = {
					correlationId,
					resolve,
					reject,
					cleanup,
					request,
					routedDeviceId: best.deviceId,
					submittedAt: new Date().toISOString(),
				};
				this.pendingEmbeds.set(correlationId, pending);
				args.signal?.addEventListener("abort", abort, { once: true });
				if (args.signal?.aborted) {
					abort();
					return;
				}

				try {
					this.sendToDevice(best.deviceId, request);
				} catch (err) {
					// error-policy:J1 transport boundary rejects the owning embedding.
					this.pendingEmbeds.delete(correlationId);
					cleanup();
					reject(err instanceof Error ? err : new Error(String(err)));
				}
			},
		);
	}

	async generate(args: {
		prompt: string;
		stopSequences?: string[];
		maxTokens?: number;
		temperature?: number;
		signal?: AbortSignal;
		cacheKey?: string;
	}): Promise<string> {
		args.signal?.throwIfAborted();
		const correlationId = randomUUID();
		const request: AgentOutbound = {
			type: "generate",
			correlationId,
			prompt: args.prompt,
			stopSequences: args.stopSequences,
			maxTokens: args.maxTokens,
			temperature: args.temperature,
			cacheKey: args.cacheKey,
		};

		const best = this.pickBestDevice();
		if (!best) {
			throw new Error(
				"DEVICE_DISCONNECTED: no mobile / desktop bridge device attached",
			);
		}

		return new Promise<string>((resolve, reject) => {
			let abort = () => {};
			const cleanup = () => args.signal?.removeEventListener("abort", abort);
			abort = () => {
				const active = this.pendingGenerates.get(correlationId);
				if (!active) return;
				this.pendingGenerates.delete(correlationId);
				cleanup();
				if (active.routedDeviceId) {
					try {
						this.sendToDevice(active.routedDeviceId, {
							type: "cancel",
							correlationId,
						});
					} catch (error) {
						// error-policy:J6 the caller is already cancelled; warn when the
						// native producer could not be stopped so leaked work is visible.
						logger.warn(
							`[device-bridge] Failed to cancel generation ${correlationId}: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
				}
				reject(abortError(args.signal as AbortSignal));
			};
			const pending: PendingGenerate = {
				correlationId,
				resolve,
				reject,
				cleanup,
				request,
				routedDeviceId: best.deviceId,
				submittedAt: new Date().toISOString(),
			};
			this.pendingGenerates.set(correlationId, pending);
			args.signal?.addEventListener("abort", abort, { once: true });
			if (args.signal?.aborted) {
				abort();
				return;
			}

			try {
				this.sendToDevice(best.deviceId, request);
			} catch (err) {
				// error-policy:J1 transport boundary rejects the owning generation.
				this.pendingGenerates.delete(correlationId);
				cleanup();
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}
}

export const deviceBridge = new DeviceBridge();

/** Shape returned by `GET /api/dev/device-resource-metrics`. */
export interface DeviceResourceMetricsDevPayload {
	generatedAtEpochMs: number;
	status: DeviceBridgeStatus;
	latest: DeviceGenerationMetrics | null;
	recentGenerations: DeviceGenerationMetrics[];
}

/**
 * Build the JSON body for `GET /api/dev/device-resource-metrics` — the Mobile
 * Resource Workbench reads this to harvest per-generation prefill/decode tok/s
 * (already differenced by the bridge) without driving the device WebView.
 */
export function buildDeviceResourceMetricsDevPayload(
	bridge: DeviceBridge = deviceBridge,
	limit = 50,
): DeviceResourceMetricsDevPayload {
	return {
		generatedAtEpochMs: Date.now(),
		status: bridge.status(),
		latest: bridge.latestGenerationMetrics(),
		recentGenerations: bridge.recentGenerationMetrics(limit),
	};
}

export function registerDeviceBridgeLoader(runtime: AgentRuntime): void {
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
	runtime.registerServiceInstance(
		"localInferenceLoader",
		Object.assign(loader, {
			capabilityDescription: "Remote device local inference backend",
			stop: () => loader.unloadModel(),
		}),
	);
	logger.info(
		"[device-bridge] Registered device-bridge loader for remote on-device inference",
	);
}

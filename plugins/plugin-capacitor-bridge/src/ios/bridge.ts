import { Buffer } from "node:buffer";
import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import {
	ChannelType,
	createMessageMemory,
	type GenerateTextParams,
	type IAgentRuntime,
	type Memory,
	type MemoryMetadata,
	ModelType,
	type StreamChunkCallback,
	stringToUuid,
	type UUID,
} from "@elizaos/core";
import {
	summarizeTranscript,
	type Transcript,
	type TranscriptScope,
	type TranscriptSegment,
	type TranscriptSource,
	type TranscriptSummary,
	transcriptDurationMs,
	transcriptPreview,
	transcriptSpeakerCount,
} from "@elizaos/shared/transcripts";
import {
	createWriteStream,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "../shared/fs-proxy.ts";
import { installMobileFsShim } from "../shared/fs-shim.ts";
import {
	resolveStoredModelPath,
	toStoredModelPath,
} from "../shared/local-inference-stored-path.ts";
import {
	createStdioBridge,
	type StdioBridgeRequestFrame as BridgeRequest,
	type StdioBridgeResponseFrame as BridgeResponse,
} from "../shared/stdio-bridge.ts";
import { runModelGrind } from "./model-grind.ts";

// `BridgeRequest` / `BridgeResponse` are the shared stdio frame types
// (imported above as aliases) — the single source of truth for the NDJSON
// request/response envelope this bridge speaks.

interface HostCallFrame {
	type: "host_call";
	id: string;
	method: string;
	payload?: unknown;
	timeoutMs?: number;
}

interface HostResultFrame {
	type: "host_result";
	id?: unknown;
	envelope?: unknown;
	ok?: boolean;
	result?: unknown;
	error?: string;
}

interface BridgeStatusResult {
	ready: boolean;
	engine: "bun";
	transport: "bun-host-ipc";
	bridgeVersion: "bun-ios:3";
	phase?: "starting" | "error";
	error?: string;
}

interface BridgeReadyFrame {
	type: "ready";
	ok: boolean;
	result?: BridgeStatusResult;
	error?: string;
}

type BridgeFrame = BridgeReadyFrame | BridgeResponse;
type BridgeOutboundFrame = BridgeFrame | HostCallFrame;

interface HttpRequestPayload {
	method?: unknown;
	path?: unknown;
	headers?: unknown;
	body?: unknown;
	bodyBase64?: unknown;
	bodyEncoding?: unknown;
	timeoutMs?: unknown;
}

interface HttpStreamRequestPayload extends HttpRequestPayload {
	/**
	 * The stream identity the caller pre-allocated so it can attach
	 * `agentStream*` listeners before this request runs (the native `call`
	 * blocks until the stream finishes, so listeners must be live first).
	 */
	streamId?: unknown;
}

/**
 * One outbound stream event, carried from the bridge to the WebView as a
 * `stream_emit` host-call. The kinds mirror the Android `agentStream*` Capacitor
 * events so `createNativeStreamingResponse` consumes iOS streams unmodified:
 * `response` (head) → `chunk` (base64 SSE bytes) → `complete`.
 */
export type StreamEmitFrame =
	| {
			streamId: string;
			kind: "response";
			status: number;
			statusText?: string;
			headers?: Record<string, string>;
	  }
	| { streamId: string; kind: "chunk"; dataBase64: string }
	| { streamId: string; kind: "complete"; error?: string | null };

/** Delivers one stream event to the native host (→ `notifyListeners`). */
export type StreamEmitter = (frame: StreamEmitFrame) => Promise<void> | void;

export interface IosBridgeBackend {
	/**
	 * The runtime is the canonical entry point for IPC routing. `dispatchRoute`
	 * runs the matched route handler directly, with no loopback HTTP hop.
	 */
	runtime: IAgentRuntime;
	dispatchRoute: DispatchRoute;
	conversations: Map<string, IosConversation>;
	close: () => Promise<void>;
}

type DispatchRoute = (args: {
	runtime: IAgentRuntime;
	method: string;
	path: string;
	headers: Record<string, string>;
	query: Record<string, string | string[]>;
	body: unknown;
	inProcess: true;
	isAuthorized: () => true;
}) => Promise<
	| {
			status: number;
			headers?: Record<string, string>;
			body?: unknown;
	  }
	| null
	| undefined
>;

type AgentModule = {
	bootElizaRuntime: () => Promise<IAgentRuntime>;
	dispatchRoute: DispatchRoute;
};

async function loadAgentModule(): Promise<AgentModule> {
	const [{ bootElizaRuntime }, { dispatchRoute }] = await Promise.all([
		import("@elizaos/agent/runtime"),
		import("@elizaos/agent/api"),
	]);
	return { bootElizaRuntime, dispatchRoute };
}

interface IosBridgeHost {
	backendPromise: Promise<IosBridgeBackend> | null;
	backend: IosBridgeBackend | null;
	bootError: unknown;
}

interface IosConversation {
	id: string;
	title: string;
	roomId: UUID;
	createdAt: string;
	updatedAt: string;
	metadata?: Record<string, unknown>;
	lastUserText?: string;
	lastAssistantText?: string;
	lastAgentName?: string;
}

interface BufferedHttpResponse {
	status: number;
	statusText: string;
	headers: Record<string, string>;
	body: string;
	bodyBase64: string;
	bodyEncoding: "utf-8";
}

interface InstalledModelEntry {
	id: string;
	displayName?: string;
	path: string;
	sizeBytes?: number;
	installedAt?: string;
	lastUsedAt?: string | null;
	source?: string;
	hfRepo?: string;
	bundleVerifiedAt?: string;
	dimensions?: number;
	embeddingDimension?: number;
	embeddingDimensions?: number;
}

interface NativeVoiceReadiness {
	status: "missing" | "assets-ready" | "engine-ready" | "ready" | "unavailable";
	installedFiles: number;
	modelId: string | null;
	message: string;
}

interface NativeLocalTtsRequest {
	text: string;
	voice?: string;
	voiceId?: string;
	model?: string;
	modelId?: string;
	sampleRate?: number;
	format?: string;
}

interface NativeLocalAsrRequest {
	// Mono fp32 PCM in [-1, 1]. Carried to the native host as a JSON number
	// array (see `transcribeNativeIosLocalAsr` / `handleAsrTranscribe` in Swift).
	pcm: number[];
	sampleRate?: number;
}

interface NativeCatalogModelEntry {
	id: string;
	displayName: string;
	hfRepo: string;
	hfPath: string;
	ggufFile: string;
	sizeGb: number;
	minRamGb: number;
	params: string;
	bucket: "small" | "mid" | "large";
	contextLength: number;
}

interface NativeDownloadJob {
	jobId: string;
	modelId: string;
	state: "queued" | "downloading" | "completed" | "failed" | "cancelled";
	received: number;
	total: number;
	bytesPerSec: number;
	etaMs: number | null;
	startedAt: string;
	updatedAt: string;
	error?: string;
}

interface NativeLlamaState {
	contextId: number | null;
	modelId: string | null;
	modelPath: string | null;
	loadedAt: string | null;
	status: "idle" | "loading" | "ready" | "error";
	error?: string;
}

interface RuntimeMessageService {
	handleMessage: (
		runtime: IAgentRuntime,
		message: ReturnType<typeof createMessageMemory>,
		onResponse: (
			content: { text?: string } | null | undefined,
		) => Promise<unknown[]> | unknown[],
	) => Promise<unknown> | unknown;
}

type GenerateTextHandler = (
	runtime: IAgentRuntime,
	params: GenerateTextParams,
) => Promise<string>;

type RuntimeWithModelRegistration = IAgentRuntime & {
	registerModel?: (
		modelType: string | number,
		handler: GenerateTextHandler,
		provider: string,
		priority?: number,
	) => void;
};

const IOS_NATIVE_LLAMA_PROVIDER = "capacitor-llama";
const IOS_NATIVE_LLAMA_DEVICE_ID = "ios-native-llama";
const IOS_NATIVE_LLAMA_PRIORITY = 0;
const ELIZA_1_HF_REPO = "elizaos/eliza-1";
const IOS_NATIVE_CATALOG_MODELS: NativeCatalogModelEntry[] = [
	{
		id: "eliza-1-2b",
		displayName: "eliza-1-2B",
		hfRepo: ELIZA_1_HF_REPO,
		hfPath: "bundles/2b/text/eliza-1-2b-128k.gguf",
		ggufFile: "text/eliza-1-2b-128k.gguf",
		sizeGb: 1.4,
		minRamGb: 4,
		params: "2B",
		bucket: "small",
		contextLength: 131_072,
	},
];
const IOS_NATIVE_ASSIGNMENT_SLOTS = new Set([
	"TEXT_SMALL",
	"TEXT_LARGE",
	"TEXT_TO_SPEECH",
	"TRANSCRIPTION",
]);
const IOS_NATIVE_NO_THINK_SYSTEM =
	"Answer with final user-visible content only. Do not include private reasoning, analysis tags, or <think> blocks.";
const TEXT_GENERATION_MODEL_TYPES = [
	ModelType.TEXT_NANO,
	ModelType.TEXT_SMALL,
	ModelType.TEXT_MEDIUM,
	ModelType.TEXT_LARGE,
	ModelType.RESPONSE_HANDLER,
	ModelType.ACTION_PLANNER,
	ModelType.TEXT_COMPLETION,
] as const;
const nativeLlamaState: NativeLlamaState = {
	contextId: null,
	modelId: null,
	modelPath: null,
	loadedAt: null,
	status: "idle",
};
const nativeDownloadState = new Map<string, NativeDownloadJob>();
const pendingHostCalls = new Map<
	string,
	{
		resolve: (value: unknown) => void;
		reject: (error: Error) => void;
		timeout: ReturnType<typeof setTimeout>;
	}
>();
let hostProtocolWrite: ((frame: BridgeOutboundFrame) => void) | null = null;
let nextHostCallId = 1;

function normalizeHeaderRecord(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const out: Record<string, string> = {};
	for (const [key, raw] of Object.entries(value)) {
		if (typeof raw === "string") out[key] = raw;
		else if (typeof raw === "number" || typeof raw === "boolean") {
			out[key] = String(raw);
		}
	}
	return out;
}

function isSafeLocalPath(path: string): boolean {
	return (
		path.startsWith("/") &&
		!path.startsWith("//") &&
		!/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(path)
	);
}

function normalizeMethod(value: unknown): string {
	const method = (typeof value === "string" ? value : "GET")
		.trim()
		.toUpperCase();
	if (!/^[A-Z]{1,16}$/.test(method)) {
		throw new Error("Unsupported HTTP method");
	}
	return method;
}

function argvValue(argv: string[], flag: string): string | null {
	const index = argv.indexOf(flag);
	if (index < 0) return null;
	const value = argv[index + 1];
	return typeof value === "string" && value.length > 0 ? value : null;
}

function setProcessEnv(
	key: string,
	value: string | null | undefined,
	overwrite = true,
): void {
	if (!key || typeof value !== "string" || value.length === 0) return;
	if (!overwrite && process.env[key]) return;
	try {
		process.env[key] = value;
	} catch {
		// Some embedded runtimes expose process.env through a host object. If it is
		// readonly, later fallbacks still use argv-derived values directly.
	}
}

interface HydratedIosArgvEnv {
	appSupportDir: string | null;
	bundlePath: string | null;
}

function hydrateIosEnvFromArgv(
	argv: string[] = process.argv,
): HydratedIosArgvEnv {
	const rawEnv = argvValue(argv, "--eliza-ios-env-json");
	if (rawEnv) {
		try {
			const parsed = JSON.parse(rawEnv);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				for (const [key, value] of Object.entries(parsed)) {
					if (typeof value === "string") setProcessEnv(key, value, true);
				}
			}
		} catch (error) {
			console.error(
				"[ios-bridge] failed to parse argv env envelope:",
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	const appSupportDir =
		argvValue(argv, "--eliza-ios-app-support-dir") ||
		process.env.ELIZA_IOS_APP_SUPPORT_DIR ||
		process.env.ELIZA_HOME ||
		null;
	const bundlePath =
		argvValue(argv, "--eliza-ios-agent-bundle") ||
		process.env.ELIZA_IOS_AGENT_BUNDLE ||
		null;

	if (appSupportDir) {
		setProcessEnv("HOME", appSupportDir, true);
		setProcessEnv("ELIZA_HOME", appSupportDir, true);
		setProcessEnv("ELIZA_STATE_DIR", appSupportDir, true);
		setProcessEnv("ELIZA_IOS_APP_SUPPORT_DIR", appSupportDir, true);
		setProcessEnv("MOBILE_WORKSPACE_ROOT", appSupportDir, true);
		setProcessEnv(
			"ELIZA_WORKSPACE_DIR",
			path.join(appSupportDir, "workspace"),
			true,
		);
		setProcessEnv(
			"PGLITE_DATA_DIR",
			path.join(appSupportDir, ".elizadb"),
			true,
		);
	}

	if (bundlePath) {
		setProcessEnv("ELIZA_IOS_AGENT_BUNDLE", bundlePath, true);
		const assetDir = path.dirname(bundlePath);
		setProcessEnv("ELIZA_IOS_AGENT_ASSET_DIR", assetDir, true);
		setProcessEnv("ELIZA_IOS_AGENT_PUBLIC_DIR", path.dirname(assetDir), true);
	}

	return { appSupportDir, bundlePath };
}

/**
 * Install process-level crash guards for the on-device iOS runtime.
 *
 * The Bun runtime here IS the iOS app's WebView host process, so a default
 * `unhandledRejection`/`uncaughtException` termination kills the whole app and
 * forces the user to relaunch from the home screen. Instead we keep the runtime
 * alive: a rejected background promise is logged and ignored, and an uncaught
 * exception is logged but does not exit — a degraded-but-alive agent beats a
 * dead app, and the bridge's boot-retry recovers transient failures.
 *
 * Inlined (not imported from `@elizaos/shared`) so the mobile bundle's
 * dependency set is unchanged. Idempotent via a globalThis latch.
 */
function installIosBackendCrashGuards(): void {
	const slot = globalThis as { __elizaIosCrashGuardsInstalled?: boolean };
	if (slot.__elizaIosCrashGuardsInstalled) return;
	slot.__elizaIosCrashGuardsInstalled = true;
	const format = (value: unknown): string =>
		value instanceof Error ? (value.stack ?? value.message) : String(value);
	process.on("unhandledRejection", (reason) => {
		console.error(
			"[ios-bridge] Unhandled promise rejection (non-fatal):",
			format(reason),
		);
	});
	process.on("uncaughtException", (error) => {
		console.error(
			"[ios-bridge] Uncaught exception (agent kept alive):",
			format(error),
		);
	});
}

/**
 * Boot the runtime with a bounded retry so a transient init failure (a slow
 * keychain read, a model file still being written, a flaky first DB open)
 * self-heals instead of permanently wedging the backend in `bootError`.
 */
async function bootRuntimeWithRetry(
	boot: () => Promise<IAgentRuntime>,
): Promise<IAgentRuntime> {
	const maxAttempts = 3;
	let lastError: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			return await boot();
		} catch (error) {
			lastError = error;
			if (attempt >= maxAttempts) break;
			const backoffMs = 1000 * 2 ** (attempt - 1);
			console.error(
				`[ios-bridge] runtime boot attempt ${attempt}/${maxAttempts} failed; retrying in ${backoffMs}ms:`,
				error instanceof Error ? error.message : String(error),
			);
			await new Promise((resolve) => setTimeout(resolve, backoffMs));
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function startIosBridgeBackend(): Promise<IosBridgeBackend> {
	installIosBackendCrashGuards();
	const argvEnv = hydrateIosEnvFromArgv();
	// ── Mobile filesystem sandbox ────────────────────────────────────────────
	// Install the fs shim as the very first action — before any runtime code
	// runs — so that PGlite, trajectory logs, skill files, and all other agent
	// I/O is confined to the app's writable workspace directory.
	//
	// MOBILE_WORKSPACE_ROOT is set by the native Swift host (ElizaBunEngine)
	// to `SandboxPaths.appSupport + "/workspace"`.  On Android it is set by
	// the nodejs-mobile bridge to `context.getFilesDir()/eliza/workspace`.
	// Fall back to a sensible default so the agent can still boot in
	// simulator / dev builds where the native host hasn't set it yet.
	const mobileWorkspaceRoot =
		process.env.MOBILE_WORKSPACE_ROOT ||
		argvEnv.appSupportDir ||
		process.env.ELIZA_WORKSPACE_DIR ||
		process.env.ELIZA_STATE_DIR ||
		process.env.ELIZA_HOME ||
		(process.env.HOME
			? `${process.env.HOME}/Library/Application Support/Eliza/workspace`
			: "/tmp/eliza-workspace");
	installMobileFsShim(mobileWorkspaceRoot);

	(
		globalThis as { __ELIZA_DISABLE_DIRECT_RUN?: boolean }
	).__ELIZA_DISABLE_DIRECT_RUN = true;
	process.env.ELIZA_PLATFORM = process.env.ELIZA_PLATFORM || "ios";
	process.env.ELIZA_MOBILE_PLATFORM =
		process.env.ELIZA_MOBILE_PLATFORM || "ios";
	process.env.ELIZA_IOS_LOCAL_BACKEND =
		process.env.ELIZA_IOS_LOCAL_BACKEND || "1";
	process.env.ELIZA_DISABLE_DIRECT_RUN =
		process.env.ELIZA_DISABLE_DIRECT_RUN || "1";
	process.env.ELIZA_HEADLESS = process.env.ELIZA_HEADLESS || "1";
	process.env.ELIZA_IOS_BRIDGE_TRANSPORT =
		process.env.ELIZA_IOS_BRIDGE_TRANSPORT || "bun-host-ipc";
	process.env.ELIZA_VAULT_BACKEND = process.env.ELIZA_VAULT_BACKEND || "file";
	process.env.ELIZA_DISABLE_VAULT_PROFILE_RESOLVER =
		process.env.ELIZA_DISABLE_VAULT_PROFILE_RESOLVER || "1";
	process.env.ELIZA_DISABLE_AGENT_WALLET_BOOTSTRAP =
		process.env.ELIZA_DISABLE_AGENT_WALLET_BOOTSTRAP || "1";
	process.env.LOG_LEVEL = process.env.LOG_LEVEL || "error";

	const { bootElizaRuntime, dispatchRoute } = await loadAgentModule();

	const runtime = await bootRuntimeWithRetry(bootElizaRuntime);
	installIosNativeLlamaHandlers(runtime);
	installKeepAwakeBridge();
	installBackgroundDownloadBridge();

	maybeAutoRunModelGrind();

	return {
		runtime,
		dispatchRoute,
		conversations: new Map(),
		close: async () => {
			await unloadNativeLlamaModel().catch(() => undefined);
		},
	};
}

/**
 * Env-gated on-device grind: when ELIZA_IOS_RUN_MODEL_GRIND=1, run the
 * grind-all-models telemetry self-test once the native host IPC is wired, then
 * log + persist the report. Non-blocking — never delays boot.
 */
function maybeAutoRunModelGrind(): void {
	if (process.env.ELIZA_IOS_RUN_MODEL_GRIND !== "1") return;
	void (async () => {
		const deadline = Date.now() + 120_000;
		while (hostProtocolWrite == null && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 500));
		}
		if (hostProtocolWrite == null) {
			console.error("[model-grind] native host never wired; skipping");
			return;
		}
		try {
			const report = await runModelGrind({
				callIosHost,
				ensureTextModelLoaded: (slot) => ensureNativeModelLoaded(slot),
				synthesizeTts: async (text) => ({
					bytes: await synthesizeNativeIosLocalTts({ text }),
					sampleRate: 24_000,
				}),
				transcribeAsr: (pcm, sampleRate) =>
					transcribeNativeIosLocalAsr({ pcm, sampleRate }),
				hardwareInfo: () => nativeHardwareInfo(),
				bundleDir: nativeVoiceBundleDir(),
			});
			const json = JSON.stringify(report);
			console.log(`[model-grind] REPORT ${json}`);
			const supportDir = process.env.ELIZA_IOS_APP_SUPPORT_DIR?.trim();
			if (supportDir) {
				try {
					writeFileSync(
						path.join(supportDir, "model-grind-report.json"),
						`${JSON.stringify(report, null, 2)}\n`,
					);
				} catch (error) {
					console.error(
						"[model-grind] report write failed:",
						error instanceof Error ? error.message : error,
					);
				}
			}
		} catch (error) {
			console.error(
				"[model-grind] grind failed:",
				error instanceof Error ? error.message : error,
			);
		}
	})();
}

function startIosBridgeHost(): IosBridgeHost {
	const host: IosBridgeHost = {
		backend: null,
		bootError: null,
		backendPromise: null,
	};
	return host;
}

function ensureIosBridgeBackendStarted(
	host: IosBridgeHost,
): Promise<IosBridgeBackend> {
	if (host.backendPromise) return host.backendPromise;
	host.backendPromise = startIosBridgeBackend().then(
		(backend) => {
			host.backend = backend;
			return backend;
		},
		(error) => {
			host.bootError = error;
			throw error;
		},
	);
	host.backendPromise.catch(() => {
		return undefined;
	});
	return host.backendPromise;
}

async function awaitIosBridgeBackend(
	host: IosBridgeHost,
	timeoutMs: number | undefined,
	label: string,
): Promise<IosBridgeBackend> {
	if (host.backend) return host.backend;
	if (host.bootError) {
		throw host.bootError instanceof Error
			? host.bootError
			: new Error(String(host.bootError));
	}
	const result = await timeoutAfter(
		ensureIosBridgeBackendStarted(host),
		timeoutMs,
		`${label} backend startup`,
	);
	if (isTimeoutMarker(result)) {
		throw new Error(`${result.label} timed out after ${result.timeoutMs}ms`);
	}
	return result;
}

function splitPathAndQuery(rawPath: string): {
	pathname: string;
	query: Record<string, string | string[]>;
} {
	const qIndex = rawPath.indexOf("?");
	if (qIndex < 0) return { pathname: rawPath, query: {} };
	const pathname = rawPath.slice(0, qIndex);
	const params = new URLSearchParams(rawPath.slice(qIndex + 1));
	const query: Record<string, string | string[]> = {};
	for (const key of params.keys()) {
		const all = params.getAll(key);
		query[key] = all.length <= 1 ? (all[0] ?? "") : all;
	}
	return { pathname, query };
}

function payloadBodyAsRaw(payload: HttpRequestPayload): unknown {
	if (typeof payload.bodyBase64 === "string") {
		return Buffer.from(payload.bodyBase64, "base64");
	}
	if (payload.bodyEncoding === "base64" && typeof payload.body === "string") {
		return Buffer.from(payload.body, "base64");
	}
	return payload.body;
}

function _bodyTextForLegacyRoute(payload: HttpRequestPayload): string {
	const raw = payloadBodyAsRaw(payload);
	if (raw == null) return "";
	if (typeof raw === "string") return raw;
	if (Buffer.isBuffer(raw)) return raw.toString("utf8");
	if (raw instanceof Uint8Array) return Buffer.from(raw).toString("utf8");
	try {
		return JSON.stringify(raw);
	} catch {
		return "";
	}
}

function statusTextForCode(status: number): string {
	if (status === 200) return "OK";
	if (status === 201) return "Created";
	if (status === 204) return "No Content";
	if (status === 400) return "Bad Request";
	if (status === 401) return "Unauthorized";
	if (status === 403) return "Forbidden";
	if (status === 404) return "Not Found";
	if (status === 504) return "Gateway Timeout";
	if (status === 500) return "Internal Server Error";
	return "";
}

function bridgeStatus(
	values: Partial<
		Omit<BridgeStatusResult, "engine" | "transport" | "bridgeVersion">
	> = {},
): BridgeStatusResult {
	return {
		ready: values.ready ?? true,
		engine: "bun",
		transport: "bun-host-ipc",
		bridgeVersion: "bun-ios:3",
		...(values.phase ? { phase: values.phase } : {}),
		...(values.error ? { error: values.error } : {}),
	};
}

function timeoutResponse(
	label: string,
	timeoutMs: number,
): {
	status: number;
	statusText: string;
	headers: Record<string, string>;
	body: string;
	bodyBase64: string;
	bodyEncoding: "utf-8";
} {
	const body = JSON.stringify({
		error: `${label} timed out after ${timeoutMs}ms`,
		code: "timeout",
		timeoutMs,
	});
	return {
		status: 504,
		statusText: statusTextForCode(504),
		headers: { "content-type": "application/json; charset=utf-8" },
		body,
		bodyBase64: Buffer.from(body, "utf8").toString("base64"),
		bodyEncoding: "utf-8",
	};
}

function timeoutAfter<T>(
	promise: Promise<T>,
	timeoutMs: number | undefined,
	label: string,
): Promise<T | { __timeout: true; timeoutMs: number; label: string }> {
	if (!timeoutMs || timeoutMs <= 0) return promise;
	const jsTimeoutMs = Math.max(100, timeoutMs - 500);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			resolve({ __timeout: true, timeoutMs: jsTimeoutMs, label });
		}, jsTimeoutMs);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

function bridgeTimeoutMs(value: unknown): number | undefined {
	return typeof value === "number" && value > 0
		? Math.min(value, 30 * 60_000)
		: undefined;
}

function isTimeoutMarker(
	value: unknown,
): value is { __timeout: true; timeoutMs: number; label: string } {
	return Boolean(
		value &&
			typeof value === "object" &&
			"__timeout" in value &&
			(value as { __timeout?: unknown }).__timeout === true,
	);
}

async function fetchBackend(
	backend: IosBridgeBackend,
	payload: HttpRequestPayload,
): Promise<{
	status: number;
	statusText: string;
	headers: Record<string, string>;
	body: string;
	bodyBase64: string;
	bodyEncoding: "utf-8";
}> {
	const rawPath = typeof payload.path === "string" ? payload.path.trim() : "";
	if (!rawPath || !isSafeLocalPath(rawPath)) {
		throw new Error(
			"iOS bridge http_request requires a path that starts with / and is not an absolute URL",
		);
	}

	const method = normalizeMethod(payload.method);
	const headers = normalizeHeaderRecord(payload.headers);
	const timeoutMs = bridgeTimeoutMs(payload.timeoutMs);
	const { pathname, query } = splitPathAndQuery(rawPath);

	const direct = await timeoutAfter(
		handleDirectCoreRoute(backend, method, rawPath, payload),
		timeoutMs,
		`${method} ${pathname}`,
	);
	if (isTimeoutMarker(direct)) {
		return timeoutResponse(direct.label, direct.timeoutMs);
	}
	if (direct) return direct;

	// ── Canonical path: in-process dispatchRoute (no loopback hop) ──────────
	// Treats every authenticated bridge call as authorized — the bridge is the
	// local app talking to its own runtime via a sealed native bridge, no external
	// attacker can inject frames here.
	const result = await timeoutAfter(
		backend.dispatchRoute({
			runtime: backend.runtime,
			method,
			path: pathname,
			headers,
			query,
			body: payloadBodyAsRaw(payload),
			inProcess: true,
			isAuthorized: () => true,
		}),
		timeoutMs,
		`${method} ${pathname}`,
	);

	if (isTimeoutMarker(result)) {
		return timeoutResponse(result.label, result.timeoutMs);
	}

	if (result) {
		const responseHeaders = result.headers ?? {};
		let bodyBytes: Buffer;
		if (result.body == null) {
			bodyBytes = Buffer.alloc(0);
		} else if (typeof result.body === "string") {
			bodyBytes = Buffer.from(result.body, "utf8");
		} else if (Buffer.isBuffer(result.body)) {
			bodyBytes = result.body;
		} else if (result.body instanceof Uint8Array) {
			bodyBytes = Buffer.from(result.body);
		} else {
			bodyBytes = Buffer.from(JSON.stringify(result.body), "utf8");
			if (
				!Object.keys(responseHeaders).some(
					(k) => k.toLowerCase() === "content-type",
				)
			) {
				responseHeaders["content-type"] = "application/json; charset=utf-8";
			}
		}
		return {
			status: result.status,
			statusText: statusTextForCode(result.status),
			headers: responseHeaders,
			body: bodyBytes.toString("utf8"),
			bodyBase64: bodyBytes.toString("base64"),
			bodyEncoding: "utf-8",
		};
	}

	return jsonResponse(404, {
		error: `No iOS local route for ${method} ${pathname}`,
		code: "not_found",
	});
}

const CONVERSATION_STREAM_PATH =
	/^\/api\/conversations\/([^/]+)\/messages\/stream$/;

/**
 * Serve the chat token stream (`POST /api/conversations/:id/messages/stream`)
 * incrementally: the caller pre-allocated `streamId`, listeners are already
 * attached WebView-side, and each token reaches the page as a `stream_emit`
 * host-call while this request is in flight. Resolves once the stream completes.
 *
 * Only the conversation stream endpoint streams; any other `/stream` path is not
 * a token stream and returns `501` so the caller falls back to the buffered
 * request path rather than hanging on events that never arrive.
 */
export async function fetchBackendStream(
	backend: IosBridgeBackend,
	payload: HttpStreamRequestPayload,
	streamId: string,
	emit: StreamEmitter,
): Promise<{ streamId: string; done: true }> {
	const rawPath = typeof payload.path === "string" ? payload.path.trim() : "";
	if (!rawPath || !isSafeLocalPath(rawPath)) {
		throw new Error(
			"iOS bridge http_request_stream requires a path that starts with / and is not an absolute URL",
		);
	}
	const method = normalizeMethod(payload.method);
	const { pathname } = splitPathAndQuery(rawPath);
	const match = CONVERSATION_STREAM_PATH.exec(pathname);

	if (method !== "POST" || !match) {
		await emit({
			streamId,
			kind: "response",
			status: 501,
			statusText: statusTextForCode(501),
			headers: { "content-type": "application/json; charset=utf-8" },
		});
		await emit({
			streamId,
			kind: "chunk",
			dataBase64: Buffer.from(
				JSON.stringify({
					error: `No iOS local stream route for ${method} ${pathname}`,
					code: "streaming_not_supported",
				}),
				"utf8",
			).toString("base64"),
		});
		await emit({ streamId, kind: "complete", error: null });
		return { streamId, done: true };
	}

	const conversationId = decodeURIComponent(match[1] ?? "");
	const body = parseRequestBody(payload);
	await streamConversationMessageResponse(
		backend,
		conversationId,
		body,
		streamId,
		emit,
	);
	return { streamId, done: true };
}

function parseJsonBody(body: string): unknown {
	try {
		return JSON.parse(body);
	} catch {
		return null;
	}
}

function sanitizeLocalInferenceSpeechText(input: string): string {
	let text = input.normalize("NFKC");
	text = text.replace(/<think\b[^>]*>[\s\S]*?(?:<\/think>|$)/gi, " ");
	text = text.replace(
		/<(analysis|reasoning|tool_calls?|tools?)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi,
		" ",
	);
	text = text.replace(/```[\s\S]*?```/g, " ");
	text = text.replace(/`([^`]+)`/g, "$1");
	text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
	text = text.replace(/<[^>\n]+>/g, " ");
	text = text.replace(/\bhttps?:\/\/\S+/gi, " ");
	return text.replace(/\s+/g, " ").trim();
}

function normalizeAudioBytes(value: unknown): Uint8Array {
	if (value instanceof Uint8Array) {
		return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	}
	if (value instanceof ArrayBuffer) {
		return new Uint8Array(value);
	}
	if (ArrayBuffer.isView(value)) {
		return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	}
	throw new Error("TEXT_TO_SPEECH returned a non-binary payload");
}

function sniffAudioContentType(bytes: Uint8Array): string {
	if (
		bytes.length >= 12 &&
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x41 &&
		bytes[10] === 0x56 &&
		bytes[11] === 0x45
	) {
		return "audio/wav";
	}
	if (
		bytes.length >= 3 &&
		bytes[0] === 0x49 &&
		bytes[1] === 0x44 &&
		bytes[2] === 0x33
	) {
		return "audio/mpeg";
	}
	if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
		return "audio/mpeg";
	}
	return "application/octet-stream";
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalPositiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: undefined;
}

function jsonResponse(status: number, body: unknown): BufferedHttpResponse {
	const text = JSON.stringify(body);
	return {
		status,
		statusText: statusTextForCode(status),
		headers: { "content-type": "application/json; charset=utf-8" },
		body: text,
		bodyBase64: Buffer.from(text, "utf8").toString("base64"),
		bodyEncoding: "utf-8",
	};
}

function bytesResponse(
	status: number,
	bytes: Uint8Array,
	headers: Record<string, string>,
): BufferedHttpResponse {
	const body = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return {
		status,
		statusText: statusTextForCode(status),
		headers,
		body: body.toString("utf8"),
		bodyBase64: body.toString("base64"),
		bodyEncoding: "utf-8",
	};
}

// ── Query-param helpers (mirror @elizaos/shared parsePositiveInteger) ─────────

/** First value of a `splitPathAndQuery` param (arrays collapse to their head). */
function queryParam(
	query: Record<string, string | string[]>,
	key: string,
): string | null {
	const raw = query[key];
	if (Array.isArray(raw)) return raw[0] ?? null;
	return typeof raw === "string" ? raw : null;
}

/** Parse a non-negative integer query value, falling back on absent/invalid. */
function parsePositiveInteger(value: string | null, fallback: number): number {
	if (value == null) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

// ── Memory Viewer routes (mirror packages/agent/src/api/memory-routes.ts) ─────
// The iOS runtime never registers the agent's memory-routes (those bind to
// node:http via dispatch-route); mirror the feed/browse/stats handlers directly
// against `backend.runtime` so the Memories view has a backend on device.

const MEMORY_BROWSE_DEFAULT_LIMIT = 50;
const MEMORY_BROWSE_MAX_LIMIT = 200;
const MEMORY_FEED_DEFAULT_LIMIT = 50;
const MEMORY_FEED_MAX_LIMIT = 100;
const MEMORY_TABLE_NAMES = [
	"messages",
	"memories",
	"facts",
	"documents",
] as const;

interface MemoryBrowseItem {
	id: string;
	type: string;
	text: string;
	entityId: string | null;
	roomId: string | null;
	agentId: string | null;
	createdAt: number;
	metadata: Record<string, unknown> | null;
	source: string | null;
}

type TaggedMemory = Memory & { _table: string };

/** Ordering key — `Memory.createdAt` is optional; rows without one sort oldest. */
function memoryCreatedAt(memory: { createdAt?: number }): number {
	return memory.createdAt ?? 0;
}

/** Newest-first comparator shared by the browse/feed list routes. */
function byNewestFirst(
	a: { createdAt?: number },
	b: { createdAt?: number },
): number {
	return memoryCreatedAt(b) - memoryCreatedAt(a);
}

function memoryToBrowseItem(memory: TaggedMemory): MemoryBrowseItem {
	const content = memory.content as Record<string, unknown> | undefined;
	return {
		id: memory.id ?? "",
		type: memory._table,
		text: (content?.text as string) ?? "",
		entityId: memory.entityId,
		roomId: memory.roomId,
		agentId: memory.agentId ?? null,
		createdAt: memoryCreatedAt(memory),
		metadata: (memory.metadata as Record<string, unknown>) ?? null,
		source: (content?.source as string) ?? null,
	};
}

function hasBrowsableContent(memory: TaggedMemory): boolean {
	const text = (memory.content as { text?: string } | undefined)?.text;
	return typeof text === "string" && text.trim().length > 0;
}

function resolveMemoryTableFilter(
	typeParam: string | null,
): readonly string[] | undefined {
	if (!typeParam) return undefined;
	const t = typeParam.toLowerCase();
	if (MEMORY_TABLE_NAMES.includes(t as (typeof MEMORY_TABLE_NAMES)[number])) {
		return [t];
	}
	return undefined;
}

/** Boolean keyword match for filtering (whole query or any term ≥2 chars). */
function matchesMemoryKeyword(text: string, query: string): boolean {
	const normalizedText = text.toLowerCase();
	const normalizedQuery = query.toLowerCase().trim();
	if (!normalizedText || !normalizedQuery) return false;
	if (normalizedText.includes(normalizedQuery)) return true;
	return normalizedQuery
		.split(/\s+/)
		.filter((term) => term.length >= 2)
		.some((term) => normalizedText.includes(term));
}

async function fetchMemoriesFromTables(
	runtime: IAgentRuntime,
	params: {
		entityIds?: UUID[];
		roomId?: UUID;
		tables?: readonly string[];
		limit?: number;
		before?: number;
	},
): Promise<TaggedMemory[]> {
	const tables = params.tables ?? MEMORY_TABLE_NAMES;
	const perTableLimit = Math.max(
		Math.ceil((params.limit ?? MEMORY_BROWSE_DEFAULT_LIMIT) * 2),
		200,
	);
	const perTableMemories = await Promise.all(
		tables.map(async (tableName) => {
			const memories = await runtime.getMemories({
				agentId: runtime.agentId as UUID,
				roomId: params.roomId,
				tableName,
				limit: perTableLimit,
				includeEmbedding: false,
			});
			return memories.map((m) => Object.assign(m, { _table: tableName }));
		}),
	);
	const allMemories: TaggedMemory[] = perTableMemories.flat();

	let filtered = allMemories;
	const entitySet = params.entityIds;
	if (entitySet && entitySet.length > 0) {
		const ids = new Set<string>(entitySet);
		filtered = allMemories.filter((m) => m.entityId && ids.has(m.entityId));
	}

	filtered = filtered.filter(hasBrowsableContent);

	const beforeTs = params.before;
	if (beforeTs) {
		return filtered.filter((m) => memoryCreatedAt(m) < beforeTs);
	}
	return filtered;
}

async function handleMemoriesFeedRoute(
	runtime: IAgentRuntime,
	query: Record<string, string | string[]>,
): Promise<BufferedHttpResponse> {
	const requestedLimit = parsePositiveInteger(
		queryParam(query, "limit"),
		MEMORY_FEED_DEFAULT_LIMIT,
	);
	const limit = Math.min(Math.max(requestedLimit, 1), MEMORY_FEED_MAX_LIMIT);
	const beforeParam = queryParam(query, "before");
	const before = beforeParam ? Number(beforeParam) : undefined;
	const tables = resolveMemoryTableFilter(queryParam(query, "type"));

	const allMemories = await fetchMemoriesFromTables(runtime, {
		tables,
		limit: limit * 2,
		before,
	});

	allMemories.sort(byNewestFirst);
	const items = allMemories.slice(0, limit).map(memoryToBrowseItem);

	return jsonResponse(200, {
		memories: items,
		count: items.length,
		limit,
		hasMore: allMemories.length > limit,
	});
}

async function handleMemoriesBrowseRoute(
	runtime: IAgentRuntime,
	query: Record<string, string | string[]>,
): Promise<BufferedHttpResponse> {
	const requestedLimit = parsePositiveInteger(
		queryParam(query, "limit"),
		MEMORY_BROWSE_DEFAULT_LIMIT,
	);
	const limit = Math.min(Math.max(requestedLimit, 1), MEMORY_BROWSE_MAX_LIMIT);
	const offset = parsePositiveInteger(queryParam(query, "offset"), 0);
	const tables = resolveMemoryTableFilter(queryParam(query, "type"));
	const entityIdParam = queryParam(query, "entityId");
	const entityIdsParam = queryParam(query, "entityIds");
	const roomIdParam = queryParam(query, "roomId");
	const searchQuery = queryParam(query, "q")?.trim() ?? "";

	const entityIds: UUID[] | undefined = entityIdsParam
		? (entityIdsParam
				.split(",")
				.map((id) => id.trim())
				.filter(Boolean) as UUID[])
		: entityIdParam
			? [entityIdParam as UUID]
			: undefined;

	const allMemories = await fetchMemoriesFromTables(runtime, {
		tables,
		entityIds,
		roomId: roomIdParam ? (roomIdParam as UUID) : undefined,
		limit: limit + offset + 100,
	});

	allMemories.sort(byNewestFirst);

	let filtered = allMemories;
	if (searchQuery) {
		filtered = allMemories.filter((m) => {
			const text = (m.content as { text?: string } | undefined)?.text ?? "";
			return matchesMemoryKeyword(text, searchQuery);
		});
	}

	const total = filtered.length;
	const page = filtered.slice(offset, offset + limit).map(memoryToBrowseItem);

	return jsonResponse(200, {
		memories: page,
		total,
		limit,
		offset,
	});
}

async function handleMemoriesStatsRoute(
	runtime: IAgentRuntime,
): Promise<BufferedHttpResponse> {
	const counts: Record<string, number> = {};
	let total = 0;

	for (const tableName of MEMORY_TABLE_NAMES) {
		const memories = await runtime.getMemories({
			agentId: runtime.agentId as UUID,
			tableName,
			limit: 10000,
			includeEmbedding: false,
		});
		counts[tableName] = memories.length;
		total += memories.length;
	}

	return jsonResponse(200, { total, byType: counts });
}

// ── Transcript routes (mirror plugin-local-inference TranscriptStore) ─────────
// plugin-local-inference is deliberately excluded from the mobile plugin set
// (MOBILE_CORE_PLUGINS), so its `/api/transcripts*` rawPath routes never reach
// `runtime.routes`. Mirror the store's memory-partition CRUD here — it uses only
// core runtime memory APIs + @elizaos/shared/transcripts helpers, so nothing
// from the excluded plugin is imported.

const TRANSCRIPTS_TABLE = "transcripts";
const TRANSCRIPT_METADATA_TYPE = "transcript";

interface CreateTranscriptRequestBody {
	worldId?: UUID;
	roomId?: UUID;
	entityId?: UUID;
	title?: string;
	source?: TranscriptSource;
	scope?: TranscriptScope;
	segments?: TranscriptSegment[];
	audioUrl?: string;
	audioContentType?: string;
	createdAt?: number;
}

interface UpdateTranscriptRequestBody {
	title?: string;
	segments?: TranscriptSegment[];
}

/** Parse the stored {@link Transcript} back out of a memory row's content blob. */
function rowToTranscript(row: Memory): Transcript | null {
	const raw = (row.content as { transcript?: unknown }).transcript;
	if (typeof raw !== "string") return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? (parsed as Transcript) : null;
	} catch {
		return null;
	}
}

function transcriptMemoryMetadata(transcript: Transcript): MemoryMetadata {
	return {
		type: "custom",
		source: TRANSCRIPT_METADATA_TYPE,
		timestamp: transcript.createdAt,
		transcriptId: transcript.id,
		durationMs: transcript.durationMs,
		speakerCount: transcript.speakerCount,
		status: transcript.status,
	};
}

function buildTranscriptFromRequest(
	body: CreateTranscriptRequestBody,
	id: string,
	now: number,
): Transcript {
	const segments = Array.isArray(body.segments) ? body.segments : [];
	const createdAt = body.createdAt ?? now;
	return {
		id,
		title:
			body.title?.trim() || `Recording ${new Date(createdAt).toLocaleString()}`,
		createdAt,
		endedAt: now,
		durationMs: transcriptDurationMs(segments),
		audioUrl: body.audioUrl,
		audioContentType: body.audioContentType,
		segments,
		source: body.source ?? "voice-session",
		scope: body.scope ?? "owner-private",
		status: "ready",
		speakerCount: transcriptSpeakerCount(segments),
	};
}

async function listTranscripts(
	runtime: IAgentRuntime,
	roomId?: UUID,
	limit = 100,
): Promise<TranscriptSummary[]> {
	const rows = await runtime.getMemories({
		tableName: TRANSCRIPTS_TABLE,
		roomId,
		count: limit,
		orderBy: "createdAt",
		orderDirection: "desc",
	});
	const summaries: TranscriptSummary[] = [];
	for (const row of rows) {
		const t = rowToTranscript(row);
		if (t) summaries.push(summarizeTranscript(t));
	}
	return summaries;
}

async function getTranscript(
	runtime: IAgentRuntime,
	id: UUID,
): Promise<Transcript | null> {
	const row = await runtime.getMemoryById(id);
	return row ? rowToTranscript(row) : null;
}

async function persistTranscript(
	runtime: IAgentRuntime,
	roomId: UUID,
	entityId: UUID,
	transcript: Transcript,
): Promise<Transcript> {
	const memory: Memory = {
		id: transcript.id as UUID,
		entityId,
		roomId,
		agentId: runtime.agentId as UUID,
		createdAt: transcript.createdAt,
		content: {
			text: transcriptPreview(transcript.segments),
			transcript: JSON.stringify(transcript),
		},
		metadata: transcriptMemoryMetadata(transcript),
	};
	await runtime.createMemory(memory, TRANSCRIPTS_TABLE);
	return transcript;
}

async function handleTranscriptsRoute(
	runtime: IAgentRuntime,
	method: string,
	pathname: string,
	query: Record<string, string | string[]>,
	body: Record<string, unknown>,
): Promise<BufferedHttpResponse | null> {
	if (method === "GET" && pathname === "/api/transcripts") {
		const roomId = queryParam(query, "roomId") ?? undefined;
		const transcripts = await listTranscripts(
			runtime,
			roomId as UUID | undefined,
		);
		return jsonResponse(200, { transcripts });
	}

	if (method === "POST" && pathname === "/api/transcripts") {
		const create = body as CreateTranscriptRequestBody;
		if (!Array.isArray(create.segments) || create.segments.length === 0) {
			return jsonResponse(400, { error: "segments are required" });
		}
		const agentId = runtime.agentId as UUID;
		const transcript = buildTranscriptFromRequest(
			create,
			crypto.randomUUID(),
			Date.now(),
		);
		const saved = await persistTranscript(
			runtime,
			(create.roomId ?? agentId) as UUID,
			(create.entityId ?? agentId) as UUID,
			transcript,
		);
		return jsonResponse(201, { transcript: saved });
	}

	const idMatch = pathname.match(/^\/api\/transcripts\/([^/]+)$/);
	if (!idMatch) return null;
	const id = decodeURIComponent(idMatch[1] ?? "") as UUID;

	if (method === "GET") {
		const transcript = await getTranscript(runtime, id);
		if (!transcript) return jsonResponse(404, { error: "not found" });
		return jsonResponse(200, { transcript });
	}

	if (method === "DELETE") {
		await runtime.deleteMemory(id);
		return jsonResponse(200, { ok: true });
	}

	if (method === "PUT") {
		const patch = body as UpdateTranscriptRequestBody;
		if (patch.title === undefined && patch.segments === undefined) {
			return jsonResponse(400, { error: "title or segments is required" });
		}
		if (patch.segments !== undefined && !Array.isArray(patch.segments)) {
			return jsonResponse(400, { error: "segments must be an array" });
		}
		const existing = await getTranscript(runtime, id);
		if (!existing) return jsonResponse(404, { error: "not found" });

		const segments = patch.segments ?? existing.segments;
		const next: Transcript = {
			...existing,
			title: patch.title?.trim() || existing.title,
			segments,
			durationMs: transcriptDurationMs(segments),
			speakerCount: transcriptSpeakerCount(segments),
			editedAt: Date.now(),
		};
		const ok = await runtime.updateMemory({
			id: next.id as UUID,
			content: {
				text: transcriptPreview(next.segments),
				transcript: JSON.stringify(next),
			},
			metadata: transcriptMemoryMetadata(next),
		});
		if (!ok) return jsonResponse(404, { error: "not found" });
		return jsonResponse(200, { transcript: next });
	}

	return null;
}

// ── Browser workspace routes (mirror the WebView kernel's web workspace) ──────
// On iOS the app itself is the browser: mode is always "web" and each tab is an
// in-app iframe (see BrowserWorkspaceView). Mirror the kernel's in-memory tab
// store so the "Open a website" button, navigation, show/hide, and close all
// work — the same shapes the desktop/server browser-workspace API returns.

const BROWSER_WORKSPACE_DEFAULT_PARTITION = "persist:eliza-browser-user";

interface IosBrowserWorkspaceTab {
	id: string;
	title: string;
	url: string;
	partition: string;
	kind?: "internal" | "standard";
	visible: boolean;
	createdAt: string;
	updatedAt: string;
	lastFocusedAt: string | null;
}

const iosBrowserWorkspaceTabs: IosBrowserWorkspaceTab[] = [];

/** Reset the in-memory browser workspace store (test hook). */
export function resetIosBrowserWorkspace(): void {
	iosBrowserWorkspaceTabs.length = 0;
}

function normalizeBrowserWorkspaceUrl(rawUrl: unknown): string {
	const value = typeof rawUrl === "string" ? rawUrl.trim() : "";
	if (!value) return "about:blank";
	if (value === "about:blank") return value;
	return /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value) ? value : `https://${value}`;
}

function normalizeBrowserWorkspaceKind(
	value: unknown,
): "internal" | "standard" | undefined {
	return value === "internal" || value === "standard" ? value : undefined;
}

function handleBrowserWorkspaceRoute(
	method: string,
	pathname: string,
	body: Record<string, unknown>,
): BufferedHttpResponse | null {
	if (method === "GET" && pathname === "/api/browser-workspace") {
		return jsonResponse(200, { mode: "web", tabs: iosBrowserWorkspaceTabs });
	}

	if (pathname === "/api/browser-workspace/tabs") {
		if (method === "GET") {
			return jsonResponse(200, { tabs: iosBrowserWorkspaceTabs });
		}
		if (method === "POST") {
			const now = new Date().toISOString();
			const show = body.show !== false;
			const tab: IosBrowserWorkspaceTab = {
				id: `btab_${crypto.randomUUID()}`,
				title:
					typeof body.title === "string" && body.title.trim()
						? body.title.trim()
						: "New tab",
				url: normalizeBrowserWorkspaceUrl(body.url),
				partition:
					typeof body.partition === "string" && body.partition.trim()
						? body.partition.trim()
						: BROWSER_WORKSPACE_DEFAULT_PARTITION,
				visible: show,
				createdAt: now,
				updatedAt: now,
				lastFocusedAt: show ? now : null,
			};
			const kind = normalizeBrowserWorkspaceKind(body.kind);
			if (kind) tab.kind = kind;
			if (show) {
				for (const entry of iosBrowserWorkspaceTabs) entry.visible = false;
			}
			iosBrowserWorkspaceTabs.push(tab);
			return jsonResponse(200, { tab });
		}
		return null;
	}

	const match = pathname.match(
		/^\/api\/browser-workspace\/tabs\/([^/]+)(?:\/(navigate|show|hide|snapshot))?$/,
	);
	if (!match) return null;

	const tabId = decodeURIComponent(match[1] ?? "").trim();
	const action = match[2] ?? null;
	const index = iosBrowserWorkspaceTabs.findIndex((tab) => tab.id === tabId);
	if (index < 0) {
		return jsonResponse(404, { error: "Browser tab not found" });
	}

	if (!action && method === "DELETE") {
		iosBrowserWorkspaceTabs.splice(index, 1);
		return jsonResponse(200, { closed: true });
	}

	if (action === "snapshot" && method === "GET") {
		return jsonResponse(200, { data: "" });
	}

	if (action === "show" && method === "POST") {
		const now = new Date().toISOString();
		for (const tab of iosBrowserWorkspaceTabs) {
			if (tab.id === tabId) {
				tab.visible = true;
				tab.updatedAt = now;
				tab.lastFocusedAt = now;
			} else {
				tab.visible = false;
			}
		}
		return jsonResponse(200, { tab: iosBrowserWorkspaceTabs[index] });
	}

	if (action === "hide" && method === "POST") {
		const now = new Date().toISOString();
		const tab = iosBrowserWorkspaceTabs[index];
		tab.visible = false;
		tab.updatedAt = now;
		return jsonResponse(200, { tab });
	}

	if (action === "navigate" && method === "POST") {
		const now = new Date().toISOString();
		const url = normalizeBrowserWorkspaceUrl(body.url);
		const tab = iosBrowserWorkspaceTabs[index];
		tab.url = url;
		tab.title = url === "about:blank" ? "New tab" : tab.title;
		tab.updatedAt = now;
		tab.lastFocusedAt = now;
		tab.visible = true;
		for (const entry of iosBrowserWorkspaceTabs) {
			if (entry.id !== tabId) entry.visible = false;
		}
		return jsonResponse(200, { tab });
	}

	return null;
}

function _buildBufferedRoutePair(args: {
	method: string;
	path: string;
	headers: Record<string, string>;
	bodyText: string;
}): {
	req: IncomingMessage;
	res: ServerResponse;
	captured: {
		statusCode: number;
		headers: Record<string, string>;
		chunks: Buffer[];
		ended: boolean;
	};
} {
	const readable = Readable.from(
		args.bodyText ? [Buffer.from(args.bodyText, "utf8")] : [],
	);
	const req = readable as IncomingMessage & {
		method: string;
		url: string;
		headers: Record<string, string>;
	};
	req.method = args.method;
	req.url = args.path;
	req.headers = args.headers;

	const captured = {
		statusCode: 200,
		headers: {} as Record<string, string>,
		chunks: [] as Buffer[],
		ended: false,
	};
	const writeChunk = (chunk: unknown): void => {
		if (chunk == null) return;
		if (typeof chunk === "string") {
			captured.chunks.push(Buffer.from(chunk, "utf8"));
		} else if (Buffer.isBuffer(chunk)) {
			captured.chunks.push(chunk);
		} else if (chunk instanceof Uint8Array) {
			captured.chunks.push(Buffer.from(chunk));
		} else {
			captured.chunks.push(Buffer.from(String(chunk), "utf8"));
		}
	};
	const res = {
		get statusCode() {
			return captured.statusCode;
		},
		set statusCode(value: number) {
			captured.statusCode = value;
		},
		get headersSent() {
			return captured.ended;
		},
		setHeader(name: string, value: string | number | string[]) {
			captured.headers[name.toLowerCase()] = Array.isArray(value)
				? value.join(", ")
				: String(value);
			return res;
		},
		getHeader(name: string) {
			return captured.headers[name.toLowerCase()];
		},
		writeHead(statusCode: number, headers?: Record<string, unknown>) {
			captured.statusCode = statusCode;
			if (headers) {
				for (const [key, value] of Object.entries(headers)) {
					if (value == null) continue;
					captured.headers[key.toLowerCase()] = Array.isArray(value)
						? value.join(", ")
						: String(value);
				}
			}
			return res;
		},
		write(chunk: unknown) {
			writeChunk(chunk);
			return true;
		},
		end(chunk?: unknown) {
			if (chunk != null) writeChunk(chunk);
			captured.ended = true;
			return res;
		},
	};
	return {
		req,
		res: res as ServerResponse,
		captured,
	};
}

function _bufferedRouteResponse(captured: {
	statusCode: number;
	headers: Record<string, string>;
	chunks: Buffer[];
}): BufferedHttpResponse {
	const bytes = Buffer.concat(captured.chunks);
	return {
		status: captured.statusCode || 200,
		statusText: statusTextForCode(captured.statusCode || 200),
		headers: captured.headers,
		body: bytes.toString("utf8"),
		bodyBase64: bytes.toString("base64"),
		bodyEncoding: "utf-8",
	};
}

function runtimeAgentName(runtime: IAgentRuntime): string {
	const character = (runtime as { character?: { name?: unknown } }).character;
	return typeof character?.name === "string" && character.name.trim()
		? character.name.trim()
		: "Eliza";
}

function parseRequestBody(
	payload: HttpRequestPayload,
): Record<string, unknown> {
	const raw = payloadBodyAsRaw(payload);
	if (!raw) return {};
	if (Buffer.isBuffer(raw)) {
		const parsed = parseJsonBody(raw.toString("utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	}
	if (typeof raw === "string") {
		const parsed = parseJsonBody(raw);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	}
	return typeof raw === "object" && !Array.isArray(raw)
		? (raw as Record<string, unknown>)
		: {};
}

function createIosConversation(
	backend: IosBridgeBackend,
	input: Record<string, unknown> = {},
): IosConversation {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	const metadata =
		input.metadata &&
		typeof input.metadata === "object" &&
		!Array.isArray(input.metadata)
			? (input.metadata as Record<string, unknown>)
			: undefined;
	const conversation: IosConversation = {
		id,
		title:
			typeof input.title === "string" && input.title.trim()
				? input.title.trim()
				: "New Chat",
		roomId: stringToUuid(`ios-conv-${id}`) as UUID,
		createdAt: now,
		updatedAt: now,
		...(metadata ? { metadata } : {}),
	};
	backend.conversations.set(id, conversation);
	return conversation;
}

function installHostCallProtocol(
	write: (frame: BridgeOutboundFrame) => void,
): void {
	hostProtocolWrite = write;
}

function tryHandleHostResultLine(line: string): boolean {
	if (!line.includes('"host_result"')) return false;
	let parsed: HostResultFrame;
	try {
		parsed = JSON.parse(line) as HostResultFrame;
	} catch {
		return false;
	}
	if (parsed.type !== "host_result" || typeof parsed.id !== "string") {
		return false;
	}
	const pending = pendingHostCalls.get(parsed.id);
	if (!pending) return true;
	pendingHostCalls.delete(parsed.id);
	clearTimeout(pending.timeout);
	const envelope =
		parsed.envelope && typeof parsed.envelope === "object"
			? (parsed.envelope as Record<string, unknown>)
			: { ok: parsed.ok, result: parsed.result, error: parsed.error };
	if (envelope.ok === false) {
		pending.reject(
			new Error(
				typeof envelope.error === "string"
					? envelope.error
					: "Native host call failed",
			),
		);
		return true;
	}
	pending.resolve(envelope.result);
	return true;
}

function callIosHost(
	method: string,
	payload: unknown,
	timeoutMs = 120_000,
): Promise<unknown> {
	const writeHostMessage = hostProtocolWrite;
	if (!writeHostMessage) {
		return Promise.reject(
			new Error("iOS native host-call protocol is not installed"),
		);
	}
	const id = `host-${nextHostCallId++}`;
	const boundedTimeout = Math.max(1_000, Math.min(timeoutMs, 30 * 60_000));
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			pendingHostCalls.delete(id);
			reject(
				new Error(
					`Native iOS host call ${method} timed out after ${boundedTimeout}ms`,
				),
			);
		}, boundedTimeout);
		pendingHostCalls.set(id, { resolve, reject, timeout });
		writeHostMessage({
			type: "host_call",
			id,
			method,
			payload,
			timeoutMs: boundedTimeout,
		});
	});
}

function resolveMobileStateDir(): string {
	const explicit =
		process.env.ELIZA_STATE_DIR ||
		process.env.ELIZA_STATE_DIR ||
		process.env.ELIZA_HOME;
	if (explicit?.trim()) return explicit.trim();
	if (process.env.HOME?.trim()) {
		return path.join(process.env.HOME.trim(), ".eliza");
	}
	return "/tmp/eliza";
}

function localInferenceRootPath(): string {
	return path.join(resolveMobileStateDir(), "local-inference");
}

function localInferenceRegistryPath(): string {
	return path.join(localInferenceRootPath(), "registry.json");
}

function localInferenceAssignmentsPath(): string {
	return path.join(localInferenceRootPath(), "assignments.json");
}

function localInferenceRoutingPath(): string {
	return path.join(localInferenceRootPath(), "routing.json");
}

function localInferenceModelsPath(): string {
	return path.join(localInferenceRootPath(), "models");
}

function bundledLocalInferenceModelsPath(): string | null {
	const assetDir = process.env.ELIZA_IOS_AGENT_ASSET_DIR?.trim();
	if (!assetDir) return null;
	return path.join(assetDir, "models");
}

function localInferenceDownloadsPath(): string {
	return path.join(localInferenceRootPath(), "downloads");
}

function readJsonObjectFile(filePath: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function writeJsonObjectFile(
	filePath: string,
	value: Record<string, unknown>,
): void {
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function iosNativeCatalogById(modelId: string): NativeCatalogModelEntry | null {
	return (
		IOS_NATIVE_CATALOG_MODELS.find((entry) => entry.id === modelId) ?? null
	);
}

function iosNativeCatalogByFile(
	filePath: string,
): NativeCatalogModelEntry | null {
	const normalized = filePath.replaceAll("\\", "/").toLowerCase();
	return (
		IOS_NATIVE_CATALOG_MODELS.find((entry) => {
			const target = entry.ggufFile.toLowerCase();
			return (
				normalized.endsWith(`/${target}`) ||
				path.basename(normalized) === path.basename(target)
			);
		}) ?? null
	);
}

function nativeCatalogModelPayload(
	model: NativeCatalogModelEntry,
): Record<string, unknown> {
	return {
		id: model.id,
		displayName: model.displayName,
		hfRepo: model.hfRepo,
		ggufFile: model.ggufFile,
		params: model.params,
		quant: "Q8_0",
		sizeGb: model.sizeGb,
		minRamGb: model.minRamGb,
		category: "chat",
		bucket: model.bucket,
		blurb: "Eliza-1 on-device GGUF bundle for iPhone local inference.",
		contextLength: model.contextLength,
		gpuLayers: "auto",
		publishStatus: "published",
		sourceModel: {
			finetuned: false,
			components: {
				text: { repo: model.hfRepo, file: model.hfPath },
			},
		},
	};
}

function modelDownloadUrl(model: NativeCatalogModelEntry): string {
	const encodedPath = model.hfPath
		.split("/")
		.map((part) => encodeURIComponent(part))
		.join("/");
	return `https://huggingface.co/${model.hfRepo}/resolve/main/${encodedPath}`;
}

function nativeModelTargetPath(model: NativeCatalogModelEntry): string {
	return path.join(localInferenceModelsPath(), model.ggufFile);
}

function installedModelForCatalogEntry(
	model: NativeCatalogModelEntry,
	filePath: string,
	sizeBytes: number,
	installedAt: string,
	source: string,
): InstalledModelEntry {
	return {
		id: model.id,
		displayName: model.displayName,
		path: filePath,
		sizeBytes,
		installedAt,
		lastUsedAt: null,
		source,
		hfRepo: model.hfRepo,
		bundleVerifiedAt: installedAt,
	};
}

function toStoredInstalledModelPath(modelPath: string): string | null {
	return toStoredModelPath(modelPath, localInferenceRootPath());
}

function serializeInstalledModelEntry(
	model: InstalledModelEntry,
): InstalledModelEntry | null {
	const storedPath = toStoredInstalledModelPath(model.path);
	return storedPath ? { ...model, path: storedPath } : null;
}

function upsertInstalledModel(model: InstalledModelEntry): void {
	const storedModel = serializeInstalledModelEntry(model);
	if (!storedModel) {
		throw new Error(
			`iOS local-inference model path must live under ${localInferenceRootPath()}: ${model.path}`,
		);
	}
	const existing = readInstalledModels().filter(
		(entry) =>
			entry.id !== model.id &&
			entry.path !== model.path &&
			serializeInstalledModelEntry(entry),
	);
	writeJsonObjectFile(localInferenceRegistryPath(), {
		version: 1,
		models: [...existing, model]
			.map(serializeInstalledModelEntry)
			.filter((entry): entry is InstalledModelEntry => Boolean(entry)),
		updatedAt: new Date().toISOString(),
	});
}

function positiveInteger(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return Math.floor(value);
	}
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
	}
	return null;
}

function readAssignments(): Record<string, string> {
	const parsed = readJsonObjectFile(localInferenceAssignmentsPath());
	const raw = parsed.assignments;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const out: Record<string, string> = {};
	for (const [slot, modelId] of Object.entries(raw)) {
		if (typeof modelId === "string" && modelId.trim()) {
			out[slot] = modelId.trim();
		}
	}
	return out;
}

function writeAssignments(assignments: Record<string, string>): void {
	writeJsonObjectFile(localInferenceAssignmentsPath(), {
		version: 1,
		assignments,
		updatedAt: new Date().toISOString(),
	});
}

function scanGgufFiles(root: string): InstalledModelEntry[] {
	const models: InstalledModelEntry[] = [];
	const visit = (dir: string, depth: number): void => {
		if (depth > 5 || models.length >= 200) return;
		let entries: string[] = [];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const entry of entries) {
			const fullPath = path.join(dir, entry);
			let stats: ReturnType<typeof statSync>;
			try {
				stats = statSync(fullPath);
			} catch {
				continue;
			}
			if (stats.isDirectory()) {
				visit(fullPath, depth + 1);
			} else if (stats.isFile() && entry.toLowerCase().endsWith(".gguf")) {
				const catalogModel = iosNativeCatalogByFile(fullPath);
				if (catalogModel) {
					models.push(
						installedModelForCatalogEntry(
							catalogModel,
							fullPath,
							stats.size,
							new Date(stats.mtimeMs).toISOString(),
							"ios-bundled",
						),
					);
				} else {
					const id = path.basename(entry, path.extname(entry));
					models.push({
						id,
						displayName: id,
						path: fullPath,
						sizeBytes: stats.size,
						installedAt: new Date(stats.mtimeMs).toISOString(),
						lastUsedAt: null,
						source: "external-scan",
					});
				}
			}
		}
	};
	visit(root, 0);
	return models;
}

function normalizeInstalledModelPath(rawPath: string): string | null {
	// Probe through the sandboxed fs proxy, not raw node:fs.
	return resolveStoredModelPath(rawPath, localInferenceRootPath(), (p) =>
		existsSync(p),
	);
}

function readInstalledModels(): InstalledModelEntry[] {
	const parsed = readJsonObjectFile(localInferenceRegistryPath());
	const rawModels = Array.isArray(parsed.models) ? parsed.models : [];
	const fromRegistry = rawModels
		.map((entry): InstalledModelEntry | null => {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
				return null;
			}
			const record = entry as Record<string, unknown>;
			if (typeof record.id !== "string" || typeof record.path !== "string") {
				return null;
			}
			const modelPath = normalizeInstalledModelPath(record.path);
			if (!modelPath) return null;
			return {
				id: record.id,
				displayName:
					typeof record.displayName === "string"
						? record.displayName
						: record.id,
				path: modelPath,
				sizeBytes: positiveInteger(record.sizeBytes) ?? 0,
				installedAt:
					typeof record.installedAt === "string"
						? record.installedAt
						: new Date().toISOString(),
				lastUsedAt:
					typeof record.lastUsedAt === "string" ? record.lastUsedAt : null,
				source: typeof record.source === "string" ? record.source : undefined,
				hfRepo: typeof record.hfRepo === "string" ? record.hfRepo : undefined,
				bundleVerifiedAt:
					typeof record.bundleVerifiedAt === "string"
						? record.bundleVerifiedAt
						: undefined,
				dimensions: positiveInteger(record.dimensions) ?? undefined,
				embeddingDimension:
					positiveInteger(record.embeddingDimension) ?? undefined,
				embeddingDimensions:
					positiveInteger(record.embeddingDimensions) ?? undefined,
			};
		})
		.filter((entry): entry is InstalledModelEntry => Boolean(entry));
	const bundledModelsPath = bundledLocalInferenceModelsPath();
	const scanned = [
		...(bundledModelsPath ? scanGgufFiles(bundledModelsPath) : []),
		...scanGgufFiles(localInferenceModelsPath()),
	];
	const byId = new Map<string, InstalledModelEntry>();
	for (const model of [...scanned, ...fromRegistry]) {
		byId.set(model.id, model);
	}
	return [...byId.values()];
}

function isEmbeddingModel(model: InstalledModelEntry): boolean {
	const lowered = model.id.toLowerCase();
	return (
		lowered.includes("embed") ||
		lowered.includes("bge-") ||
		lowered.includes("nomic") ||
		lowered.includes("gte-") ||
		lowered.includes("e5-")
	);
}

function resolveAssignedModel(slot: string): InstalledModelEntry | null {
	const installed = readInstalledModels().filter(
		(model) => !isEmbeddingModel(model),
	);
	const assignments = readAssignments();
	const assigned = assignments[slot];
	if (assigned) {
		const model = installed.find((entry) => entry.id === assigned);
		if (model) return model;
	}
	if (nativeLlamaState.modelPath) {
		const current = installed.find(
			(entry) => entry.path === nativeLlamaState.modelPath,
		);
		if (current) return current;
	}
	return (
		installed.sort((left, right) => {
			const leftUsed = left.lastUsedAt ? Date.parse(left.lastUsedAt) : 0;
			const rightUsed = right.lastUsedAt ? Date.parse(right.lastUsedAt) : 0;
			if (rightUsed !== leftUsed) return rightUsed - leftUsed;
			return (right.sizeBytes ?? 0) - (left.sizeBytes ?? 0);
		})[0] ?? null
	);
}

function nativeLlamaContextSize(): number {
	return (
		positiveInteger(process.env.ELIZA_IOS_LLAMA_CONTEXT_SIZE) ??
		positiveInteger(process.env.ELIZA_IOS_LLAMA_CONTEXT_SIZE) ??
		positiveInteger(process.env.ELIZA_LOCAL_CONTEXT_SIZE) ??
		4096
	);
}

function isMetalLoadError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return (
		/metal/i.test(message) ||
		/MTLLibraryErrorDomain/.test(message) ||
		/ggml_metal/i.test(message)
	);
}

async function shouldUseNativeLlamaGpu(): Promise<boolean> {
	const explicit = process.env.ELIZA_IOS_LLAMA_USE_GPU;
	if (explicit === "1" || explicit?.toLowerCase() === "true") return true;
	if (explicit === "0" || explicit?.toLowerCase() === "false") return false;

	const hardware = await nativeHardwareInfo();
	return hardware.metal_supported === true && hardware.is_simulator !== true;
}

const NATIVE_LOAD_OVERHEAD_BYTES = 768 * 1024 * 1024;

/**
 * #11612: loading a model that exceeds the device's remaining memory gets the
 * whole app jetsam-killed (crash-loop) instead of failing. The native bridge
 * enforces the authoritative per-process jetsam budget at load time
 * (`LlamaBridgeImpl.loadModel`); this pre-flight check fails fast with a clean
 * error before a multi-minute native load is even attempted.
 */
async function assertModelFitsDeviceMemory(
	model: InstalledModelEntry,
): Promise<void> {
	if (!model.sizeBytes || model.sizeBytes <= 0) return;
	const hardware = await nativeHardwareInfo();
	if (hardware.is_simulator === true) return;
	const availableBytes = Number(hardware.available_ram_gb ?? 0) * 1024 ** 3;
	if (!Number.isFinite(availableBytes) || availableBytes <= 0) return;
	const requiredBytes = model.sizeBytes + NATIVE_LOAD_OVERHEAD_BYTES;
	if (requiredBytes > availableBytes) {
		const requiredMb = Math.round(requiredBytes / (1024 * 1024));
		const availableMb = Math.round(availableBytes / (1024 * 1024));
		throw new Error(
			`[ios-native-llama] insufficient memory to load ${model.id}: needs ~${requiredMb} MB but only ~${availableMb} MB is available. Close other apps or install a smaller model.`,
		);
	}
}

async function loadNativeLlamaModel(
	model: InstalledModelEntry,
	useGpu: boolean,
): Promise<Record<string, unknown>> {
	const result = await callIosHost(
		"llama_load_model",
		{
			path: model.path,
			modelId: model.id,
			context_size: nativeLlamaContextSize(),
			use_gpu: useGpu,
		},
		10 * 60_000,
	);
	return result && typeof result === "object" && !Array.isArray(result)
		? (result as Record<string, unknown>)
		: {};
}

async function ensureNativeModelLoaded(
	slot: string,
): Promise<NativeLlamaState> {
	const model = resolveAssignedModel(slot);
	if (!model) {
		throw new Error(
			`[ios-native-llama] No local GGUF model is installed under ${path.join(
				localInferenceRootPath(),
				"models",
			)}. Download or install a model before using local generation.`,
		);
	}
	if (
		nativeLlamaState.contextId != null &&
		nativeLlamaState.modelPath === model.path &&
		nativeLlamaState.status === "ready"
	) {
		return nativeLlamaState;
	}

	await unloadNativeLlamaModel();
	nativeLlamaState.status = "loading";
	nativeLlamaState.modelId = model.id;
	nativeLlamaState.modelPath = model.path;
	nativeLlamaState.loadedAt = null;
	delete nativeLlamaState.error;
	try {
		await assertModelFitsDeviceMemory(model);
		let requestedGpu = await shouldUseNativeLlamaGpu();
		let record: Record<string, unknown>;
		try {
			record = await loadNativeLlamaModel(model, requestedGpu);
		} catch (error) {
			if (!requestedGpu || !isMetalLoadError(error)) throw error;
			requestedGpu = false;
			record = await loadNativeLlamaModel(model, false);
		}
		const contextId =
			positiveInteger(record.context_id) ?? positiveInteger(record.contextId);
		if (contextId == null) {
			throw new Error("Native llama load returned no context_id");
		}
		nativeLlamaState.contextId = contextId;
		nativeLlamaState.loadedAt = new Date().toISOString();
		nativeLlamaState.status = "ready";
		return nativeLlamaState;
	} catch (error) {
		nativeLlamaState.contextId = null;
		nativeLlamaState.loadedAt = null;
		nativeLlamaState.status = "error";
		nativeLlamaState.error =
			error instanceof Error ? error.message : String(error);
		throw error;
	}
}

async function unloadNativeLlamaModel(): Promise<void> {
	const contextId = nativeLlamaState.contextId;
	nativeLlamaState.contextId = null;
	nativeLlamaState.loadedAt = null;
	nativeLlamaState.status = "idle";
	if (contextId != null) {
		await callIosHost("llama_free", { context_id: contextId }, 30_000).catch(
			() => undefined,
		);
	}
	nativeLlamaState.modelId = null;
	nativeLlamaState.modelPath = null;
	delete nativeLlamaState.error;
}

function flattenChatParamsForPrompt(params: GenerateTextParams): string {
	if (typeof params.prompt === "string" && params.prompt.length > 0) {
		const trimmedPrompt = params.prompt.trimEnd();
		if (
			trimmedPrompt.includes("<start_of_turn>") &&
			trimmedPrompt.includes("<start_of_turn>model")
		) {
			return trimmedPrompt;
		}
		const legacyMessages = trimmedPrompt.includes("<|im_start|>")
			? collectChatMlPromptMessages(trimmedPrompt, IOS_NATIVE_NO_THINK_SYSTEM)
			: null;
		if (legacyMessages && legacyMessages.length > 0) {
			return renderGemmaPrompt(legacyMessages);
		}
		return renderGemmaPrompt([
			{ role: "system", content: IOS_NATIVE_NO_THINK_SYSTEM },
			{ role: "user", content: trimmedPrompt },
		]);
	}
	const systemBlocks = [IOS_NATIVE_NO_THINK_SYSTEM];
	if (typeof params.system === "string" && params.system) {
		systemBlocks.push(params.system);
	}
	const chatMessages: Array<{ role: string; content: string }> = [];
	const messages = params.messages ?? [];
	for (const message of messages) {
		const role =
			message.role === "system" ||
			message.role === "assistant" ||
			message.role === "tool"
				? message.role
				: "user";
		if (typeof message.content === "string") {
			if (message.content) {
				if (role === "system") systemBlocks.push(message.content);
				else chatMessages.push({ role, content: message.content });
			}
			continue;
		}
		if (Array.isArray(message.content)) {
			const text = message.content
				.map((part) =>
					part && typeof part === "object" && "text" in part
						? String((part as { text?: unknown }).text ?? "")
						: "",
				)
				.filter(Boolean)
				.join("\n");
			if (text) {
				if (role === "system") systemBlocks.push(text);
				else chatMessages.push({ role, content: text });
			}
		}
	}
	return renderGemmaPrompt([
		{ role: "system", content: systemBlocks.join("\n\n") },
		...chatMessages,
	]);
}

function roleForGemmaPrompt(role: string): "system" | "user" | "model" {
	if (role === "assistant" || role === "tool") return "model";
	if (role === "system") return "system";
	return "user";
}

function collectChatMlPromptMessages(
	prompt: string,
	system?: string,
): Array<{ role: string; content: string }> | null {
	const headerPattern = /<\|im_start\|>(system|user|assistant|tool)(?:\n|$)/g;
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
	const messages: Array<{ role: string; content: string }> = [];
	if (system?.trim() && headers[0]?.role !== "system") {
		messages.push({ role: "system", content: system.trim() });
	}
	for (let i = 0; i < headers.length; i += 1) {
		const current = headers[i];
		const next = headers[i + 1];
		const content = prompt
			.slice(current.bodyStart, next ? next.index : prompt.length)
			.replace(/<\|im_end\|>\s*$/g, "")
			.trim();
		if (content) messages.push({ role: current.role, content });
	}
	return messages.length > 0 ? messages : null;
}

function renderGemmaPrompt(
	messages: Array<{ role: string; content: string }>,
): string {
	const blocks: string[] = [];
	for (const message of messages) {
		const content = message.content.trim();
		if (content) {
			blocks.push(
				`<start_of_turn>${roleForGemmaPrompt(message.role)}\n${content}<end_of_turn>`,
			);
		}
	}
	blocks.push("<start_of_turn>model\n");
	return blocks.join("\n");
}

function stripReasoningBlocks(raw: string): string {
	return raw
		.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "")
		.replace(/^[\s\S]*?<\/think>/i, "")
		.replace(/<think\b[^>]*>[\s\S]*$/gi, "")
		.replace(/\/?\bno_think\b/gi, "")
		.trim();
}

function cleanIosNativeConversationReply(raw: string): string {
	const withoutTokens = stripReasoningBlocks(raw)
		.split("<end_of_turn>")[0]
		.split("<start_of_turn>")[0]
		.split("<|im_end|>")[0]
		.split("<|im_start|>")[0]
		.replace(/^\s*model\s*:\s*/i, "")
		.replace(/^\s*(assistant|eliza)\s*:\s*/i, "")
		.trim();
	const compact = withoutTokens.replace(/\s+/g, " ").trim();
	if (!compact) return "";
	const firstSentence = compact.match(/^(.{12,280}?[.!?])(?:\s|$)/u)?.[1];
	return (firstSentence ?? compact).trim();
}

async function maybeGenerateIosNativeConversationReply(
	runtime: IAgentRuntime,
	prompt: string,
	onToken?: StreamChunkCallback,
): Promise<Record<string, unknown> | null> {
	const installed = readInstalledModels().filter(
		(model) => !isEmbeddingModel(model),
	);
	if (installed.length === 0) return null;
	const startedAt = Date.now();
	const raw = await runtime.useModel(
		ModelType.TEXT_SMALL,
		{
			messages: [
				{
					role: "system",
					content:
						"Eliza-1 is running locally on this iPhone. Reply with one natural sentence under 10 words.",
				},
				{ role: "user", content: prompt },
			],
			maxTokens: 32,
			temperature: 0,
			stopSequences: ["<end_of_turn>", "<start_of_turn>"],
			// When the caller is streaming, forward incremental model tokens so the
			// hot chat stream renders progressively instead of one buffered frame.
			...(onToken ? { onStreamChunk: onToken } : {}),
		},
		IOS_NATIVE_LLAMA_PROVIDER,
	);
	const text = cleanIosNativeConversationReply(raw);
	if (!text) {
		throw new Error("Native llama returned an empty response");
	}
	return {
		text,
		reply: text,
		localInference: {
			provider: IOS_NATIVE_LLAMA_PROVIDER,
			modelId: nativeLlamaState.modelId ?? installed[0]?.id ?? null,
			mode: "ios_native_conversation",
			latencyMs: Date.now() - startedAt,
		},
	};
}

function isStructuredGenerationSlot(slot: string): boolean {
	return (
		slot === ModelType.RESPONSE_HANDLER ||
		slot === ModelType.ACTION_PLANNER ||
		slot === ModelType.TEXT_COMPLETION
	);
}

function mergeStopSequences(values: unknown): string[] {
	const requested = Array.isArray(values)
		? values.filter((value): value is string => typeof value === "string")
		: [];
	return Array.from(
		new Set([...requested, "<end_of_turn>", "<start_of_turn>", "<endoftext>"]),
	);
}

function makeIosNativeGenerateHandler(slot: string): GenerateTextHandler {
	return async (_runtime, params) => {
		const state = await ensureNativeModelLoaded(slot);
		if (state.contextId == null) {
			throw new Error(
				"[ios-native-llama] model load did not produce a context",
			);
		}
		const prompt = flattenChatParamsForPrompt(params);
		const structuredSlot = isStructuredGenerationSlot(slot);
		const requestedMaxTokens = positiveInteger(params.maxTokens) ?? 256;
		const maxTokens = Math.min(requestedMaxTokens, structuredSlot ? 256 : 128);
		const result = await callIosHost(
			"llama_generate",
			{
				context_id: state.contextId,
				prompt,
				max_tokens: maxTokens,
				temperature:
					typeof params.temperature === "number"
						? params.temperature
						: structuredSlot
							? 0.2
							: 0.4,
				top_p: typeof params.topP === "number" ? params.topP : 0.95,
				top_k: positiveInteger(params.topK) ?? 40,
				stop: mergeStopSequences(params.stopSequences),
			},
			Math.max(120_000, maxTokens * 2_000),
		);
		const record =
			result && typeof result === "object" && !Array.isArray(result)
				? (result as Record<string, unknown>)
				: {};
		const text =
			typeof record.text === "string" ? record.text : String(result ?? "");
		const cleanedText = stripReasoningBlocks(text);
		if (params.onStreamChunk && cleanedText) {
			await params.onStreamChunk(cleanedText, crypto.randomUUID(), cleanedText);
		}
		return cleanedText;
	};
}

/**
 * Expose `__ELIZA_BRIDGE__.keep_awake_set` on the full-Bun engine's Bun global
 * so the in-process model downloader can hold the iOS idle timer open for the
 * duration of a multi-GB transfer (#11841). The native handler (`keep_awake_set`
 * in FullBunEngineHost) reference-counts the hold and toggles
 * `UIApplication.shared.isIdleTimerDisabled`. Fire-and-forget: the downloader
 * calls this synchronously and ignores the result, so a host-call failure can
 * never affect the download. Only defines the function when the engine has not
 * already installed one.
 */
function installKeepAwakeBridge(): void {
	const g = globalThis as typeof globalThis & {
		__ELIZA_BRIDGE__?: Record<string, unknown>;
	};
	g.__ELIZA_BRIDGE__ = g.__ELIZA_BRIDGE__ ?? {};
	if (typeof g.__ELIZA_BRIDGE__.keep_awake_set === "function") return;
	g.__ELIZA_BRIDGE__.keep_awake_set = (enabled: unknown): boolean => {
		void callIosHost("keep_awake_set", { enabled: Boolean(enabled) }).catch(
			() => undefined,
		);
		return true;
	};
}

/**
 * Expose the native background-download host functions on the full-Bun engine's
 * Bun global so the in-process model downloader can route the ~5 GB weight pull
 * through a native background `URLSession` that survives the app backgrounding
 * or the device locking (#11841). The native handlers (`bg_download_*` in
 * `FullBunEngineHost` → `BackgroundDownloadBridge`) start the task and report
 * progress/terminal state; the downloader starts a job then polls status until
 * it is terminal. Each function resolves the native host envelope's `result`
 * object; a rejection means the host call itself failed. Only defines the
 * functions when the engine has not already installed them.
 */
function installBackgroundDownloadBridge(): void {
	const g = globalThis as typeof globalThis & {
		__ELIZA_BRIDGE__?: Record<string, unknown>;
	};
	g.__ELIZA_BRIDGE__ = g.__ELIZA_BRIDGE__ ?? {};
	if (typeof g.__ELIZA_BRIDGE__.bg_download_start === "function") return;
	g.__ELIZA_BRIDGE__.bg_download_start = (args: unknown): Promise<unknown> =>
		callIosHost("bg_download_start", args, 60_000);
	g.__ELIZA_BRIDGE__.bg_download_status = (args: unknown): Promise<unknown> =>
		callIosHost("bg_download_status", args, 60_000);
	g.__ELIZA_BRIDGE__.bg_download_cancel = (args: unknown): Promise<unknown> =>
		callIosHost("bg_download_cancel", args, 60_000);
}

function installIosNativeLlamaHandlers(runtime: IAgentRuntime): void {
	const flagged = runtime as IAgentRuntime & {
		__iosNativeLlamaHandlersInstalled?: boolean;
	};
	if (flagged.__iosNativeLlamaHandlersInstalled) return;
	const runtimeWithRegistration = runtime as RuntimeWithModelRegistration;
	if (typeof runtimeWithRegistration.registerModel !== "function") return;
	for (const modelType of TEXT_GENERATION_MODEL_TYPES) {
		runtimeWithRegistration.registerModel(
			modelType,
			makeIosNativeGenerateHandler(modelType),
			IOS_NATIVE_LLAMA_PROVIDER,
			IOS_NATIVE_LLAMA_PRIORITY,
		);
	}
	flagged.__iosNativeLlamaHandlersInstalled = true;
}

async function nativeHardwareInfo(): Promise<Record<string, unknown>> {
	try {
		const result = await callIosHost("llama_hardware_info", {}, 10_000);
		return result && typeof result === "object" && !Array.isArray(result)
			? (result as Record<string, unknown>)
			: {};
	} catch (error) {
		return {
			backend: "unknown",
			total_ram_gb: 0,
			available_ram_gb: 0,
			cpu_cores: 0,
			is_simulator: process.env.SIMULATOR_DEVICE_NAME ? true : undefined,
			metal_supported: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function nativeLlamaDeviceStatus(): Promise<Record<string, unknown>> {
	const hardware = await nativeHardwareInfo();
	const totalRamGb = Number(hardware.total_ram_gb ?? 0);
	const cpuCores = Number(hardware.cpu_cores ?? 0);
	const metalSupported = hardware.metal_supported === true;
	return {
		enabled: true,
		connected: true,
		transport: "bun-host-ipc",
		devices: [
			{
				deviceId: IOS_NATIVE_LLAMA_DEVICE_ID,
				capabilities: {
					platform: "ios",
					deviceModel:
						hardware.is_simulator === true ? "iOS Simulator" : "iOS Device",
					totalRamGb,
					cpuCores,
					gpu: {
						backend: "metal",
						available: metalSupported,
					},
				},
				loadedPath: nativeLlamaState.modelPath,
				connectedSince: nativeLlamaState.loadedAt ?? new Date().toISOString(),
			},
		],
		primaryDeviceId: IOS_NATIVE_LLAMA_DEVICE_ID,
		pendingRequests: pendingHostCalls.size,
		modelPath: nativeLlamaState.modelPath,
	};
}

function nativeLlamaActiveSnapshot(): Record<string, unknown> {
	return {
		modelId: nativeLlamaState.modelId,
		modelPath: nativeLlamaState.modelPath,
		loadedAt: nativeLlamaState.loadedAt,
		status: nativeLlamaState.status,
		provider: IOS_NATIVE_LLAMA_PROVIDER,
		transport: "bun-host-ipc",
		...(nativeLlamaState.error ? { error: nativeLlamaState.error } : {}),
	};
}

async function nativeLocalInferenceProviders(): Promise<
	Record<string, unknown>
> {
	const installed = readInstalledModels();
	return {
		providers: [
			{
				id: IOS_NATIVE_LLAMA_PROVIDER,
				label: "Eliza-1 on-device runtime (iOS)",
				kind: "local",
				description:
					"Runs Eliza-1 natively through the full Bun host IPC bridge.",
				supportedSlots: ["TEXT_SMALL", "TEXT_LARGE"],
				configureHref: null,
				enableState: {
					enabled: true,
					reason: "Native iOS llama bridge connected",
				},
				registeredSlots: ["TEXT_SMALL", "TEXT_LARGE"],
				transport: "bun-host-ipc",
			},
			{
				id: "eliza-local-inference",
				label: "Eliza-1 local inference",
				kind: "local",
				description: "Eliza-1 bundles installed in this agent state directory.",
				supportedSlots: ["TEXT_SMALL", "TEXT_LARGE", "TEXT_EMBEDDING"],
				configureHref: "#local-inference-panel",
				enableState: {
					enabled: installed.length > 0,
					reason:
						installed.length > 0
							? "Eliza-1 bundle installed"
							: "No Eliza-1 bundle installed",
				},
				registeredSlots:
					installed.length > 0 ? ["TEXT_SMALL", "TEXT_LARGE"] : [],
			},
		],
	};
}

function nativeCatalogModels(): Array<Record<string, unknown>> {
	const curated = IOS_NATIVE_CATALOG_MODELS.map(nativeCatalogModelPayload);
	const curatedIds = new Set(
		IOS_NATIVE_CATALOG_MODELS.map((model) => model.id),
	);
	const installedCustom = readInstalledModels()
		.filter((model) => !isEmbeddingModel(model) && !curatedIds.has(model.id))
		.map((model) => {
			const sizeGb = Math.max(0.1, (model.sizeBytes ?? 0) / 1024 ** 3);
			return {
				id: model.id,
				displayName: model.displayName ?? model.id,
				hfRepo: model.hfRepo ?? "elizaos/eliza-1",
				ggufFile: path.basename(model.path),
				params: "2B",
				quant: "Q8_0",
				sizeGb,
				minRamGb: 4,
				category: "chat",
				bucket: sizeGb <= 1 ? "small" : "mid",
				blurb: "Installed Eliza-1 on-device GGUF bundle.",
				contextLength: 128_000,
				gpuLayers: "auto",
				publishStatus: "published",
			};
		});
	return [...curated, ...installedCustom];
}

function nativeDownloadJobs(): NativeDownloadJob[] {
	const jobs = Array.from(nativeDownloadState.values());
	const trackedModelIds = new Set(jobs.map((job) => job.modelId));
	for (const model of readInstalledModels().filter(
		(entry) => !isEmbeddingModel(entry),
	)) {
		if (trackedModelIds.has(model.id)) continue;
		jobs.push(nativeDownloadJobForInstalledModel(model));
	}
	return jobs;
}

function nativeDownloadStatus(
	model: InstalledModelEntry | null,
): Record<string, unknown> {
	const bytes = model?.sizeBytes ?? 0;
	return {
		state: model ? "completed" : "missing",
		receivedBytes: bytes,
		totalBytes: bytes,
		percent: model ? 100 : null,
		bytesPerSec: 0,
		etaMs: model ? 0 : null,
		updatedAt: model?.lastUsedAt ?? model?.installedAt ?? null,
		errors: [],
	};
}

function nativeDownloadJobForInstalledModel(
	model: InstalledModelEntry,
): NativeDownloadJob {
	const installedAt = model.installedAt ?? new Date().toISOString();
	const updatedAt = model.lastUsedAt ?? model.bundleVerifiedAt ?? installedAt;
	const bytes = model.sizeBytes ?? 0;
	return {
		jobId: `installed:${model.id}`,
		modelId: model.id,
		state: "completed",
		received: bytes,
		total: bytes,
		bytesPerSec: 0,
		etaMs: 0,
		startedAt: installedAt,
		updatedAt,
	};
}

function updateNativeDownloadJob(
	modelId: string,
	patch: Partial<Omit<NativeDownloadJob, "jobId" | "modelId" | "startedAt">>,
): NativeDownloadJob {
	const current = nativeDownloadState.get(modelId);
	if (!current) {
		throw new Error(`No native download job is registered for ${modelId}`);
	}
	const next: NativeDownloadJob = {
		...current,
		...patch,
		updatedAt: new Date().toISOString(),
	};
	nativeDownloadState.set(modelId, next);
	return next;
}

function writeDownloadChunk(
	writer: ReturnType<typeof createWriteStream>,
	chunk: Uint8Array,
): Promise<void> {
	return new Promise((resolve, reject) => {
		writer.write(Buffer.from(chunk), (error: Error | null | undefined) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

function closeDownloadWriter(
	writer: ReturnType<typeof createWriteStream>,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error): void => {
			writer.off("error", onError);
			reject(error);
		};
		writer.once("error", onError);
		writer.end(() => {
			writer.off("error", onError);
			resolve();
		});
	});
}

async function runNativeModelDownload(
	model: NativeCatalogModelEntry,
): Promise<void> {
	const startedMs = Date.now();
	const totalEstimate = Math.round(model.sizeGb * 1024 ** 3);
	updateNativeDownloadJob(model.id, {
		state: "downloading",
		total: totalEstimate,
	});
	mkdirSync(path.dirname(nativeModelTargetPath(model)), { recursive: true });
	mkdirSync(localInferenceDownloadsPath(), { recursive: true });
	const partialPath = path.join(
		localInferenceDownloadsPath(),
		`${model.id}.part`,
	);
	const response = await fetch(modelDownloadUrl(model), { redirect: "follow" });
	if (!response.ok) {
		throw new Error(
			`Failed to download ${model.id}: HTTP ${response.status} ${response.statusText}`,
		);
	}
	if (!response.body) {
		throw new Error(`Failed to download ${model.id}: response body is empty`);
	}
	const contentLength =
		positiveInteger(response.headers.get("content-length")) ?? totalEstimate;
	updateNativeDownloadJob(model.id, { total: contentLength });
	const writer = createWriteStream(partialPath);
	let received = 0;
	try {
		const reader = response.body.getReader();
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			received += value.byteLength;
			await writeDownloadChunk(writer, value);
			const elapsedSeconds = Math.max(1, (Date.now() - startedMs) / 1000);
			const bytesPerSec = Math.round(received / elapsedSeconds);
			const remaining = Math.max(0, contentLength - received);
			updateNativeDownloadJob(model.id, {
				received,
				bytesPerSec,
				etaMs:
					bytesPerSec > 0 ? Math.round((remaining / bytesPerSec) * 1000) : null,
			});
		}
		await closeDownloadWriter(writer);
		const targetPath = nativeModelTargetPath(model);
		renameSync(partialPath, targetPath);
		const stats = statSync(targetPath);
		const installedAt = new Date().toISOString();
		upsertInstalledModel(
			installedModelForCatalogEntry(
				model,
				targetPath,
				stats.size,
				installedAt,
				"eliza-download",
			),
		);
		updateNativeDownloadJob(model.id, {
			state: "completed",
			received: stats.size,
			total: stats.size,
			bytesPerSec: 0,
			etaMs: 0,
		});
	} catch (error) {
		updateNativeDownloadJob(model.id, {
			state: "failed",
			error: error instanceof Error ? error.message : String(error),
		});
		writer.destroy();
		rmSync(partialPath, { force: true });
		throw error;
	}
}

function startNativeModelDownload(modelId: string): NativeDownloadJob {
	const model = iosNativeCatalogById(modelId);
	if (!model) throw new Error(`Unsupported iOS local model: ${modelId}`);
	const installed = readInstalledModels().find(
		(entry) => entry.id === model.id,
	);
	if (installed) {
		const job = nativeDownloadJobForInstalledModel(installed);
		nativeDownloadState.set(model.id, job);
		return job;
	}
	const existing = nativeDownloadState.get(model.id);
	if (
		existing &&
		(existing.state === "queued" || existing.state === "downloading")
	) {
		return existing;
	}
	const now = new Date().toISOString();
	const job: NativeDownloadJob = {
		jobId: `ios-download:${model.id}:${Date.now()}`,
		modelId: model.id,
		state: "queued",
		received: 0,
		total: Math.round(model.sizeGb * 1024 ** 3),
		bytesPerSec: 0,
		etaMs: null,
		startedAt: now,
		updatedAt: now,
	};
	nativeDownloadState.set(model.id, job);
	void runNativeModelDownload(model).catch(() => {});
	return job;
}

function nativeTextReadiness(): Record<string, unknown> {
	const installed = readInstalledModels().filter(
		(model) => !isEmbeddingModel(model),
	);
	const assignments = readAssignments();
	const now = new Date().toISOString();
	const slots: Record<string, Record<string, unknown>> = {};
	for (const slot of ["TEXT_SMALL", "TEXT_LARGE"]) {
		const assignedModelId = assignments[slot] ?? installed[0]?.id ?? null;
		const model =
			assignedModelId == null
				? null
				: (installed.find((entry) => entry.id === assignedModelId) ?? null);
		const active =
			model != null &&
			nativeLlamaState.modelId === model.id &&
			nativeLlamaState.status === "ready";
		const downloaded = model != null;
		slots[slot] = {
			slot,
			assigned: assignedModelId != null,
			assignedModelId,
			displayName: model?.displayName ?? model?.id ?? null,
			primaryDownloaded: downloaded,
			downloaded,
			active,
			ready: active,
			state: active ? "active" : downloaded ? "downloaded" : "missing",
			requiredModelIds: assignedModelId ? [assignedModelId] : [],
			missingModelIds: downloaded || !assignedModelId ? [] : [assignedModelId],
			installedBytes: model?.sizeBytes ?? 0,
			expectedBytes: model?.sizeBytes ?? 0,
			download: nativeDownloadStatus(model),
			errors: nativeLlamaState.error ? [nativeLlamaState.error] : [],
		};
	}
	return { updatedAt: now, slots };
}

function hasNativeLocalTtsExecutor(): boolean {
	return hostProtocolWrite != null;
}

function hasNativeVoiceBundle(bundleDir: string): boolean {
	// A voice bundle is usable if it ships ANY recognized TTS engine. The CoreML
	// Kokoro model is the preferred (ANE) engine but optional — its absence must
	// not hide the fused OmniVoice/Kokoro-GGUF assets, which the native bridge can
	// still resolve (TTS engine selection happens later, in synthesizeSpeech).
	const ttsDir = path.join(bundleDir, "tts");
	// 1. CoreML Kokoro (preferred).
	try {
		const coreml = path.join(ttsDir, "kokoro-coreml", "kokoro_5s.mlmodelc");
		const voice = path.join(ttsDir, "kokoro-coreml", "voices", "af_heart.json");
		if (statSync(coreml).isDirectory() && statSync(voice).isFile()) return true;
	} catch {
		/* fall through to fused-asset detection */
	}
	// 2. Fused OmniVoice / GGUF Kokoro.
	try {
		for (const entry of readdirSync(ttsDir)) {
			if (/^omnivoice-base-.*\.gguf$/i.test(entry)) return true; // OmniVoice (tier default)
			if (entry === "kokoro") {
				try {
					for (const k of readdirSync(path.join(ttsDir, "kokoro"))) {
						if (/\.gguf$/i.test(k) || k === "model_q4.onnx") return true;
					}
				} catch {
					/* no kokoro subdir */
				}
			}
		}
	} catch {
		return false;
	}
	return false;
}

function nativeVoiceBundleDir(): string | null {
	const modelsRoots = [
		path.join(localInferenceRootPath(), "models"),
		bundledLocalInferenceModelsPath(),
	].filter((root): root is string => Boolean(root));
	let bundleDir: string | null = null;
	const visit = (dir: string, depth: number): void => {
		if (depth > 6 || bundleDir) return;
		let entries: string[] = [];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const entry of entries) {
			const fullPath = path.join(dir, entry);
			let stats: ReturnType<typeof statSync>;
			try {
				stats = statSync(fullPath);
			} catch {
				continue;
			}
			if (stats.isDirectory()) {
				if (entry.endsWith(".bundle") && hasNativeVoiceBundle(fullPath)) {
					bundleDir = fullPath;
					return;
				}
				visit(fullPath, depth + 1);
				if (bundleDir) return;
			}
		}
	};
	for (const root of modelsRoots) {
		visit(root, 0);
		if (bundleDir) return bundleDir;
	}
	return null;
}

function nativeVoiceReadiness(): NativeVoiceReadiness {
	const modelsRoots = [
		path.join(localInferenceRootPath(), "models"),
		bundledLocalInferenceModelsPath(),
	].filter((root): root is string => Boolean(root));
	let installedFiles = 0;
	let modelId: string | null = null;
	const visit = (dir: string, depth: number): void => {
		if (depth > 6 || installedFiles > 0) return;
		let entries: string[] = [];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const entry of entries) {
			const fullPath = path.join(dir, entry);
			let stats: ReturnType<typeof statSync>;
			try {
				stats = statSync(fullPath);
			} catch {
				continue;
			}
			if (stats.isDirectory()) {
				visit(fullPath, depth + 1);
				if (installedFiles > 0) return;
				continue;
			}
			const normalized = fullPath.split(path.sep).join("/");
			if (
				stats.isFile() &&
				/\/(tts|voice|asr|vad)\//i.test(normalized) &&
				/\.(gguf|bin|json)$/i.test(entry)
			) {
				const markerIndex = normalized.indexOf(".bundle/");
				if (markerIndex >= 0) {
					const bundlePath = fullPath.slice(0, markerIndex + ".bundle".length);
					if (hasNativeVoiceBundle(bundlePath)) {
						installedFiles += 1;
						const match = normalized.match(/models\/([^/]+\.bundle)\//);
						modelId = match?.[1]?.replace(/\.bundle$/, "") ?? null;
						return;
					}
				}
			}
		}
	};
	for (const root of modelsRoots) {
		visit(root, 0);
		if (installedFiles > 0) break;
	}
	if (installedFiles > 0) {
		if (!hasNativeLocalTtsExecutor()) {
			return {
				status: "unavailable",
				installedFiles,
				modelId,
				message:
					"Eliza-1 voice assets are installed. This build is missing the iOS local voice playback engine.",
			};
		}
		return {
			status: "assets-ready",
			installedFiles,
			modelId,
			message:
				"Local voice assets are installed. Voice engine will warm on first playback.",
		};
	}
	return {
		status: "missing",
		installedFiles: 0,
		modelId: null,
		message: "Eliza-1 voice assets are not installed in this iOS build.",
	};
}

function routingPreferencesSnapshot(): Record<string, unknown> {
	const parsed = readJsonObjectFile(localInferenceRoutingPath());
	const preferences =
		parsed.preferences && typeof parsed.preferences === "object"
			? (parsed.preferences as Record<string, unknown>)
			: { preferredProvider: {}, policy: {} };
	return {
		registrations: ["TEXT_SMALL", "TEXT_LARGE"].map((modelType) => ({
			modelType,
			provider: IOS_NATIVE_LLAMA_PROVIDER,
			priority: IOS_NATIVE_LLAMA_PRIORITY,
			registeredAt: new Date().toISOString(),
		})),
		preferences,
	};
}

async function nativeHubSnapshot(): Promise<Record<string, unknown>> {
	const hardware = await nativeHardwareInfo();
	return {
		catalog: nativeCatalogModels(),
		installed: readInstalledModels(),
		active: nativeLlamaActiveSnapshot(),
		downloads: nativeDownloadJobs(),
		device: await nativeLlamaDeviceStatus(),
		providers: (await nativeLocalInferenceProviders()).providers,
		hardware: {
			totalRamGb: Number(hardware.total_ram_gb ?? 0),
			freeRamGb: Number(hardware.available_ram_gb ?? 0),
			gpu: {
				backend: "metal",
				available: hardware.metal_supported === true,
			},
			cpuCores: Number(hardware.cpu_cores ?? 0),
			platform: "ios",
			arch: hardware.is_simulator === true ? "simulator" : "arm64",
			appleSilicon: hardware.metal_supported === true,
			recommendedBucket: "small",
			source: "ios-native-llama",
		},
		assignments: readAssignments(),
		textReadiness: nativeTextReadiness(),
		voiceReadiness: nativeVoiceReadiness(),
	};
}

async function synthesizeNativeIosLocalTts(
	request: NativeLocalTtsRequest,
): Promise<Uint8Array> {
	const bundleDir = nativeVoiceBundleDir();
	if (!bundleDir) {
		throw new Error("No Eliza-1 voice bundle is installed");
	}
	const sampleRate = optionalPositiveNumber(request.sampleRate);
	const result = await callIosHost(
		"eliza_tts_synthesize",
		{
			bundleDir,
			text: request.text,
			...(request.voice || request.voiceId
				? { speakerPresetId: request.voice ?? request.voiceId }
				: {}),
			maxSamples: sampleRate ? Math.round(sampleRate * 60) : 24_000 * 60,
		},
		180_000,
	);
	const record =
		result && typeof result === "object" && !Array.isArray(result)
			? (result as Record<string, unknown>)
			: {};
	const audioFilePath = record.audioFilePath;
	if (typeof audioFilePath === "string" && audioFilePath.trim()) {
		const resolvedAudioFilePath = audioFilePath.trim();
		const bytes = readFileSync(resolvedAudioFilePath);
		rmSync(resolvedAudioFilePath, { force: true });
		return normalizeAudioBytes(bytes);
	}
	const audioBase64 = record.audioBase64;
	if (typeof audioBase64 !== "string" || audioBase64.length === 0) {
		throw new Error("Native iOS local TTS returned no audio");
	}
	return normalizeAudioBytes(Buffer.from(audioBase64, "base64"));
}

async function handleNativeIosLocalTtsRoute(
	method: string,
	rawPath: string,
	payload: HttpRequestPayload,
): Promise<BufferedHttpResponse | null> {
	const { pathname } = splitPathAndQuery(rawPath);
	if (method !== "POST" || pathname !== "/api/tts/local-inference") {
		return null;
	}

	const body = parseRequestBody(payload);
	const text =
		typeof body.text === "string"
			? sanitizeLocalInferenceSpeechText(body.text)
			: "";
	if (!text) {
		return jsonResponse(400, { error: "Missing text" });
	}

	const voiceReadiness = nativeVoiceReadiness();
	if (
		voiceReadiness.status !== "ready" &&
		voiceReadiness.status !== "engine-ready" &&
		voiceReadiness.status !== "assets-ready"
	) {
		return jsonResponse(503, {
			error: voiceReadiness.message,
			code:
				voiceReadiness.status === "unavailable"
					? "ios_local_tts_executor_missing"
					: "ios_local_voice_assets_missing",
			voiceReadiness,
		});
	}

	const request: NativeLocalTtsRequest = {
		text,
		...(optionalString(body.voice)
			? { voice: optionalString(body.voice) }
			: {}),
		...(optionalString(body.voiceId)
			? { voice: optionalString(body.voiceId) }
			: {}),
		...(optionalString(body.model)
			? { model: optionalString(body.model) }
			: {}),
		...(optionalString(body.modelId)
			? { modelId: optionalString(body.modelId) }
			: {}),
		...(optionalPositiveNumber(body.speed)
			? { speed: optionalPositiveNumber(body.speed) }
			: {}),
		...(optionalPositiveNumber(body.sampleRate)
			? { sampleRate: optionalPositiveNumber(body.sampleRate) }
			: {}),
		...(optionalString(body.format)
			? { format: optionalString(body.format) }
			: {}),
	};

	try {
		const bytes = await synthesizeNativeIosLocalTts(request);
		if (bytes.length === 0) {
			return jsonResponse(502, {
				error: "Local inference TEXT_TO_SPEECH returned empty audio",
			});
		}
		return bytesResponse(200, bytes, {
			"content-type": sniffAudioContentType(bytes),
			"cache-control": "no-store",
			"content-length": String(bytes.byteLength),
		});
	} catch (error) {
		return jsonResponse(502, {
			error: `Local inference TTS error: ${
				error instanceof Error ? error.message : String(error)
			}`,
			code: "ios_local_tts_failed",
		});
	}
}

async function transcribeNativeIosLocalAsr(
	request: NativeLocalAsrRequest,
): Promise<string> {
	const bundleDir = nativeVoiceBundleDir();
	if (!bundleDir) {
		throw new Error("No Eliza-1 voice bundle is installed");
	}
	const sampleRate = optionalPositiveNumber(request.sampleRate) ?? 16_000;
	// Send fp32 PCM as a JSON number array; `handleAsrTranscribe` in
	// FullBunEngineHost.swift parses the same shape via `floatArrayValue`.
	const result = await callIosHost(
		"eliza_asr_transcribe",
		{
			bundleDir,
			pcm: request.pcm,
			sampleRate,
		},
		180_000,
	);
	const record =
		result && typeof result === "object" && !Array.isArray(result)
			? (result as Record<string, unknown>)
			: {};
	const text = record.text;
	if (typeof text !== "string") {
		throw new Error("Native iOS local ASR returned no transcript");
	}
	return text;
}

function parsePcmFloatArray(value: unknown): number[] | null {
	if (!Array.isArray(value) || value.length === 0) {
		return null;
	}
	const pcm: number[] = [];
	for (const sample of value) {
		if (typeof sample !== "number" || !Number.isFinite(sample)) {
			return null;
		}
		pcm.push(sample);
	}
	return pcm;
}

async function handleNativeIosLocalAsrRoute(
	method: string,
	rawPath: string,
	payload: HttpRequestPayload,
): Promise<BufferedHttpResponse | null> {
	const { pathname } = splitPathAndQuery(rawPath);
	if (method !== "POST" || pathname !== "/api/asr/local-inference") {
		return null;
	}

	const body = parseRequestBody(payload);
	// Internal fast path: mono fp32 PCM in [-1, 1] as a JSON number array under
	// `pcm`. Raw audio and JSON `audioBase64` intentionally fall through to the
	// canonical local-inference ASR route so the public HTTP contract is intact.
	const pcm = parsePcmFloatArray(body.pcm ?? body.audio);
	if (!pcm) {
		return null;
	}

	const voiceReadiness = nativeVoiceReadiness();
	if (
		voiceReadiness.status !== "ready" &&
		voiceReadiness.status !== "engine-ready" &&
		voiceReadiness.status !== "assets-ready"
	) {
		return jsonResponse(503, {
			error: voiceReadiness.message,
			code:
				voiceReadiness.status === "unavailable"
					? "ios_local_asr_executor_missing"
					: "ios_local_voice_assets_missing",
			voiceReadiness,
		});
	}

	const request: NativeLocalAsrRequest = {
		pcm,
		...(optionalPositiveNumber(body.sampleRate)
			? { sampleRate: optionalPositiveNumber(body.sampleRate) }
			: {}),
	};

	try {
		const text = await transcribeNativeIosLocalAsr(request);
		return jsonResponse(200, { text });
	} catch (error) {
		return jsonResponse(502, {
			error: `Local inference ASR error: ${
				error instanceof Error ? error.message : String(error)
			}`,
			code: "ios_local_asr_failed",
		});
	}
}

async function handleNativeIosLocalInferenceRoute(
	method: string,
	rawPath: string,
	payload: HttpRequestPayload,
): Promise<BufferedHttpResponse | null> {
	const { pathname } = splitPathAndQuery(rawPath);
	if (method === "GET" && pathname === "/api/local-inference/device") {
		return jsonResponse(200, await nativeLlamaDeviceStatus());
	}
	if (method === "GET" && pathname === "/api/local-inference/providers") {
		return jsonResponse(200, await nativeLocalInferenceProviders());
	}
	if (method === "GET" && pathname === "/api/local-inference/hardware") {
		return jsonResponse(200, (await nativeHubSnapshot()).hardware);
	}
	if (method === "GET" && pathname === "/api/local-inference/catalog") {
		return jsonResponse(200, { models: nativeCatalogModels() });
	}
	if (method === "GET" && pathname === "/api/local-inference/installed") {
		return jsonResponse(200, { models: readInstalledModels() });
	}
	if (method === "GET" && pathname === "/api/local-inference/downloads") {
		return jsonResponse(200, { downloads: nativeDownloadJobs() });
	}
	if (method === "POST" && pathname === "/api/local-inference/downloads") {
		const body = parseRequestBody(payload);
		const modelId =
			typeof body.modelId === "string"
				? body.modelId
				: body.spec &&
						typeof body.spec === "object" &&
						!Array.isArray(body.spec) &&
						typeof (body.spec as Record<string, unknown>).id === "string"
					? ((body.spec as Record<string, unknown>).id as string)
					: "";
		if (!modelId) {
			return jsonResponse(400, { error: "Missing modelId" });
		}
		try {
			return jsonResponse(200, { job: startNativeModelDownload(modelId) });
		} catch (error) {
			return jsonResponse(400, {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	if (method === "GET" && pathname === "/api/local-inference/routing") {
		return jsonResponse(200, routingPreferencesSnapshot());
	}
	if (method === "GET" && pathname === "/api/local-inference/assignments") {
		return jsonResponse(200, { assignments: readAssignments() });
	}
	if (method === "POST" && pathname === "/api/local-inference/assignments") {
		const body = parseRequestBody(payload);
		const slot = typeof body.slot === "string" ? body.slot : "";
		const modelId = typeof body.modelId === "string" ? body.modelId : null;
		if (!IOS_NATIVE_ASSIGNMENT_SLOTS.has(slot)) {
			return jsonResponse(400, {
				error: `Unsupported assignment slot: ${slot}`,
			});
		}
		if (modelId) {
			const installed = readInstalledModels();
			const known =
				installed.some((model) => model.id === modelId) ||
				iosNativeCatalogById(modelId) != null ||
				nativeDownloadState.has(modelId);
			if (!known) {
				return jsonResponse(404, { error: `Unknown local model: ${modelId}` });
			}
		}
		const assignments = readAssignments();
		if (modelId) assignments[slot] = modelId;
		else delete assignments[slot];
		writeAssignments(assignments);
		return jsonResponse(200, { assignments });
	}
	if (method === "GET" && pathname === "/api/local-inference/active") {
		return jsonResponse(200, nativeLlamaActiveSnapshot());
	}
	if (method === "POST" && pathname === "/api/local-inference/active") {
		const body = parseRequestBody(payload);
		const modelId = typeof body.modelId === "string" ? body.modelId : "";
		const installed = readInstalledModels();
		const target = installed.find((model) => model.id === modelId);
		if (!target) {
			return jsonResponse(404, { error: `Model not installed: ${modelId}` });
		}
		mkdirSync(localInferenceRootPath(), { recursive: true });
		nativeLlamaState.modelId = target.id;
		nativeLlamaState.modelPath = target.path;
		await ensureNativeModelLoaded("TEXT_SMALL");
		return jsonResponse(200, nativeLlamaActiveSnapshot());
	}
	if (method === "DELETE" && pathname === "/api/local-inference/active") {
		await unloadNativeLlamaModel();
		return jsonResponse(200, nativeLlamaActiveSnapshot());
	}
	if (method === "GET" && pathname === "/api/local-inference/hub") {
		return jsonResponse(200, await nativeHubSnapshot());
	}
	const verifyMatch = pathname.match(
		/^\/api\/local-inference\/installed\/([^/]+)\/verify$/,
	);
	if (method === "POST" && verifyMatch?.[1]) {
		const id = decodeURIComponent(verifyMatch[1]);
		const model = readInstalledModels().find((entry) => entry.id === id);
		if (!model)
			return jsonResponse(404, { error: `Model not installed: ${id}` });
		return jsonResponse(200, {
			ok: true,
			modelId: model.id,
			path: model.path,
			sizeBytes: model.sizeBytes ?? 0,
			verifiedAt: new Date().toISOString(),
		});
	}
	return null;
}

async function handleBufferedLocalInferenceRoute(
	method: string,
	rawPath: string,
	payload: HttpRequestPayload,
): Promise<BufferedHttpResponse | null> {
	const { pathname } = splitPathAndQuery(rawPath);
	if (!pathname.startsWith("/api/local-inference/")) return null;

	if (
		method === "GET" &&
		(pathname === "/api/local-inference/downloads/stream" ||
			pathname === "/api/local-inference/device/stream")
	) {
		return jsonResponse(501, {
			error:
				"Streaming local-inference endpoints are not available over the iOS stdio bridge",
			code: "streaming_not_supported",
		});
	}

	const native = await handleNativeIosLocalInferenceRoute(
		method,
		rawPath,
		payload,
	);
	if (native) return native;
	return null;
}

async function ensureConversationConnection(
	backend: IosBridgeBackend,
	conversation: IosConversation,
): Promise<UUID> {
	const runtime = backend.runtime as IAgentRuntime & {
		ensureConnection?: (args: Record<string, unknown>) => Promise<void> | void;
	};
	const userId = stringToUuid("ios-local-user") as UUID;
	if (typeof runtime.ensureConnection === "function") {
		await runtime.ensureConnection({
			entityId: userId,
			roomId: conversation.roomId,
			worldId: stringToUuid("ios-local-world") as UUID,
			userName: "User",
			source: "ios-local",
			channelId: "ios-local-chat",
			type: ChannelType.DM,
			messageServerId: stringToUuid("ios-local-server") as UUID,
			metadata: { ownership: { ownerId: userId } },
		});
	}
	return userId;
}

async function handleDirectConversationMessage(
	backend: IosBridgeBackend,
	conversation: IosConversation,
	input: Record<string, unknown>,
	onToken?: (token: string, accumulated: string) => void,
): Promise<Record<string, unknown>> {
	const prompt =
		typeof input.text === "string"
			? input.text
			: typeof input.message === "string"
				? input.message
				: typeof input.prompt === "string"
					? input.prompt
					: "";
	if (!prompt.trim()) throw new Error("message text is required");

	const runtime = backend.runtime as IAgentRuntime & {
		createMemory?: (
			memory: ReturnType<typeof createMessageMemory>,
			tableName: string,
		) => Promise<void> | void;
		messageService?: RuntimeMessageService;
	};
	const userId = await ensureConversationConnection(backend, conversation);
	const channelType =
		typeof input.channelType === "string" &&
		Object.values(ChannelType).includes(input.channelType as ChannelType)
			? (input.channelType as ChannelType)
			: ChannelType.DM;
	const metadata =
		input.metadata &&
		typeof input.metadata === "object" &&
		!Array.isArray(input.metadata)
			? (input.metadata as Record<string, unknown>)
			: undefined;
	const message = createMessageMemory({
		id: crypto.randomUUID() as UUID,
		entityId: userId,
		roomId: conversation.roomId,
		content: {
			text: prompt,
			source: "ios-local",
			channelType,
			...(metadata ? { metadata: metadata as never } : {}),
		},
	});

	try {
		await runtime.createMemory?.(message, "messages");
	} catch {
		// Best effort. Some adapters persist inside messageService.
	}

	// Track cumulative streamed text so incremental model chunks accumulate into
	// the running `fullText` the client SSE parser expects. Emit tokens verbatim
	// — inter-token whitespace is load-bearing, so no per-chunk trim/strip here
	// (reasoning-block cleanup already happens in the model handler before the
	// chunk reaches us, and the terminal `done` frame carries the final text).
	let streamedAccumulated = "";
	const emitToken = onToken
		? (chunk: string): void => {
				if (!chunk) return;
				streamedAccumulated += chunk;
				onToken(chunk, streamedAccumulated);
			}
		: undefined;

	const nativeReply = await maybeGenerateIosNativeConversationReply(
		backend.runtime,
		prompt,
		emitToken ? (chunk) => emitToken(chunk) : undefined,
	).catch((error) => ({
		text:
			error instanceof Error
				? `The local Eliza-1 model is installed, but generation failed: ${error.message}`
				: "The local Eliza-1 model is installed, but generation failed.",
		reply:
			error instanceof Error
				? `The local Eliza-1 model is installed, but generation failed: ${error.message}`
				: "The local Eliza-1 model is installed, but generation failed.",
		localInference: {
			provider: IOS_NATIVE_LLAMA_PROVIDER,
			mode: "ios_native_conversation",
			error: error instanceof Error ? error.message : String(error),
		},
	}));
	if (nativeReply) {
		const agentName = runtimeAgentName(backend.runtime);
		conversation.updatedAt = new Date().toISOString();
		conversation.lastUserText = prompt.trim();
		conversation.lastAssistantText =
			typeof nativeReply.text === "string" ? nativeReply.text : "";
		conversation.lastAgentName = agentName;
		return {
			...nativeReply,
			agentName,
			conversationId: conversation.id,
		};
	}

	if (!runtime.messageService?.handleMessage) {
		throw new Error("runtime.messageService is not available");
	}

	const chunks: string[] = [];
	try {
		await runtime.messageService.handleMessage(
			runtime,
			message,
			async (content) => {
				if (content?.text) {
					chunks.push(content.text);
					emitToken?.(content.text);
				}
				return [];
			},
		);
	} catch (err) {
		chunks.push(
			err instanceof Error
				? `The local agent started, but generation is unavailable: ${err.message}`
				: "The local agent started, but generation is unavailable.",
		);
	}

	const text = stripReasoningBlocks(chunks.join("")).trim();
	const agentName = runtimeAgentName(backend.runtime);
	conversation.updatedAt = new Date().toISOString();
	conversation.lastUserText = prompt.trim();
	conversation.lastAssistantText = text;
	conversation.lastAgentName = agentName;
	return {
		text,
		reply: text,
		agentName,
		conversationId: conversation.id,
	};
}

function cachedConversationMessageResult(
	conversation: IosConversation,
	input: Record<string, unknown>,
): Record<string, unknown> | null {
	const prompt =
		typeof input.text === "string"
			? input.text
			: typeof input.message === "string"
				? input.message
				: typeof input.prompt === "string"
					? input.prompt
					: "";
	if (
		!conversation.lastAssistantText ||
		!conversation.lastUserText ||
		conversation.lastUserText !== prompt.trim()
	) {
		return null;
	}
	return {
		text: conversation.lastAssistantText,
		reply: conversation.lastAssistantText,
		agentName: conversation.lastAgentName ?? "Eliza",
		conversationId: conversation.id,
		cached: true,
	};
}

function sseEvent(payload: Record<string, unknown>): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

function bufferedConversationStreamResponse(
	result: Record<string, unknown>,
): BufferedHttpResponse {
	const text = typeof result.text === "string" ? result.text : "";
	const agentName =
		typeof result.agentName === "string" && result.agentName.trim()
			? result.agentName
			: "Eliza";
	const body = [
		...(text ? [sseEvent({ type: "token", text, fullText: text })] : []),
		sseEvent({
			type: "done",
			fullText: text,
			agentName,
			completed: true,
			...(typeof result.failureKind === "string"
				? { failureKind: result.failureKind }
				: {}),
			...(result.localInference &&
			typeof result.localInference === "object" &&
			!Array.isArray(result.localInference)
				? { localInference: result.localInference }
				: {}),
		}),
	].join("");
	return {
		status: 200,
		statusText: statusTextForCode(200),
		headers: {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache, no-transform",
			connection: "keep-alive",
		},
		body,
		bodyBase64: Buffer.from(body, "utf8").toString("base64"),
		bodyEncoding: "utf-8",
	};
}

const SSE_STREAM_HEADERS: Record<string, string> = {
	"content-type": "text/event-stream; charset=utf-8",
	"cache-control": "no-cache, no-transform",
	connection: "keep-alive",
};

function sseChunkBase64(payload: Record<string, unknown>): string {
	return Buffer.from(sseEvent(payload), "utf8").toString("base64");
}

/**
 * Drive the chat token stream for `POST /api/conversations/:id/messages/stream`
 * over the native stream contract: emit the SSE response head, one `chunk` per
 * incremental model token, then `complete`. Replaces
 * `bufferedConversationStreamResponse` on the hot path so tokens render
 * incrementally on iOS local mode (#12354).
 *
 * The emitter is the seam that reaches the WebView (via a `stream_emit`
 * host-call → `notifyListeners`); a fake emitter unit-tests the whole flow with
 * no device. A cached turn or a conversation lookup miss still resolves through
 * this path — the client sees the same `token`/`done` frames as a live turn.
 */
export async function streamConversationMessageResponse(
	backend: IosBridgeBackend,
	conversationId: string,
	body: Record<string, unknown>,
	streamId: string,
	emit: StreamEmitter,
): Promise<void> {
	const conversation = backend.conversations.get(conversationId);
	if (!conversation) {
		await emit({
			streamId,
			kind: "response",
			status: 404,
			statusText: statusTextForCode(404),
			headers: { "content-type": "application/json; charset=utf-8" },
		});
		await emit({
			streamId,
			kind: "chunk",
			dataBase64: Buffer.from(
				JSON.stringify({ error: "Conversation not found" }),
				"utf8",
			).toString("base64"),
		});
		await emit({ streamId, kind: "complete", error: null });
		return;
	}

	await emit({
		streamId,
		kind: "response",
		status: 200,
		statusText: statusTextForCode(200),
		headers: SSE_STREAM_HEADERS,
	});

	// A serialized emit tail: keep `chunk` frames in generation order even though
	// `emit` may be async, and let `complete` await every prior chunk.
	let emitTail: Promise<void> = Promise.resolve();
	const enqueueChunk = (payload: Record<string, unknown>): void => {
		const dataBase64 = sseChunkBase64(payload);
		emitTail = emitTail.then(() =>
			Promise.resolve(emit({ streamId, kind: "chunk", dataBase64 })),
		);
	};

	let streamedAny = false;
	let result: Record<string, unknown>;
	try {
		const cached = cachedConversationMessageResult(conversation, body);
		if (cached) {
			result = cached;
			const cachedText = typeof cached.text === "string" ? cached.text : "";
			if (cachedText) {
				streamedAny = true;
				enqueueChunk({ type: "token", text: cachedText, fullText: cachedText });
			}
		} else {
			result = await handleDirectConversationMessage(
				backend,
				conversation,
				body,
				(token, accumulated) => {
					streamedAny = true;
					enqueueChunk({ type: "token", text: token, fullText: accumulated });
				},
			);
		}
	} catch (error) {
		await emitTail;
		await emit({
			streamId,
			kind: "chunk",
			dataBase64: sseChunkBase64({
				type: "error",
				error: error instanceof Error ? error.message : String(error),
			}),
		});
		await emit({ streamId, kind: "complete", error: null });
		return;
	}

	const fullText = typeof result.text === "string" ? result.text : "";
	// If the model handler produced no incremental tokens (e.g. a provider that
	// only resolves the whole reply), emit the full text as one token so the
	// client still renders content before `done`.
	if (!streamedAny && fullText) {
		enqueueChunk({ type: "token", text: fullText, fullText });
	}

	const agentName =
		typeof result.agentName === "string" && result.agentName.trim()
			? result.agentName
			: "Eliza";
	enqueueChunk({
		type: "done",
		fullText,
		agentName,
		completed: true,
		...(typeof result.failureKind === "string"
			? { failureKind: result.failureKind }
			: {}),
		...(result.localInference &&
		typeof result.localInference === "object" &&
		!Array.isArray(result.localInference)
			? { localInference: result.localInference }
			: {}),
	});

	await emitTail;
	await emit({ streamId, kind: "complete", error: null });
}

export async function handleDirectCoreRoute(
	backend: IosBridgeBackend,
	method: string,
	rawPath: string,
	payload: HttpRequestPayload,
): Promise<BufferedHttpResponse | null> {
	const { pathname } = splitPathAndQuery(rawPath);

	if (method === "GET" && pathname === "/api/health") {
		return jsonResponse(200, {
			ready: true,
			runtime: "ok",
			database: "ok",
			plugins: {
				loaded: Array.isArray(
					(backend.runtime as { plugins?: unknown }).plugins,
				)
					? ((backend.runtime as { plugins?: unknown[] }).plugins?.length ?? 0)
					: 0,
				failed: 0,
			},
			coordinator: "not_wired",
			agentState: "running",
			agentName: runtimeAgentName(backend.runtime),
			startedAt: null,
			uptime: 0,
			iosBridge: "bun",
		});
	}

	if (method === "GET" && pathname === "/api/status") {
		// The startup readiness poll (runStartingRuntime → client.getStatus) gates
		// on `state === "running"` from /api/status, then dispatches AGENT_RUNNING.
		// The agent's real /api/status (health-routes.ts) is NOT wired into
		// dispatchRoute — same reason /api/health is shimmed above — so without this
		// the poll 404s ("No iOS local route for GET /api/status") and the app shows
		// "Startup failed: Agent Timeout" even though the in-process agent is up.
		// The full-Bun in-process runtime is booted before routes are served here,
		// so report it running + able to respond.
		return jsonResponse(200, {
			state: "running",
			agentName: runtimeAgentName(backend.runtime),
			model: null,
			canRespond: true,
			startedAt: null,
			uptime: 0,
			startup: { phase: "running", runtimePhase: "running" },
			cloud: {
				connectionStatus: "disconnected",
				activeAgentId: null,
				cloudProvisioned: false,
				hasApiKey: false,
			},
			pendingRestart: false,
			pendingRestartReasons: [],
			iosBridge: "bun",
		});
	}

	if (method === "GET" && pathname === "/api/apps/runs") {
		// The home orchestrator widget polls /api/apps/runs (page-scoped-context
		// provider). It is not served by dispatchRoute on the in-process iOS
		// runtime, so without this shim the home surfaces a raw error toast
		// ("No iOS local route for GET /api/apps/runs"). No app runs exist on a
		// fresh local agent — return an empty list so the widget renders its empty
		// state cleanly instead of an error.
		return jsonResponse(200, []);
	}

	if (method === "GET" && pathname === "/api/first-run/status") {
		// The full-Bun in-process agent is already provisioned and running, so
		// first-run is complete from the backend's perspective (onboarding is a
		// client-shell concern). Mirrors the WebView kernel shim
		// (ios-local-agent-kernel.ts) which the full-Bun bridge replaces — without
		// this route the local-mode startup poll 404s and the app shows
		// "Backend Unreachable".
		return jsonResponse(200, {
			complete: true,
			cloudProvisioned: false,
			deploymentTarget: "local",
		});
	}

	if (method === "POST" && pathname === "/api/first-run") {
		// finishLocal() submits the first-run profile here. The in-process agent
		// is already booted with its config, so the submit is acknowledged as
		// complete — without this route the POST 404s ("No iOS local route for
		// POST /api/first-run") and on-device onboarding can never finish, leaving
		// the user stuck on "Starting local agent". Companion to the GET
		// /api/first-run/status route above.
		return jsonResponse(200, {
			ok: true,
			complete: true,
			deploymentTarget: "local",
		});
	}

	if (method === "GET" && pathname === "/api/auth/me") {
		// The post-startup auth probe hits /api/auth/me; the in-process local
		// agent has no remote auth, so report a local machine session (mirrors
		// the WebView kernel shim). Without it the probe fails and the app shows
		// "Backend Unreachable — auth probe could not reach /api/auth/me".
		return jsonResponse(200, {
			identity: {
				id: "local-agent",
				displayName: "Local Agent",
				kind: "machine",
			},
			session: { id: "local", kind: "local", expiresAt: null },
			access: {
				mode: "local",
				passwordConfigured: false,
				ownerConfigured: false,
			},
		});
	}

	if (method === "GET" && pathname === "/api/auth/status") {
		return jsonResponse(200, {
			required: false,
			pairingEnabled: false,
			expiresAt: null,
			authenticated: true,
			localAccess: true,
		});
	}

	if (method === "POST" && pathname === "/api/dev/model-grind") {
		const report = await runModelGrind({
			callIosHost,
			ensureTextModelLoaded: (slot) => ensureNativeModelLoaded(slot),
			synthesizeTts: async (text) => ({
				bytes: await synthesizeNativeIosLocalTts({ text }),
				sampleRate: 24_000,
			}),
			transcribeAsr: (pcm, sampleRate) =>
				transcribeNativeIosLocalAsr({ pcm, sampleRate }),
			hardwareInfo: () => nativeHardwareInfo(),
			bundleDir: nativeVoiceBundleDir(),
		});
		return jsonResponse(report.overall.allPassed ? 200 : 207, report);
	}

	const localTts = await handleNativeIosLocalTtsRoute(method, rawPath, payload);
	if (localTts) return localTts;

	const localAsr = await handleNativeIosLocalAsrRoute(method, rawPath, payload);
	if (localAsr) return localAsr;

	const localInference = await handleBufferedLocalInferenceRoute(
		method,
		rawPath,
		payload,
	);
	if (localInference) return localInference;

	if (method === "GET" && pathname === "/api/conversations") {
		return jsonResponse(200, {
			conversations: Array.from(backend.conversations.values()).sort(
				(a, b) =>
					new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
			),
		});
	}

	if (method === "POST" && pathname === "/api/conversations") {
		const conversation = createIosConversation(
			backend,
			parseRequestBody(payload),
		);
		return jsonResponse(200, { conversation });
	}

	const messageMatch = pathname.match(
		/^\/api\/conversations\/([^/]+)\/messages$/,
	);
	const messageStreamMatch = pathname.match(
		/^\/api\/conversations\/([^/]+)\/messages\/stream$/,
	);
	if (method === "GET" && messageMatch) {
		return jsonResponse(200, { messages: [] });
	}
	if (method === "POST" && messageStreamMatch) {
		const conversationId = decodeURIComponent(messageStreamMatch[1] ?? "");
		const conversation = backend.conversations.get(conversationId);
		if (!conversation) {
			return jsonResponse(404, { error: "Conversation not found" });
		}
		const body = parseRequestBody(payload);
		const result =
			cachedConversationMessageResult(conversation, body) ??
			(await handleDirectConversationMessage(backend, conversation, body));
		return bufferedConversationStreamResponse(result);
	}
	if (method === "POST" && messageMatch) {
		const conversationId = decodeURIComponent(messageMatch[1] ?? "");
		const conversation = backend.conversations.get(conversationId);
		if (!conversation) {
			return jsonResponse(404, { error: "Conversation not found" });
		}
		const result = await handleDirectConversationMessage(
			backend,
			conversation,
			parseRequestBody(payload),
		);
		return jsonResponse(200, result);
	}

	// ── Memory Viewer ──────────────────────────────────────────────────────
	if (method === "GET" && pathname === "/api/memories/feed") {
		const { query } = splitPathAndQuery(rawPath);
		return handleMemoriesFeedRoute(backend.runtime, query);
	}
	if (method === "GET" && pathname === "/api/memories/browse") {
		const { query } = splitPathAndQuery(rawPath);
		return handleMemoriesBrowseRoute(backend.runtime, query);
	}
	if (method === "GET" && pathname === "/api/memories/stats") {
		return handleMemoriesStatsRoute(backend.runtime);
	}

	// ── Transcripts ────────────────────────────────────────────────────────
	if (
		pathname === "/api/transcripts" ||
		pathname.startsWith("/api/transcripts/")
	) {
		const { query } = splitPathAndQuery(rawPath);
		const transcripts = await handleTranscriptsRoute(
			backend.runtime,
			method,
			pathname,
			query,
			parseRequestBody(payload),
		);
		if (transcripts) return transcripts;
	}

	// ── Browser workspace (the app is the browser on iOS) ──────────────────
	if (pathname.startsWith("/api/browser-workspace")) {
		const browser = handleBrowserWorkspaceRoute(
			method,
			pathname,
			parseRequestBody(payload),
		);
		if (browser) return browser;
	}

	return null;
}

async function sendMessage(
	backend: IosBridgeBackend,
	payload: unknown,
): Promise<Record<string, unknown>> {
	const input =
		payload && typeof payload === "object" && !Array.isArray(payload)
			? (payload as Record<string, unknown>)
			: {};
	const message = typeof input.message === "string" ? input.message : "";
	if (!message.trim()) throw new Error("send_message requires message");

	let conversationId =
		typeof input.conversationId === "string" && input.conversationId.trim()
			? input.conversationId.trim()
			: "";

	if (!conversationId) {
		conversationId = createIosConversation(backend, {
			title: "iOS Local Chat",
		}).id;
	}

	const conversation = backend.conversations.get(conversationId);
	if (!conversation) throw new Error("Conversation not found");

	const result = await timeoutAfter(
		handleDirectConversationMessage(backend, conversation, {
			text: message,
			channelType:
				typeof input.channelType === "string" ? input.channelType : "DM",
			...(input.metadata &&
			typeof input.metadata === "object" &&
			!Array.isArray(input.metadata)
				? { metadata: input.metadata }
				: {}),
		}),
		bridgeTimeoutMs(input.timeoutMs),
		"send_message",
	);
	if (isTimeoutMarker(result)) {
		throw new Error(`${result.label} timed out after ${result.timeoutMs}ms`);
	}
	return { ...result, conversationId, response: result };
}

async function dispatchBridgeRequest(
	host: IosBridgeHost,
	request: BridgeRequest,
): Promise<unknown> {
	const method = typeof request.method === "string" ? request.method : "";
	const payload =
		request.payload && typeof request.payload === "object"
			? (request.payload as Record<string, unknown>)
			: {};
	switch (method) {
		case "status":
			if (host.backend) {
				return bridgeStatus();
			}
			if (host.bootError) {
				return bridgeStatus({
					ready: false,
					phase: "error",
					error:
						host.bootError instanceof Error
							? host.bootError.message
							: String(host.bootError),
				});
			}
			if (payload.timeoutMs !== undefined) {
				await awaitIosBridgeBackend(
					host,
					bridgeTimeoutMs(payload.timeoutMs),
					"status",
				);
				return bridgeStatus();
			}
			return bridgeStatus({ ready: false, phase: "starting" });
		case "http_request":
		case "http_fetch": {
			const backendForFetch = await awaitIosBridgeBackend(
				host,
				bridgeTimeoutMs(payload.timeoutMs),
				method,
			);
			return fetchBackend(
				backendForFetch,
				(request.payload ?? {}) as HttpRequestPayload,
			);
		}
		case "http_request_stream": {
			const streamPayload = (request.payload ?? {}) as HttpStreamRequestPayload;
			const streamId =
				typeof streamPayload.streamId === "string" &&
				streamPayload.streamId.trim()
					? streamPayload.streamId.trim()
					: `ios-stream-${crypto.randomUUID()}`;
			const backendForStream = await awaitIosBridgeBackend(
				host,
				bridgeTimeoutMs(payload.timeoutMs),
				method,
			);
			// Each frame reaches the WebView as a `stream_emit` host-call, which the
			// native host translates into an `agentStream*` Capacitor event. The
			// call blocks until the stream finishes; tokens are already delivered by
			// then, so the caller's listeners (attached before this ran) saw them
			// live.
			return fetchBackendStream(
				backendForStream,
				streamPayload,
				streamId,
				(frame) =>
					callIosHost("stream_emit", frame, 30 * 60_000).then(() => {}),
			);
		}
		case "send_message": {
			const backendForMessage = await awaitIosBridgeBackend(
				host,
				bridgeTimeoutMs(payload.timeoutMs),
				method,
			);
			return sendMessage(backendForMessage, request.payload);
		}
		default:
			throw new Error(`Unknown iOS bridge method: ${method || "(missing)"}`);
	}
}

function reserveStdoutForBridgeProtocol(): () => void {
	const stderrWrite = process.stderr.write.bind(process.stderr);
	const originalStdoutWrite = process.stdout.write.bind(process.stdout);
	const originalConsoleLog = console.log.bind(console);
	const originalConsoleInfo = console.info.bind(console);
	const originalConsoleDebug = console.debug.bind(console);
	const assignments: Array<() => void> = [];

	const tryAssign = <T extends object, K extends keyof T>(
		target: T,
		key: K,
		value: T[K],
		restore: () => void,
	): void => {
		try {
			target[key] = value;
			assignments.push(restore);
		} catch {
			// Embedded iOS Bun can expose selected globals as readonly. Protocol
			// writes still use `originalStdoutWrite`; this downgrade only means
			// third-party stdout noise cannot be force-rerouted by assignment.
		}
	};

	const writeToStderr = (
		chunk: string | Uint8Array,
		encoding?: BufferEncoding | ((err?: Error | null) => void),
		cb?: (err?: Error | null) => void,
	): boolean => {
		if (typeof encoding === "function") {
			return stderrWrite(chunk, encoding);
		}
		if (encoding) {
			return cb
				? stderrWrite(chunk, encoding, cb)
				: stderrWrite(chunk, encoding);
		}
		return cb ? stderrWrite(chunk, cb) : stderrWrite(chunk);
	};

	const stdoutWriteToStderr = ((
		chunk: unknown,
		encoding?: unknown,
		cb?: unknown,
	) =>
		writeToStderr(
			chunk as string | Uint8Array,
			encoding as BufferEncoding,
			cb as ((err?: Error | null) => void) | undefined,
		)) as typeof process.stdout.write;

	tryAssign(process.stdout, "write", stdoutWriteToStderr, () => {
		process.stdout.write = originalStdoutWrite;
	});
	tryAssign(
		console,
		"log",
		((...args: unknown[]) => console.error(...args)) as typeof console.log,
		() => {
			console.log = originalConsoleLog;
		},
	);
	tryAssign(
		console,
		"info",
		((...args: unknown[]) => console.error(...args)) as typeof console.info,
		() => {
			console.info = originalConsoleInfo;
		},
	);
	tryAssign(
		console,
		"debug",
		((...args: unknown[]) => console.error(...args)) as typeof console.debug,
		() => {
			console.debug = originalConsoleDebug;
		},
	);

	return () => {
		for (let i = assignments.length - 1; i >= 0; i -= 1) {
			try {
				assignments[i]?.();
			} catch {
				// Best-effort teardown during app shutdown.
			}
		}
	};
}

export async function runIosBridgeCli(
	argv: string[] = process.argv,
): Promise<void> {
	if (!argv.includes("--stdio")) {
		throw new Error("ios-bridge currently supports --stdio only");
	}

	const protocolWrite = process.stdout.write.bind(process.stdout);
	const restoreStdout = reserveStdoutForBridgeProtocol();
	const writeProtocolLine = (value: BridgeOutboundFrame) => {
		protocolWrite(`${JSON.stringify(value)}\n`);
	};

	installHostCallProtocol(writeProtocolLine);
	const host = startIosBridgeHost();
	process.on("unhandledRejection", (reason) => {
		console.error(
			"[ios-bridge] unhandled rejection:",
			reason instanceof Error ? reason.stack || reason.message : reason,
		);
	});
	process.on("uncaughtException", (error) => {
		console.error(
			"[ios-bridge] uncaught exception:",
			error.stack || error.message,
		);
	});
	writeProtocolLine({
		type: "ready",
		ok: true,
		result: bridgeStatus({ ready: true }),
	});

	const shutdown = async () => {
		try {
			if (host.backend) {
				await host.backend.close();
			}
		} catch {
			// Best effort during app shutdown.
		}
	};
	let stopBridge: (() => void) | null = null;
	const stopPromise = new Promise<void>((resolve) => {
		stopBridge = resolve;
	});
	process.once("SIGINT", () => stopBridge?.());
	process.once("SIGTERM", () => stopBridge?.());

	const keepAlive = setInterval(() => {
		// Bun's iOS stdio does not always keep the JS event loop alive while a
		// native pipe is idle. The bridge is host-owned and exits when the app
		// tears down the engine, so this timer intentionally keeps the process up.
	}, 2_147_483_647);

	// Buffered NDJSON request/response framing is the platform-neutral half of
	// this loop — delegate it to the shared kernel. iOS keeps ownership of the
	// host-call interleaving (`tryHandleHostResultLine`) via `interceptLine`, the
	// runtime host, stdout reservation, and the status/streaming shims above.
	const stdioBridge = createStdioBridge({
		request: (request) => dispatchBridgeRequest(host, request),
		writeFrame: (frame) => writeProtocolLine(frame),
		interceptLine: (line) => tryHandleHostResultLine(line),
	});

	let bufferedInput = "";
	const stdin = process.stdin as typeof process.stdin & {
		setEncoding?: (encoding: BufferEncoding) => void;
		resume?: () => void;
	};
	stdin.setEncoding?.("utf8");
	stdin.on("data", (chunk: Buffer | string) => {
		bufferedInput += typeof chunk === "string" ? chunk : chunk.toString("utf8");
		for (;;) {
			const newline = bufferedInput.indexOf("\n");
			if (newline < 0) break;
			const line = bufferedInput.slice(0, newline).replace(/\r$/, "");
			bufferedInput = bufferedInput.slice(newline + 1);
			void stdioBridge.handleLine(line);
		}
	});
	stdin.once("end", () => {
		if (bufferedInput.trim()) {
			const line = bufferedInput;
			bufferedInput = "";
			void stdioBridge.handleLine(line);
		}
		stopBridge?.();
	});
	stdin.once("error", (err) => {
		writeProtocolLine({
			id: null,
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		});
		stopBridge?.();
	});
	stdin.resume?.();

	await stopPromise;
	clearInterval(keepAlive);
	await stdioBridge.drain();

	restoreStdout();
	await shutdown();
}

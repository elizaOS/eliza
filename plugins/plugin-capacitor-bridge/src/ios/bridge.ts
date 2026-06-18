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
	ModelType,
	stringToUuid,
	type UUID,
} from "@elizaos/core";
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

interface BridgeRequest {
	id?: unknown;
	method?: unknown;
	payload?: unknown;
}

interface BridgeResponse {
	id: unknown;
	ok: boolean;
	result?: unknown;
	error?: string;
}

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

interface IosBridgeBackend {
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
		id: "eliza-1-0_8b",
		displayName: "eliza-1-0.8B",
		hfRepo: ELIZA_1_HF_REPO,
		hfPath: "bundles/0_8b/text/eliza-1-0_8b-128k.gguf",
		ggufFile: "text/eliza-1-0_8b-128k.gguf",
		sizeGb: 0.5,
		minRamGb: 2,
		params: "0.8B",
		bucket: "small",
		contextLength: 131_072,
	},
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

async function startIosBridgeBackend(): Promise<IosBridgeBackend> {
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

	const runtime = await bootElizaRuntime();
	installIosNativeLlamaHandlers(runtime);

	return {
		runtime,
		dispatchRoute,
		conversations: new Map(),
		close: async () => {
			await unloadNativeLlamaModel().catch(() => undefined);
		},
	};
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
	const req = readable as unknown as IncomingMessage & {
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
		res: res as unknown as ServerResponse,
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
			: (parsed as unknown as Record<string, unknown>);
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

function upsertInstalledModel(model: InstalledModelEntry): void {
	const existing = readInstalledModels().filter(
		(entry) => entry.id !== model.id && entry.path !== model.path,
	);
	writeJsonObjectFile(localInferenceRegistryPath(), {
		version: 1,
		models: [...existing, model],
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
	const trimmed = rawPath.trim();
	if (!trimmed || trimmed.includes("\0")) return null;
	const currentRoot = localInferenceRootPath();
	const candidates = new Set<string>([
		trimmed,
		trimmed.replace(/^\/private\/var\//, "/var/"),
	]);
	const marker = "/local-inference/";
	const markerIndex = trimmed.indexOf(marker);
	if (markerIndex >= 0) {
		const relativePath = trimmed.slice(markerIndex + marker.length);
		if (
			relativePath &&
			!relativePath.startsWith("/") &&
			!relativePath.split(/[\\/]+/).includes("..")
		) {
			candidates.add(path.join(currentRoot, relativePath));
		}
	}
	for (const candidate of candidates) {
		try {
			if (existsSync(candidate)) return candidate;
		} catch {}
	}
	return null;
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
		return renderChatMlPrompt(IOS_NATIVE_NO_THINK_SYSTEM, [
			{ role: "user", content: params.prompt },
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
	return renderChatMlPrompt(systemBlocks.join("\n\n"), chatMessages);
}

function renderChatMlPrompt(
	system: string,
	messages: Array<{ role: string; content: string }>,
): string {
	const blocks = [`<|im_start|>system\n${system.trim()}\n<|im_end|>`];
	for (const message of messages) {
		const role =
			message.role === "assistant" || message.role === "tool"
				? message.role
				: "user";
		const content = message.content.trim();
		if (content) blocks.push(`<|im_start|>${role}\n${content}\n<|im_end|>`);
	}
	blocks.push("<|im_start|>assistant\n<think>\n\n</think>\n\n");
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
		.split("<|im_end|>")[0]
		.split("<|im_start|>")[0]
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
			stopSequences: ["<|im_end|>", "<|im_start|>"],
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
	return Array.from(new Set([...requested, "<|im_end|>", "<|endoftext|>"]));
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
				params: model.id.includes("0_8b") ? "0.8B" : "2B",
				quant: "Q8_0",
				sizeGb,
				minRamGb: model.id.includes("0_8b") ? 2 : 4,
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

function hasNativeKokoroBundle(bundleDir: string): boolean {
	const model = path.join(
		bundleDir,
		"tts",
		"kokoro-coreml",
		"kokoro_5s.mlmodelc",
	);
	const voice = path.join(
		bundleDir,
		"tts",
		"kokoro-coreml",
		"voices",
		"af_heart.json",
	);
	try {
		return statSync(model).isDirectory() && statSync(voice).isFile();
	} catch {
		return false;
	}
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
				if (entry.endsWith(".bundle") && hasNativeKokoroBundle(fullPath)) {
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
				/\.(gguf|onnx|bin|json)$/i.test(entry)
			) {
				const markerIndex = normalized.indexOf(".bundle/");
				if (markerIndex >= 0) {
					const bundlePath = fullPath.slice(0, markerIndex + ".bundle".length);
					if (hasNativeKokoroBundle(bundlePath)) {
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
	// Wire contract: mono fp32 PCM in [-1, 1] as a JSON number array under `pcm`.
	const pcm = parsePcmFloatArray(body.pcm ?? body.audio);
	if (!pcm) {
		return jsonResponse(400, { error: "Missing pcm" });
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

	const nativeReply = await maybeGenerateIosNativeConversationReply(
		backend.runtime,
		prompt,
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
				if (content?.text) chunks.push(content.text);
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

async function handleDirectCoreRoute(
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

	const handleLine = async (line: string) => {
		if (!line.trim()) return;
		let parsed: BridgeRequest;
		try {
			parsed = JSON.parse(line) as BridgeRequest;
		} catch (err) {
			writeProtocolLine({
				id: null,
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			});
			return;
		}

		const id = parsed.id ?? null;
		try {
			const result = await dispatchBridgeRequest(host, parsed);
			writeProtocolLine({ id, ok: true, result });
		} catch (err) {
			writeProtocolLine({
				id,
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	};

	let pending = Promise.resolve();
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
			if (tryHandleHostResultLine(line)) continue;
			pending = pending
				.then(() => handleLine(line))
				.catch((err) => {
					writeProtocolLine({
						id: null,
						ok: false,
						error: err instanceof Error ? err.message : String(err),
					});
				});
		}
	});
	stdin.once("end", () => {
		if (bufferedInput.trim()) {
			const line = bufferedInput;
			bufferedInput = "";
			if (!tryHandleHostResultLine(line)) {
				pending = pending.then(() => handleLine(line));
			}
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
	await pending.catch(() => undefined);

	restoreStdout();
	await shutdown();
}

import { E as require_index_cjs, S as invokeDesktopBridgeRequest, n as isElectrobunRuntime, r as getAppBlockerPlugin, v as getWebsiteBlockerPlugin } from "./electrobun-runtime-zXJ9acDW.js";
import { DEFAULT_WALLET_RPC_SELECTIONS as DEFAULT_WALLET_RPC_SELECTIONS$1, WALLET_RPC_PROVIDER_OPTIONS as WALLET_RPC_PROVIDER_OPTIONS$1, isElizaSettingsDebugEnabled, normalizeWalletRpcProviderId, normalizeWalletRpcSelections as normalizeWalletRpcSelections$1, packageNameToAppRouteSlug, sanitizeForSettingsDebug, settingsDebugCloudSummary } from "@elizaos/shared";
import { createContext, useContext } from "react";

//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/config/boot-config-store.js
/**
* AppBootConfig — typed runtime configuration that replaces window.__* globals.
*
* The hosting app (e.g. apps/app) creates an AppBootConfig and passes it via
* <AppBootProvider>. All app-core code reads from this config instead of
* reaching for window globals.
*
* React context lives in `boot-config-react.tsx` so Bun/Node can import this
* module without loading `react` runtime (avoids Bun parsing @types/react).
*/
const DEFAULT_BOOT_CONFIG = {
	branding: {},
	cloudApiBase: "https://www.elizacloud.ai"
};
const BOOT_CONFIG_STORE_KEY = Symbol.for("elizaos.app.boot-config");
const BOOT_CONFIG_WINDOW_KEY = "__ELIZAOS_APP_BOOT_CONFIG__";
/** Resolve the global object (browser or Node) with symbol-key access. */
function getGlobalSlot() {
	return globalThis;
}
function getBootConfigStore() {
	const globalObject = getGlobalSlot();
	const mirroredWindowConfig = globalObject[BOOT_CONFIG_WINDOW_KEY];
	if (mirroredWindowConfig) {
		const mirroredStore = { current: mirroredWindowConfig };
		globalObject[BOOT_CONFIG_STORE_KEY] = mirroredStore;
		return mirroredStore;
	}
	const existing = globalObject[BOOT_CONFIG_STORE_KEY];
	if (existing && typeof existing === "object" && "current" in existing) return existing;
	const store = { current: DEFAULT_BOOT_CONFIG };
	globalObject[BOOT_CONFIG_STORE_KEY] = store;
	globalObject[BOOT_CONFIG_WINDOW_KEY] = store.current;
	return store;
}
/** Set the boot config. Called by AppBootProvider on mount. */
function setBootConfig(config) {
	const store = getBootConfigStore();
	store.current = config;
	getGlobalSlot()[BOOT_CONFIG_WINDOW_KEY] = config;
}
/** Read the boot config from non-React code. */
function getBootConfig() {
	return getBootConfigStore().current;
}
function resolveAssets(catalog) {
	return catalog.assets.map((asset) => ({
		...asset,
		compressedVrmPath: `vrms/${asset.slug}.vrm.gz`,
		rawVrmPath: `vrms/${asset.slug}.vrm`,
		previewPath: `vrms/previews/${asset.slug}.png`,
		backgroundPath: `vrms/backgrounds/${asset.slug}.png`,
		sourceVrmFilename: `${asset.sourceName}.vrm`
	}));
}
/** Resolve a character catalog into ready-to-use assets and characters. */
function resolveCharacterCatalog(catalog) {
	const assets = resolveAssets(catalog);
	const assetById = new Map(assets.map((a) => [a.id, a]));
	const defaultAsset = assets[0] ?? null;
	const injectedCharacters = catalog.injectedCharacters.map((character) => {
		const avatarAsset = assetById.get(character.avatarAssetId) ?? defaultAsset;
		if (!avatarAsset) throw new Error(`Missing avatar asset ${character.avatarAssetId} for ${character.name}.`);
		return {
			...character,
			avatarAsset
		};
	});
	const byCatchphrase = new Map(injectedCharacters.map((c) => [c.catchphrase, c]));
	return {
		assets,
		assetCount: assets.length,
		defaultAsset,
		injectedCharacters,
		injectedCharacterCount: injectedCharacters.length,
		getAsset: (id) => assetById.get(id) ?? defaultAsset,
		getInjectedCharacter: (catchphrase) => byCatchphrase.get(catchphrase) ?? null
	};
}
const mirroredBrandKeys = /* @__PURE__ */ new Set();
const mirroredElizaKeys = /* @__PURE__ */ new Set();
const getProcessEnv = () => {
	try {
		return globalThis.process?.env ?? null;
	} catch {
		return null;
	}
};
/** Sync brand env vars → Eliza equivalents. Server-side only. */
function syncBrandEnvToEliza(aliases) {
	const env = getProcessEnv();
	if (!env) return;
	for (const [brandKey, elizaKey] of aliases) {
		const value = env[brandKey];
		if (typeof value === "string") {
			env[elizaKey] = value;
			mirroredElizaKeys.add(elizaKey);
		} else if (mirroredElizaKeys.has(elizaKey)) {
			delete env[elizaKey];
			mirroredElizaKeys.delete(elizaKey);
		}
	}
}
/** Sync Eliza env vars → brand equivalents. Server-side only. */
function syncElizaEnvToBrand(aliases) {
	const env = getProcessEnv();
	if (!env) return;
	for (const [brandKey, elizaKey] of aliases) {
		const value = env[elizaKey];
		if (typeof value === "string") {
			env[brandKey] = value;
			mirroredBrandKeys.add(brandKey);
		} else if (mirroredBrandKeys.has(brandKey)) {
			delete env[brandKey];
			mirroredBrandKeys.delete(brandKey);
		}
	}
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/utils/assistant-text.js
const STAGE_DIRECTION_FIRST_WORDS = new Set([
	"beam",
	"beams",
	"beaming",
	"blink",
	"blinks",
	"blinking",
	"blush",
	"blushes",
	"blushing",
	"bow",
	"bows",
	"bowing",
	"breathe",
	"breathes",
	"breathing",
	"cheer",
	"cheers",
	"cheering",
	"chuckle",
	"chuckles",
	"chuckling",
	"clap",
	"claps",
	"clapping",
	"cry",
	"cries",
	"crying",
	"curtsy",
	"curtsies",
	"curtsying",
	"dance",
	"dances",
	"dancing",
	"frown",
	"frowns",
	"frowning",
	"gasp",
	"gasps",
	"gasping",
	"gesture",
	"gestures",
	"gesturing",
	"giggle",
	"giggles",
	"giggling",
	"glance",
	"glances",
	"glancing",
	"grin",
	"grins",
	"grinning",
	"laugh",
	"laughs",
	"laughing",
	"lean",
	"leans",
	"leaning",
	"look",
	"looks",
	"looking",
	"nod",
	"nods",
	"nodding",
	"pause",
	"pauses",
	"pausing",
	"point",
	"points",
	"pointing",
	"pose",
	"poses",
	"posing",
	"pout",
	"pouts",
	"pouting",
	"raise",
	"raises",
	"raising",
	"shrug",
	"shrugs",
	"shrugging",
	"sigh",
	"sighs",
	"sighing",
	"smile",
	"smiles",
	"smiling",
	"smirk",
	"smirks",
	"smirking",
	"spin",
	"spins",
	"spinning",
	"stare",
	"stares",
	"staring",
	"stretch",
	"stretches",
	"stretching",
	"sway",
	"sways",
	"swaying",
	"tilt",
	"tilts",
	"tilting",
	"wave",
	"waves",
	"waving",
	"whisper",
	"whispers",
	"whispering",
	"wink",
	"winks",
	"winking",
	"yawn",
	"yawns",
	"yawning"
]);
function collapseInlineWhitespace(input) {
	return input.replace(/[ \t]+/g, " ").trim();
}
function looksLikeStageDirection(input) {
	const normalized = collapseInlineWhitespace(input).trim();
	if (!normalized || normalized.length > 100) return false;
	if (/[^\x00-\x7F]/.test(normalized)) return false;
	const wordMatch = normalized.match(/^[^\w]*([A-Za-z]+)/);
	if (!wordMatch) return false;
	const firstWord = wordMatch[1].toLowerCase();
	return STAGE_DIRECTION_FIRST_WORDS.has(firstWord);
}
function stripWrappedStageDirections(input, pattern) {
	return input.replace(pattern, (match, inner, offset, source) => {
		const prev = source[offset - 1] ?? "";
		const next = source[offset + match.length] ?? "";
		const hasSafeLeftBoundary = offset === 0 || /[\s([{>"'“‘.!?,;:-]/.test(prev);
		const hasSafeRightBoundary = offset + match.length >= source.length || /[\s)\]}<"'”’.!?,;:-]/.test(next);
		if (!hasSafeLeftBoundary || !hasSafeRightBoundary || !looksLikeStageDirection(inner)) return match;
		return " ";
	});
}
function tidyAssistantTextSpacing(input) {
	return (input.length > 2e5 ? input.slice(0, 2e5) : input).replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n").replace(/[ \t]{2,}/g, " ").replace(/ ?([,.;!?])/g, "$1").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")");
}
function stripAssistantStageDirections(input) {
	let normalized = input;
	normalized = stripWrappedStageDirections(normalized, /\*([^*\n]+)\*/g);
	normalized = stripWrappedStageDirections(normalized, /_([^_\n]+)_/g);
	return tidyAssistantTextSpacing(normalized);
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/utils/eliza-globals.js
function getElizaWindow() {
	return typeof window === "undefined" ? null : window;
}
function readTrimmedString(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function getElizaApiBase() {
	const elizaWindow = getElizaWindow();
	return readTrimmedString(elizaWindow?.__ELIZA_API_BASE__) ?? readTrimmedString(elizaWindow?.__ELIZAOS_API_BASE__);
}
function getElizaApiToken() {
	const elizaWindow = getElizaWindow();
	return readTrimmedString(elizaWindow?.__ELIZA_API_TOKEN__) ?? readTrimmedString(elizaWindow?.__ELIZAOS_API_TOKEN__);
}
function setElizaApiBase(value) {
	const elizaWindow = getElizaWindow();
	if (elizaWindow) {
		elizaWindow.__ELIZAOS_API_BASE__ = value;
		elizaWindow.__ELIZA_API_BASE__ = value;
	}
}
function clearElizaApiBase() {
	const elizaWindow = getElizaWindow();
	if (elizaWindow) {
		delete elizaWindow.__ELIZAOS_API_BASE__;
		delete elizaWindow.__ELIZA_API_BASE__;
	}
}
function setElizaApiToken(value) {
	const elizaWindow = getElizaWindow();
	if (elizaWindow) {
		elizaWindow.__ELIZAOS_API_TOKEN__ = value;
		elizaWindow.__ELIZA_API_TOKEN__ = value;
	}
}
function clearElizaApiToken() {
	const elizaWindow = getElizaWindow();
	if (elizaWindow) {
		delete elizaWindow.__ELIZAOS_API_TOKEN__;
		delete elizaWindow.__ELIZA_API_TOKEN__;
	}
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/utils/streaming-text.js
/**
* Merge streaming text updates that may arrive as pure deltas, cumulative
* snapshots, or overlapping suffix/prefix fragments.
*/
function commonPrefixLength(left, right) {
	const maxLength = Math.min(left.length, right.length);
	let index = 0;
	while (index < maxLength && left.charCodeAt(index) === right.charCodeAt(index)) index += 1;
	return index;
}
function commonSuffixLength(left, right, sharedPrefixLength) {
	const maxLength = Math.min(left.length - sharedPrefixLength, right.length - sharedPrefixLength);
	let length = 0;
	while (length < maxLength && left.charCodeAt(left.length - 1 - length) === right.charCodeAt(right.length - 1 - length)) length += 1;
	return length;
}
function isLikelySnapshotReplacement(existing, incoming) {
	const sharedPrefixLength = commonPrefixLength(existing, incoming);
	const sharedLength = sharedPrefixLength + commonSuffixLength(existing, incoming, sharedPrefixLength);
	const minLength = Math.min(existing.length, incoming.length);
	if (minLength < 30 && sharedPrefixLength >= 2) return true;
	return sharedPrefixLength >= 8 || sharedLength >= Math.max(4, Math.ceil(minLength * .7));
}
function mergeStreamingText(existing, incoming) {
	if (!incoming) return existing;
	if (!existing) return incoming;
	const existingNorm = existing.normalize("NFC");
	const incomingNorm = incoming.normalize("NFC");
	if (incomingNorm === existingNorm) return incoming;
	if (incomingNorm.startsWith(existingNorm)) return incoming;
	if (incomingNorm.includes(existingNorm)) return incoming;
	if (existingNorm.startsWith(incomingNorm)) return existing;
	const existingTrimmed = existingNorm.trimEnd();
	const maxOverlap = Math.min(existingTrimmed.length, incomingNorm.length);
	const existingTrimmedLength = existingTrimmed.length;
	for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
		const existingStart = existingTrimmedLength - overlap;
		let match = true;
		for (let index = 0; index < overlap; index += 1) if (existingTrimmed.charCodeAt(existingStart + index) !== incomingNorm.charCodeAt(index)) {
			match = false;
			break;
		}
		if (!match) continue;
		if (overlap === incomingNorm.length) return incoming.length === 1 ? `${existing}${incoming}` : existing;
		return `${existing.slice(0, existing.length - (existingNorm.length - existingTrimmedLength))}${incoming.slice(overlap)}`;
	}
	if (isLikelySnapshotReplacement(existingNorm, incomingNorm)) return incoming;
	return `${existing}${incoming}`;
}
function computeStreamingDelta(existing, incoming) {
	const merged = mergeStreamingText(existing, incoming);
	if (merged === existing) return "";
	if (merged.startsWith(existing)) return merged.slice(existing.length);
	return incoming;
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/native-cloud-http-transport.js
var import_index_cjs = require_index_cjs();
const DIRECT_CLOUD_API_HOSTS = new Set([
	"api.elizacloud.ai",
	"elizacloud.ai",
	"www.elizacloud.ai",
	"dev.elizacloud.ai"
]);
function isNativeDirectCloudApiUrl(url) {
	try {
		const parsed = new URL(url);
		return import_index_cjs.Capacitor.isNativePlatform() && parsed.protocol === "https:" && DIRECT_CLOUD_API_HOSTS.has(parsed.hostname.toLowerCase());
	} catch {
		return false;
	}
}
function headersToRecord(headers) {
	if (!headers) return {};
	const record = {};
	new Headers(headers).forEach((value, key) => {
		record[key] = value;
	});
	return record;
}
function methodAllowsBody(method) {
	const normalized = method.toUpperCase();
	return normalized !== "GET" && normalized !== "HEAD";
}
function bodyToNativeData(body) {
	if (body === null || body === void 0) return void 0;
	if (typeof body === "string") return body;
	if (body instanceof URLSearchParams) return body.toString();
}
function responseBody(data) {
	if (data === null || data === void 0) return "";
	if (typeof data === "string") return data;
	return JSON.stringify(data);
}
async function requestWithNativeCloudHttp(url, init, context) {
	if (!isNativeDirectCloudApiUrl(url)) return null;
	const method = init.method ?? "GET";
	const data = bodyToNativeData(init.body);
	if (init.body != null && data === void 0) return null;
	const result = await import_index_cjs.CapacitorHttp.request({
		url,
		method,
		headers: headersToRecord(init.headers),
		...methodAllowsBody(method) && data !== void 0 ? { data } : {},
		responseType: "text",
		...context?.timeoutMs ? {
			connectTimeout: context.timeoutMs,
			readTimeout: context.timeoutMs
		} : {}
	});
	return new Response(responseBody(result.data), {
		status: result.status,
		headers: result.headers
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/client-types-cloud.js
/**
* Maps raw PTY sessions from /api/coding-agents into CodingAgentSession[].
* Extracted as a pure function so it can be unit-tested without instantiating
* the full ElizaClient.
*/
function mapPtySessionsToCodingAgentSessions(ptySessions) {
	return ptySessions.map((s) => ({
		sessionId: s.id,
		agentType: s.agentType ?? "claude",
		label: s.metadata?.label ?? s.name ?? s.agentType ?? "Agent",
		originalTask: "",
		workdir: s.workdir ?? "",
		status: s.status === "ready" || s.status === "busy" ? "active" : s.status === "error" ? "error" : s.status === "stopped" || s.status === "done" || s.status === "completed" || s.status === "exited" ? "stopped" : "active",
		decisionCount: 0,
		autoResolvedCount: 0
	}));
}
/** Maps persisted coordinator task threads into the existing CodingAgentSession UI shape. */
function mapTaskThreadsToCodingAgentSessions(taskThreads) {
	return taskThreads.map((thread) => ({
		sessionId: thread.latestSessionId ?? thread.id,
		agentType: "task-thread",
		label: thread.title || thread.latestSessionLabel || "Task",
		originalTask: thread.originalRequest,
		workdir: thread.latestWorkdir ?? thread.latestRepo ?? "",
		status: thread.status === "failed" ? "error" : thread.status === "done" ? "completed" : thread.status === "interrupted" ? "stopped" : thread.status === "validating" ? "tool_running" : thread.status === "blocked" || thread.status === "waiting_on_user" ? "blocked" : "active",
		decisionCount: thread.decisionCount,
		autoResolvedCount: 0,
		lastActivity: thread.status === "interrupted" ? "Interrupted - reopen or resume this task" : thread.summary || thread.latestSessionLabel || thread.status
	}));
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/client-types-core.js
var ApiError = class extends Error {
	kind;
	status;
	path;
	constructor(options) {
		super(options.message);
		this.name = "ApiError";
		this.kind = options.kind;
		this.path = options.path;
		this.status = options.status;
		if (options.cause !== void 0) this.cause = options.cause;
	}
};
function isApiError(value) {
	return value instanceof ApiError;
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/client-base.js
/**
* ElizaClient class — core infrastructure only.
*
* Separated from client.ts so domain augmentation files can import the class
* without circular dependency issues.
*/
const GENERIC_NO_RESPONSE_TEXT = "Sorry, I couldn't generate a response right now. Please try again.";
const DEFAULT_FETCH_TIMEOUT_MS = 1e4;
const LOCAL_STORAGE_API_BASE_KEY = "elizaos_api_base";
var ElizaClient = class ElizaClient {
	_baseUrl;
	_userSetBase;
	_token;
	clientId;
	ws = null;
	wsHandlers = /* @__PURE__ */ new Map();
	wsSendQueue = [];
	wsSendQueueLimit = 32;
	reconnectTimer = null;
	backoffMs = 500;
	wsHasConnectedOnce = false;
	connectionState = "disconnected";
	reconnectAttempt = 0;
	disconnectedAt = null;
	connectionStateListeners = /* @__PURE__ */ new Set();
	maxReconnectAttempts = 15;
	_uiLanguage = null;
	/** Store the current UI language so it can be sent as a header on every request. */
	setUiLanguage(lang) {
		this._uiLanguage = lang || null;
	}
	static generateClientId() {
		let random;
		if (typeof globalThis.crypto?.randomUUID === "function") random = globalThis.crypto.randomUUID();
		else if (typeof globalThis.crypto?.getRandomValues === "function") {
			const buf = new Uint8Array(16);
			globalThis.crypto.getRandomValues(buf);
			random = `${Date.now().toString(36)}${Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("")}`;
		} else random = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
		return `ui-${random.slice(0, 256).replace(/[^a-zA-Z0-9._-]/g, "")}`;
	}
	constructor(baseUrl, token) {
		this.clientId = ElizaClient.generateClientId();
		this._token = token?.trim() || null;
		const bootBase = getBootConfig().apiBase;
		const injectedBase = getElizaApiBase();
		const storedBase = typeof window !== "undefined" && window.localStorage ? window.localStorage.getItem(LOCAL_STORAGE_API_BASE_KEY) : null;
		this._userSetBase = baseUrl != null;
		this._baseUrl = baseUrl ?? bootBase ?? injectedBase ?? storedBase ?? "";
	}
	/**
	* Resolve the API base URL lazily.
	* In the desktop shell the main process injects the API base after the
	* page loads (once the agent runtime starts). Re-checking the boot config
	* on every call ensures we pick up the injected value even if it wasn't
	* set at construction, or if the port changed dynamically (e.g. 2138→2139).
	*/
	get baseUrl() {
		if (!this._userSetBase) {
			const bootBase = getBootConfig().apiBase;
			const injectedBase = getElizaApiBase();
			const preferredBase = bootBase ?? injectedBase;
			if (preferredBase && preferredBase !== this._baseUrl) this._baseUrl = preferredBase;
		}
		return this._baseUrl;
	}
	get apiToken() {
		if (this._token) return this._token;
		const bootToken = getBootConfig().apiToken;
		if (typeof bootToken === "string" && bootToken.trim()) return bootToken.trim();
		const injectedToken = getElizaApiToken();
		if (injectedToken) return injectedToken;
		return null;
	}
	hasToken() {
		return Boolean(this.apiToken);
	}
	/**
	* Bearer token sent on app REST requests (compat API). Used when the
	* Electrobun main process relays HTTP so it can match the renderer-injected
	* token in external-desktop / Vite-proxy setups.
	*/
	getRestAuthToken() {
		return this.apiToken;
	}
	setToken(token) {
		this._token = token?.trim() || null;
		setBootConfig({
			...getBootConfig(),
			apiToken: this._token ?? void 0
		});
		if (this._token) setElizaApiToken(this._token);
		else clearElizaApiToken();
	}
	getBaseUrl() {
		return this.baseUrl;
	}
	setBaseUrl(baseUrl) {
		const trimmed = baseUrl?.slice(0, 4096).trim() ?? "";
		let end = trimmed.length;
		while (end > 0 && trimmed.charCodeAt(end - 1) === 47) end--;
		const normalized = trimmed.slice(0, end);
		this._userSetBase = normalized.length > 0;
		this._baseUrl = normalized;
		this.disconnectWs();
		setBootConfig({
			...getBootConfig(),
			apiBase: normalized || void 0
		});
		if (typeof window !== "undefined") {
			if (normalized) window.localStorage.setItem(LOCAL_STORAGE_API_BASE_KEY, normalized);
			else window.localStorage.removeItem(LOCAL_STORAGE_API_BASE_KEY);
			window.sessionStorage.removeItem(LOCAL_STORAGE_API_BASE_KEY);
		}
		if (normalized) setElizaApiBase(normalized);
		else clearElizaApiBase();
	}
	/** True when we have a usable HTTP(S) API endpoint. */
	get apiAvailable() {
		if (this.baseUrl) return true;
		if (typeof window !== "undefined") {
			const proto = window.location.protocol;
			return proto === "http:" || proto === "https:";
		}
		return false;
	}
	async rawRequest(path, init, options) {
		if (!this.apiAvailable) throw new ApiError({
			kind: "network",
			path,
			message: "API not available (no HTTP origin)"
		});
		const requestUrl = (() => {
			if (this.baseUrl) return `${this.baseUrl}${path}`;
			if (typeof window !== "undefined") {
				const proto = window.location.protocol;
				if (proto === "http:" || proto === "https:") return new URL(path, window.location.origin).toString();
			}
			return path;
		})();
		const makeRequest = async (token) => {
			const timeoutMs = options?.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
			const abortController = new AbortController();
			let timeoutId;
			let timedOut = false;
			let abortListener;
			if (init?.signal?.aborted) throw new ApiError({
				kind: "network",
				path,
				message: "Request aborted"
			});
			timeoutId = setTimeout(() => {
				timedOut = true;
				abortController.abort();
			}, timeoutMs);
			if (init?.signal) {
				abortListener = () => {
					abortController.abort();
				};
				init.signal.addEventListener("abort", abortListener, { once: true });
			}
			const requestInit = {
				...init,
				signal: abortController.signal,
				headers: {
					"X-ElizaOS-Client-Id": this.clientId,
					...token ? { Authorization: `Bearer ${token}` } : {},
					...this._uiLanguage ? { "X-ElizaOS-UI-Language": this._uiLanguage } : {},
					...init?.headers
				}
			};
			try {
				const nativeCloudResponse = await requestWithNativeCloudHttp(requestUrl, requestInit, { timeoutMs });
				if (nativeCloudResponse) return nativeCloudResponse;
				return await fetch(requestUrl, requestInit);
			} catch (err) {
				if (timedOut) throw new ApiError({
					kind: "timeout",
					path,
					message: `Request timed out after ${timeoutMs}ms`
				});
				if (abortController.signal.aborted) throw new ApiError({
					kind: "network",
					path,
					message: "Request aborted",
					cause: err
				});
				if (err instanceof ApiError) throw err;
				throw new ApiError({
					kind: "network",
					path,
					message: err instanceof Error && err.message ? err.message : "Network request failed",
					cause: err
				});
			} finally {
				if (timeoutId !== void 0) clearTimeout(timeoutId);
				if (init?.signal && abortListener) init.signal.removeEventListener("abort", abortListener);
			}
		};
		const token = this.apiToken;
		let res = await makeRequest(token);
		if (res.status === 401 && !token) {
			const retryToken = this.apiToken;
			if (retryToken) res = await makeRequest(retryToken);
		}
		if (!res.ok && !options?.allowNonOk) {
			const body = await res.json().catch(() => ({ error: res.statusText }));
			throw new ApiError({
				kind: "http",
				path,
				status: res.status,
				message: body?.error ?? `HTTP ${res.status}`
			});
		}
		return res;
	}
	async fetch(path, init, options) {
		const res = await this.rawRequest(path, {
			...init,
			headers: {
				"Content-Type": "application/json",
				...init?.headers
			}
		}, options);
		if (res.status === 204) return;
		const text = await res.text();
		if (text === "") return;
		try {
			return JSON.parse(text);
		} catch (err) {
			throw new ApiError({
				kind: "parse",
				path,
				status: res.status,
				message: err instanceof Error ? `Invalid JSON response: ${err.message}` : "Invalid JSON response",
				cause: err
			});
		}
	}
	connectWs() {
		if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) return;
		let host;
		let wsProtocol;
		if (this.baseUrl) {
			const parsed = new URL(this.baseUrl);
			host = parsed.host;
			wsProtocol = parsed.protocol === "https:" ? "wss:" : "ws:";
		} else {
			const loc = window.location;
			if (loc.protocol !== "http:" && loc.protocol !== "https:") return;
			host = loc.host;
			wsProtocol = loc.protocol === "https:" ? "wss:" : "ws:";
		}
		if (!host) return;
		if (!this.baseUrl && typeof host === "string") {
			const hasPort = host.includes(":");
			const isLoopback = host.startsWith("127.") || host.startsWith("localhost:");
			if (!hasPort && !isLoopback) return;
		}
		let url = `${wsProtocol}//${host}/ws`;
		const params = new URLSearchParams({ clientId: this.clientId });
		url += `?${params.toString()}`;
		this.ws = new WebSocket(url);
		this.ws.onopen = () => {
			const token = this.apiToken;
			if (token && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({
				type: "auth",
				token
			}));
			this.backoffMs = 500;
			this.reconnectAttempt = 0;
			this.disconnectedAt = null;
			this.connectionState = "connected";
			this.emitConnectionStateChange();
			if (this.wsHasConnectedOnce) {
				const handlers = this.wsHandlers.get("ws-reconnected");
				if (handlers) for (const handler of handlers) handler({ type: "ws-reconnected" });
			}
			this.wsHasConnectedOnce = true;
			if (this.wsSendQueue.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
				const pending = this.wsSendQueue;
				this.wsSendQueue = [];
				for (let i = 0; i < pending.length; i++) {
					if (this.ws?.readyState !== WebSocket.OPEN) {
						this.wsSendQueue = pending.slice(i).concat(this.wsSendQueue);
						break;
					}
					try {
						this.ws.send(pending[i]);
					} catch {
						this.wsSendQueue = pending.slice(i).concat(this.wsSendQueue);
						break;
					}
				}
			}
		};
		this.ws.onmessage = (event) => {
			try {
				const data = JSON.parse(event.data);
				const type = data.type;
				const handlers = this.wsHandlers.get(type);
				if (handlers) for (const handler of handlers) handler(data);
				const allHandlers = this.wsHandlers.get("*");
				if (allHandlers) for (const handler of allHandlers) handler(data);
			} catch {}
		};
		this.ws.onclose = () => {
			this.ws = null;
			if (this.disconnectedAt === null) this.disconnectedAt = Date.now();
			this.reconnectAttempt++;
			if (this.reconnectAttempt >= this.maxReconnectAttempts) this.connectionState = "failed";
			else this.connectionState = "reconnecting";
			this.emitConnectionStateChange();
			this.scheduleReconnect();
		};
		this.ws.onerror = () => {};
	}
	scheduleReconnect() {
		if (this.reconnectTimer) return;
		if (this.reconnectAttempt >= this.maxReconnectAttempts) {
			this.reconnectTimer = setTimeout(() => {
				this.reconnectTimer = null;
				this.connectWs();
			}, 3e4);
			return;
		}
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.connectWs();
		}, this.backoffMs);
		this.backoffMs = Math.min(this.backoffMs * 1.5, 1e4);
	}
	emitConnectionStateChange() {
		const state = this.getConnectionState();
		for (const listener of this.connectionStateListeners) try {
			listener(state);
		} catch {}
	}
	/** Get the current WebSocket connection state. */
	getConnectionState() {
		return {
			state: this.connectionState,
			reconnectAttempt: this.reconnectAttempt,
			maxReconnectAttempts: this.maxReconnectAttempts,
			disconnectedAt: this.disconnectedAt
		};
	}
	/** Subscribe to connection state changes. Returns an unsubscribe function. */
	onConnectionStateChange(listener) {
		this.connectionStateListeners.add(listener);
		return () => {
			this.connectionStateListeners.delete(listener);
		};
	}
	/** Reset connection state and restart reconnection attempts. */
	resetConnection() {
		this.reconnectAttempt = 0;
		this.disconnectedAt = null;
		this.connectionState = "disconnected";
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.backoffMs = 500;
		this.emitConnectionStateChange();
		this.connectWs();
	}
	/** Send an arbitrary JSON message over the WebSocket connection. */
	sendWsMessage(data) {
		const payload = JSON.stringify(data);
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(payload);
			return;
		}
		if (data.type === "active-conversation") this.wsSendQueue = this.wsSendQueue.filter((queued) => {
			try {
				return JSON.parse(queued).type !== "active-conversation";
			} catch {
				return true;
			}
		});
		if (this.wsSendQueue.length >= this.wsSendQueueLimit) {
			const droppedType = typeof data.type === "string" ? data.type : "unknown";
			console.warn("[ws] send queue full - dropping:", droppedType);
			this.wsSendQueue.shift();
		}
		this.wsSendQueue.push(payload);
		if (!this.ws || this.ws.readyState === WebSocket.CLOSED) this.connectWs();
	}
	onWsEvent(type, handler) {
		if (!this.wsHandlers.has(type)) this.wsHandlers.set(type, /* @__PURE__ */ new Set());
		this.wsHandlers.get(type)?.add(handler);
		return () => {
			this.wsHandlers.get(type)?.delete(handler);
		};
	}
	disconnectWs() {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.ws?.close();
		this.ws = null;
		this.wsSendQueue = [];
		this.reconnectAttempt = 0;
		this.disconnectedAt = null;
		this.connectionState = "disconnected";
		this.emitConnectionStateChange();
	}
	normalizeAssistantText(text) {
		const trimmed = stripAssistantStageDirections(text).trim();
		if (trimmed.length === 0) {
			if (text.trim().length === 0 || /^\(?no response\)?$/i.test(text.trim())) return GENERIC_NO_RESPONSE_TEXT;
			return "";
		}
		if (/^\(?no response\)?$/i.test(trimmed)) return GENERIC_NO_RESPONSE_TEXT;
		return trimmed;
	}
	normalizeGreetingText(text) {
		const trimmed = stripAssistantStageDirections(text).trim();
		if (trimmed.length === 0 || /^\(?no response\)?$/i.test(trimmed)) return "";
		return trimmed;
	}
	async streamChatEndpoint(path, text, onToken, channelType = "DM", signal, images, conversationMode, metadata) {
		const res = await this.rawRequest(path, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "text/event-stream"
			},
			body: JSON.stringify({
				text,
				channelType,
				...images?.length ? { images } : {},
				...conversationMode ? { conversationMode } : {},
				...metadata ? { metadata } : {}
			}),
			signal
		});
		if (!res.body) throw new Error("Streaming not supported by this browser");
		const decoder = new TextDecoder();
		const reader = res.body.getReader();
		let buffer = "";
		let fullText = "";
		let doneText = null;
		let doneAgentName = null;
		let doneNoResponseReason = null;
		let doneUsage;
		let receivedDone = false;
		const findSseEventBreak = (chunkBuffer) => {
			const lfBreak = chunkBuffer.indexOf("\n\n");
			const crlfBreak = chunkBuffer.indexOf("\r\n\r\n");
			if (lfBreak === -1 && crlfBreak === -1) return null;
			if (lfBreak === -1) return {
				index: crlfBreak,
				length: 4
			};
			if (crlfBreak === -1) return {
				index: lfBreak,
				length: 2
			};
			return lfBreak < crlfBreak ? {
				index: lfBreak,
				length: 2
			} : {
				index: crlfBreak,
				length: 4
			};
		};
		const parseDataLine = (line) => {
			const payload = line.startsWith("data:") ? line.slice(5).trim() : "";
			if (!payload) return;
			let parsed;
			try {
				parsed = JSON.parse(payload);
			} catch {
				return;
			}
			if (!parsed.type && typeof parsed.text === "string") parsed.type = "token";
			if (parsed.type === "token") {
				const chunk = parsed.text ?? "";
				const nextFullText = typeof parsed.fullText === "string" ? parsed.fullText : chunk ? mergeStreamingText(fullText, chunk) : fullText;
				if (nextFullText === fullText) return;
				fullText = nextFullText;
				onToken(chunk, fullText);
				return;
			}
			if (parsed.type === "done") {
				receivedDone = true;
				if (typeof parsed.fullText === "string") doneText = parsed.fullText;
				if (typeof parsed.agentName === "string" && parsed.agentName.trim()) doneAgentName = parsed.agentName;
				if (parsed.noResponseReason === "ignored") doneNoResponseReason = "ignored";
				if (parsed.usage) doneUsage = {
					promptTokens: parsed.usage.promptTokens ?? 0,
					completionTokens: parsed.usage.completionTokens ?? 0,
					totalTokens: parsed.usage.totalTokens ?? 0,
					model: parsed.usage.model
				};
				reader.cancel("elizaos-sse-terminal-done").catch(() => {});
				return;
			}
			if (parsed.type === "error") throw new Error(parsed.message ?? "generation failed");
		};
		const SSE_IDLE_TIMEOUT_MS = 6e4;
		while (true) {
			let done = false;
			let value;
			try {
				const readPromise = reader.read();
				const timeoutPromise = new Promise((_, reject) => {
					const id = setTimeout(() => reject(/* @__PURE__ */ new Error("SSE idle timeout — no data for 60s")), SSE_IDLE_TIMEOUT_MS);
					readPromise.finally(() => clearTimeout(id));
				});
				({done, value} = await Promise.race([readPromise, timeoutPromise]));
			} catch (streamErr) {
				console.warn("[api-client] SSE stream interrupted:", streamErr);
				reader.cancel("elizaos-sse-idle-timeout").catch(() => {});
				break;
			}
			if (done || !value) break;
			buffer += decoder.decode(value, { stream: true });
			let eventBreak = findSseEventBreak(buffer);
			while (eventBreak) {
				const rawEvent = buffer.slice(0, eventBreak.index);
				buffer = buffer.slice(eventBreak.index + eventBreak.length);
				for (const line of rawEvent.split(/\r?\n/)) {
					if (!line.startsWith("data:")) continue;
					parseDataLine(line);
				}
				eventBreak = findSseEventBreak(buffer);
			}
		}
		if (buffer.trim()) {
			for (const line of buffer.split(/\r?\n/)) if (line.startsWith("data:")) parseDataLine(line);
		}
		return {
			text: doneNoResponseReason === "ignored" ? "" : this.normalizeAssistantText(doneText ?? fullText),
			agentName: doneAgentName ?? "Eliza",
			completed: receivedDone,
			...doneNoResponseReason ? { noResponseReason: doneNoResponseReason } : {},
			...doneUsage ? { usage: doneUsage } : {}
		};
	}
};

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/chat/coding-agent-session-state.js
const STATUS_DOT = {
	active: "bg-ok",
	tool_running: "bg-accent",
	blocked: "bg-warn",
	error: "bg-danger"
};
const PULSE_STATUSES = new Set(["active", "tool_running"]);
const TERMINAL_STATUSES = new Set([
	"completed",
	"stopped",
	"error",
	"interrupted"
]);
function mapServerTasksToSessions(tasks) {
	return tasks.filter((task) => !TERMINAL_STATUSES.has(task.status ?? "")).map((task) => ({
		sessionId: task.sessionId,
		agentType: task.agentType ?? "claude",
		label: task.label ?? task.sessionId,
		originalTask: task.originalTask ?? "",
		workdir: task.workdir ?? "",
		status: task.status ?? "active",
		decisionCount: task.decisionCount ?? 0,
		autoResolvedCount: task.autoResolvedCount ?? 0
	}));
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/client-agent.js
/**
* Agent domain methods — lifecycle, auth, config, connectors, triggers,
* training, plugins, streaming/PTY, logs, character, permissions, updates.
*/
function clientSettingsDebug() {
	let viteEnv;
	try {
		viteEnv = import.meta.env;
	} catch {
		viteEnv = void 0;
	}
	return isElizaSettingsDebugEnabled({
		importMetaEnv: viteEnv,
		env: typeof process !== "undefined" ? process.env : void 0
	});
}
const WEBSITE_BLOCKING_PERMISSION_ID = "website-blocking";
function getNativeWebsiteBlockerPluginIfAvailable() {
	const plugin = getWebsiteBlockerPlugin();
	return typeof plugin.getStatus === "function" && typeof plugin.startBlock === "function" && typeof plugin.stopBlock === "function" && typeof plugin.checkPermissions === "function" && typeof plugin.requestPermissions === "function" && typeof plugin.openSettings === "function" ? plugin : null;
}
function getNativeAppBlockerPluginIfAvailable() {
	const plugin = getAppBlockerPlugin();
	return typeof plugin.getStatus === "function" && typeof plugin.checkPermissions === "function" && typeof plugin.requestPermissions === "function" && typeof plugin.getInstalledApps === "function" && typeof plugin.selectApps === "function" && typeof plugin.blockApps === "function" && typeof plugin.unblockApps === "function" ? plugin : null;
}
function mapWebsiteBlockerPermissionResult(permission) {
	return {
		id: WEBSITE_BLOCKING_PERMISSION_ID,
		status: permission.status,
		canRequest: permission.canRequest,
		reason: permission.reason,
		lastChecked: Date.now()
	};
}
function mapWebsiteBlockerStatusToPermission(status) {
	return {
		id: WEBSITE_BLOCKING_PERMISSION_ID,
		status: status.permissionStatus ?? (status.available ? "granted" : "not-determined"),
		canRequest: status.canRequestPermission ?? status.supportsElevationPrompt,
		reason: status.reason,
		lastChecked: Date.now()
	};
}
function logSettingsClient(phase, detail) {
	if (!clientSettingsDebug()) return;
	console.debug(`[eliza][settings][client] ${phase}`, sanitizeForSettingsDebug(detail));
}
const SETTINGS_MUTATION_TIMEOUT_MS = 3e4;
ElizaClient.prototype.getStatus = async function() {
	return this.fetch("/api/status");
};
ElizaClient.prototype.getAgentSelfStatus = async function() {
	return this.fetch("/api/agent/self-status");
};
ElizaClient.prototype.getRuntimeSnapshot = async function(opts) {
	const params = new URLSearchParams();
	if (typeof opts?.depth === "number") params.set("depth", String(opts.depth));
	if (typeof opts?.maxArrayLength === "number") params.set("maxArrayLength", String(opts.maxArrayLength));
	if (typeof opts?.maxObjectEntries === "number") params.set("maxObjectEntries", String(opts.maxObjectEntries));
	if (typeof opts?.maxStringLength === "number") params.set("maxStringLength", String(opts.maxStringLength));
	const qs = params.toString();
	return this.fetch(`/api/runtime${qs ? `?${qs}` : ""}`);
};
ElizaClient.prototype.setAutomationMode = async function(mode) {
	return this.fetch("/api/permissions/automation-mode", {
		method: "PUT",
		body: JSON.stringify({ mode })
	});
};
ElizaClient.prototype.setTradeMode = async function(mode) {
	return this.fetch("/api/permissions/trade-mode", {
		method: "PUT",
		body: JSON.stringify({ mode })
	});
};
ElizaClient.prototype.playEmote = async function(emoteId) {
	return this.fetch("/api/emote", {
		method: "POST",
		body: JSON.stringify({ emoteId })
	});
};
ElizaClient.prototype.runTerminalCommand = async function(command) {
	return this.fetch("/api/terminal/run", {
		method: "POST",
		body: JSON.stringify({ command })
	});
};
ElizaClient.prototype.getOnboardingStatus = async function() {
	return this.fetch("/api/onboarding/status");
};
ElizaClient.prototype.getWalletKeys = async function() {
	return this.fetch("/api/wallet/keys");
};
ElizaClient.prototype.getWalletOsStoreStatus = async function() {
	return this.fetch("/api/wallet/os-store");
};
ElizaClient.prototype.postWalletOsStoreAction = async function(action) {
	return this.fetch("/api/wallet/os-store", {
		method: "POST",
		body: JSON.stringify({ action })
	});
};
ElizaClient.prototype.getAuthStatus = async function() {
	const maxRetries = 3;
	const baseBackoffMs = 1e3;
	let lastErr;
	for (let attempt = 0; attempt <= maxRetries; attempt++) try {
		return await this.fetch("/api/auth/status");
	} catch (err) {
		const status = err?.status;
		if (status === 401) return {
			required: true,
			pairingEnabled: false,
			expiresAt: null
		};
		if (status === 404) return {
			required: false,
			pairingEnabled: false,
			expiresAt: null
		};
		lastErr = err;
		if (attempt < maxRetries) await new Promise((r) => setTimeout(r, baseBackoffMs * 2 ** attempt));
	}
	throw lastErr;
};
ElizaClient.prototype.postBootstrapExchange = async function(token) {
	const body = await this.fetch("/api/auth/bootstrap/exchange", {
		method: "POST",
		body: JSON.stringify({ token })
	}, { allowNonOk: true });
	if (typeof body.sessionId === "string" && typeof body.expiresAt === "number" && typeof body.identityId === "string") return {
		ok: true,
		sessionId: body.sessionId,
		expiresAt: body.expiresAt,
		identityId: body.identityId
	};
	const reason = body.reason;
	return {
		ok: false,
		status: reason === "rate_limited" ? 429 : reason === "db_unavailable" || reason === "missing_issuer_env" || reason === "missing_container_env" ? 503 : reason === "missing_token" ? 400 : 401,
		error: body.error ?? "exchange_failed",
		reason
	};
};
ElizaClient.prototype.pair = async function(code) {
	return await this.fetch("/api/auth/pair", {
		method: "POST",
		body: JSON.stringify({ code })
	});
};
ElizaClient.prototype.getOnboardingOptions = async function() {
	return this.fetch("/api/onboarding/options");
};
ElizaClient.prototype.submitOnboarding = async function(data) {
	await this.fetch("/api/onboarding", {
		method: "POST",
		body: JSON.stringify(data)
	});
};
ElizaClient.prototype.startAnthropicLogin = async function() {
	return this.fetch("/api/subscription/anthropic/start", { method: "POST" });
};
ElizaClient.prototype.exchangeAnthropicCode = async function(code) {
	return this.fetch("/api/subscription/anthropic/exchange", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ code })
	});
};
ElizaClient.prototype.submitAnthropicSetupToken = async function(token) {
	return this.fetch("/api/subscription/anthropic/setup-token", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ token })
	});
};
ElizaClient.prototype.getSubscriptionStatus = async function() {
	return this.fetch("/api/subscription/status");
};
ElizaClient.prototype.deleteSubscription = async function(provider) {
	return this.fetch(`/api/subscription/${encodeURIComponent(provider)}`, { method: "DELETE" });
};
ElizaClient.prototype.switchProvider = async function(provider, apiKey, primaryModel, options) {
	logSettingsClient("POST /api/provider/switch → start", {
		baseUrl: this.getBaseUrl(),
		provider,
		hasApiKey: Boolean(apiKey?.trim()),
		apiKey,
		hasPrimaryModel: Boolean(primaryModel?.trim()),
		primaryModel,
		useLocalEmbeddings: options?.useLocalEmbeddings
	});
	const result = await this.fetch("/api/provider/switch", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			provider,
			...apiKey ? { apiKey } : {},
			...primaryModel ? { primaryModel } : {},
			...options?.useLocalEmbeddings != null ? { useLocalEmbeddings: options.useLocalEmbeddings } : {}
		})
	});
	logSettingsClient("POST /api/provider/switch ← ok", {
		baseUrl: this.getBaseUrl(),
		result
	});
	return result;
};
ElizaClient.prototype.startOpenAILogin = async function() {
	return this.fetch("/api/subscription/openai/start", { method: "POST" });
};
ElizaClient.prototype.exchangeOpenAICode = async function(code) {
	return this.fetch("/api/subscription/openai/exchange", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ code })
	});
};
ElizaClient.prototype.startAgent = async function() {
	return (await this.fetch("/api/agent/start", { method: "POST" })).status;
};
ElizaClient.prototype.stopAgent = async function() {
	return (await this.fetch("/api/agent/stop", { method: "POST" })).status;
};
ElizaClient.prototype.pauseAgent = async function() {
	return (await this.fetch("/api/agent/pause", { method: "POST" })).status;
};
ElizaClient.prototype.resumeAgent = async function() {
	return (await this.fetch("/api/agent/resume", { method: "POST" })).status;
};
ElizaClient.prototype.restartAgent = async function() {
	try {
		return (await this.fetch("/api/agent/restart", { method: "POST" })).status;
	} catch {
		await this.fetch("/api/restart", { method: "POST" });
		return {
			state: "restarting",
			agentName: "Eliza",
			model: void 0,
			uptime: void 0,
			startedAt: void 0
		};
	}
};
ElizaClient.prototype.restartAndWait = async function(maxWaitMs = 3e4) {
	const t0 = Date.now();
	console.info("[eliza][reset][client] restartAndWait: begin", {
		baseUrl: this.getBaseUrl(),
		maxWaitMs
	});
	try {
		await this.restartAgent();
		console.info("[eliza][reset][client] restartAndWait: restart accepted");
	} catch (e) {
		console.info("[eliza][reset][client] restartAndWait: initial restart call failed (often 409 while restarting)", e);
	}
	const start = Date.now();
	const interval = 1e3;
	let pollN = 0;
	while (Date.now() - start < maxWaitMs) {
		await new Promise((r) => setTimeout(r, interval));
		pollN += 1;
		try {
			const status = await this.getStatus();
			if (status.state === "running") {
				console.info("[eliza][reset][client] restartAndWait: running", {
					pollN,
					waitedMs: Date.now() - t0,
					port: status.port
				});
				return status;
			}
			if (pollN === 1 || pollN % 5 === 0) console.debug("[eliza][reset][client] restartAndWait: poll", {
				pollN,
				state: status.state,
				waitedMs: Date.now() - t0
			});
		} catch (pollErr) {
			if (pollN === 1 || pollN % 5 === 0) console.debug("[eliza][reset][client] restartAndWait: getStatus error while polling", {
				pollN,
				waitedMs: Date.now() - t0
			}, pollErr);
		}
	}
	const final = await this.getStatus();
	console.warn("[eliza][reset][client] restartAndWait: timed out — returning last status", {
		state: final.state,
		waitedMs: Date.now() - t0,
		maxWaitMs
	});
	return final;
};
ElizaClient.prototype.resetAgent = async function() {
	console.info("[eliza][reset][client] POST /api/agent/reset", { baseUrl: this.getBaseUrl() });
	await this.fetch("/api/agent/reset", { method: "POST" });
	console.info("[eliza][reset][client] POST /api/agent/reset OK");
};
ElizaClient.prototype.restart = async function() {
	return this.fetch("/api/restart", { method: "POST" });
};
ElizaClient.prototype.getConfig = async function() {
	logSettingsClient("GET /api/config → start", { baseUrl: this.getBaseUrl() });
	const r = await this.fetch("/api/config");
	const cloud = r.cloud;
	logSettingsClient("GET /api/config ← ok", {
		baseUrl: this.getBaseUrl(),
		topKeys: Object.keys(r).sort(),
		cloud: settingsDebugCloudSummary(cloud)
	});
	return r;
};
ElizaClient.prototype.getConfigSchema = async function() {
	return this.fetch("/api/config/schema");
};
ElizaClient.prototype.updateConfig = async function(patch) {
	logSettingsClient("PUT /api/config → start", {
		baseUrl: this.getBaseUrl(),
		patch
	});
	const out = await this.fetch("/api/config", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(patch)
	}, { timeoutMs: SETTINGS_MUTATION_TIMEOUT_MS });
	const cloud = out.cloud;
	logSettingsClient("PUT /api/config ← ok", {
		baseUrl: this.getBaseUrl(),
		topKeys: Object.keys(out).sort(),
		cloud: settingsDebugCloudSummary(cloud)
	});
	return out;
};
ElizaClient.prototype.uploadCustomVrm = async function(file) {
	const buf = await file.arrayBuffer();
	await this.fetch("/api/avatar/vrm", {
		method: "POST",
		headers: { "Content-Type": "application/octet-stream" },
		body: buf
	});
};
ElizaClient.prototype.hasCustomVrm = async function() {
	try {
		return (await this.rawRequest("/api/avatar/vrm", { method: "HEAD" }, { allowNonOk: true })).ok;
	} catch {
		return false;
	}
};
ElizaClient.prototype.uploadCustomBackground = async function(file) {
	const buf = await file.arrayBuffer();
	await this.fetch("/api/avatar/background", {
		method: "POST",
		headers: { "Content-Type": "application/octet-stream" },
		body: buf
	});
};
ElizaClient.prototype.hasCustomBackground = async function() {
	try {
		return (await this.rawRequest("/api/avatar/background", { method: "HEAD" }, { allowNonOk: true })).ok;
	} catch {
		return false;
	}
};
ElizaClient.prototype.getConnectors = async function() {
	return this.fetch("/api/connectors");
};
ElizaClient.prototype.saveConnector = async function(name, config) {
	return this.fetch("/api/connectors", {
		method: "POST",
		body: JSON.stringify({
			name,
			config
		})
	});
};
ElizaClient.prototype.deleteConnector = async function(name) {
	return this.fetch(`/api/connectors/${encodeURIComponent(name)}`, { method: "DELETE" });
};
ElizaClient.prototype.getTriggers = async function() {
	return this.fetch("/api/triggers");
};
ElizaClient.prototype.getTrigger = async function(id) {
	return this.fetch(`/api/triggers/${encodeURIComponent(id)}`);
};
ElizaClient.prototype.createTrigger = async function(request) {
	return this.fetch("/api/triggers", {
		method: "POST",
		body: JSON.stringify(request)
	});
};
ElizaClient.prototype.updateTrigger = async function(id, request) {
	return this.fetch(`/api/triggers/${encodeURIComponent(id)}`, {
		method: "PUT",
		body: JSON.stringify(request)
	});
};
ElizaClient.prototype.deleteTrigger = async function(id) {
	return this.fetch(`/api/triggers/${encodeURIComponent(id)}`, { method: "DELETE" });
};
ElizaClient.prototype.runTriggerNow = async function(id) {
	return this.fetch(`/api/triggers/${encodeURIComponent(id)}/execute`, { method: "POST" });
};
ElizaClient.prototype.getTriggerRuns = async function(id) {
	return this.fetch(`/api/triggers/${encodeURIComponent(id)}/runs`);
};
ElizaClient.prototype.emitTriggerEvent = async function(eventKind, payload = {}) {
	return this.fetch(`/api/triggers/events/${encodeURIComponent(eventKind)}`, {
		method: "POST",
		body: JSON.stringify({ payload })
	});
};
ElizaClient.prototype.getTriggerHealth = async function() {
	return this.fetch("/api/triggers/health");
};
ElizaClient.prototype.getTrainingStatus = async function() {
	return this.fetch("/api/training/status");
};
ElizaClient.prototype.listTrainingTrajectories = async function(opts) {
	const params = new URLSearchParams();
	if (typeof opts?.limit === "number") params.set("limit", String(opts.limit));
	if (typeof opts?.offset === "number") params.set("offset", String(opts.offset));
	const qs = params.toString();
	return this.fetch(`/api/training/trajectories${qs ? `?${qs}` : ""}`);
};
ElizaClient.prototype.getTrainingTrajectory = async function(trajectoryId) {
	return this.fetch(`/api/training/trajectories/${encodeURIComponent(trajectoryId)}`);
};
ElizaClient.prototype.listTrainingDatasets = async function() {
	return this.fetch("/api/training/datasets");
};
ElizaClient.prototype.buildTrainingDataset = async function(options) {
	return this.fetch("/api/training/datasets/build", {
		method: "POST",
		body: JSON.stringify(options ?? {})
	});
};
ElizaClient.prototype.listTrainingJobs = async function() {
	return this.fetch("/api/training/jobs");
};
ElizaClient.prototype.startTrainingJob = async function(options) {
	return this.fetch("/api/training/jobs", {
		method: "POST",
		body: JSON.stringify(options ?? {})
	});
};
ElizaClient.prototype.getTrainingJob = async function(jobId) {
	return this.fetch(`/api/training/jobs/${encodeURIComponent(jobId)}`);
};
ElizaClient.prototype.cancelTrainingJob = async function(jobId) {
	return this.fetch(`/api/training/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" });
};
ElizaClient.prototype.listTrainingModels = async function() {
	return this.fetch("/api/training/models");
};
ElizaClient.prototype.importTrainingModelToOllama = async function(modelId, options) {
	return this.fetch(`/api/training/models/${encodeURIComponent(modelId)}/import-ollama`, {
		method: "POST",
		body: JSON.stringify(options ?? {})
	});
};
ElizaClient.prototype.activateTrainingModel = async function(modelId, providerModel) {
	return this.fetch(`/api/training/models/${encodeURIComponent(modelId)}/activate`, {
		method: "POST",
		body: JSON.stringify({ providerModel })
	});
};
ElizaClient.prototype.benchmarkTrainingModel = async function(modelId) {
	return this.fetch(`/api/training/models/${encodeURIComponent(modelId)}/benchmark`, { method: "POST" });
};
ElizaClient.prototype.getPlugins = async function() {
	return this.fetch("/api/plugins");
};
ElizaClient.prototype.fetchModels = async function(provider, refresh = true) {
	const params = new URLSearchParams({ provider });
	if (refresh) params.set("refresh", "true");
	return this.fetch(`/api/models?${params.toString()}`);
};
ElizaClient.prototype.getCorePlugins = async function() {
	return this.fetch("/api/plugins/core");
};
ElizaClient.prototype.toggleCorePlugin = async function(npmName, enabled) {
	return this.fetch("/api/plugins/core/toggle", {
		method: "POST",
		body: JSON.stringify({
			npmName,
			enabled
		})
	});
};
ElizaClient.prototype.updatePlugin = async function(id, config) {
	logSettingsClient(`PUT /api/plugins/${id} → start`, {
		baseUrl: this.getBaseUrl(),
		body: config
	});
	const result = await this.fetch(`/api/plugins/${id}`, {
		method: "PUT",
		body: JSON.stringify(config)
	}, { timeoutMs: SETTINGS_MUTATION_TIMEOUT_MS });
	logSettingsClient(`PUT /api/plugins/${id} ← ok`, {
		baseUrl: this.getBaseUrl(),
		result
	});
	return result;
};
ElizaClient.prototype.getSecrets = async function() {
	return this.fetch("/api/secrets");
};
ElizaClient.prototype.updateSecrets = async function(secrets) {
	logSettingsClient("PUT /api/secrets → start", {
		baseUrl: this.getBaseUrl(),
		secretMeta: Object.keys(secrets).sort().map((key) => ({
			key,
			hasValue: Boolean(secrets[key])
		}))
	});
	const out = await this.fetch("/api/secrets", {
		method: "PUT",
		body: JSON.stringify({ secrets })
	});
	logSettingsClient("PUT /api/secrets ← ok", {
		baseUrl: this.getBaseUrl(),
		out
	});
	return out;
};
ElizaClient.prototype.testPluginConnection = async function(id) {
	return this.fetch(`/api/plugins/${encodeURIComponent(id)}/test`, { method: "POST" });
};
ElizaClient.prototype.getLogs = async function(filter) {
	const params = new URLSearchParams();
	if (filter?.source) params.set("source", filter.source);
	if (filter?.level) params.set("level", filter.level);
	if (filter?.tag) params.set("tag", filter.tag);
	if (filter?.since) params.set("since", String(filter.since));
	const qs = params.toString();
	return this.fetch(`/api/logs${qs ? `?${qs}` : ""}`);
};
function buildSecurityAuditParams(filter, includeStream = false) {
	const params = new URLSearchParams();
	if (filter?.type) params.set("type", filter.type);
	if (filter?.severity) params.set("severity", filter.severity);
	if (filter?.since !== void 0) {
		const sinceValue = filter.since instanceof Date ? filter.since.toISOString() : String(filter.since);
		params.set("since", sinceValue);
	}
	if (filter?.limit !== void 0) params.set("limit", String(filter.limit));
	if (includeStream) params.set("stream", "1");
	return params;
}
ElizaClient.prototype.getSecurityAudit = async function(filter) {
	const qs = buildSecurityAuditParams(filter).toString();
	return this.fetch(`/api/security/audit${qs ? `?${qs}` : ""}`);
};
ElizaClient.prototype.streamSecurityAudit = async function(onEvent, filter, signal) {
	if (!this.apiAvailable) throw new Error("API not available (no HTTP origin)");
	const token = this.apiToken;
	const qs = buildSecurityAuditParams(filter, true).toString();
	const res = await fetch(`${this.baseUrl}/api/security/audit${qs ? `?${qs}` : ""}`, {
		method: "GET",
		headers: {
			Accept: "text/event-stream",
			...token ? { Authorization: `Bearer ${token}` } : {}
		},
		signal
	});
	if (!res.ok) {
		const body = await res.json().catch(() => ({ error: res.statusText }));
		const err = new Error(body?.error ?? `HTTP ${res.status}`);
		err.status = res.status;
		throw err;
	}
	if (!res.body) throw new Error("Streaming not supported by this browser");
	const parsePayload = (payload) => {
		if (!payload) return;
		try {
			const parsed = JSON.parse(payload);
			if (parsed.type === "snapshot" || parsed.type === "entry") onEvent(parsed);
		} catch {}
	};
	const decoder = new TextDecoder();
	const reader = res.body.getReader();
	let buffer = "";
	const findSseEventBreak = (chunkBuffer) => {
		const lfBreak = chunkBuffer.indexOf("\n\n");
		const crlfBreak = chunkBuffer.indexOf("\r\n\r\n");
		if (lfBreak === -1 && crlfBreak === -1) return null;
		if (lfBreak === -1) return {
			index: crlfBreak,
			length: 4
		};
		if (crlfBreak === -1) return {
			index: lfBreak,
			length: 2
		};
		return lfBreak < crlfBreak ? {
			index: lfBreak,
			length: 2
		} : {
			index: crlfBreak,
			length: 4
		};
	};
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let eventBreak = findSseEventBreak(buffer);
		while (eventBreak) {
			const rawEvent = buffer.slice(0, eventBreak.index);
			buffer = buffer.slice(eventBreak.index + eventBreak.length);
			for (const line of rawEvent.split(/\r?\n/)) {
				if (!line.startsWith("data:")) continue;
				parsePayload(line.slice(5).trim());
			}
			eventBreak = findSseEventBreak(buffer);
		}
	}
	if (buffer.trim()) for (const line of buffer.split(/\r?\n/)) {
		if (!line.startsWith("data:")) continue;
		parsePayload(line.slice(5).trim());
	}
};
ElizaClient.prototype.getAgentEvents = async function(opts) {
	const params = new URLSearchParams();
	if (opts?.afterEventId) params.set("after", opts.afterEventId);
	if (typeof opts?.limit === "number") params.set("limit", String(opts.limit));
	if (opts?.runId) params.set("runId", opts.runId);
	if (typeof opts?.fromSeq === "number") params.set("fromSeq", String(Math.trunc(opts.fromSeq)));
	const qs = params.toString();
	return this.fetch(`/api/agent/events${qs ? `?${qs}` : ""}`);
};
ElizaClient.prototype.getExtensionStatus = async function() {
	return this.fetch("/api/extension/status");
};
ElizaClient.prototype.getRelationshipsGraph = async function(query) {
	const params = new URLSearchParams();
	if (query?.search) params.set("search", query.search);
	if (query?.platform) params.set("platform", query.platform);
	if (query?.scope) params.set("scope", query.scope);
	if (typeof query?.limit === "number") params.set("limit", String(query.limit));
	if (typeof query?.offset === "number") params.set("offset", String(query.offset));
	const qs = params.toString();
	return (await this.fetch(`/api/relationships/graph${qs ? `?${qs}` : ""}`)).data;
};
ElizaClient.prototype.getRelationshipsPeople = async function(query) {
	const params = new URLSearchParams();
	if (query?.search) params.set("search", query.search);
	if (query?.platform) params.set("platform", query.platform);
	if (query?.scope) params.set("scope", query.scope);
	if (typeof query?.limit === "number") params.set("limit", String(query.limit));
	if (typeof query?.offset === "number") params.set("offset", String(query.offset));
	const qs = params.toString();
	const response = await this.fetch(`/api/relationships/people${qs ? `?${qs}` : ""}`);
	return {
		people: response.data,
		stats: response.stats
	};
};
ElizaClient.prototype.getRelationshipsPerson = async function(id) {
	return (await this.fetch(`/api/relationships/people/${encodeURIComponent(id)}`)).data;
};
ElizaClient.prototype.getRelationshipsActivity = async function(limit, offset) {
	const params = new URLSearchParams();
	if (typeof limit === "number") params.set("limit", String(limit));
	if (typeof offset === "number") params.set("offset", String(offset));
	const qs = params.toString();
	return this.fetch(`/api/relationships/activity${qs ? `?${qs}` : ""}`);
};
ElizaClient.prototype.getRelationshipsCandidates = async function() {
	return (await this.fetch("/api/relationships/candidates")).data;
};
ElizaClient.prototype.acceptRelationshipsCandidate = async function(candidateId) {
	return (await this.fetch(`/api/relationships/candidates/${encodeURIComponent(candidateId)}/accept`, { method: "POST" })).data;
};
ElizaClient.prototype.rejectRelationshipsCandidate = async function(candidateId) {
	return (await this.fetch(`/api/relationships/candidates/${encodeURIComponent(candidateId)}/reject`, { method: "POST" })).data;
};
ElizaClient.prototype.proposeRelationshipsLink = async function(sourceEntityId, targetEntityId, evidence) {
	return (await this.fetch(`/api/relationships/people/${encodeURIComponent(sourceEntityId)}/link`, {
		method: "POST",
		body: JSON.stringify({
			targetEntityId,
			evidence: evidence ?? {}
		}),
		headers: { "Content-Type": "application/json" }
	})).data;
};
ElizaClient.prototype.getCharacter = async function() {
	return this.fetch("/api/character");
};
ElizaClient.prototype.getRandomName = async function() {
	return this.fetch("/api/character/random-name");
};
ElizaClient.prototype.generateCharacterField = async function(field, context, mode) {
	return this.fetch("/api/character/generate", {
		method: "POST",
		body: JSON.stringify({
			field,
			context,
			mode
		})
	});
};
ElizaClient.prototype.updateCharacter = async function(character) {
	return this.fetch("/api/character", {
		method: "PUT",
		body: JSON.stringify(character)
	});
};
ElizaClient.prototype.listCharacterHistory = async function(options) {
	const params = new URLSearchParams();
	if (typeof options?.limit === "number") params.set("limit", String(options.limit));
	if (typeof options?.offset === "number") params.set("offset", String(options.offset));
	const qs = params.toString();
	return this.fetch(`/api/character/history${qs ? `?${qs}` : ""}`);
};
ElizaClient.prototype.listExperiences = async function(options) {
	const params = new URLSearchParams();
	const appendMulti = (key, value) => {
		if (Array.isArray(value)) {
			value.map((item) => item.trim()).filter(Boolean).forEach((item) => {
				params.append(key, item);
			});
			return;
		}
		if (typeof value === "string" && value.trim()) params.append(key, value.trim());
	};
	if (typeof options?.limit === "number") params.set("limit", String(options.limit));
	if (typeof options?.offset === "number") params.set("offset", String(options.offset));
	if (typeof options?.q === "string" && options.q.trim()) params.set("q", options.q.trim());
	if (typeof options?.query === "string" && options.query.trim()) params.set("query", options.query.trim());
	if (typeof options?.minConfidence === "number") params.set("minConfidence", String(options.minConfidence));
	if (typeof options?.minImportance === "number") params.set("minImportance", String(options.minImportance));
	if (typeof options?.includeRelated === "boolean") params.set("includeRelated", String(options.includeRelated));
	appendMulti("type", options?.type);
	appendMulti("outcome", options?.outcome);
	appendMulti("domain", options?.domain);
	options?.tags?.map((tag) => tag.trim()).filter(Boolean).forEach((tag) => {
		params.append("tag", tag);
	});
	const qs = params.toString();
	const response = await this.fetch(`/api/character/experiences${qs ? `?${qs}` : ""}`);
	return {
		experiences: response.data,
		total: response.total
	};
};
ElizaClient.prototype.getExperienceGraph = async function(options) {
	const params = new URLSearchParams();
	const appendMulti = (key, value) => {
		if (Array.isArray(value)) {
			value.map((item) => item.trim()).filter(Boolean).forEach((item) => {
				params.append(key, item);
			});
			return;
		}
		if (typeof value === "string" && value.trim()) params.append(key, value.trim());
	};
	if (typeof options?.limit === "number") params.set("limit", String(options.limit));
	if (typeof options?.q === "string" && options.q.trim()) params.set("q", options.q.trim());
	if (typeof options?.query === "string" && options.query.trim()) params.set("query", options.query.trim());
	if (typeof options?.minConfidence === "number") params.set("minConfidence", String(options.minConfidence));
	if (typeof options?.minImportance === "number") params.set("minImportance", String(options.minImportance));
	if (typeof options?.includeRelated === "boolean") params.set("includeRelated", String(options.includeRelated));
	appendMulti("type", options?.type);
	appendMulti("outcome", options?.outcome);
	appendMulti("domain", options?.domain);
	options?.tags?.map((tag) => tag.trim()).filter(Boolean).forEach((tag) => {
		params.append("tag", tag);
	});
	const qs = params.toString();
	return { graph: (await this.fetch(`/api/character/experiences/graph${qs ? `?${qs}` : ""}`)).data };
};
ElizaClient.prototype.runExperienceMaintenance = async function(options) {
	return { result: (await this.fetch("/api/character/experiences/maintenance", {
		method: "POST",
		body: JSON.stringify(options ?? {})
	})).data };
};
ElizaClient.prototype.getExperience = async function(id) {
	return { experience: (await this.fetch(`/api/character/experiences/${encodeURIComponent(id)}`)).data };
};
ElizaClient.prototype.updateExperience = async function(id, data) {
	return { experience: (await this.fetch(`/api/character/experiences/${encodeURIComponent(id)}`, {
		method: "PATCH",
		body: JSON.stringify(data)
	})).data };
};
ElizaClient.prototype.deleteExperience = async function(id) {
	return this.fetch(`/api/character/experiences/${encodeURIComponent(id)}`, { method: "DELETE" });
};
ElizaClient.prototype.getUpdateStatus = async function(force = false) {
	return this.fetch(`/api/update/status${force ? "?force=true" : ""}`);
};
ElizaClient.prototype.setUpdateChannel = async function(channel) {
	return this.fetch("/api/update/channel", {
		method: "PUT",
		body: JSON.stringify({ channel })
	});
};
ElizaClient.prototype.getAgentAutomationMode = async function() {
	return this.fetch("/api/permissions/automation-mode");
};
ElizaClient.prototype.setAgentAutomationMode = async function(mode) {
	return this.fetch("/api/permissions/automation-mode", {
		method: "PUT",
		body: JSON.stringify({ mode })
	});
};
ElizaClient.prototype.getTradePermissionMode = async function() {
	return this.fetch("/api/permissions/trade-mode");
};
ElizaClient.prototype.setTradePermissionMode = async function(mode) {
	return this.fetch("/api/permissions/trade-mode", {
		method: "PUT",
		body: JSON.stringify({ mode })
	});
};
ElizaClient.prototype.getPermissions = async function() {
	const permissions = await this.fetch("/api/permissions");
	const plugin = getNativeWebsiteBlockerPluginIfAvailable();
	if (!plugin) return permissions;
	const permission = mapWebsiteBlockerStatusToPermission(await plugin.getStatus());
	return {
		...permissions,
		[WEBSITE_BLOCKING_PERMISSION_ID]: permission
	};
};
ElizaClient.prototype.getPermission = async function(id) {
	if (id === WEBSITE_BLOCKING_PERMISSION_ID) {
		const plugin = getNativeWebsiteBlockerPluginIfAvailable();
		if (plugin) return mapWebsiteBlockerStatusToPermission(await plugin.getStatus());
	}
	return this.fetch(`/api/permissions/${id}`);
};
ElizaClient.prototype.requestPermission = async function(id) {
	if (id === WEBSITE_BLOCKING_PERMISSION_ID) {
		const plugin = getNativeWebsiteBlockerPluginIfAvailable();
		if (plugin) return mapWebsiteBlockerPermissionResult(await plugin.requestPermissions());
	}
	return this.fetch(`/api/permissions/${id}/request`, { method: "POST" });
};
ElizaClient.prototype.openPermissionSettings = async function(id) {
	if (id === WEBSITE_BLOCKING_PERMISSION_ID) {
		const plugin = getNativeWebsiteBlockerPluginIfAvailable();
		if (plugin) {
			await plugin.openSettings();
			return;
		}
	}
	await this.fetch(`/api/permissions/${id}/open-settings`, { method: "POST" });
};
ElizaClient.prototype.refreshPermissions = async function() {
	const permissions = await this.fetch("/api/permissions/refresh", { method: "POST" });
	const plugin = getNativeWebsiteBlockerPluginIfAvailable();
	if (!plugin) return permissions;
	const permission = mapWebsiteBlockerStatusToPermission(await plugin.getStatus());
	return {
		...permissions,
		[WEBSITE_BLOCKING_PERMISSION_ID]: permission
	};
};
ElizaClient.prototype.setShellEnabled = async function(enabled) {
	return this.fetch("/api/permissions/shell", {
		method: "PUT",
		body: JSON.stringify({ enabled })
	});
};
ElizaClient.prototype.isShellEnabled = async function() {
	return (await this.fetch("/api/permissions/shell")).enabled;
};
ElizaClient.prototype.getWebsiteBlockerStatus = async function() {
	const plugin = getNativeWebsiteBlockerPluginIfAvailable();
	if (plugin) return await plugin.getStatus();
	return this.fetch("/api/website-blocker");
};
ElizaClient.prototype.startWebsiteBlock = async function(options) {
	const plugin = getNativeWebsiteBlockerPluginIfAvailable();
	if (plugin) return await plugin.startBlock(options);
	return this.fetch("/api/website-blocker", {
		method: "PUT",
		body: JSON.stringify(options)
	});
};
ElizaClient.prototype.stopWebsiteBlock = async function() {
	const plugin = getNativeWebsiteBlockerPluginIfAvailable();
	if (plugin) return await plugin.stopBlock();
	return this.fetch("/api/website-blocker", { method: "DELETE" });
};
ElizaClient.prototype.getAppBlockerStatus = async function() {
	const plugin = getNativeAppBlockerPluginIfAvailable();
	if (plugin) return await plugin.getStatus();
	return {
		available: false,
		active: false,
		platform: "web",
		engine: "none",
		blockedCount: 0,
		blockedPackageNames: [],
		endsAt: null,
		permissionStatus: "not-applicable",
		reason: "App blocking is only available on iPhone and Android builds."
	};
};
ElizaClient.prototype.checkAppBlockerPermissions = async function() {
	const plugin = getNativeAppBlockerPluginIfAvailable();
	if (plugin) return await plugin.checkPermissions();
	return {
		status: "not-applicable",
		canRequest: false,
		reason: "App blocking is only available on iPhone and Android builds."
	};
};
ElizaClient.prototype.requestAppBlockerPermissions = async function() {
	const plugin = getNativeAppBlockerPluginIfAvailable();
	if (plugin) return await plugin.requestPermissions();
	return {
		status: "not-applicable",
		canRequest: false,
		reason: "App blocking is only available on iPhone and Android builds."
	};
};
ElizaClient.prototype.getInstalledAppsToBlock = async function() {
	const plugin = getNativeAppBlockerPluginIfAvailable();
	if (plugin) return await plugin.getInstalledApps();
	return { apps: [] };
};
ElizaClient.prototype.selectAppBlockerApps = async function() {
	const plugin = getNativeAppBlockerPluginIfAvailable();
	if (plugin) return await plugin.selectApps();
	return {
		apps: [],
		cancelled: true
	};
};
ElizaClient.prototype.startAppBlock = async function(options) {
	const plugin = getNativeAppBlockerPluginIfAvailable();
	if (plugin) return await plugin.blockApps(options);
	return {
		success: false,
		endsAt: null,
		blockedCount: 0,
		error: "App blocking is only available on iPhone and Android builds."
	};
};
ElizaClient.prototype.stopAppBlock = async function() {
	const plugin = getNativeAppBlockerPluginIfAvailable();
	if (plugin) return await plugin.unblockApps();
	return {
		success: false,
		error: "App blocking is only available on iPhone and Android builds."
	};
};
ElizaClient.prototype.getCodingAgentStatus = async function() {
	try {
		const status = await this.fetch("/api/coding-agents/coordinator/status");
		if (status && status.tasks.length === 0 && Array.isArray(status.taskThreads) && status.taskThreads.length > 0) {
			status.tasks = mapTaskThreadsToCodingAgentSessions(status.taskThreads).filter((task) => !TERMINAL_STATUSES.has(task.status));
			status.taskCount = status.tasks.length;
		}
		if (status && !status.tasks) try {
			const ptySessions = await this.fetch("/api/coding-agents");
			if (Array.isArray(ptySessions) && ptySessions.length > 0) {
				status.tasks = mapPtySessionsToCodingAgentSessions(ptySessions);
				status.taskCount = status.tasks.length;
			}
		} catch {}
		return status;
	} catch {
		return null;
	}
};
ElizaClient.prototype.listCodingAgentTaskThreads = function(options) {
	const params = new URLSearchParams();
	if (options?.includeArchived) params.set("includeArchived", "true");
	if (options?.status) params.set("status", options.status);
	if (options?.search) params.set("search", options.search);
	if (typeof options?.limit === "number" && options.limit > 0) params.set("limit", String(options.limit));
	const query = params.toString();
	return this.fetch(`/api/coding-agents/coordinator/threads${query ? `?${query}` : ""}`);
};
ElizaClient.prototype.getCodingAgentTaskThread = function(threadId) {
	return this.fetch(`/api/coding-agents/coordinator/threads/${encodeURIComponent(threadId)}`);
};
ElizaClient.prototype.archiveCodingAgentTaskThread = async function(threadId) {
	await this.fetch(`/api/coding-agents/coordinator/threads/${encodeURIComponent(threadId)}/archive`, { method: "POST" });
	return true;
};
ElizaClient.prototype.reopenCodingAgentTaskThread = async function(threadId) {
	await this.fetch(`/api/coding-agents/coordinator/threads/${encodeURIComponent(threadId)}/reopen`, { method: "POST" });
	return true;
};
ElizaClient.prototype.stopCodingAgent = async function(sessionId) {
	try {
		await this.fetch(`/api/coding-agents/${encodeURIComponent(sessionId)}/stop`, { method: "POST" });
		return true;
	} catch {
		return false;
	}
};
ElizaClient.prototype.listCodingAgentScratchWorkspaces = async function() {
	try {
		return await this.fetch("/api/coding-agents/scratch");
	} catch (err) {
		console.warn("[api-client] Failed to list coding agent scratch workspaces:", err);
		return [];
	}
};
ElizaClient.prototype.keepCodingAgentScratchWorkspace = async function(sessionId) {
	try {
		await this.fetch(`/api/coding-agents/${encodeURIComponent(sessionId)}/scratch/keep`, { method: "POST" });
		return true;
	} catch {
		return false;
	}
};
ElizaClient.prototype.deleteCodingAgentScratchWorkspace = async function(sessionId) {
	try {
		await this.fetch(`/api/coding-agents/${encodeURIComponent(sessionId)}/scratch/delete`, { method: "POST" });
		return true;
	} catch {
		return false;
	}
};
ElizaClient.prototype.promoteCodingAgentScratchWorkspace = async function(sessionId, name) {
	try {
		return (await this.fetch(`/api/coding-agents/${encodeURIComponent(sessionId)}/scratch/promote`, {
			method: "POST",
			body: JSON.stringify(name ? { name } : {})
		})).scratch ?? null;
	} catch {
		return null;
	}
};
ElizaClient.prototype.spawnShellSession = async function(workdir) {
	return { sessionId: (await this.fetch("/api/coding-agents/spawn", {
		method: "POST",
		body: JSON.stringify({
			agentType: "shell",
			...workdir ? { workdir } : {}
		})
	})).sessionId };
};
ElizaClient.prototype.subscribePtyOutput = function(sessionId) {
	this.sendWsMessage({
		type: "pty-subscribe",
		sessionId
	});
};
ElizaClient.prototype.unsubscribePtyOutput = function(sessionId) {
	this.sendWsMessage({
		type: "pty-unsubscribe",
		sessionId
	});
};
ElizaClient.prototype.sendPtyInput = function(sessionId, data) {
	this.sendWsMessage({
		type: "pty-input",
		sessionId,
		data
	});
};
ElizaClient.prototype.resizePty = function(sessionId, cols, rows) {
	this.sendWsMessage({
		type: "pty-resize",
		sessionId,
		cols,
		rows
	});
};
ElizaClient.prototype.getPtyBufferedOutput = async function(sessionId) {
	try {
		return (await this.fetch(`/api/coding-agents/${encodeURIComponent(sessionId)}/buffered-output`)).output ?? "";
	} catch {
		return "";
	}
};
ElizaClient.prototype.streamGoLive = async function() {
	return this.fetch("/api/stream/live", { method: "POST" });
};
ElizaClient.prototype.streamGoOffline = async function() {
	return this.fetch("/api/stream/offline", { method: "POST" });
};
ElizaClient.prototype.streamStatus = async function() {
	return this.fetch("/api/stream/status");
};
ElizaClient.prototype.getStreamingDestinations = async function() {
	return this.fetch("/api/streaming/destinations");
};
ElizaClient.prototype.setActiveDestination = async function(destinationId) {
	return this.fetch("/api/streaming/destination", {
		method: "POST",
		body: JSON.stringify({ destinationId })
	});
};
ElizaClient.prototype.setStreamVolume = async function(volume) {
	return this.fetch("/api/stream/volume", {
		method: "POST",
		body: JSON.stringify({ volume })
	});
};
ElizaClient.prototype.muteStream = async function() {
	return this.fetch("/api/stream/mute", { method: "POST" });
};
ElizaClient.prototype.unmuteStream = async function() {
	return this.fetch("/api/stream/unmute", { method: "POST" });
};
ElizaClient.prototype.getStreamVoice = async function() {
	return this.fetch("/api/stream/voice");
};
ElizaClient.prototype.saveStreamVoice = async function(settings) {
	return this.fetch("/api/stream/voice", {
		method: "POST",
		body: JSON.stringify(settings)
	});
};
ElizaClient.prototype.streamVoiceSpeak = async function(text) {
	return this.fetch("/api/stream/voice/speak", {
		method: "POST",
		body: JSON.stringify({ text })
	});
};
ElizaClient.prototype.getOverlayLayout = async function(destinationId) {
	const qs = destinationId ? `?destination=${encodeURIComponent(destinationId)}` : "";
	return this.fetch(`/api/stream/overlay-layout${qs}`);
};
ElizaClient.prototype.saveOverlayLayout = async function(layout, destinationId) {
	const qs = destinationId ? `?destination=${encodeURIComponent(destinationId)}` : "";
	return this.fetch(`/api/stream/overlay-layout${qs}`, {
		method: "POST",
		body: JSON.stringify({ layout })
	});
};
ElizaClient.prototype.getStreamSource = async function() {
	return this.fetch("/api/stream/source");
};
ElizaClient.prototype.setStreamSource = async function(sourceType, customUrl) {
	return this.fetch("/api/stream/source", {
		method: "POST",
		body: JSON.stringify({
			sourceType,
			customUrl
		})
	});
};
ElizaClient.prototype.getStreamSettings = async function() {
	return this.fetch("/api/stream/settings");
};
ElizaClient.prototype.saveStreamSettings = async function(settings) {
	return this.fetch("/api/stream/settings", {
		method: "POST",
		body: JSON.stringify({ settings })
	});
};
ElizaClient.prototype.listAccounts = async function() {
	return this.fetch("/api/accounts");
};
ElizaClient.prototype.createApiKeyAccount = async function(providerId, body) {
	return this.fetch(`/api/accounts/${encodeURIComponent(providerId)}`, {
		method: "POST",
		body: JSON.stringify({
			source: "api-key",
			...body
		})
	});
};
ElizaClient.prototype.patchAccount = async function(providerId, accountId, body) {
	return this.fetch(`/api/accounts/${encodeURIComponent(providerId)}/${encodeURIComponent(accountId)}`, {
		method: "PATCH",
		body: JSON.stringify(body)
	});
};
ElizaClient.prototype.deleteAccount = async function(providerId, accountId) {
	return this.fetch(`/api/accounts/${encodeURIComponent(providerId)}/${encodeURIComponent(accountId)}`, { method: "DELETE" });
};
ElizaClient.prototype.testAccount = async function(providerId, accountId) {
	return this.fetch(`/api/accounts/${encodeURIComponent(providerId)}/${encodeURIComponent(accountId)}/test`, { method: "POST" });
};
ElizaClient.prototype.refreshAccountUsage = async function(providerId, accountId) {
	return this.fetch(`/api/accounts/${encodeURIComponent(providerId)}/${encodeURIComponent(accountId)}/refresh-usage`, { method: "POST" });
};
ElizaClient.prototype.startAccountOAuth = async function(providerId, body) {
	return this.fetch(`/api/accounts/${encodeURIComponent(providerId)}/oauth/start`, {
		method: "POST",
		body: JSON.stringify(body)
	});
};
ElizaClient.prototype.submitAccountOAuthCode = async function(providerId, body) {
	return this.fetch(`/api/accounts/${encodeURIComponent(providerId)}/oauth/submit-code`, {
		method: "POST",
		body: JSON.stringify(body)
	});
};
ElizaClient.prototype.cancelAccountOAuth = async function(providerId, body) {
	return this.fetch(`/api/accounts/${encodeURIComponent(providerId)}/oauth/cancel`, {
		method: "POST",
		body: JSON.stringify(body)
	});
};
ElizaClient.prototype.patchProviderStrategy = async function(providerId, body) {
	return this.fetch(`/api/providers/${encodeURIComponent(providerId)}/strategy`, {
		method: "PATCH",
		body: JSON.stringify(body)
	});
};

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/client-automations.js
ElizaClient.prototype.listAutomations = async function() {
	return this.fetch("/api/automations");
};
ElizaClient.prototype.getAutomationNodeCatalog = async function() {
	return this.fetch("/api/automations/nodes");
};

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/client-browser-workspace.js
async function requestDesktopBrowserWorkspace(options) {
	if (!isElectrobunRuntime()) return null;
	return invokeDesktopBridgeRequest(options);
}
ElizaClient.prototype.getBrowserWorkspace = async function() {
	const bridged = await requestDesktopBrowserWorkspace({
		rpcMethod: "browserWorkspaceGetSnapshot",
		ipcChannel: "browser-workspace:getSnapshot"
	});
	if (bridged) return bridged;
	return this.fetch("/api/browser-workspace");
};
ElizaClient.prototype.openBrowserWorkspaceTab = async function(request) {
	const bridged = await requestDesktopBrowserWorkspace({
		rpcMethod: "browserWorkspaceOpenTab",
		ipcChannel: "browser-workspace:openTab",
		params: request
	});
	if (bridged) return bridged;
	return this.fetch("/api/browser-workspace/tabs", {
		method: "POST",
		body: JSON.stringify(request)
	});
};
ElizaClient.prototype.navigateBrowserWorkspaceTab = async function(id, url) {
	const bridged = await requestDesktopBrowserWorkspace({
		rpcMethod: "browserWorkspaceNavigateTab",
		ipcChannel: "browser-workspace:navigateTab",
		params: {
			id,
			url
		}
	});
	if (bridged) return bridged;
	return this.fetch(`/api/browser-workspace/tabs/${encodeURIComponent(id)}/navigate`, {
		method: "POST",
		body: JSON.stringify({ url })
	});
};
ElizaClient.prototype.showBrowserWorkspaceTab = async function(id) {
	const bridged = await requestDesktopBrowserWorkspace({
		rpcMethod: "browserWorkspaceShowTab",
		ipcChannel: "browser-workspace:showTab",
		params: { id }
	});
	if (bridged) return bridged;
	return this.fetch(`/api/browser-workspace/tabs/${encodeURIComponent(id)}/show`, { method: "POST" });
};
ElizaClient.prototype.hideBrowserWorkspaceTab = async function(id) {
	const bridged = await requestDesktopBrowserWorkspace({
		rpcMethod: "browserWorkspaceHideTab",
		ipcChannel: "browser-workspace:hideTab",
		params: { id }
	});
	if (bridged) return bridged;
	return this.fetch(`/api/browser-workspace/tabs/${encodeURIComponent(id)}/hide`, { method: "POST" });
};
ElizaClient.prototype.closeBrowserWorkspaceTab = async function(id) {
	const bridged = await requestDesktopBrowserWorkspace({
		rpcMethod: "browserWorkspaceCloseTab",
		ipcChannel: "browser-workspace:closeTab",
		params: { id }
	});
	if (bridged) return bridged;
	return this.fetch(`/api/browser-workspace/tabs/${encodeURIComponent(id)}`, { method: "DELETE" });
};
ElizaClient.prototype.snapshotBrowserWorkspaceTab = async function(id) {
	const bridged = await requestDesktopBrowserWorkspace({
		rpcMethod: "browserWorkspaceSnapshotTab",
		ipcChannel: "browser-workspace:snapshotTab",
		params: { id }
	});
	if (bridged) return bridged;
	return this.fetch(`/api/browser-workspace/tabs/${encodeURIComponent(id)}/snapshot`);
};

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/client-chat.js
/**
* Chat domain methods — chat, conversations, knowledge, memory, MCP,
* share ingest, workbench, trajectories, database.
*/
const LEGACY_CHAT_COMPAT_TITLE = "Quick Chat";
const LEGACY_CHAT_CONVERSATION_STORAGE_PREFIX = "legacy_chat_conversation";
function getLegacyChatConversationStorageKey(client) {
	const base = client.getBaseUrl() || (typeof window !== "undefined" ? window.location.origin : "same-origin");
	return `${LEGACY_CHAT_CONVERSATION_STORAGE_PREFIX}:${encodeURIComponent(base)}`;
}
function readLegacyChatConversationId(client) {
	if (typeof window === "undefined") return null;
	const stored = window.sessionStorage.getItem(getLegacyChatConversationStorageKey(client));
	return stored?.trim() ? stored.trim() : null;
}
function writeLegacyChatConversationId(client, conversationId) {
	if (typeof window === "undefined") return;
	const key = getLegacyChatConversationStorageKey(client);
	if (conversationId?.trim()) {
		window.sessionStorage.setItem(key, conversationId.trim());
		return;
	}
	window.sessionStorage.removeItem(key);
}
async function ensureLegacyChatConversationId(client) {
	const cached = readLegacyChatConversationId(client);
	if (cached) return cached;
	const { conversation } = await client.createConversation(LEGACY_CHAT_COMPAT_TITLE);
	writeLegacyChatConversationId(client, conversation.id);
	return conversation.id;
}
ElizaClient.prototype.sendChatRest = async function(text, channelType = "DM", conversationMode) {
	const sendToConversation = async (conversationId) => this.sendConversationMessage(conversationId, text, channelType, void 0, conversationMode);
	const conversationId = await ensureLegacyChatConversationId(this);
	try {
		return await sendToConversation(conversationId);
	} catch (error) {
		if (error instanceof Error && error.name === "ApiError" && error.status === 404) {
			writeLegacyChatConversationId(this, null);
			return sendToConversation(await ensureLegacyChatConversationId(this));
		}
		throw error;
	}
};
ElizaClient.prototype.sendChatStream = async function(text, onToken, channelType = "DM", signal, conversationMode) {
	const streamConversation = async (conversationId) => this.sendConversationMessageStream(conversationId, text, onToken, channelType, signal, void 0, conversationMode);
	const conversationId = await ensureLegacyChatConversationId(this);
	try {
		return await streamConversation(conversationId);
	} catch (error) {
		if (error instanceof Error && error.name === "ApiError" && error.status === 404) {
			writeLegacyChatConversationId(this, null);
			return streamConversation(await ensureLegacyChatConversationId(this));
		}
		throw error;
	}
};
ElizaClient.prototype.listConversations = async function() {
	return this.fetch("/api/conversations");
};
ElizaClient.prototype.createConversation = async function(title, options) {
	const response = await this.fetch("/api/conversations", {
		method: "POST",
		body: JSON.stringify({
			title,
			...options?.includeGreeting === true || options?.bootstrapGreeting === true ? { includeGreeting: true } : {},
			...typeof options?.lang === "string" && options.lang.trim() ? { lang: options.lang.trim() } : {},
			...options?.metadata ? { metadata: options.metadata } : {}
		})
	});
	if (!response.greeting) return response;
	return {
		...response,
		greeting: {
			...response.greeting,
			text: this.normalizeGreetingText(response.greeting.text)
		}
	};
};
ElizaClient.prototype.getConversationMessages = async function(id) {
	return { messages: (await this.fetch(`/api/conversations/${encodeURIComponent(id)}/messages`)).messages.map((message) => {
		if (message.role !== "assistant") return message;
		const text = this.normalizeAssistantText(message.text);
		return text === message.text ? message : {
			...message,
			text
		};
	}) };
};
ElizaClient.prototype.getInboxMessages = async function(options) {
	const params = new URLSearchParams();
	if (typeof options?.limit === "number" && options.limit > 0) params.set("limit", String(options.limit));
	if (options?.sources && options.sources.length > 0) params.set("sources", options.sources.join(","));
	if (typeof options?.roomId === "string" && options.roomId.length > 0) params.set("roomId", options.roomId);
	if (typeof options?.roomSource === "string" && options.roomSource.length > 0) params.set("roomSource", options.roomSource);
	const query = params.toString();
	const path = query ? `/api/inbox/messages?${query}` : "/api/inbox/messages";
	return this.fetch(path);
};
ElizaClient.prototype.getInboxSources = async function() {
	return this.fetch("/api/inbox/sources");
};
ElizaClient.prototype.getInboxChats = async function(options) {
	const params = new URLSearchParams();
	if (options?.sources && options.sources.length > 0) params.set("sources", options.sources.join(","));
	const query = params.toString();
	const path = query ? `/api/inbox/chats?${query}` : "/api/inbox/chats";
	return this.fetch(path);
};
ElizaClient.prototype.sendInboxMessage = async function(data) {
	return this.fetch("/api/inbox/messages", {
		method: "POST",
		body: JSON.stringify(data)
	});
};
ElizaClient.prototype.truncateConversationMessages = async function(id, messageId, options) {
	return this.fetch(`/api/conversations/${encodeURIComponent(id)}/messages/truncate`, {
		method: "POST",
		body: JSON.stringify({
			messageId,
			inclusive: options?.inclusive === true
		})
	});
};
ElizaClient.prototype.sendConversationMessage = async function(id, text, channelType = "DM", images, conversationMode, metadata) {
	const response = await this.fetch(`/api/conversations/${encodeURIComponent(id)}/messages`, {
		method: "POST",
		body: JSON.stringify({
			text,
			channelType,
			...images?.length ? { images } : {},
			...conversationMode ? { conversationMode } : {},
			...metadata ? { metadata } : {}
		})
	});
	return {
		...response,
		text: response.noResponseReason === "ignored" ? "" : this.normalizeAssistantText(response.text)
	};
};
ElizaClient.prototype.sendConversationMessageStream = async function(id, text, onToken, channelType = "DM", signal, images, conversationMode, metadata) {
	return this.streamChatEndpoint(`/api/conversations/${encodeURIComponent(id)}/messages/stream`, text, onToken, channelType, signal, images, conversationMode, metadata);
};
ElizaClient.prototype.requestGreeting = async function(id, lang) {
	const qs = lang ? `?lang=${encodeURIComponent(lang)}` : "";
	const response = await this.fetch(`/api/conversations/${encodeURIComponent(id)}/greeting${qs}`, { method: "POST" });
	return {
		...response,
		text: this.normalizeGreetingText(response.text)
	};
};
ElizaClient.prototype.renameConversation = async function(id, title, options) {
	return this.updateConversation(id, {
		title,
		generate: options?.generate
	});
};
ElizaClient.prototype.updateConversation = async function(id, data) {
	return this.fetch(`/api/conversations/${encodeURIComponent(id)}`, {
		method: "PATCH",
		body: JSON.stringify({
			...typeof data?.title === "string" ? { title: data.title } : {},
			...typeof data?.generate === "boolean" ? { generate: data.generate } : {},
			...data && "metadata" in data ? { metadata: data.metadata } : {}
		})
	});
};
ElizaClient.prototype.deleteConversation = async function(id) {
	return this.fetch(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
};
ElizaClient.prototype.cleanupEmptyConversations = async function(options) {
	return this.fetch("/api/conversations/cleanup-empty", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ ...options?.keepId ? { keepId: options.keepId } : {} })
	});
};
ElizaClient.prototype.getKnowledgeStats = async function() {
	return this.fetch("/api/knowledge/stats");
};
ElizaClient.prototype.listKnowledgeDocuments = async function(options) {
	const params = new URLSearchParams();
	if (options?.limit) params.set("limit", String(options.limit));
	if (options?.offset) params.set("offset", String(options.offset));
	const query = params.toString();
	return this.fetch(`/api/knowledge/documents${query ? `?${query}` : ""}`);
};
ElizaClient.prototype.getKnowledgeDocument = async function(documentId) {
	return this.fetch(`/api/knowledge/documents/${encodeURIComponent(documentId)}`);
};
ElizaClient.prototype.updateKnowledgeDocument = async function(documentId, data) {
	return this.fetch(`/api/knowledge/documents/${encodeURIComponent(documentId)}`, {
		method: "PATCH",
		body: JSON.stringify(data)
	});
};
ElizaClient.prototype.deleteKnowledgeDocument = async function(documentId) {
	return this.fetch(`/api/knowledge/documents/${encodeURIComponent(documentId)}`, { method: "DELETE" });
};
ElizaClient.prototype.uploadKnowledgeDocument = async function(data) {
	return this.fetch("/api/knowledge/documents", {
		method: "POST",
		body: JSON.stringify(data)
	});
};
ElizaClient.prototype.uploadKnowledgeDocumentsBulk = async function(data) {
	return this.fetch("/api/knowledge/documents/bulk", {
		method: "POST",
		body: JSON.stringify(data)
	});
};
ElizaClient.prototype.uploadKnowledgeFromUrl = async function(url, metadata) {
	return this.fetch("/api/knowledge/documents/url", {
		method: "POST",
		body: JSON.stringify({
			url,
			metadata
		})
	});
};
ElizaClient.prototype.searchKnowledge = async function(query, options) {
	const params = new URLSearchParams({ q: query });
	if (options?.threshold !== void 0) params.set("threshold", String(options.threshold));
	if (options?.limit !== void 0) params.set("limit", String(options.limit));
	return this.fetch(`/api/knowledge/search?${params}`);
};
ElizaClient.prototype.getKnowledgeFragments = async function(documentId) {
	return this.fetch(`/api/knowledge/fragments/${encodeURIComponent(documentId)}`);
};
ElizaClient.prototype.listScratchpadTopics = async function() {
	return this.fetch("/api/knowledge/scratchpad/topics");
};
ElizaClient.prototype.createScratchpadTopic = async function(data) {
	return this.fetch("/api/knowledge/scratchpad/topics", {
		method: "POST",
		body: JSON.stringify(data)
	});
};
ElizaClient.prototype.getScratchpadTopic = async function(topicId) {
	return this.fetch(`/api/knowledge/scratchpad/topics/${encodeURIComponent(topicId)}`);
};
ElizaClient.prototype.replaceScratchpadTopic = async function(topicId, data) {
	return this.fetch(`/api/knowledge/scratchpad/topics/${encodeURIComponent(topicId)}`, {
		method: "PUT",
		body: JSON.stringify(data)
	});
};
ElizaClient.prototype.deleteScratchpadTopic = async function(topicId) {
	return this.fetch(`/api/knowledge/scratchpad/topics/${encodeURIComponent(topicId)}`, { method: "DELETE" });
};
ElizaClient.prototype.searchScratchpadTopics = async function(query, options) {
	const params = new URLSearchParams({ q: query });
	if (options?.limit !== void 0) params.set("limit", String(options.limit));
	return this.fetch(`/api/knowledge/scratchpad/search?${params}`);
};
ElizaClient.prototype.previewScratchpadSummary = async function(data) {
	return this.fetch("/api/knowledge/scratchpad/summary-preview", {
		method: "POST",
		body: JSON.stringify(data)
	});
};
ElizaClient.prototype.rememberMemory = async function(text) {
	return this.fetch("/api/memory/remember", {
		method: "POST",
		body: JSON.stringify({ text })
	});
};
ElizaClient.prototype.searchMemory = async function(query, options) {
	const params = new URLSearchParams({ q: query });
	if (options?.limit !== void 0) params.set("limit", String(options.limit));
	return this.fetch(`/api/memory/search?${params}`);
};
ElizaClient.prototype.quickContext = async function(query, options) {
	const params = new URLSearchParams({ q: query });
	if (options?.limit !== void 0) params.set("limit", String(options.limit));
	return this.fetch(`/api/context/quick?${params}`);
};
ElizaClient.prototype.getMemoryFeed = async function(query) {
	const params = new URLSearchParams();
	if (query?.type) params.set("type", query.type);
	if (typeof query?.limit === "number") params.set("limit", String(query.limit));
	if (typeof query?.before === "number") params.set("before", String(query.before));
	const qs = params.toString();
	return this.fetch(`/api/memories/feed${qs ? `?${qs}` : ""}`);
};
ElizaClient.prototype.browseMemories = async function(query) {
	const params = new URLSearchParams();
	if (query?.type) params.set("type", query.type);
	if (query?.entityId) params.set("entityId", query.entityId);
	if (query?.roomId) params.set("roomId", query.roomId);
	if (query?.q) params.set("q", query.q);
	if (typeof query?.limit === "number") params.set("limit", String(query.limit));
	if (typeof query?.offset === "number") params.set("offset", String(query.offset));
	const qs = params.toString();
	return this.fetch(`/api/memories/browse${qs ? `?${qs}` : ""}`);
};
ElizaClient.prototype.getMemoriesByEntity = async function(entityId, query) {
	const params = new URLSearchParams();
	if (query?.type) params.set("type", query.type);
	if (typeof query?.limit === "number") params.set("limit", String(query.limit));
	if (typeof query?.offset === "number") params.set("offset", String(query.offset));
	if (query?.entityIds && query.entityIds.length > 0) params.set("entityIds", query.entityIds.join(","));
	const qs = params.toString();
	return this.fetch(`/api/memories/by-entity/${encodeURIComponent(entityId)}${qs ? `?${qs}` : ""}`);
};
ElizaClient.prototype.getMemoryStats = async function() {
	return this.fetch("/api/memories/stats");
};
ElizaClient.prototype.getMcpConfig = async function() {
	return this.fetch("/api/mcp/config");
};
ElizaClient.prototype.getMcpStatus = async function() {
	return this.fetch("/api/mcp/status");
};
ElizaClient.prototype.searchMcpMarketplace = async function(query, limit) {
	const params = new URLSearchParams({
		q: query,
		limit: String(limit)
	});
	return this.fetch(`/api/mcp/marketplace/search?${params}`);
};
ElizaClient.prototype.getMcpServerDetails = async function(name) {
	return this.fetch(`/api/mcp/marketplace/${encodeURIComponent(name)}`);
};
ElizaClient.prototype.addMcpServer = async function(name, config) {
	await this.fetch("/api/mcp/servers", {
		method: "POST",
		body: JSON.stringify({
			name,
			config
		})
	});
};
ElizaClient.prototype.removeMcpServer = async function(name) {
	await this.fetch(`/api/mcp/servers/${encodeURIComponent(name)}`, { method: "DELETE" });
};
ElizaClient.prototype.ingestShare = async function(payload) {
	return this.fetch("/api/ingest/share", {
		method: "POST",
		body: JSON.stringify(payload)
	});
};
ElizaClient.prototype.consumeShareIngest = async function() {
	return this.fetch("/api/share/consume", { method: "POST" });
};
ElizaClient.prototype.getWorkbenchOverview = async function() {
	return this.fetch("/api/workbench/overview");
};
ElizaClient.prototype.listWorkbenchTasks = async function() {
	return this.fetch("/api/workbench/tasks");
};
ElizaClient.prototype.getWorkbenchTask = async function(taskId) {
	return this.fetch(`/api/workbench/tasks/${encodeURIComponent(taskId)}`);
};
ElizaClient.prototype.createWorkbenchTask = async function(data) {
	return this.fetch("/api/workbench/tasks", {
		method: "POST",
		body: JSON.stringify(data)
	});
};
ElizaClient.prototype.updateWorkbenchTask = async function(taskId, data) {
	return this.fetch(`/api/workbench/tasks/${encodeURIComponent(taskId)}`, {
		method: "PUT",
		body: JSON.stringify(data)
	});
};
ElizaClient.prototype.deleteWorkbenchTask = async function(taskId) {
	return this.fetch(`/api/workbench/tasks/${encodeURIComponent(taskId)}`, { method: "DELETE" });
};
ElizaClient.prototype.listWorkbenchTodos = async function() {
	return this.fetch("/api/workbench/todos");
};
ElizaClient.prototype.getWorkbenchTodo = async function(todoId) {
	return this.fetch(`/api/workbench/todos/${encodeURIComponent(todoId)}`);
};
ElizaClient.prototype.createWorkbenchTodo = async function(data) {
	return this.fetch("/api/workbench/todos", {
		method: "POST",
		body: JSON.stringify(data)
	});
};
ElizaClient.prototype.updateWorkbenchTodo = async function(todoId, data) {
	return this.fetch(`/api/workbench/todos/${encodeURIComponent(todoId)}`, {
		method: "PUT",
		body: JSON.stringify(data)
	});
};
ElizaClient.prototype.setWorkbenchTodoCompleted = async function(todoId, isCompleted) {
	await this.fetch(`/api/workbench/todos/${encodeURIComponent(todoId)}/complete`, {
		method: "POST",
		body: JSON.stringify({ isCompleted })
	});
};
ElizaClient.prototype.deleteWorkbenchTodo = async function(todoId) {
	return this.fetch(`/api/workbench/todos/${encodeURIComponent(todoId)}`, { method: "DELETE" });
};
ElizaClient.prototype.refreshRegistry = async function() {
	await this.fetch("/api/apps/refresh", { method: "POST" });
};
ElizaClient.prototype.getTrajectories = async function(options) {
	const params = new URLSearchParams();
	if (options?.limit) params.set("limit", String(options.limit));
	if (options?.offset) params.set("offset", String(options.offset));
	if (options?.source) params.set("source", options.source);
	if (options?.scenarioId) params.set("scenarioId", options.scenarioId);
	if (options?.batchId) params.set("batchId", options.batchId);
	if (options?.status) params.set("status", options.status);
	if (options?.startDate) params.set("startDate", options.startDate);
	if (options?.endDate) params.set("endDate", options.endDate);
	if (options?.search) params.set("search", options.search);
	const query = params.toString();
	return this.fetch(`/api/trajectories${query ? `?${query}` : ""}`);
};
ElizaClient.prototype.getTrajectoryDetail = async function(trajectoryId) {
	return this.fetch(`/api/trajectories/${encodeURIComponent(trajectoryId)}`);
};
ElizaClient.prototype.getTrajectoryStats = async function() {
	return this.fetch("/api/trajectories/stats");
};
ElizaClient.prototype.getTrajectoryConfig = async function() {
	return this.fetch("/api/trajectories/config");
};
ElizaClient.prototype.updateTrajectoryConfig = async function(config) {
	return this.fetch("/api/trajectories/config", {
		method: "PUT",
		body: JSON.stringify(config)
	});
};
ElizaClient.prototype.exportTrajectories = async function(options) {
	return (await this.rawRequest("/api/trajectories/export", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(options)
	})).blob();
};
ElizaClient.prototype.deleteTrajectories = async function(trajectoryIds) {
	return this.fetch("/api/trajectories", {
		method: "DELETE",
		body: JSON.stringify({ trajectoryIds })
	});
};
ElizaClient.prototype.clearAllTrajectories = async function() {
	return this.fetch("/api/trajectories", {
		method: "DELETE",
		body: JSON.stringify({ clearAll: true })
	});
};
ElizaClient.prototype.getDatabaseStatus = async function() {
	return this.fetch("/api/database/status");
};
ElizaClient.prototype.getDatabaseConfig = async function() {
	return this.fetch("/api/database/config");
};
ElizaClient.prototype.saveDatabaseConfig = async function(config) {
	return this.fetch("/api/database/config", {
		method: "PUT",
		body: JSON.stringify(config)
	});
};
ElizaClient.prototype.testDatabaseConnection = async function(creds) {
	return this.fetch("/api/database/test", {
		method: "POST",
		body: JSON.stringify(creds)
	});
};
ElizaClient.prototype.getDatabaseTables = async function() {
	return this.fetch("/api/database/tables");
};
ElizaClient.prototype.getDatabaseRows = async function(table, opts) {
	const params = new URLSearchParams();
	if (opts?.offset != null) params.set("offset", String(opts.offset));
	if (opts?.limit != null) params.set("limit", String(opts.limit));
	if (opts?.sort) params.set("sort", opts.sort);
	if (opts?.order) params.set("order", opts.order);
	if (opts?.search) params.set("search", opts.search);
	const qs = params.toString();
	return this.fetch(`/api/database/tables/${encodeURIComponent(table)}/rows${qs ? `?${qs}` : ""}`);
};
ElizaClient.prototype.insertDatabaseRow = async function(table, data) {
	return this.fetch(`/api/database/tables/${encodeURIComponent(table)}/rows`, {
		method: "POST",
		body: JSON.stringify({ data })
	});
};
ElizaClient.prototype.updateDatabaseRow = async function(table, where, data) {
	return this.fetch(`/api/database/tables/${encodeURIComponent(table)}/rows`, {
		method: "PUT",
		body: JSON.stringify({
			where,
			data
		})
	});
};
ElizaClient.prototype.deleteDatabaseRow = async function(table, where) {
	return this.fetch(`/api/database/tables/${encodeURIComponent(table)}/rows`, {
		method: "DELETE",
		body: JSON.stringify({ where })
	});
};
ElizaClient.prototype.executeDatabaseQuery = async function(sql, readOnly = true) {
	return this.fetch("/api/database/query", {
		method: "POST",
		body: JSON.stringify({
			sql,
			readOnly
		})
	});
};

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/client-cloud.js
/**
* Cloud domain methods — cloud billing, compat agents, sandbox,
* export/import, direct cloud auth, bug reports.
*/
const AGENT_TRANSFER_MIN_PASSWORD_LENGTH = 4;
const DEFAULT_DIRECT_CLOUD_BASE_URL = "https://www.elizacloud.ai";
const DEFAULT_DIRECT_CLOUD_API_BASE_URL = "https://api.elizacloud.ai";
const DIRECT_ELIZA_CLOUD_WEB_HOSTS = new Set([
	"elizacloud.ai",
	"www.elizacloud.ai",
	"dev.elizacloud.ai"
]);
const DIRECT_ELIZA_CLOUD_API_HOST = "api.elizacloud.ai";
function isCloudRouteNotFound(error) {
	return error instanceof Error && "status" in error && error.status === 404;
}
function shouldUseNativeCloudHttp() {
	return import_index_cjs.Capacitor.isNativePlatform();
}
function generateCloudLoginSessionId() {
	if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
function resolveDirectCloudWebBase(cloudBase) {
	const normalized = cloudBase.replace(/\/+$/, "");
	try {
		if (new URL(normalized).hostname.toLowerCase() === DIRECT_ELIZA_CLOUD_API_HOST) return DEFAULT_DIRECT_CLOUD_BASE_URL;
	} catch {}
	return normalized;
}
function resolveDirectCloudAuthApiBase(cloudBase) {
	const normalized = cloudBase.replace(/\/+$/, "");
	try {
		const host = new URL(normalized).hostname.toLowerCase();
		if (host === DIRECT_ELIZA_CLOUD_API_HOST || DIRECT_ELIZA_CLOUD_WEB_HOSTS.has(host)) return DEFAULT_DIRECT_CLOUD_API_BASE_URL;
	} catch {}
	return normalized;
}
function originsMatch(left, right) {
	try {
		return new URL(left).origin === new URL(right).origin;
	} catch {
		return false;
	}
}
function isDirectCloudBase(client) {
	const baseUrl = client.getBaseUrl().trim();
	if (!baseUrl) return false;
	if (originsMatch(baseUrl, DEFAULT_DIRECT_CLOUD_API_BASE_URL) || originsMatch(baseUrl, DEFAULT_DIRECT_CLOUD_BASE_URL)) return true;
	try {
		const host = new URL(baseUrl).hostname.toLowerCase();
		return host === DIRECT_ELIZA_CLOUD_API_HOST || DIRECT_ELIZA_CLOUD_WEB_HOSTS.has(host);
	} catch {
		return false;
	}
}
function stringOrNull(value) {
	return typeof value === "string" && value.trim() ? value : null;
}
function toCloudCompatAgent(input) {
	const id = stringOrNull(input.agentId) ?? stringOrNull(input.id) ?? "";
	const agentName = stringOrNull(input.agentName) ?? stringOrNull(input.name) ?? id;
	const bridgeUrl = input.bridgeUrl ?? input.bridge_url ?? null;
	const webUiUrl = input.webUiUrl ?? input.web_ui_url ?? null;
	const createdAt = stringOrNull(input.createdAt) ?? stringOrNull(input.created_at) ?? (/* @__PURE__ */ new Date(0)).toISOString();
	const updatedAt = stringOrNull(input.updatedAt) ?? stringOrNull(input.updated_at) ?? createdAt;
	return {
		agent_id: id,
		agent_name: agentName,
		node_id: null,
		container_id: null,
		headscale_ip: null,
		bridge_url: bridgeUrl,
		web_ui_url: webUiUrl,
		status: stringOrNull(input.status) ?? "unknown",
		agent_config: input.agentConfig ?? input.agent_config ?? {},
		created_at: createdAt,
		updated_at: updatedAt,
		containerUrl: input.containerUrl ?? bridgeUrl ?? "",
		webUiUrl,
		database_status: stringOrNull(input.databaseStatus) ?? stringOrNull(input.database_status) ?? "unknown",
		error_message: input.errorMessage ?? input.error_message ?? null,
		last_heartbeat_at: input.lastHeartbeatAt ?? input.last_heartbeat_at ?? null
	};
}
function toCloudCompatJob(input) {
	const status = (() => {
		switch (input.status) {
			case "completed":
			case "failed":
			case "retrying": return input.status;
			case "in_progress":
			case "processing": return "processing";
			default: return "queued";
		}
	})();
	const id = stringOrNull(input.id) ?? "";
	const createdAt = stringOrNull(input.createdAt) ?? (/* @__PURE__ */ new Date(0)).toISOString();
	const completedAt = input.completedAt ?? null;
	return {
		jobId: id,
		type: stringOrNull(input.type) ?? "agent_provision",
		status,
		data: {},
		result: input.result ?? null,
		error: input.error ?? null,
		createdAt,
		startedAt: input.startedAt ?? null,
		completedAt,
		retryCount: input.attempts ?? 0,
		id,
		name: stringOrNull(input.type) ?? "agent_provision",
		state: status,
		created_on: createdAt,
		completed_on: completedAt
	};
}
ElizaClient.prototype.getCloudStatus = async function() {
	return this.fetch("/api/cloud/status");
};
ElizaClient.prototype.getCloudCredits = async function() {
	return this.fetch("/api/cloud/credits");
};
ElizaClient.prototype.getCloudBillingSummary = async function() {
	return this.fetch("/api/cloud/billing/summary");
};
ElizaClient.prototype.getCloudBillingSettings = async function() {
	return this.fetch("/api/cloud/billing/settings");
};
ElizaClient.prototype.updateCloudBillingSettings = async function(request) {
	return this.fetch("/api/cloud/billing/settings", {
		method: "PUT",
		body: JSON.stringify(request)
	});
};
ElizaClient.prototype.getCloudBillingPaymentMethods = async function() {
	return this.fetch("/api/cloud/billing/payment-methods");
};
ElizaClient.prototype.getCloudBillingHistory = async function() {
	return this.fetch("/api/cloud/billing/history");
};
ElizaClient.prototype.createCloudBillingCheckout = async function(request) {
	return this.fetch("/api/cloud/billing/checkout", {
		method: "POST",
		body: JSON.stringify(request)
	});
};
ElizaClient.prototype.createCloudBillingCryptoQuote = async function(request) {
	return this.fetch("/api/cloud/billing/crypto/quote", {
		method: "POST",
		body: JSON.stringify(request)
	});
};
ElizaClient.prototype.cloudLogin = async function() {
	return this.fetch("/api/cloud/login", { method: "POST" });
};
ElizaClient.prototype.cloudLoginPoll = async function(sessionId) {
	return this.fetch(`/api/cloud/login/status?sessionId=${encodeURIComponent(sessionId)}`);
};
ElizaClient.prototype.cloudLoginPersist = async function(apiKey, identity) {
	return this.fetch("/api/cloud/login/persist", {
		method: "POST",
		body: JSON.stringify({
			apiKey,
			...identity?.organizationId ? { organizationId: identity.organizationId } : {},
			...identity?.userId ? { userId: identity.userId } : {}
		})
	});
};
ElizaClient.prototype.cloudDisconnect = async function() {
	return this.fetch("/api/cloud/disconnect", { method: "POST" });
};
ElizaClient.prototype.getCloudCompatAgents = async function() {
	if (isDirectCloudBase(this)) {
		const response = await this.fetch("/api/v1/eliza/agents");
		return {
			success: response.success,
			data: (response.data ?? []).map(toCloudCompatAgent)
		};
	}
	return this.fetch("/api/cloud/compat/agents");
};
ElizaClient.prototype.createCloudCompatAgent = async function(opts) {
	if (isDirectCloudBase(this)) {
		const response = await this.fetch("/api/v1/eliza/agents", {
			method: "POST",
			body: JSON.stringify({
				agentName: opts.agentName,
				...opts.agentConfig ? { agentConfig: opts.agentConfig } : {},
				...opts.environmentVars ? { environmentVars: opts.environmentVars } : {}
			})
		});
		const agentId = response.data?.id ?? "";
		return {
			success: response.success,
			data: {
				agentId,
				agentName: response.data?.agentName ?? opts.agentName,
				jobId: "",
				status: response.data?.status ?? "pending",
				nodeId: null,
				message: response.success ? "Agent created" : response.error ?? ""
			}
		};
	}
	return this.fetch("/api/cloud/compat/agents", {
		method: "POST",
		body: JSON.stringify(opts)
	});
};
ElizaClient.prototype.ensureCloudCompatManagedDiscordAgent = async function() {
	return this.fetch("/api/cloud/v1/app/discord/gateway-agent", { method: "POST" });
};
ElizaClient.prototype.provisionCloudCompatAgent = async function(agentId) {
	if (isDirectCloudBase(this)) return this.fetch(`/api/v1/eliza/agents/${encodeURIComponent(agentId)}/provision`, { method: "POST" }, { allowNonOk: true });
	return this.fetch(`/api/cloud/v1/app/agents/${encodeURIComponent(agentId)}/provision`, { method: "POST" }, { allowNonOk: true });
};
ElizaClient.prototype.getCloudCompatAgent = async function(agentId) {
	if (isDirectCloudBase(this)) {
		const response = await this.fetch(`/api/v1/eliza/agents/${encodeURIComponent(agentId)}`);
		return {
			success: response.success,
			data: toCloudCompatAgent(response.data ?? { id: agentId })
		};
	}
	return this.fetch(`/api/cloud/compat/agents/${encodeURIComponent(agentId)}`);
};
ElizaClient.prototype.getCloudCompatAgentManagedDiscord = async function(agentId) {
	return this.fetch(`/api/cloud/v1/app/agents/${encodeURIComponent(agentId)}/discord`);
};
ElizaClient.prototype.createCloudCompatAgentManagedDiscordOauth = async function(agentId, request = {}) {
	return this.fetch(`/api/cloud/v1/app/agents/${encodeURIComponent(agentId)}/discord/oauth`, {
		method: "POST",
		body: JSON.stringify(request)
	});
};
ElizaClient.prototype.disconnectCloudCompatAgentManagedDiscord = async function(agentId) {
	return this.fetch(`/api/cloud/v1/app/agents/${encodeURIComponent(agentId)}/discord`, { method: "DELETE" });
};
ElizaClient.prototype.getCloudCompatAgentDiscordConfig = async function(agentId) {
	return this.fetch(`/api/cloud/v1/app/agents/${encodeURIComponent(agentId)}/discord/config`);
};
ElizaClient.prototype.updateCloudCompatAgentDiscordConfig = async function(agentId, config) {
	return this.fetch(`/api/cloud/v1/app/agents/${encodeURIComponent(agentId)}/discord/config`, {
		method: "PATCH",
		body: JSON.stringify(config)
	});
};
ElizaClient.prototype.getCloudCompatAgentManagedGithub = async function(agentId) {
	return this.fetch(`/api/cloud/v1/app/agents/${encodeURIComponent(agentId)}/github`);
};
ElizaClient.prototype.createCloudCompatAgentManagedGithubOauth = async function(agentId, request = {}) {
	try {
		return await this.fetch(`/api/cloud/v1/app/agents/${encodeURIComponent(agentId)}/github/oauth`, {
			method: "POST",
			body: JSON.stringify(request)
		});
	} catch (error) {
		if (!isCloudRouteNotFound(error)) throw error;
		const params = new URLSearchParams({
			target: "agent",
			agent_id: agentId
		});
		if (request.postMessage) params.set("post_message", "1");
		if (request.returnUrl) params.set("return_url", request.returnUrl);
		return {
			success: true,
			data: { authorizeUrl: (await this.initiateCloudOauth("github", {
				redirectUrl: `/api/v1/eliza/lifeops/github-complete?${params.toString()}`,
				connectionRole: "agent",
				scopes: request.scopes
			})).authUrl }
		};
	}
};
ElizaClient.prototype.linkCloudCompatAgentManagedGithub = async function(agentId, connectionId) {
	return this.fetch(`/api/cloud/v1/app/agents/${encodeURIComponent(agentId)}/github/link`, {
		method: "POST",
		body: JSON.stringify({ connectionId })
	});
};
ElizaClient.prototype.disconnectCloudCompatAgentManagedGithub = async function(agentId) {
	return this.fetch(`/api/cloud/v1/app/agents/${encodeURIComponent(agentId)}/github`, { method: "DELETE" });
};
ElizaClient.prototype.listCloudOauthConnections = async function(args) {
	const params = new URLSearchParams();
	if (args?.platform) params.set("platform", args.platform);
	if (args?.connectionRole) params.set("connectionRole", args.connectionRole);
	const query = params.toString();
	return this.fetch(`/api/cloud/v1/oauth/connections${query ? `?${query}` : ""}`);
};
ElizaClient.prototype.initiateCloudOauth = async function(platform, request) {
	try {
		return await this.fetch(`/api/cloud/v1/oauth/${encodeURIComponent(platform)}/initiate`, {
			method: "POST",
			body: JSON.stringify(request ?? {})
		});
	} catch (error) {
		if (!isCloudRouteNotFound(error)) throw error;
		return this.fetch(`/api/cloud/v1/oauth/initiate?provider=${encodeURIComponent(platform)}`, {
			method: "POST",
			body: JSON.stringify(request ?? {})
		});
	}
};
ElizaClient.prototype.initiateCloudTwitterOauth = async function(request) {
	return this.fetch("/api/cloud/v1/twitter/connect", {
		method: "POST",
		body: JSON.stringify(request ?? {})
	});
};
ElizaClient.prototype.disconnectCloudOauthConnection = async function(connectionId) {
	return this.fetch(`/api/cloud/v1/oauth/connections/${encodeURIComponent(connectionId)}`, { method: "DELETE" });
};
ElizaClient.prototype.getCloudCompatAgentGithubToken = async function(agentId) {
	return this.fetch(`/api/cloud/v1/app/agents/${encodeURIComponent(agentId)}/github/token`);
};
ElizaClient.prototype.deleteCloudCompatAgent = async function(agentId) {
	return this.fetch(`/api/cloud/compat/agents/${encodeURIComponent(agentId)}`, { method: "DELETE" });
};
ElizaClient.prototype.getCloudCompatAgentStatus = async function(agentId) {
	return this.fetch(`/api/cloud/compat/agents/${encodeURIComponent(agentId)}/status`);
};
ElizaClient.prototype.getCloudCompatAgentLogs = async function(agentId, tail = 100) {
	return this.fetch(`/api/cloud/compat/agents/${encodeURIComponent(agentId)}/logs?tail=${tail}`);
};
ElizaClient.prototype.restartCloudCompatAgent = async function(agentId) {
	return this.fetch(`/api/cloud/compat/agents/${encodeURIComponent(agentId)}/restart`, { method: "POST" });
};
ElizaClient.prototype.suspendCloudCompatAgent = async function(agentId) {
	return this.fetch(`/api/cloud/compat/agents/${encodeURIComponent(agentId)}/suspend`, { method: "POST" });
};
ElizaClient.prototype.resumeCloudCompatAgent = async function(agentId) {
	return this.fetch(`/api/cloud/compat/agents/${encodeURIComponent(agentId)}/resume`, { method: "POST" });
};
ElizaClient.prototype.launchCloudCompatAgent = async function(agentId) {
	return this.fetch(`/api/cloud/compat/agents/${encodeURIComponent(agentId)}/launch`, { method: "POST" });
};
ElizaClient.prototype.getCloudCompatPairingToken = async function(agentId) {
	return this.fetch(`/api/cloud/v1/app/agents/${encodeURIComponent(agentId)}/pairing-token`, { method: "POST" });
};
ElizaClient.prototype.getCloudCompatAvailability = async function() {
	return this.fetch("/api/cloud/compat/availability");
};
ElizaClient.prototype.getCloudCompatJobStatus = async function(jobId) {
	if (isDirectCloudBase(this)) {
		const response = await this.fetch(`/api/v1/jobs/${encodeURIComponent(jobId)}`);
		return {
			success: response.success,
			data: toCloudCompatJob(response.data ?? { id: jobId })
		};
	}
	return this.fetch(`/api/cloud/compat/jobs/${encodeURIComponent(jobId)}`);
};
ElizaClient.prototype.exportAgent = async function(password, includeLogs = false) {
	if (password.length < AGENT_TRANSFER_MIN_PASSWORD_LENGTH) throw new Error(`Password must be at least ${AGENT_TRANSFER_MIN_PASSWORD_LENGTH} characters.`);
	return this.rawRequest("/api/agent/export", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			password,
			includeLogs
		})
	});
};
ElizaClient.prototype.getExportEstimate = async function() {
	return this.fetch("/api/agent/export/estimate");
};
ElizaClient.prototype.importAgent = async function(password, fileBuffer) {
	if (password.length < AGENT_TRANSFER_MIN_PASSWORD_LENGTH) throw new Error(`Password must be at least ${AGENT_TRANSFER_MIN_PASSWORD_LENGTH} characters.`);
	const passwordBytes = new TextEncoder().encode(password);
	const envelope = new Uint8Array(4 + passwordBytes.length + fileBuffer.byteLength);
	new DataView(envelope.buffer).setUint32(0, passwordBytes.length, false);
	envelope.set(passwordBytes, 4);
	envelope.set(new Uint8Array(fileBuffer), 4 + passwordBytes.length);
	const res = await this.rawRequest("/api/agent/import", {
		method: "POST",
		headers: { "Content-Type": "application/octet-stream" },
		body: envelope
	});
	const data = await res.json();
	if (!data.success) throw new Error(data.error ?? `Import failed (${res.status})`);
	return data;
};
ElizaClient.prototype.getSandboxPlatform = async function() {
	return this.fetch("/api/sandbox/platform");
};
ElizaClient.prototype.getSandboxBrowser = async function() {
	return this.fetch("/api/sandbox/browser");
};
ElizaClient.prototype.getSandboxScreenshot = async function(region) {
	if (!region) return this.fetch("/api/sandbox/screen/screenshot", { method: "POST" });
	return this.fetch("/api/sandbox/screen/screenshot", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(region)
	});
};
ElizaClient.prototype.getSandboxWindows = async function() {
	return this.fetch("/api/sandbox/screen/windows");
};
ElizaClient.prototype.startDocker = async function() {
	return this.fetch("/api/sandbox/docker/start", { method: "POST" });
};
ElizaClient.prototype.cloudLoginDirect = async function(cloudApiBase) {
	const sessionId = generateCloudLoginSessionId();
	const cloudWebBase = resolveDirectCloudWebBase(cloudApiBase);
	const authApiBase = resolveDirectCloudAuthApiBase(cloudApiBase);
	try {
		if (shouldUseNativeCloudHttp()) {
			const res = await import_index_cjs.CapacitorHttp.post({
				url: `${authApiBase}/api/auth/cli-session`,
				headers: { "Content-Type": "application/json" },
				data: { sessionId },
				responseType: "json",
				connectTimeout: 1e4,
				readTimeout: 1e4
			});
			if (res.status < 200 || res.status >= 300) return {
				ok: false,
				error: `Login failed (${res.status})`
			};
			return {
				ok: true,
				apiBase: authApiBase,
				sessionId,
				browserUrl: `${cloudWebBase}/auth/cli-login?session=${encodeURIComponent(sessionId)}`
			};
		}
		const res = await fetch(`${authApiBase}/api/auth/cli-session`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ sessionId })
		});
		if (!res.ok) return {
			ok: false,
			error: `Login failed (${res.status})`
		};
		return {
			ok: true,
			apiBase: authApiBase,
			sessionId,
			browserUrl: `${cloudWebBase}/auth/cli-login?session=${encodeURIComponent(sessionId)}`
		};
	} catch (err) {
		return {
			ok: false,
			error: `Failed to reach Eliza Cloud: ${err instanceof Error ? err.message : String(err)}`
		};
	}
};
ElizaClient.prototype.cloudLoginPollDirect = async function(cloudApiBase, sessionId) {
	const authApiBase = resolveDirectCloudAuthApiBase(cloudApiBase);
	try {
		let status;
		let data;
		if (shouldUseNativeCloudHttp()) {
			const res = await import_index_cjs.CapacitorHttp.get({
				url: `${authApiBase}/api/auth/cli-session/${encodeURIComponent(sessionId)}`,
				responseType: "json",
				connectTimeout: 1e4,
				readTimeout: 1e4
			});
			status = res.status;
			data = typeof res.data === "object" && res.data !== null ? res.data : {};
		} else {
			const res = await fetch(`${authApiBase}/api/auth/cli-session/${encodeURIComponent(sessionId)}`);
			status = res.status;
			if (!res.ok) {
				if (res.status === 404) return {
					status: "expired",
					error: "Auth session expired or not found"
				};
				return {
					status: "error",
					error: `Poll failed (${res.status})`
				};
			}
			data = await res.json();
		}
		if (status < 200 || status >= 300) {
			if (status === 404) return {
				status: "expired",
				error: "Auth session expired or not found"
			};
			return {
				status: "error",
				error: `Poll failed (${status})`
			};
		}
		if (data.status === "authenticated" && data.apiKey) return {
			status: "authenticated",
			organizationId: data.organizationId,
			token: data.apiKey,
			userId: data.userId
		};
		return { status: data.status ?? "pending" };
	} catch {
		return {
			status: "error",
			error: "Poll request failed"
		};
	}
};
ElizaClient.prototype.provisionCloudSandbox = async function(options) {
	const { cloudApiBase, authToken, name, bio, onProgress } = options;
	const headers = {
		"Content-Type": "application/json",
		Authorization: `Bearer ${authToken}`
	};
	onProgress?.("creating", "Creating agent...");
	const createRes = await fetch(`${cloudApiBase}/api/v1/app/agents`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			name,
			bio
		})
	});
	if (!createRes.ok) {
		const err = await createRes.text().catch(() => "Unknown error");
		throw new Error(`Failed to create cloud agent: ${err}`);
	}
	const agentId = (await createRes.json()).id;
	onProgress?.("provisioning", "Provisioning sandbox environment...");
	const provisionRes = await fetch(`${cloudApiBase}/api/v1/app/agents/${agentId}/provision`, {
		method: "POST",
		headers
	});
	if (!provisionRes.ok) {
		const err = await provisionRes.text().catch(() => "Unknown error");
		throw new Error(`Failed to start provisioning: ${err}`);
	}
	const jobId = (await provisionRes.json()).jobId;
	const deadline = Date.now() + 12e4;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 2e3));
		const jobRes = await fetch(`${cloudApiBase}/api/v1/jobs/${jobId}`, { headers });
		if (!jobRes.ok) continue;
		const jobData = await jobRes.json();
		if (jobData.status === "completed" && jobData.result?.bridgeUrl) {
			onProgress?.("ready", "Sandbox ready!");
			return {
				bridgeUrl: jobData.result.bridgeUrl,
				agentId
			};
		}
		if (jobData.status === "failed") throw new Error(`Provisioning failed: ${jobData.error ?? "Unknown error"}`);
		onProgress?.("provisioning", `Status: ${jobData.status}...`);
	}
	throw new Error("Provisioning timed out after 2 minutes");
};
ElizaClient.prototype.checkBugReportInfo = async function() {
	return this.fetch("/api/bug-report/info");
};
ElizaClient.prototype.submitBugReport = async function(report) {
	return this.fetch("/api/bug-report", {
		method: "POST",
		body: JSON.stringify(report)
	});
};

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/client-computeruse.js
ElizaClient.prototype.getComputerUseApprovals = async function() {
	return this.fetch("/api/computer-use/approvals");
};
ElizaClient.prototype.respondToComputerUseApproval = async function(id, approved, reason) {
	return this.fetch(`/api/computer-use/approvals/${encodeURIComponent(id)}`, {
		method: "POST",
		body: JSON.stringify({
			approved,
			reason
		})
	});
};
ElizaClient.prototype.setComputerUseApprovalMode = async function(mode) {
	return this.fetch("/api/computer-use/approval-mode", {
		method: "POST",
		body: JSON.stringify({ mode })
	});
};

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/client-imessage.js
function buildQuery(params) {
	const query = params.toString();
	return query.length > 0 ? `?${query}` : "";
}
ElizaClient.prototype.getIMessageStatus = async function() {
	return this.fetch("/api/lifeops/connectors/imessage/status");
};
function normalizeLifeOpsMessage(message) {
	const attachmentPaths = message.attachments?.map((attachment) => attachment.path).filter((path) => typeof path === "string") ?? [];
	return {
		id: message.id,
		text: message.text,
		handle: message.isFromMe ? message.toHandles[0] ?? "" : message.fromHandle,
		chatId: message.chatId ?? "",
		timestamp: Date.parse(message.sentAt) || 0,
		isFromMe: message.isFromMe,
		hasAttachments: attachmentPaths.length > 0,
		...attachmentPaths.length > 0 ? { attachmentPaths } : {}
	};
}
function normalizeLifeOpsChat(chat) {
	return {
		chatId: chat.id,
		chatType: chat.participants.length > 1 ? "group" : "direct",
		displayName: chat.name,
		participants: chat.participants.map((handle) => ({
			handle,
			isPhoneNumber: /^\+?[0-9()\s.-]+$/.test(handle)
		}))
	};
}
ElizaClient.prototype.getIMessageMessages = async function(options = {}) {
	const params = new URLSearchParams();
	if (options.chatId?.trim()) params.set("chatId", options.chatId.trim());
	if (typeof options.limit === "number" && Number.isFinite(options.limit)) params.set("limit", String(options.limit));
	const result = await this.fetch(`/api/lifeops/connectors/imessage/messages${buildQuery(params)}`);
	return {
		messages: result.messages.map(normalizeLifeOpsMessage),
		count: result.count
	};
};
ElizaClient.prototype.listIMessageChats = async function() {
	const result = await this.fetch("/api/lifeops/connectors/imessage/chats");
	return {
		chats: result.chats.map(normalizeLifeOpsChat),
		count: result.count
	};
};
ElizaClient.prototype.sendIMessage = async function(request) {
	const attachmentPaths = request.attachmentPaths ?? (request.mediaUrl ? [request.mediaUrl] : void 0);
	const body = {
		to: request.to,
		text: request.text,
		...attachmentPaths ? { attachmentPaths } : {}
	};
	const result = await this.fetch("/api/lifeops/connectors/imessage/send", {
		method: "POST",
		body: JSON.stringify(body)
	});
	return {
		success: result.ok,
		messageId: result.messageId
	};
};

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/client-local-inference.js
/**
* Client-side helpers for the local-inference endpoints. Mirrors the
* structure used by `client-computeruse.ts`: augments `ElizaClient` via
* declaration merging so callers get typed methods without reaching into
* raw `fetch` from UI code.
*/
ElizaClient.prototype.getLocalInferenceHub = async function() {
	return this.fetch("/api/local-inference/hub");
};
ElizaClient.prototype.getLocalInferenceHardware = async function() {
	return this.fetch("/api/local-inference/hardware");
};
ElizaClient.prototype.getLocalInferenceCatalog = async function() {
	return this.fetch("/api/local-inference/catalog");
};
ElizaClient.prototype.getLocalInferenceInstalled = async function() {
	return this.fetch("/api/local-inference/installed");
};
ElizaClient.prototype.startLocalInferenceDownload = async function(modelIdOrSpec) {
	const body = typeof modelIdOrSpec === "string" ? { modelId: modelIdOrSpec } : { spec: modelIdOrSpec };
	return this.fetch("/api/local-inference/downloads", {
		method: "POST",
		body: JSON.stringify(body)
	});
};
ElizaClient.prototype.searchHuggingFaceGguf = async function(query, limit) {
	const params = new URLSearchParams({ q: query });
	if (limit != null) params.set("limit", String(limit));
	return this.fetch(`/api/local-inference/hf-search?${params.toString()}`);
};
ElizaClient.prototype.cancelLocalInferenceDownload = async function(modelId) {
	return this.fetch(`/api/local-inference/downloads/${encodeURIComponent(modelId)}`, { method: "DELETE" });
};
ElizaClient.prototype.getLocalInferenceActive = async function() {
	return this.fetch("/api/local-inference/active");
};
ElizaClient.prototype.setLocalInferenceActive = async function(modelId) {
	return this.fetch("/api/local-inference/active", {
		method: "POST",
		body: JSON.stringify({ modelId })
	});
};
ElizaClient.prototype.clearLocalInferenceActive = async function() {
	return this.fetch("/api/local-inference/active", { method: "DELETE" });
};
ElizaClient.prototype.uninstallLocalInferenceModel = async function(id) {
	return this.fetch(`/api/local-inference/installed/${encodeURIComponent(id)}`, { method: "DELETE" });
};
ElizaClient.prototype.getLocalInferenceDeviceStatus = async function() {
	return this.fetch("/api/local-inference/device");
};
ElizaClient.prototype.getLocalInferenceProviders = async function() {
	return this.fetch("/api/local-inference/providers");
};
ElizaClient.prototype.getLocalInferenceAssignments = async function() {
	return this.fetch("/api/local-inference/assignments");
};
ElizaClient.prototype.setLocalInferenceAssignment = async function(slot, modelId) {
	return this.fetch("/api/local-inference/assignments", {
		method: "POST",
		body: JSON.stringify({
			slot,
			modelId
		})
	});
};
ElizaClient.prototype.verifyLocalInferenceModel = async function(id) {
	return this.fetch(`/api/local-inference/installed/${encodeURIComponent(id)}/verify`, { method: "POST" });
};
ElizaClient.prototype.getLocalInferenceRouting = async function() {
	return this.fetch("/api/local-inference/routing");
};
ElizaClient.prototype.setLocalInferencePreferredProvider = async function(slot, provider) {
	return this.fetch("/api/local-inference/routing/preferred", {
		method: "POST",
		body: JSON.stringify({
			slot,
			provider
		})
	});
};
ElizaClient.prototype.setLocalInferencePolicy = async function(slot, policy) {
	return this.fetch("/api/local-inference/routing/policy", {
		method: "POST",
		body: JSON.stringify({
			slot,
			policy
		})
	});
};

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/client-n8n.js
/**
* n8n domain methods — status, workflow CRUD, sidecar start.
*
* All routes hit `/api/n8n/*` on the local agent server.
* The workflow CRUD routes are served by the n8n plugin itself
* but exposed through the same base URL via the plugin's route registration.
*/
ElizaClient.prototype.getN8nStatus = async function() {
	return this.fetch("/api/n8n/status");
};
ElizaClient.prototype.getN8nWorkflow = async function(id) {
	return this.fetch(`/api/n8n/workflows/${encodeURIComponent(id)}`);
};
ElizaClient.prototype.listN8nWorkflows = async function() {
	return (await this.fetch("/api/n8n/workflows")).workflows ?? [];
};
ElizaClient.prototype.createN8nWorkflow = async function(request) {
	return this.fetch("/api/n8n/workflows", {
		method: "POST",
		body: JSON.stringify(request)
	});
};
ElizaClient.prototype.updateN8nWorkflow = async function(id, request) {
	return this.fetch(`/api/n8n/workflows/${encodeURIComponent(id)}`, {
		method: "PUT",
		body: JSON.stringify(request)
	});
};
ElizaClient.prototype.generateN8nWorkflow = async function(request) {
	return this.fetch("/api/n8n/workflows/generate", {
		method: "POST",
		body: JSON.stringify(request)
	}, { timeoutMs: 12e4 });
};
ElizaClient.prototype.resolveN8nClarification = async function(request) {
	return this.fetch("/api/n8n/workflows/resolve-clarification", {
		method: "POST",
		body: JSON.stringify(request)
	}, { timeoutMs: 12e4 });
};
ElizaClient.prototype.activateN8nWorkflow = async function(id) {
	return this.fetch(`/api/n8n/workflows/${encodeURIComponent(id)}/activate`, { method: "POST" });
};
ElizaClient.prototype.deactivateN8nWorkflow = async function(id) {
	return this.fetch(`/api/n8n/workflows/${encodeURIComponent(id)}/deactivate`, { method: "POST" });
};
ElizaClient.prototype.deleteN8nWorkflow = async function(id) {
	return this.fetch(`/api/n8n/workflows/${encodeURIComponent(id)}`, { method: "DELETE" });
};
ElizaClient.prototype.startN8nSidecar = async function() {
	return this.fetch("/api/n8n/sidecar/start", { method: "POST" });
};

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/client-skills.js
/**
* Skills domain methods — skills, catalog, marketplace, apps, Babylon,
* custom actions, WhatsApp, agent events.
*/
ElizaClient.prototype.getSkills = async function() {
	return this.fetch("/api/skills");
};
ElizaClient.prototype.refreshSkills = async function() {
	return this.fetch("/api/skills/refresh", { method: "POST" });
};
ElizaClient.prototype.getSkillCatalog = async function(opts) {
	const params = new URLSearchParams();
	if (opts?.page) params.set("page", String(opts.page));
	if (opts?.perPage) params.set("perPage", String(opts.perPage));
	if (opts?.sort) params.set("sort", opts.sort);
	const qs = params.toString();
	return this.fetch(`/api/skills/catalog${qs ? `?${qs}` : ""}`);
};
ElizaClient.prototype.searchSkillCatalog = async function(query, limit = 30) {
	return this.fetch(`/api/skills/catalog/search?q=${encodeURIComponent(query)}&limit=${limit}`);
};
ElizaClient.prototype.getSkillCatalogDetail = async function(slug) {
	return this.fetch(`/api/skills/catalog/${encodeURIComponent(slug)}`);
};
ElizaClient.prototype.refreshSkillCatalog = async function() {
	return this.fetch("/api/skills/catalog/refresh", { method: "POST" });
};
ElizaClient.prototype.installCatalogSkill = async function(slug, version) {
	return this.fetch("/api/skills/catalog/install", {
		method: "POST",
		body: JSON.stringify({
			slug,
			version
		})
	});
};
ElizaClient.prototype.uninstallCatalogSkill = async function(slug) {
	return this.fetch("/api/skills/catalog/uninstall", {
		method: "POST",
		body: JSON.stringify({ slug })
	});
};
ElizaClient.prototype.getRegistryPlugins = async function() {
	return this.fetch("/api/registry/plugins");
};
ElizaClient.prototype.getRegistryPluginInfo = async function(name) {
	return this.fetch(`/api/registry/plugins/${encodeURIComponent(name)}`);
};
ElizaClient.prototype.getInstalledPlugins = async function() {
	return this.fetch("/api/plugins/installed");
};
ElizaClient.prototype.installRegistryPlugin = async function(name, autoRestart = true, options = {}) {
	return this.fetch("/api/plugins/install", {
		method: "POST",
		body: JSON.stringify({
			name,
			autoRestart,
			...options
		})
	}, { timeoutMs: 12e4 });
};
ElizaClient.prototype.updateRegistryPlugin = async function(name, autoRestart = true, options = {}) {
	return this.fetch("/api/plugins/update", {
		method: "POST",
		body: JSON.stringify({
			name,
			autoRestart,
			...options
		})
	}, { timeoutMs: 12e4 });
};
ElizaClient.prototype.uninstallRegistryPlugin = async function(name, autoRestart = true) {
	return this.fetch("/api/plugins/uninstall", {
		method: "POST",
		body: JSON.stringify({
			name,
			autoRestart
		})
	});
};
ElizaClient.prototype.searchSkillsMarketplace = async function(query, installed, limit) {
	const params = new URLSearchParams({
		q: query,
		installed: String(installed),
		limit: String(limit)
	});
	return this.fetch(`/api/skills/marketplace/search?${params}`);
};
ElizaClient.prototype.getSkillsMarketplaceConfig = async function() {
	return this.fetch("/api/skills/marketplace/config");
};
ElizaClient.prototype.updateSkillsMarketplaceConfig = async function(apiKey) {
	return this.fetch("/api/skills/marketplace/config", {
		method: "PUT",
		body: JSON.stringify({ apiKey })
	});
};
ElizaClient.prototype.installMarketplaceSkill = async function(data) {
	await this.fetch("/api/skills/marketplace/install", {
		method: "POST",
		body: JSON.stringify(data)
	});
};
ElizaClient.prototype.uninstallMarketplaceSkill = async function(skillId, autoRefresh) {
	await this.fetch("/api/skills/marketplace/uninstall", {
		method: "POST",
		body: JSON.stringify({
			id: skillId,
			autoRefresh
		})
	});
};
ElizaClient.prototype.enableSkill = async function(skillId) {
	return this.fetch(`/api/skills/${encodeURIComponent(skillId)}/enable`, { method: "POST" });
};
ElizaClient.prototype.disableSkill = async function(skillId) {
	return this.fetch(`/api/skills/${encodeURIComponent(skillId)}/disable`, { method: "POST" });
};
ElizaClient.prototype.createSkill = async function(name, description) {
	return this.fetch("/api/skills/create", {
		method: "POST",
		body: JSON.stringify({
			name,
			description
		})
	});
};
ElizaClient.prototype.openSkill = async function(id) {
	return this.fetch(`/api/skills/${encodeURIComponent(id)}/open`, { method: "POST" });
};
ElizaClient.prototype.getSkillSource = async function(id) {
	return this.fetch(`/api/skills/${encodeURIComponent(id)}/source`);
};
ElizaClient.prototype.saveSkillSource = async function(id, content) {
	return this.fetch(`/api/skills/${encodeURIComponent(id)}/source`, {
		method: "PUT",
		body: JSON.stringify({ content })
	});
};
ElizaClient.prototype.deleteSkill = async function(id) {
	return this.fetch(`/api/skills/${encodeURIComponent(id)}`, { method: "DELETE" });
};
ElizaClient.prototype.getSkillScanReport = async function(id) {
	return this.fetch(`/api/skills/${encodeURIComponent(id)}/scan`);
};
ElizaClient.prototype.acknowledgeSkill = async function(id, enable) {
	return this.fetch(`/api/skills/${encodeURIComponent(id)}/acknowledge`, {
		method: "POST",
		body: JSON.stringify({ enable })
	});
};
ElizaClient.prototype.listApps = async function() {
	return this.fetch("/api/apps");
};
ElizaClient.prototype.listCatalogApps = async function() {
	return this.fetch("/api/catalog/apps");
};
ElizaClient.prototype.searchApps = async function(query) {
	return this.fetch(`/api/apps/search?q=${encodeURIComponent(query)}`);
};
ElizaClient.prototype.listInstalledApps = async function() {
	return this.fetch("/api/apps/installed");
};
ElizaClient.prototype.listAppRuns = async function() {
	return this.fetch("/api/apps/runs");
};
ElizaClient.prototype.getAppRun = async function(runId) {
	return this.fetch(`/api/apps/runs/${encodeURIComponent(runId)}`);
};
ElizaClient.prototype.attachAppRun = async function(runId) {
	return this.fetch(`/api/apps/runs/${encodeURIComponent(runId)}/attach`, { method: "POST" });
};
ElizaClient.prototype.detachAppRun = async function(runId) {
	return this.fetch(`/api/apps/runs/${encodeURIComponent(runId)}/detach`, { method: "POST" });
};
ElizaClient.prototype.stopApp = async function(name) {
	return this.fetch("/api/apps/stop", {
		method: "POST",
		body: JSON.stringify({ name })
	});
};
ElizaClient.prototype.stopAppRun = async function(runId) {
	return this.fetch(`/api/apps/runs/${encodeURIComponent(runId)}/stop`, { method: "POST" });
};
ElizaClient.prototype.heartbeatAppRun = async function(runId) {
	return this.fetch(`/api/apps/runs/${encodeURIComponent(runId)}/heartbeat`, { method: "POST" });
};
ElizaClient.prototype.getAppInfo = async function(name) {
	return this.fetch(`/api/apps/info/${encodeURIComponent(name)}`);
};
ElizaClient.prototype.launchApp = async function(name) {
	return this.fetch("/api/apps/launch", {
		method: "POST",
		body: JSON.stringify({ name })
	});
};
ElizaClient.prototype.sendAppRunMessage = async function(runId, content) {
	const response = await this.rawRequest(`/api/apps/runs/${encodeURIComponent(runId)}/message`, {
		method: "POST",
		body: JSON.stringify({ content })
	}, { allowNonOk: true });
	const data = await response.json().catch(() => ({}));
	return {
		success: Boolean(data.success),
		message: typeof data.message === "string" && data.message.trim().length > 0 ? data.message.trim() : response.status === 202 ? "Command queued." : response.status >= 500 ? "Command unavailable." : "Command rejected.",
		disposition: data.disposition === "accepted" || data.disposition === "queued" || data.disposition === "rejected" || data.disposition === "unsupported" ? data.disposition : response.status === 202 ? "queued" : response.status >= 500 ? "unsupported" : response.status >= 400 ? "rejected" : "accepted",
		status: response.status,
		run: data.run && typeof data.run === "object" ? data.run : null,
		session: data.session && typeof data.session === "object" ? data.session : null
	};
};
ElizaClient.prototype.controlAppRun = async function(runId, action) {
	const response = await this.rawRequest(`/api/apps/runs/${encodeURIComponent(runId)}/control`, {
		method: "POST",
		body: JSON.stringify({ action })
	}, { allowNonOk: true });
	const data = await response.json().catch(() => ({}));
	return {
		success: Boolean(data.success),
		message: typeof data.message === "string" && data.message.trim().length > 0 ? data.message.trim() : response.status === 202 ? "Command queued." : response.status >= 500 ? "Command unavailable." : "Command rejected.",
		disposition: data.disposition === "accepted" || data.disposition === "queued" || data.disposition === "rejected" || data.disposition === "unsupported" ? data.disposition : response.status === 202 ? "queued" : response.status >= 500 ? "unsupported" : response.status >= 400 ? "rejected" : "accepted",
		status: response.status,
		run: data.run && typeof data.run === "object" ? data.run : null,
		session: data.session && typeof data.session === "object" ? data.session : null
	};
};
ElizaClient.prototype.getAppSessionState = async function(appName, sessionId) {
	const routeSlug = packageNameToAppRouteSlug(appName) ?? appName;
	return this.fetch(`/api/apps/${encodeURIComponent(routeSlug)}/session/${encodeURIComponent(sessionId)}`);
};
ElizaClient.prototype.sendAppSessionMessage = async function(appName, sessionId, content) {
	const routeSlug = packageNameToAppRouteSlug(appName) ?? appName;
	return this.fetch(`/api/apps/${encodeURIComponent(routeSlug)}/session/${encodeURIComponent(sessionId)}/message`, {
		method: "POST",
		body: JSON.stringify({ content })
	});
};
ElizaClient.prototype.controlAppSession = async function(appName, sessionId, action) {
	const routeSlug = packageNameToAppRouteSlug(appName) ?? appName;
	return this.fetch(`/api/apps/${encodeURIComponent(routeSlug)}/session/${encodeURIComponent(sessionId)}/control`, {
		method: "POST",
		body: JSON.stringify({ action })
	});
};
ElizaClient.prototype.listRegistryPlugins = async function() {
	return this.fetch("/api/apps/plugins");
};
ElizaClient.prototype.searchRegistryPlugins = async function(query) {
	return this.fetch(`/api/apps/plugins/search?q=${encodeURIComponent(query)}`);
};
ElizaClient.prototype.listCustomActions = async function() {
	return (await this.fetch("/api/custom-actions")).actions;
};
ElizaClient.prototype.createCustomAction = async function(action) {
	return (await this.fetch("/api/custom-actions", {
		method: "POST",
		body: JSON.stringify(action)
	})).action;
};
ElizaClient.prototype.updateCustomAction = async function(id, action) {
	return (await this.fetch(`/api/custom-actions/${encodeURIComponent(id)}`, {
		method: "PUT",
		body: JSON.stringify(action)
	})).action;
};
ElizaClient.prototype.deleteCustomAction = async function(id) {
	await this.fetch(`/api/custom-actions/${encodeURIComponent(id)}`, { method: "DELETE" });
};
ElizaClient.prototype.testCustomAction = async function(id, params) {
	return this.fetch(`/api/custom-actions/${encodeURIComponent(id)}/test`, {
		method: "POST",
		body: JSON.stringify({ params })
	});
};
ElizaClient.prototype.generateCustomAction = async function(prompt) {
	return this.fetch("/api/custom-actions/generate", {
		method: "POST",
		body: JSON.stringify({ prompt })
	});
};
ElizaClient.prototype.getWhatsAppStatus = async function(accountId = "default", options = {}) {
	const params = new URLSearchParams({ accountId });
	if (options.authScope) params.set("authScope", options.authScope);
	return this.fetch(`/api/whatsapp/status?${params.toString()}`);
};
ElizaClient.prototype.startWhatsAppPairing = async function(accountId = "default", options = {}) {
	return this.fetch("/api/whatsapp/pair", {
		method: "POST",
		body: JSON.stringify({
			...options,
			accountId
		})
	});
};
ElizaClient.prototype.stopWhatsAppPairing = async function(accountId = "default", options = {}) {
	return this.fetch("/api/whatsapp/pair/stop", {
		method: "POST",
		body: JSON.stringify({
			...options,
			accountId
		})
	});
};
ElizaClient.prototype.disconnectWhatsApp = async function(accountId = "default", options = {}) {
	return this.fetch("/api/whatsapp/disconnect", {
		method: "POST",
		body: JSON.stringify({
			...options,
			accountId
		})
	});
};
ElizaClient.prototype.getSignalStatus = async function(accountId = "default") {
	return this.fetch(`/api/signal/status?accountId=${encodeURIComponent(accountId)}`);
};
ElizaClient.prototype.startSignalPairing = async function(accountId = "default") {
	return this.fetch("/api/signal/pair", {
		method: "POST",
		body: JSON.stringify({ accountId })
	});
};
ElizaClient.prototype.stopSignalPairing = async function(accountId = "default") {
	return this.fetch("/api/signal/pair/stop", {
		method: "POST",
		body: JSON.stringify({ accountId })
	});
};
ElizaClient.prototype.disconnectSignal = async function(accountId = "default") {
	return this.fetch("/api/signal/disconnect", {
		method: "POST",
		body: JSON.stringify({ accountId })
	});
};
ElizaClient.prototype.getTelegramAccountStatus = async function() {
	return this.fetch("/api/telegram-account/status");
};
ElizaClient.prototype.startTelegramAccountAuth = async function(phone) {
	return this.fetch("/api/telegram-account/auth/start", {
		method: "POST",
		body: JSON.stringify(typeof phone === "string" && phone.trim().length > 0 ? { phone: phone.trim() } : {})
	});
};
ElizaClient.prototype.submitTelegramAccountAuth = async function(input) {
	return this.fetch("/api/telegram-account/auth/submit", {
		method: "POST",
		body: JSON.stringify(input)
	});
};
ElizaClient.prototype.disconnectTelegramAccount = async function() {
	return this.fetch("/api/telegram-account/disconnect", { method: "POST" });
};
ElizaClient.prototype.getDiscordLocalStatus = async function() {
	return this.fetch("/api/discord-local/status");
};
ElizaClient.prototype.authorizeDiscordLocal = async function() {
	return this.fetch("/api/discord-local/authorize", { method: "POST" });
};
ElizaClient.prototype.disconnectDiscordLocal = async function() {
	return this.fetch("/api/discord-local/disconnect", { method: "POST" });
};
ElizaClient.prototype.listDiscordLocalGuilds = async function() {
	return this.fetch("/api/discord-local/guilds");
};
ElizaClient.prototype.listDiscordLocalChannels = async function(guildId) {
	return this.fetch(`/api/discord-local/channels?guildId=${encodeURIComponent(guildId)}`);
};
ElizaClient.prototype.saveDiscordLocalSubscriptions = async function(channelIds) {
	return this.fetch("/api/discord-local/subscriptions", {
		method: "POST",
		body: JSON.stringify({ channelIds })
	});
};
ElizaClient.prototype.getBlueBubblesStatus = async function() {
	return this.fetch("/api/bluebubbles/status");
};
ElizaClient.prototype.getBabylonAgentStatus = async function() {
	return this.fetch("/api/apps/babylon@elizaos/agent/status");
};
ElizaClient.prototype.getBabylonAgentActivity = async function(opts) {
	const params = new URLSearchParams();
	if (opts?.limit) params.set("limit", String(opts.limit));
	if (opts?.type) params.set("type", opts.type);
	const qs = params.toString();
	return this.fetch(`/api/apps/babylon@elizaos/agent/activity${qs ? `?${qs}` : ""}`);
};
ElizaClient.prototype.getBabylonAgentLogs = async function(opts) {
	const params = new URLSearchParams();
	if (opts?.type) params.set("type", opts.type);
	if (opts?.level) params.set("level", opts.level);
	const qs = params.toString();
	return this.fetch(`/api/apps/babylon@elizaos/agent/logs${qs ? `?${qs}` : ""}`);
};
ElizaClient.prototype.getBabylonAgentWallet = async function() {
	return this.fetch("/api/apps/babylon@elizaos/agent/wallet");
};
ElizaClient.prototype.getBabylonTeam = async function() {
	return this.fetch("/api/apps/babylon/team");
};
ElizaClient.prototype.getBabylonTeamChat = async function() {
	return this.fetch("/api/apps/babylon/team/info");
};
ElizaClient.prototype.sendBabylonTeamChat = async function(content, mentions) {
	return this.fetch("/api/apps/babylon/team/chat", {
		method: "POST",
		body: JSON.stringify({
			content,
			mentions
		})
	});
};
ElizaClient.prototype.toggleBabylonAgent = async function(action) {
	return this.fetch("/api/apps/babylon@elizaos/agent/toggle", {
		method: "POST",
		body: JSON.stringify({ action })
	});
};
ElizaClient.prototype.toggleBabylonAgentAutonomy = async function(opts) {
	return this.fetch("/api/apps/babylon", {
		method: "POST",
		body: JSON.stringify(opts)
	});
};
ElizaClient.prototype.getBabylonPredictionMarkets = async function(opts) {
	const params = new URLSearchParams();
	if (opts?.page) params.set("page", String(opts.page));
	if (opts?.pageSize) params.set("pageSize", String(opts.pageSize));
	if (opts?.status) params.set("status", opts.status);
	if (opts?.category) params.set("category", opts.category);
	const qs = params.toString();
	return this.fetch(`/api/apps/babylon/markets/predictions${qs ? `?${qs}` : ""}`);
};
ElizaClient.prototype.getBabylonPredictionMarket = async function(marketId) {
	return this.fetch(`/api/apps/babylon/markets/predictions/${encodeURIComponent(marketId)}`);
};
ElizaClient.prototype.buyBabylonPredictionShares = async function(marketId, side, amount) {
	return this.fetch(`/api/apps/babylon/markets/predictions/${encodeURIComponent(marketId)}/buy`, {
		method: "POST",
		body: JSON.stringify({
			side,
			amount
		})
	});
};
ElizaClient.prototype.sellBabylonPredictionShares = async function(marketId, side, amount) {
	return this.fetch(`/api/apps/babylon/markets/predictions/${encodeURIComponent(marketId)}/sell`, {
		method: "POST",
		body: JSON.stringify({
			side,
			amount
		})
	});
};
ElizaClient.prototype.getBabylonPerpMarkets = async function() {
	return this.fetch("/api/apps/babylon/markets/perps");
};
ElizaClient.prototype.getBabylonOpenPerpPositions = async function() {
	return this.fetch("/api/apps/babylon/markets/perps/open");
};
ElizaClient.prototype.closeBabylonPerpPosition = async function(positionId) {
	return this.fetch(`/api/apps/babylon/markets/perps/position/${encodeURIComponent(positionId)}/close`, {
		method: "POST",
		body: JSON.stringify({})
	});
};
ElizaClient.prototype.getBabylonPosts = async function(opts) {
	const params = new URLSearchParams();
	if (opts?.page) params.set("page", String(opts.page));
	if (opts?.limit) params.set("limit", String(opts.limit));
	if (opts?.feed) params.set("feed", opts.feed);
	const qs = params.toString();
	return this.fetch(`/api/apps/babylon/posts${qs ? `?${qs}` : ""}`);
};
ElizaClient.prototype.createBabylonPost = async function(content, marketId) {
	return this.fetch("/api/apps/babylon/posts", {
		method: "POST",
		body: JSON.stringify({
			content,
			marketId
		})
	});
};
ElizaClient.prototype.commentOnBabylonPost = async function(postId, content) {
	return this.fetch(`/api/apps/babylon/posts/${encodeURIComponent(postId)}/comments`, {
		method: "POST",
		body: JSON.stringify({ content })
	});
};
ElizaClient.prototype.likeBabylonPost = async function(postId) {
	return this.fetch(`/api/apps/babylon/posts/${encodeURIComponent(postId)}/like`, { method: "POST" });
};
ElizaClient.prototype.getBabylonChats = async function() {
	return this.fetch("/api/apps/babylon/chats");
};
ElizaClient.prototype.getBabylonChatMessages = async function(chatId) {
	return this.fetch(`/api/apps/babylon/chats/${encodeURIComponent(chatId)}/messages`);
};
ElizaClient.prototype.sendBabylonChatMessage = async function(chatId, content) {
	return this.fetch(`/api/apps/babylon/chats/${encodeURIComponent(chatId)}/message`, {
		method: "POST",
		body: JSON.stringify({ content })
	});
};
ElizaClient.prototype.getBabylonDM = async function(userId) {
	return this.fetch(`/api/apps/babylon/chats/dm?userId=${encodeURIComponent(userId)}`);
};
ElizaClient.prototype.getBabylonAgentGoals = async function() {
	return this.fetch("/api/apps/babylon@elizaos/agent/goals");
};
ElizaClient.prototype.getBabylonAgentStats = async function() {
	return this.fetch("/api/apps/babylon@elizaos/agent/stats");
};
ElizaClient.prototype.getBabylonAgentSummary = async function() {
	return this.fetch("/api/apps/babylon@elizaos/agent/summary");
};
ElizaClient.prototype.getBabylonAgentRecentTrades = async function() {
	return this.fetch("/api/apps/babylon@elizaos/agent/recent-trades");
};
ElizaClient.prototype.getBabylonAgentTradingBalance = async function() {
	return this.fetch("/api/apps/babylon@elizaos/agent/trading-balance");
};
ElizaClient.prototype.sendBabylonAgentChat = async function(content) {
	return this.fetch("/api/apps/babylon@elizaos/agent/chat", {
		method: "POST",
		body: JSON.stringify({ content })
	});
};
ElizaClient.prototype.getBabylonAgentChat = async function() {
	return this.fetch("/api/apps/babylon@elizaos/agent/chat");
};
ElizaClient.prototype.getBabylonFeedForYou = async function() {
	return this.fetch("/api/apps/babylon/feed/for-you");
};
ElizaClient.prototype.getBabylonFeedHot = async function() {
	return this.fetch("/api/apps/babylon/feed/hot");
};
ElizaClient.prototype.getBabylonTrades = async function() {
	return this.fetch("/api/apps/babylon/trades");
};
ElizaClient.prototype.discoverBabylonAgents = async function() {
	return this.fetch("/api/apps/babylon@elizaos/agents/discover");
};
ElizaClient.prototype.getBabylonTeamDashboard = async function() {
	return this.fetch("/api/apps/babylon/team/dashboard");
};
ElizaClient.prototype.getBabylonTeamConversations = async function() {
	return this.fetch("/api/apps/babylon/team/conversations");
};
ElizaClient.prototype.pauseAllBabylonAgents = async function() {
	return this.fetch("/api/apps/babylon/admin@elizaos/agents/pause-all", { method: "POST" });
};
ElizaClient.prototype.resumeAllBabylonAgents = async function() {
	return this.fetch("/api/apps/babylon/admin@elizaos/agents/resume-all", { method: "POST" });
};

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/client-vault.js
/**
* Vault domain methods — saved-login autofill for the in-app browser.
*
* Mirrors the wallet-shim contract: the in-tab preload sends
* `__elizaVaultAutofillRequest` to the host, the host calls these
* methods, then replies via `tag.executeJavascript("window.__elizaVaultReply(...)")`.
*
* The list endpoint aggregates entries from every signed-in backend:
* in-house vault, 1Password, and Bitwarden. Each entry carries a
* `source` + `identifier` pair so callers can reveal credentials
* uniformly via `revealSavedLogin(source, identifier)`.
*/
ElizaClient.prototype.listSavedLogins = async function(domain) {
	const path = domain ? `/api/secrets/logins?domain=${encodeURIComponent(domain)}` : "/api/secrets/logins";
	const res = await this.fetch(path);
	return {
		logins: res.logins,
		failures: res.failures
	};
};
ElizaClient.prototype.revealSavedLogin = async function(source, identifier) {
	const path = `/api/secrets/logins/reveal?${new URLSearchParams({
		source,
		identifier
	}).toString()}`;
	return (await this.fetch(path)).login;
};
ElizaClient.prototype.saveSavedLogin = async function(input) {
	await this.fetch("/api/secrets/logins", {
		method: "POST",
		body: JSON.stringify(input)
	});
};
ElizaClient.prototype.deleteSavedLogin = async function(domain, username) {
	const path = `/api/secrets/logins/${encodeURIComponent(domain)}/${encodeURIComponent(username)}`;
	await this.fetch(path, { method: "DELETE" });
};
ElizaClient.prototype.getAutofillAllowed = async function(domain) {
	const path = `/api/secrets/logins/${encodeURIComponent(domain)}/autoallow`;
	return (await this.fetch(path)).allowed;
};
ElizaClient.prototype.setAutofillAllowed = async function(domain, allowed) {
	const path = `/api/secrets/logins/${encodeURIComponent(domain)}/autoallow`;
	await this.fetch(path, {
		method: "PUT",
		body: JSON.stringify({ allowed })
	});
};

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/client-wallet.js
/**
* Wallet domain methods — wallet addresses/balances, BSC trading, steward,
* trading profile, registry (ERC-8004), drop/mint, whitelist, twitter verify.
*/
ElizaClient.prototype.getWalletAddresses = async function() {
	return this.fetch("/api/wallet/addresses");
};
ElizaClient.prototype.getWalletBalances = async function() {
	return this.fetch("/api/wallet/balances");
};
ElizaClient.prototype.getWalletNfts = async function() {
	return this.fetch("/api/wallet/nfts");
};
ElizaClient.prototype.getWalletConfig = async function() {
	return this.fetch("/api/wallet/config");
};
ElizaClient.prototype.updateWalletConfig = async function(config) {
	return this.fetch("/api/wallet/config", {
		method: "PUT",
		body: JSON.stringify(config)
	});
};
ElizaClient.prototype.refreshCloudWallets = async function() {
	return this.fetch("/api/wallet/refresh-cloud", { method: "POST" });
};
ElizaClient.prototype.setWalletPrimary = async function(params) {
	return this.fetch("/api/wallet/primary", {
		method: "POST",
		body: JSON.stringify(params)
	});
};
ElizaClient.prototype.generateWallet = async function(params = {}) {
	return this.fetch("/api/wallet/generate", {
		method: "POST",
		body: JSON.stringify(params)
	});
};
ElizaClient.prototype.exportWalletKeys = async function(exportToken) {
	return this.fetch("/api/wallet/export", {
		method: "POST",
		body: JSON.stringify({
			confirm: true,
			exportToken
		})
	});
};
ElizaClient.prototype.getBscTradePreflight = async function(tokenAddress) {
	return this.fetch("/api/wallet/trade/preflight", {
		method: "POST",
		body: JSON.stringify(tokenAddress?.trim() ? { tokenAddress: tokenAddress.trim() } : {})
	});
};
ElizaClient.prototype.getBscTradeQuote = async function(request) {
	return this.fetch("/api/wallet/trade/quote", {
		method: "POST",
		body: JSON.stringify(request)
	});
};
ElizaClient.prototype.executeBscTrade = async function(request) {
	return this.fetch("/api/wallet/trade/execute", {
		method: "POST",
		body: JSON.stringify(request)
	});
};
ElizaClient.prototype.executeBscTransfer = async function(request) {
	return this.fetch("/api/wallet/transfer/execute", {
		method: "POST",
		body: JSON.stringify(request)
	});
};
ElizaClient.prototype.getBscTradeTxStatus = async function(hash) {
	return this.fetch(`/api/wallet/trade/tx-status?hash=${encodeURIComponent(hash)}`);
};
ElizaClient.prototype.getStewardStatus = async function() {
	return this.fetch("/api/wallet/steward-status");
};
ElizaClient.prototype.getStewardAddresses = async function() {
	return this.fetch("/api/wallet/steward-addresses");
};
ElizaClient.prototype.getStewardBalance = async function(chainId) {
	const qs = chainId == null ? "" : `?chainId=${encodeURIComponent(String(chainId))}`;
	return this.fetch(`/api/wallet/steward-balances${qs}`);
};
ElizaClient.prototype.getStewardTokens = async function(chainId) {
	const qs = chainId == null ? "" : `?chainId=${encodeURIComponent(String(chainId))}`;
	return this.fetch(`/api/wallet/steward-tokens${qs}`);
};
ElizaClient.prototype.getStewardWebhookEvents = async function(opts) {
	const params = new URLSearchParams();
	if (opts?.event) params.set("event", opts.event);
	if (opts?.since != null) params.set("since", String(opts.since));
	const qs = params.toString();
	return this.fetch(`/api/wallet/steward-webhook-events${qs ? `?${qs}` : ""}`);
};
ElizaClient.prototype.getStewardPolicies = async function() {
	return this.fetch("/api/wallet/steward-policies");
};
ElizaClient.prototype.setStewardPolicies = async function(policies) {
	await this.fetch("/api/wallet/steward-policies", {
		method: "PUT",
		body: JSON.stringify({ policies })
	});
};
ElizaClient.prototype.getStewardHistory = async function(opts) {
	const params = new URLSearchParams();
	if (opts?.status) params.set("status", opts.status);
	if (opts?.limit != null) params.set("limit", String(opts.limit));
	if (opts?.offset != null) params.set("offset", String(opts.offset));
	const qs = params.toString();
	return this.fetch(`/api/wallet/steward-tx-records${qs ? `?${qs}` : ""}`);
};
ElizaClient.prototype.getStewardPending = async function() {
	return this.fetch("/api/wallet/steward-pending-approvals");
};
ElizaClient.prototype.approveStewardTx = async function(txId) {
	return this.fetch("/api/wallet/steward-approve-tx", {
		method: "POST",
		body: JSON.stringify({ txId })
	});
};
ElizaClient.prototype.rejectStewardTx = async function(txId, reason) {
	return this.fetch("/api/wallet/steward-deny-tx", {
		method: "POST",
		body: JSON.stringify({
			txId,
			reason
		})
	});
};
ElizaClient.prototype.signViaSteward = async function(request) {
	return this.fetch("/api/wallet/steward-sign", {
		method: "POST",
		body: JSON.stringify(request)
	});
};
ElizaClient.prototype.sendBrowserWalletTransaction = async function(request) {
	return this.fetch("/api/wallet/browser-transaction", {
		method: "POST",
		body: JSON.stringify(request)
	});
};
ElizaClient.prototype.signBrowserWalletMessage = async function(message) {
	return this.fetch("/api/wallet/browser-sign-message", {
		method: "POST",
		body: JSON.stringify({ message })
	});
};
ElizaClient.prototype.signBrowserSolanaMessage = async function(request) {
	return this.fetch("/api/wallet/browser-solana-sign-message", {
		method: "POST",
		body: JSON.stringify(request)
	});
};
ElizaClient.prototype.sendBrowserSolanaTransaction = async function(request) {
	return this.fetch("/api/wallet/browser-solana-transaction", {
		method: "POST",
		body: JSON.stringify(request)
	});
};
ElizaClient.prototype.getWalletMarketOverview = async function() {
	return this.fetch("/api/wallet/market-overview");
};
ElizaClient.prototype.getWalletTradingProfile = async function(window = "30d", source = "all") {
	const params = new URLSearchParams({
		window,
		source
	});
	return this.fetch(`/api/wallet/trading/profile?${params.toString()}`);
};
ElizaClient.prototype.applyProductionWalletDefaults = async function() {
	return this.fetch("/api/wallet/production-defaults", {
		method: "POST",
		body: JSON.stringify({ confirm: true })
	});
};
ElizaClient.prototype.getRegistryStatus = async function() {
	return this.fetch("/api/registry/status");
};
ElizaClient.prototype.registerAgent = async function(params) {
	return this.fetch("/api/registry/register", {
		method: "POST",
		body: JSON.stringify(params ?? {})
	});
};
ElizaClient.prototype.updateRegistryTokenURI = async function(tokenURI) {
	return this.fetch("/api/registry/update-uri", {
		method: "POST",
		body: JSON.stringify({ tokenURI })
	});
};
ElizaClient.prototype.syncRegistryProfile = async function(params) {
	return this.fetch("/api/registry/sync", {
		method: "POST",
		body: JSON.stringify(params ?? {})
	});
};
ElizaClient.prototype.getRegistryConfig = async function() {
	return this.fetch("/api/registry/config");
};
ElizaClient.prototype.getDropStatus = async function() {
	return this.fetch("/api/drop/status");
};
ElizaClient.prototype.mintAgent = async function(params) {
	return this.fetch("/api/drop/mint", {
		method: "POST",
		body: JSON.stringify(params ?? {})
	});
};
ElizaClient.prototype.mintAgentWhitelist = async function(params) {
	return this.fetch("/api/drop/mint-whitelist", {
		method: "POST",
		body: JSON.stringify(params)
	});
};
ElizaClient.prototype.getWhitelistStatus = async function() {
	return this.fetch("/api/whitelist/status");
};
ElizaClient.prototype.generateTwitterVerificationMessage = async function() {
	return this.fetch("/api/whitelist/twitter/message", { method: "POST" });
};
ElizaClient.prototype.verifyTwitter = async function(tweetUrl) {
	return this.fetch("/api/whitelist/twitter/verify", {
		method: "POST",
		body: JSON.stringify({ tweetUrl })
	});
};

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/client.js
/**
* API client for the backend.
*
* Thin fetch wrapper + WebSocket for real-time chat/events.
* Replaces the gateway WebSocket protocol entirely.
*
* The ElizaClient class is defined in client-base.ts and re-exported here.
* Domain methods are defined via declaration merging + prototype augmentation
* in the companion files: client-agent, client-chat, client-wallet,
* client-cloud, client-skills, client-computeruse, client-imessage.
*/
const client = new ElizaClient();

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/utils/format.js
/**
* Shared formatting helpers for Eliza app views.
*/
/**
* Format an uptime duration in seconds into a compact human string.
*
* When `verbose` is true the output uses every non-zero unit (e.g. "2d 3h 15m").
* Otherwise the two most-significant units are returned (e.g. "2d 3h").
*/
function formatUptime(seconds, verbose) {
	if (seconds == null || seconds < 0) return "—";
	const d = Math.floor(seconds / 86400);
	const h = Math.floor(seconds % 86400 / 3600);
	const m = Math.floor(seconds % 3600 / 60);
	const s = Math.floor(seconds % 60);
	if (verbose) {
		const parts = [];
		if (d > 0) parts.push(`${d}d`);
		if (h > 0) parts.push(`${h}h`);
		if (m > 0) parts.push(`${m}m`);
		if (parts.length === 0) parts.push(`${s}s`);
		return parts.join(" ");
	}
	if (d > 0) return `${d}d ${h}h`;
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m`;
	return `${s}s`;
}
/**
* Format a byte count in human-readable units.
*/
function formatByteSize(bytes, options = {}) {
	const { unknownLabel = "unknown", kbPrecision = 1, mbPrecision = 1, gbPrecision = 1, tbPrecision = 1 } = options;
	if (!Number.isFinite(bytes) || bytes < 0) return unknownLabel;
	if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(tbPrecision)} TB`;
	if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(gbPrecision)} GB`;
	if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(mbPrecision)} MB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(kbPrecision)} KB`;
	return `${bytes} B`;
}
/**
* Format timestamp / date for locale display (`toLocaleString`).
*/
function formatDateTime(value, options = {}) {
	const { fallback = "—", locale } = options;
	if (value == null || value === "") return fallback;
	const parsed = value instanceof Date ? value : new Date(value);
	if (!Number.isFinite(parsed.getTime())) return fallback;
	return parsed.toLocaleString(locale);
}
/**
* Format timestamp / date as locale time only (`toLocaleTimeString`).
*/
function formatTime(value, options = {}) {
	const { fallback = "—", locale } = options;
	if (value == null || value === "") return fallback;
	const parsed = value instanceof Date ? value : new Date(value);
	if (!Number.isFinite(parsed.getTime())) return fallback;
	return parsed.toLocaleTimeString(locale);
}
/**
* Format timestamp / date as locale date only (`toLocaleDateString`).
*/
function formatShortDate(value, options = {}) {
	const { fallback = "—", locale } = options;
	if (value == null || value === "") return fallback;
	const parsed = value instanceof Date ? value : new Date(value);
	if (!Number.isFinite(parsed.getTime())) return fallback;
	return parsed.toLocaleDateString(locale, {
		year: "numeric",
		month: "short",
		day: "numeric"
	});
}
/**
* Format an elapsed duration in milliseconds into a compact human string.
*/
function formatDurationMs(ms, options = {}) {
	const { fallback = "—", t } = options;
	if (ms == null || !Number.isFinite(ms) || ms < 0) return fallback;
	if (ms < 6e4) {
		const value = Math.round(ms / 1e3);
		return t ? t("format.duration.seconds", { value }) : `${value}s`;
	}
	if (ms < 36e5) {
		const value = Math.round(ms / 6e4);
		return t ? t("format.duration.minutes", { value }) : `${value}m`;
	}
	if (ms < 864e5) {
		const hours = ms / 36e5;
		const value = hours === Math.floor(hours) ? hours : Number(hours.toFixed(1));
		return t ? t("format.duration.hours", { value }) : `${value}h`;
	}
	const days = ms / 864e5;
	const value = days === Math.floor(days) ? days : Number(days.toFixed(1));
	return t ? t("format.duration.days", { value }) : `${value}d`;
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/state/useApp.js
const AppContext = createContext(null);
function useApp() {
	const ctx = useContext(AppContext);
	if (!ctx) throw new Error("useApp must be used within AppProvider");
	return ctx;
}

//#endregion
export { setElizaApiToken as A, computeStreamingDelta as C, getElizaApiBase as D, clearElizaApiToken as E, setBootConfig as F, syncBrandEnvToEliza as I, syncElizaEnvToBrand as L, DEFAULT_BOOT_CONFIG as M, getBootConfig as N, getElizaApiToken as O, resolveCharacterCatalog as P, mapTaskThreadsToCodingAgentSessions as S, clearElizaApiBase as T, mapServerTasksToSessions as _, formatDurationMs as a, isApiError as b, formatUptime as c, client as d, normalizeWalletRpcProviderId as f, TERMINAL_STATUSES as g, STATUS_DOT as h, formatDateTime as i, stripAssistantStageDirections as j, setElizaApiBase as k, DEFAULT_WALLET_RPC_SELECTIONS$1 as l, PULSE_STATUSES as m, useApp as n, formatShortDate as o, normalizeWalletRpcSelections$1 as p, formatByteSize as r, formatTime as s, AppContext as t, WALLET_RPC_PROVIDER_OPTIONS$1 as u, ElizaClient as v, mergeStreamingText as w, mapPtySessionsToCodingAgentSessions as x, ApiError as y };
/**
 * Android in-process route dispatch for the stdio bridge (#12352, #12180 phase 2).
 *
 * Turns a native NDJSON `http_request` / `http_request_stream` frame into an
 * in-process `dispatchRoute` call — the same route kernel the HTTP server runs,
 * with no loopback TCP hop. `dispatchBufferedRequest` returns the response
 * envelope `ElizaAgentService.requestLocalAgent` used to build from an
 * `HttpURLConnection` (status/statusText/headers/body/bodyBase64/bodyEncoding),
 * so `AgentPlugin.request` and the WebView `AgentRequestTransport` contract stay
 * byte-for-byte stable. `dispatchStreamingRequest` drives an incremental sink
 * (response head → base64 chunks → complete) so the chat SSE reply still streams
 * token-by-token onto the WebView's `agentStream*` events.
 *
 * The runtime handle + `dispatchRoute` are supplied by the caller (the Android
 * bridge CLI, which boots the port-free local-agent runtime). This module owns
 * only the path/header/body marshalling and the in-process authorization stance:
 * a sealed native pipe from the app's own WebView is always authorized — no
 * external attacker can inject frames into an anonymous stdio pipe.
 */

import { Buffer } from "node:buffer";
import type {
	AgentNotification,
	IAgentRuntime,
	RouteHandlerResult,
} from "@elizaos/core";
import { NotificationService, ServiceType } from "@elizaos/core";
import type { StdioBridgeStreamSink } from "../shared/stdio-bridge.ts";

/** In-process route dispatcher (from `@elizaos/agent/api`). */
export type AndroidDispatchRoute = (args: {
	runtime: IAgentRuntime;
	method: string;
	path: string;
	headers: Record<string, string>;
	query: Record<string, string | string[]>;
	body: unknown;
	inProcess: true;
	isAuthorized: () => true;
	/** Incremental sink for legacy SSE handlers — set only for streaming. */
	onChunk?: (chunk: Buffer) => void;
}) => Promise<RouteHandlerResult | null | undefined>;

/** The `http_request` / `http_request_stream` payload the native side sends. */
export interface AndroidRequestPayload {
	method?: unknown;
	path?: unknown;
	headers?: unknown;
	body?: unknown;
	timeoutMs?: unknown;
}

/** Buffered response envelope — the exact shape the loopback path returned. */
export interface AndroidBufferedResponse {
	status: number;
	statusText: string;
	headers: Record<string, string>;
	body: string;
	bodyBase64: string;
	bodyEncoding: "base64";
}

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
		path.startsWith("/") && !path.startsWith("//") && !path.includes("://")
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

/** Coerce the native string/JSON body into what dispatchRoute expects on `body`. */
function payloadBody(payload: AndroidRequestPayload): unknown {
	const raw = payload.body;
	if (raw == null) return undefined;
	return raw;
}

const STATUS_TEXT: Record<number, string> = {
	200: "OK",
	201: "Created",
	202: "Accepted",
	204: "No Content",
	301: "Moved Permanently",
	302: "Found",
	304: "Not Modified",
	400: "Bad Request",
	401: "Unauthorized",
	403: "Forbidden",
	404: "Not Found",
	405: "Method Not Allowed",
	409: "Conflict",
	422: "Unprocessable Entity",
	429: "Too Many Requests",
	500: "Internal Server Error",
	502: "Bad Gateway",
	503: "Service Unavailable",
	504: "Gateway Timeout",
};

function statusText(status: number): string {
	return STATUS_TEXT[status] ?? "";
}

function jsonResponse(
	status: number,
	body: unknown,
	headers: Record<string, string> = {},
): AndroidBufferedResponse {
	const text = JSON.stringify(body);
	return {
		status,
		statusText: statusText(status),
		headers: {
			"content-type": "application/json; charset=utf-8",
			...headers,
		},
		body: text,
		bodyBase64: Buffer.from(text, "utf8").toString("base64"),
		bodyEncoding: "base64",
	};
}

function runtimeAgentName(runtime: IAgentRuntime): string {
	const character = (runtime as { character?: { name?: unknown } }).character;
	return typeof character?.name === "string" && character.name.trim()
		? character.name.trim()
		: "Eliza";
}

/** The persisted-config seams the first-run routes read/write (from @elizaos/agent). */
export interface AndroidCoreRouteDeps {
	configFileExists: () => boolean;
	loadElizaConfig: () => AndroidElizaConfigLike;
	saveElizaConfig: (config: AndroidElizaConfigLike) => void;
	hasPersistedFirstRunState: (config: AndroidElizaConfigLike) => boolean;
}

/** Structural stand-in for ElizaConfig — the bridge only touches `meta`. */
export type AndroidElizaConfigLike = Record<string, unknown> & {
	meta?: Record<string, unknown>;
};

/**
 * Structural view of the runtime NotificationService the bridge serves the
 * `/api/notifications` surface against. The service lives on the runtime, so
 * the bridge does not need to import the agent's HTTP route module — it drives
 * the same service the HTTP `handleNotificationRoute` does (list/read/remove/
 * clear), which is what the dashboard notification center hydrates from.
 */
interface AndroidNotificationServiceLike {
	list: (query?: {
		unreadOnly?: boolean;
		category?: string;
		limit?: number;
	}) => AgentNotification[];
	getUnreadCount: () => number;
	markRead: (id: string) => Promise<boolean>;
	markAllRead: () => Promise<number>;
	remove: (id: string) => Promise<boolean>;
	clear: () => Promise<void>;
}

function isAndroidNotifier(
	value: unknown,
): value is AndroidNotificationServiceLike {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as AndroidNotificationServiceLike).list === "function" &&
		typeof (value as AndroidNotificationServiceLike).markRead === "function"
	);
}

/**
 * Serve the `/api/notifications` inbox surface over the Android UDS. These are
 * server-level routes (not plugin `runtime.routes`), so `dispatchRoute` never
 * matches them and the loopback 404s — which left the dashboard notification
 * center empty on every on-device local boot (the store's hydrate `GET
 * /api/notifications` failed). Drives the runtime NotificationService directly,
 * mirroring how first-run/health are inline-served above. Returns null for
 * anything outside the inbox verbs (incl. the push-tokens sub-namespace, which
 * the push service owns) so it falls through to the plugin dispatcher.
 */
async function directAndroidNotificationRoute(
	runtime: IAgentRuntime,
	method: string,
	pathname: string,
	query: Record<string, string | string[]>,
): Promise<AndroidBufferedResponse | null> {
	const queryValue = (key: string): string | undefined => {
		const raw = query[key];
		return Array.isArray(raw) ? raw[0] : raw;
	};
	if (!pathname.startsWith("/api/notifications")) return null;
	// Push-token registration is owned by the push delivery service, not the
	// inbox — leave it to the normal dispatcher.
	if (pathname.startsWith("/api/notifications/push-tokens")) return null;

	const service = runtime.getService(ServiceType.NOTIFICATION);
	if (!isAndroidNotifier(service)) {
		const availability = NotificationService.getAvailability(runtime);
		if (availability === "disabled") {
			if (method === "GET" && pathname === "/api/notifications") {
				return jsonResponse(200, {
					notifications: [],
					unreadCount: 0,
					serviceStatus: "disabled",
				});
			}
			return jsonResponse(503, {
				error: "Notification service is disabled",
				code: "NOTIFICATION_SERVICE_DISABLED",
			});
		}
		if (availability === "failed") {
			const recovery = NotificationService.requestRecovery(runtime);
			return jsonResponse(
				503,
				{
					error: "Notification inbox is temporarily unavailable",
					code: "NOTIFICATION_SERVICE_FAILED",
					retryAfter: recovery.retryAfterSeconds,
				},
				{ "retry-after": String(recovery.retryAfterSeconds) },
			);
		}
		return jsonResponse(
			503,
			{
				error: "Notification service is still starting",
				code: "NOTIFICATION_SERVICE_NOT_READY",
				retryAfter: 1,
			},
			{ "retry-after": "1" },
		);
	}

	if (method === "GET" && pathname === "/api/notifications") {
		const limitRaw = queryValue("limit");
		const parsedLimit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
		const limit =
			typeof parsedLimit === "number" &&
			Number.isFinite(parsedLimit) &&
			parsedLimit >= 0
				? Math.min(parsedLimit, 500)
				: undefined;
		const notifications = service.list({
			unreadOnly: queryValue("unreadOnly") === "true",
			category: queryValue("category"),
			limit,
		});
		return jsonResponse(200, {
			notifications,
			unreadCount: service.getUnreadCount(),
			serviceStatus: "ready",
		});
	}

	if (method === "POST" && pathname === "/api/notifications/read-all") {
		const changed = await service.markAllRead();
		return jsonResponse(200, { changed });
	}

	const readMatch = pathname.match(/^\/api\/notifications\/([^/]+)\/read$/);
	if (method === "POST" && readMatch) {
		const ok = await service.markRead(decodeURIComponent(readMatch[1]));
		return jsonResponse(200, { ok });
	}

	if (method === "DELETE" && pathname === "/api/notifications") {
		await service.clear();
		return jsonResponse(200, { ok: true });
	}

	const idMatch = pathname.match(/^\/api\/notifications\/([^/]+)$/);
	if (method === "DELETE" && idMatch) {
		const ok = await service.remove(decodeURIComponent(idMatch[1]));
		return jsonResponse(200, { ok });
	}

	// A known notifications sub-path with an unsupported verb — 404 here rather
	// than letting the plugin dispatcher's `:id` matchers mis-handle it.
	return jsonResponse(404, { error: "notification route not found" });
}

function directAndroidCoreRoute(
	runtime: IAgentRuntime,
	method: string,
	pathname: string,
	coreRoutes?: AndroidCoreRouteDeps,
): AndroidBufferedResponse | null {
	if (method === "GET" && pathname === "/api/health") {
		return jsonResponse(200, {
			ready: true,
			runtime: "ok",
			database: "ok",
			plugins: {
				loaded: Array.isArray((runtime as { plugins?: unknown }).plugins)
					? ((runtime as { plugins?: unknown[] }).plugins?.length ?? 0)
					: 0,
				failed: 0,
			},
			coordinator: "not_wired",
			agentState: "running",
			agentName: runtimeAgentName(runtime),
			startedAt: null,
			uptime: 0,
			androidBridge: "uds",
		});
	}

	if (method === "GET" && pathname === "/api/status") {
		return jsonResponse(200, {
			state: "running",
			agentName: runtimeAgentName(runtime),
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
			androidBridge: "uds",
		});
	}

	if (method === "GET" && pathname === "/api/apps/runs") {
		return jsonResponse(200, []);
	}

	if (method === "GET" && pathname === "/api/first-run/status") {
		let complete = false;
		try {
			complete = Boolean(
				coreRoutes?.configFileExists() &&
					coreRoutes.hasPersistedFirstRunState(coreRoutes.loadElizaConfig()),
			);
		} catch {
			// error-policy:J3 an unreadable config cannot prove onboarding completion.
			// Fail closed to "onboarding required" instead of skipping first-run on Android.
			complete = false;
		}
		return jsonResponse(200, {
			complete,
			cloudProvisioned: false,
			deploymentTarget: "local",
		});
	}

	if (method === "POST" && pathname === "/api/first-run") {
		if (!coreRoutes) {
			return jsonResponse(503, {
				error: "config_unavailable",
				reason: "config_unavailable",
			});
		}
		try {
			const config: AndroidElizaConfigLike = coreRoutes.configFileExists()
				? coreRoutes.loadElizaConfig()
				: {};
			config.meta = { ...(config.meta ?? {}), firstRunComplete: true };
			coreRoutes.saveElizaConfig(config);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return jsonResponse(500, {
				error: `Failed to persist first-run completion: ${message}`,
			});
		}
		return jsonResponse(200, {
			ok: true,
			complete: true,
			deploymentTarget: "local",
		});
	}

	if (method === "GET" && pathname === "/api/auth/me") {
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
				role: "OWNER",
			},
		});
	}

	if (method === "GET" && pathname === "/api/auth/status") {
		return jsonResponse(200, {
			required: false,
			authenticated: true,
			loginRequired: false,
			bootstrapRequired: false,
			pairingEnabled: false,
			expiresAt: null,
			enabled: false,
			cloudProvisioned: false,
			passwordConfigured: false,
			localAccess: true,
			mode: "local",
		});
	}

	if (method === "POST" && pathname === "/api/auth/bootstrap/exchange") {
		return jsonResponse(503, {
			error: "db_unavailable",
			reason: "db_unavailable",
		});
	}

	return null;
}

/** Serialize a RouteHandlerResult body to raw bytes, mirroring the HTTP path. */
function resultBodyBytes(result: RouteHandlerResult): {
	bytes: Buffer;
	headers: Record<string, string>;
} {
	const headers = { ...(result.headers ?? {}) };
	const body = result.body;
	let bytes: Buffer;
	if (body == null) {
		bytes = Buffer.alloc(0);
	} else if (typeof body === "string") {
		bytes = Buffer.from(body, "utf8");
	} else if (Buffer.isBuffer(body)) {
		bytes = body;
	} else if (body instanceof Uint8Array) {
		bytes = Buffer.from(body);
	} else {
		bytes = Buffer.from(JSON.stringify(body), "utf8");
		if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
			headers["content-type"] = "application/json; charset=utf-8";
		}
	}
	return { bytes, headers };
}

function notFound(method: string, pathname: string): AndroidBufferedResponse {
	const body = JSON.stringify({
		error: `No local route for ${method} ${pathname}`,
		code: "not_found",
	});
	return {
		status: 404,
		statusText: "Not Found",
		headers: { "content-type": "application/json; charset=utf-8" },
		body,
		bodyBase64: Buffer.from(body, "utf8").toString("base64"),
		bodyEncoding: "base64",
	};
}

/**
 * Dispatch one buffered request in-process and return the loopback-shaped
 * envelope. Throws on an invalid path/method (the caller surfaces it as an
 * error frame). A body arrives already-buffered because this resolves only after
 * the handler runs to `res.end()`.
 */
export async function dispatchBufferedRequest(
	runtime: IAgentRuntime,
	dispatchRoute: AndroidDispatchRoute,
	payload: AndroidRequestPayload,
	coreRoutes?: AndroidCoreRouteDeps,
): Promise<AndroidBufferedResponse> {
	const rawPath = typeof payload.path === "string" ? payload.path.trim() : "";
	if (!rawPath || !isSafeLocalPath(rawPath)) {
		throw new Error(
			"Android bridge http_request requires a path that starts with / and is not an absolute URL",
		);
	}
	const method = normalizeMethod(payload.method);
	const headers = normalizeHeaderRecord(payload.headers);
	const { pathname, query } = splitPathAndQuery(rawPath);

	const direct = directAndroidCoreRoute(runtime, method, pathname, coreRoutes);
	if (direct) return direct;

	const notif = await directAndroidNotificationRoute(
		runtime,
		method,
		pathname,
		query,
	);
	if (notif) return notif;

	const result = await dispatchRoute({
		runtime,
		method,
		path: pathname,
		headers,
		query,
		body: payloadBody(payload),
		inProcess: true,
		isAuthorized: () => true,
	});

	if (!result) return notFound(method, pathname);

	const { bytes, headers: responseHeaders } = resultBodyBytes(result);
	return {
		status: result.status,
		statusText: statusText(result.status),
		headers: responseHeaders,
		body: bytes.toString("utf8"),
		bodyBase64: bytes.toString("base64"),
		bodyEncoding: "base64",
	};
}

/**
 * Dispatch one streaming request in-process, pushing the response head and each
 * body fragment into `sink` as they arrive. Two sources of incremental output
 * are handled: a return-shape handler that sets `result.stream` (AsyncIterable),
 * and a legacy SSE handler that flushes via `res.write(...)` — captured by the
 * `onChunk` sink wired into `dispatchRoute`. The head is emitted from the
 * resolved status/headers; the shared kernel emits the terminal `complete`.
 */
export async function dispatchStreamingRequest(
	runtime: IAgentRuntime,
	dispatchRoute: AndroidDispatchRoute,
	payload: AndroidRequestPayload,
	sink: StdioBridgeStreamSink,
	coreRoutes?: AndroidCoreRouteDeps,
): Promise<void> {
	const rawPath = typeof payload.path === "string" ? payload.path.trim() : "";
	if (!rawPath || !isSafeLocalPath(rawPath)) {
		throw new Error(
			"Android bridge http_request_stream requires a path that starts with / and is not an absolute URL",
		);
	}
	const method = normalizeMethod(payload.method);
	const headers = normalizeHeaderRecord(payload.headers);
	const { pathname, query } = splitPathAndQuery(rawPath);

	const direct = directAndroidCoreRoute(runtime, method, pathname, coreRoutes);
	if (direct) {
		sink.emitResponse({
			status: direct.status,
			statusText: direct.statusText,
			headers: direct.headers,
		});
		if (direct.bodyBase64) sink.emitChunk(direct.bodyBase64);
		return;
	}

	// A legacy SSE handler flushes body fragments through `res.write(...)` before
	// it resolves. `dispatchRoute` resolves only after `res.end()`, so we cannot
	// wait for the result to send the head — emit it as soon as the handler
	// starts flushing, then forward every fragment live. `headSent` gates so the
	// return-shape path (below) does not double-send.
	let headSent = false;
	const emitHead = (status: number, h: Record<string, string>): void => {
		if (headSent) return;
		headSent = true;
		sink.emitResponse({ status, statusText: statusText(status), headers: h });
	};

	const result = await dispatchRoute({
		runtime,
		method,
		path: pathname,
		headers,
		query,
		body: payloadBody(payload),
		inProcess: true,
		isAuthorized: () => true,
		onChunk: (chunk) => {
			// SSE handlers set the head before the first write; if the handler
			// bypassed status(), default to 200 so the WebView still sees a head.
			emitHead(200, { "content-type": "text/event-stream" });
			sink.emitChunk(chunk.toString("base64"));
		},
	});

	if (!result) {
		const nf = notFound(method, pathname);
		emitHead(nf.status, nf.headers);
		if (nf.bodyBase64) sink.emitChunk(nf.bodyBase64);
		return;
	}

	// Return-shape streaming handler: emit the head from the result, then iterate.
	if (result.stream) {
		emitHead(result.status, result.headers ?? {});
		for await (const frame of result.stream) {
			const buf =
				typeof frame === "string"
					? Buffer.from(frame, "utf8")
					: Buffer.from(frame);
			if (buf.length > 0) sink.emitChunk(buf.toString("base64"));
		}
		return;
	}

	// Buffered result (handler used res.json/res.send, or an SSE handler already
	// flushed via onChunk). If nothing streamed, emit the whole body as one
	// chunk so a non-streaming route still completes over the streaming channel.
	const { bytes, headers: responseHeaders } = resultBodyBytes(result);
	if (!headSent) {
		emitHead(result.status, responseHeaders);
		if (bytes.length > 0) sink.emitChunk(bytes.toString("base64"));
	}
}

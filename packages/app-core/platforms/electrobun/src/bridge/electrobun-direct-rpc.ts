/**
 * Electrobun Renderer Bridge
 *
 * Exposes the direct the app Electrobun RPC surface in the webview context.
 *
 * This script runs in the webview context (injected as a preload).
 * It uses `Electroview.defineRPC()` + `new Electroview()` to connect to
 * the Bun main process via the Electrobun WebSocket RPC channel.
 *
 * `window.__ELIZA_ELECTROBUN_RPC__` is the only public desktop bridge exposed
 * to renderer code. It mirrors the native Electrobun RPC surface directly:
 * `request.<method>(params)` plus `onMessage(<message>, listener)`.
 */
import { Electroview } from "electrobun/view";
import type { RpcMessageListener } from "../types.js";
import { getBrowserTabsRendererImpl } from "./browser-tabs-renderer-registry.js";
import { ensureElectrobunGlobal } from "./electrobun-stub.js";

type RendererRequestHandler = (params: unknown) => Promise<unknown>;
type RendererBridgeRpc = {
	request: Record<string, RendererRequestHandler>;
	setTransport: (transport: unknown) => void;
};

const listenersByRpcMessage: Record<string, Set<RpcMessageListener>> = {};
const BOOT_CONFIG_STORE_KEY = Symbol.for("elizaos.app.boot-config");
const BOOT_CONFIG_WINDOW_KEY = "__ELIZA_APP_BOOT_CONFIG__";
const RENDERER_LOG_MIRROR_KEY = "__ELIZA_ELECTROBUN_LOG_MIRROR__";

type BootConfig = {
	apiBase?: string;
	apiToken?: string;
	[key: string]: unknown;
};

type BootConfigStore = {
	current: BootConfig;
};

function readRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object") {
		throw new Error("Electrobun RPC params must be an object");
	}
	return value as Record<string, unknown>;
}

function readRequiredString(
	record: Record<string, unknown>,
	key: string,
): string {
	const value = record[key];
	if (typeof value !== "string") {
		throw new Error(`Electrobun RPC param "${key}" must be a string`);
	}
	return value;
}

function readRequiredNumber(
	record: Record<string, unknown>,
	key: string,
): number {
	const value = record[key];
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`Electrobun RPC param "${key}" must be a finite number`);
	}
	return value;
}

// Electrobun's native layer sets these globals before preloads run.
// __electrobun must exist before Electroview.init() tries to write to it.
// If the built-in preload hasn't fired yet (rare edge case), stub it.
ensureElectrobunGlobal();

function updateBootConfig(
	updates: Pick<BootConfig, "apiBase" | "apiToken">,
): void {
	const globalObject = window as Window & Record<PropertyKey, unknown> & {
		[BOOT_CONFIG_WINDOW_KEY]?: BootConfig;
	};
	const currentConfig =
		globalObject[BOOT_CONFIG_WINDOW_KEY] ??
		(globalObject[BOOT_CONFIG_STORE_KEY] as BootConfigStore | undefined)
			?.current ??
		{};
	const nextConfig = {
		...currentConfig,
		...updates,
	};

	globalObject[BOOT_CONFIG_WINDOW_KEY] = nextConfig;
	globalObject[BOOT_CONFIG_STORE_KEY] = { current: nextConfig };
}

function dispatchMessage(messageName: string, payload: unknown): void {
	if (messageName === "apiBaseUpdate") {
		const apiBaseUpdate = payload as { base: string; token?: string };
		window.__ELIZA_API_BASE__ = apiBaseUpdate.base;
		if (apiBaseUpdate.token) {
			Object.defineProperty(window, "__ELIZA_API_TOKEN__", {
				value: apiBaseUpdate.token,
				configurable: true,
				writable: true,
				enumerable: false,
			});
		}
		// Propagate to boot config so the appClient picks up port changes.
		// We modify it directly instead of importing @elizaos/app-core
		// to prevent bundling React and the entire UI layer into the preload script.
		updateBootConfig({
			apiBase: apiBaseUpdate.base,
			...(apiBaseUpdate.token ? { apiToken: apiBaseUpdate.token } : {}),
		});
	}

	const listeners = listenersByRpcMessage[messageName];
	if (!listeners) {
		return;
	}

	for (const listener of Array.from(listeners)) {
		try {
			listener(payload);
		} catch (err) {
			console.error(
				`[ElectrobunBridge] Listener error for ${messageName}:`,
				err,
			);
		}
	}
}

function handleWildcardMessage(messageName: unknown, payload: unknown): void {
	if (typeof messageName === "string") {
		dispatchMessage(messageName, payload);
	}
}

// Electrobun defaults maxRequestTime to 1000ms (see node_modules/electrobun/.../rpc.ts).
// Native sheets + main-process HTTP (disconnect, reset, file pickers) exceed that and
// surface as "RPC request timed out." in the renderer.
const rpc = Electroview.defineRPC({
	maxRequestTime: 600_000,
	handlers: {
		requests: {
			browserWorkspaceRendererEvaluate: async (params: unknown) => {
				const record = readRecord(params);
				const id = readRequiredString(record, "id");
				const script = readRequiredString(record, "script");
				const timeoutMs = readRequiredNumber(record, "timeoutMs");
				getBrowserTabsRendererImpl().evaluate(id, script, timeoutMs);
			},
			browserWorkspaceRendererGetTabRect: async (params: unknown) => {
				const record = readRecord(params);
				return getBrowserTabsRendererImpl().getTabRect(
					readRequiredString(record, "id"),
				);
			},
		},
		messages: {
			"*": handleWildcardMessage,
		},
	},
}) as RendererBridgeRpc;

new Electroview({ rpc });

function summarizeDiagnosticValue(value: unknown): unknown {
	if (value instanceof Error) {
		return {
			name: value.name,
			message: value.message,
			stack: value.stack,
		};
	}
	return value;
}

const instrumentedRequest = new Proxy(rpc.request, {
	get(target, prop, receiver) {
		const value = Reflect.get(target, prop, receiver);
		if (typeof value !== "function") {
			return value;
		}

		return async (params: unknown) => {
			try {
				return await value.call(target, params);
			} catch (error) {
				void rpc.request
					.rendererReportDiagnostic({
						level: "error",
						source: "rpc",
						message: `Electrobun RPC request failed: ${String(prop)}`,
						details: summarizeDiagnosticValue(error),
					})
					.catch(() => {
						// Best effort only.
					});
				throw error;
			}
		};
	},
}) as RendererBridgeRpc["request"];

const electrobunRpc = {
	request: instrumentedRequest,
	onMessage: (messageName: string, listener: RpcMessageListener): void => {
		if (!listenersByRpcMessage[messageName]) {
			listenersByRpcMessage[messageName] = new Set();
		}
		listenersByRpcMessage[messageName].add(listener);
	},
	offMessage: (messageName: string, listener: RpcMessageListener): void => {
		listenersByRpcMessage[messageName]?.delete(listener);
		if (listenersByRpcMessage[messageName]?.size === 0) {
			delete listenersByRpcMessage[messageName];
		}
	},
};

declare global {
	interface Window {
		__ELIZA_API_BASE__: string;
		__ELIZA_API_TOKEN__: string;
		__ELIZA_ELECTROBUN_RPC__?: typeof electrobunRpc;
	}
}

window.__ELIZA_ELECTROBUN_RPC__ = electrobunRpc;

function installRendererLogMirror(): void {
	const globalWindow = window as typeof window & {
		[RENDERER_LOG_MIRROR_KEY]?: boolean;
	};
	if (globalWindow[RENDERER_LOG_MIRROR_KEY]) {
		return;
	}
	globalWindow[RENDERER_LOG_MIRROR_KEY] = true;

	const reportDiagnostic = (
		level: "log" | "info" | "warn" | "error",
		source: string,
		message: string,
		details?: unknown,
	) => {
		void rpc.request
			.rendererReportDiagnostic({
				level,
				source,
				message,
				details,
			})
			.catch(() => {
				// Best effort only — never break the renderer because diagnostics failed.
			});
	};

	const consoleMethods = ["log", "info", "warn", "error"] as const;
	for (const level of consoleMethods) {
		const original = console[level].bind(console);
		console[level] = (...args: unknown[]) => {
			original(...args);
			reportDiagnostic(
				level,
				"console",
				args
					.map((value) => {
						if (typeof value === "string") return value;
						try {
							return JSON.stringify(value);
						} catch {
							return String(value);
						}
					})
					.join(" "),
			);
		};
	}

	window.addEventListener(
		"error",
		(event) => {
			const target = event.target as
				| { src?: string; href?: string; tagName?: string }
				| null
				| undefined;
			if (target && (target.src || target.href)) {
				reportDiagnostic("error", "resource", "Failed to load resource", {
					tagName: target.tagName,
					src: target.src,
					href: target.href,
				});
				return;
			}

			reportDiagnostic(
				"error",
				"window.onerror",
				event.message || "Unhandled window error",
				{
					filename: event.filename,
					lineno: event.lineno,
					colno: event.colno,
				},
			);
		},
		true,
	);

	window.addEventListener("unhandledrejection", (event) => {
		reportDiagnostic(
			"error",
			"unhandledrejection",
			"Unhandled promise rejection",
			summarizeDiagnosticValue(event.reason),
		);
	});

	if (typeof window.fetch === "function") {
		const originalFetch = window.fetch.bind(window);
		window.fetch = (async (...args: Parameters<typeof window.fetch>) => {
			const startedAt = Date.now();
			const input = args[0];
			const init = args[1];
			const url =
				typeof input === "string"
					? input
					: input instanceof Request
						? input.url
						: String(input);
			const method =
				init?.method ??
				(input instanceof Request ? input.method : undefined) ??
				"GET";

			try {
				const response = await originalFetch(...args);
				if (!response.ok) {
					reportDiagnostic(
						response.status >= 500 ? "error" : "warn",
						"fetch",
						`HTTP ${response.status} ${response.statusText}`,
						{
							url,
							method,
							durationMs: Date.now() - startedAt,
						},
					);
				}
				return response;
			} catch (error) {
				reportDiagnostic("error", "fetch", "Fetch failed", {
					url,
					method,
					durationMs: Date.now() - startedAt,
					error: summarizeDiagnosticValue(error),
				});
				throw error;
			}
		}) as typeof window.fetch;
	}

	if (typeof XMLHttpRequest !== "undefined") {
		const open = XMLHttpRequest.prototype.open;
		const send = XMLHttpRequest.prototype.send;

		XMLHttpRequest.prototype.open = function (
			method: string,
			url: string | URL,
			...rest: unknown[]
		) {
			(
				this as XMLHttpRequest & {
					__elizaDiag?: { method: string; url: string; startedAt: number };
				}
			).__elizaDiag = {
				method,
				url: String(url),
				startedAt: Date.now(),
			};
			return (open as (...args: unknown[]) => unknown).call(
				this,
				method,
				url,
				...rest,
			);
		};

		XMLHttpRequest.prototype.send = function (...args: unknown[]) {
			const xhr = this as XMLHttpRequest & {
				__elizaDiag?: { method: string; url: string; startedAt: number };
			};
			const handleComplete = () => {
				const diag = xhr.__elizaDiag;
				if (!diag) {
					return;
				}
				if (xhr.status >= 400) {
					reportDiagnostic(
						xhr.status >= 500 ? "error" : "warn",
						"xhr",
						`HTTP ${xhr.status}`,
						{
							url: diag.url,
							method: diag.method,
							durationMs: Date.now() - diag.startedAt,
						},
					);
				}
			};

			const handleError = () => {
				const diag = xhr.__elizaDiag;
				reportDiagnostic("error", "xhr", "XMLHttpRequest failed", {
					url: diag?.url,
					method: diag?.method,
					durationMs: diag ? Date.now() - diag.startedAt : undefined,
				});
			};

			xhr.addEventListener("loadend", handleComplete, { once: true });
			xhr.addEventListener("error", handleError, { once: true });
			return send.call(this, ...(args as []));
		};
	}
}

installRendererLogMirror();

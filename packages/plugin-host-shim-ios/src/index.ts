/**
 * iOS implementation of {@link PluginHostShim}. View bundles run inside
 * a `WKWebView` whose `WKUserContentController` exposes the
 * `elizaosBridge` script-message handler. The Swift side forwards
 * messages into the in-process Bun runtime (`plugin-capacitor-bridge`
 * → `bootElizaRuntime()` → `RemotePluginBridge`) and posts responses
 * back via `evaluateJavaScript`.
 *
 * Wire envelope between WKWebView and Swift bridge is the same JSON
 * shape as the Electrobun preload bridge:
 *
 *     { kind: "request",  id, method, params }
 *     { kind: "response", id, ok, payload?, error? }
 *     { kind: "event",    event, data }
 */

import type { JsonValue } from "@elizaos/plugin-remote-manifest";
import {
	type PluginHostShim,
	installHostShim,
} from "@elizaos/plugin-host-shim";

interface IosMessageHandler {
	postMessage(message: unknown): void;
}

interface IosWebkit {
	messageHandlers: {
		elizaosBridge?: IosMessageHandler;
	};
}

declare global {
	interface Window {
		webkit?: IosWebkit;
		/** Set by the Swift bridge before posting an "elizaosBridge" message back. */
		__elizaosIosDeliver?: (data: unknown) => void;
	}
}

export function installIosShim(): PluginHostShim {
	const handler = window.webkit?.messageHandlers?.elizaosBridge;
	if (!handler) {
		throw new Error(
			"installIosShim(): window.webkit.messageHandlers.elizaosBridge missing — " +
				"is the WKWebView configured with the elizaosBridge WKScriptMessageHandler?",
		);
	}

	const subscribers = new Map<string, Set<(data: JsonValue) => void>>();
	const pending = new Map<
		number,
		{ resolve: (v: JsonValue) => void; reject: (e: Error) => void }
	>();
	let nextId = 0;

	// Swift calls window.__elizaosIosDeliver(...) via evaluateJavaScript
	// to push responses + events back into the view.
	window.__elizaosIosDeliver = (data: unknown) => {
		if (isResponse(data)) {
			const slot = pending.get(data.id);
			if (!slot) return;
			pending.delete(data.id);
			if (data.ok) {
				slot.resolve((data.payload ?? null) as JsonValue);
			} else {
				slot.reject(new Error(data.error ?? "iOS bridge error"));
			}
			return;
		}
		if (isEvent(data)) {
			const set = subscribers.get(data.event);
			if (!set) return;
			for (const fn of set) fn(data.data);
		}
	};

	const shim: PluginHostShim = {
		resolveViewUrl(pluginName, relativePath) {
			// iOS host serves plugin assets via a custom URL scheme rooted
			// at the app sandbox: app-resource://plugin/<name>/<path>.
			return new URL(
				`app-resource://plugin/${encodeURIComponent(pluginName)}/${relativePath}`,
			);
		},
		request(method, params) {
			const id = ++nextId;
			return new Promise((resolve, reject) => {
				pending.set(id, {
					resolve: (v) => resolve(v as never),
					reject,
				});
				handler.postMessage({ kind: "request", id, method, params });
			});
		},
		on(event, handler) {
			let set = subscribers.get(event);
			if (!set) {
				set = new Set();
				subscribers.set(event, set);
			}
			set.add(handler);
			return () => set?.delete(handler);
		},
	};

	installHostShim(shim);
	return shim;
}

function isResponse(
	data: unknown,
): data is { id: number; ok: boolean; payload?: JsonValue; error?: string } {
	return (
		typeof data === "object" &&
		data !== null &&
		(data as { kind?: unknown }).kind === "response" &&
		typeof (data as { id?: unknown }).id === "number"
	);
}
function isEvent(
	data: unknown,
): data is { event: string; data: JsonValue } {
	return (
		typeof data === "object" &&
		data !== null &&
		(data as { kind?: unknown }).kind === "event" &&
		typeof (data as { event?: unknown }).event === "string"
	);
}

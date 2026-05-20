/**
 * Web / XR iframe implementation of {@link PluginHostShim}. The view
 * bundle loads inside an iframe whose parent is the elizaOS dashboard
 * (or the XR view-host page from `plugins/plugin-xr`). Requests are
 * delivered via `parent.postMessage` and the parent forwards them to
 * the agent's HTTP endpoint at `/api/plugins/remote/:name/invoke`.
 *
 * The wire envelope between iframe and parent is a tiny JSON object:
 *
 *     { kind: "elizaos.shim.request", id, method, params }
 *     { kind: "elizaos.shim.response", id, ok, payload?, error? }
 *     { kind: "elizaos.shim.event", event, data }
 */

import type { JsonValue } from "@elizaos/plugin-remote-manifest";
import {
	type PluginHostShim,
	installHostShim,
} from "./index.ts";

interface ParentRequest {
	kind: "elizaos.shim.request";
	id: number;
	method: string;
	params: JsonValue;
}
interface ParentResponse {
	kind: "elizaos.shim.response";
	id: number;
	ok: boolean;
	payload?: JsonValue;
	error?: string;
}
interface ParentEvent {
	kind: "elizaos.shim.event";
	event: string;
	data: JsonValue;
}

/**
 * Build and install the web shim. Idempotent — calling twice is a
 * no-op. Returns the installed shim for callers that want to keep a
 * reference (most just use {@link getHostShim}).
 */
export function installWebShim(options: {
	/** Origin to send postMessage to. Defaults to "*"; production agents should pin this. */
	parentOrigin?: string;
	/** Base path the agent serves view bundles from. Default `/api/views`. */
	viewsBasePath?: string;
} = {}): PluginHostShim {
	const parentOrigin = options.parentOrigin ?? "*";
	const viewsBasePath = options.viewsBasePath ?? "/api/views";

	const subscribers = new Map<string, Set<(data: JsonValue) => void>>();
	const pending = new Map<
		number,
		{ resolve: (v: JsonValue) => void; reject: (e: Error) => void }
	>();
	let nextRequestId = 0;

	window.addEventListener("message", (event: MessageEvent) => {
		const message = event.data;
		if (!isShimMessage(message)) return;
		if (message.kind === "elizaos.shim.response") {
			const slot = pending.get(message.id);
			if (!slot) return;
			pending.delete(message.id);
			if (message.ok) {
				slot.resolve((message.payload ?? null) as JsonValue);
			} else {
				slot.reject(new Error(message.error ?? "Unknown shim error"));
			}
			return;
		}
		if (message.kind === "elizaos.shim.event") {
			const set = subscribers.get(message.event);
			if (!set) return;
			for (const handler of set) handler(message.data);
		}
	});

	const shim: PluginHostShim = {
		resolveViewUrl(pluginName, relativePath) {
			return new URL(
				`${viewsBasePath}/${encodeURIComponent(pluginName)}/${relativePath}`,
				window.location.href,
			);
		},
		request(method, params) {
			const id = ++nextRequestId;
			const envelope: ParentRequest = {
				kind: "elizaos.shim.request",
				id,
				method,
				params,
			};
			return new Promise((resolve, reject) => {
				pending.set(id, {
					resolve: (v) => resolve(v as never),
					reject,
				});
				window.parent.postMessage(envelope, parentOrigin);
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

function isShimMessage(
	message: unknown,
): message is ParentRequest | ParentResponse | ParentEvent {
	if (typeof message !== "object" || message === null) return false;
	const kind = (message as { kind?: unknown }).kind;
	return (
		kind === "elizaos.shim.request" ||
		kind === "elizaos.shim.response" ||
		kind === "elizaos.shim.event"
	);
}

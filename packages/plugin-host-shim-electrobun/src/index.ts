/**
 * Electrobun implementation of {@link PluginHostShim}. The view bundle
 * runs inside an Electrobun BrowserView whose preload script exposes
 * `globalThis.__elizaosElectrobunBridge` (set up by the
 * `app-core/platforms/electrobun` host). The shim layers a typed
 * request / event surface on top of that bridge so view code is
 * indistinguishable from the iOS/Android/web variants.
 *
 * Usage inside a view bundle:
 *
 * ```ts
 * import { installElectrobunShim } from "@elizaos/plugin-host-shim-electrobun";
 * installElectrobunShim();
 * import { getHostShim } from "@elizaos/plugin-host-shim";
 * const result = await getHostShim().request("provider.spotify", {});
 * ```
 */

import type { JsonValue } from "@elizaos/plugin-remote-manifest";
import {
	type PluginHostShim,
	installHostShim,
} from "@elizaos/plugin-host-shim";

interface ElectrobunBridge {
	postMessage(message: unknown): void;
	addListener(
		event: string,
		handler: (data: unknown) => void,
	): () => void;
}

declare global {
	// eslint-disable-next-line no-var
	var __elizaosElectrobunBridge: ElectrobunBridge | undefined;
}

export function installElectrobunShim(): PluginHostShim {
	const bridge = globalThis.__elizaosElectrobunBridge;
	if (!bridge) {
		throw new Error(
			"installElectrobunShim(): __elizaosElectrobunBridge missing — " +
				"is the view loaded inside an Electrobun BrowserView with the host preload script?",
		);
	}

	const subscribers = new Map<string, Set<(data: JsonValue) => void>>();
	const pending = new Map<
		number,
		{ resolve: (v: JsonValue) => void; reject: (e: Error) => void }
	>();
	let nextId = 0;

	bridge.addListener("response", (data: unknown) => {
		if (!isResponse(data)) return;
		const slot = pending.get(data.id);
		if (!slot) return;
		pending.delete(data.id);
		if (data.ok) {
			slot.resolve((data.payload ?? null) as JsonValue);
		} else {
			slot.reject(new Error(data.error ?? "Unknown bridge error"));
		}
	});

	bridge.addListener("event", (data: unknown) => {
		if (!isEvent(data)) return;
		const set = subscribers.get(data.event);
		if (!set) return;
		for (const handler of set) handler(data.data);
	});

	const shim: PluginHostShim = {
		resolveViewUrl(pluginName, relativePath) {
			// Electrobun serves plugin assets via the `views://` URL scheme
			// rooted at the plugin's currentDir.
			return new URL(
				`views://${encodeURIComponent(pluginName)}/${relativePath}`,
			);
		},
		request(method, params) {
			const id = ++nextId;
			return new Promise((resolve, reject) => {
				pending.set(id, {
					resolve: (v) => resolve(v as never),
					reject,
				});
				bridge.postMessage({ kind: "request", id, method, params });
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
		typeof (data as { id?: unknown }).id === "number" &&
		typeof (data as { ok?: unknown }).ok === "boolean"
	);
}
function isEvent(
	data: unknown,
): data is { event: string; data: JsonValue } {
	return (
		typeof data === "object" &&
		data !== null &&
		typeof (data as { event?: unknown }).event === "string"
	);
}

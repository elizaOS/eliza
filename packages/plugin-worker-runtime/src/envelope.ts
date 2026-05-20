/**
 * Low-level transport adapter for the remote-plugin worker runtime.
 *
 * Abstracts the message channel so the same dispatch/proxy code runs on
 * top of a Bun Worker (postMessage / `message` event), a Bun subprocess
 * (stdio newline-delimited JSON), or an HTTPS endpoint (POST /rpc). P1
 * ships the Worker adapter; P2 adds subprocess + HTTPS.
 */

import type { RemotePluginWorkerMessage } from "@elizaos/plugin-remote-manifest";

/** Minimal contract every transport must satisfy. */
export interface WorkerChannel {
	/** Post a message to the host. */
	send(message: RemotePluginWorkerMessage): void;
	/** Subscribe to host → worker messages. Returns an unsubscribe fn. */
	onMessage(
		handler: (message: RemotePluginWorkerMessage) => void,
	): () => void;
	/** Stop accepting messages and free transport resources. */
	close(): void;
}

/**
 * Worker-thread message-port adapter. Uses `globalThis.postMessage` /
 * `addEventListener("message")` from inside a Web Worker (the model Bun
 * Workers expose).
 */
export function createWorkerChannel(): WorkerChannel {
	type WorkerSelf = {
		postMessage(message: unknown): void;
		addEventListener(
			type: "message",
			handler: (event: MessageEvent) => void,
		): void;
		removeEventListener(
			type: "message",
			handler: (event: MessageEvent) => void,
		): void;
	};
	const self = globalThis as unknown as WorkerSelf;

	const subscribers = new Set<(message: RemotePluginWorkerMessage) => void>();
	let closed = false;
	const listener = (event: MessageEvent): void => {
		if (closed) return;
		const message = event.data as RemotePluginWorkerMessage;
		for (const subscriber of subscribers) subscriber(message);
	};
	self.addEventListener("message", listener);

	return {
		send(message) {
			if (closed) return;
			self.postMessage(message);
		},
		onMessage(handler) {
			subscribers.add(handler);
			return () => subscribers.delete(handler);
		},
		close() {
			if (closed) return;
			closed = true;
			subscribers.clear();
			self.removeEventListener("message", listener);
		},
	};
}

/**
 * Monotonic request-id allocator used to correlate request / response
 * envelopes. Each side (worker and host) has its own counter and never
 * looks at the other's namespace.
 */
export function createRequestIdAllocator(): () => number {
	let n = 0;
	return () => {
		n = (n + 1) >>> 0;
		return n;
	};
}

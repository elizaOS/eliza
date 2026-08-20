/**
 * Makes filesystem write and flush operations obey the same abort signal as
 * the network side of a model download.
 */

import type { Writable } from "node:stream";

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new Error("Model download was aborted");
}

export function writeDownloadChunk(
	writer: Writable,
	chunk: Uint8Array,
	signal: AbortSignal,
): Promise<void> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let aborting = false;
		const settle = (error?: Error | null): void => {
			if (settled || aborting) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			if (error) reject(error);
			else resolve();
		};
		const onAbort = (): void => {
			if (aborting) return;
			aborting = true;
			const reason = abortReason(signal);
			if (writer.closed) {
				settled = true;
				reject(reason);
				return;
			}
			writer.once("close", () => {
				if (settled) return;
				settled = true;
				reject(reason);
			});
			writer.destroy();
		};
		if (signal.aborted) {
			onAbort();
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			writer.write(chunk, (error: Error | null | undefined) => settle(error));
		} catch (error) {
			settle(error instanceof Error ? error : new Error(String(error)));
		}
	});
}

export function closeDownloadWriter(
	writer: Writable,
	signal: AbortSignal,
): Promise<void> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let aborting = false;
		const settle = (error?: Error | null): void => {
			if (settled || aborting) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			writer.off("error", onError);
			if (error) reject(error);
			else resolve();
		};
		const onError = (error: Error): void => settle(error);
		const onAbort = (): void => {
			if (aborting) return;
			aborting = true;
			const reason = abortReason(signal);
			if (writer.closed) {
				settled = true;
				writer.off("error", onError);
				reject(reason);
				return;
			}
			writer.once("close", () => {
				if (settled) return;
				settled = true;
				writer.off("error", onError);
				reject(reason);
			});
			writer.destroy();
		};
		if (signal.aborted) {
			onAbort();
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
		writer.once("error", onError);
		try {
			writer.end(() => settle());
		} catch (error) {
			settle(error instanceof Error ? error : new Error(String(error)));
		}
	});
}

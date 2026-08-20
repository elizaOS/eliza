/**
 * Makes filesystem write and flush operations obey the same abort signal as
 * the network side of a model download.
 */

import type { Writable } from "node:stream";

interface CancelableDownloadReader {
	cancel(reason?: unknown): Promise<unknown>;
}

interface FailedDownloadTeardownOptions {
	reader?: CancelableDownloadReader;
	writer?: Writable;
	removePartial(): void;
}

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
			writer.off("error", onError);
			if (error) reject(error);
			else resolve();
		};
		const onError = (error: Error): void => {
			if (settled || aborting) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			// Keep handling any follow-up error emitted during auto-destroy. The
			// listener is removed only after the stream has actually closed.
			writer.once("close", () => writer.off("error", onError));
			writer.destroy();
			reject(error);
		};
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
		writer.on("error", onError);
		try {
			writer.write(chunk, (error: Error | null | undefined) => {
				// Node emits `error` after invoking the write callback with the same
				// failure. Keep the listener installed so that event cannot escape as
				// an uncaught process exception; `onError` owns rejection.
				if (!error) settle();
			});
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

function destroyDownloadWriter(writer: Writable): Promise<void> {
	if (writer.closed) return Promise.resolve();
	return new Promise((resolve) => {
		const onError = (): void => {
			// The original download failure remains authoritative while destroy
			// drains any follow-up stream error through the close boundary.
		};
		writer.on("error", onError);
		writer.once("close", () => {
			writer.off("error", onError);
			resolve();
		});
		writer.destroy();
	});
}

export async function teardownFailedDownload({
	reader,
	writer,
	removePartial,
}: FailedDownloadTeardownOptions): Promise<void> {
	await Promise.allSettled([
		reader?.cancel(),
		writer ? destroyDownloadWriter(writer) : undefined,
	]);
	removePartial();
}

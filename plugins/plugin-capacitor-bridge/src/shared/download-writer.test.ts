/**
 * Exercises abort-aware model file writes with real Node Writable lifecycle
 * behavior and deliberately gated write and flush callbacks.
 */

import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { closeDownloadWriter, writeDownloadChunk } from "./download-writer.ts";

class GatedWriter extends Writable {
	writeCallback: ((error?: Error | null) => void) | undefined;
	finalCallback: ((error?: Error | null) => void) | undefined;

	override _write(
		_chunk: Buffer,
		_encoding: BufferEncoding,
		callback: (error?: Error | null) => void,
	): void {
		this.writeCallback = callback;
	}

	override _final(callback: (error?: Error | null) => void): void {
		this.finalCallback = callback;
	}
}

class FailingWriter extends Writable {
	override _write(
		_chunk: Buffer,
		_encoding: BufferEncoding,
		callback: (error?: Error | null) => void,
	): void {
		callback(new Error("disk write failed"));
	}
}

describe("abort-aware model download writer", () => {
	it("destroys and rejects a write whose filesystem callback stalls", async () => {
		const controller = new AbortController();
		const writer = new GatedWriter();
		const pending = writeDownloadChunk(
			writer,
			new Uint8Array([1]),
			controller.signal,
		);
		controller.abort(new Error("write deadline"));

		await expect(pending).rejects.toThrow("write deadline");
		expect(writer.destroyed).toBe(true);
		expect(writer.closed).toBe(true);
	});

	it("destroys and rejects a close whose filesystem flush stalls", async () => {
		const controller = new AbortController();
		const writer = new GatedWriter();
		writer.writeCallback = undefined;
		const write = writeDownloadChunk(
			writer,
			new Uint8Array([1]),
			controller.signal,
		);
		writer.writeCallback?.();
		await write;
		const close = closeDownloadWriter(writer, controller.signal);
		expect(writer.finalCallback).toBeTypeOf("function");
		controller.abort(new Error("close deadline"));

		await expect(close).rejects.toThrow("close deadline");
		expect(writer.destroyed).toBe(true);
		expect(writer.closed).toBe(true);
	});

	it("handles the error event emitted after a write callback failure", async () => {
		const writer = new FailingWriter();
		const closed = new Promise<void>((resolve) =>
			writer.once("close", resolve),
		);
		await expect(
			writeDownloadChunk(
				writer,
				new Uint8Array([1]),
				new AbortController().signal,
			),
		).rejects.toThrow("disk write failed");
		await closed;
		expect(writer.destroyed).toBe(true);
		expect(writer.closed).toBe(true);
	});
});

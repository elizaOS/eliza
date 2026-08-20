/**
 * Unit tests for streaming utilities in packages/core/src/utils/streaming.ts.
 * Tests PassthroughExtractor, MarkableExtractor, StreamError, createStreamingRetryState, and createStreamingContext.
 */

import { describe, expect, it, vi } from "vitest";
import {
	createStreamingContext,
	createStreamingRetryState,
	MarkableExtractor,
	PassthroughExtractor,
	StreamError,
} from "./streaming";

describe("StreamError", () => {
	it("constructs and identifies StreamError instances", () => {
		const error = new StreamError("CHUNK_TOO_LARGE", "Chunk too big", {
			chunkSize: 2000,
		});

		expect(error.name).toBe("StreamError");
		expect(error.code).toBe("CHUNK_TOO_LARGE");
		expect(error.message).toBe("Chunk too big");
		expect(error.details).toEqual({ chunkSize: 2000 });
		expect(StreamError.isStreamError(error)).toBe(true);
		expect(StreamError.isStreamError(new Error("generic"))).toBe(false);
	});
});

describe("PassthroughExtractor", () => {
	it("passes chunks through unchanged and implements IStreamExtractor lifecycle", () => {
		const extractor = new PassthroughExtractor();
		expect(extractor.done).toBe(false);

		expect(extractor.push("hello")).toBe("hello");
		expect(extractor.push(" world")).toBe(" world");
		expect(extractor.flush()).toBe("");

		extractor.reset();
		expect(extractor.done).toBe(false);
	});

	it("throws StreamError when chunk exceeds MAX_CHUNK_SIZE", () => {
		const extractor = new PassthroughExtractor();
		const oversized = "x".repeat(1024 * 1024 + 1);

		expect(() => extractor.push(oversized)).toThrow(StreamError);
	});

	it("rejects non-string chunks at the runtime boundary", () => {
		const extractor = new PassthroughExtractor();

		expect(() => extractor.push(42 as never)).toThrow(TypeError);
	});
});

describe("MarkableExtractor", () => {
	it("passes through chunks and marks complete on demand", () => {
		const extractor = new MarkableExtractor();
		expect(extractor.done).toBe(false);

		expect(extractor.push("chunk-1")).toBe("chunk-1");
		expect(extractor.flush()).toBe("");
		expect(extractor.done).toBe(false);

		extractor.markComplete();
		expect(extractor.done).toBe(true);

		extractor.reset();
		expect(extractor.done).toBe(false);
	});
});

describe("createStreamingRetryState", () => {
	it("tracks streamed text and handles reset", () => {
		const extractor = new PassthroughExtractor();
		const retryState = createStreamingRetryState(extractor);

		expect(retryState.isComplete()).toBe(false);
		expect(retryState.getStreamedText()).toBe("");

		retryState.appendText("token1 ");
		retryState.appendText("token2");
		expect(retryState.getStreamedText()).toBe("token1 token2");

		retryState.reset();
		expect(retryState.getStreamedText()).toBe("");
	});
});

describe("createStreamingContext", () => {
	it("routes streaming chunks through extractor to callback and records text", async () => {
		const extractor = new MarkableExtractor();
		const receivedChunks: string[] = [];
		const callback = vi.fn(async (chunk: string) => {
			receivedChunks.push(chunk);
		});

		const context = createStreamingContext(extractor, callback, "msg-123");
		expect(context.messageId).toBe("msg-123");
		expect(context.isComplete()).toBe(false);

		await context.onStreamChunk("first ");
		await context.onStreamChunk("second");

		expect(receivedChunks).toEqual(["first ", "second"]);
		expect(context.getStreamedText()).toBe("first second");

		extractor.markComplete();
		expect(context.isComplete()).toBe(true);

		// When complete, further chunks are ignored
		await context.onStreamChunk("ignored");
		expect(receivedChunks).toEqual(["first ", "second"]);
	});

	it("forwards the structured-stream revision to the downstream callback", async () => {
		const callback = vi.fn();
		const context = createStreamingContext(
			new MarkableExtractor(),
			callback,
			"msg-revision",
		);

		await context.onStreamChunk("new", "msg-revision", "new", 7);

		expect(callback).toHaveBeenCalledWith("new", "msg-revision", "new", 7);
	});
});

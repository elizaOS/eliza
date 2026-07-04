/**
 * Streaming-path tests for the iOS bridge's chat token stream (#12354). They
 * drive `streamConversationMessageResponse` / `fetchBackendStream` end-to-end
 * with a fake in-memory runtime whose `messageService` emits tokens
 * incrementally, plus a fake stream emitter standing in for the native
 * `stream_emit` host-call → `notifyListeners` bridge. No device, no model on
 * disk (so the native-llama path is skipped and the deterministic
 * message-service path runs).
 *
 * They prove the contract the Android `agentStream*` events and
 * `createNativeStreamingResponse` consume: exactly one `response` head, one
 * `chunk` per model token (SSE `token` frames with a running `fullText`), and a
 * terminal `complete` — never the buffered single-frame fallback.
 */

import type { IAgentRuntime, UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
	fetchBackendStream,
	type IosBridgeBackend,
	type StreamEmitFrame,
	streamConversationMessageResponse,
} from "./bridge.ts";

const CONVERSATION_ID = "conv-stream-1";
const ROOM_ID = "00000000-0000-0000-0000-0000000000bb" as UUID;

/**
 * A runtime whose message service streams the given tokens one-by-one through
 * the `onResponse` callback — the same shape the real messageService uses when
 * generation is available but no on-device model file is installed.
 */
function createStreamingRuntime(tokens: string[]): IAgentRuntime {
	return {
		agentId: "00000000-0000-0000-0000-0000000000aa" as UUID,
		character: { name: "Eliza" },
		async ensureConnection(): Promise<void> {},
		async createMemory(): Promise<UUID> {
			return crypto.randomUUID() as UUID;
		},
		messageService: {
			async handleMessage(
				_runtime: IAgentRuntime,
				_message: unknown,
				onResponse: (content: { text?: string } | null) => Promise<unknown[]>,
			): Promise<void> {
				for (const token of tokens) {
					await onResponse({ text: token });
				}
			},
		},
	} as unknown as IAgentRuntime;
}

function makeBackendWithConversation(runtime: IAgentRuntime): IosBridgeBackend {
	const conversations = new Map<string, never>();
	conversations.set(CONVERSATION_ID, {
		id: CONVERSATION_ID,
		title: "Stream",
		roomId: ROOM_ID,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	} as never);
	return {
		runtime,
		dispatchRoute: async () => null,
		conversations:
			conversations as unknown as IosBridgeBackend["conversations"],
		close: async () => {},
	};
}

/** Collect emitted frames; return the collector + emitter. */
function collector() {
	const frames: StreamEmitFrame[] = [];
	const emit = (frame: StreamEmitFrame): void => {
		frames.push(frame);
	};
	return { frames, emit };
}

/** Decode a `chunk` frame's base64 back into the SSE `data:` JSON payload. */
function decodeChunk(frame: StreamEmitFrame): Record<string, unknown> {
	if (frame.kind !== "chunk") throw new Error("not a chunk frame");
	const sse = Buffer.from(frame.dataBase64, "base64").toString("utf8");
	const line = sse.split("\n").find((l) => l.startsWith("data:"));
	if (!line) throw new Error(`no data line in ${JSON.stringify(sse)}`);
	return JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
}

describe("iOS bridge — streamConversationMessageResponse", () => {
	it("emits response → one chunk per token (running fullText) → complete", async () => {
		const runtime = createStreamingRuntime(["Hello", " there", " friend"]);
		const backend = makeBackendWithConversation(runtime);
		const { frames, emit } = collector();

		await streamConversationMessageResponse(
			backend,
			CONVERSATION_ID,
			{ text: "hi" },
			"stream-a",
			emit,
		);

		// Head, one token chunk per model token, a done chunk, and complete.
		expect(frames[0]).toMatchObject({ kind: "response", status: 200 });
		expect(frames[0]).toMatchObject({
			headers: { "content-type": "text/event-stream; charset=utf-8" },
		});
		expect(frames.at(-1)).toEqual({
			streamId: "stream-a",
			kind: "complete",
			error: null,
		});

		const chunks = frames.filter((f) => f.kind === "chunk");
		const tokenChunks = chunks
			.map(decodeChunk)
			.filter((p) => p.type === "token");
		expect(tokenChunks.map((p) => p.text)).toEqual([
			"Hello",
			" there",
			" friend",
		]);
		// fullText accumulates across tokens.
		expect(tokenChunks.map((p) => p.fullText)).toEqual([
			"Hello",
			"Hello there",
			"Hello there friend",
		]);

		const done = chunks.map(decodeChunk).find((p) => p.type === "done");
		expect(done).toMatchObject({
			type: "done",
			completed: true,
			fullText: "Hello there friend",
		});

		// Every frame carries the pre-allocated streamId.
		for (const frame of frames) expect(frame.streamId).toBe("stream-a");
	});

	it("delivers more than one stream chunk per turn (real incremental stream)", async () => {
		const runtime = createStreamingRuntime(["a", "b", "c", "d"]);
		const backend = makeBackendWithConversation(runtime);
		const { frames, emit } = collector();

		await streamConversationMessageResponse(
			backend,
			CONVERSATION_ID,
			{ text: "hi" },
			"stream-b",
			emit,
		);

		const tokenChunks = frames
			.filter((f) => f.kind === "chunk")
			.map(decodeChunk)
			.filter((p) => p.type === "token");
		expect(tokenChunks.length).toBeGreaterThan(1);
	});

	it("emits a terminal complete frame when a mid-stream chunk emit rejects", async () => {
		const runtime = createStreamingRuntime(["a", "b", "c"]);
		const backend = makeBackendWithConversation(runtime);
		const frames: StreamEmitFrame[] = [];

		await streamConversationMessageResponse(
			backend,
			CONVERSATION_ID,
			{ text: "hi" },
			"stream-reject",
			async (frame) => {
				frames.push(frame);
				if (
					frame.kind === "chunk" &&
					decodeChunk(frame).type === "token" &&
					decodeChunk(frame).text === "b"
				) {
					throw new Error("webview emit failed");
				}
			},
		);

		expect(frames[0]).toMatchObject({ kind: "response", status: 200 });
		expect(frames.at(-1)).toEqual({
			streamId: "stream-reject",
			kind: "complete",
			error: "Error: webview emit failed",
		});
		expect(
			frames
				.filter((f) => f.kind === "chunk")
				.map(decodeChunk)
				.some((p) => p.type === "done"),
		).toBe(true);
	});

	it("emits a 404 stream for an unknown conversation without throwing", async () => {
		const runtime = createStreamingRuntime(["ignored"]);
		const backend = makeBackendWithConversation(runtime);
		const { frames, emit } = collector();

		await streamConversationMessageResponse(
			backend,
			"does-not-exist",
			{ text: "hi" },
			"stream-c",
			emit,
		);

		expect(frames[0]).toMatchObject({ kind: "response", status: 404 });
		expect(frames.at(-1)).toMatchObject({ kind: "complete" });
	});

	it("surfaces a generation failure as an SSE error chunk, still terminating", async () => {
		const runtime = {
			agentId: "00000000-0000-0000-0000-0000000000aa" as UUID,
			character: { name: "Eliza" },
			async ensureConnection(): Promise<void> {},
			async createMemory(): Promise<UUID> {
				return crypto.randomUUID() as UUID;
			},
			messageService: {
				async handleMessage(): Promise<void> {
					throw new Error("boom");
				},
			},
		} as unknown as IAgentRuntime;
		const backend = makeBackendWithConversation(runtime);
		const { frames, emit } = collector();

		await streamConversationMessageResponse(
			backend,
			CONVERSATION_ID,
			{ text: "hi" },
			"stream-d",
			emit,
		);

		// The message-service path catches its own error and streams a graceful
		// fallback sentence, so the turn still completes with a done frame.
		expect(frames[0]).toMatchObject({ kind: "response", status: 200 });
		const done = frames
			.filter((f) => f.kind === "chunk")
			.map(decodeChunk)
			.find((p) => p.type === "done");
		expect(done).toBeDefined();
		expect(String(done?.fullText)).toContain("unavailable");
		expect(frames.at(-1)).toMatchObject({ kind: "complete" });
	});
});

describe("iOS bridge — fetchBackendStream routing", () => {
	it("routes POST /messages/stream through the streaming path", async () => {
		const runtime = createStreamingRuntime(["hi"]);
		const backend = makeBackendWithConversation(runtime);
		const { frames, emit } = collector();

		const result = await fetchBackendStream(
			backend,
			{
				method: "POST",
				path: `/api/conversations/${CONVERSATION_ID}/messages/stream`,
				streamId: "stream-e",
			},
			"stream-e",
			emit,
		);

		expect(result).toEqual({ streamId: "stream-e", done: true });
		expect(frames[0]).toMatchObject({ kind: "response", status: 200 });
		expect(frames.some((f) => f.kind === "chunk")).toBe(true);
	});

	it("returns a 501 stream for a non-conversation-stream path (buffered fallback)", async () => {
		const runtime = createStreamingRuntime(["hi"]);
		const backend = makeBackendWithConversation(runtime);
		const { frames, emit } = collector();

		await fetchBackendStream(
			backend,
			{ method: "GET", path: "/api/local-inference/downloads/stream" },
			"stream-f",
			emit,
		);

		expect(frames[0]).toMatchObject({ kind: "response", status: 501 });
		expect(frames.at(-1)).toMatchObject({ kind: "complete" });
	});

	it("rejects an unsafe path", async () => {
		const runtime = createStreamingRuntime(["hi"]);
		const backend = makeBackendWithConversation(runtime);
		const { emit } = collector();

		await expect(
			fetchBackendStream(
				backend,
				{ method: "POST", path: "http://evil/api" },
				"stream-g",
				emit,
			),
		).rejects.toThrow(/starts with/);
	});
});

/**
 * Exercises structured/plain streaming through `AgentRuntime.useModel` and
 * `isLocalProvider` routing: local-handler stream callbacks, non-local
 * textStream fan-out, tool-call/usage passthrough, mid-stream abort, and
 * suppression of hidden image-description calls from ambient chat streams. Real
 * runtime over the in-memory adapter with registered fake handlers; deterministic.
 */
import { describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../../database/inMemoryAdapter";
import { AgentRuntime } from "../../runtime";
import { runWithStreamingContext } from "../../streaming-context";
import { type Character, ModelType, type ResponseSkeleton } from "../../types";
import { isLocalProvider } from "../action-model-routing";

function makeRuntime(): AgentRuntime {
	return new AgentRuntime({
		character: {
			name: "StreamingAgent",
			bio: "test",
			settings: {},
		} as Character,
		adapter: new InMemoryDatabaseAdapter(),
		logLevel: "fatal",
	});
}

const responseSkeleton: ResponseSkeleton = {
	spans: [
		{ kind: "literal", value: '{"shouldRespond":' },
		{ kind: "free-string", key: "shouldRespond" },
		{ kind: "literal", value: ',"contexts":' },
		{ kind: "free-json", key: "contexts" },
		{ kind: "literal", value: ',"intents":' },
		{ kind: "free-json", key: "intents" },
		{ kind: "literal", value: ',"replyText":' },
		{ kind: "free-string", key: "replyText" },
		{ kind: "literal", value: ',"facts":' },
		{ kind: "free-json", key: "facts" },
		{ kind: "literal", value: "}" },
	],
};

describe("AgentRuntime structured streaming", () => {
	it("preserves local handler stream callbacks and emits only replyText", async () => {
		const runtime = makeRuntime();
		const streamed: Array<[string, string | undefined]> = [];
		const raw =
			'{"shouldRespond":"RESPOND","contexts":["general"],"intents":[],"replyText":"On it now.","facts":[]}';
		const handler = vi.fn(async (_runtime, params: unknown) => {
			const streamingParams = params as {
				stream?: boolean;
				onStreamChunk?: (chunk: string) => Promise<void> | void;
			};
			expect(streamingParams.stream).toBe(true);
			expect(typeof streamingParams.onStreamChunk).toBe("function");
			await streamingParams.onStreamChunk?.(
				'{"shouldRespond":"RESPOND","contexts":["general"],"intents":[],',
			);
			await streamingParams.onStreamChunk?.('"replyText":"On it ');
			await streamingParams.onStreamChunk?.('now.","facts":[]}');
			return raw;
		});
		runtime.registerModel(
			ModelType.RESPONSE_HANDLER,
			handler,
			"eliza-local-inference",
		);

		const result = await runWithStreamingContext(
			{
				messageId: "message-1",
				onStreamChunk: (chunk, _messageId, accumulated) => {
					streamed.push([chunk, accumulated]);
				},
			},
			() =>
				runtime.useModel(ModelType.RESPONSE_HANDLER, {
					messages: [],
					streamStructured: true,
					responseSkeleton,
				}),
		);

		expect(result).toBe(raw);
		expect(streamed).toEqual([
			["On it ", "On it "],
			["now.", "On it now."],
		]);
	});

	it("streams structured fields from non-local handlers that return text streams", async () => {
		const runtime = makeRuntime();
		const streamed: string[] = [];
		const raw =
			'{"shouldRespond":"RESPOND","contexts":["general"],"intents":[],"replyText":"auth-ok","facts":[]}';
		const handler = vi.fn(async (_runtime, params: unknown) => {
			const streamingParams = params as {
				stream?: boolean;
				onStreamChunk?: (chunk: string) => Promise<void> | void;
			};
			expect(streamingParams.stream).toBe(true);
			expect(streamingParams.onStreamChunk).toBeUndefined();
			return {
				textStream: (async function* () {
					yield '{"shouldRespond":"RESPOND","contexts":["general"],"intents":[],';
					yield '"replyText":"auth-';
					yield 'ok","facts":[]}';
				})(),
				text: Promise.resolve(raw),
				usage: Promise.resolve(undefined),
				finishReason: Promise.resolve("stop"),
			};
		});
		runtime.registerModel(ModelType.RESPONSE_HANDLER, handler, "openai");

		const result = await runWithStreamingContext(
			{
				messageId: "message-1",
				onStreamChunk: (chunk) => {
					streamed.push(chunk);
				},
			},
			() =>
				runtime.useModel(ModelType.RESPONSE_HANDLER, {
					messages: [],
					streamStructured: true,
					responseSkeleton,
				}),
		);

		expect(result).toBe(raw);
		expect(streamed.join("")).toBe("auth-ok");
	});

	it("preserves streamed provider tool calls, finish reason, and usage", async () => {
		const runtime = makeRuntime();
		const toolCalls = [
			{
				id: "call-1",
				type: "function",
				function: {
					name: "CREATE_TASK",
					arguments: '{"title":"Ship it"}',
				},
			},
		];
		const usage = { promptTokens: 11, completionTokens: 7, totalTokens: 18 };
		const handler = vi.fn(async () => ({
			textStream: (async function* () {
				yield "Planning ";
				yield "done.";
			})(),
			text: Promise.resolve("Planning done."),
			toolCalls: Promise.resolve(toolCalls),
			finishReason: Promise.resolve("tool-calls"),
			usage: Promise.resolve(usage),
			providerMetadata: { provider: "test" },
		}));
		runtime.registerModel(ModelType.ACTION_PLANNER, handler, "openai");

		const result = await runWithStreamingContext(
			{
				messageId: "message-1",
				onStreamChunk: vi.fn(),
			},
			() =>
				runtime.useModel(ModelType.ACTION_PLANNER, {
					messages: [],
				}),
		);

		expect(result).toEqual({
			text: "Planning done.",
			toolCalls,
			finishReason: "tool-calls",
			usage,
			providerMetadata: { provider: "test" },
		});
	});

	it("stops emitting non-local stream chunks once the abort signal fires mid-stream", async () => {
		// runtime.ts: the non-local textStream loop checks `abortSignal?.aborted`
		// at the top of each iteration. Aborting after the first chunk must break
		// the loop so no further chunks reach the chat SSE callback, and the
		// trailing flush must not emit a partial/garbled tail.
		const runtime = makeRuntime();
		const streamed: string[] = [];
		const controller = new AbortController();
		const handler = vi.fn(async () => ({
			textStream: (async function* () {
				yield "a";
				yield "b";
				yield "c";
			})(),
			text: Promise.resolve("abc"),
			usage: Promise.resolve(undefined),
			finishReason: Promise.resolve("stop"),
		}));
		runtime.registerModel(ModelType.ACTION_PLANNER, handler, "openai");

		await runWithStreamingContext(
			{
				messageId: "message-1",
				abortSignal: controller.signal,
				onStreamChunk: (chunk) => {
					streamed.push(chunk);
					// Abort right after the first chunk is delivered.
					controller.abort();
				},
			},
			() =>
				runtime.useModel(ModelType.ACTION_PLANNER, {
					messages: [],
				}),
		);

		// Only the first chunk was delivered; "b"/"c" were suppressed by the abort.
		expect(streamed).toEqual(["a"]);
	});

	it("passes streaming-context callbacks to local handlers for plain text streams", async () => {
		const runtime = makeRuntime();
		const streamed: string[] = [];
		const handler = vi.fn(async (_runtime, params: unknown) => {
			const streamingParams = params as {
				stream?: boolean;
				onStreamChunk?: (chunk: string) => Promise<void> | void;
			};
			expect(streamingParams.stream).toBe(true);
			expect(typeof streamingParams.onStreamChunk).toBe("function");
			await streamingParams.onStreamChunk?.("Hello");
			await streamingParams.onStreamChunk?.(" there.");
			return "Hello there.";
		});
		runtime.registerModel(
			ModelType.TEXT_LARGE,
			handler,
			"eliza-local-inference",
		);

		const result = await runWithStreamingContext(
			{
				messageId: "message-1",
				onStreamChunk: (chunk) => {
					streamed.push(chunk);
				},
			},
			() =>
				runtime.useModel(ModelType.TEXT_LARGE, {
					prompt: "say hello",
				}),
		);

		expect(result).toBe("Hello there.");
		expect(streamed).toEqual(["Hello", " there."]);
	});

	it("does not leak hidden local image-description calls into ambient chat streams", async () => {
		const runtime = makeRuntime();
		const streamed: string[] = [];
		const handler = vi.fn(async (_runtime, params: unknown) => {
			const streamingParams = params as {
				stream?: boolean;
				onStreamChunk?: (chunk: string) => Promise<void> | void;
			};
			expect(streamingParams.stream).toBe(false);
			expect(streamingParams.onStreamChunk).toBeUndefined();
			return { title: "Image", description: "internal caption" };
		});
		runtime.registerModel(
			ModelType.IMAGE_DESCRIPTION,
			handler,
			"eliza-local-inference",
		);

		const result = await runWithStreamingContext(
			{
				messageId: "message-1",
				onStreamChunk: (chunk) => {
					streamed.push(chunk);
				},
			},
			() =>
				runtime.useModel(ModelType.IMAGE_DESCRIPTION, {
					imageUrl: "data:image/png;base64,aa==",
				}),
		);

		expect(result).toEqual({ title: "Image", description: "internal caption" });
		expect(streamed).toEqual([]);
	});

	it("passes image-description stream callbacks only when explicitly requested", async () => {
		const runtime = makeRuntime();
		const streamed: string[] = [];
		const handler = vi.fn(async (_runtime, params: unknown) => {
			const streamingParams = params as {
				stream?: boolean;
				onStreamChunk?: (chunk: string) => Promise<void> | void;
			};
			expect(streamingParams.stream).toBe(true);
			expect(typeof streamingParams.onStreamChunk).toBe("function");
			await streamingParams.onStreamChunk?.("visible ");
			await streamingParams.onStreamChunk?.("caption");
			return { title: "Image", description: "visible caption" };
		});
		runtime.registerModel(
			ModelType.IMAGE_DESCRIPTION,
			handler,
			"eliza-local-inference",
		);

		const result = await runWithStreamingContext(
			{
				messageId: "message-1",
				onStreamChunk: (chunk) => {
					streamed.push(chunk);
				},
			},
			() =>
				runtime.useModel(ModelType.IMAGE_DESCRIPTION, {
					imageUrl: "data:image/png;base64,aa==",
					stream: true,
				}),
		);

		expect(result).toEqual({ title: "Image", description: "visible caption" });
		expect(streamed).toEqual(["visible ", "caption"]);
	});

	it("treats built-in Eliza local providers as local model routes", () => {
		expect(isLocalProvider("eliza-local-inference")).toBe(true);
		expect(isLocalProvider("eliza-device-bridge")).toBe(true);
		expect(isLocalProvider("capacitor-llama")).toBe(true);
		expect(isLocalProvider("eliza-aosp-llama")).toBe(true);
	});
});

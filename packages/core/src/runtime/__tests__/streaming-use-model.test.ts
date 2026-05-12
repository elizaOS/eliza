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

	it("treats built-in Eliza local providers as local model routes", () => {
		expect(isLocalProvider("eliza-local-inference")).toBe(true);
		expect(isLocalProvider("eliza-device-bridge")).toBe(true);
		expect(isLocalProvider("capacitor-llama")).toBe(true);
		expect(isLocalProvider("eliza-aosp-llama")).toBe(true);
	});
});

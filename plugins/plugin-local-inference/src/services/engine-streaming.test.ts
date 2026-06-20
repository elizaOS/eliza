import { describe, expect, it } from "vitest";

import type { GenerateArgs } from "./backend";
import { LocalInferenceEngine } from "./engine";

/**
 * Regression guard for local chat token streaming through the engine facade.
 *
 * The chat reply path forces a per-turn grammar (the Stage-1 HANDLE_RESPONSE
 * envelope) and asks for `streamStructured`. The runtime wires
 * `params.onStreamChunk` down to the engine's `onTextChunk`, and the
 * `ResponseSkeletonStreamExtractor` slices the `replyText` field out of the
 * streamed JSON. For that to surface incremental deltas, the per-token
 * callback MUST fire once per chunk all the way through the dispatcher — not
 * collapse into a single final chunk.
 */

const REPLY_TOKENS = [
	'{"shouldRespond":"RESPOND",',
	'"contexts":["simple"],',
	'"replyText":"On ',
	"it ",
	'now.","facts":[]}',
];

// A minimal GBNF source — only its presence matters. This mirrors the Stage-1
// reply path always carrying a grammar.
const FORCED_GRAMMAR = 'root ::= "{" [^}]* "}"';

describe("LocalInferenceEngine.generateInConversation streaming (chat path)", () => {
	it("forwards onTextChunk per token through the dispatcher when voice is off", async () => {
		// The production chat reply has a conversationId, so the local handler
		// routes through `generateInConversation` (NOT `engine.generate`). With no
		// voice bridge active, `voiceStreamingArgs` is a passthrough, so the
		// dispatcher must receive — and the backend must fire — `onTextChunk`
		// per token. This is the junction the FFI-backed unit tests don't cover.
		const engine = new LocalInferenceEngine();
		const seenChunks: string[] = [];

		const internals = engine as unknown as {
			dispatcher: {
				generate: (args: GenerateArgs) => Promise<string>;
				activeBackendId: () => string | null;
			};
			currentModelPath: () => string | null;
		};
		// Drive the non-"llama-cpp" branch of generateInConversation (the
		// usage-block-synthesizing forward path) by reporting no active FFI
		// backend while still stubbing dispatcher.generate.
		internals.dispatcher.activeBackendId = () => null;
		internals.currentModelPath = () => "fake-model";
		internals.dispatcher.generate = async (args: GenerateArgs) => {
			// Simulate the backend firing the per-token callback.
			for (const token of REPLY_TOKENS) {
				await args.onTextChunk?.(token);
			}
			return REPLY_TOKENS.join("");
		};

		const handle = engine.openConversation({
			conversationId: "conv-stream-test",
			modelId: "fake-model",
		});

		const result = await engine.generateInConversation(handle, {
			prompt: "say hi",
			grammar: FORCED_GRAMMAR,
			streamStructured: true,
			onTextChunk: (chunk) => {
				seenChunks.push(chunk);
			},
		});

		expect(seenChunks).toEqual(REPLY_TOKENS);
		expect(seenChunks.length).toBeGreaterThan(1);
		expect(result.text).toBe(REPLY_TOKENS.join(""));

		await engine.closeConversation(handle);
	});
});

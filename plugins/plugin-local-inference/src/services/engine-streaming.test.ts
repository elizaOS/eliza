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
	const gatedVoiceSkeleton: GenerateArgs["responseSkeleton"] = {
		spans: [
			{ kind: "literal", value: '{"shouldRespond":"' },
			{
				kind: "enum",
				key: "shouldRespond",
				enumValues: ["RESPOND", "IGNORE", "STOP"],
			},
			{ kind: "literal", value: '","replyText":"' },
			{ kind: "free-string", key: "replyText" },
			{ kind: "literal", value: '"}' },
		],
	};

	function voiceHarness() {
		const engine = new LocalInferenceEngine();
		const pushed: string[] = [];
		const internals = engine as unknown as {
			voiceBridge: {
				lifecycle: { current: () => { kind: string } };
				scheduler: {
					bargeIn: { onSignal: () => () => void };
				};
				pushAcceptedToken: (token: { text: string }) => Promise<void>;
				settle: () => Promise<void>;
			};
			voiceStreamingArgs: (args: GenerateArgs) => {
				args: GenerateArgs;
				finish: (text: string) => Promise<void>;
			};
		};
		internals.voiceBridge = {
			lifecycle: { current: () => ({ kind: "voice-on" }) },
			scheduler: { bargeIn: { onSignal: () => () => {} } },
			pushAcceptedToken: async (token) => {
				pushed.push(token.text);
			},
			settle: async () => {},
		};
		return { internals, pushed };
	}

	it("speaks only replyText when the structured decision is RESPOND", async () => {
		const { internals, pushed } = voiceHarness();
		const text = '{"shouldRespond":"RESPOND","replyText":"Hello Nubs."}';
		const streaming = internals.voiceStreamingArgs({
			prompt: "visible response",
			voiceOutput: "user-visible",
			streamStructured: true,
			responseSkeleton: gatedVoiceSkeleton,
		});

		await streaming.args.onTextChunk?.(text);
		await streaming.finish(text);

		expect(pushed.join("")).toBe("Hello Nubs.");
	});

	it("speaks nothing when an enum shouldRespond gate says IGNORE", async () => {
		const { internals, pushed } = voiceHarness();
		const text =
			'{"shouldRespond":"IGNORE","replyText":"This must stay silent."}';
		const streaming = internals.voiceStreamingArgs({
			prompt: "ignored response",
			voiceOutput: "user-visible",
			streamStructured: true,
			responseSkeleton: gatedVoiceSkeleton,
		});

		await streaming.args.onTextChunk?.(text);
		await streaming.finish(text);

		expect(pushed).toEqual([]);
	});

	it("does not promote an internal structured stream into voice output", async () => {
		const engine = new LocalInferenceEngine();
		let pushed = 0;
		const internals = engine as unknown as {
			voiceBridge: {
				lifecycle: { current: () => { kind: string } };
				pushAcceptedToken: () => Promise<void>;
			};
			voiceStreamingArgs: (args: GenerateArgs) => {
				args: GenerateArgs;
				finish: (text: string) => Promise<void>;
			};
		};
		internals.voiceBridge = {
			lifecycle: { current: () => ({ kind: "voice-on" }) },
			pushAcceptedToken: async () => {
				pushed += 1;
			},
		};
		const args: GenerateArgs = {
			prompt: "internal structured work",
			streamStructured: true,
			responseSkeleton: {
				spans: [
					{ kind: "literal", text: '{"replyText":' },
					{ kind: "field", key: "replyText", valueType: "string" },
					{ kind: "literal", text: "}" },
				],
			},
			onTextChunk: () => {},
		};

		const streaming = internals.voiceStreamingArgs(args);
		await streaming.finish('{"replyText":"private planner output"}');

		expect(streaming.args).toBe(args);
		expect(pushed).toBe(0);
	});

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

import { describe, expect, it } from "vitest";

import type { GenerateArgs } from "./backend";
import { LocalInferenceEngine, NodeLlamaCppBackend } from "./engine";
import { SessionPool } from "./session-pool";

/**
 * Regression guard for local chat token streaming.
 *
 * The chat reply path forces a per-turn grammar (the Stage-1 HANDLE_RESPONSE
 * envelope) and asks for `streamStructured`. The runtime wires
 * `params.onStreamChunk` down to the engine's `onTextChunk`, and the
 * `ResponseSkeletonStreamExtractor` slices the `replyText` field out of the
 * streamed JSON. For that to surface incremental deltas, the engine's
 * `node-llama-cpp` session MUST invoke `onTextChunk` per token even when a
 * `grammar` is set — node-llama-cpp 3.x supports streaming + grammar together.
 *
 * These tests drive the real `NodeLlamaCppBackend.generate` with a fake
 * session pool so they run keyless / model-less, and assert the per-token
 * callback fires once PER chunk (not collapsed into a single final chunk).
 */

interface FakePromptOptions {
	grammar?: unknown;
	onTextChunk?: (chunk: string) => void;
}

/** A fake `LlamaChatSession` that streams a fixed token list via onTextChunk. */
function makeFakeSession(tokens: string[]): {
	prompt: (text: string, options?: FakePromptOptions) => Promise<string>;
	resetChatHistory: () => void;
	sawGrammar: () => boolean;
} {
	let grammarSeen = false;
	return {
		sawGrammar: () => grammarSeen,
		resetChatHistory: () => {},
		async prompt(_text: string, options?: FakePromptOptions): Promise<string> {
			if (options?.grammar) grammarSeen = true;
			for (const token of tokens) {
				// node-llama-cpp fires onTextChunk synchronously per accepted token.
				options?.onTextChunk?.(token);
			}
			return tokens.join("");
		},
	};
}

/**
 * Wire a `NodeLlamaCppBackend` with injected internals so `generate()` runs
 * without a native binding. We stub:
 *   - `sessionPool` (real `SessionPool`, fake session factory),
 *   - `bindingModule.LlamaGrammar` (opaque ctor),
 *   - `llama` (only used as the grammar ctor's first arg).
 */
function makeBackendWithFakeSession(tokens: string[]): {
	backend: NodeLlamaCppBackend;
	sawGrammar: () => boolean;
} {
	const session = makeFakeSession(tokens);
	const internals = new NodeLlamaCppBackend() as unknown as {
		sessionPool: SessionPool<unknown>;
		bindingModule: { LlamaGrammar: new (...args: unknown[]) => object };
		llama: object;
	};
	internals.sessionPool = new SessionPool({
		maxSize: 2,
		factory: async () => session,
	});
	internals.bindingModule = {
		LlamaGrammar: class {
			readonly source: string;
			constructor(_llama: unknown, options: { grammar: string }) {
				this.source = options.grammar;
			}
		},
	};
	internals.llama = {};
	return {
		backend: internals as unknown as NodeLlamaCppBackend,
		sawGrammar: session.sawGrammar,
	};
}

const REPLY_TOKENS = [
	'{"shouldRespond":"RESPOND",',
	'"contexts":["simple"],',
	'"replyText":"On ',
	"it ",
	'now.","facts":[]}',
];

// A minimal GBNF source — only its presence matters; the fake session never
// actually constrains decoding. This mirrors the Stage-1 reply path always
// carrying a grammar.
const FORCED_GRAMMAR = 'root ::= "{" [^}]* "}"';

describe("NodeLlamaCppBackend streaming", () => {
	it("fires onTextChunk once per token even with a grammar set", async () => {
		const { backend, sawGrammar } = makeBackendWithFakeSession(REPLY_TOKENS);
		const chunks: string[] = [];
		const args: GenerateArgs = {
			prompt: "say hi",
			grammar: FORCED_GRAMMAR,
			streamStructured: true,
			onTextChunk: (chunk) => {
				chunks.push(chunk);
			},
		};

		const result = await backend.generate(args);

		// The grammar reached the session (the structured path is exercised)...
		expect(sawGrammar()).toBe(true);
		// ...and the callback fired PER token, not once at the end.
		expect(chunks).toEqual(REPLY_TOKENS);
		expect(chunks.length).toBeGreaterThan(1);
		expect(result).toBe(REPLY_TOKENS.join(""));
	});

	it("does not register onTextChunk when no callback is supplied", async () => {
		// Sanity: the no-callback branch still returns the full text.
		const { backend } = makeBackendWithFakeSession(REPLY_TOKENS);
		const result = await backend.generate({ prompt: "say hi" });
		expect(result).toBe(REPLY_TOKENS.join(""));
	});
});

describe("LocalInferenceEngine.generateInConversation streaming (chat path)", () => {
	it("forwards onTextChunk per token through the dispatcher when voice is off", async () => {
		// The production chat reply has a conversationId, so the local handler
		// routes through `generateInConversation` (NOT `engine.generate`). With no
		// voice bridge active, `voiceStreamingArgs` is a passthrough, so the
		// dispatcher must receive — and the backend must fire — `onTextChunk`
		// per token. This is the junction the unit tests above don't cover.
		const engine = new LocalInferenceEngine();
		const seenChunks: string[] = [];

		const internals = engine as unknown as {
			dispatcher: {
				generate: (args: GenerateArgs) => Promise<string>;
				activeBackendId: () => string | null;
			};
			currentModelPath: () => string | null;
		};
		// Force the node-llama-cpp branch of generateInConversation (not "llama-cpp").
		internals.dispatcher.activeBackendId = () => "node-llama-cpp";
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

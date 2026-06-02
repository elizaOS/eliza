import { describe, expect, it, vi } from "vitest";
import { DesktopLlamaAdapter } from "./desktop-llama-adapter";

/**
 * Tests for #11: llama_token_to_piece negative-return handling (resize + retry,
 * never drop token text) and split-UTF-8 reassembly across token boundaries.
 *
 * The harness captures every buffer handed to `ffi.ptr` so the
 * `llama_token_to_piece` mock can write real bytes into the adapter's
 * `pieceBuf` and report the byte count (or a negative "buffer too small").
 */
function makePieceHarness(pieces: Map<number, Uint8Array>) {
	let nextPtr = 100;
	// Map the fake integer "pointer" back to the JS-side buffer it came from.
	const ptrToBuf = new Map<number, Uint8Array>();

	const ffi = {
		ptr: vi.fn((buf: Uint8Array) => {
			const p = nextPtr++;
			if (buf instanceof Uint8Array) ptrToBuf.set(p, buf);
			return p;
		}),
	};

	const llama = {
		llama_backend_init: vi.fn(),
		llama_backend_free: vi.fn(),
		llama_model_free: vi.fn(),
		llama_free: vi.fn(),
		llama_get_model: vi.fn().mockReturnValue(2),
		llama_model_get_vocab: vi.fn().mockReturnValue(3),
		llama_n_ctx: vi.fn().mockReturnValue(4096),
		llama_vocab_is_eog: vi.fn().mockReturnValue(false),
		llama_set_embeddings: vi.fn(),
		llama_get_memory: vi.fn().mockReturnValue(4),
		llama_memory_clear: vi.fn(),
		llama_tokenize: vi.fn(),
		// Write the token's bytes into the buffer behind `bufPtr`. Returns the
		// byte count, or -byteCount when the buffer is too small (the llama.cpp
		// contract) so we exercise the resize+retry path.
		llama_token_to_piece: vi.fn(
			(
				_vocab: number,
				token: number,
				bufPtr: number,
				length: number,
				_lstrip: number,
				_special: boolean,
			) => {
				const bytes = pieces.get(token) ?? new Uint8Array();
				if (bytes.length > length) return -bytes.length;
				const buf = ptrToBuf.get(bufPtr);
				if (buf) buf.set(bytes.subarray(0, length));
				return bytes.length;
			},
		),
		llama_sampler_chain_add: vi.fn(),
		llama_sampler_init_temp: vi.fn().mockReturnValue(10),
		llama_sampler_init_top_p: vi.fn().mockReturnValue(11),
		llama_sampler_init_top_k: vi.fn().mockReturnValue(12),
		llama_sampler_init_dist: vi.fn().mockReturnValue(13),
		llama_sampler_init_greedy: vi.fn().mockReturnValue(14),
		llama_sampler_sample: vi.fn(),
		llama_sampler_accept: vi.fn(),
		llama_sampler_free: vi.fn(),
		llama_state_seq_save_file: vi.fn().mockReturnValue(1),
		llama_state_seq_load_file: vi.fn().mockReturnValue(1),
	};

	const shim = {
		eliza_llama_model_params_default: vi.fn().mockReturnValue(20),
		eliza_llama_model_params_free: vi.fn(),
		eliza_llama_model_params_set_n_gpu_layers: vi.fn(),
		eliza_llama_model_params_set_use_mmap: vi.fn(),
		eliza_llama_model_params_set_use_mlock: vi.fn(),
		eliza_llama_model_load_from_file: vi.fn().mockReturnValue(30),
		eliza_llama_context_params_default: vi.fn().mockReturnValue(40),
		eliza_llama_context_params_free: vi.fn(),
		eliza_llama_context_params_set_n_ctx: vi.fn(),
		eliza_llama_context_params_set_n_batch: vi.fn(),
		eliza_llama_context_params_set_n_ubatch: vi.fn(),
		eliza_llama_context_params_set_n_threads: vi.fn(),
		eliza_llama_context_params_set_n_threads_batch: vi.fn(),
		eliza_llama_context_params_set_embeddings: vi.fn(),
		eliza_llama_context_params_set_offload_kqv: vi.fn(),
		eliza_llama_init_from_model: vi.fn().mockReturnValue(50),
		eliza_llama_sampler_chain_params_default: vi.fn().mockReturnValue(60),
		eliza_llama_sampler_chain_params_free: vi.fn(),
		eliza_llama_sampler_chain_init: vi.fn().mockReturnValue(70),
		eliza_llama_batch_get_one: vi.fn(() => nextPtr++),
		eliza_llama_batch_free: vi.fn(),
		eliza_llama_decode: vi.fn().mockReturnValue(0),
		eliza_llama_log_silence: vi.fn(),
		eliza_llama_context_attach_drafter: vi.fn().mockReturnValue(0),
		eliza_llama_context_detach_drafter: vi.fn(),
		eliza_llama_context_has_drafter: vi.fn().mockReturnValue(0),
		eliza_llama_context_set_spec_mode: vi.fn().mockReturnValue(0),
		eliza_llama_decode_unified: vi.fn().mockReturnValue(0),
		eliza_llama_mtp_stats: vi.fn(),
	};

	const adapter = new DesktopLlamaAdapter(
		ffi as never,
		llama as never,
		shim as never,
	);
	adapter.loadModel({
		modelPath: "/fake/model.gguf",
		nBatch: 32,
		nUBatch: 32,
		threads: 1,
	});

	return { adapter, binding: adapter.createBinding(), llama };
}

function openStream(binding: ReturnType<DesktopLlamaAdapter["createBinding"]>) {
	return binding.llmStreamOpen({
		ctx: 50n,
		config: {
			maxTokens: 8,
			temperature: 0,
			topP: 1,
			topK: 0,
			repeatPenalty: 1,
			slotId: 0,
			promptCacheKey: null,
			draftMin: 0,
			draftMax: 0,
			draftModelPath: null,
		},
	});
}

describe("DesktopLlamaAdapter token-to-piece decoding (#11)", () => {
	it("reassembles a UTF-8 codepoint split across two token pieces", () => {
		// "你" (U+4F60) is E4 BD A0. Split across two tokens: [E4], [BD A0].
		// Per-piece decoding would yield two U+FFFD; streaming decode must
		// reassemble it into the original character.
		const pieces = new Map<number, Uint8Array>([
			[101, new Uint8Array([0xe4])],
			[102, new Uint8Array([0xbd, 0xa0])],
		]);
		const h = makePieceHarness(pieces);
		// Emit token 101 then 102, then EOG to stop.
		h.llama.llama_sampler_sample
			.mockReturnValueOnce(101)
			.mockReturnValueOnce(102);
		h.llama.llama_vocab_is_eog
			.mockReturnValueOnce(false)
			.mockReturnValueOnce(false)
			.mockReturnValue(true);

		const stream = openStream(h.binding);
		const step = h.binding.llmStreamNext({
			stream,
			maxTokensPerStep: 8,
			maxTextBytes: 1024,
		});

		expect(step.text).toBe("你");
		expect(step.text).not.toContain("�");
		h.binding.llmStreamClose(stream);
	});

	it("resizes and retries on a negative return instead of dropping the piece", () => {
		// A single piece larger than the default 256-byte buffer. The first
		// call returns -length; the adapter must grow the buffer and retry.
		const big = new TextEncoder().encode("z".repeat(300));
		const pieces = new Map<number, Uint8Array>([[200, big]]);
		const h = makePieceHarness(pieces);
		h.llama.llama_sampler_sample.mockReturnValueOnce(200);
		h.llama.llama_vocab_is_eog.mockReturnValueOnce(false).mockReturnValue(true);

		const stream = openStream(h.binding);
		const step = h.binding.llmStreamNext({
			stream,
			maxTokensPerStep: 8,
			maxTextBytes: 4096,
		});

		expect(step.text).toBe("z".repeat(300));
		// Called twice for the same token: small buffer (rejected), then resized.
		const calls = h.llama.llama_token_to_piece.mock.calls.filter(
			(c) => c[1] === 200,
		);
		expect(calls.length).toBe(2);
		expect(calls[0][3]).toBe(256); // first attempt: default buffer length
		expect(calls[1][3]).toBe(300); // retry: grown to required size
		h.binding.llmStreamClose(stream);
	});

	it("flushes an incomplete UTF-8 piece when EOG ends the stream", () => {
		const pieces = new Map<number, Uint8Array>([
			[101, new Uint8Array([0xe4])],
		]);
		const h = makePieceHarness(pieces);
		h.llama.llama_sampler_sample.mockReturnValueOnce(101);
		h.llama.llama_vocab_is_eog.mockReturnValueOnce(false).mockReturnValue(true);

		const stream = openStream(h.binding);
		const step = h.binding.llmStreamNext({
			stream,
			maxTokensPerStep: 8,
			maxTextBytes: 1024,
		});

		expect(step.done).toBe(true);
		expect(step.text).toBe("�");
		h.binding.llmStreamClose(stream);
	});

	it("flushes an incomplete UTF-8 piece when a stream is cancelled", () => {
		const pieces = new Map<number, Uint8Array>([
			[101, new Uint8Array([0xe4])],
		]);
		const h = makePieceHarness(pieces);
		h.llama.llama_sampler_sample.mockReturnValueOnce(101);
		h.llama.llama_vocab_is_eog.mockReturnValue(false);

		const stream = openStream(h.binding);
		const first = h.binding.llmStreamNext({
			stream,
			maxTokensPerStep: 1,
			maxTextBytes: 1024,
		});
		expect(first.done).toBe(false);
		expect(first.text).toBe("");

		h.binding.llmStreamCancel(stream);
		const cancelled = h.binding.llmStreamNext({
			stream,
			maxTokensPerStep: 8,
			maxTextBytes: 1024,
		});

		expect(cancelled.done).toBe(true);
		expect(cancelled.text).toBe("�");
		h.binding.llmStreamClose(stream);
	});
});

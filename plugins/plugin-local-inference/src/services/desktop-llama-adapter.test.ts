import { describe, expect, it, vi } from "vitest";
import { DesktopLlamaAdapter } from "./desktop-llama-adapter";

function makeAdapterHarness(nBatch: number) {
	let nextPtr = 100;
	const decodeBatchSizes: number[] = [];
	const configuredBatchSizes: number[] = [];

	const ffi = {
		ptr: vi.fn(() => nextPtr++),
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
		llama_token_to_piece: vi.fn(),
		llama_sampler_chain_add: vi.fn(),
		llama_sampler_init_temp: vi.fn().mockReturnValue(10),
		llama_sampler_init_top_p: vi.fn().mockReturnValue(11),
		llama_sampler_init_top_k: vi.fn().mockReturnValue(12),
		llama_sampler_init_dist: vi.fn().mockReturnValue(13),
		llama_sampler_init_greedy: vi.fn().mockReturnValue(14),
		llama_sampler_sample: vi.fn().mockReturnValue(15),
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
		eliza_llama_context_params_set_n_batch: vi.fn((_, value: number) => {
			configuredBatchSizes.push(value);
		}),
		eliza_llama_context_params_set_n_ubatch: vi.fn(),
		eliza_llama_context_params_set_n_threads: vi.fn(),
		eliza_llama_context_params_set_n_threads_batch: vi.fn(),
		eliza_llama_context_params_set_embeddings: vi.fn(),
		eliza_llama_context_params_set_offload_kqv: vi.fn(),
		eliza_llama_init_from_model: vi.fn().mockReturnValue(50),
		eliza_llama_sampler_chain_params_default: vi.fn().mockReturnValue(60),
		eliza_llama_sampler_chain_params_free: vi.fn(),
		eliza_llama_sampler_chain_init: vi.fn().mockReturnValue(70),
		eliza_llama_batch_get_one: vi.fn((_, tokenCount: number) => {
			if (tokenCount > nBatch) {
				throw new Error(`batch too large: ${tokenCount} > ${nBatch}`);
			}
			decodeBatchSizes.push(tokenCount);
			return nextPtr++;
		}),
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
		nBatch,
		nUBatch: nBatch,
		threads: 1,
	});

	return {
		adapter,
		binding: adapter.createBinding(),
		decodeBatchSizes,
		configuredBatchSizes,
	};
}

describe("DesktopLlamaAdapter prefill", () => {
	it("chunks prefill decode calls so no batch exceeds configured nBatch", () => {
		const h = makeAdapterHarness(4);
		const stream = h.binding.llmStreamOpen({
			ctx: 50n,
			config: {
				maxTokens: 0,
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

		h.binding.llmStreamPrefill({
			stream,
			tokens: new Int32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]),
		});

		expect(h.configuredBatchSizes).toContain(4);
		expect(h.decodeBatchSizes).toEqual([4, 4, 1]);
		h.binding.llmStreamClose(stream);
	});
});

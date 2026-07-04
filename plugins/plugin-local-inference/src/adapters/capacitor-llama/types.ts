/**
 * Canonical Capacitor-llama adapter contract.
 *
 * This is the SAME shape used by `llama-cpp-capacitor` on mobile (iOS / Android,
 * including riscv64 once Wave 2's libllama.so is installed) and by the bun:ffi
 * backend on desktop. Every entry point in this plugin consumes one of these
 * interfaces — there is no `node-llama-cpp` import anywhere downstream.
 *
 * Shape rationale: the interface mirrors `llama-cpp-capacitor`'s
 * `LlamaContext` class verbatim so the mobile path can implement it with a
 * straight pass-through. The loader is mobile-only — libllama is retired, so
 * there is no desktop façade (desktop runs the fused `libelizainference`).
 *
 * Why a TS interface rather than `import type { LlamaContext } from
 * "llama-cpp-capacitor"`? The Capacitor package is mobile-only at install time
 * (Capacitor SPI'd Java/Swift bindings). Importing its types from the desktop
 * path would force every desktop tsc run to pull the mobile binding's d.ts. We
 * keep the interface free-standing so any backend can implement it.
 */

export interface TokenizerConfig {
	name: string;
	type: string;
}

// === Context / completion params ===========================================

export interface CapacitorLlamaContextParams {
	/** GGUF model path (absolute or Capacitor-asset URI). */
	model: string;
	/** Optional Jinja chat template override. */
	chat_template?: string;
	/** When loading from a packaged Android/iOS asset. */
	is_model_asset?: boolean;
	use_progress_callback?: boolean;
	n_ctx?: number;
	n_batch?: number;
	n_ubatch?: number;
	n_threads?: number;
	/**
	 * GPU layer offload. `999` = "all layers on GPU" per llama.cpp convention.
	 * The Capacitor binding rejects > model layer count; desktop path clamps
	 * to the model's metadata layer count.
	 */
	n_gpu_layers?: number;
	no_gpu_devices?: boolean;
	flash_attn?: boolean;
	cache_type_k?:
		| "f16"
		| "f32"
		| "q8_0"
		| "q4_0"
		| "q4_1"
		| "iq4_nl"
		| "q5_0"
		| "q5_1";
	cache_type_v?:
		| "f16"
		| "f32"
		| "q8_0"
		| "q4_0"
		| "q4_1"
		| "iq4_nl"
		| "q5_0"
		| "q5_1";
	use_mlock?: boolean;
	use_mmap?: boolean;
	vocab_only?: boolean;
	lora?: string;
	lora_scaled?: number;
	lora_list?: Array<{ path: string; scaled?: number }>;
	rope_freq_base?: number;
	rope_freq_scale?: number;
	pooling_type?: "none" | "mean" | "cls" | "last" | "rank";
	ctx_shift?: boolean;
	kv_unified?: boolean;
	swa_full?: boolean;
	n_cpu_moe?: number;
	embedding?: boolean;
	embd_normalize?: number;
}

export interface CapacitorLlamaMessagePart {
	type: string;
	text?: string;
	image_url?: { url?: string };
	input_audio?: { format: string; data?: string; url?: string };
}

export interface CapacitorLlamaChatMessage {
	role: string;
	content?: string | CapacitorLlamaMessagePart[];
}

export interface CapacitorLlamaResponseFormat {
	type: "text" | "json_object" | "json_schema";
	json_schema?: { strict?: boolean; schema: object };
	schema?: object;
}

export interface CapacitorLlamaCompletionParams {
	/** Raw prompt string. Mutually exclusive with `messages`. */
	prompt?: string;
	/** OpenAI-style messages; the binding renders the chat template. */
	messages?: CapacitorLlamaChatMessage[];
	chat_template?: string;
	jinja?: boolean;
	json_schema?: string;
	/** GBNF grammar source. */
	grammar?: string;
	grammar_lazy?: boolean;
	grammar_triggers?: Array<{ type: number; value: string; token: number }>;
	enable_thinking?: boolean;
	thinking_forced_open?: boolean;
	preserved_tokens?: string[];
	chat_format?: number;
	reasoning_format?: string;
	media_paths?: string[];
	stop?: string[];
	n_predict?: number;
	n_probs?: number;
	top_k?: number;
	top_p?: number;
	min_p?: number;
	xtc_probability?: number;
	xtc_threshold?: number;
	typical_p?: number;
	temperature?: number;
	penalty_last_n?: number;
	penalty_repeat?: number;
	penalty_freq?: number;
	penalty_present?: number;
	mirostat?: number;
	mirostat_tau?: number;
	mirostat_eta?: number;
	dry_multiplier?: number;
	dry_base?: number;
	dry_allowed_length?: number;
	dry_penalty_last_n?: number;
	dry_sequence_breakers?: string[];
	top_n_sigma?: number;
	ignore_eos?: boolean;
	logit_bias?: Array<[number, number]>;
	seed?: number;
	guide_tokens?: number[];
	tools?: object;
	parallel_tool_calls?: object;
	tool_choice?: string;
	response_format?: CapacitorLlamaResponseFormat;
	add_generation_prompt?: boolean;
	chat_template_kwargs?: Record<string, string>;
	prefill_text?: string;
}

export interface CapacitorLlamaToolCall {
	type: "function";
	id?: string;
	function: { name: string; arguments: string };
}

export interface CapacitorLlamaTokenData {
	token: string;
	completion_probabilities?: Array<{
		content: string;
		probs: Array<{ tok_str: string; prob: number }>;
	}>;
	content?: string;
	reasoning_content?: string;
	tool_calls?: CapacitorLlamaToolCall[];
	accumulated_text?: string;
}

export interface CapacitorLlamaCompletionResult {
	text: string;
	reasoning_content: string;
	tool_calls: CapacitorLlamaToolCall[];
	content: string;
	chat_format: number;
	tokens_predicted: number;
	tokens_evaluated: number;
	truncated: boolean;
	stopped_eos: boolean;
	stopped_word: string;
	stopped_limit: number;
	stopping_word: string;
	context_full: boolean;
	interrupted: boolean;
	tokens_cached: number;
	timings: {
		prompt_n: number;
		prompt_ms: number;
		prompt_per_token_ms: number;
		prompt_per_second: number;
		predicted_n: number;
		predicted_ms: number;
		predicted_per_token_ms: number;
		predicted_per_second: number;
	};
	completion_probabilities?: Array<{
		content: string;
		probs: Array<{ tok_str: string; prob: number }>;
	}>;
	audio_tokens?: number[];
}

export interface CapacitorLlamaTokenizeResult {
	tokens: number[];
	has_images: boolean;
	bitmap_hashes: number[];
	chunk_pos: number[];
	chunk_pos_images: number[];
}

export interface CapacitorLlamaEmbeddingResult {
	embedding: number[];
}

export interface CapacitorLlamaBenchResult {
	modelDesc: string;
	modelSize: number;
	modelNParams: number;
	ppAvg: number;
	ppStd: number;
	tgAvg: number;
	tgStd: number;
}

// === Model description (mirrors NativeLlamaContext['model'])  ==============

export interface CapacitorLlamaModelDescriptor {
	desc: string;
	size: number;
	nEmbd: number;
	nParams: number;
	chatTemplates: {
		llamaChat: boolean;
		minja: {
			default: boolean;
			defaultCaps: {
				tools: boolean;
				toolCalls: boolean;
				toolResponses: boolean;
				systemRole: boolean;
				parallelToolCalls: boolean;
				toolCallId: boolean;
			};
			toolUse: boolean;
			toolUseCaps: {
				tools: boolean;
				toolCalls: boolean;
				toolResponses: boolean;
				systemRole: boolean;
				parallelToolCalls: boolean;
				toolCallId: boolean;
			};
		};
	};
	metadata: object;
	isChatTemplateSupported: boolean;
}

// === Canonical context interface ===========================================

/**
 * The canonical context handle every backend implements. Designed so a single
 * caller can switch between `llama-cpp-capacitor`'s `LlamaContext` and the
 * desktop bun:ffi-backed implementation with zero behavioural change at the
 * TypeScript level.
 *
 * Backends that genuinely cannot implement a method (e.g. `bench()` on the
 * desktop FFI adapter v1) MUST throw a `CapacitorLlamaUnsupportedError` so
 * callers can route around the gap explicitly rather than silently producing
 * wrong results.
 */
export interface CapacitorLlamaContext {
	readonly id: number;
	readonly gpu: boolean;
	readonly reasonNoGPU: string;
	readonly model: CapacitorLlamaModelDescriptor;

	completion(
		params: CapacitorLlamaCompletionParams,
		callback?: (data: CapacitorLlamaTokenData) => void,
	): Promise<CapacitorLlamaCompletionResult>;

	stopCompletion(): Promise<void>;

	tokenize(
		text: string,
		options?: { media_paths?: string[] },
	): Promise<CapacitorLlamaTokenizeResult>;

	detokenize(tokens: number[]): Promise<string>;

	embedding(
		text: string,
		params?: { embd_normalize?: number },
	): Promise<CapacitorLlamaEmbeddingResult>;

	bench(
		pp: number,
		tg: number,
		pl: number,
		nr: number,
	): Promise<CapacitorLlamaBenchResult>;

	release(): Promise<void>;
}

/** Thrown by adapter methods that aren't implemented for a given backend. */
export class CapacitorLlamaUnsupportedError extends Error {
	constructor(
		readonly method: string,
		readonly backend: "mobile" | "desktop-ffi",
		message?: string,
	) {
		super(
			message ??
				`[capacitor-llama] ${method} is not supported on ${backend} yet`,
		);
		this.name = "CapacitorLlamaUnsupportedError";
	}
}

// === Model registry =======================================================

export interface ModelSpec {
	name: string;
	repo: string;
	size: string;
	quantization: string;
	contextSize: number;
	tokenizer: TokenizerConfig;
}

export interface EmbeddingModelSpec extends ModelSpec {
	dimensions: number;
}

/**
 * Default model bundle. Vision and TTS are owned by `plugin-local-inference`'s
 * voice and vision subsystems — they don't live on this adapter.
 */
export const MODEL_SPECS = {
	small: {
		name: "text/eliza-1-2b-128k.gguf",
		repo: "elizaos/eliza-1",
		size: "2B",
		quantization: "fused GGUF",
		contextSize: 131072,
		tokenizer: { name: "elizaos/eliza-1", type: "eliza1" },
	},
	medium: {
		name: "text/eliza-1-4b-128k.gguf",
		repo: "elizaos/eliza-1",
		size: "4B",
		quantization: "fused GGUF",
		contextSize: 131072,
		tokenizer: { name: "elizaos/eliza-1", type: "eliza1" },
	},
	embedding: {
		name: "gte-small_fp16.gguf",
		repo: "ChristianAzinn/gte-small-gguf",
		size: "64 MB",
		quantization: "fp16 GGUF",
		contextSize: 512,
		dimensions: 384,
		tokenizer: { name: "ChristianAzinn/gte-small-gguf", type: "bert" },
	},
} as const satisfies {
	small: ModelSpec;
	medium: ModelSpec;
	embedding: EmbeddingModelSpec;
};

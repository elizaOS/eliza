/**
 * Generic single-file GGUF backend.
 *
 * The explicit-`modelPath` text runtime for a model the user downloaded or
 * scanned (a Hugging Face / ModelScope GGUF, an LM Studio / Ollama / Jan file),
 * as opposed to a curated Eliza-1 bundle. It loads ONE GGUF from an explicit
 * path with stock f16 KV — no Eliza-1 bundle layout, no fused MTP, no fork KV
 * kernels, no fused voice/vision. This is the honest "reduced optimizations"
 * path.
 *
 * Runtime binding: the explicit-`modelPath` `llama-cpp-capacitor` context
 * (`initCapacitorLlama({ model })`). That binding ships on mobile
 * (`ELIZA_PLATFORM=android|ios`); on desktop the explicit-path FFI binding (the
 * retired libllama + eliza-llama-shim) is not built into the shipping
 * `libelizainference`, so `available()` reports false there and the dispatcher
 * raises a typed `GenericRuntimeUnavailableError` rather than mis-loading the
 * GGUF through the bundle-locked fused path.
 */

import type { CapacitorLlamaContext } from "../adapters/capacitor-llama/types";
import type {
	BackendPlan,
	GenerateArgs,
	GenerateResult,
	LocalGenerateWithUsageResult,
	LocalInferenceBackend,
} from "./backend";

/**
 * Minimal explicit-`modelPath` loader contract. The default implementation
 * dynamic-imports the capacitor loader; tests inject a fake to exercise the
 * dispatcher routing without a native binding.
 */
export interface ExplicitModelPathLoader {
	/** True when this platform can load a GGUF from an explicit path. */
	available(): boolean | Promise<boolean>;
	/** Load a single GGUF from `modelPath`. */
	load(args: {
		modelPath: string;
		contextSize?: number;
		gpuLayers?: number;
	}): Promise<CapacitorLlamaContext>;
}

/**
 * Default loader: the mobile-only `llama-cpp-capacitor` explicit-path binding.
 * `available()` follows the same platform gate as `initCapacitorLlama` — true
 * only on `ELIZA_PLATFORM=android|ios`. Desktop has no explicit-path runtime
 * built into the shipping libelizainference, so this reports false there.
 */
export class CapacitorExplicitModelPathLoader
	implements ExplicitModelPathLoader
{
	available(): boolean {
		const platform = process.env.ELIZA_PLATFORM?.trim().toLowerCase();
		return platform === "android" || platform === "ios";
	}

	async load(args: {
		modelPath: string;
		contextSize?: number;
		gpuLayers?: number;
	}): Promise<CapacitorLlamaContext> {
		const { initCapacitorLlama } = await import(
			"../adapters/capacitor-llama/loader"
		);
		return initCapacitorLlama({
			model: args.modelPath,
			...(args.contextSize !== undefined ? { n_ctx: args.contextSize } : {}),
			n_gpu_layers: args.gpuLayers ?? 999,
			use_mmap: true,
		});
	}
}

export class GenericGgufBackend implements LocalInferenceBackend {
	readonly id = "generic-gguf" as const;

	private ctx: CapacitorLlamaContext | null = null;
	private loadedPath: string | null = null;

	constructor(
		private readonly loader: ExplicitModelPathLoader = new CapacitorExplicitModelPathLoader(),
	) {}

	async available(): Promise<boolean> {
		return this.loader.available();
	}

	hasLoadedModel(): boolean {
		return this.ctx !== null;
	}

	currentModelPath(): string | null {
		return this.loadedPath;
	}

	async load(plan: BackendPlan): Promise<void> {
		if (this.ctx) await this.unload();
		this.ctx = await this.loader.load({
			modelPath: plan.modelPath,
			...(plan.overrides?.contextSize !== undefined
				? { contextSize: plan.overrides.contextSize }
				: {}),
			...(typeof plan.overrides?.gpuLayers === "number"
				? { gpuLayers: plan.overrides.gpuLayers }
				: {}),
		});
		this.loadedPath = plan.modelPath;
	}

	async unload(): Promise<void> {
		const ctx = this.ctx;
		this.ctx = null;
		this.loadedPath = null;
		if (ctx) await ctx.release();
	}

	async generate(args: GenerateArgs): Promise<GenerateResult> {
		const result = await this.generateWithUsage(args);
		return result.text;
	}

	async generateWithUsage(
		args: GenerateArgs & { slotId?: number },
	): Promise<LocalGenerateWithUsageResult> {
		const ctx = this.ctx;
		if (!ctx) {
			throw new Error(
				"[generic-gguf-backend] generate() called before load() — no GGUF context.",
			);
		}
		const completion = await ctx.completion(
			{
				prompt: args.prompt,
				n_predict: args.maxTokens ?? 2048,
				temperature: args.temperature ?? 0.7,
				top_p: args.topP ?? 0.9,
				stop: args.stopSequences ?? [],
			},
			args.onTextChunk
				? (token) => {
						const piece = token.token ?? token.content ?? "";
						if (piece) void args.onTextChunk?.(piece);
					}
				: undefined,
		);
		const text = completion.content || completion.text;
		return {
			text,
			usage: {
				prompt_tokens: completion.tokens_evaluated,
				completion_tokens: completion.tokens_predicted,
				total_tokens: completion.tokens_evaluated + completion.tokens_predicted,
			},
		};
	}
}

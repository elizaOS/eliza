/**
 * Canonical Capacitor-llama loader.
 *
 * `initCapacitorLlama(params)` returns a context that implements
 * `CapacitorLlamaContext`. Backend selection:
 *
 *  - **Mobile (`ELIZA_PLATFORM=android|ios`):** dynamic-imports
 *    `llama-cpp-capacitor`. The package's `LlamaContext` already implements
 *    the canonical shape verbatim, so we return it directly with an `as`
 *    cast (the d.ts overlaps by construction).
 *
 *  - **Desktop / riscv64 / fallback:** wraps `DesktopLlamaAdapter`
 *    (bun:ffi → libllama.so) in a thin façade that emulates the Capacitor
 *    surface. Streaming completion goes through the existing `LlmStreamingBinding`;
 *    embeddings & bench currently throw `CapacitorLlamaUnsupportedError`
 *    (gap documented in the adapter README).
 *
 * No `node-llama-cpp` import — anywhere. This is the whole point of the
 * migration.
 */

import { logger } from "@elizaos/core";
import {
	type DesktopLlamaAdapter,
	type DesktopLlamaLoadOptions,
	desktopLlamaDylibsPresent,
	loadDesktopLlama,
} from "../../services/desktop-llama-adapter";
import {
	type CapacitorLlamaBenchResult,
	type CapacitorLlamaCompletionParams,
	type CapacitorLlamaCompletionResult,
	type CapacitorLlamaContext,
	type CapacitorLlamaContextParams,
	type CapacitorLlamaEmbeddingResult,
	type CapacitorLlamaModelDescriptor,
	type CapacitorLlamaTokenData,
	type CapacitorLlamaTokenizeResult,
	CapacitorLlamaUnsupportedError,
} from "./types";

// === Mobile shim ===========================================================

interface MobileCapacitorModule {
	initLlama(
		params: CapacitorLlamaContextParams,
		onProgress?: (progress: number) => void,
	): Promise<CapacitorLlamaContext>;
	releaseAllLlama(): Promise<void>;
	setContextLimit(limit: number): Promise<void>;
	toggleNativeLog(enabled: boolean): Promise<void>;
}

let cachedMobileModule: MobileCapacitorModule | null = null;

async function loadMobileCapacitor(): Promise<MobileCapacitorModule> {
	if (cachedMobileModule) return cachedMobileModule;
	// Dynamic import keeps the desktop / test runtime from trying to resolve
	// the mobile-only native binding.
	const spec = "llama-cpp-capacitor";
	const mod = (await import(spec)) as MobileCapacitorModule;
	if (typeof mod.initLlama !== "function") {
		throw new Error(
			"[capacitor-llama] llama-cpp-capacitor did not expose initLlama — the binding is missing or stubbed.",
		);
	}
	cachedMobileModule = mod;
	return mod;
}

// === Desktop façade ========================================================

interface DesktopMutableModelDescriptor {
	desc: string;
	size: number;
	nEmbd: number;
	nParams: number;
	chatTemplates: CapacitorLlamaModelDescriptor["chatTemplates"];
	metadata: object;
	isChatTemplateSupported: boolean;
}

/**
 * Minimal model descriptor synthesized for the desktop FFI path. The shim
 * does not yet expose `llama_model_meta_*` getters, so most fields are
 * placeholders. They're consumed by telemetry / UI only — the inference path
 * doesn't read them.
 */
function synthesizeDesktopModelDescriptor(
	modelPath: string,
): DesktopMutableModelDescriptor {
	return {
		desc: modelPath,
		size: 0,
		nEmbd: 0,
		nParams: 0,
		chatTemplates: {
			llamaChat: true,
			minja: {
				default: false,
				defaultCaps: {
					tools: false,
					toolCalls: false,
					toolResponses: false,
					systemRole: true,
					parallelToolCalls: false,
					toolCallId: false,
				},
				toolUse: false,
				toolUseCaps: {
					tools: false,
					toolCalls: false,
					toolResponses: false,
					systemRole: true,
					parallelToolCalls: false,
					toolCallId: false,
				},
			},
		},
		metadata: {},
		isChatTemplateSupported: true,
	};
}

class DesktopCapacitorLlamaContext implements CapacitorLlamaContext {
	readonly id: number;
	readonly gpu: boolean;
	readonly reasonNoGPU: string;
	readonly model: CapacitorLlamaModelDescriptor;

	private currentSession: bigint | null = null;
	private nextSessionToken = 1;

	constructor(
		private readonly adapter: DesktopLlamaAdapter,
		readonly params: CapacitorLlamaContextParams,
	) {
		this.id = Math.floor(Math.random() * 0x7fffffff);
		this.gpu = (params.n_gpu_layers ?? 0) > 0 && !params.no_gpu_devices;
		this.reasonNoGPU = this.gpu ? "" : "GPU offload disabled (n_gpu_layers=0)";
		this.model = synthesizeDesktopModelDescriptor(params.model);
	}

	async completion(
		params: CapacitorLlamaCompletionParams,
		callback?: (data: CapacitorLlamaTokenData) => void,
	): Promise<CapacitorLlamaCompletionResult> {
		const prompt = params.prompt;
		if (typeof prompt !== "string") {
			throw new CapacitorLlamaUnsupportedError(
				"completion(messages)",
				"desktop-ffi",
				"[capacitor-llama] desktop FFI path requires `prompt`; chat-template rendering (`messages`) is not bound yet. Render the template upstream and pass the resulting prompt string.",
			);
		}
		const startedMs = Date.now();

		// Open a streaming session. We mirror the LlmStreamingBinding contract
		// because the existing desktop adapter is already wired against it.
		const binding = this.adapter.createBinding();
		const stream = binding.llmStreamOpen({
			ctx: this.adapter.getCtxHandle(),
			config: {
				temperature: params.temperature ?? 0.7,
				topP: params.top_p ?? 0.9,
				topK: params.top_k ?? 0,
				maxTokens: params.n_predict ?? -1,
				repeatPenalty: params.penalty_repeat ?? 1,
				slotId: -1,
				promptCacheKey: null,
				draftMin: 0,
				draftMax: 0,
				draftModelPath: null,
			},
		});
		this.currentSession = stream;

		try {
			const tokens = this.adapter.tokenize(prompt);
			binding.llmStreamPrefill({ stream, tokens });

			let acc = "";
			let predicted = 0;
			let stoppedEos = false;
			const tokensCap = params.n_predict ?? 2048;
			const stops = params.stop ?? [];

			while (predicted < tokensCap) {
				const step = binding.llmStreamNext({
					stream,
					maxTokensPerStep: 16,
					maxTextBytes: 1024,
				});
				if (step.text.length > 0) {
					acc += step.text;
					callback?.({
						token: step.text,
						content: step.text,
						accumulated_text: acc,
					});
					predicted += step.tokens.length;
				}
				if (step.done) {
					stoppedEos = true;
					break;
				}
				// Stop-token check against accumulated text.
				if (stops.some((s) => acc.endsWith(s))) {
					break;
				}
			}

			const elapsedMs = Date.now() - startedMs;
			const promptTokens = tokens.length;
			return {
				text: acc,
				reasoning_content: "",
				tool_calls: [],
				content: acc,
				chat_format: 0,
				tokens_predicted: predicted,
				tokens_evaluated: promptTokens,
				truncated: false,
				stopped_eos: stoppedEos,
				stopped_word: "",
				stopped_limit: predicted >= tokensCap ? 1 : 0,
				stopping_word: "",
				context_full: false,
				interrupted: false,
				tokens_cached: promptTokens,
				timings: {
					prompt_n: promptTokens,
					prompt_ms: 0,
					prompt_per_token_ms: 0,
					prompt_per_second: 0,
					predicted_n: predicted,
					predicted_ms: elapsedMs,
					predicted_per_token_ms: predicted > 0 ? elapsedMs / predicted : 0,
					predicted_per_second:
						elapsedMs > 0 ? (predicted * 1000) / elapsedMs : 0,
				},
			};
		} finally {
			binding.llmStreamClose(stream);
			this.currentSession = null;
		}
	}

	async stopCompletion(): Promise<void> {
		const stream = this.currentSession;
		if (stream === null) return;
		const binding = this.adapter.createBinding();
		binding.llmStreamCancel(stream);
	}

	async tokenize(
		text: string,
		_options?: { media_paths?: string[] },
	): Promise<CapacitorLlamaTokenizeResult> {
		const tokens = this.adapter.tokenize(text);
		return {
			tokens: Array.from(tokens),
			has_images: false,
			bitmap_hashes: [],
			chunk_pos: [],
			chunk_pos_images: [],
		};
	}

	async detokenize(_tokens: number[]): Promise<string> {
		throw new CapacitorLlamaUnsupportedError(
			"detokenize",
			"desktop-ffi",
			"[capacitor-llama] detokenize is not bound on the desktop FFI shim yet — wire `llama_token_to_piece` through the shim and expose here.",
		);
	}

	async embedding(
		_text: string,
		_params?: { embd_normalize?: number },
	): Promise<CapacitorLlamaEmbeddingResult> {
		throw new CapacitorLlamaUnsupportedError(
			"embedding",
			"desktop-ffi",
			"[capacitor-llama] embedding extraction is not implemented on the desktop FFI path; route TEXT_EMBEDDING through the mtp subprocess backend until the shim adds llama_embeddings + per-context embedding mode toggle.",
		);
	}

	async bench(
		_pp: number,
		_tg: number,
		_pl: number,
		_nr: number,
	): Promise<CapacitorLlamaBenchResult> {
		throw new CapacitorLlamaUnsupportedError("bench", "desktop-ffi");
	}

	async release(): Promise<void> {
		this.adapter.close();
	}

	// Internal helper — used by structured-output and tests to grab a fresh
	// stream id without going through the public `completion` path.
	_allocateSessionToken(): number {
		return this.nextSessionToken++;
	}
}

// === Public loader =========================================================

export interface InitCapacitorLlamaOptions extends CapacitorLlamaContextParams {
	/**
	 * Force a specific backend. When omitted, the loader picks `mobile` on
	 * `ELIZA_PLATFORM=android|ios`, otherwise `desktop`. `mobile` requires the
	 * `llama-cpp-capacitor` package; `desktop` requires the bundled libllama
	 * dylib pair.
	 */
	backend?: "mobile" | "desktop";
}

function detectBackend(
	env: NodeJS.ProcessEnv = process.env,
): "mobile" | "desktop" {
	const platform = env.ELIZA_PLATFORM?.trim().toLowerCase();
	if (platform === "android" || platform === "ios") return "mobile";
	return "desktop";
}

/**
 * Load a Capacitor-shaped llama.cpp context. The returned handle is
 * platform-independent — callers should not branch on `backend`. When the
 * desktop FFI backend cannot satisfy a method, it throws
 * `CapacitorLlamaUnsupportedError` which callers MUST handle explicitly.
 */
export async function initCapacitorLlama(
	opts: InitCapacitorLlamaOptions,
): Promise<CapacitorLlamaContext> {
	const { backend, ...params } = opts;
	const target = backend ?? detectBackend();

	if (target === "mobile") {
		const mod = await loadMobileCapacitor();
		return mod.initLlama(params);
	}

	if (!desktopLlamaDylibsPresent()) {
		throw new Error(
			"[capacitor-llama] desktop libllama+shim dylibs are not present. Run `bun run build:llama-cpp-desktop-dylib` or set ELIZA_DESKTOP_BACKEND appropriately.",
		);
	}
	const loadOptions: DesktopLlamaLoadOptions = {
		modelPath: params.model,
		contextSize: params.n_ctx,
		nBatch: params.n_batch,
		nUBatch: params.n_ubatch,
		gpuLayers: params.n_gpu_layers,
		threads: params.n_threads,
		useMmap: params.use_mmap,
		useMlock: params.use_mlock,
	};
	const loaded = await loadDesktopLlama(loadOptions);
	if (!loaded) {
		throw new Error(
			"[capacitor-llama] desktop FFI load failed — bun:ffi unavailable or dlopen errored. Check ELIZA_STATE_DIR/local-inference/bin/llama-cpp/<platform>-<arch>-<backend>/.",
		);
	}
	logger.info(
		{ modelPath: params.model, backend: "desktop-ffi" },
		"[capacitor-llama] desktop FFI context ready",
	);
	return new DesktopCapacitorLlamaContext(loaded.adapter, params);
}

/** Mobile-only: release every context. No-op on desktop. */
export async function releaseAllCapacitorLlama(): Promise<void> {
	if (detectBackend() !== "mobile") return;
	try {
		const mod = await loadMobileCapacitor();
		await mod.releaseAllLlama();
	} catch (err) {
		logger.debug(
			{ err: err instanceof Error ? err.message : String(err) },
			"[capacitor-llama] releaseAllLlama not available",
		);
	}
}

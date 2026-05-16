/**
 * LiveKit turn-detector — GGUF-backed binding (J1.d).
 *
 * The text-side turn-completion classifier formats the latest partial
 * user transcript with the Qwen chat template, strips the trailing
 * `<|im_end|>`, and reads `P(<|im_end|>)` from the next-token
 * distribution. The upstream `livekit/turn-detector` ships an ONNX
 * graph; this binding consumes the **GGUF** export published at
 * `elizalabs/eliza-1` under `voice/turn-detector/onnx/turn-detector-en-q8.gguf`
 * (and the multilingual variant at
 * `voice/turn/intl/turn-detector-intl-q8.gguf`), running through the
 * canonical fork wrapper `node-llama-cpp` (per
 * `plugins/plugin-local-inference/native/AGENTS.md` §1 — the npm
 * `node-llama-cpp` dep is the elizaOS fork's republish, binding to the
 * fork's `libllama`).
 *
 * Why this exists: per I1's single-runtime audit
 * (`.swarm/impl/I1-single-runtime.md` §B), the turn-detector was the
 * cheapest of the four remaining ONNX surfaces to retire — the GGUF
 * artifact was already published by H4 (see commit history), and the
 * detector's architecture (Qwen2-style small decoder + classification
 * head on the `<|im_end|>` logit) is exactly what `LLM_ARCH_QWEN2`
 * already implements in the fork. The work is wiring, not porting.
 *
 * No silent fallback (AGENTS.md §3): when `node-llama-cpp` is
 * unavailable, the GGUF is missing, or the model load fails, this
 * class throws `EotGgmlUnavailableError` with a structured code. The
 * resolver above this binding picks `HeuristicEotClassifier` or the
 * legacy ONNX path; the binding itself never fabricates a probability.
 *
 * Tokenizer ownership: the GGUF carries its own tokenizer (BPE +
 * special tokens, including `<|im_end|>`); this binding does NOT
 * import `@huggingface/transformers`. The `apply_chat_template`
 * formatting is re-implemented here using the same template upstream
 * uses (single-turn user message wrapped in `<|im_start|>user\n... \n`)
 * — see `applyQwenUserTemplate` below.
 */

import { access } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { EotClassifier, VoiceTurnSignal } from "./eot-classifier";
import { turnSignalFromProbability } from "./eot-classifier";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Raised when the GGUF binding cannot be loaded or scored. */
export class EotGgmlUnavailableError extends Error {
	readonly code:
		| "native-missing"
		| "model-missing"
		| "model-load-failed"
		| "tokenizer-missing-im-end"
		| "evaluate-failed"
		| "invalid-input";
	constructor(code: EotGgmlUnavailableError["code"], message: string) {
		super(message);
		this.name = "EotGgmlUnavailableError";
		this.code = code;
	}
}

// ---------------------------------------------------------------------------
// HF asset constants
// ---------------------------------------------------------------------------

/** HF mono-repo holding every voice sub-model. */
export const LIVEKIT_TURN_DETECTOR_HF_REPO = "elizalabs/eliza-1";

/** Canonical English GGUF asset path inside the bundle. */
export const DEFAULT_LIVEKIT_TURN_DETECTOR_GGUF_EN =
	"voice/turn-detector/onnx/turn-detector-en-q8.gguf";

/** Canonical multilingual GGUF asset path inside the bundle. */
export const DEFAULT_LIVEKIT_TURN_DETECTOR_GGUF_INTL =
	"voice/turn/intl/turn-detector-intl-q8.gguf";

/** Special-token literal the detector reads the probability of. */
export const LIVEKIT_IM_END_TOKEN = "<|im_end|>";

/**
 * Default on-disk location for the staged GGUF. The bundle downloader
 * materializes assets under `~/.eliza/local-inference/models/...`; this
 * matches the path used by the ONNX-backed `LiveKitTurnDetector`.
 */
export const DEFAULT_LIVEKIT_TURN_DETECTOR_GGML_DIR = path.join(
	homedir(),
	".eliza",
	"local-inference",
	"models",
	"turn-detector",
	"livekit-turn-detector",
);

/**
 * Resolve which GGUF variant a given Eliza-1 tier should bundle.
 * Mirrors `turnDetectorRevisionForTier` in `eot-classifier.ts` —
 * mobile tiers get the English-only ~40 MB Q8 GGUF, desktop tiers
 * get the multilingual ~280 MB Q8 GGUF.
 *
 * Accepts both bare tier ids (`"4b"`) and prefixed catalog ids
 * (`"eliza-1-4b"`).
 */
export function turnDetectorGgufForTier(tierId: string): {
	hfPath: string;
	variant: "en" | "intl";
} {
	const bare = tierId.startsWith("eliza-1-")
		? tierId.slice("eliza-1-".length)
		: tierId;
	if (bare === "0_8b" || bare === "2b") {
		return {
			hfPath: DEFAULT_LIVEKIT_TURN_DETECTOR_GGUF_EN,
			variant: "en",
		};
	}
	return {
		hfPath: DEFAULT_LIVEKIT_TURN_DETECTOR_GGUF_INTL,
		variant: "intl",
	};
}

// ---------------------------------------------------------------------------
// node-llama-cpp lazy import (fork wrapper — per native/AGENTS.md §1)
// ---------------------------------------------------------------------------

interface NlcModule {
	getLlama(opts?: {
		gpu?: false | "auto" | "metal" | "cuda" | "vulkan";
		logLevel?: string;
	}): Promise<NlcLlama>;
}

interface NlcLlama {
	loadModel(opts: {
		modelPath: string;
		gpuLayers?: number | "max" | "auto";
	}): Promise<NlcLlamaModel>;
}

interface NlcLlamaModel {
	tokenize(text: string, specialTokens?: boolean): number[];
	detokenize(tokens: readonly number[], specialTokens?: boolean): string;
	createContext(opts?: {
		contextSize?: number | "auto";
		batchSize?: number;
		threads?: number;
	}): Promise<NlcLlamaContext>;
	dispose(): Promise<void>;
}

interface NlcLlamaContext {
	getSequence(): NlcLlamaSequence;
	dispose(): Promise<void>;
}

interface NlcControlledIndexOutput {
	next: {
		token?: number | null;
		confidence?: number;
		probabilities?: Map<number, number>;
	};
}

interface NlcLlamaSequence {
	controlledEvaluate(
		input: ReadonlyArray<
			| number
			| [
					number,
					{
						generateNext?: {
							probabilities?: boolean;
							confidence?: boolean;
							token?: boolean;
						};
					},
			  ]
		>,
		opts?: unknown,
	): Promise<ReadonlyArray<NlcControlledIndexOutput | undefined>>;
	clearHistory(): Promise<void>;
	dispose?(): Promise<void>;
}

let cachedNlcModule: NlcModule | null = null;
async function loadNlc(): Promise<NlcModule> {
	if (cachedNlcModule) return cachedNlcModule;
	try {
		const mod = (await import("node-llama-cpp")) as unknown as NlcModule;
		cachedNlcModule = mod;
		return mod;
	} catch (err) {
		throw new EotGgmlUnavailableError(
			"native-missing",
			`[eot-ggml] node-llama-cpp is not installed: ${err instanceof Error ? err.message : String(err)}. The fork's canonical wrapper is required (see plugins/plugin-local-inference/native/AGENTS.md §1).`,
		);
	}
}

let cachedLlama: NlcLlama | null = null;
async function getLlama(): Promise<NlcLlama> {
	if (cachedLlama) return cachedLlama;
	const mod = await loadNlc();
	// CPU-only for the turn-detector: the model is small (~40-280 MB), the
	// classification call is single-token, and putting it on GPU would
	// contend with the text model that's already there.
	cachedLlama = await mod.getLlama({ gpu: false });
	return cachedLlama;
}

// ---------------------------------------------------------------------------
// Construction options
// ---------------------------------------------------------------------------

export interface LiveKitGgmlTurnDetectorOptions {
	/** Absolute path to the GGUF file. Required. */
	ggufPath: string;
	/**
	 * Upstream revision tag for telemetry only (`"v1.2.2-en"` /
	 * `"v0.4.1-intl"`). Does not affect inference.
	 */
	revision?: string;
	/** Max history tokens after Qwen-template wrapping. Default: 128. */
	maxHistoryTokens?: number;
	/** Optional model label for telemetry. */
	model?: string;
	/** Optional thread count for the context. Default: 2. */
	threads?: number;
}

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

/**
 * Local GGUF-backed LiveKit turn-detector. Replaces the ONNX path in
 * `LiveKitTurnDetector` with a `node-llama-cpp` evaluation of the same
 * Qwen2-style decoder, reading `P(<|im_end|>)` from the next-token
 * distribution after the truncated user-template prefix.
 *
 * One detector instance owns one `LlamaModel` + one `LlamaContext` +
 * one `LlamaSequence`. `score()` resets the sequence between calls —
 * the detector is intentionally stateless (no carried context across
 * different user transcripts).
 */
export class LiveKitGgmlTurnDetector implements EotClassifier {
	readonly ggufPath: string;
	private readonly maxHistoryTokens: number;
	private readonly model: string;
	private readonly revision: string | undefined;
	private readonly threads: number;
	private ready: Promise<{
		llamaModel: NlcLlamaModel;
		context: NlcLlamaContext;
		sequence: NlcLlamaSequence;
		imEndTokenId: number;
	}> | null = null;

	constructor(opts: LiveKitGgmlTurnDetectorOptions) {
		if (typeof opts.ggufPath !== "string" || opts.ggufPath.length === 0) {
			throw new EotGgmlUnavailableError(
				"invalid-input",
				"[eot-ggml] ggufPath is required",
			);
		}
		this.ggufPath = opts.ggufPath;
		this.maxHistoryTokens = opts.maxHistoryTokens ?? 128;
		this.revision = opts.revision;
		this.threads = opts.threads ?? 2;
		this.model =
			opts.model ??
			(opts.revision
				? `${LIVEKIT_TURN_DETECTOR_HF_REPO}@${opts.revision}`
				: LIVEKIT_TURN_DETECTOR_HF_REPO);
	}

	async score(partialTranscript: string): Promise<number> {
		return (await this.signal(partialTranscript)).endOfTurnProbability;
	}

	async signal(partialTranscript: string): Promise<VoiceTurnSignal> {
		const started = performance.now();
		const loaded = await this.load();
		const transcript = normalizeTurnDetectorText(partialTranscript);
		// Tokenize the user-templated transcript WITHOUT the trailing
		// `<|im_end|>` (the head must score that token as the next one).
		// We do not pass `specialTokens=true` for the user text itself —
		// only the template wrappers themselves are special tokens.
		const promptText = applyQwenUserTemplate(transcript);

		// Tokenize: the template wrappers are special tokens; the GGUF's
		// BPE handles the inner text. Passing `true` tells the tokenizer
		// to recognize the `<|im_start|>` / `\n` literals as the real
		// special-token ids. Truncate from the LEFT so the recent text
		// is preserved.
		let tokens = loaded.llamaModel.tokenize(promptText, true);
		if (tokens.length > this.maxHistoryTokens) {
			tokens = tokens.slice(tokens.length - this.maxHistoryTokens);
		}
		if (tokens.length === 0) {
			throw new EotGgmlUnavailableError(
				"evaluate-failed",
				"[eot-ggml] tokenizer produced empty token list for transcript",
			);
		}

		// Clear the sequence before each evaluation — turn detection is
		// stateless per transcript.
		await loaded.sequence.clearHistory();

		// Feed every token, asking for the probability distribution only
		// on the LAST one. That gives us P(token=<|im_end|>) after the
		// truncated template prefix.
		const lastIdx = tokens.length - 1;
		const input = tokens.map((tok, i) =>
			i === lastIdx
				? ([tok, { generateNext: { probabilities: true } }] as [
						number,
						{ generateNext: { probabilities: boolean } },
					])
				: tok,
		);
		const results = await loaded.sequence.controlledEvaluate(input);
		const last = results[lastIdx];
		const probs = last?.next.probabilities;
		if (!probs) {
			throw new EotGgmlUnavailableError(
				"evaluate-failed",
				"[eot-ggml] controlledEvaluate did not return probabilities for the last token",
			);
		}
		const imEndProb = probs.get(loaded.imEndTokenId) ?? 0;

		return turnSignalFromProbability({
			probability: imEndProb,
			transcript,
			source: "livekit-turn-detector",
			model: this.model,
			latencyMs: performance.now() - started,
		});
	}

	/** Release the underlying GGUF + context. Idempotent. */
	async dispose(): Promise<void> {
		const r = this.ready;
		this.ready = null;
		if (!r) return;
		const loaded = await r.catch(() => null);
		if (!loaded) return;
		await loaded.sequence.dispose?.().catch(() => undefined);
		await loaded.context.dispose().catch(() => undefined);
		await loaded.llamaModel.dispose().catch(() => undefined);
	}

	private load(): Promise<{
		llamaModel: NlcLlamaModel;
		context: NlcLlamaContext;
		sequence: NlcLlamaSequence;
		imEndTokenId: number;
	}> {
		this.ready ??= this.loadInner();
		return this.ready;
	}

	private async loadInner(): Promise<{
		llamaModel: NlcLlamaModel;
		context: NlcLlamaContext;
		sequence: NlcLlamaSequence;
		imEndTokenId: number;
	}> {
		try {
			await access(this.ggufPath);
		} catch {
			throw new EotGgmlUnavailableError(
				"model-missing",
				`[eot-ggml] GGUF not found at ${this.ggufPath}. Stage it via the bundle downloader from ${LIVEKIT_TURN_DETECTOR_HF_REPO}.`,
			);
		}

		const llama = await getLlama();
		let llamaModel: NlcLlamaModel;
		try {
			llamaModel = await llama.loadModel({
				modelPath: this.ggufPath,
				gpuLayers: 0,
			});
		} catch (err) {
			throw new EotGgmlUnavailableError(
				"model-load-failed",
				`[eot-ggml] loadModel failed for ${this.ggufPath}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		// Resolve the <|im_end|> token id from the GGUF's BPE tokenizer.
		// Passing `specialTokens=true` tells the tokenizer to recognize
		// the literal as the corresponding special token.
		const imEndTokens = llamaModel.tokenize(LIVEKIT_IM_END_TOKEN, true);
		if (imEndTokens.length !== 1) {
			await llamaModel.dispose().catch(() => undefined);
			throw new EotGgmlUnavailableError(
				"tokenizer-missing-im-end",
				`[eot-ggml] tokenizer produced ${imEndTokens.length} tokens for <|im_end|>; expected exactly 1. The GGUF's special-token table is missing the expected entry.`,
			);
		}
		const imEndTokenId = imEndTokens[0];

		let context: NlcLlamaContext;
		try {
			context = await llamaModel.createContext({
				contextSize: Math.max(this.maxHistoryTokens, 256),
				threads: this.threads,
			});
		} catch (err) {
			await llamaModel.dispose().catch(() => undefined);
			throw new EotGgmlUnavailableError(
				"model-load-failed",
				`[eot-ggml] createContext failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		const sequence = context.getSequence();
		return { llamaModel, context, sequence, imEndTokenId };
	}
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Resolve a `LiveKitGgmlTurnDetector` against the bundle's on-disk
 * staging directory. Search order:
 *
 *   1. Explicit `opts.ggufPath`.
 *   2. `ELIZA_TURN_DETECTOR_GGUF` env var.
 *   3. `<modelDir>/<en GGUF name>` (the canonical layout for the
 *      bundle's English variant).
 *   4. `<modelDir>/<intl GGUF name>` (multilingual).
 *
 * Returns `null` if no GGUF is found alongside the directory — the
 * caller falls back to the legacy ONNX path (`createBundledLiveKitTurnDetector`)
 * which itself falls back to `HeuristicEotClassifier`.
 */
export async function createBundledLiveKitGgmlTurnDetector(
	opts: {
		ggufPath?: string;
		modelDir?: string;
		revision?: string;
		maxHistoryTokens?: number;
		threads?: number;
	} = {},
): Promise<LiveKitGgmlTurnDetector | null> {
	const candidates: string[] = [];

	const envOverride = process.env.ELIZA_TURN_DETECTOR_GGUF;
	if (opts.ggufPath) candidates.push(opts.ggufPath);
	if (envOverride) candidates.push(envOverride);

	const modelDir =
		opts.modelDir ??
		process.env.ELIZA_TURN_DETECTOR_MODEL_DIR ??
		DEFAULT_LIVEKIT_TURN_DETECTOR_GGML_DIR;

	// The on-disk staging layout mirrors the HF asset path, so the bundle
	// downloader will materialize the GGUF at one of these locations.
	candidates.push(
		path.join(modelDir, "turn-detector-en-q8.gguf"),
		path.join(modelDir, "turn-detector-intl-q8.gguf"),
		path.join(modelDir, "onnx", "turn-detector-en-q8.gguf"),
		path.join(modelDir, DEFAULT_LIVEKIT_TURN_DETECTOR_GGUF_EN),
		path.join(modelDir, DEFAULT_LIVEKIT_TURN_DETECTOR_GGUF_INTL),
	);

	for (const candidate of candidates) {
		try {
			await access(candidate);
			return new LiveKitGgmlTurnDetector({
				ggufPath: candidate,
				...(opts.revision ? { revision: opts.revision } : {}),
				...(opts.maxHistoryTokens !== undefined
					? { maxHistoryTokens: opts.maxHistoryTokens }
					: {}),
				...(opts.threads !== undefined ? { threads: opts.threads } : {}),
			});
		} catch {
			// try next
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Mirror of `normalizeTurnDetectorText` in `eot-classifier.ts`. The
 * upstream LiveKit detector lowercases + strips most punctuation
 * before tokenizing; we do the same so the two paths produce
 * comparable readings.
 */
function normalizeTurnDetectorText(text: string): string {
	return text
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}'\-\s]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Apply the single-turn user Qwen chat template, omitting the trailing
 * `<|im_end|>` so the detector head scores it as the next token.
 *
 * Upstream `livekit/turn-detector` formats:
 *
 *   <|im_start|>user\n{transcript}<|im_end|>\n
 *
 * The detector strips the trailing `<|im_end|>\n` and reads
 * `P(<|im_end|>)` after the user content. We emit the prefix exactly,
 * stopping where the `<|im_end|>` would go.
 */
export function applyQwenUserTemplate(transcript: string): string {
	return `<|im_start|>user\n${transcript}`;
}

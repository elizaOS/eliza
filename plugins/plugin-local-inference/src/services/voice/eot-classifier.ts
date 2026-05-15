/**
 * Semantic end-of-turn (EOT) classifier — Tier 3 of the three-tier VAD.
 *
 * Tier 1: RMS energy gate (~10 ms)
 * Tier 2: Silero VAD (~32 ms hop)
 * Tier 3: Semantic EOT classifier — P(turn_complete | transcript_so_far)
 *
 * The classifier operates on the partial transcript text emitted by streaming
 * ASR, not on audio. It returns P(done) ∈ [0, 1]. The voice state machine
 * uses it to:
 *
 *   P(done) ≥ 0.9 AND silence ≥ 50 ms  → commit immediately, skip hangover
 *   P(done) ≥ 0.6 AND silence ≥ 20 ms  → enter PAUSE_TENTATIVE early (start drafter)
 *   P(done) < 0.4                        → extend hangover by 50 ms (mid-clause)
 *
 * Four implementations ship:
 *
 *   `HeuristicEotClassifier` — deterministic, zero-latency, no model load.
 *     This is the baseline; it is always available.
 *
 *   `LiveKitTurnDetector` — local INT8 ONNX LiveKit turn detector
 *     (`livekit/turn-detector`). It formats the latest user transcript with
 *     the Qwen chat template, removes the final `<|im_end|>`, and reads
 *     P(`<|im_end|>` next) from the model. Two upstream revisions exist:
 *     `v1.2.2-en` (SmolLM2-135M distilled, ~66 MB Q8 ONNX) for mobile/small
 *     tiers, and `v0.4.1-intl` (pruned Qwen2.5-0.5B, ~396 MB Q8 ONNX,
 *     14 languages) for desktop/server tiers.
 *
 *   `TurnsenseEotClassifier` — Apache-2.0 fallback. Wraps the
 *     `latishab/turnsense` ONNX (SmolLM2-135M with a binary classification
 *     head). English-only and slightly less accurate, but unrestricted
 *     license, useful for environments where the LiveKit Model License is
 *     blocked.
 *
 *   `RemoteEotClassifier` — fail-closed HTTP adapter for a real model server.
 *     It throws on network/parse errors so callers never mistake a synthetic
 *     fallback for a measured turn signal.
 *
 * Cancellation contract (handshake with VoiceTurnController / R11): the
 * classifier emits a `VoiceTurnSignal` per partial transcript. It NEVER
 * aborts a turn directly — `signal()` is data, not a cancellation. The
 * controller layer above consumes the signal and decides whether to
 * suppress (via `BargeInCancelToken.signal` with reason `"turn-suppressed"`).
 */

import { access } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { Eliza1EotScorer } from "./eliza1-eot-scorer";
import type {
	Eliza1EotScoreResult,
	Eliza1EotScorerOptions,
} from "./eliza1-eot-scorer";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export type VoiceNextSpeaker = "agent" | "user" | "unknown";

export interface VoiceTurnSignal {
	/** P(user turn complete | transcript/history). */
	endOfTurnProbability: number;
	/**
	 * The best turn-taking read from this signal. Text-only EOU models infer
	 * this from end-of-turn probability; audio/prosody models can set it
	 * directly.
	 */
	nextSpeaker: VoiceNextSpeaker;
	/** Whether the agent should begin a response now. */
	agentShouldSpeak: boolean | null;
	/** Implementation/source name for telemetry and trace records. */
	source:
		| "heuristic"
		| "livekit-turn-detector"
		| "eliza-1-drafter"
		| "remote"
		| "custom";
	/** Optional model/version identifier for telemetry. */
	model?: string;
	/** Text actually scored after normalization/template truncation. */
	transcript: string;
	/** Wall-clock model latency, excluding caller queueing. */
	latencyMs?: number;
}

/**
 * End-of-turn classifier interface. Both implementations satisfy this contract
 * so callers are backend-agnostic.
 */
export interface EotClassifier {
	/** Return P(turn_complete) ∈ [0, 1] for `partialTranscript`. */
	score(partialTranscript: string): Promise<number>;
	/** Return the structured turn signal when the implementation can provide it. */
	signal?(partialTranscript: string): Promise<VoiceTurnSignal>;
}

export function clampProbability(value: number): number {
	if (!Number.isFinite(value)) return 0.5;
	return Math.max(0, Math.min(1, value));
}

export function turnSignalFromProbability(args: {
	probability: number;
	transcript: string;
	source: VoiceTurnSignal["source"];
	model?: string;
	latencyMs?: number;
}): VoiceTurnSignal {
	const p = clampProbability(args.probability);
	const nextSpeaker: VoiceNextSpeaker =
		p >= EOT_TENTATIVE_THRESHOLD
			? "agent"
			: p < EOT_MID_CLAUSE_THRESHOLD
				? "user"
				: "unknown";
	return {
		endOfTurnProbability: p,
		nextSpeaker,
		agentShouldSpeak:
			nextSpeaker === "agent" ? true : nextSpeaker === "user" ? false : null,
		source: args.source,
		...(args.model ? { model: args.model } : {}),
		transcript: args.transcript,
		...(args.latencyMs !== undefined ? { latencyMs: args.latencyMs } : {}),
	};
}

// ---------------------------------------------------------------------------
// Heuristic baseline
// ---------------------------------------------------------------------------

/**
 * Rules-of-thumb EOT classifier. The rules fire in priority order; the first
 * match wins.
 *
 * Priority  Signal                                       P(done)
 * --------  -------------------------------------------  -------
 *   1       Sentence-final punctuation (. ! ?)            0.95
 *   2       Question-tag words ("right?", "yeah?", "ok?") 0.85
 *   3       Short utterance (< 3 words)                   0.70
 *   4       Trailing conjunction (and/but/or/because/…)   0.15
 *   5       Last word is a preposition or article         0.20
 *   6       No signal                                     0.50
 */
export class HeuristicEotClassifier implements EotClassifier {
	/** Conjunctions that strongly suggest the user is mid-clause. */
	private static readonly TRAILING_CONJUNCTIONS = new Set([
		"and",
		"but",
		"or",
		"nor",
		"yet",
		"so",
		"because",
		"although",
		"though",
		"while",
		"whereas",
		"if",
		"unless",
		"until",
		"since",
		"when",
		"where",
		"which",
		"that",
		"who",
		"whom",
		"whose",
	]);

	/** Prepositions and articles that suggest an incomplete NP follows. */
	private static readonly TRAILING_INCOMPLETE = new Set([
		"a",
		"an",
		"the",
		"to",
		"of",
		"in",
		"on",
		"at",
		"by",
		"for",
		"with",
		"from",
		"into",
		"about",
		"through",
		"between",
		"against",
		"during",
		"before",
		"after",
		"without",
		"under",
		"over",
		"above",
		"below",
		"around",
		"beside",
		"beyond",
		"like",
		"near",
		"past",
		"via",
	]);

	/** Question-tag suffixes that end an utterance (case-insensitive). */
	private static readonly QUESTION_TAGS = [
		"right?",
		"yeah?",
		"ok?",
		"okay?",
		"right",
		"yeah",
		"correct?",
		"correct",
		"hm?",
		"huh?",
		"eh?",
	];

	score(partialTranscript: string): Promise<number> {
		const text = partialTranscript.trim();
		if (text.length === 0) return Promise.resolve(0.5);

		// Rule 1 — sentence-final punctuation.
		if (/[.!?]$/.test(text)) {
			return Promise.resolve(0.95);
		}

		// Rule 2 — question-tag words at the end.
		const lower = text.toLowerCase();
		for (const tag of HeuristicEotClassifier.QUESTION_TAGS) {
			if (lower.endsWith(tag)) return Promise.resolve(0.85);
		}

		// Split into words for word-level checks.
		const words = text
			.toLowerCase()
			.replace(/[^a-z0-9'\s-]/gi, "")
			.split(/\s+/)
			.filter(Boolean);
		if (words.length === 0) return Promise.resolve(0.5);

		const lastWord = words[words.length - 1].replace(/[',;:-]+$/, "");

		// Rule 3 — short utterance (< 3 words) → likely complete.
		if (words.length < 3) return Promise.resolve(0.7);

		// Rule 4 — trailing conjunction → mid-clause.
		if (HeuristicEotClassifier.TRAILING_CONJUNCTIONS.has(lastWord)) {
			return Promise.resolve(0.15);
		}

		// Rule 5 — trailing preposition or article → incomplete NP.
		if (HeuristicEotClassifier.TRAILING_INCOMPLETE.has(lastWord)) {
			return Promise.resolve(0.2);
		}

		// Rule 6 — no signal.
		return Promise.resolve(0.5);
	}

	async signal(partialTranscript: string): Promise<VoiceTurnSignal> {
		return turnSignalFromProbability({
			probability: await this.score(partialTranscript),
			transcript: partialTranscript.trim(),
			source: "heuristic",
			model: "heuristic-v1",
		});
	}
}

// ---------------------------------------------------------------------------
// Local LiveKit ONNX turn detector
// ---------------------------------------------------------------------------

type ChatMessage = { role: "user" | "assistant"; content: string };

interface TokenTensorLike {
	data?: BigInt64Array | BigUint64Array | Int32Array | number[] | bigint[];
	dims?: number[];
}

interface TokenizerOutputLike {
	input_ids?: TokenTensorLike | number[] | bigint[] | number[][];
}

interface CallableTokenizer {
	apply_chat_template(
		messages: ChatMessage[],
		options: {
			add_generation_prompt?: boolean;
			tokenize?: boolean;
			add_special_tokens?: boolean;
		},
	): string;
	(
		text: string,
		options: {
			add_special_tokens?: boolean;
			max_length?: number;
			truncation?: boolean;
		},
	): Promise<TokenizerOutputLike>;
}

type OrtModule = typeof import("onnxruntime-node");
type OrtSession = import("onnxruntime-node").InferenceSession;

/**
 * Tier-bundled upstream revisions for `livekit/turn-detector`. The upstream
 * repo pins each variant by HF revision tag — see
 * https://huggingface.co/livekit/turn-detector/tree/v1.2.2-en and
 * https://huggingface.co/livekit/turn-detector/tree/v0.4.1-intl. The bundle
 * stager (packages/training/scripts/manifest/stage_eliza1_bundle_assets.py)
 * uses these constants to pull the matching ONNX. Per-tier mapping:
 *
 *   0_8b / 2b (mobile, ≤1.7B class) → `v1.2.2-en` (SmolLM2-135M, ~66 MB).
 *   4b / 9b / 27b (desktop, ≥4B class) → `v0.4.1-intl` (pruned Qwen2.5-0.5B,
 *                                       ~396 MB, 14 languages).
 */
export const LIVEKIT_TURN_DETECTOR_HF_REPO = "livekit/turn-detector";
export const LIVEKIT_TURN_DETECTOR_EN_REVISION = "v1.2.2-en";
export const LIVEKIT_TURN_DETECTOR_INTL_REVISION = "v0.4.1-intl";

/**
 * Resolve the upstream `livekit/turn-detector` revision a given Eliza-1 tier
 * should bundle. Mobile/small tiers (`0_8b`, `2b`) get the ~66 MB EN-only
 * SmolLM2-135M distill (`v1.2.2-en`); desktop/server tiers (`4b`+) get the
 * ~396 MB multilingual pruned Qwen2.5-0.5B (`v0.4.1-intl`).
 *
 * Accepts both bare tier ids (`"4b"`) and prefixed catalog ids
 * (`"eliza-1-4b"`) so both the bundle stager (Python tier strings) and the
 * runtime engine (catalog `Eliza1TierId`) can call it.
 *
 * @see packages/training/scripts/manifest/stage_eliza1_bundle_assets.py — the
 * staging step that pulls the matching ONNX for each tier.
 */
export function turnDetectorRevisionForTier(
	tierId: string,
):
	| typeof LIVEKIT_TURN_DETECTOR_EN_REVISION
	| typeof LIVEKIT_TURN_DETECTOR_INTL_REVISION {
	const bare = tierId.startsWith("eliza-1-")
		? tierId.slice("eliza-1-".length)
		: tierId;
	if (bare === "0_8b" || bare === "2b") {
		return LIVEKIT_TURN_DETECTOR_EN_REVISION;
	}
	return LIVEKIT_TURN_DETECTOR_INTL_REVISION;
}

/**
 * Default ONNX filename inside the bundle's turn-detector dir. Upstream
 * publishes the INT8 graph as `onnx/model_q8.onnx` under both
 * `v1.2.2-en` and `v0.4.1-intl`. The historical Eliza staging path used a
 * flat `model_quantized.onnx` filename; for back-compat we also accept that
 * via the `ELIZA_TURN_DETECTOR_ONNX` env var or an explicit `onnxFilename`.
 */
export const DEFAULT_LIVEKIT_TURN_DETECTOR_ONNX = "onnx/model_q8.onnx";

/**
 * Legacy filename kept for back-compat. Bundles staged before Voice Wave 2
 * placed the ONNX flat at this name; the detector accepts either. New
 * bundles use {@link DEFAULT_LIVEKIT_TURN_DETECTOR_ONNX}.
 */
export const LEGACY_LIVEKIT_TURN_DETECTOR_ONNX = "model_quantized.onnx";

export interface LiveKitTurnDetectorOptions {
	/** Directory containing tokenizer files and the ONNX graph. */
	modelDir?: string;
	/**
	 * ONNX filename inside `modelDir`. Default: `onnx/model_q8.onnx`
	 * (the upstream layout). Set to {@link LEGACY_LIVEKIT_TURN_DETECTOR_ONNX}
	 * for bundles staged before Voice Wave 2.
	 */
	onnxFilename?: string;
	/**
	 * Upstream revision tag for telemetry and the model-card label only.
	 * One of `"v1.2.2-en"` or `"v0.4.1-intl"` for the canonical LiveKit
	 * detectors; arbitrary strings are accepted for fine-tunes. The actual
	 * ONNX path is encoded in `modelDir` + `onnxFilename`.
	 */
	revision?: string;
	/** Max history tokens. LiveKit's published runner uses 128. */
	maxHistoryTokens?: number;
	/** CPU execution threads for ONNX Runtime. Default: 2. */
	intraOpNumThreads?: number;
	/** Optional model label for telemetry. */
	model?: string;
}

export const DEFAULT_LIVEKIT_TURN_DETECTOR_DIR = path.join(
	homedir(),
	".eliza",
	"local-inference",
	"models",
	"turn-detector",
	"livekit-turn-detector",
);

const LIVEKIT_IM_END_TOKEN = "<|im_end|>";

/**
 * Local LiveKit text turn detector. This is the same inference contract as
 * the LiveKit Agents plugin, adapted to the main-branch HF export where the
 * ONNX graph returns logits instead of a pre-sigmoided scalar.
 */
export class LiveKitTurnDetector implements EotClassifier {
	private readonly modelDir: string;
	private readonly onnxPath: string;
	private readonly maxHistoryTokens: number;
	private readonly intraOpNumThreads: number;
	private readonly model: string;
	private readonly revision: string | undefined;
	private ready: Promise<{
		ort: OrtModule;
		session: OrtSession;
		tokenizer: CallableTokenizer;
		imEndTokenId: number;
	}> | null = null;

	constructor(opts: LiveKitTurnDetectorOptions = {}) {
		this.modelDir = opts.modelDir ?? DEFAULT_LIVEKIT_TURN_DETECTOR_DIR;
		this.onnxPath = path.join(
			this.modelDir,
			opts.onnxFilename ?? DEFAULT_LIVEKIT_TURN_DETECTOR_ONNX,
		);
		this.maxHistoryTokens = opts.maxHistoryTokens ?? 128;
		this.intraOpNumThreads = opts.intraOpNumThreads ?? 2;
		this.revision = opts.revision;
		this.model = opts.model ?? this.defaultModelLabel(opts.revision);
	}

	private defaultModelLabel(revision: string | undefined): string {
		if (!revision) return LIVEKIT_TURN_DETECTOR_HF_REPO;
		return `${LIVEKIT_TURN_DETECTOR_HF_REPO}@${revision}`;
	}

	async score(partialTranscript: string): Promise<number> {
		return (await this.signal(partialTranscript)).endOfTurnProbability;
	}

	async signal(partialTranscript: string): Promise<VoiceTurnSignal> {
		const started = performance.now();
		const loaded = await this.load();
		const transcript = normalizeTurnDetectorText(partialTranscript);
		const text = formatLiveKitTurnDetectorPrompt(loaded.tokenizer, transcript);
		const encoded = await loaded.tokenizer(text, {
			add_special_tokens: false,
			max_length: this.maxHistoryTokens,
			truncation: true,
		});
		const { data, dims } = tokenIdsToBigInt64(encoded);
		const feeds = {
			input_ids: new loaded.ort.Tensor("int64", data, dims),
		};
		const outputs = await loaded.session.run(feeds);
		const outputName = loaded.session.outputNames[0];
		const tensor =
			(outputName ? outputs[outputName] : undefined) ??
			Object.values(outputs)[0];
		if (!tensor) {
			throw new Error("[voice] LiveKit turn detector returned no outputs.");
		}
		const probability = probabilityFromOnnxOutput(tensor, loaded.imEndTokenId);
		return turnSignalFromProbability({
			probability,
			transcript,
			source: "livekit-turn-detector",
			model: this.model,
			latencyMs: performance.now() - started,
		});
	}

	private load(): Promise<{
		ort: OrtModule;
		session: OrtSession;
		tokenizer: CallableTokenizer;
		imEndTokenId: number;
	}> {
		this.ready ??= this.loadInner();
		return this.ready;
	}

	private async loadInner(): Promise<{
		ort: OrtModule;
		session: OrtSession;
		tokenizer: CallableTokenizer;
		imEndTokenId: number;
	}> {
		await Promise.all([
			access(this.onnxPath),
			access(path.join(this.modelDir, "tokenizer.json")),
		]);
		const [{ AutoTokenizer }, ort] = await Promise.all([
			import("@huggingface/transformers"),
			import("onnxruntime-node"),
		]);
		const tokenizer = (await AutoTokenizer.from_pretrained(this.modelDir, {
			local_files_only: true,
		})) as unknown as CallableTokenizer;
		(
			tokenizer as CallableTokenizer & { truncation_side?: "left" }
		).truncation_side = "left";
		const imEnd = await tokenizer(LIVEKIT_IM_END_TOKEN, {
			add_special_tokens: false,
		});
		const imEndIds = tokenIdsToBigInt64(imEnd).data;
		const imEndTokenId = Number(imEndIds[0]);
		if (!Number.isInteger(imEndTokenId)) {
			throw new Error(
				"[voice] LiveKit turn detector tokenizer did not expose <|im_end|>.",
			);
		}
		const session = await ort.InferenceSession.create(this.onnxPath, {
			executionProviders: ["cpu"],
			graphOptimizationLevel: "all",
			interOpNumThreads: 1,
			intraOpNumThreads: this.intraOpNumThreads,
		});
		if (!session.inputNames.includes("input_ids")) {
			throw new Error(
				`[voice] LiveKit turn detector graph is missing input_ids (inputs: ${session.inputNames.join(", ")}).`,
			);
		}
		return { ort, session, tokenizer, imEndTokenId };
	}
}

/**
 * Construct a `LiveKitTurnDetector` if the bundle has the model installed
 * on disk. Resolution order for the ONNX filename:
 *
 *   1. Explicit `opts.onnxFilename`.
 *   2. `ELIZA_TURN_DETECTOR_ONNX` env var (operator override).
 *   3. `onnx/model_q8.onnx` (the canonical upstream layout).
 *   4. `model_quantized.onnx` (legacy Eliza staging layout, back-compat).
 *
 * Returns `null` if neither candidate ONNX is present alongside
 * `tokenizer.json`. The caller falls back to {@link HeuristicEotClassifier}.
 */
export async function createBundledLiveKitTurnDetector(
	opts: LiveKitTurnDetectorOptions = {},
): Promise<LiveKitTurnDetector | null> {
	const modelDir =
		opts.modelDir ??
		process.env.ELIZA_TURN_DETECTOR_MODEL_DIR ??
		DEFAULT_LIVEKIT_TURN_DETECTOR_DIR;
	const explicit = opts.onnxFilename ?? process.env.ELIZA_TURN_DETECTOR_ONNX;
	const candidates = explicit
		? [explicit]
		: [DEFAULT_LIVEKIT_TURN_DETECTOR_ONNX, LEGACY_LIVEKIT_TURN_DETECTOR_ONNX];

	let resolvedFilename: string | null = null;
	for (const candidate of candidates) {
		try {
			await access(path.join(modelDir, candidate));
			resolvedFilename = candidate;
			break;
		} catch {
			// try next
		}
	}
	if (resolvedFilename === null) return null;
	try {
		await access(path.join(modelDir, "tokenizer.json"));
	} catch {
		return null;
	}
	return new LiveKitTurnDetector({
		...opts,
		modelDir,
		onnxFilename: resolvedFilename,
	});
}

function normalizeTurnDetectorText(text: string): string {
	return text
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}'\-\s]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function formatLiveKitTurnDetectorPrompt(
	tokenizer: CallableTokenizer,
	transcript: string,
): string {
	const templated = tokenizer.apply_chat_template(
		[{ role: "user", content: transcript }],
		{
			add_generation_prompt: false,
			tokenize: false,
			add_special_tokens: false,
		},
	);
	const ix = templated.lastIndexOf(LIVEKIT_IM_END_TOKEN);
	return ix >= 0 ? templated.slice(0, ix) : templated;
}

function tokenIdsToBigInt64(encoded: TokenizerOutputLike): {
	data: BigInt64Array;
	dims: number[];
} {
	const ids = encoded.input_ids;
	if (!ids) throw new Error("[voice] tokenizer output missing input_ids.");
	if (isTensorLike(ids) && ids.data) {
		const dims = ids.dims ?? [1, ids.data.length];
		return {
			data: toBigInt64Array(ids.data),
			dims,
		};
	}
	if (Array.isArray(ids)) {
		const flattened = ids.flat() as Array<number | bigint>;
		const nestedWidth = Array.isArray(ids[0])
			? (ids[0] as Array<number | bigint>).length
			: ids.length;
		return {
			data: toBigInt64Array(flattened),
			dims: Array.isArray(ids[0]) ? [ids.length, nestedWidth] : [1, ids.length],
		};
	}
	throw new Error("[voice] unsupported tokenizer input_ids shape.");
}

function isTensorLike(value: unknown): value is TokenTensorLike {
	return typeof value === "object" && value !== null && "data" in value;
}

function toBigInt64Array(
	input: BigInt64Array | BigUint64Array | Int32Array | Array<number | bigint>,
): BigInt64Array {
	if (input instanceof BigInt64Array) return input;
	const out = new BigInt64Array(input.length);
	for (let i = 0; i < input.length; i++) {
		out[i] = BigInt(input[i] as number | bigint);
	}
	return out;
}

function probabilityFromOnnxOutput(
	tensor: import("onnxruntime-node").Tensor,
	imEndTokenId: number,
): number {
	const data = tensor.data;
	if (!(data instanceof Float32Array || data instanceof Float64Array)) {
		throw new Error(
			`[voice] LiveKit turn detector output must be float logits/probabilities, got ${tensor.type}.`,
		);
	}
	const dims = tensor.dims;
	if (dims.length >= 3) {
		const vocabSize = dims[dims.length - 1];
		if (imEndTokenId < 0 || imEndTokenId >= vocabSize) {
			throw new Error(
				`[voice] <|im_end|> token id ${imEndTokenId} outside detector vocab ${vocabSize}.`,
			);
		}
		const sequenceLength = dims[dims.length - 2];
		const offset = (sequenceLength - 1) * vocabSize;
		return softmaxProbability(data, offset, vocabSize, imEndTokenId);
	}
	const last = data[data.length - 1];
	return clampProbability(last);
}

function softmaxProbability(
	logits: Float32Array | Float64Array,
	offset: number,
	length: number,
	tokenId: number,
): number {
	let max = -Infinity;
	for (let i = 0; i < length; i++) {
		const value = logits[offset + i];
		if (value > max) max = value;
	}
	let sum = 0;
	for (let i = 0; i < length; i++) {
		sum += Math.exp(logits[offset + i] - max);
	}
	return clampProbability(Math.exp(logits[offset + tokenId] - max) / sum);
}

// ---------------------------------------------------------------------------
// Local Turnsense ONNX classifier (Apache-2.0 fallback)
// ---------------------------------------------------------------------------

/**
 * `latishab/turnsense` is a SmolLM2-135M head fine-tuned as a *binary*
 * end-of-utterance classifier (logits over `[NON_EOU, EOU]`). Architecturally
 * the same backbone as `livekit/turn-detector @ v1.2.2-en` (4-layer SmolLM2),
 * but the output is a 2-class softmax instead of a next-token distribution
 * over `<|im_end|>`. Apache-2.0 licensed — useful as a FOSS fallback for
 * environments where the LiveKit Model License is blocked.
 *
 * Upstream tree: https://huggingface.co/latishab/turnsense
 * Quantized ONNX: `model_quantized.onnx` (~176 MB INT8 at the repo root).
 *
 * The classifier prepends `<|user|> ` to the latest user transcript, runs
 * a 256-token-max truncation, and reads `softmax(logits)[EOU]` as the
 * end-of-turn probability.
 */
export const TURNSENSE_HF_REPO = "latishab/turnsense";
export const DEFAULT_TURNSENSE_ONNX = "model_quantized.onnx";
export const DEFAULT_TURNSENSE_DIR = path.join(
	homedir(),
	".eliza",
	"local-inference",
	"models",
	"turn-detector",
	"turnsense",
);

export interface TurnsenseEotClassifierOptions {
	/** Directory containing tokenizer files and the Turnsense ONNX. */
	modelDir?: string;
	/** ONNX filename inside `modelDir`. Default: `model_quantized.onnx`. */
	onnxFilename?: string;
	/** Max history tokens. Upstream uses 256. */
	maxHistoryTokens?: number;
	/** CPU execution threads for ONNX Runtime. Default: 2. */
	intraOpNumThreads?: number;
	/** Optional model label for telemetry. */
	model?: string;
}

/**
 * Turnsense binary EOU classifier. Returns the same `VoiceTurnSignal`
 * shape as `LiveKitTurnDetector`; the `source` field is
 * `"livekit-turn-detector"` regardless because the runtime gates on source
 * for behaviour, and turnsense fills the same slot (text-based, batch-1,
 * partial-transcript EOU).
 */
export class TurnsenseEotClassifier implements EotClassifier {
	private readonly modelDir: string;
	private readonly onnxPath: string;
	private readonly maxHistoryTokens: number;
	private readonly intraOpNumThreads: number;
	private readonly model: string;
	private ready: Promise<{
		ort: OrtModule;
		session: OrtSession;
		tokenizer: CallableTokenizer;
	}> | null = null;

	constructor(opts: TurnsenseEotClassifierOptions = {}) {
		this.modelDir = opts.modelDir ?? DEFAULT_TURNSENSE_DIR;
		this.onnxPath = path.join(
			this.modelDir,
			opts.onnxFilename ?? DEFAULT_TURNSENSE_ONNX,
		);
		this.maxHistoryTokens = opts.maxHistoryTokens ?? 256;
		this.intraOpNumThreads = opts.intraOpNumThreads ?? 2;
		this.model = opts.model ?? TURNSENSE_HF_REPO;
	}

	async score(partialTranscript: string): Promise<number> {
		return (await this.signal(partialTranscript)).endOfTurnProbability;
	}

	async signal(partialTranscript: string): Promise<VoiceTurnSignal> {
		const started = performance.now();
		const loaded = await this.load();
		const transcript = normalizeTurnDetectorText(partialTranscript);
		const text = `<|user|> ${transcript}`;
		const encoded = await loaded.tokenizer(text, {
			add_special_tokens: false,
			max_length: this.maxHistoryTokens,
			truncation: true,
		});
		const { data, dims } = tokenIdsToBigInt64(encoded);
		const feeds = {
			input_ids: new loaded.ort.Tensor("int64", data, dims),
		};
		const outputs = await loaded.session.run(feeds);
		const outputName = loaded.session.outputNames[0];
		const tensor =
			(outputName ? outputs[outputName] : undefined) ??
			Object.values(outputs)[0];
		if (!tensor) {
			throw new Error("[voice] Turnsense classifier returned no outputs.");
		}
		const probability = probabilityFromTurnsenseOutput(tensor);
		return turnSignalFromProbability({
			probability,
			transcript,
			source: "livekit-turn-detector",
			model: this.model,
			latencyMs: performance.now() - started,
		});
	}

	private load(): Promise<{
		ort: OrtModule;
		session: OrtSession;
		tokenizer: CallableTokenizer;
	}> {
		this.ready ??= this.loadInner();
		return this.ready;
	}

	private async loadInner(): Promise<{
		ort: OrtModule;
		session: OrtSession;
		tokenizer: CallableTokenizer;
	}> {
		await Promise.all([
			access(this.onnxPath),
			access(path.join(this.modelDir, "tokenizer.json")),
		]);
		const [{ AutoTokenizer }, ort] = await Promise.all([
			import("@huggingface/transformers"),
			import("onnxruntime-node"),
		]);
		const tokenizer = (await AutoTokenizer.from_pretrained(this.modelDir, {
			local_files_only: true,
		})) as unknown as CallableTokenizer;
		(
			tokenizer as CallableTokenizer & { truncation_side?: "left" }
		).truncation_side = "left";
		const session = await ort.InferenceSession.create(this.onnxPath, {
			executionProviders: ["cpu"],
			graphOptimizationLevel: "all",
			interOpNumThreads: 1,
			intraOpNumThreads: this.intraOpNumThreads,
		});
		if (!session.inputNames.includes("input_ids")) {
			throw new Error(
				`[voice] Turnsense graph is missing input_ids (inputs: ${session.inputNames.join(", ")}).`,
			);
		}
		return { ort, session, tokenizer };
	}
}

/**
 * Try to construct a Turnsense classifier from a locally-staged ONNX
 * bundle. Returns `null` if the model dir / files are missing.
 */
export async function createBundledTurnsenseEotClassifier(
	opts: TurnsenseEotClassifierOptions = {},
): Promise<TurnsenseEotClassifier | null> {
	const modelDir =
		opts.modelDir ??
		process.env.ELIZA_TURNSENSE_MODEL_DIR ??
		DEFAULT_TURNSENSE_DIR;
	const onnxFilename =
		opts.onnxFilename ??
		process.env.ELIZA_TURNSENSE_ONNX ??
		DEFAULT_TURNSENSE_ONNX;
	try {
		await Promise.all([
			access(path.join(modelDir, onnxFilename)),
			access(path.join(modelDir, "tokenizer.json")),
		]);
	} catch {
		return null;
	}
	return new TurnsenseEotClassifier({
		...opts,
		modelDir,
		onnxFilename,
	});
}

function probabilityFromTurnsenseOutput(
	tensor: import("onnxruntime-node").Tensor,
): number {
	const data = tensor.data;
	if (!(data instanceof Float32Array || data instanceof Float64Array)) {
		throw new Error(
			`[voice] Turnsense output must be float logits/probabilities, got ${tensor.type}.`,
		);
	}
	// Output is `[batch=1, num_classes=2]` with class index 1 = EOU.
	// Some Turnsense exports emit a flat 2-element vector; handle both.
	if (data.length < 2) {
		throw new Error(
			`[voice] Turnsense output has unexpected length ${data.length}; expected ≥2.`,
		);
	}
	const dims = tensor.dims;
	const offset = dims.length >= 2 ? data.length - 2 : 0;
	const logitNon = data[offset];
	const logitEou = data[offset + 1];
	const max = logitNon > logitEou ? logitNon : logitEou;
	const expEou = Math.exp(logitEou - max);
	const expNon = Math.exp(logitNon - max);
	return clampProbability(expEou / (expEou + expNon));
}

// ---------------------------------------------------------------------------
// Remote model adapter
// ---------------------------------------------------------------------------

export interface RemoteEotClassifierOptions {
	/**
	 * HTTP endpoint to POST the partial transcript to. Expected to return JSON
	 * with a `p_done` field: `{ "p_done": 0.92 }`.
	 *
	 * Example: LiveKit turn-detector inference endpoint or a custom model server.
	 */
	endpoint: string;
	/**
	 * Timeout in milliseconds for each HTTP request. Default 200 ms — the
	 * classifier must be faster than the silence hangover it's trying to beat.
	 */
	timeoutMs?: number;
	/** Optional model label for telemetry. */
	model?: string;
}

/**
 * Remote EOT classifier. POSTs `{ transcript: string }` to `endpoint`
 * and expects `{ p_done: number }` back.
 *
 * Intended to be wired to a real LiveKit turn-detector HTTP API or a custom
 * model inference server. This adapter fails closed: no fallback score is
 * manufactured on network or parse errors.
 */
export class RemoteEotClassifier implements EotClassifier {
	private readonly endpoint: string;
	private readonly timeoutMs: number;
	private readonly model: string;

	constructor(opts: RemoteEotClassifierOptions) {
		this.endpoint = opts.endpoint;
		this.timeoutMs = opts.timeoutMs ?? 200;
		this.model = opts.model ?? "remote-eot";
	}

	async score(partialTranscript: string): Promise<number> {
		return (await this.signal(partialTranscript)).endOfTurnProbability;
	}

	async signal(partialTranscript: string): Promise<VoiceTurnSignal> {
		const started = performance.now();
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			const response = await fetch(this.endpoint, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ transcript: partialTranscript }),
				signal: controller.signal,
			});
			if (!response.ok) {
				throw new Error(
					`[voice] Remote EOT classifier failed: HTTP ${response.status} ${response.statusText}`,
				);
			}
			const json = (await response.json()) as unknown;
			if (
				typeof json === "object" &&
				json !== null &&
				"p_done" in json &&
				typeof (json as Record<string, unknown>).p_done === "number"
			) {
				const p = (json as { p_done: number }).p_done;
				return turnSignalFromProbability({
					probability: p,
					transcript: partialTranscript.trim(),
					source: "remote",
					model: this.model,
					latencyMs: performance.now() - started,
				});
			}
			throw new Error(
				"[voice] Remote EOT classifier response missing numeric p_done.",
			);
		} finally {
			clearTimeout(timer);
		}
	}
}

// ---------------------------------------------------------------------------
// Thresholds (shared constants so tests and state machine stay in sync)
// ---------------------------------------------------------------------------

/** P(done) ≥ this AND silence ≥ EOT_COMMIT_SILENCE_MS → commit immediately. */
export const EOT_COMMIT_THRESHOLD = 0.9;

/** P(done) ≥ this AND silence ≥ EOT_TENTATIVE_SILENCE_MS → enter PAUSE_TENTATIVE early. */
export const EOT_TENTATIVE_THRESHOLD = 0.6;

/** P(done) < this → extend hangover by EOT_HANGOVER_EXTENSION_MS. */
export const EOT_MID_CLAUSE_THRESHOLD = 0.4;

/** Minimum silence (ms) required alongside P ≥ EOT_COMMIT_THRESHOLD to commit. */
export const EOT_COMMIT_SILENCE_MS = 50;

/** Minimum silence (ms) required alongside P ≥ EOT_TENTATIVE_THRESHOLD to start drafter. */
export const EOT_TENTATIVE_SILENCE_MS = 20;

/** How many ms to add to the pause hangover when P < EOT_MID_CLAUSE_THRESHOLD. */
export const EOT_HANGOVER_EXTENSION_MS = 50;

// ---------------------------------------------------------------------------
// Eliza-1 drafter EOT classifier
// ---------------------------------------------------------------------------

export type { Eliza1EotScorerOptions, Eliza1EotScoreResult };

/**
 * Eliza-1 EOT classifier. Reuses the already-loaded text model (typically
 * the eliza-1 drafter — same model DFlash keeps warm for speculative
 * decoding) to compute P(`<|im_end|>` | partial transcript). Optionally
 * loads a fine-tuned EOT LoRA adapter on top of the base weights — see
 * `packages/training/scripts/turn_detector/` for the training recipe.
 *
 * Unlike `LiveKitTurnDetector`, this classifier ships zero additional
 * model weights — it leans on what's already in RAM.
 */
export class Eliza1EotClassifier implements EotClassifier {
	private readonly scorer: Eliza1EotScorer;

	constructor(options: Eliza1EotScorerOptions | { scorer: Eliza1EotScorer }) {
		this.scorer =
			"scorer" in options ? options.scorer : new Eliza1EotScorer(options);
	}

	async score(partialTranscript: string): Promise<number> {
		const { probability } = await this.scorer.score(partialTranscript);
		return probability;
	}

	async signal(partialTranscript: string): Promise<VoiceTurnSignal> {
		const result = await this.scorer.score(partialTranscript);
		return turnSignalFromProbability({
			probability: result.probability,
			transcript: partialTranscript,
			source: "eliza-1-drafter",
			model: this.scorer.modelLabel,
			latencyMs: result.latencyMs,
		});
	}

	async dispose(): Promise<void> {
		await this.scorer.dispose();
	}
}

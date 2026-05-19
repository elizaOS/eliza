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
 * Available implementations:
 *
 *   `HeuristicEotClassifier` — deterministic, zero-latency, no model load.
 *     Always available baseline.
 *
 *   `LiveKitTurnDetector` — local GGUF-backed LiveKit turn detector. Wraps
 *     `LiveKitGgmlTurnDetector` (`eot-classifier-ggml.ts`); the upstream
 *     ONNX path has been retired. Two upstream revisions are bundled as
 *     GGUFs: `v1.2.2-en` (SmolLM2-135M, ~40 MB Q8 GGUF) for mobile tiers,
 *     and `v0.4.1-intl` (pruned Qwen2.5-0.5B, ~280 MB Q8 GGUF, 14
 *     languages) for desktop tiers.
 *
 *   `RemoteEotClassifier` — fail-closed HTTP adapter for a real model server.
 *     It throws on network/parse errors so callers never mistake a synthetic
 *     fallback for a measured turn signal.
 *
 *   `Eliza1EotClassifier` — reuse the already-loaded chat target model for
 *     a P(`<|im_end|>`) read (LoRA hot-swap path; see `eliza1-eot-scorer`).
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
import type {
	Eliza1EotScoreResult,
	Eliza1EotScorerOptions,
} from "./eliza1-eot-scorer";
import { Eliza1EotScorer } from "./eliza1-eot-scorer";
import {
	createBundledLiveKitGgmlTurnDetector,
	EotGgmlUnavailableError,
	LiveKitGgmlTurnDetector,
	type LiveKitGgmlTurnDetectorOptions,
} from "./eot-classifier-ggml";

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
 */
export class HeuristicEotClassifier implements EotClassifier {
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

		if (/[.!?]$/.test(text)) {
			return Promise.resolve(0.95);
		}

		const lower = text.toLowerCase();
		for (const tag of HeuristicEotClassifier.QUESTION_TAGS) {
			if (lower.endsWith(tag)) return Promise.resolve(0.85);
		}

		const words = text
			.toLowerCase()
			.replace(/[^a-z0-9'\s-]/gi, "")
			.split(/\s+/)
			.filter(Boolean);
		if (words.length === 0) return Promise.resolve(0.5);

		const lastWord = words[words.length - 1].replace(/[',;:-]+$/, "");

		if (words.length < 3) return Promise.resolve(0.7);

		if (HeuristicEotClassifier.TRAILING_CONJUNCTIONS.has(lastWord)) {
			return Promise.resolve(0.15);
		}

		if (HeuristicEotClassifier.TRAILING_INCOMPLETE.has(lastWord)) {
			return Promise.resolve(0.2);
		}

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
// LiveKit turn detector — GGUF/GGML path
// ---------------------------------------------------------------------------

/** HF repo holding the LiveKit turn detector GGUF variants. */
export const LIVEKIT_TURN_DETECTOR_HF_REPO = "livekit/turn-detector";
export const LIVEKIT_TURN_DETECTOR_EN_REVISION = "v1.2.2-en";
export const LIVEKIT_TURN_DETECTOR_INTL_REVISION = "v0.4.1-intl";

/**
 * Resolve the upstream revision a given Eliza-1 tier should bundle.
 * Mobile/small tiers (`0_8b`, `2b`) get the EN-only SmolLM2-135M
 * distill (`v1.2.2-en`); desktop tiers (`4b`+) get the multilingual
 * pruned Qwen2.5-0.5B (`v0.4.1-intl`).
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

export const DEFAULT_LIVEKIT_TURN_DETECTOR_DIR = path.join(
	homedir(),
	".eliza",
	"local-inference",
	"models",
	"turn-detector",
	"livekit-turn-detector",
);

export interface LiveKitTurnDetectorOptions {
	/** Directory containing the GGUF and tokenizer files. */
	modelDir?: string;
	/** GGUF filename inside `modelDir`. */
	ggufFilename?: string;
	/** Upstream revision tag for telemetry. */
	revision?: string;
	/** Max history tokens. LiveKit's published runner uses 128. */
	maxHistoryTokens?: number;
	/** CPU execution threads. Default: 2. */
	threads?: number;
	/** Optional model label for telemetry. */
	model?: string;
}

/**
 * Local LiveKit text turn detector. Thin wrapper over
 * `LiveKitGgmlTurnDetector` so callers keep importing the same name the
 * previous ONNX-backed implementation exposed.
 */
export class LiveKitTurnDetector implements EotClassifier {
	private readonly inner: LiveKitGgmlTurnDetector;

	constructor(opts: LiveKitTurnDetectorOptions & { ggufPath?: string }) {
		const ggufPath =
			opts.ggufPath ??
			path.join(
				opts.modelDir ?? DEFAULT_LIVEKIT_TURN_DETECTOR_DIR,
				opts.ggufFilename ?? "turn-detector-en-q8.gguf",
			);
		const innerOpts: LiveKitGgmlTurnDetectorOptions = {
			ggufPath,
			...(opts.revision !== undefined ? { revision: opts.revision } : {}),
			...(opts.maxHistoryTokens !== undefined
				? { maxHistoryTokens: opts.maxHistoryTokens }
				: {}),
			...(opts.model !== undefined ? { model: opts.model } : {}),
			...(opts.threads !== undefined ? { threads: opts.threads } : {}),
		};
		this.inner = new LiveKitGgmlTurnDetector(innerOpts);
	}

	async score(partialTranscript: string): Promise<number> {
		return this.inner.score(partialTranscript);
	}

	async signal(partialTranscript: string): Promise<VoiceTurnSignal> {
		return this.inner.signal(partialTranscript);
	}

	async dispose(): Promise<void> {
		await this.inner.dispose();
	}
}

/**
 * Construct a `LiveKitTurnDetector` if the bundle has the GGUF on
 * disk. Returns `null` if no GGUF is found — the caller falls back to
 * {@link HeuristicEotClassifier}.
 *
 * Resolution order is delegated to `createBundledLiveKitGgmlTurnDetector`.
 */
export async function createBundledLiveKitTurnDetector(
	opts: LiveKitTurnDetectorOptions = {},
): Promise<LiveKitTurnDetector | null> {
	try {
		const inner = await createBundledLiveKitGgmlTurnDetector({
			...(opts.modelDir !== undefined ? { modelDir: opts.modelDir } : {}),
			...(opts.revision !== undefined ? { revision: opts.revision } : {}),
			...(opts.maxHistoryTokens !== undefined
				? { maxHistoryTokens: opts.maxHistoryTokens }
				: {}),
			...(opts.threads !== undefined ? { threads: opts.threads } : {}),
		});
		if (!inner) return null;
		// Re-construct the wrapper so the public surface stays
		// `LiveKitTurnDetector`. The inner ggml detector is the same shape
		// either way.
		return new LiveKitTurnDetector({
			ggufPath: inner.ggufPath,
			...(opts.revision !== undefined ? { revision: opts.revision } : {}),
			...(opts.maxHistoryTokens !== undefined
				? { maxHistoryTokens: opts.maxHistoryTokens }
				: {}),
			...(opts.threads !== undefined ? { threads: opts.threads } : {}),
		});
	} catch (err) {
		if (err instanceof EotGgmlUnavailableError) return null;
		throw err;
	}
}

// ---------------------------------------------------------------------------
// Remote model adapter
// ---------------------------------------------------------------------------

export interface RemoteEotClassifierOptions {
	endpoint: string;
	timeoutMs?: number;
	model?: string;
}

/**
 * Remote EOT classifier. POSTs `{ transcript: string }` to `endpoint`
 * and expects `{ p_done: number }` back. Fail-closed: no fallback score
 * is manufactured on network or parse errors.
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

export const EOT_COMMIT_THRESHOLD = 0.9;
export const EOT_TENTATIVE_THRESHOLD = 0.6;
export const EOT_MID_CLAUSE_THRESHOLD = 0.4;
export const EOT_COMMIT_SILENCE_MS = 50;
export const EOT_TENTATIVE_SILENCE_MS = 20;
export const EOT_HANGOVER_EXTENSION_MS = 50;

// ---------------------------------------------------------------------------
// Eliza-1 drafter EOT classifier
// ---------------------------------------------------------------------------

export type { Eliza1EotScoreResult, Eliza1EotScorerOptions };

/**
 * Eliza-1 EOT classifier. Reuses the already-loaded text model (the
 * eliza-1 drafter — same model DFlash keeps warm for speculative
 * decoding) to compute P(`<|im_end|>` | partial transcript).
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

// ---------------------------------------------------------------------------
// Removed ONNX/HF assets (kept as no-ops for back-compat)
// ---------------------------------------------------------------------------

/**
 * @deprecated The runtime no longer loads ONNX turn-detector graphs;
 * every variant ships as a GGUF and runs through `LiveKitGgmlTurnDetector`.
 * Kept as a sentinel string so legacy bundle stagers do not break at
 * import-time. Consume via the GGUF asset paths in
 * `eot-classifier-ggml.ts` instead.
 */
export const DEFAULT_LIVEKIT_TURN_DETECTOR_ONNX = "onnx/model_q8.onnx";

/** @deprecated Legacy filename — see `DEFAULT_LIVEKIT_TURN_DETECTOR_ONNX`. */
export const LEGACY_LIVEKIT_TURN_DETECTOR_ONNX = "model_quantized.onnx";

/**
 * @deprecated Convenience helper for callers that need to test whether
 * the *file* exists on disk. The runtime no longer loads ONNX, so this
 * is purely an artifact-presence probe used by the bundle stager.
 */
export async function bundleHasLegacyOnnxTurnDetector(
	modelDir: string,
): Promise<boolean> {
	for (const candidate of [
		DEFAULT_LIVEKIT_TURN_DETECTOR_ONNX,
		LEGACY_LIVEKIT_TURN_DETECTOR_ONNX,
	]) {
		try {
			await access(path.join(modelDir, candidate));
			return true;
		} catch {
			// keep probing
		}
	}
	return false;
}

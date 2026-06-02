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
 * Three implementations ship:
 *
 *   `HeuristicEotClassifier` — deterministic, zero-latency, no model load.
 *     This is the baseline; it is always available.
 *
 *   `RemoteEotClassifier` — fail-closed HTTP adapter for a real model server.
 *     It throws on network/parse errors so callers never mistake a synthetic
 *     fallback for a measured turn signal.
 *
 *   `Eliza1EotClassifier` — uses the already-loaded text model to compute
 *     P(`<|im_end|>` | partial transcript). Zero additional model weights.
 *
 *   The GGUF-backed LiveKit detector lives in `eot-classifier-ggml.ts`.
 *
 * Cancellation contract (handshake with VoiceTurnController / R11): the
 * classifier emits a `VoiceTurnSignal` per partial transcript. It NEVER
 * aborts a turn directly — `signal()` is data, not a cancellation. The
 * controller layer above consumes the signal and decides whether to
 * suppress (via `BargeInCancelToken.signal` with reason `"turn-suppressed"`).
 */

import type {
	Eliza1EotScoreResult,
	Eliza1EotScorerOptions,
} from "./eliza1-eot-scorer";
import { Eliza1EotScorer } from "./eliza1-eot-scorer";

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
// Tier-aware GGUF variant resolver (shared with eot-classifier-ggml.ts)
// ---------------------------------------------------------------------------

/**
 * Resolve which upstream revision a given Eliza-1 tier should bundle.
 * Mobile/small tiers (`0_8b`, `2b`) get the English-only variant;
 * desktop/server tiers (`4b`+) get the multilingual variant.
 *
 * Accepts both bare tier ids (`"4b"`) and prefixed catalog ids
 * (`"eliza-1-4b"`).
 */
export const LIVEKIT_TURN_DETECTOR_EN_REVISION = "v1.2.2-en";
export const LIVEKIT_TURN_DETECTOR_INTL_REVISION = "v0.4.1-intl";

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

export type { Eliza1EotScoreResult, Eliza1EotScorerOptions };

/**
 * Eliza-1 EOT classifier. Reuses the already-loaded text model (typically
 * the eliza-1 drafter — same model MTP keeps warm for speculative
 * decoding) to compute P(`<|im_end|>` | partial transcript). Optionally
 * loads a fine-tuned EOT LoRA adapter on top of the base weights — see
 * `packages/training/scripts/turn_detector/` for the training recipe.
 *
 * Unlike the GGUF-backed `LiveKitGgmlTurnDetector`, this classifier ships
 * zero additional model weights — it leans on what's already in RAM.
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

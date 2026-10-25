/**
 * Speaker-ID + diarization attribution pipeline.
 *
 * Wraps a `StreamingTranscriber` so the partial / final
 * `TranscriptUpdate`s carry diarized `VoiceSegment[]` and a
 * `primarySpeaker`. The attribution runs in parallel with ASR — the
 * encoder fires the moment ≥ 1 s of audio is available, and the
 * profile store's `beginMatch` starts at speech-start.
 *
 * This module owns *only* the attribution logic. It does NOT replace
 * the transcriber; callers feed PCM through both the transcriber and
 * the attributor in parallel, then attach the resolved metadata via
 * `BaseStreamingTranscriber.setMetadataDefaults()` once it lands.
 *
 * Why a separate module: the existing `VoicePipeline` is large and
 * already handles a lot. Putting attribution behind a small adapter
 * lets the voice pipeline opt in without entangling the diarizer /
 * encoder / profile-store dependencies into the streaming-ASR contract.
 */

import { logger } from "@elizaos/core";
import type {
	VoiceImprintMatchHandle,
	VoiceProfileObservation,
	VoiceProfileStore,
} from "../profile-store";
import { voiceSpeakerFromImprintMatch } from "../speaker-imprint";
import type {
	VoiceInputSource,
	VoiceSegment,
	VoiceSpeaker,
	VoiceTurnMetadata,
} from "../types";
import type { Diarizer, LocalSpeakerSegment } from "./diarizer";
import type { SpeakerEncoder } from "./encoder";
import { WESPEAKER_MIN_SAMPLES } from "./encoder";

/**
 * Diagnostic sink for a failure that has no return-value path back to a caller
 * — matches `IAgentRuntime.reportError` so a wired live session forwards the
 * failure into RECENT_ERRORS / owner-escalation (#12263 J7). Optional: a
 * pipeline built without a runtime (tests, older callers) falls back to
 * `logger.warn`, but the failure is always observed, never swallowed.
 */
export type AttributionDiagnosticSink = (
	scope: string,
	error: unknown,
	context?: Record<string, unknown>,
) => void;

export interface VoiceAttributionPipelineDeps {
	encoder: SpeakerEncoder;
	diarizer?: Diarizer;
	profileStore: VoiceProfileStore;
	/**
	 * Observability boundary for the speech-start speculative match's background
	 * result promise. That encode runs detached from any caller (no code awaits
	 * `speculativeMatch.result` — turn-taking that will read it is #12255), so an
	 * `encode()`/`findBestMatch()` rejection has nowhere to surface and would
	 * become an unhandled rejection (#12894). Routed here instead.
	 */
	reportError?: AttributionDiagnosticSink;
}

export interface VoiceAttributionRequest {
	turnId: string;
	source?: VoiceInputSource;
	/** Concatenated mono 16 kHz PCM for the entire turn. */
	pcm: Float32Array;
	startedAtMs?: number;
	endedAtMs?: number;
	/** When set, the attributor will only run if the abort signal isn't yet fired. */
	signal?: AbortSignal;
}

export interface VoiceAttributionOutput {
	turnId: string;
	primarySpeaker?: VoiceSpeaker;
	segments: VoiceSegment[];
	turn: VoiceTurnMetadata;
	observation: VoiceProfileObservation | null;
}

/** Init for an incremental (windowed) turn — see {@link VoiceAttributionPipeline.beginTurn}. */
export interface IncrementalTurnInit {
	turnId: string;
	source?: VoiceInputSource;
	startedAtMs?: number;
	/** Aborts the speech-start speculative `beginMatch` lookup if the turn is cancelled. */
	signal?: AbortSignal;
}

/** The trailing partial window and full turn PCM handed to `finalize`. */
export interface IncrementalTurnFinalize {
	/** The whole turn's concatenated PCM — spliced for the primary-speaker embedding. */
	fullPcm: Float32Array;
	/** The trailing < 5 s window that had not yet been decoded at speech-end. */
	finalWindowPcm?: Float32Array;
	/** Turn-relative start (ms) of `finalWindowPcm`. */
	finalWindowStartMs?: number;
	endedAtMs?: number;
	signal?: AbortSignal;
}

/**
 * A single long turn diarized window-by-window instead of in one whole-turn
 * decode. `pushWindow` runs the pyannote 5 s decode as each window fills DURING
 * the turn; `finalize` runs only the trailing partial window plus the one
 * embedding + profile-match over the merged segments — so post-endpoint work
 * drops from a whole-turn (≤30 s) decode to ≤ one 5 s window + match (#12257).
 *
 * `speculativeMatch` is the `profileStore.beginMatch` handle kicked off at
 * speech-start; it resolves in parallel with ASR. The turn-taking sub-issue
 * (#12255) reads it to gate barge-in before the turn finalizes.
 */
export interface IncrementalTurnAttributor {
	pushWindow(windowPcm: Float32Array, windowStartMs: number): Promise<void>;
	finalize(args: IncrementalTurnFinalize): Promise<VoiceAttributionOutput>;
	/**
	 * Abandon a turn that never reaches `finalize` (VAD close mid-turn,
	 * zero-buffer speech-end). Settles the speech-start window promise so a
	 * suspended speculative `embed()` unwinds instead of hanging forever
	 * (#12896), and cancels the match handle. Idempotent; safe after `finalize`.
	 */
	cancel(): void;
	readonly speculativeMatch: VoiceImprintMatchHandle;
	/** Count of window decodes done DURING the turn (excludes the finalize window). */
	readonly windowsDiarized: number;
}

function nonOverlappingSegments(
	local: ReadonlyArray<LocalSpeakerSegment>,
): LocalSpeakerSegment[] {
	if (local.length === 0) return [];
	return local
		.filter((seg) => !seg.hasOverlap)
		.sort((a, b) =>
			a.startMs !== b.startMs ? a.startMs - b.startMs : a.endMs - b.endMs,
		);
}

/**
 * Shift window-local segment times into turn-relative time. Each 5 s window is
 * decoded with 0-based frame timestamps; adding the window's turn-relative start
 * places its segments on the same timeline the one-shot whole-turn decode uses.
 * `localSpeakerId` is left untouched — it stays window-local (0..2), so the
 * profile store's cosine re-clustering (not the diarizer) owns cross-window
 * identity, exactly as on the one-shot path.
 */
function offsetSegments(
	segments: ReadonlyArray<LocalSpeakerSegment>,
	offsetMs: number,
): LocalSpeakerSegment[] {
	if (offsetMs === 0) return segments.slice();
	return segments.map((seg) => ({
		...seg,
		startMs: seg.startMs + offsetMs,
		endMs: seg.endMs + offsetMs,
	}));
}

function spanDurationMs(spans: ReadonlyArray<LocalSpeakerSegment>): number {
	let total = 0;
	for (const span of mergeSpanRanges(spans)) {
		total += Math.max(0, span.endMs - span.startMs);
	}
	return total;
}

function mergeSpanRanges(
	spans: ReadonlyArray<LocalSpeakerSegment>,
): Array<{ startMs: number; endMs: number }> {
	const sorted = spans
		.map((span) => ({
			startMs: Math.max(0, span.startMs),
			endMs: Math.max(0, span.endMs),
		}))
		.filter((span) => span.endMs > span.startMs)
		.sort((a, b) =>
			a.startMs !== b.startMs ? a.startMs - b.startMs : a.endMs - b.endMs,
		);
	const merged: Array<{ startMs: number; endMs: number }> = [];
	for (const span of sorted) {
		const last = merged[merged.length - 1];
		if (last && span.startMs <= last.endMs) {
			last.endMs = Math.max(last.endMs, span.endMs);
		} else {
			merged.push({ ...span });
		}
	}
	return merged;
}

function pickPrimaryLocalSpeaker(
	local: ReadonlyArray<LocalSpeakerSegment>,
): number | null {
	if (local.length === 0) return null;
	const durations = new Map<number, number>();
	const bySpeaker = new Map<number, LocalSpeakerSegment[]>();
	for (const seg of local) {
		const list = bySpeaker.get(seg.localSpeakerId) ?? [];
		list.push(seg);
		bySpeaker.set(seg.localSpeakerId, list);
	}
	for (const [localSpeakerId, spans] of bySpeaker.entries()) {
		const ms = spanDurationMs(spans);
		durations.set(localSpeakerId, (durations.get(localSpeakerId) ?? 0) + ms);
	}
	let best: { id: number; ms: number } | null = null;
	for (const [id, ms] of durations.entries()) {
		if (!best || ms > best.ms) best = { id, ms };
	}
	return best?.id ?? null;
}

/**
 * Run the diarizer + encoder + profile-store against a complete turn's
 * audio. The caller is responsible for slicing the audio buffer (the
 * pipeline's prefix queue already buffers the entire utterance for
 * the streaming-ASR path).
 *
 * The high-level flow:
 *   1. Diarizer runs on the full PCM, producing per-segment speaker
 *      tags (window-local ids).
 *   2. We pick the longest local-speaker span and run the encoder on
 *      that span (≥ 1 s) to produce a 256-dim embedding.
 *   3. The embedding is matched against the profile store. On hit,
 *      attribute the turn to the matched profile's entity. On miss,
 *      create a new cluster profile (no entity binding — that happens
 *      at the LifeOps layer based on utterance text).
 *   4. Build `VoiceSegment[]` with the resolved speaker, plus a
 *      `VoiceTurnMetadata` for downstream consumers.
 */
export class VoiceAttributionPipeline {
	constructor(private readonly deps: VoiceAttributionPipelineDeps) {}

	async attribute(
		req: VoiceAttributionRequest,
	): Promise<VoiceAttributionOutput> {
		if (req.signal?.aborted) {
			return this.buildEmptyOutput(req);
		}
		// Diarizer is optional — when missing we treat the whole turn as
		// one segment with `localSpeakerId=0`.
		let rawLocal: LocalSpeakerSegment[] = [];
		if (this.deps.diarizer) {
			try {
				const out = await this.deps.diarizer.diarizeWindow(req.pcm);
				rawLocal = out.segments.sort((a, b) =>
					a.startMs !== b.startMs ? a.startMs - b.startMs : a.endMs - b.endMs,
				);
			} catch {
				rawLocal = [];
			}
		}
		return this.resolveAttribution(req, rawLocal);
	}

	/**
	 * Begin a windowed long turn: kick off the speech-start speculative
	 * `beginMatch` and return an attributor that decodes each 5 s window as it
	 * fills (`pushWindow`) and, at speech-end, decodes only the trailing partial
	 * window + the one embedding/profile-match (`finalize`). See
	 * {@link IncrementalTurnAttributor}. Short turns (≤ one window) push no
	 * windows and finalize over the single whole-turn window — identical to
	 * `attribute`.
	 */
	beginTurn(init: IncrementalTurnInit): IncrementalTurnAttributor {
		const rawLocal: LocalSpeakerSegment[] = [];
		let windowsDiarized = 0;

		// The first available window (≥ 1 s) feeds the speculative match so the
		// identity lookup resolves in parallel with ASR instead of at speech-end.
		let resolveFirstWindow: (pcm: Float32Array | null) => void = () => {};
		const firstWindow = new Promise<Float32Array | null>((resolve) => {
			resolveFirstWindow = resolve;
		});
		let firstWindowSettled = false;
		const settleFirstWindow = (pcm: Float32Array | null): void => {
			if (firstWindowSettled) return;
			firstWindowSettled = true;
			resolveFirstWindow(pcm);
		};

		const speculativeMatch = this.deps.profileStore.beginMatch({
			embed: async () => {
				const pcm = await firstWindow;
				if (!pcm || pcm.length < WESPEAKER_MIN_SAMPLES) return null;
				const embedding = await this.deps.encoder.encode(pcm);
				return {
					embedding,
					embeddingModel: this.deps.encoder.modelId ?? "",
				};
			},
			...(init.signal ? { signal: init.signal } : {}),
		});
		// Nothing in this pipeline awaits the speculative result (turn-taking that
		// will consume it is #12255), so its rejection has no caller to land on.
		// Consume it here once so an `encode()`/`findBestMatch()` failure surfaces
		// through the diagnostic sink instead of becoming an unhandled rejection
		// (#12894). `cancel()` resolves the promise to `null` (never rejects), so
		// this only fires on a genuine encode/match failure.
		speculativeMatch.result.catch((error: unknown) => {
			const context = { turnId: init.turnId };
			if (this.deps.reportError) {
				this.deps.reportError(
					"VoiceAttributionPipeline.speculativeMatch",
					error,
					context,
				);
			} else {
				logger.warn(
					{ error, ...context },
					"[VoiceAttributionPipeline] speculative match failed",
				);
			}
		});

		const diarizeInto = async (
			pcm: Float32Array,
			startMs: number,
		): Promise<void> => {
			if (!this.deps.diarizer) return;
			try {
				const out = await this.deps.diarizer.diarizeWindow(pcm);
				for (const seg of offsetSegments(out.segments, startMs)) {
					rawLocal.push(seg);
				}
			} catch {
				// A window that fails to diarize contributes no segments; earlier
				// windows still drive attribution (parity with the one-shot catch).
			}
		};

		// Settle the speech-start window promise (to `null`) and cancel the match.
		// A suspended `embed()` (still `await`-ing `firstWindow` because no window
		// ever pushed) unwinds via the `!pcm` guard → `beginMatch` resolves its
		// result to `null` rather than hanging forever (#12896). Idempotent.
		const abandonSpeculativeMatch = (): void => {
			settleFirstWindow(null);
			speculativeMatch.cancel();
		};

		return {
			get windowsDiarized() {
				return windowsDiarized;
			},
			speculativeMatch,
			cancel: abandonSpeculativeMatch,
			pushWindow: async (windowPcm, windowStartMs) => {
				settleFirstWindow(windowPcm);
				windowsDiarized += 1;
				await diarizeInto(windowPcm, windowStartMs);
			},
			finalize: async (args) => {
				// A turn shorter than one window never pushed: seed the speculative
				// match from the final (whole-turn) window so it still resolves.
				settleFirstWindow(args.finalWindowPcm ?? args.fullPcm);
				if (args.finalWindowPcm && args.finalWindowPcm.length > 0) {
					await diarizeInto(args.finalWindowPcm, args.finalWindowStartMs ?? 0);
				}
				rawLocal.sort((a, b) =>
					a.startMs !== b.startMs ? a.startMs - b.startMs : a.endMs - b.endMs,
				);
				const req: VoiceAttributionRequest = {
					turnId: init.turnId,
					pcm: args.fullPcm,
					...(init.source ? { source: init.source } : {}),
					...(init.startedAtMs !== undefined
						? { startedAtMs: init.startedAtMs }
						: {}),
					...(args.endedAtMs !== undefined
						? { endedAtMs: args.endedAtMs }
						: {}),
					...(args.signal ? { signal: args.signal } : {}),
				};
				try {
					return await this.resolveAttribution(req, rawLocal.slice());
				} finally {
					speculativeMatch.cancel();
				}
			},
		};
	}

	/**
	 * Shared attribution tail: given the turn's diarizer segments (`rawLocal`,
	 * already in turn-relative time) and full PCM (`req.pcm`), pick the primary
	 * local speaker, splice its spans, encode, and match/refine against the
	 * profile store. Both the one-shot `attribute` and the windowed `beginTurn`
	 * finalize converge here so their output shape is identical.
	 */
	private async resolveAttribution(
		req: VoiceAttributionRequest,
		rawLocal: LocalSpeakerSegment[],
	): Promise<VoiceAttributionOutput> {
		if (req.signal?.aborted) return this.buildEmptyOutput(req);
		let local = nonOverlappingSegments(rawLocal);
		if (local.length === 0) {
			local =
				rawLocal.length > 0
					? rawLocal
					: [
							{
								startMs: 0,
								endMs: Math.round(
									(req.pcm.length / this.deps.encoder.sampleRate) * 1000,
								),
								localSpeakerId: 0,
								confidence: 0.5,
								hasOverlap: false,
							},
						];
		}
		let primaryLocal = pickPrimaryLocalSpeaker(local);
		if (primaryLocal === null) return this.buildEmptyOutput(req);
		// Concatenate the primary local speaker's spans into a single PCM
		// window for the embedding.
		let primarySpans = local.filter(
			(seg) => seg.localSpeakerId === primaryLocal,
		);
		let window = this.spliceSpans(req.pcm, primarySpans);
		if (
			window.length < WESPEAKER_MIN_SAMPLES &&
			rawLocal.length > local.length
		) {
			const fallbackPrimary = pickPrimaryLocalSpeaker(rawLocal);
			const fallbackSpans =
				fallbackPrimary === null
					? []
					: rawLocal.filter((seg) => seg.localSpeakerId === fallbackPrimary);
			const fallbackWindow = this.spliceSpans(req.pcm, fallbackSpans);
			if (
				fallbackPrimary !== null &&
				fallbackWindow.length >= WESPEAKER_MIN_SAMPLES
			) {
				local = rawLocal;
				primaryLocal = fallbackPrimary;
				primarySpans = fallbackSpans;
				window = fallbackWindow;
			}
		}
		if (window.length < WESPEAKER_MIN_SAMPLES) {
			// Not enough audio for a stable embedding — emit an
			// "unknown speaker" segment, no profile observation.
			const turn: VoiceTurnMetadata = {
				turnId: req.turnId,
				source: req.source,
				segments: this.localToUnknownSegments(local, req.source),
				...(req.startedAtMs !== undefined
					? { startedAtMs: req.startedAtMs }
					: {}),
				...(req.endedAtMs !== undefined ? { endedAtMs: req.endedAtMs } : {}),
				diarization: this.deps.diarizer
					? {
							provider: "local",
							model: this.deps.diarizer.modelId,
							version: "v1",
						}
					: undefined,
			};
			return {
				turnId: req.turnId,
				segments: turn.segments ?? [],
				turn,
				observation: null,
			};
		}
		if (req.signal?.aborted) return this.buildEmptyOutput(req);

		const embedding = await this.deps.encoder.encode(window);
		if (req.signal?.aborted) return this.buildEmptyOutput(req);

		const match = await this.deps.profileStore.findBestMatch({
			embedding,
			embeddingModel: this.deps.encoder.modelId ?? "",
		});

		let observation: VoiceProfileObservation;
		let speaker: VoiceSpeaker;
		if (match) {
			// Update the existing profile with the new observation.
			const refined = await this.deps.profileStore.refine({
				profileId: match.profile.id,
				embedding,
				durationMs: this.spanMsTotal(primarySpans),
				confidence: match.confidence,
			});
			observation = {
				profileId: match.profile.id,
				imprintClusterId: match.profile.sourceScopeId ?? match.profile.id,
				entityId: refined?.entityId ?? match.profile.entityId ?? null,
				embedding,
				embeddingModel: this.deps.encoder.modelId ?? "",
				confidence: match.confidence,
				source: req.source,
				startMs: primarySpans[0]?.startMs,
				endMs: primarySpans[primarySpans.length - 1]?.endMs,
			};
			speaker = voiceSpeakerFromImprintMatch({
				match,
				source: req.source,
				observationId: req.turnId,
			});
		} else {
			// Create a new cluster.
			const created = await this.deps.profileStore.createProfile({
				centroid: embedding,
				embeddingModel: this.deps.encoder.modelId ?? "",
				entityId: null,
				confidence: 0.5,
				durationMs: this.spanMsTotal(primarySpans),
			});
			observation = {
				profileId: created.profileId,
				imprintClusterId: created.imprintClusterId,
				entityId: null,
				embedding,
				embeddingModel: this.deps.encoder.modelId ?? "",
				confidence: 0.5,
				source: req.source,
				startMs: primarySpans[0]?.startMs,
				endMs: primarySpans[primarySpans.length - 1]?.endMs,
			};
			speaker = {
				id: created.imprintClusterId,
				imprintClusterId: created.imprintClusterId,
				imprintObservationId: req.turnId,
				entityId: undefined,
				source: req.source,
				confidence: 0.5,
				metadata: {
					attributionOnly: true,
					evidenceKind: "voice_imprint_attribution",
					identityAuthority: false,
					synthesisAuthorization: false,
					embeddingModel: this.deps.encoder.modelId ?? "",
					profileId: created.profileId,
				},
			};
		}

		const segments = this.localToVoiceSegments(
			local,
			primaryLocal,
			speaker,
			req.source,
		);

		const turn: VoiceTurnMetadata = {
			turnId: req.turnId,
			source: req.source,
			primarySpeaker: speaker,
			segments,
			...(req.startedAtMs !== undefined
				? { startedAtMs: req.startedAtMs }
				: {}),
			...(req.endedAtMs !== undefined ? { endedAtMs: req.endedAtMs } : {}),
			diarization: this.deps.diarizer
				? {
						provider: "local",
						model: this.deps.diarizer.modelId,
						version: "v1",
						confidence: match?.confidence,
					}
				: undefined,
		};

		return {
			turnId: req.turnId,
			primarySpeaker: speaker,
			segments,
			turn,
			observation,
		};
	}

	private buildEmptyOutput(
		req: VoiceAttributionRequest,
	): VoiceAttributionOutput {
		const turn: VoiceTurnMetadata = {
			turnId: req.turnId,
			source: req.source,
			segments: [],
			...(req.startedAtMs !== undefined
				? { startedAtMs: req.startedAtMs }
				: {}),
			...(req.endedAtMs !== undefined ? { endedAtMs: req.endedAtMs } : {}),
		};
		return { turnId: req.turnId, segments: [], turn, observation: null };
	}

	private spliceSpans(
		pcm: Float32Array,
		spans: ReadonlyArray<LocalSpeakerSegment>,
	): Float32Array {
		const sr = this.deps.encoder.sampleRate;
		const merged = mergeSpanRanges(spans);
		// Compute total length first so we can allocate once.
		let total = 0;
		for (const span of merged) {
			const a = Math.max(0, Math.floor((span.startMs / 1000) * sr));
			const b = Math.min(pcm.length, Math.ceil((span.endMs / 1000) * sr));
			if (b > a) total += b - a;
		}
		if (total === 0) return new Float32Array(0);
		const out = new Float32Array(total);
		let cursor = 0;
		for (const span of merged) {
			const a = Math.max(0, Math.floor((span.startMs / 1000) * sr));
			const b = Math.min(pcm.length, Math.ceil((span.endMs / 1000) * sr));
			if (b > a) {
				out.set(pcm.subarray(a, b), cursor);
				cursor += b - a;
			}
		}
		return out;
	}

	private spanMsTotal(spans: ReadonlyArray<LocalSpeakerSegment>): number {
		let total = 0;
		for (const span of spans) total += Math.max(0, span.endMs - span.startMs);
		return total;
	}

	private localToVoiceSegments(
		local: ReadonlyArray<LocalSpeakerSegment>,
		primaryLocalId: number,
		primarySpeaker: VoiceSpeaker,
		source?: VoiceInputSource,
	): VoiceSegment[] {
		return local.map<VoiceSegment>((seg, i) => {
			const isPrimary = seg.localSpeakerId === primaryLocalId;
			const speaker: VoiceSpeaker = isPrimary
				? primarySpeaker
				: {
						id: `local_${seg.localSpeakerId}`,
						label: `Speaker ${seg.localSpeakerId}`,
						source,
						confidence: seg.confidence,
						metadata: {
							attributionOnly: true,
							evidenceKind: "voice_imprint_attribution",
							identityAuthority: false,
							synthesisAuthorization: false,
							diarizationOnly: true,
						},
					};
			return {
				id: `seg_${i}`,
				text: "",
				startMs: seg.startMs,
				endMs: seg.endMs,
				speaker,
				speakerId: speaker.id,
				...(source ? { source } : {}),
				confidence: seg.confidence,
				metadata: {
					localSpeakerId: seg.localSpeakerId,
					primary: isPrimary,
				},
			};
		});
	}

	private localToUnknownSegments(
		local: ReadonlyArray<LocalSpeakerSegment>,
		source?: VoiceInputSource,
	): VoiceSegment[] {
		return local.map<VoiceSegment>((seg, i) => ({
			id: `seg_${i}`,
			text: "",
			startMs: seg.startMs,
			endMs: seg.endMs,
			...(source ? { source } : {}),
			confidence: seg.confidence,
			metadata: { localSpeakerId: seg.localSpeakerId, primary: false },
		}));
	}
}

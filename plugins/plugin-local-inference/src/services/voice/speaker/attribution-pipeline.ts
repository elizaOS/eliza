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

import {
	matchVoiceImprint,
	voiceSpeakerFromImprintMatch,
	type VoiceImprintMatch,
} from "../speaker-imprint";
import type {
	VoiceInputSource,
	VoiceSegment,
	VoiceSpeaker,
	VoiceTurnMetadata,
} from "../types";
import type { Diarizer, LocalSpeakerSegment } from "./diarizer";
import type { SpeakerEncoder } from "./encoder";
import { WESPEAKER_MIN_SAMPLES } from "./encoder";
import type {
	VoiceProfileObservation,
	VoiceProfileStore,
} from "../profile-store";

export interface VoiceAttributionPipelineDeps {
	encoder: SpeakerEncoder;
	diarizer?: Diarizer;
	profileStore: VoiceProfileStore;
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

function pickPrimaryLocalSpeaker(
	local: ReadonlyArray<LocalSpeakerSegment>,
): number | null {
	if (local.length === 0) return null;
	const durations = new Map<number, number>();
	for (const seg of local) {
		const ms = Math.max(0, seg.endMs - seg.startMs);
		durations.set(seg.localSpeakerId, (durations.get(seg.localSpeakerId) ?? 0) + ms);
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
		let local: LocalSpeakerSegment[] = [];
		if (this.deps.diarizer) {
			try {
				const out = await this.deps.diarizer.diarizeWindow(req.pcm);
				local = nonOverlappingSegments(out.segments);
			} catch {
				local = [];
			}
		}
		if (local.length === 0) {
			local = [
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
		const primaryLocal = pickPrimaryLocalSpeaker(local);
		if (primaryLocal === null) return this.buildEmptyOutput(req);
		// Concatenate the primary local speaker's spans into a single PCM
		// window for the embedding.
		const primarySpans = local.filter(
			(seg) => seg.localSpeakerId === primaryLocal,
		);
		const window = this.spliceSpans(req.pcm, primarySpans);
		if (window.length < WESPEAKER_MIN_SAMPLES) {
			// Not enough audio for a stable embedding — emit an
			// "unknown speaker" segment, no profile observation.
			const turn: VoiceTurnMetadata = {
				turnId: req.turnId,
				source: req.source,
				segments: this.localToUnknownSegments(local, req.source),
				...(req.startedAtMs !== undefined ? { startedAtMs: req.startedAtMs } : {}),
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
			embeddingModel: this.deps.encoder.modelId,
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
				embeddingModel: this.deps.encoder.modelId,
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
				embeddingModel: this.deps.encoder.modelId,
				entityId: null,
				confidence: 0.5,
				durationMs: this.spanMsTotal(primarySpans),
			});
			observation = {
				profileId: created.profileId,
				imprintClusterId: created.imprintClusterId,
				entityId: null,
				embedding,
				embeddingModel: this.deps.encoder.modelId,
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
					embeddingModel: this.deps.encoder.modelId,
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
			...(req.startedAtMs !== undefined ? { startedAtMs: req.startedAtMs } : {}),
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

	private buildEmptyOutput(req: VoiceAttributionRequest): VoiceAttributionOutput {
		const turn: VoiceTurnMetadata = {
			turnId: req.turnId,
			source: req.source,
			segments: [],
			...(req.startedAtMs !== undefined ? { startedAtMs: req.startedAtMs } : {}),
			...(req.endedAtMs !== undefined ? { endedAtMs: req.endedAtMs } : {}),
		};
		return { turnId: req.turnId, segments: [], turn, observation: null };
	}

	private spliceSpans(
		pcm: Float32Array,
		spans: ReadonlyArray<LocalSpeakerSegment>,
	): Float32Array {
		const sr = this.deps.encoder.sampleRate;
		// Compute total length first so we can allocate once.
		let total = 0;
		for (const span of spans) {
			const a = Math.max(0, Math.floor((span.startMs / 1000) * sr));
			const b = Math.min(pcm.length, Math.ceil((span.endMs / 1000) * sr));
			if (b > a) total += b - a;
		}
		if (total === 0) return new Float32Array(0);
		const out = new Float32Array(total);
		let cursor = 0;
		for (const span of spans) {
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

/** Covers `VoiceAttributionPipeline` end-to-end over diarizer + encoder + profile store. Deterministic, fake components. */
import { describe, expect, it } from "vitest";
import {
	VOICE_PROFILE_RECORD_SCHEMA_VERSION,
	type VoiceProfileRecord,
	type VoiceProfileStore,
} from "../profile-store";
import { VoiceAttributionPipeline } from "./attribution-pipeline";
import type { Diarizer } from "./diarizer";
import { PYANNOTE_SEGMENTATION_3_INT8_MODEL_ID } from "./diarizer";
import type { SpeakerEncoder } from "./encoder";

describe("VoiceAttributionPipeline", () => {
	it("does not double-count overlapping spans when choosing the primary local speaker", async () => {
		const encoder: SpeakerEncoder & { windows: Float32Array[] } = {
			embeddingDim: 2,
			sampleRate: 16_000,
			modelId: "test-speaker-encoder",
			windows: [],
			async encode(pcm) {
				this.windows.push(pcm);
				return new Float32Array([1, 0]);
			},
			async dispose() {},
		};
		const diarizer: Diarizer = {
			modelId: PYANNOTE_SEGMENTATION_3_INT8_MODEL_ID,
			sampleRate: 16_000,
			async diarizeWindow() {
				return {
					localSpeakerCount: 2,
					speechMs: 2_500,
					segments: [
						{
							startMs: 0,
							endMs: 1_000,
							localSpeakerId: 0,
							confidence: 0.9,
							hasOverlap: false,
						},
						{
							startMs: 0,
							endMs: 1_000,
							localSpeakerId: 0,
							confidence: 0.9,
							hasOverlap: false,
						},
						{
							startMs: 1_000,
							endMs: 2_500,
							localSpeakerId: 1,
							confidence: 0.8,
							hasOverlap: false,
						},
					],
				};
			},
			async dispose() {},
		};
		const profileStore: Pick<
			VoiceProfileStore,
			"findBestMatch" | "createProfile" | "refine"
		> = {
			async findBestMatch() {
				return null;
			},
			async createProfile(args): Promise<VoiceProfileRecord> {
				return {
					schemaVersion: VOICE_PROFILE_RECORD_SCHEMA_VERSION,
					profileId: "profile-primary",
					embeddingModel: args.embeddingModel,
					embeddingDim: args.centroid.length,
					centroid: Array.from(args.centroid),
					variance: new Array(args.centroid.length).fill(0),
					welfordM2: new Array(args.centroid.length).fill(0),
					sampleCount: 1,
					totalDurationMs: args.durationMs,
					firstObservedAt: "2026-01-01T00:00:00.000Z",
					lastObservedAt: "2026-01-01T00:00:00.000Z",
					lastRefinedAt: "2026-01-01T00:00:00.000Z",
					entityId: null,
					imprintClusterId: "cluster-primary",
					confidence: args.confidence,
					consent: {
						attributionAuthorized: false,
						synthesisAuthorized: false,
					},
				};
			},
			async refine() {
				return null;
			},
		};
		const pipeline = new VoiceAttributionPipeline({
			encoder,
			diarizer,
			profileStore: profileStore as VoiceProfileStore,
		});

		const output = await pipeline.attribute({
			turnId: "turn-overlap-primary",
			pcm: new Float32Array(16_000 * 3),
		});

		expect(encoder.windows).toHaveLength(1);
		expect(encoder.windows[0]).toHaveLength(24_000);
		expect(
			output.segments.map((segment) => ({
				localSpeakerId: segment.metadata?.localSpeakerId,
				primary: segment.metadata?.primary,
			})),
		).toEqual([
			{ localSpeakerId: 0, primary: false },
			{ localSpeakerId: 0, primary: false },
			{ localSpeakerId: 1, primary: true },
		]);
	});

	it("uses overlap-marked diarizer spans when strict non-overlap spans are too short", async () => {
		const encoder: SpeakerEncoder & { windows: Float32Array[] } = {
			embeddingDim: 2,
			sampleRate: 16_000,
			modelId: "test-speaker-encoder",
			windows: [],
			async encode(pcm) {
				this.windows.push(pcm);
				return new Float32Array([1, 0]);
			},
			async dispose() {},
		};
		const diarizer: Diarizer = {
			modelId: PYANNOTE_SEGMENTATION_3_INT8_MODEL_ID,
			sampleRate: 16_000,
			async diarizeWindow() {
				return {
					localSpeakerCount: 3,
					speechMs: 1_720,
					segments: [
						{
							startMs: 0,
							endMs: 20,
							localSpeakerId: 0,
							confidence: 0.5,
							hasOverlap: false,
						},
						{
							startMs: 0,
							endMs: 1_000,
							localSpeakerId: 1,
							confidence: 0.5,
							hasOverlap: true,
						},
						{
							startMs: 500,
							endMs: 1_500,
							localSpeakerId: 1,
							confidence: 0.5,
							hasOverlap: true,
						},
						{
							startMs: 1_600,
							endMs: 1_800,
							localSpeakerId: 2,
							confidence: 0.5,
							hasOverlap: true,
						},
					],
				};
			},
			async dispose() {},
		};
		const profileStore: Pick<
			VoiceProfileStore,
			"findBestMatch" | "createProfile" | "refine"
		> = {
			async findBestMatch() {
				return null;
			},
			async createProfile(args): Promise<VoiceProfileRecord> {
				return {
					schemaVersion: VOICE_PROFILE_RECORD_SCHEMA_VERSION,
					profileId: "profile-overlap",
					embeddingModel: args.embeddingModel,
					embeddingDim: args.centroid.length,
					centroid: Array.from(args.centroid),
					variance: new Array(args.centroid.length).fill(0),
					welfordM2: new Array(args.centroid.length).fill(0),
					sampleCount: 1,
					totalDurationMs: args.durationMs,
					firstObservedAt: "2026-01-01T00:00:00.000Z",
					lastObservedAt: "2026-01-01T00:00:00.000Z",
					lastRefinedAt: "2026-01-01T00:00:00.000Z",
					entityId: null,
					imprintClusterId: "cluster-overlap",
					confidence: args.confidence,
					consent: {
						attributionAuthorized: false,
						synthesisAuthorized: false,
					},
				};
			},
			async refine() {
				return null;
			},
		};
		const pipeline = new VoiceAttributionPipeline({
			encoder,
			diarizer,
			profileStore: profileStore as VoiceProfileStore,
		});

		const output = await pipeline.attribute({
			turnId: "turn-overlap-fallback",
			pcm: new Float32Array(16_000 * 2),
		});

		expect(output.observation?.imprintClusterId).toBe("cluster-overlap");
		expect(output.primarySpeaker?.imprintClusterId).toBe("cluster-overlap");
		expect(encoder.windows).toHaveLength(1);
		expect(encoder.windows[0]).toHaveLength(24_000);
	});
});

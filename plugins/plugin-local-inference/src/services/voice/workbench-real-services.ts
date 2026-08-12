/**
 * Voice Workbench real services adapter (#9147).
 *
 * `voice:workbench --real` must not be an all-skipped honesty stub: the lane
 * has a fused libelizainference build, ASR regions, WeSpeaker, pyannote, and
 * real generated human speech — distinct fused Kokoro voice packs keylessly
 * (#9577), upgraded to ElevenLabs voices when ELEVENLABS_API_KEY is set. The
 * agent turns always come from the fused Kokoro engine (the product's
 * on-device TTS). This adapter drives those real pieces through the existing
 * workbench runner/scorers.
 */

import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	type OwnerObservation,
	resolveOwnerCandidate,
} from "@elizaos/shared/voice/owner-inference";
import {
	AGENT_SELF_VOICE_IMPRINT_THRESHOLD,
	buildVoiceTurnSignal,
} from "@elizaos/shared/voice/respond-gate";
import { scoreEndOfTurnHeuristic } from "@elizaos/shared/voice-eot";
import { resolveFusedLibraryPath } from "../desktop-fused-ffi-backend-runtime";
import { OnlineSpeakerClusterer } from "./acoustic-speaker-attribution";
import type {
	CorpusGroundTruth,
	CorpusTtsSynthesizer,
	GeneratedVoiceCorpus,
} from "./corpus-generator";
import { createKokoroTtsBackend } from "./engine-bridge";
import {
	type ElizaInferenceContextHandle,
	type ElizaInferenceFfi,
	loadElizaInferenceFfi,
} from "./ffi-bindings";
import type { KokoroTtsBackend } from "./kokoro/kokoro-backend";
import { resolveKokoroEngineConfig } from "./kokoro/kokoro-engine-discovery";
import {
	type DiarizerOutput,
	PYANNOTE_WINDOW_SECONDS,
} from "./speaker/diarizer";
import { FusedDiarizer } from "./speaker/diarizer-fused";
import { averageEmbeddings } from "./speaker/encoder";
import { FusedSpeakerEncoder } from "./speaker/encoder-fused";
import { SPEAKER_GGML_MIN_SAMPLES } from "./speaker/encoder-ggml";
import {
	cosineSimilarity,
	DEFAULT_VOICE_IMPRINT_MATCH_THRESHOLD,
} from "./speaker-imprint";
import {
	StabilizedStreamingTranscriber,
	StreamingAsrFeeder,
} from "./streaming-asr/streaming-pipeline-adapter";
import {
	createStreamingTranscriber,
	ffiSupportsStreamingAsr,
	resampleLinear,
} from "./transcriber";
import type { VoiceScenario } from "./voice-scenario";
import type {
	VoiceDiarizationObservation,
	VoiceTurnObservation,
	VoiceWorkbenchServices,
} from "./workbench-headless-runner";
import {
	KOKORO_AGENT_VOICE,
	labelHash,
	resolveKokoroVoicePack,
	validateScenarioVoiceAssignments,
} from "./workbench-voice-packs";

const SAMPLE_RATE = 16_000;
const EOT_COMMIT_THRESHOLD = 0.5;
export const VOICE_WORKBENCH_OWNER_THRESHOLD =
	DEFAULT_VOICE_IMPRINT_MATCH_THRESHOLD;
const MAX_AGENT_TTS_SECONDS = 12;
const STREAMING_ASR_FRAME_SAMPLES = SAMPLE_RATE / 5;
export const VOICE_WORKBENCH_ENROLLMENT_PHRASES = [
	"Silver lanterns shimmer while gentle rain crosses the quiet valley.",
	"Pack five bright boxes beside the old wooden gate before sunrise.",
	"Could you remember my calm voice when numbers change from seven to forty two?",
] as const;

const ELEVENLABS_MODEL_ID = "eleven_turbo_v2_5";
const ELEVENLABS_VOICE_IDS = [
	"21m00Tcm4TlvDq8ikWAM", // Rachel
	"pNInz6obpgDQGcFmaJgB", // Adam
	"EXAVITQu4vr4xnSDxMaL", // Bella
	"ErXwobaYiN019PkySvjV", // Antoni
	"MF3mGyEYCl7XYWbV9V6O", // Elli
	"TxGEqnHWrfWFTfGW9XjX", // Josh
] as const;

const VOICE_ID_ALIASES: Record<string, string> = {
	af_bella: "EXAVITQu4vr4xnSDxMaL",
	af_sarah: "EXAVITQu4vr4xnSDxMaL",
	af_nicole: "MF3mGyEYCl7XYWbV9V6O",
	am_adam: "pNInz6obpgDQGcFmaJgB",
	am_michael: "ErXwobaYiN019PkySvjV",
	bm_lewis: "ErXwobaYiN019PkySvjV",
	owner: "21m00Tcm4TlvDq8ikWAM",
	alice: "21m00Tcm4TlvDq8ikWAM",
	jill: "21m00Tcm4TlvDq8ikWAM",
	bob: "pNInz6obpgDQGcFmaJgB",
	guest: "pNInz6obpgDQGcFmaJgB",
	intruder: "pNInz6obpgDQGcFmaJgB",
	marcus: "ErXwobaYiN019PkySvjV",
	priya: "EXAVITQu4vr4xnSDxMaL",
	mia: "EXAVITQu4vr4xnSDxMaL",
	eliza: "MF3mGyEYCl7XYWbV9V6O",
	aria: "TxGEqnHWrfWFTfGW9XjX",
};

/** Resolve the concrete ElevenLabs voice used for enrollment and scored turns. */
export function resolveElevenLabsWorkbenchVoiceId(
	voiceId: string | undefined,
	speakerLabel: string,
	voiceMap: Readonly<Record<string, string>> = {},
): string {
	const keys = [voiceId, speakerLabel].filter(
		(value): value is string => typeof value === "string" && value.length > 0,
	);
	for (const key of keys) {
		const mapped =
			voiceMap[key.toLowerCase()] ?? VOICE_ID_ALIASES[key.toLowerCase()];
		if (mapped) return mapped;
	}
	return ELEVENLABS_VOICE_IDS[
		labelHash(speakerLabel) % ELEVENLABS_VOICE_IDS.length
	];
}

// Keyless mode (#9577): human turns are synthesized with distinct fused Kokoro
// voice packs instead of ElevenLabs voices. The pack constants and the
// label → pack resolution live in `workbench-voice-packs.ts` so the mapping is
// unit-coverable without the fused native library this adapter binds.

interface SpeakerProfile {
	label: string;
	entityId: string | null;
	isOwner: boolean;
	centroid: Float32Array;
}

interface SpeakerMatch {
	profile: SpeakerProfile;
	similarity: number;
}

interface MeasuredSynthesis {
	pcm: Float32Array;
	firstAudioMs: number;
}

/**
 * Drive the same fused streaming-to-batch ASR selection used by the product
 * voice bridge. The microtask yield models live frame arrival: without it the
 * synthetic corpus can enqueue every batch-interim decode before any partial
 * has a chance to run, incorrectly reporting zero streaming coverage.
 */
export async function transcribeVoiceWorkbenchStream(args: {
	ffi: ElizaInferenceFfi;
	ctx: ElizaInferenceContextHandle;
	pcm: Float32Array;
}): Promise<{ transcript: string; partials: string[] }> {
	const rawTranscriber = createStreamingTranscriber({
		ffi: args.ffi,
		getContext: () => args.ctx,
		asrBundlePresent: true,
		prefer: "auto",
	});
	const transcriber = ffiSupportsStreamingAsr(args.ffi)
		? new StabilizedStreamingTranscriber(rawTranscriber)
		: rawTranscriber;
	const partials: string[] = [];
	const feeder = new StreamingAsrFeeder({
		transcriber,
		events: {
			onPartial: (update) => partials.push(update.partial),
		},
	});
	try {
		const startedAtMs = performance.now();
		for (
			let offset = 0;
			offset < args.pcm.length;
			offset += STREAMING_ASR_FRAME_SAMPLES
		) {
			feeder.feedFrame({
				pcm: args.pcm.subarray(
					offset,
					Math.min(args.pcm.length, offset + STREAMING_ASR_FRAME_SAMPLES),
				),
				sampleRate: SAMPLE_RATE,
				timestampMs: startedAtMs + (offset / SAMPLE_RATE) * 1000,
			});
			await Promise.resolve();
		}
		const final = await feeder.finalize();
		return { transcript: final.partial.trim(), partials };
	} finally {
		feeder.dispose();
		transcriber.dispose();
	}
}

export interface RealVoiceWorkbenchRuntime {
	services: VoiceWorkbenchServices;
	synthesizer: CorpusTtsSynthesizer;
	/** Exact native/model artifacts used by the run for evidence hashing. */
	artifacts: RealVoiceWorkbenchArtifacts;
	dispose(): Promise<void>;
}

export interface RealVoiceWorkbenchArtifacts {
	bundle: string;
	fusedLib: string;
	speakerGguf: string;
	diarizGguf: string;
}

interface RealVoiceWorkbenchOptions {
	bundle: string;
	fusedLib: string;
	speakerGguf: string;
	diarizGguf: string;
	elevenLabsApiKey: string | null;
	ownerAcceptThreshold?: number;
	voiceMap?: Record<string, string>;
}

function requirePath(label: string, value: string | null | undefined): string {
	if (!value || !existsSync(value)) {
		throw new Error(
			`[voice:workbench --real] missing ${label}: ${value ?? "(unset)"}`,
		);
	}
	return value;
}

function nonEmpty(value: string | null | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function firstExisting(
	...candidates: Array<string | null | undefined>
): string | null {
	for (const candidate of candidates) {
		if (candidate && existsSync(candidate)) return candidate;
	}
	return null;
}

function finiteNumberEnv(
	env: NodeJS.ProcessEnv,
	name: string,
	fallback: number,
): number {
	const raw = env[name]?.trim();
	if (!raw) return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value)) {
		throw new Error(
			`[voice:workbench --real] ${name} must be finite, got ${raw}`,
		);
	}
	return value;
}

function parseVoiceMap(raw: string | undefined): Record<string, string> {
	if (!raw?.trim()) return {};
	const parsed = JSON.parse(raw) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(
			"[voice:workbench --real] ELIZA_WORKBENCH_ELEVENLABS_VOICE_MAP must be a JSON object",
		);
	}
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (typeof value !== "string" || !value.trim()) {
			throw new Error(
				`[voice:workbench --real] voice map value for ${key} must be a non-empty string`,
			);
		}
		out[key.toLowerCase()] = value.trim();
	}
	return out;
}

function ensureSampleRate(
	pcm: Float32Array,
	fromRate: number,
	toRate: number,
): Float32Array {
	return fromRate === toRate ? pcm : resampleLinear(pcm, fromRate, toRate);
}

function ensureMinSpeakerSamples(pcm: Float32Array): Float32Array {
	if (pcm.length >= SPEAKER_GGML_MIN_SAMPLES) return pcm;
	const out = new Float32Array(SPEAKER_GGML_MIN_SAMPLES);
	out.set(pcm);
	return out;
}

/** Build the workbench profile exactly like multi-capture product enrollment. */
export async function buildVoiceWorkbenchEnrollmentCentroid(args: {
	voiceId: string;
	synthesize(input: { text: string; voiceId: string }): Promise<Float32Array>;
	encode(pcm: Float32Array): Promise<Float32Array>;
}): Promise<Float32Array> {
	const embeddings: Float32Array[] = [];
	for (
		let sampleIndex = 0;
		sampleIndex < VOICE_WORKBENCH_ENROLLMENT_PHRASES.length;
		sampleIndex += 1
	) {
		const pcm = await args.synthesize({
			text: VOICE_WORKBENCH_ENROLLMENT_PHRASES[sampleIndex],
			voiceId: args.voiceId,
		});
		if (pcm.length === 0) {
			throw new Error(
				`[voice:workbench --real] enrollment sample ${sampleIndex + 1} produced no audio`,
			);
		}
		const embedding = await args.encode(ensureMinSpeakerSamples(pcm));
		let magnitudeSquared = 0;
		for (const value of embedding) {
			if (!Number.isFinite(value)) {
				throw new Error(
					`[voice:workbench --real] enrollment sample ${sampleIndex + 1} produced a non-finite embedding`,
				);
			}
			magnitudeSquared += value * value;
		}
		if (embedding.length === 0 || magnitudeSquared === 0) {
			throw new Error(
				`[voice:workbench --real] enrollment sample ${sampleIndex + 1} produced an empty embedding`,
			);
		}
		embeddings.push(embedding);
	}
	return averageEmbeddings(embeddings);
}

function concatPcm(parts: ReadonlyArray<Float32Array>): Float32Array {
	const total = parts.reduce((sum, part) => sum + part.length, 0);
	const out = new Float32Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

function diarizerWindow(pcm: Float32Array): Float32Array {
	const targetSamples = SAMPLE_RATE * 5;
	if (pcm.length === targetSamples) return pcm;
	if (pcm.length > targetSamples) return pcm.subarray(0, targetSamples);
	const out = new Float32Array(targetSamples);
	out.set(pcm);
	return out;
}

export interface VoiceWorkbenchStreamDiarizationArgs {
	audio: Float32Array;
	sampleRate: number;
	diarizeWindow(pcm: Float32Array): Promise<DiarizerOutput>;
	encodeSpeaker(pcm: Float32Array): Promise<Float32Array>;
}

/** Diarize every model window and preserve provider-produced stream offsets. */
export async function diarizeVoiceWorkbenchStream(
	args: VoiceWorkbenchStreamDiarizationArgs,
): Promise<VoiceDiarizationObservation[]> {
	const audio16 = ensureSampleRate(args.audio, args.sampleRate, SAMPLE_RATE);
	const windowSamples = SAMPLE_RATE * PYANNOTE_WINDOW_SECONDS;
	const clusterer = new OnlineSpeakerClusterer();
	const observations: VoiceDiarizationObservation[] = [];

	for (
		let windowStartSample = 0;
		windowStartSample < audio16.length;
		windowStartSample += windowSamples
	) {
		const availableSamples = Math.min(
			windowSamples,
			audio16.length - windowStartSample,
		);
		const windowPcm = new Float32Array(windowSamples);
		windowPcm.set(
			audio16.subarray(windowStartSample, windowStartSample + availableSamples),
		);
		const output = await args.diarizeWindow(windowPcm);
		const byLocalSpeaker = new Map<number, typeof output.segments>();
		for (const segment of output.segments) {
			const existing = byLocalSpeaker.get(segment.localSpeakerId) ?? [];
			existing.push(segment);
			byLocalSpeaker.set(segment.localSpeakerId, existing);
		}

		for (const segments of byLocalSpeaker.values()) {
			const audioParts = segments.flatMap((segment) => {
				const start = Math.max(
					0,
					Math.floor((segment.startMs / 1000) * SAMPLE_RATE),
				);
				const end = Math.min(
					availableSamples,
					Math.ceil((segment.endMs / 1000) * SAMPLE_RATE),
				);
				return end > start ? [windowPcm.subarray(start, end)] : [];
			});
			if (audioParts.length === 0) continue;
			const embedding = await args.encodeSpeaker(
				ensureMinSpeakerSamples(concatPcm(audioParts)),
			);
			const clusterId = clusterer.assign(embedding);
			if (!clusterId) continue;

			const windowStartMs = (windowStartSample / SAMPLE_RATE) * 1000;
			const availableMs = (availableSamples / SAMPLE_RATE) * 1000;
			for (const segment of segments) {
				const endMs = Math.min(segment.endMs, availableMs);
				if (endMs <= segment.startMs) continue;
				observations.push({
					speaker: clusterId,
					startMs: windowStartMs + segment.startMs,
					endMs: windowStartMs + endMs,
					confidence: segment.confidence,
					hasOverlap: segment.hasOverlap,
				});
			}
		}
	}

	return observations;
}

function pcm16ToFloat32(bytes: Uint8Array): Float32Array {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const samples = Math.floor(bytes.byteLength / 2);
	const out = new Float32Array(samples);
	for (let i = 0; i < samples; i += 1) {
		out[i] = view.getInt16(i * 2, true) / 32768;
	}
	return out;
}

function extractName(transcript: string): string | null {
	const match = transcript.match(
		/\b(?:my name is|i am|i'm|this is|call me)\s+([a-z]+)/i,
	);
	return match?.[1]?.toLowerCase() ?? null;
}

function knownSpeakerIds(groundTruth: CorpusGroundTruth): string[] {
	if (groundTruth.knownSpeakerEntityIds)
		return groundTruth.knownSpeakerEntityIds;
	return groundTruth.participants
		.map((p) => p.entityId)
		.filter((id): id is string => typeof id === "string" && id.length > 0);
}

function bestSpeakerMatch(
	profiles: Iterable<SpeakerProfile>,
	embedding: Float32Array,
): SpeakerMatch | null {
	let best: SpeakerMatch | null = null;
	for (const profile of profiles) {
		const similarity = cosineSimilarity(embedding, profile.centroid);
		if (!best || similarity > best.similarity) {
			best = { profile, similarity };
		}
	}
	return best;
}

async function elevenLabsPcm(args: {
	text: string;
	voiceId: string;
	apiKey: string;
	sampleRate: number;
}): Promise<Float32Array> {
	const response = await fetch(
		`https://api.elevenlabs.io/v1/text-to-speech/${args.voiceId}?output_format=pcm_16000`,
		{
			method: "POST",
			headers: {
				"xi-api-key": args.apiKey,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				text: args.text,
				model_id: ELEVENLABS_MODEL_ID,
			}),
		},
	);
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(
			`[voice:workbench --real] ElevenLabs ${response.status} for ${args.voiceId}: ${body.slice(0, 240)}`,
		);
	}
	const pcm = pcm16ToFloat32(new Uint8Array(await response.arrayBuffer()));
	return ensureSampleRate(pcm, SAMPLE_RATE, args.sampleRate);
}

class RealVoiceWorkbenchAdapter implements RealVoiceWorkbenchRuntime {
	readonly synthesizer: CorpusTtsSynthesizer;
	readonly services: VoiceWorkbenchServices;
	readonly artifacts: RealVoiceWorkbenchArtifacts;

	private readonly ffi: ElizaInferenceFfi;
	private readonly ctx: ReturnType<ElizaInferenceFfi["create"]>;
	private readonly encoder: FusedSpeakerEncoder;
	private readonly diarizer: FusedDiarizer;
	private readonly kokoroBackend: KokoroTtsBackend;
	private readonly apiKey: string | null;
	private readonly ownerThreshold: number;
	private readonly voiceMap: Record<string, string>;
	private readonly profiles = new Map<string, SpeakerProfile>();
	private readonly selfVoiceEmbeddings: Float32Array[] = [];
	private ownerObservations: OwnerObservation[] = [];
	private scenarioId: string | null = null;
	private lastAgentReply: string | undefined;

	private constructor(args: {
		ffi: ElizaInferenceFfi;
		ctx: ReturnType<ElizaInferenceFfi["create"]>;
		encoder: FusedSpeakerEncoder;
		diarizer: FusedDiarizer;
		kokoroBackend: KokoroTtsBackend;
		apiKey: string | null;
		ownerThreshold: number;
		voiceMap: Record<string, string>;
		artifacts: RealVoiceWorkbenchArtifacts;
	}) {
		this.ffi = args.ffi;
		this.ctx = args.ctx;
		this.encoder = args.encoder;
		this.diarizer = args.diarizer;
		this.kokoroBackend = args.kokoroBackend;
		this.apiKey = args.apiKey;
		this.ownerThreshold = args.ownerThreshold;
		this.voiceMap = args.voiceMap;
		this.artifacts = args.artifacts;
		this.synthesizer = {
			validateScenario: (scenario) =>
				this.validateScenarioVoiceEvidence(scenario),
			synthesize: (input) => this.synthesizeCorpusTurn(input),
		};
		this.services = {
			strictMeasurementCoverage: true,
			prepareScenario: (input) => this.prepareScenario(input),
			observeDiarization: (input) => this.observeDiarization(input),
			observeTurn: (input) => this.observeTurn(input),
		};
	}

	static async create(
		options: RealVoiceWorkbenchOptions,
	): Promise<RealVoiceWorkbenchAdapter> {
		const ffi = loadElizaInferenceFfi(options.fusedLib);
		const ctx = ffi.create(options.bundle);
		try {
			if (!FusedSpeakerEncoder.isSupported(ffi)) {
				throw new Error(
					"[voice:workbench --real] fused library does not support speaker ABI",
				);
			}
			if (!FusedDiarizer.isSupported(ffi)) {
				throw new Error(
					"[voice:workbench --real] fused library does not support diarizer ABI",
				);
			}
			// The workbench transcribes the entire matrix. Keep ASR resident for the
			// run, matching LiveDiarizationSession, instead of reloading the model and
			// audio projector for every scored turn.
			ffi.mmapAcquire(ctx, "asr");
			const encoder = await FusedSpeakerEncoder.load({
				ffi,
				ctx,
				ggufPath: options.speakerGguf,
			});
			const diarizer = await FusedDiarizer.load({
				ffi,
				ctx,
				ggufPath: options.diarizGguf,
			});
			// The agent voice is always the fused Kokoro engine (the product's
			// on-device TTS); keyless mode synthesizes the human turns through it
			// too, so the backend is required in both modes.
			if (typeof ffi.kokoroSupported !== "function" || !ffi.kokoroSupported()) {
				throw new Error(
					"[voice:workbench --real] fused library does not link the Kokoro engine (eliza_inference_kokoro_*)",
				);
			}
			const kokoro = resolveKokoroEngineConfig();
			if (!kokoro) {
				throw new Error(
					"[voice:workbench --real] no Kokoro model staged (set ELIZA_KOKORO_MODEL_DIR to a dir with kokoro-82m-v1_0*.gguf + voices/<voice>.bin)",
				);
			}
			const kokoroBackend = createKokoroTtsBackend(kokoro, { ffi });
			return new RealVoiceWorkbenchAdapter({
				ffi,
				ctx,
				encoder,
				diarizer,
				kokoroBackend,
				apiKey: options.elevenLabsApiKey,
				ownerThreshold:
					options.ownerAcceptThreshold ?? VOICE_WORKBENCH_OWNER_THRESHOLD,
				voiceMap: options.voiceMap ?? {},
				artifacts: {
					bundle: options.bundle,
					fusedLib: options.fusedLib,
					speakerGguf: options.speakerGguf,
					diarizGguf: options.diarizGguf,
				},
			});
		} catch (err) {
			ffi.destroy(ctx);
			ffi.close();
			throw err;
		}
	}

	private async prepareScenario(args: {
		scenario: VoiceScenario;
		corpus: GeneratedVoiceCorpus;
	}): Promise<void> {
		this.scenarioId = args.scenario.id;
		this.lastAgentReply = undefined;
		this.ownerObservations = [];
		this.profiles.clear();
		this.selfVoiceEmbeddings.length = 0;

		// Build speaker profiles from held-out enrollment audio, never from the
		// scored scenario turns. Otherwise the DER gate can match a turn against
		// an embedding extracted from that same turn and false-green.
		for (const participant of args.corpus.groundTruth.participants) {
			// The enrollment sample must come from the SAME voice that speaks the
			// participant's scored turns, so both modes resolve the voice with the
			// same keys the corpus synthesizer uses.
			const voiceId = this.resolveHumanVoiceId(
				participant.ttsVoiceId,
				participant.label,
			);
			const apiKey = this.apiKey;
			const centroid = await buildVoiceWorkbenchEnrollmentCentroid({
				voiceId,
				synthesize: ({ text, voiceId: enrollmentVoiceId }) =>
					apiKey
						? elevenLabsPcm({
								text,
								voiceId: enrollmentVoiceId,
								apiKey,
								sampleRate: SAMPLE_RATE,
							})
						: this.synthesizeKokoro(text, enrollmentVoiceId),
				encode: (pcm) => this.encoder.encode(pcm),
			});
			this.profiles.set(participant.label, {
				label: participant.label,
				entityId: participant.entityId ?? null,
				isOwner: participant.isOwner === true,
				centroid,
			});
		}
	}

	private async observeTurn(
		args: Parameters<VoiceWorkbenchServices["observeTurn"]>[0],
	): Promise<VoiceTurnObservation> {
		if (args.groundTruth.scenarioId !== this.scenarioId) {
			throw new Error(
				`[voice:workbench --real] scenario ${args.groundTruth.scenarioId} was not prepared before observeTurn`,
			);
		}
		const endpointStartedAtMs = performance.now();
		const audio16 = ensureSampleRate(args.audio, args.sampleRate, SAMPLE_RATE);
		const speakerPcm = ensureMinSpeakerSamples(audio16);
		const embedding = await this.encoder.encode(speakerPcm);
		const diarized = await this.diarizer.diarizeWindow(diarizerWindow(audio16));
		const hasSpeech = diarized.segments.some(
			(segment) => segment.endMs > segment.startMs,
		);
		const bestMatch = hasSpeech
			? bestSpeakerMatch(this.profiles.values(), embedding)
			: null;
		const speakerMatch =
			bestMatch && bestMatch.similarity >= this.ownerThreshold
				? bestMatch
				: null;
		const matchedEntityId = speakerMatch?.profile.entityId ?? null;
		if (matchedEntityId && !args.label.isAgentEcho) {
			this.ownerObservations.push({
				entityId: matchedEntityId,
				confidence: Math.max(0, Math.min(1, speakerMatch?.similarity ?? 0)),
			});
		}
		const ownerCandidate = resolveOwnerCandidate(this.ownerObservations);
		const predictedOwner =
			ownerCandidate.ownerEntityId !== null
				? matchedEntityId === ownerCandidate.ownerEntityId
				: speakerMatch?.profile.isOwner === true;

		const streamingResult = args.groundTruth.classes.includes(
			"streaming-partials",
		)
			? await this.transcribeStreaming(audio16)
			: null;
		const transcript = streamingResult
			? streamingResult.transcript
			: await this.transcribe(audio16);
		const eotProbability = scoreEndOfTurnHeuristic(transcript);
		const eotDecided = eotProbability >= EOT_COMMIT_THRESHOLD;
		const selfVoiceSimilarity = this.selfVoiceSimilarity(embedding);
		const signal = buildVoiceTurnSignal(transcript, {
			...(this.lastAgentReply
				? { recentAgentReply: this.lastAgentReply, replyAgeMs: 500 }
				: {}),
			agentSpeaking: args.label.isAgentEcho === true,
			// WeSpeaker-embedding scale: the agent-specific threshold travels with
			// the measurement (self ~0.37 vs human ~0.15 — never the 0.7 MFCC bar).
			...(typeof selfVoiceSimilarity === "number"
				? {
						selfVoiceSimilarity,
						selfVoiceThreshold: AGENT_SELF_VOICE_IMPRINT_THRESHOLD,
					}
				: {}),
			speaker: {
				entityId: matchedEntityId,
				confidence: Math.max(0, Math.min(1, speakerMatch?.similarity ?? 0)),
				isOwner: predictedOwner,
			},
			wakeWordActive: /\bhey\s+eliza\b/i.test(transcript),
			knownSpeakerEntityIds: knownSpeakerIds(args.groundTruth),
		});
		const transcriptionMode =
			args.groundTruth.classes.includes("transcription-mode");
		const responded = !transcriptionMode && signal.nextSpeaker === "agent";
		const inferredEntities: string[] = [];
		const name = extractName(transcript);
		if (name) {
			const participant = args.groundTruth.participants.find(
				(p) => p.label.toLowerCase() === name && p.entityId,
			);
			if (participant?.entityId) inferredEntities.push(participant.entityId);
		}

		let firstAudioMs: number | undefined;
		if (responded) {
			const replyText = args.label.agentReplyText ?? "I heard you.";
			const synthesisStartedAtMs = performance.now();
			firstAudioMs =
				synthesisStartedAtMs -
				endpointStartedAtMs +
				(await this.observeAgentReply(replyText));
			if (args.label.agentReplyText) {
				this.lastAgentReply = args.label.agentReplyText;
			}
		}

		return {
			hypothesisTranscript: transcript,
			predictedSpeakerLabel: speakerMatch?.profile.label ?? null,
			synthesizedVoiceId: args.label.isAgentEcho
				? KOKORO_AGENT_VOICE
				: this.resolveHumanVoiceId(args.label.ttsVoiceId, args.label.speaker),
			speakerSimilarity: bestMatch?.similarity ?? null,
			speakerAcceptThreshold: this.ownerThreshold,
			eotDecided,
			responded,
			inferredEntities,
			matchedEntityId,
			...(firstAudioMs !== undefined ? { firstAudioMs } : {}),
			predictedOwner,
			selfVoiceSimilarity,
			...(streamingResult
				? { partialTranscripts: streamingResult.partials }
				: {}),
		};
	}

	private async observeDiarization(args: {
		audio: Float32Array;
		sampleRate: number;
	}): Promise<VoiceDiarizationObservation[]> {
		return diarizeVoiceWorkbenchStream({
			...args,
			diarizeWindow: (pcm) => this.diarizer.diarizeWindow(pcm),
			encodeSpeaker: (pcm) => this.encoder.encode(pcm),
		});
	}

	private async synthesizeCorpusTurn(args: {
		text: string;
		voiceId?: string;
		speakerLabel: string;
		turnIndex: number;
		isAgentEcho: boolean;
		sampleRate: number;
	}): Promise<Float32Array> {
		if (args.isAgentEcho) {
			return ensureSampleRate(
				await this.synthesizeAgent(args.text),
				SAMPLE_RATE,
				args.sampleRate,
			);
		}
		if (this.apiKey) {
			const voiceId = this.resolveHumanVoiceId(args.voiceId, args.speakerLabel);
			return elevenLabsPcm({
				text: args.text,
				voiceId,
				apiKey: this.apiKey,
				sampleRate: args.sampleRate,
			});
		}
		// Keyless (#9577): distinct fused Kokoro packs stand in for the human
		// voices, resolved deterministically from the same label/voiceId keys.
		const pack = this.resolveHumanVoiceId(args.voiceId, args.speakerLabel);
		const pcm = await this.synthesizeKokoro(args.text, pack);
		return ensureSampleRate(pcm, SAMPLE_RATE, args.sampleRate);
	}

	private resolveHumanVoiceId(
		voiceId: string | undefined,
		speakerLabel: string,
	): string {
		return this.apiKey
			? this.resolveElevenLabsVoiceId(voiceId, speakerLabel)
			: resolveKokoroVoicePack(voiceId, speakerLabel);
	}

	private validateScenarioVoiceEvidence(scenario: VoiceScenario): void {
		const validation = validateScenarioVoiceAssignments(
			scenario,
			(voiceId, speakerLabel) =>
				this.resolveHumanVoiceId(voiceId, speakerLabel),
		);
		if (!validation.valid) {
			throw new Error(
				`[voice:workbench --real] invalid voice evidence for ${scenario.id}: ${validation.errors.join("; ")}`,
			);
		}
	}

	private resolveElevenLabsVoiceId(
		voiceId: string | undefined,
		speakerLabel: string,
	): string {
		return resolveElevenLabsWorkbenchVoiceId(
			voiceId,
			speakerLabel,
			this.voiceMap,
		);
	}

	/**
	 * Synthesize through the fused Kokoro engine and return 16 kHz PCM. Kokoro
	 * emits at its native 24 kHz — resampling here (instead of trusting the
	 * caller's rate label) is what keeps WeSpeaker/pyannote time bases honest.
	 */
	private async synthesizeKokoro(
		text: string,
		voiceId: string,
	): Promise<Float32Array> {
		return (await this.synthesizeKokoroMeasured(text, voiceId)).pcm;
	}

	private async synthesizeKokoroMeasured(
		text: string,
		voiceId: string,
	): Promise<MeasuredSynthesis> {
		const chunks: Float32Array[] = [];
		let sampleRate = 0;
		const startedAtMs = performance.now();
		let firstAudioMs: number | undefined;
		await this.kokoroBackend.synthesizeStream({
			phrase: {
				id: 1,
				text,
				fromIndex: 0,
				toIndex: text.length,
				terminator: "punctuation",
			},
			preset: {
				voiceId,
				embedding: new Float32Array(0),
				bytes: new Uint8Array(0),
			},
			cancelSignal: { cancelled: false },
			onChunk: (c) => {
				if (!c.isFinal && c.pcm.length > 0) {
					firstAudioMs ??= performance.now() - startedAtMs;
					chunks.push(c.pcm);
					sampleRate = c.sampleRate;
				}
				return undefined;
			},
		});
		const total = chunks.reduce((n, c) => n + c.length, 0);
		if (total === 0 || sampleRate === 0 || firstAudioMs === undefined) {
			throw new Error(
				`[voice:workbench --real] Kokoro produced no audio for "${text}" [${voiceId}]`,
			);
		}
		const pcm = new Float32Array(total);
		let off = 0;
		for (const c of chunks) {
			pcm.set(c, off);
			off += c.length;
		}
		const capped = Math.min(pcm.length, sampleRate * MAX_AGENT_TTS_SECONDS);
		return {
			pcm: resampleLinear(pcm.subarray(0, capped), sampleRate, SAMPLE_RATE),
			firstAudioMs,
		};
	}

	private async synthesizeAgent(text: string): Promise<Float32Array> {
		return this.synthesizeKokoro(text, KOKORO_AGENT_VOICE);
	}

	private async observeAgentReply(text: string): Promise<number> {
		const synthesis = await this.synthesizeKokoroMeasured(
			text,
			KOKORO_AGENT_VOICE,
		);
		this.selfVoiceEmbeddings.push(
			await this.encoder.encode(ensureMinSpeakerSamples(synthesis.pcm)),
		);
		while (this.selfVoiceEmbeddings.length > 8) {
			this.selfVoiceEmbeddings.shift();
		}
		return synthesis.firstAudioMs;
	}

	private selfVoiceSimilarity(embedding: Float32Array): number | null {
		if (this.selfVoiceEmbeddings.length === 0) return null;
		return cosineSimilarity(
			embedding,
			averageEmbeddings(this.selfVoiceEmbeddings),
		);
	}

	private async transcribe(pcm: Float32Array): Promise<string> {
		if (this.ffi.timedAsrSupported?.()) {
			return this.ffi
				.asrTranscribeTimed({ ctx: this.ctx, pcm, sampleRateHz: SAMPLE_RATE })
				.text.trim();
		}
		return this.ffi
			.asrTranscribe({ ctx: this.ctx, pcm, sampleRateHz: SAMPLE_RATE })
			.trim();
	}

	private async transcribeStreaming(
		pcm: Float32Array,
	): Promise<{ transcript: string; partials: string[] }> {
		return transcribeVoiceWorkbenchStream({
			ffi: this.ffi,
			ctx: this.ctx,
			pcm,
		});
	}

	async dispose(): Promise<void> {
		try {
			this.kokoroBackend.dispose();
		} finally {
			try {
				await this.encoder.dispose();
			} finally {
				try {
					await this.diarizer.dispose();
				} finally {
					try {
						this.ffi.mmapEvict(this.ctx, "asr");
					} finally {
						this.ffi.destroy(this.ctx);
						this.ffi.close();
					}
				}
			}
		}
	}
}

export async function createRealVoiceWorkbenchRuntimeFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): Promise<RealVoiceWorkbenchRuntime> {
	const bundle = requirePath(
		"ELIZA_ASR_BUNDLE",
		nonEmpty(env.ELIZA_ASR_BUNDLE) ??
			nonEmpty(env.ELIZA_VOICE_REAL_MODEL_DIR) ??
			path.join(
				os.homedir(),
				".eliza/local-inference/models/eliza-1-2b.bundle",
			),
	);
	const fusedLib = requirePath(
		"libelizainference",
		resolveFusedLibraryPath(bundle, env),
	);
	const speakerGguf = requirePath(
		"speaker GGUF",
		firstExisting(
			nonEmpty(env.ELIZA_SPEAKER_GGUF),
			path.join(bundle, "speaker", "wespeaker-resnet34-lm.gguf"),
			path.join(bundle, "speaker-encoder", "wespeaker-resnet34-lm.gguf"),
			path.join(bundle, "voice/speaker-encoder/wespeaker-resnet34-lm.gguf"),
		),
	);
	const diarizGguf = requirePath(
		"diarizer GGUF",
		firstExisting(
			nonEmpty(env.ELIZA_DIARIZ_GGUF),
			// epoch-2 IFGO bake first (#11377) — the IFGO fused reader rejects
			// the legacy epoch-less IOFC artifact below.
			path.join(bundle, "diariz", "pyannote-segmentation-3.0-ifgo-epoch2.gguf"),
			path.join(
				bundle,
				"diarizer",
				"pyannote-segmentation-3.0-ifgo-epoch2.gguf",
			),
			path.join(
				bundle,
				"voice/diarizer/pyannote-segmentation-3.0-ifgo-epoch2.gguf",
			),
			path.join(bundle, "diariz", "pyannote-segmentation-3.0.gguf"),
			path.join(bundle, "diarizer", "pyannote-segmentation-3.0.gguf"),
			path.join(bundle, "voice/diarizer/pyannote-segmentation-3.0.gguf"),
		),
	);
	// Keyless by design (#9577): without the key the human turns come from
	// distinct fused Kokoro packs; the key upgrades them to real ElevenLabs
	// voices. The agent turns are the fused Kokoro engine either way.
	const apiKey = nonEmpty(env.ELEVENLABS_API_KEY) ?? null;

	return RealVoiceWorkbenchAdapter.create({
		bundle,
		fusedLib,
		speakerGguf,
		diarizGguf,
		elevenLabsApiKey: apiKey,
		ownerAcceptThreshold: finiteNumberEnv(
			env,
			"ELIZA_VOICE_OWNER_ACCEPT_THRESHOLD",
			VOICE_WORKBENCH_OWNER_THRESHOLD,
		),
		voiceMap: parseVoiceMap(env.ELIZA_WORKBENCH_ELEVENLABS_VOICE_MAP),
	});
}

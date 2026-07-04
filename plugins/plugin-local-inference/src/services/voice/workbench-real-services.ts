/**
 * Voice Workbench real services adapter (#9147).
 *
 * `voice:workbench --real` must not be an all-skipped honesty stub: the
 * provisioned lane has a fused libelizainference build, ASR/TTS regions,
 * WeSpeaker, pyannote, and ElevenLabs-generated human speech. This adapter
 * drives those real pieces through the existing workbench runner/scorers.
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
import type {
	CorpusGroundTruth,
	CorpusTtsSynthesizer,
	GeneratedVoiceCorpus,
} from "./corpus-generator";
import { type ElizaInferenceFfi, loadElizaInferenceFfi } from "./ffi-bindings";
import { FusedDiarizer } from "./speaker/diarizer-fused";
import { averageEmbeddings } from "./speaker/encoder";
import { FusedSpeakerEncoder } from "./speaker/encoder-fused";
import { SPEAKER_GGML_MIN_SAMPLES } from "./speaker/encoder-ggml";
import { cosineSimilarity } from "./speaker-imprint";
import { resampleLinear } from "./transcriber";
import type { VoiceScenario } from "./voice-scenario";
import type {
	VoiceTurnObservation,
	VoiceWorkbenchServices,
} from "./workbench-headless-runner";

const SAMPLE_RATE = 16_000;
const EOT_COMMIT_THRESHOLD = 0.5;
const DEFAULT_OWNER_THRESHOLD = 0.78;
const MAX_AGENT_TTS_SECONDS = 12;
const SPEAKER_ENROLLMENT_PHRASE =
	"This is my voice enrollment sample for reliable speaker recognition.";

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
	owner: "21m00Tcm4TlvDq8ikWAM",
	alice: "21m00Tcm4TlvDq8ikWAM",
	jill: "21m00Tcm4TlvDq8ikWAM",
	bob: "pNInz6obpgDQGcFmaJgB",
	guest: "pNInz6obpgDQGcFmaJgB",
	intruder: "pNInz6obpgDQGcFmaJgB",
	marcus: "ErXwobaYiN019PkySvjV",
	priya: "EXAVITQu4vr4xnSDxMaL",
	eliza: "MF3mGyEYCl7XYWbV9V6O",
	aria: "TxGEqnHWrfWFTfGW9XjX",
};

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

export interface RealVoiceWorkbenchRuntime {
	services: VoiceWorkbenchServices;
	synthesizer: CorpusTtsSynthesizer;
	dispose(): Promise<void>;
}

interface RealVoiceWorkbenchOptions {
	bundle: string;
	fusedLib: string;
	speakerGguf: string;
	diarizGguf: string;
	elevenLabsApiKey: string;
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

function labelHash(label: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < label.length; i += 1) {
		h ^= label.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
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

function diarizerWindow(pcm: Float32Array): Float32Array {
	const targetSamples = SAMPLE_RATE * 5;
	if (pcm.length === targetSamples) return pcm;
	if (pcm.length > targetSamples) return pcm.subarray(0, targetSamples);
	const out = new Float32Array(targetSamples);
	out.set(pcm);
	return out;
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

	private readonly ffi: ElizaInferenceFfi;
	private readonly ctx: ReturnType<ElizaInferenceFfi["create"]>;
	private readonly encoder: FusedSpeakerEncoder;
	private readonly diarizer: FusedDiarizer;
	private readonly apiKey: string;
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
		apiKey: string;
		ownerThreshold: number;
		voiceMap: Record<string, string>;
	}) {
		this.ffi = args.ffi;
		this.ctx = args.ctx;
		this.encoder = args.encoder;
		this.diarizer = args.diarizer;
		this.apiKey = args.apiKey;
		this.ownerThreshold = args.ownerThreshold;
		this.voiceMap = args.voiceMap;
		this.synthesizer = {
			synthesize: (input) => this.synthesizeCorpusTurn(input),
		};
		this.services = {
			prepareScenario: (input) => this.prepareScenario(input),
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
			return new RealVoiceWorkbenchAdapter({
				ffi,
				ctx,
				encoder,
				diarizer,
				apiKey: options.elevenLabsApiKey,
				ownerThreshold: options.ownerAcceptThreshold ?? DEFAULT_OWNER_THRESHOLD,
				voiceMap: options.voiceMap ?? {},
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
			const enrollment = await elevenLabsPcm({
				text: SPEAKER_ENROLLMENT_PHRASE,
				voiceId: this.resolveElevenLabsVoiceId(
					participant.ttsVoiceId,
					participant.label,
				),
				apiKey: this.apiKey,
				sampleRate: SAMPLE_RATE,
			});
			const embedding = await this.encoder.encode(
				ensureMinSpeakerSamples(enrollment),
			);
			this.profiles.set(participant.label, {
				label: participant.label,
				entityId: participant.entityId ?? null,
				isOwner: participant.isOwner === true,
				centroid: embedding,
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

		const transcript = await this.transcribe(audio16);
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

		if (responded && args.label.agentReplyText) {
			this.lastAgentReply = args.label.agentReplyText;
			await this.observeAgentReply(args.label.agentReplyText);
		}

		return {
			hypothesisTranscript: transcript,
			predictedSpeakerLabel: speakerMatch?.profile.label ?? null,
			eotDecided,
			responded,
			inferredEntities,
			matchedEntityId,
			predictedOwner,
		};
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
				this.synthesizeAgent(args.text),
				SAMPLE_RATE,
				args.sampleRate,
			);
		}
		const voiceId = this.resolveElevenLabsVoiceId(
			args.voiceId,
			args.speakerLabel,
		);
		return elevenLabsPcm({
			text: args.text,
			voiceId,
			apiKey: this.apiKey,
			sampleRate: args.sampleRate,
		});
	}

	private resolveElevenLabsVoiceId(
		voiceId: string | undefined,
		speakerLabel: string,
	): string {
		const keys = [voiceId, speakerLabel].filter(
			(value): value is string => typeof value === "string" && value.length > 0,
		);
		for (const key of keys) {
			const mapped =
				this.voiceMap[key.toLowerCase()] ?? VOICE_ID_ALIASES[key.toLowerCase()];
			if (mapped) return mapped;
		}
		return ELEVENLABS_VOICE_IDS[
			labelHash(speakerLabel) % ELEVENLABS_VOICE_IDS.length
		];
	}

	private synthesizeAgent(text: string): Float32Array {
		this.ffi.mmapAcquire(this.ctx, "tts");
		try {
			const out = new Float32Array(SAMPLE_RATE * MAX_AGENT_TTS_SECONDS);
			const samples = this.ffi.ttsSynthesize({
				ctx: this.ctx,
				text,
				speakerPresetId: null,
				out,
			});
			if (!Number.isFinite(samples) || samples <= 0) {
				throw new Error(
					`[voice:workbench --real] agent TTS produced ${samples} samples`,
				);
			}
			return out.slice(0, samples);
		} finally {
			this.ffi.mmapEvict(this.ctx, "tts");
		}
	}

	private async observeAgentReply(text: string): Promise<void> {
		const pcm = this.synthesizeAgent(text);
		this.selfVoiceEmbeddings.push(
			await this.encoder.encode(ensureMinSpeakerSamples(pcm)),
		);
		while (this.selfVoiceEmbeddings.length > 8) {
			this.selfVoiceEmbeddings.shift();
		}
	}

	private selfVoiceSimilarity(embedding: Float32Array): number | null {
		if (this.selfVoiceEmbeddings.length === 0) return null;
		return cosineSimilarity(
			embedding,
			averageEmbeddings(this.selfVoiceEmbeddings),
		);
	}

	private async transcribe(pcm: Float32Array): Promise<string> {
		this.ffi.mmapAcquire(this.ctx, "asr");
		try {
			if (this.ffi.timedAsrSupported?.()) {
				return this.ffi
					.asrTranscribeTimed({ ctx: this.ctx, pcm, sampleRateHz: SAMPLE_RATE })
					.text.trim();
			}
			return this.ffi
				.asrTranscribe({ ctx: this.ctx, pcm, sampleRateHz: SAMPLE_RATE })
				.trim();
		} finally {
			this.ffi.mmapEvict(this.ctx, "asr");
		}
	}

	async dispose(): Promise<void> {
		try {
			await this.encoder.dispose();
		} finally {
			try {
				await this.diarizer.dispose();
			} finally {
				this.ffi.destroy(this.ctx);
				this.ffi.close();
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
	const apiKey = nonEmpty(env.ELEVENLABS_API_KEY);
	if (!apiKey) {
		throw new Error("[voice:workbench --real] ELEVENLABS_API_KEY is required");
	}

	return RealVoiceWorkbenchAdapter.create({
		bundle,
		fusedLib,
		speakerGguf,
		diarizGguf,
		elevenLabsApiKey: apiKey,
		ownerAcceptThreshold: finiteNumberEnv(
			env,
			"ELIZA_VOICE_OWNER_ACCEPT_THRESHOLD",
			DEFAULT_OWNER_THRESHOLD,
		),
		voiceMap: parseVoiceMap(env.ELIZA_WORKBENCH_ELEVENLABS_VOICE_MAP),
	});
}

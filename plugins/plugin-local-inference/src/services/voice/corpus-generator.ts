/**
 * Voice Workbench corpus generator (#8785).
 *
 * Turns a declarative {@link VoiceScenario} into one labeled audio stream + a
 * ground-truth JSON the headless runner scores against. Two synthesis paths,
 * one shape:
 *
 *   - Synthetic (default, deterministic, NO native model): formant-resonator
 *     speech-like PCM (`__test-helpers__/synthetic-speech.ts`) the Silero VAD
 *     reads as speech. Reproducible in CI with no artifacts — it exercises the
 *     pipeline plumbing + the scorers/labels, not diarization/WER *accuracy*.
 *   - Real TTS (gated): an injected {@link CorpusTtsSynthesizer} (Kokoro /
 *     OmniVoice via the TTS route) produces natural speech. Real diarization
 *     DER and transcription WER benchmarking need this path.
 *
 * `generateVoiceCorpus` is pure (no I/O) so it is unit-testable without disk;
 * `writeVoiceCorpus` / `readVoiceCorpus` handle the versioned on-disk corpus.
 * A turn's labels (speaker, transcript, respond decision, entity) come straight
 * from the scenario, so the ground truth is reproducible regardless of path.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
	AGENT_VOICE_TIMBRE,
	makeSpeechWithSilenceFixture,
	type SpeakerTimbre,
	speakerTimbreForIndex,
} from "./__test-helpers__/synthetic-speech";
import {
	type AugmentationSpec,
	augmentPcm,
	specIsClean,
} from "./corpus-augment";
import {
	resolveTurnEnvironment,
	turnReferenceTranscript,
	turnSpeakerLabel,
	type VoiceEnvironment,
	type VoiceScenario,
	validateVoiceScenario,
} from "./voice-scenario";
import { encodeMonoPcm16Wav } from "./wav-codec";

const DEFAULT_SAMPLE_RATE = 16_000;
/** Natural speaking rate used to size synthetic speech from text length. */
const DEFAULT_CHARS_PER_SECOND = 13;
const DEFAULT_INTER_TURN_SILENCE_SEC = 0.4;
const MIN_SPEECH_SEC = 0.4;
/** Cap a single synthetic turn (long-form monologue still lands well under). */
const MAX_SPEECH_SEC = 45;
const SYNTHETIC_LEAD_SILENCE_SEC = 0.15;
const SYNTHETIC_TAIL_SILENCE_SEC = 0.15;

/** Per-turn ground-truth label with sample-accurate timing. */
export interface CorpusTurnLabel {
	index: number;
	/** Diarization ground-truth label (the participant who spoke). */
	speaker: string;
	/** Resolved elizaOS entity id for the speaker, when the scenario binds one. */
	entityId?: string;
	/** First sample of voiced speech in this turn (after any lead silence). */
	speechStartSample: number;
	/** Sample just past the voiced speech (before trailing pauses). */
	speechEndSample: number;
	/** First sample of this turn's whole segment in the stream. */
	segmentStartSample: number;
	/** Sample just past this turn's whole segment (incl. trailing pauses). */
	segmentEndSample: number;
	/** Reference transcript for WER scoring. */
	referenceTranscript: string;
	/** Ground truth: should the agent respond to this turn? */
	expectRespond: boolean;
	/** Ground truth: is this segment a real end-of-turn boundary? */
	expectEndOfTurn?: boolean;
	/** Expected inferred/recognized entity, when the scenario asserts one. */
	expectedEntity?: string;
	/** TTS voice id used for this turn (real-TTS path), when set. */
	ttsVoiceId?: string;
	/** True when this turn was formant-synthesized rather than real TTS. */
	synthetic: boolean;
	/** Acoustic degradation applied to this turn's audio (when any). */
	environment?: VoiceEnvironment;
	/** True when this "turn" is the agent's own TTS echoed back (not a user turn). */
	isAgentEcho?: boolean;
	/** Ground truth: the speaker is the device owner / primary enrolled voice. */
	isOwner?: boolean;
	/** The agent's spoken reply to this turn (drives the echo gate downstream). */
	agentReplyText?: string;
	/** True when this turn arrives while the agent is mid-TTS (a barge-in). */
	bargeIn?: boolean;
	/** Ground truth: a {@link bargeIn} turn that MUST hard-stop the agent's TTS. */
	expectBargeInCancel?: boolean;
}

/**
 * On-disk corpus ground-truth schema version. Bump when the labeled-corpus
 * shape changes incompatibly; `readVoiceCorpusGroundTruth` treats a corpus
 * written by a different version as absent (→ `skipped`, never a stale `pass`).
 */
export const CORPUS_SCHEMA_VERSION = 1;

export interface CorpusGroundTruth {
	/** Labeled-corpus schema version (see {@link CORPUS_SCHEMA_VERSION}). */
	schemaVersion: number;
	scenarioId: string;
	classes: VoiceScenario["classes"];
	sampleRate: number;
	totalSamples: number;
	durationSec: number;
	participants: Array<{
		label: string;
		entityId?: string;
		isOwner?: boolean;
		ttsVoiceId?: string;
	}>;
	agents?: string[];
	/** Entity ids the agent answers without a wake word (owner + enrolled). */
	knownSpeakerEntityIds?: string[];
	turns: CorpusTurnLabel[];
	/** True when EVERY turn was synthetic (no real TTS used anywhere). */
	synthetic: boolean;
}

export interface GeneratedVoiceCorpus {
	pcm: Float32Array;
	sampleRate: number;
	groundTruth: CorpusGroundTruth;
}

/**
 * Real-TTS synthesizer. Gated: when omitted, the generator uses deterministic
 * synthetic speech. An implementation wraps the TTS route / Kokoro engine and
 * returns mono PCM at the requested sample rate.
 */
export interface CorpusTtsSynthesizer {
	synthesize(args: {
		text: string;
		voiceId?: string;
		speakerLabel: string;
		turnIndex: number;
		isAgentEcho: boolean;
		sampleRate: number;
	}): Promise<Float32Array>;
}

export interface GenerateVoiceCorpusOptions {
	sampleRate?: number;
	/** Inject a real-TTS synthesizer to produce natural speech (else synthetic). */
	synthesizer?: CorpusTtsSynthesizer;
	/** Silence (s) spliced after a turn that declares no explicit pauses. */
	interTurnSilenceSec?: number;
	/** Synthetic-speech sizing: characters of text per second of audio. */
	charsPerSecond?: number;
}

/** Deterministic 32-bit FNV-1a of a label → a stable per-speaker synthesis seed. */
function labelSeed(label: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < label.length; i++) {
		h ^= label.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

function silenceSamples(ms: number, sampleRate: number): number {
	return Math.max(0, Math.round((ms / 1000) * sampleRate));
}

/**
 * A continuous competing-talker stream for `backgroundTalkersDb`, built from
 * formant-synth speech (no models) so it is deterministic. `augmentPcm` mixes +
 * loops it under the real turn at the requested level.
 */
function synthesizeBabble(
	sampleRate: number,
	lengthSamples: number,
	seed: number,
): Float32Array {
	const fixture = makeSpeechWithSilenceFixture({
		sampleRate,
		leadSilenceSec: 0,
		speechSec: Math.max(0.3, lengthSamples / sampleRate),
		tailSilenceSec: 0,
		seed,
	});
	return fixture.pcm;
}

/**
 * Generate one labeled audio stream for a scenario. Throws on an invalid
 * scenario (fail loud — a malformed corpus must not silently produce garbage).
 * A turn that carries only `audioRef` (no `text`) is not synthesizable here and
 * is rejected; pre-rendered audio is supplied through the corpus on disk.
 */
export async function generateVoiceCorpus(
	scenario: VoiceScenario,
	options: GenerateVoiceCorpusOptions = {},
): Promise<GeneratedVoiceCorpus> {
	const validation = validateVoiceScenario(scenario);
	if (!validation.valid) {
		throw new Error(
			`[voice-corpus] invalid scenario "${scenario.id}": ${validation.errors.join("; ")}`,
		);
	}

	const sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
	const charsPerSecond = options.charsPerSecond ?? DEFAULT_CHARS_PER_SECOND;
	const interTurnSilence = silenceSamples(
		(options.interTurnSilenceSec ?? DEFAULT_INTER_TURN_SILENCE_SEC) * 1000,
		sampleRate,
	);
	const synthesizer = options.synthesizer;

	const participantByLabel = new Map(
		scenario.participants.map((p) => [p.label, p]),
	);
	// Each participant gets a distinct voice colour, spread evenly across the
	// timbre range so a blind acoustic diarizer can tell co-present speakers apart
	// from the audio alone (#9427).
	const timbreByLabel = new Map<string, SpeakerTimbre>(
		scenario.participants.map((p, i) => [
			p.label,
			speakerTimbreForIndex(i, scenario.participants.length),
		]),
	);

	const segments: Float32Array[] = [];
	const labels: CorpusTurnLabel[] = [];
	let cursor = 0;
	let anyReal = false;

	for (let i = 0; i < scenario.turns.length; i++) {
		const turn = scenario.turns[i];
		const text = turn.text?.trim();
		if (!text) {
			throw new Error(
				`[voice-corpus] turn[${i}] of "${scenario.id}" has no text to synthesize (audioRef-only turns are supplied via the on-disk corpus, not generated)`,
			);
		}
		const participant = participantByLabel.get(turn.speaker);
		const ttsVoiceId = turn.ttsVoiceId ?? participant?.ttsVoiceId;

		const segmentStartSample = cursor;
		let speech: Float32Array;
		let speechStartOffset: number;
		let speechEndOffset: number;
		let synthetic: boolean;

		if (synthesizer) {
			speech = await synthesizer.synthesize({
				text,
				voiceId: ttsVoiceId,
				speakerLabel: turn.speaker,
				turnIndex: i,
				isAgentEcho: turn.isAgentEcho === true,
				sampleRate,
			});
			speechStartOffset = 0;
			speechEndOffset = speech.length;
			synthetic = false;
			anyReal = true;
		} else {
			const speechSec = Math.min(
				MAX_SPEECH_SEC,
				Math.max(MIN_SPEECH_SEC, text.length / charsPerSecond),
			);
			// An agent-echo turn is the agent's OWN TTS bleeding back through the
			// mic, so it carries the agent's voice — not the labelled speaker's. Real
			// speaker turns get their distinct per-speaker timbre (#9427).
			const timbre = turn.isAgentEcho
				? AGENT_VOICE_TIMBRE
				: (timbreByLabel.get(turn.speaker) ?? AGENT_VOICE_TIMBRE);
			const fixture = makeSpeechWithSilenceFixture({
				sampleRate,
				leadSilenceSec: SYNTHETIC_LEAD_SILENCE_SEC,
				speechSec,
				tailSilenceSec: SYNTHETIC_TAIL_SILENCE_SEC,
				seed: labelSeed(turn.isAgentEcho ? "__agent__" : turn.speaker),
				timbre,
			});
			speech = fixture.pcm;
			speechStartOffset = fixture.speechStartSample;
			speechEndOffset = fixture.speechEndSample;
			synthetic = true;
		}

		// Trailing pauses: explicit per-turn gaps, else the default inter-turn gap
		// (except after the final turn).
		const pauseTotal =
			turn.pausesMs && turn.pausesMs.length > 0
				? turn.pausesMs.reduce((n, ms) => n + silenceSamples(ms, sampleRate), 0)
				: i < scenario.turns.length - 1
					? interTurnSilence
					: 0;

		// Assemble the turn's full segment (voiced speech + trailing pause) so the
		// per-turn acoustic degradation — reverb ringing into the gap, a noise
		// floor in the "silence" — covers the pause, not just the speech.
		let segment: Float32Array = new Float32Array(speech.length + pauseTotal);
		segment.set(speech, 0);

		const env = resolveTurnEnvironment(scenario, turn);
		let appliedEnv: VoiceEnvironment | undefined;
		if (env && !specIsClean(env)) {
			const seed =
				env.seed ?? (labelSeed(scenario.id) ^ (i * 0x9e3779b1)) >>> 0;
			const resolvedEnv: AugmentationSpec = { ...env, seed };
			const babble =
				resolvedEnv.backgroundTalkersDb !== undefined
					? synthesizeBabble(sampleRate, segment.length, (seed ^ 0x1234) >>> 0)
					: undefined;
			segment = augmentPcm(segment, sampleRate, resolvedEnv, {
				...(babble ? { babble } : {}),
			});
			appliedEnv = resolvedEnv;
		}

		segments.push(segment);
		cursor += segment.length;

		labels.push({
			index: i,
			speaker: turnSpeakerLabel(turn),
			...(participant?.entityId ? { entityId: participant.entityId } : {}),
			speechStartSample: segmentStartSample + speechStartOffset,
			speechEndSample: segmentStartSample + speechEndOffset,
			segmentStartSample,
			segmentEndSample: cursor,
			referenceTranscript: turnReferenceTranscript(turn),
			expectRespond: turn.isAgentEcho ? false : turn.expectRespond,
			expectEndOfTurn: turn.expectEndOfTurn ?? true,
			...(turn.expectedEntity ? { expectedEntity: turn.expectedEntity } : {}),
			...(ttsVoiceId ? { ttsVoiceId } : {}),
			synthetic,
			...(appliedEnv ? { environment: appliedEnv } : {}),
			...(turn.isAgentEcho ? { isAgentEcho: true } : {}),
			...(participant?.isOwner ? { isOwner: true } : {}),
			...(turn.agentReplyText ? { agentReplyText: turn.agentReplyText } : {}),
			...(turn.bargeIn ? { bargeIn: true } : {}),
			...(turn.expectBargeInCancel !== undefined
				? { expectBargeInCancel: turn.expectBargeInCancel }
				: {}),
		});
	}

	const pcm = new Float32Array(cursor);
	let offset = 0;
	for (const segment of segments) {
		pcm.set(segment, offset);
		offset += segment.length;
	}

	const groundTruth: CorpusGroundTruth = {
		schemaVersion: CORPUS_SCHEMA_VERSION,
		scenarioId: scenario.id,
		classes: scenario.classes,
		sampleRate,
		totalSamples: pcm.length,
		durationSec: pcm.length / sampleRate,
		participants: scenario.participants.map((p) => ({
			label: p.label,
			...(p.entityId ? { entityId: p.entityId } : {}),
			...(p.isOwner ? { isOwner: p.isOwner } : {}),
			...(p.ttsVoiceId ? { ttsVoiceId: p.ttsVoiceId } : {}),
		})),
		...(scenario.agents ? { agents: scenario.agents } : {}),
		...(scenario.knownSpeakerEntityIds
			? { knownSpeakerEntityIds: scenario.knownSpeakerEntityIds }
			: {}),
		turns: labels,
		synthetic: !anyReal,
	};

	return { pcm, sampleRate, groundTruth };
}

export interface VoiceCorpusPaths {
	dir: string;
	audioPath: string;
	groundTruthPath: string;
}

/** Persist a generated corpus as `audio.wav` + `ground-truth.json` under `dir`. */
export function writeVoiceCorpus(
	corpus: GeneratedVoiceCorpus,
	dir: string,
): VoiceCorpusPaths {
	mkdirSync(dir, { recursive: true });
	const audioPath = path.join(dir, "audio.wav");
	const groundTruthPath = path.join(dir, "ground-truth.json");
	writeFileSync(audioPath, encodeMonoPcm16Wav(corpus.pcm, corpus.sampleRate));
	writeFileSync(
		groundTruthPath,
		`${JSON.stringify(corpus.groundTruth, null, 2)}\n`,
	);
	return { dir, audioPath, groundTruthPath };
}

/**
 * Read a previously-written corpus's ground truth. Returns null when the corpus
 * directory or its ground-truth file is absent (the honesty contract — the
 * runner reports `skipped`, never `pass`, when corpus artifacts are missing).
 */
export function readVoiceCorpusGroundTruth(
	dir: string,
): CorpusGroundTruth | null {
	const groundTruthPath = path.join(dir, "ground-truth.json");
	if (!existsSync(groundTruthPath)) return null;
	const parsed = JSON.parse(readFileSync(groundTruthPath, "utf8")) as unknown;
	if (!parsed || typeof parsed !== "object") return null;
	// Honesty contract: a corpus written by an incompatible schema version is
	// treated as absent (→ skipped, never a stale pass against drifted labels).
	if (
		(parsed as { schemaVersion?: unknown }).schemaVersion !==
		CORPUS_SCHEMA_VERSION
	)
		return null;
	return parsed as CorpusGroundTruth;
}

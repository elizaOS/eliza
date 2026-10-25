/**
 * Meeting-grade acoustic stress matrix (#12492).
 *
 * Produces deterministic Voice Workbench scenarios plus manifest metadata for
 * source-backed real lanes. The built-in scenarios use synthetic voices for
 * smoke generation; real evidence can swap the source manifests for licensed
 * MUSAN/DNS/WHAM/LibriMix/RIR assets without changing scenario ids.
 */

import type { AugmentationSpec, NoiseKind } from "./corpus-augment";
import type { VoiceScenario, VoiceScenarioTurn } from "./voice-scenario";

export const MEETING_STRESS_SNRS_DB = [-5, 0, 5, 10, 20] as const;
export const MEETING_STRESS_BACKGROUNDS = [
	"music",
	"office_cafe",
	"keyboard",
	"fan_hvac",
	"babble",
	"tv_podcast_speech",
	"outdoor_noise",
] as const;
export const MEETING_STRESS_ROOMS = [
	"close_mic",
	"far_field",
	"reverb",
	"room_mic_multi_speaker",
] as const;
export const MEETING_STRESS_QUALITIES = [
	"clean",
	"clipping",
	"telephone_bandlimit",
	"compression_artifacts",
	"packet_loss_dropouts",
] as const;
export const MEETING_STRESS_SPEECH_STRUCTURES = [
	"interruption",
	"overlap",
	"cross_talk",
	"side_conversation",
	"whisper_low_volume",
	"accented_non_native",
	"multilingual_turn",
] as const;
export const MEETING_STRESS_SPEAKER_COUNTS = [1, 2, 3, 5, 8] as const;
export const MEETING_STRESS_NEGATIVE_BEHAVIORS = [
	"unknown",
	"do_not_respond",
	"needs_speaker_correction",
] as const;

export type MeetingStressBackground =
	(typeof MEETING_STRESS_BACKGROUNDS)[number];
export type MeetingStressRoom = (typeof MEETING_STRESS_ROOMS)[number];
export type MeetingStressQuality = (typeof MEETING_STRESS_QUALITIES)[number];
export type MeetingStressSpeechStructure =
	(typeof MEETING_STRESS_SPEECH_STRUCTURES)[number];
export type MeetingStressNegativeBehavior =
	(typeof MEETING_STRESS_NEGATIVE_BEHAVIORS)[number];

export interface MeetingAcousticStressSourceManifest {
	id: string;
	source: string;
	license: string;
	mode: "synthetic_smoke" | "real_evidence";
	covers: string[];
}

export interface MeetingAcousticStressCase {
	id: string;
	snrDb: (typeof MEETING_STRESS_SNRS_DB)[number];
	background: MeetingStressBackground;
	room: MeetingStressRoom;
	quality: MeetingStressQuality;
	speechStructure: MeetingStressSpeechStructure;
	speakerCount: (typeof MEETING_STRESS_SPEAKER_COUNTS)[number];
	expectedBehavior: MeetingStressNegativeBehavior | "respond";
	seed: number;
	sourceManifestIds: string[];
	scenario: VoiceScenario;
}

export interface MeetingAcousticStressMatrix {
	schemaVersion: 1;
	seed: number;
	requirements: {
		snrsDb: readonly number[];
		backgrounds: readonly MeetingStressBackground[];
		rooms: readonly MeetingStressRoom[];
		qualities: readonly MeetingStressQuality[];
		speechStructures: readonly MeetingStressSpeechStructure[];
		speakerCounts: readonly number[];
		negativeBehaviors: readonly MeetingStressNegativeBehavior[];
	};
	sourceManifests: MeetingAcousticStressSourceManifest[];
	cases: MeetingAcousticStressCase[];
}

const BACKGROUND_SOURCE: Record<MeetingStressBackground, string> = {
	music: "musan",
	office_cafe: "dns_challenge",
	keyboard: "dns_challenge",
	fan_hvac: "dns_challenge",
	babble: "librimix",
	tv_podcast_speech: "musan",
	outdoor_noise: "whamr",
};

export const MEETING_ACOUSTIC_STRESS_SOURCE_MANIFESTS: MeetingAcousticStressSourceManifest[] =
	[
		{
			id: "synthetic_smoke",
			source: "in-repo synthetic formant voices",
			license: "repo-test-fixture",
			mode: "synthetic_smoke",
			covers: ["all smoke lanes", "manual listenability checks"],
		},
		{
			id: "musan",
			source: "MUSAN music/noise/speech beds",
			license: "dataset-specific",
			mode: "real_evidence",
			covers: ["music", "tv_podcast_speech", "noise"],
		},
		{
			id: "dns_challenge",
			source: "DNS Challenge noise subsets",
			license: "dataset-specific",
			mode: "real_evidence",
			covers: ["office_cafe", "fan_hvac", "keyboard"],
		},
		{
			id: "whamr",
			source: "WHAM!/WHAMR! ambient noise and reverberation",
			license: "dataset-specific",
			mode: "real_evidence",
			covers: ["outdoor_noise", "reverb", "room impulse response"],
		},
		{
			id: "librimix",
			source: "LibriMix/Libri3Mix overlap recipes",
			license: "dataset-specific",
			mode: "real_evidence",
			covers: ["babble", "overlap", "multi-speaker single stream"],
		},
	];

function backgroundEnvironment(
	background: MeetingStressBackground,
	snrDb: number,
	seed: number,
): AugmentationSpec {
	const noiseKindByBackground: Record<MeetingStressBackground, NoiseKind> = {
		music: "music",
		office_cafe: "pink",
		keyboard: "white",
		fan_hvac: "pink",
		babble: "pink",
		tv_podcast_speech: "pink",
		outdoor_noise: "white",
	};
	return {
		noiseSnrDb: snrDb,
		noiseKind: noiseKindByBackground[background],
		seed,
		...(background === "babble" || background === "tv_podcast_speech"
			? { backgroundTalkersDb: Math.max(3, 20 - snrDb) }
			: {}),
	};
}

function roomEnvironment(room: MeetingStressRoom): AugmentationSpec {
	if (room === "far_field") return { farFieldDb: 14 };
	if (room === "reverb") return { reverb: 0.76, reverbWet: 0.62 };
	if (room === "room_mic_multi_speaker") {
		return { reverb: 0.55, reverbWet: 0.45, backgroundTalkersDb: 8 };
	}
	return {};
}

function qualityEnvironment(quality: MeetingStressQuality): AugmentationSpec {
	if (quality === "clipping") return { clipThreshold: 0.56 };
	if (quality === "telephone_bandlimit") return { lowQuality: true };
	if (quality === "compression_artifacts") {
		return { compressionArtifacts: 0.7 };
	}
	if (quality === "packet_loss_dropouts") {
		return { dropoutProbability: 0.16, dropoutMs: 45 };
	}
	return {};
}

function mergeEnvironment(...parts: AugmentationSpec[]): AugmentationSpec {
	return Object.assign({}, ...parts);
}

function speakerLabel(index: number): string {
	return `speaker${index + 1}`;
}

function expectedBehaviorFor(
	speechStructure: MeetingStressSpeechStructure,
	index: number,
): MeetingAcousticStressCase["expectedBehavior"] {
	if (
		speechStructure === "side_conversation" ||
		speechStructure === "cross_talk"
	)
		return "do_not_respond";
	if (speechStructure === "overlap" || index % 11 === 0) return "unknown";
	if (speechStructure === "whisper_low_volume" || index % 13 === 0)
		return "needs_speaker_correction";
	return "respond";
}

function turnsForCase(args: {
	speakerCount: number;
	speechStructure: MeetingStressSpeechStructure;
	expectedBehavior: MeetingAcousticStressCase["expectedBehavior"];
}): VoiceScenarioTurn[] {
	const speakers = Array.from({ length: args.speakerCount }, (_, i) =>
		speakerLabel(i),
	);
	const address = args.expectedBehavior === "do_not_respond" ? "" : "Eliza ";
	const baseTextByStructure: Record<MeetingStressSpeechStructure, string> = {
		interruption: `${address}hold on I need to interrupt with the new deadline`,
		overlap: `${address}two people are speaking over the planning update`,
		cross_talk: "did you already send the deck to marketing",
		side_conversation: "let us keep this side note out of the recording",
		whisper_low_volume: `${address}quietly add the private follow up`,
		accented_non_native: `${address}please summarize the reunion notes after lunch`,
		multilingual_turn: `${address}recuerda la reunion and send the action items`,
	};
	return speakers.map((speaker, index) => ({
		speaker,
		text:
			index === 0
				? baseTextByStructure[args.speechStructure]
				: `background speaker ${index + 1} adds overlapping context`,
		expectRespond: index === 0 && args.expectedBehavior !== "do_not_respond",
		...(args.expectedBehavior === "unknown" && index === 0
			? { expectedSpeakerLabel: "unknown" }
			: {}),
		...(args.expectedBehavior === "needs_speaker_correction" && index === 0
			? { expectedEntity: "needs-speaker-correction" }
			: {}),
		...(args.speechStructure === "interruption" && index === 0
			? { bargeIn: true, expectBargeInCancel: true }
			: {}),
		...(args.speechStructure === "whisper_low_volume" && index === 0
			? { environment: { farFieldDb: 18 } }
			: {}),
	}));
}

export function buildMeetingAcousticStressMatrix(
	seed = 12492,
): MeetingAcousticStressMatrix {
	const cases: MeetingAcousticStressCase[] = [];
	let index = 0;
	for (const snrDb of MEETING_STRESS_SNRS_DB) {
		for (const background of MEETING_STRESS_BACKGROUNDS) {
			const room = MEETING_STRESS_ROOMS[index % MEETING_STRESS_ROOMS.length];
			const quality =
				MEETING_STRESS_QUALITIES[index % MEETING_STRESS_QUALITIES.length];
			const speechStructure =
				MEETING_STRESS_SPEECH_STRUCTURES[
					index % MEETING_STRESS_SPEECH_STRUCTURES.length
				];
			const speakerCount =
				MEETING_STRESS_SPEAKER_COUNTS[
					index % MEETING_STRESS_SPEAKER_COUNTS.length
				];
			const caseSeed = seed + index * 101;
			const expectedBehavior = expectedBehaviorFor(speechStructure, index);
			const snrLabel = snrDb < 0 ? `neg${Math.abs(snrDb)}` : `${snrDb}`;
			const id =
				`meeting-stress-${snrLabel}db-${background}-${room}-${quality}-${speechStructure}-${speakerCount}spk`
					.replace(/[^a-zA-Z0-9_]+/g, "-")
					.toLowerCase();
			const environment = mergeEnvironment(
				backgroundEnvironment(background, snrDb, caseSeed),
				roomEnvironment(room),
				qualityEnvironment(quality),
			);
			const participants = Array.from({ length: speakerCount }, (_, i) => ({
				label: speakerLabel(i),
				entityId: `entity-${speakerLabel(i)}`,
				isOwner: i === 0,
			}));
			const scenario: VoiceScenario = {
				id,
				description: `Meeting acoustic stress: ${snrDb} dB ${background}, ${room}, ${quality}, ${speechStructure}, ${speakerCount} speakers.`,
				classes: ["robustness", "multi-speaker", "overlapping-speech"],
				participants,
				knownSpeakerEntityIds: ["entity-speaker1"],
				environment,
				turns: turnsForCase({
					speakerCount,
					speechStructure,
					expectedBehavior,
				}),
				assertions: {
					maxWer: snrDb <= 0 ? 0.65 : 0.45,
					maxDer: speakerCount >= 5 ? 0.42 : 0.32,
					minRespondAccuracy: expectedBehavior === "do_not_respond" ? 1 : 0.85,
				},
			};
			cases.push({
				id,
				snrDb,
				background,
				room,
				quality,
				speechStructure,
				speakerCount,
				expectedBehavior,
				seed: caseSeed,
				sourceManifestIds: [
					...new Set([
						"synthetic_smoke",
						BACKGROUND_SOURCE[background],
						...(room === "reverb" || room === "room_mic_multi_speaker"
							? ["whamr"]
							: []),
						...(speechStructure === "overlap" ||
						speechStructure === "cross_talk"
							? ["librimix"]
							: []),
					]),
				],
				scenario,
			});
			index += 1;
		}
	}
	return {
		schemaVersion: 1,
		seed,
		requirements: {
			snrsDb: MEETING_STRESS_SNRS_DB,
			backgrounds: MEETING_STRESS_BACKGROUNDS,
			rooms: MEETING_STRESS_ROOMS,
			qualities: MEETING_STRESS_QUALITIES,
			speechStructures: MEETING_STRESS_SPEECH_STRUCTURES,
			speakerCounts: MEETING_STRESS_SPEAKER_COUNTS,
			negativeBehaviors: MEETING_STRESS_NEGATIVE_BEHAVIORS,
		},
		sourceManifests: MEETING_ACOUSTIC_STRESS_SOURCE_MANIFESTS,
		cases,
	};
}

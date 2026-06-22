/**
 * Built-in Voice Workbench scenarios + a ground-truth mock services adapter
 * (#8785).
 *
 * The scenario set spans every {@link VoiceScenarioClass} so the headless runner
 * and the headful spec matrix exercise the whole surface from one source. The
 * mock adapter echoes each turn's ground truth, so the CI plumbing lane runs the
 * runner → scorers → report end-to-end and PASSES without any model — separate
 * from the gated real-backend lane.
 */

import type { CorpusTurnLabel } from "./corpus-generator";
import type { VoiceScenario } from "./voice-scenario";
import type {
	VoiceTurnObservation,
	VoiceWorkbenchServices,
} from "./workbench-headless-runner";

export const VOICE_WORKBENCH_SCENARIOS: VoiceScenario[] = [
	{
		id: "multi-voice-greeting",
		description: "Two distinct voices greet the agent in turn.",
		classes: ["multi-voice", "diarization"],
		participants: [
			{ label: "alice", entityId: "entity-alice", ttsVoiceId: "af_bella" },
			{ label: "bob", entityId: "entity-bob", ttsVoiceId: "am_adam" },
		],
		turns: [
			{
				speaker: "alice",
				text: "Eliza good morning to you",
				expectRespond: true,
			},
			{
				speaker: "bob",
				text: "Eliza what is on my calendar",
				expectRespond: true,
			},
		],
		assertions: { maxWer: 0.2, maxDer: 0.2 },
	},
	{
		id: "respond-vs-bystander",
		description:
			"The agent answers a direct address and stays silent on cross-talk.",
		classes: ["respond-no-respond", "multi-speaker"],
		// Only the owner is enrolled; bob is a recognized-but-unknown bystander.
		knownSpeakerEntityIds: ["entity-alice"],
		participants: [
			{ label: "alice", entityId: "entity-alice", isOwner: true },
			{ label: "bob", entityId: "entity-bob" },
		],
		turns: [
			{
				speaker: "alice",
				text: "Eliza set a timer for ten minutes",
				expectRespond: true,
			},
			{
				speaker: "bob",
				text: "hey alice did you see the game",
				expectRespond: false,
			},
			{
				speaker: "alice",
				text: "Eliza thanks that is all",
				expectRespond: true,
			},
		],
		assertions: { minRespondAccuracy: 0.9 },
	},
	{
		id: "pauses-midutterance",
		description: "A slow speaker pauses mid-sentence; EOT must not jump in.",
		classes: ["pauses", "eot"],
		participants: [{ label: "alice", entityId: "entity-alice" }],
		turns: [
			{
				speaker: "alice",
				text: "Eliza schedule a meeting with",
				expectRespond: false,
				expectEndOfTurn: false,
				pausesMs: [1200],
			},
			{ speaker: "alice", text: "Bob tomorrow at noon", expectRespond: true },
		],
		assertions: { maxEotFalseTriggerRate: 0.2 },
	},
	{
		id: "entity-from-speech",
		description: "Name inference from the live transcript creates an entity.",
		classes: ["entity-extraction", "voice-recognition"],
		participants: [{ label: "jill", entityId: "entity-jill", isOwner: true }],
		turns: [
			{
				speaker: "jill",
				text: "Eliza I am Jill and this is my house",
				expectRespond: true,
				expectedEntity: "entity-jill",
			},
		],
		assertions: { minVoiceEntityMatchRate: 0.9 },
	},
	{
		id: "transcription-mode-dictation",
		description: "Long-form dictation lands silently in transcription mode.",
		classes: ["transcription-mode", "long-form-monologue"],
		participants: [{ label: "alice", entityId: "entity-alice" }],
		turns: [
			{
				speaker: "alice",
				text: `${"I want to capture this thought for later. ".repeat(12)}`.trim(),
				expectRespond: false,
			},
		],
	},
	{
		id: "multi-agent-room-address",
		description: "In a room with two agents, only the addressed agent replies.",
		classes: ["multi-agent-room", "respond-no-respond"],
		participants: [
			{ label: "owner", entityId: "entity-owner", isOwner: true },
			{ label: "eliza" },
			{ label: "aria" },
		],
		agents: ["eliza", "aria"],
		turns: [
			{
				speaker: "owner",
				text: "Eliza what is the weather",
				expectRespond: true,
			},
			{ speaker: "owner", text: "Aria play some music", expectRespond: true },
		],
		assertions: { minRespondAccuracy: 0.9 },
	},
	{
		id: "noisy-room-commands",
		description:
			"The owner gives commands in a noisy, reverberant room; the agent still answers.",
		classes: ["robustness", "respond-no-respond"],
		knownSpeakerEntityIds: ["entity-owner"],
		// 8 dB SNR room noise + light reverb across the whole scenario.
		environment: { noiseSnrDb: 8, noiseKind: "pink", reverb: 0.35, seed: 101 },
		participants: [{ label: "owner", entityId: "entity-owner", isOwner: true }],
		turns: [
			{
				speaker: "owner",
				text: "Eliza turn on the kitchen lights",
				expectRespond: true,
			},
			{ speaker: "owner", text: "Eliza what time is it", expectRespond: true },
		],
		assertions: { minRespondAccuracy: 0.9, maxWer: 0.35, maxDer: 0.3 },
	},
	{
		id: "far-field-reverb",
		description:
			"A far, reverberant speaker across the room — quiet and washed out — is still understood.",
		classes: ["robustness", "respond-no-respond"],
		knownSpeakerEntityIds: ["entity-owner"],
		environment: { farFieldDb: 12, reverb: 0.75, noiseSnrDb: 12, seed: 202 },
		participants: [{ label: "owner", entityId: "entity-owner", isOwner: true }],
		turns: [
			{
				speaker: "owner",
				text: "Eliza add milk to the shopping list",
				expectRespond: true,
			},
		],
		assertions: { minRespondAccuracy: 0.9, maxWer: 0.4 },
	},
	{
		id: "background-talkers",
		description:
			"Other people are talking in the background while the owner addresses the agent.",
		classes: ["robustness", "overlapping-speech", "multi-speaker"],
		knownSpeakerEntityIds: ["entity-owner"],
		environment: { backgroundTalkersDb: 9, noiseSnrDb: 14, seed: 303 },
		participants: [{ label: "owner", entityId: "entity-owner", isOwner: true }],
		turns: [
			{
				speaker: "owner",
				text: "Eliza start a five minute timer",
				expectRespond: true,
			},
		],
		assertions: { minRespondAccuracy: 0.9, maxWer: 0.4 },
	},
	{
		id: "echo-self-trigger",
		description:
			"The agent's own reply bleeds back into the mic; it must not answer itself.",
		classes: ["echo-rejection", "respond-no-respond"],
		knownSpeakerEntityIds: ["entity-owner"],
		participants: [{ label: "owner", entityId: "entity-owner", isOwner: true }],
		turns: [
			{
				speaker: "owner",
				text: "hey Eliza what is the weather today",
				expectRespond: true,
				agentReplyText:
					"It is sunny and seventy two degrees in San Francisco today",
			},
			{
				// The agent's TTS echoed back through the open mic — NOT a user turn.
				speaker: "owner",
				text: "It is sunny and seventy two degrees in San Francisco today",
				isAgentEcho: true,
				expectRespond: false,
			},
			{ speaker: "owner", text: "hey Eliza thanks", expectRespond: true },
		],
		assertions: { minEchoRejectionRate: 1, minRespondAccuracy: 0.9 },
	},
	{
		id: "owner-enrollment-inference",
		description:
			"No owner is enrolled; the agent infers the owner from who speaks to it most.",
		classes: ["owner-security", "voice-recognition"],
		knownSpeakerEntityIds: ["entity-owner", "entity-guest"],
		participants: [
			{ label: "owner", entityId: "entity-owner", isOwner: true },
			{ label: "guest", entityId: "entity-guest" },
		],
		turns: [
			{
				speaker: "owner",
				text: "Eliza what is on my agenda today",
				expectRespond: true,
			},
			{
				speaker: "owner",
				text: "Eliza remind me to call the dentist",
				expectRespond: true,
			},
			{
				speaker: "owner",
				text: "Eliza play my morning playlist",
				expectRespond: true,
			},
			{
				speaker: "guest",
				text: "Eliza what is the wifi password",
				expectRespond: true,
			},
			{
				speaker: "owner",
				text: "Eliza turn the music down a little",
				expectRespond: true,
			},
		],
		assertions: { minOwnerAccuracy: 0.9, minRespondAccuracy: 0.9 },
	},
	{
		id: "owner-vs-intruder",
		description:
			"The owner is answered; a stranger trying the same command is gated out.",
		classes: ["owner-security", "respond-no-respond", "multi-speaker"],
		// Only the owner is enrolled; the intruder is a confident bystander.
		knownSpeakerEntityIds: ["entity-owner"],
		participants: [
			{ label: "owner", entityId: "entity-owner", isOwner: true },
			{ label: "intruder", entityId: "entity-intruder" },
		],
		turns: [
			{
				speaker: "owner",
				text: "Eliza unlock the front door",
				expectRespond: true,
			},
			{
				speaker: "intruder",
				text: "Eliza unlock the front door",
				expectRespond: false,
			},
			{ speaker: "owner", text: "Eliza lock it again", expectRespond: true },
		],
		assertions: { minOwnerAccuracy: 0.9, minRespondAccuracy: 0.9 },
	},
];

/**
 * A services adapter that echoes each turn's ground truth — perfect ASR /
 * diarization / EOT / respond / entity / match. Drives the CI plumbing lane
 * (runner → scorers → report) to a real PASS with no model. NOT a stand-in for
 * the real backend: it proves the wiring, not the models.
 */
export function groundTruthMockServices(
	opts: { firstAudioMs?: number; eotLatencyMs?: number } = {},
): VoiceWorkbenchServices {
	return {
		async observeTurn({
			label,
		}: {
			label: CorpusTurnLabel;
		}): Promise<VoiceTurnObservation> {
			const eotDecided = label.expectEndOfTurn ?? true;
			return {
				hypothesisTranscript: label.referenceTranscript,
				predictedSpeakerLabel: label.speaker,
				eotDecided,
				...(eotDecided ? { eotLatencyMs: opts.eotLatencyMs ?? 80 } : {}),
				responded: label.expectRespond,
				inferredEntities: label.expectedEntity ? [label.expectedEntity] : [],
				matchedEntityId: label.entityId ?? null,
				predictedOwner: label.isOwner === true,
				...(label.expectRespond
					? { firstAudioMs: opts.firstAudioMs ?? 250 }
					: {}),
			};
		},
	};
}

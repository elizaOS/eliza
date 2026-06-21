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
			return {
				hypothesisTranscript: label.referenceTranscript,
				predictedSpeakerLabel: label.speaker,
				eotDecided: true,
				eotLatencyMs: opts.eotLatencyMs ?? 80,
				responded: label.expectRespond,
				inferredEntities: label.expectedEntity ? [label.expectedEntity] : [],
				matchedEntityId: label.entityId ?? null,
				...(label.expectRespond
					? { firstAudioMs: opts.firstAudioMs ?? 250 }
					: {}),
			};
		},
	};
}

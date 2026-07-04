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
		// DER budget: VoxConverse offline 11.3% + 10 pp streaming headroom (parent
		// decision #10). TTFA 800 ms is the real-lane time-to-first-audio ceiling;
		// the model-free lanes report a fixed sub-budget latency.
		assertions: { maxWer: 0.2, maxDer: 0.213, maxFirstAudioMs: 800 },
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
		assertions: { minRespondAccuracy: 0.9, maxFirstAudioMs: 800 },
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
		assertions: { minRespondAccuracy: 0.9, maxWer: 0.35, maxDer: 0.288 },
	},
	{
		id: "music-background-commands",
		description:
			"The owner gives commands with music playing in the background; the agent answers and the tonal music bed does not false-trigger VAD/respond.",
		classes: ["robustness", "respond-no-respond"],
		knownSpeakerEntityIds: ["entity-owner"],
		// 10 dB SNR music bed across the whole scenario. The `music` noise kind is
		// tonal/harmonic (unlike white/pink) — this scenario exercises the music
		// augmentation that landed in corpus-augment.ts (d56efcc80b) but until now
		// had no scenario driving it (#9147).
		environment: { noiseSnrDb: 10, noiseKind: "music", reverb: 0.2, seed: 404 },
		participants: [{ label: "owner", entityId: "entity-owner", isOwner: true }],
		turns: [
			{ speaker: "owner", text: "Eliza pause the timer", expectRespond: true },
			{
				speaker: "owner",
				text: "Eliza what is the weather today",
				expectRespond: true,
			},
		],
		assertions: { minRespondAccuracy: 0.9, maxWer: 0.35, maxDer: 0.288 },
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
		id: "multi-speaker-name-capture",
		description:
			"Two new people in the room introduce themselves; each name is captured and bound to a distinct entity, separate from the owner.",
		classes: [
			"diarization",
			"entity-extraction",
			"multi-speaker",
			"voice-recognition",
		],
		knownSpeakerEntityIds: ["entity-owner", "entity-marcus", "entity-priya"],
		participants: [
			{ label: "owner", entityId: "entity-owner", isOwner: true },
			{ label: "marcus", entityId: "entity-marcus" },
			{ label: "priya", entityId: "entity-priya" },
		],
		turns: [
			{
				speaker: "owner",
				text: "Eliza meet my two coworkers",
				expectRespond: true,
			},
			{
				speaker: "marcus",
				text: "hey Eliza I am Marcus good to meet you",
				expectRespond: true,
				expectedEntity: "entity-marcus",
			},
			{
				speaker: "priya",
				text: "Eliza I am Priya from the design team",
				expectRespond: true,
				expectedEntity: "entity-priya",
			},
			{
				speaker: "owner",
				text: "Eliza remember them for later",
				expectRespond: true,
			},
		],
		assertions: {
			minRespondAccuracy: 0.9,
			maxDer: 0.213,
			minVoiceEntityMatchRate: 0.9,
		},
	},
	{
		id: "confusable-names-clean",
		description:
			"Three people with confusable names (Jon / John / Joan) introduce themselves in a quiet room; each name must bind to exactly its own entity, never a near-miss neighbor. minEntityF1 1 makes one cross-bind (precision) or one collapse (recall) fail the gate.",
		classes: [
			"entity-extraction",
			"name-disambiguation",
			"multi-speaker",
			"voice-recognition",
			"diarization",
		],
		knownSpeakerEntityIds: ["entity-jon", "entity-john", "entity-joan"],
		participants: [
			{ label: "jon", entityId: "entity-jon" },
			{ label: "john", entityId: "entity-john" },
			{ label: "joan", entityId: "entity-joan" },
		],
		turns: [
			{
				speaker: "jon",
				text: "hey Eliza I am Jon and I live next door",
				expectRespond: true,
				expectedEntity: "entity-jon",
			},
			{
				speaker: "john",
				text: "Eliza I am John from the accounting team",
				expectRespond: true,
				expectedEntity: "entity-john",
			},
			{
				speaker: "joan",
				text: "Eliza I am Joan and my house is the blue one",
				expectRespond: true,
				expectedEntity: "entity-joan",
			},
		],
		// maxWer 0.25 (not the default 0.2) because Jon/John are homophones: a
		// real-lane ASR spelling either one the other way is legitimate acoustic
		// ambiguity, not a transcription regression.
		assertions: {
			minRespondAccuracy: 0.9,
			maxDer: 0.213,
			maxWer: 0.25,
			minVoiceEntityMatchRate: 0.9,
			minEntityF1: 1,
		},
	},
	{
		id: "confusable-names-noisy",
		description:
			"Confusable-name introductions (Erik / Erika, Mia / Maya) in a noisy, reverberant room; every name still binds to exactly its own entity.",
		classes: [
			"entity-extraction",
			"name-disambiguation",
			"multi-speaker",
			"voice-recognition",
			"robustness",
		],
		environment: { noiseSnrDb: 10, noiseKind: "pink", reverb: 0.3, seed: 707 },
		knownSpeakerEntityIds: [
			"entity-erik",
			"entity-erika",
			"entity-mia",
			"entity-maya",
		],
		participants: [
			{ label: "erik", entityId: "entity-erik" },
			{ label: "erika", entityId: "entity-erika" },
			{ label: "mia", entityId: "entity-mia" },
			{ label: "maya", entityId: "entity-maya" },
		],
		turns: [
			{
				speaker: "erik",
				text: "hey Eliza I am Erik and I just moved here",
				expectRespond: true,
				expectedEntity: "entity-erik",
			},
			{
				speaker: "erika",
				text: "Eliza I am Erika and I work in the city",
				expectRespond: true,
				expectedEntity: "entity-erika",
			},
			{
				speaker: "mia",
				text: "hey Eliza I am Mia and I love this garden",
				expectRespond: true,
				expectedEntity: "entity-mia",
			},
			{
				speaker: "maya",
				text: "Eliza I am Maya and I brought the cake",
				expectRespond: true,
				expectedEntity: "entity-maya",
			},
		],
		// AMI meeting baseline 18.8% + 10 pp → 0.288 DER budget for the noisy
		// multi-speaker case (parent decision #10).
		assertions: {
			minRespondAccuracy: 0.9,
			maxDer: 0.288,
			maxWer: 0.4,
			minVoiceEntityMatchRate: 0.9,
			minEntityF1: 1,
		},
	},
	{
		id: "confusable-name-garbled-transcript",
		description:
			"ASR garbles a confusable name (Mia heard as 'Maia') — ambiguous between the enrolled Mia and Maya, so the extractor must bind NOTHING rather than guess a neighbor. A fuzzy matcher that guesses either drops precision and trips the minEntityF1 gate.",
		classes: [
			"entity-extraction",
			"name-disambiguation",
			"multi-speaker",
			"voice-recognition",
		],
		knownSpeakerEntityIds: ["entity-pam", "entity-mia", "entity-maya"],
		participants: [
			{ label: "pam", entityId: "entity-pam" },
			{ label: "mia", entityId: "entity-mia" },
			{ label: "maya", entityId: "entity-maya" },
		],
		turns: [
			{
				speaker: "pam",
				text: "hey Eliza I am Pam and these are my friends",
				expectRespond: true,
				expectedEntity: "entity-pam",
			},
			{
				// Mia's introduction mis-transcribed as "Maia" — a token BETWEEN the
				// two enrolled confusables. Ground truth binds nothing (no
				// expectedEntity); the garbled form goes straight into `text`,
				// mirroring the echo-mistranscribed precedent.
				speaker: "mia",
				text: "Eliza I am Maia and this is my first visit",
				expectRespond: true,
			},
			{
				speaker: "maya",
				text: "Eliza the garden looks wonderful today",
				expectRespond: true,
			},
		],
		assertions: {
			minRespondAccuracy: 0.9,
			maxDer: 0.213,
			maxWer: 0.25,
			minVoiceEntityMatchRate: 0.9,
			minEntityF1: 1,
		},
	},
	{
		id: "echo-mistranscribed",
		description:
			"The agent's echo is mis-transcribed (no word overlap); the ACOUSTIC self-voice gate still rejects it.",
		classes: ["echo-rejection"],
		knownSpeakerEntityIds: ["entity-owner"],
		participants: [{ label: "owner", entityId: "entity-owner", isOwner: true }],
		turns: [
			{
				speaker: "owner",
				text: "hey Eliza how many days until friday",
				expectRespond: true,
				agentReplyText: "There are three days until Friday",
			},
			{
				// ASR garbled the echoed reply — NO words overlap "three days until
				// friday", so the transcript guard would miss it. Self-voice catches it.
				speaker: "owner",
				text: "thudder ays untl fryeday",
				isAgentEcho: true,
				expectRespond: false,
			},
		],
		assertions: { minEchoRejectionRate: 1 },
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
	{
		id: "endpoint-latency",
		description:
			"A clean, sentence-final command commits at the endpoint; first audio must land within the real-lane TTFA budget (#12254).",
		classes: ["endpoint-latency", "eot"],
		knownSpeakerEntityIds: ["entity-owner"],
		participants: [{ label: "owner", entityId: "entity-owner", isOwner: true }],
		turns: [
			{
				speaker: "owner",
				text: "hey Eliza what is the weather today",
				expectRespond: true,
				expectEndOfTurn: true,
			},
			{
				speaker: "owner",
				text: "hey Eliza set a timer for five minutes",
				expectRespond: true,
				expectEndOfTurn: true,
			},
		],
		assertions: { maxEotFalseTriggerRate: 0, maxFirstAudioMs: 800 },
	},
	{
		id: "tail-off-thinking",
		description:
			"The owner tails off mid-thought (trailing conjunction) then finishes after a pause; the endpoint detector must hold, not jump in on the pause (#12255).",
		classes: ["tail-off", "eot", "pauses"],
		knownSpeakerEntityIds: ["entity-owner"],
		participants: [{ label: "owner", entityId: "entity-owner", isOwner: true }],
		turns: [
			{
				speaker: "owner",
				text: "Eliza remind me to call the bank and",
				expectRespond: false,
				expectEndOfTurn: false,
				pausesMs: [1300],
			},
			{
				speaker: "owner",
				text: "the pharmacy before noon tomorrow",
				expectRespond: true,
			},
		],
		assertions: { maxEotFalseTriggerRate: 0 },
	},
	{
		id: "streaming-partials-monotonic",
		description:
			"Streaming ASR emits growing partial hypotheses; the committed prefix must never retract as later audio arrives (#12254). Scored only where a streaming-ASR partial feed exists; batch lanes skip it honestly.",
		classes: ["streaming-partials", "eot"],
		knownSpeakerEntityIds: ["entity-owner"],
		participants: [{ label: "owner", entityId: "entity-owner", isOwner: true }],
		turns: [
			{
				speaker: "owner",
				text: "hey Eliza what is the weather in san francisco today",
				expectRespond: true,
			},
		],
	},
	{
		id: "speaker-gated-barge-in",
		description:
			"While the agent is speaking: a wake-word interjection must hard-stop TTS within 250 ms; the agent's own echo and an unenrolled bystander must NOT (#12255).",
		classes: ["speaker-gated-barge-in", "echo-rejection"],
		knownSpeakerEntityIds: ["entity-owner"],
		participants: [
			{ label: "owner", entityId: "entity-owner", isOwner: true },
			{ label: "bystander", entityId: "entity-bystander" },
		],
		turns: [
			{
				speaker: "owner",
				text: "hey Eliza tell me about the weather forecast for the week",
				expectRespond: true,
				agentReplyText:
					"The week ahead is mostly sunny with a chance of rain on thursday",
			},
			{
				// Wake-word interjection while the agent is mid-reply → MUST cancel.
				speaker: "owner",
				text: "hey Eliza stop the forecast",
				expectRespond: true,
				bargeIn: true,
				expectBargeInCancel: true,
			},
			{
				speaker: "owner",
				text: "hey Eliza what about tomorrow instead",
				expectRespond: true,
				agentReplyText: "Tomorrow looks clear and mild all day long",
			},
			{
				// The agent's own reply echoes back through the open mic → must NOT cancel.
				speaker: "owner",
				text: "Tomorrow looks clear and mild all day long",
				isAgentEcho: true,
				expectRespond: false,
				bargeIn: true,
				expectBargeInCancel: false,
			},
			{
				// Unenrolled bystander cross-talk during the agent's reply → must NOT cancel.
				speaker: "bystander",
				text: "did you catch the game last night",
				expectRespond: false,
				bargeIn: true,
				expectBargeInCancel: false,
			},
		],
		assertions: { maxBargeInCancelMs: 250, minEchoRejectionRate: 1 },
	},
	{
		id: "desktop-aec-echo",
		description:
			"Desktop speak-back loop: the agent's reply echoes into the mic. The AEC must keep ERLE ≥ 18 dB and the self-voice gate must reject the echo as a turn (#12256). ERLE is scored only where an AEC/ERLE feed exists; the decision-logic lane still scores echo rejection.",
		classes: ["desktop-aec", "echo-rejection"],
		knownSpeakerEntityIds: ["entity-owner"],
		participants: [{ label: "owner", entityId: "entity-owner", isOwner: true }],
		turns: [
			{
				speaker: "owner",
				text: "hey Eliza what is the capital of france",
				expectRespond: true,
				agentReplyText: "The capital of France is Paris",
			},
			{
				speaker: "owner",
				text: "The capital of France is Paris",
				isAgentEcho: true,
				expectRespond: false,
			},
			{ speaker: "owner", text: "hey Eliza thank you", expectRespond: true },
		],
		assertions: { minErleDb: 18, minEchoRejectionRate: 1 },
	},
	{
		id: "long-turn-diarization",
		description:
			"A long three-voice exchange (~30 s) windowed incrementally; every segment must attribute within the AMI meeting DER budget (#12257).",
		classes: ["long-turn-diarization", "diarization", "multi-speaker"],
		knownSpeakerEntityIds: ["entity-a", "entity-b", "entity-c"],
		participants: [
			{ label: "ada", entityId: "entity-a" },
			{ label: "ben", entityId: "entity-b" },
			{ label: "cal", entityId: "entity-c" },
		],
		turns: [
			{
				speaker: "ada",
				text: "Eliza pull up the quarterly revenue chart for us",
				expectRespond: true,
			},
			{
				speaker: "ben",
				text: "Eliza also show the cost breakdown next to it",
				expectRespond: true,
			},
			{
				speaker: "cal",
				text: "Eliza highlight the regions that grew the most this quarter",
				expectRespond: true,
			},
			{
				speaker: "ada",
				text: "Eliza compare that against last year for the same period",
				expectRespond: true,
			},
			{
				speaker: "ben",
				text: "Eliza note which product line drove the increase",
				expectRespond: true,
			},
			{
				speaker: "cal",
				text: "Eliza and flag anything that looks like an outlier",
				expectRespond: true,
			},
			{
				speaker: "ada",
				text: "Eliza summarize all of that into three bullet points",
				expectRespond: true,
			},
			{
				speaker: "ben",
				text: "Eliza then draft a short update for the team channel",
				expectRespond: true,
			},
		],
		// AMI meeting baseline 18.8% + 10 pp streaming headroom (parent decision #10).
		assertions: { maxDer: 0.288, minRespondAccuracy: 0.9 },
	},
];

/** A growing sequence of committed prefixes over `text`'s words (monotonic). */
function monotonicPartials(text: string): string[] {
	const words = text.split(/\s+/).filter(Boolean);
	const out: string[] = [];
	for (let i = 1; i <= words.length; i++) out.push(words.slice(0, i).join(" "));
	return out;
}

/**
 * A services adapter that echoes each turn's ground truth — perfect ASR /
 * diarization / EOT / respond / entity / match, plus a clean barge-in / ERLE /
 * streaming-partial signal for the scenarios that assert them. Drives the CI
 * plumbing lane (runner → scorers → report) to a real PASS with no model. NOT a
 * stand-in for the real backend: it proves the wiring, not the models.
 */
export function groundTruthMockServices(
	opts: {
		firstAudioMs?: number;
		eotLatencyMs?: number;
		bargeInCancelMs?: number;
		erleDb?: number;
	} = {},
): VoiceWorkbenchServices {
	return {
		async observeTurn({
			label,
			groundTruth,
		}: {
			label: CorpusTurnLabel;
			groundTruth: { classes: readonly string[] };
		}): Promise<VoiceTurnObservation> {
			const eotDecided = label.expectEndOfTurn ?? true;
			// A barge-in that should cancel reports an in-budget latency; one that
			// should hold reports `null` (no cancel) — the speaker-gating ground truth.
			const bargeInCancelMs = label.bargeIn
				? label.expectBargeInCancel
					? (opts.bargeInCancelMs ?? 120)
					: null
				: undefined;
			// AEC scenarios report a healthy ERLE on the echo turn; the decision-logic
			// lane has no AEC and omits it (honest skip).
			const erleDb =
				groundTruth.classes.includes("desktop-aec") && label.isAgentEcho
					? (opts.erleDb ?? 24)
					: undefined;
			const partialTranscripts =
				groundTruth.classes.includes("streaming-partials") &&
				label.expectRespond
					? monotonicPartials(label.referenceTranscript)
					: undefined;
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
				...(bargeInCancelMs !== undefined ? { bargeInCancelMs } : {}),
				...(erleDb !== undefined ? { erleDb } : {}),
				...(partialTranscripts ? { partialTranscripts } : {}),
			};
		},
	};
}

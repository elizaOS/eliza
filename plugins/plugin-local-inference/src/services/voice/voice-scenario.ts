/**
 * Voice Workbench scenario schema (#8785).
 *
 * One declarative format for a voice conversation that BOTH the headless runner
 * (real services: ASR / diarization / EOT / respond / TTS over a corpus) and
 * the headful scenario player (the real frontend client pipeline) execute, and
 * that the benchmark layer scores. A scenario is an ordered list of turns plus
 * named participants and scenario-level assertions; each turn declares the
 * expected behavior (respond / don't, transcript, speaker label, entity) so the
 * runner can score against ground truth.
 *
 * Pure types + a pure validator — no model loading, no I/O — so it is safe to
 * import from the runner, the player, and tests alike.
 */

import type { AugmentationSpec } from "./corpus-augment";

/**
 * Acoustic environment for a scenario or a single turn: room noise, reverb,
 * far-field attenuation, low-quality line, background talkers. Drives the
 * corpus generator's degradation chain ({@link AugmentationSpec}). A turn's
 * environment is merged over the scenario's, so a scenario can declare a noisy
 * room once and an individual turn can override it (e.g. one talker steps away).
 */
export type VoiceEnvironment = AugmentationSpec;

/** A named voice/entity participating in the scenario. */
export interface VoiceScenarioParticipant {
	/** Stable label used in turns + diarization ground truth (e.g. "alice"). */
	label: string;
	/** TTS voice id used to synthesize this participant's turns in the corpus. */
	ttsVoiceId?: string;
	/** The elizaOS entity id this voice should resolve to (voice→entity match). */
	entityId?: string;
	/** True when this participant is the device owner / primary enrolled speaker. */
	isOwner?: boolean;
}

/** One spoken turn in the scenario. */
export interface VoiceScenarioTurn {
	/** Participant label (must exist in `participants`). */
	speaker: string;
	/** Spoken text — synthesized to audio by the corpus generator. */
	text?: string;
	/** OR a reference to a pre-recorded/-generated audio file under the corpus. */
	audioRef?: string;
	/** Override the participant's default TTS voice for this turn. */
	ttsVoiceId?: string;
	/** Silent gaps (ms) spliced AFTER this turn's audio (pauses / barge-in gaps). */
	pausesMs?: number[];
	/** Ground truth: SHOULD the agent respond to this turn? */
	expectRespond: boolean;
	/** Ground truth: is this segment a real end-of-turn boundary? */
	expectEndOfTurn?: boolean;
	/** Expected ASR transcript (for WER scoring); defaults to `text`. */
	expectedTranscript?: string;
	/** Expected diarization label (defaults to `speaker`). */
	expectedSpeakerLabel?: string;
	/** Expected entity inferred/recognized from this turn (name extraction). */
	expectedEntity?: string;
	/**
	 * Acoustic degradation for THIS turn, merged over the scenario environment.
	 * Use it to model one talker stepping away (far-field) or onto a bad line
	 * while the rest of the room stays clean.
	 */
	environment?: VoiceEnvironment;
	/**
	 * Ground truth for echo/self-voice rejection: this "turn" is the agent's own
	 * TTS bleeding back into the mic (not a real user turn). The respond gate
	 * MUST suppress it. Always implies `expectRespond: false`.
	 */
	isAgentEcho?: boolean;
	/**
	 * The agent's spoken reply to THIS turn (when it responds). The real-decision
	 * logic adapter uses it as the "recent agent reply" the echo gate compares a
	 * following `isAgentEcho` turn against — so echo rejection is tested against a
	 * genuine reply string, not a circular self-reference.
	 */
	agentReplyText?: string;
	/**
	 * This turn arrives WHILE the agent is mid-TTS (a barge-in). The speaker-gated
	 * barge-in scorer measures whether the agent's playback was correctly cancelled
	 * (or correctly held). Set on wake-word interjections, bystander cross-talk, and
	 * agent-echo bleed-back that occur during agent speech (#12255).
	 */
	bargeIn?: boolean;
	/**
	 * Ground truth for a {@link bargeIn} turn: SHOULD it hard-stop the agent's TTS?
	 * A wake-word / owner interjection must (`true`); the agent's own echo and an
	 * unenrolled bystander must not (`false`). Only meaningful when `bargeIn` is set.
	 */
	expectBargeInCancel?: boolean;
}

/** Scenario-level pass/fail thresholds the benchmark layer enforces. */
export interface VoiceScenarioAssertions {
	/** Max word-error-rate across the scenario's transcripts. */
	maxWer?: number;
	/** Max diarization error rate. */
	maxDer?: number;
	/** Min respond-decision accuracy. */
	minRespondAccuracy?: number;
	/** Max EOT false-trigger rate. */
	maxEotFalseTriggerRate?: number;
	/** Min voice→entity match rate. */
	minVoiceEntityMatchRate?: number;
	/**
	 * Min entity-extraction F1 (precision/recall over inferred names). Defaults
	 * to the scorer's 0.8; disambiguation scenarios pin it to 1 so a single
	 * confusable-name misbind (precision) or miss (recall) fails the gate.
	 */
	minEntityF1?: number;
	/** Latency budgets (ms) — first-audio / time-to-first-token, etc. */
	maxFirstAudioMs?: number;
	maxTtftMs?: number;
	/** Min echo/self-voice rejection rate (agent-echo turns correctly suppressed). */
	minEchoRejectionRate?: number;
	/** Min owner-vs-intruder accuracy for security scenarios. */
	minOwnerAccuracy?: number;
	/**
	 * Max barge-in cancel latency (ms) for a turn that MUST hard-stop the agent's
	 * TTS. Settled ceiling: 250 ms (parent decision #10). The speaker-gated
	 * barge-in scorer also fails any turn that cancelled when it should have held
	 * (echo / bystander), independent of this budget.
	 */
	maxBargeInCancelMs?: number;
	/**
	 * Min echo-return-loss-enhancement (dB) on AEC scenarios — the residual after
	 * cancellation must be at least this far below the near-end echo. Settled floor:
	 * 18 dB (parent decision #10). Consumes the runtime AEC/ERLE telemetry the echo
	 * sub-issue (#12256) exposes; honestly unscored in lanes without an AEC feed.
	 */
	minErleDb?: number;
}

export type VoiceScenarioClass =
	| "multi-voice"
	| "pauses"
	| "respond-no-respond"
	| "multi-speaker"
	| "diarization"
	| "entity-extraction"
	| "voice-recognition"
	| "eot"
	| "transcription-mode"
	| "multi-agent-room"
	| "long-form-monologue"
	// Robustness: degraded acoustics (noise / reverb / far-field / low-quality).
	| "robustness"
	// Self-echo: the agent's own TTS must not be treated as a user turn.
	| "echo-rejection"
	// Security: owner vs. intruder / non-owner voice gating.
	| "owner-security"
	// Similar-sounding names (Jon/John/Joan, Erik/Erika, Mia/Maya) must each
	// bind to exactly their own entity — never a near-miss neighbor.
	| "name-disambiguation"
	// Two voices overlapping / interrupting each other.
	| "overlapping-speech"
	// Streaming-ASR partial hypotheses: the committed prefix never retracts.
	| "streaming-partials"
	// Speech-end → commit latency under the tuned end-of-turn hangover.
	| "endpoint-latency"
	// Filler / mid-clause pauses that must NOT be treated as a turn boundary.
	| "tail-off"
	// Barge-in gated by speaker: wake-word cancels TTS; echo / bystander do not.
	| "speaker-gated-barge-in"
	// Desktop speak-back echo scored for ERLE + self-voice rejection.
	| "desktop-aec"
	// Long multi-speaker turn, windowed incrementally, DER within the meeting budget.
	| "long-turn-diarization";

export interface VoiceScenario {
	/** Stable id (also the corpus subdirectory name). */
	id: string;
	/** Human description of what the scenario exercises. */
	description?: string;
	/** Which scenario class(es) this belongs to (drives the headful spec matrix). */
	classes: VoiceScenarioClass[];
	participants: VoiceScenarioParticipant[];
	turns: VoiceScenarioTurn[];
	assertions?: VoiceScenarioAssertions;
	/** Agent labels present in a multi-agent room (subset of participants). */
	agents?: string[];
	/** Scenario-wide acoustic environment; per-turn `environment` overrides it. */
	environment?: VoiceEnvironment;
	/**
	 * Entity ids the agent answers WITHOUT a wake word (owner + enrolled
	 * speakers). The respond gate suppresses a confident speaker NOT in this set
	 * as a bystander. Defaults (in the runner) to every participant that has an
	 * `entityId`; set it explicitly to mark some bound voices as strangers.
	 */
	knownSpeakerEntityIds?: string[];
}

export interface VoiceScenarioValidation {
	valid: boolean;
	errors: string[];
}

/**
 * Validate a scenario's internal consistency (pure; no I/O). Checks ids,
 * participant references, turn audio/text presence, and that any agents named
 * exist as participants. Returns all errors (does not throw) so a corpus build
 * can report every problem at once.
 */
/** True when a value is not a non-empty string (so `.trim()` is never called on a non-string). */
function isBlank(v: unknown): boolean {
	return typeof v !== "string" || v.trim().length === 0;
}

export function validateVoiceScenario(
	scenario: VoiceScenario,
): VoiceScenarioValidation {
	const errors: string[] = [];
	// A malformed/empty scenario file can deserialize to a non-object; guard the
	// boundary so the validator reports an error instead of throwing.
	if (!scenario || typeof scenario !== "object" || Array.isArray(scenario)) {
		return { valid: false, errors: ["scenario must be an object"] };
	}
	if (isBlank(scenario.id)) errors.push("scenario.id is required");
	if (!Array.isArray(scenario.classes) || scenario.classes.length === 0) {
		errors.push("scenario.classes must be a non-empty array");
	}
	// Iterate defensively: a malformed scenario may carry non-array fields.
	const participants = Array.isArray(scenario.participants)
		? scenario.participants
		: [];
	const turns = Array.isArray(scenario.turns) ? scenario.turns : [];
	const agents = Array.isArray(scenario.agents) ? scenario.agents : [];
	const labels = new Set<string>();
	for (const p of participants) {
		if (!p || typeof p !== "object") {
			errors.push("participant must be an object");
			continue;
		}
		if (isBlank(p.label)) {
			errors.push("participant.label is required");
			continue;
		}
		if (labels.has(p.label))
			errors.push(`duplicate participant label: ${p.label}`);
		labels.add(p.label);
	}
	if (labels.size === 0) errors.push("scenario.participants must be non-empty");
	if (!Array.isArray(scenario.turns) || scenario.turns.length === 0) {
		errors.push("scenario.turns must be a non-empty array");
	}
	turns.forEach((t, i) => {
		if (!t || typeof t !== "object") {
			errors.push(`turn[${i}] must be an object`);
			return;
		}
		if (!labels.has(t.speaker)) {
			errors.push(`turn[${i}].speaker "${t.speaker}" is not a participant`);
		}
		if (isBlank(t.text) && isBlank(t.audioRef)) {
			errors.push(`turn[${i}] must have either text or audioRef`);
		}
		if (typeof t.expectRespond !== "boolean") {
			errors.push(`turn[${i}].expectRespond must be a boolean`);
		}
		if (
			t.expectEndOfTurn !== undefined &&
			typeof t.expectEndOfTurn !== "boolean"
		) {
			errors.push(`turn[${i}].expectEndOfTurn must be a boolean`);
		}
	});
	for (const agent of agents) {
		if (!labels.has(agent)) {
			errors.push(`agent "${agent}" is not a participant`);
		}
	}
	validateEnvironment(scenario.environment, "scenario.environment", errors);
	turns.forEach((t, i) => {
		validateEnvironment(t?.environment, `turn[${i}].environment`, errors);
	});
	return { valid: errors.length === 0, errors };
}

/** Validate an acoustic environment's ranges (pure; appends to `errors`). */
function validateEnvironment(
	env: VoiceEnvironment | undefined,
	where: string,
	errors: string[],
): void {
	if (!env) return;
	if (
		env.reverb !== undefined &&
		(!Number.isFinite(env.reverb) || env.reverb < 0 || env.reverb > 1)
	) {
		errors.push(`${where}.reverb must be in [0, 1]`);
	}
	if (env.noiseSnrDb !== undefined && !Number.isFinite(env.noiseSnrDb)) {
		errors.push(`${where}.noiseSnrDb must be a finite number`);
	}
	if (
		env.farFieldDb !== undefined &&
		(!Number.isFinite(env.farFieldDb) || env.farFieldDb < 0)
	) {
		errors.push(`${where}.farFieldDb must be a non-negative dB attenuation`);
	}
	if (
		env.backgroundTalkersDb !== undefined &&
		!Number.isFinite(env.backgroundTalkersDb)
	) {
		errors.push(`${where}.backgroundTalkersDb must be a finite number`);
	}
}

/** Merge a turn's environment over the scenario's (turn wins, field by field). */
export function resolveTurnEnvironment(
	scenario: VoiceScenario,
	turn: VoiceScenarioTurn,
): VoiceEnvironment | undefined {
	if (!scenario.environment && !turn.environment) return undefined;
	return { ...scenario.environment, ...turn.environment };
}

/** The expected ASR reference for a turn (explicit override or its text). */
export function turnReferenceTranscript(turn: VoiceScenarioTurn): string {
	return (turn.expectedTranscript ?? turn.text ?? "").trim();
}

/** The expected diarization label for a turn (explicit override or speaker). */
export function turnSpeakerLabel(turn: VoiceScenarioTurn): string {
	return turn.expectedSpeakerLabel ?? turn.speaker;
}

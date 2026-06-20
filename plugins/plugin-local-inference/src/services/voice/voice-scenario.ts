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
	/** Expected ASR transcript (for WER scoring); defaults to `text`. */
	expectedTranscript?: string;
	/** Expected diarization label (defaults to `speaker`). */
	expectedSpeakerLabel?: string;
	/** Expected entity inferred/recognized from this turn (name extraction). */
	expectedEntity?: string;
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
	/** Latency budgets (ms) — first-audio / time-to-first-token, etc. */
	maxFirstAudioMs?: number;
	maxTtftMs?: number;
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
	| "long-form-monologue";

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
export function validateVoiceScenario(
	scenario: VoiceScenario,
): VoiceScenarioValidation {
	const errors: string[] = [];
	if (!scenario.id?.trim()) errors.push("scenario.id is required");
	if (!Array.isArray(scenario.classes) || scenario.classes.length === 0) {
		errors.push("scenario.classes must be a non-empty array");
	}
	const labels = new Set<string>();
	for (const p of scenario.participants ?? []) {
		if (!p.label?.trim()) {
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
	scenario.turns?.forEach((t, i) => {
		if (!labels.has(t.speaker)) {
			errors.push(`turn[${i}].speaker "${t.speaker}" is not a participant`);
		}
		if (!t.text?.trim() && !t.audioRef?.trim()) {
			errors.push(`turn[${i}] must have either text or audioRef`);
		}
		if (typeof t.expectRespond !== "boolean") {
			errors.push(`turn[${i}].expectRespond must be a boolean`);
		}
	});
	for (const agent of scenario.agents ?? []) {
		if (!labels.has(agent)) {
			errors.push(`agent "${agent}" is not a participant`);
		}
	}
	return { valid: errors.length === 0, errors };
}

/** The expected ASR reference for a turn (explicit override or its text). */
export function turnReferenceTranscript(turn: VoiceScenarioTurn): string {
	return (turn.expectedTranscript ?? turn.text ?? "").trim();
}

/** The expected diarization label for a turn (explicit override or speaker). */
export function turnSpeakerLabel(turn: VoiceScenarioTurn): string {
	return turn.expectedSpeakerLabel ?? turn.speaker;
}

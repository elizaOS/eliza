/**
 * Voice Workbench real-decision-logic services adapter (#8785).
 *
 * The ground-truth mock (`groundTruthMockServices`) echoes the corpus labels —
 * it proves the runner → scorers → report wiring, but it can never catch a
 * regression in the DECISION logic because it never runs it. This adapter does:
 * for every turn it runs the REAL, shipped modules —
 *
 *   - end-of-turn:        `scoreEndOfTurnHeuristic` (`@elizaos/shared/voice-eot`)
 *   - respond / echo /    `buildVoiceTurnSignal` (`@elizaos/shared/voice/respond-gate`)
 *     bystander / wake-word   — the SAME gate the UI client ships
 *   - name extraction:    the inline patterns below (mirrors IDENTIFY_SPEAKER)
 *
 * — so the workbench catches a regression in the gate the moment it lands. It is
 * CI-runnable with NO models or network: it makes the perfect-ASR /
 * perfect-diarization assumption (transcript + speaker label come from ground
 * truth), so it does NOT measure ASR WER, diarization DER, EOT latency, or
 * acoustic speaker verification — those need the real model lane. What it DOES
 * measure is genuine: EOT decisions, the respond/echo/bystander/wake-word
 * decision, and name extraction.
 */

import {
	type OwnerObservation,
	resolveOwnerCandidate,
} from "@elizaos/shared/voice/owner-inference";
import { buildVoiceTurnSignal } from "@elizaos/shared/voice/respond-gate";
import { scoreEndOfTurnHeuristic } from "@elizaos/shared/voice-eot";
import type { CorpusGroundTruth } from "./corpus-generator";
import type {
	VoiceTurnObservation,
	VoiceWorkbenchServices,
} from "./workbench-headless-runner";

/** Wake phrase the agent answers to without other addressing. */
const WAKE_WORD = /\bhey\s+eliza\b/i;

/** Commit threshold for the syntactic EOT heuristic (matches TurnAggregator). */
const EOT_COMMIT_THRESHOLD = 0.5;

/** "my name is X" / "I am X" / "this is X" / "call me X" → the spoken name. */
const NAME_PATTERNS: RegExp[] = [
	/\bmy name is\s+([a-z]+)/i,
	/\bi am\s+([a-z]+)/i,
	/\bi'm\s+([a-z]+)/i,
	/\bthis is\s+([a-z]+)/i,
	/\bcall me\s+([a-z]+)/i,
];

function extractName(transcript: string): string | null {
	for (const re of NAME_PATTERNS) {
		const m = transcript.match(re);
		if (m?.[1]) return m[1].toLowerCase();
	}
	return null;
}

/** Default enrolled set: every participant the corpus bound to an entity. */
function knownSpeakerIds(groundTruth: CorpusGroundTruth): string[] {
	if (groundTruth.knownSpeakerEntityIds)
		return groundTruth.knownSpeakerEntityIds;
	const ids: string[] = [];
	for (const p of groundTruth.participants)
		if (p.entityId) ids.push(p.entityId);
	return ids;
}

/**
 * Build a services adapter that runs the real decision logic. Stateful across a
 * scenario's turns (it remembers the agent's last reply so a following
 * `isAgentEcho` turn is gated against a genuine reply string); state resets at
 * each scenario's first turn.
 */
export function realDecisionLogicServices(): VoiceWorkbenchServices {
	let scenarioId: string | null = null;
	let lastAgentReply: string | undefined;
	let ownerObservations: OwnerObservation[] = [];

	return {
		async observeTurn({ label, groundTruth }): Promise<VoiceTurnObservation> {
			// New scenario → drop carried-over reply state (the runner reuses one
			// services instance across the whole matrix).
			if (groundTruth.scenarioId !== scenarioId || label.index === 0) {
				scenarioId = groundTruth.scenarioId;
				lastAgentReply = undefined;
				ownerObservations = [];
			}

			// Perfect-ASR / perfect-diarization assumption: the transcript and the
			// speaker identity come from ground truth so the DECISION logic — not
			// the acoustic models — is what we score here.
			const transcript = label.referenceTranscript;
			const wakeWordActive = WAKE_WORD.test(transcript);
			const known = knownSpeakerIds(groundTruth);

			const signal = buildVoiceTurnSignal(transcript, {
				...(lastAgentReply ? { recentAgentReply: lastAgentReply } : {}),
				replyAgeMs: 500,
				agentSpeaking: label.isAgentEcho === true,
				speaker: {
					entityId: label.entityId ?? null,
					confidence: 0.9,
					isOwner: label.isOwner === true,
				},
				wakeWordActive,
				knownSpeakerEntityIds: known,
				// Explicitly de-scoped fixture (#9427): in this headless lane no
				// real speaker-embedding similarity is computed, so an agent-echo
				// turn is fed a fixed above-threshold value purely to exercise the
				// downstream self-voice gate's PLUMBING (that it consumes the
				// signal), NOT to validate acoustic self-voice matching — that
				// needs a live speaker encoder and belongs to the real-audio lane.
				...(label.isAgentEcho ? { selfVoiceSimilarity: 0.9 } : {}),
			});
			// The server gate suppresses unless `nextSpeaker === "agent"`, which folds
			// in BOTH the respond/bystander/echo decision AND the EOT gate (a turn that
			// trails off mid-clause is "user", not "agent"). Transcription mode is a
			// dictation mode where the agent never speaks, regardless of the gate.
			const transcriptionMode =
				groundTruth.classes.includes("transcription-mode");
			const responded = !transcriptionMode && signal.nextSpeaker === "agent";

			const eotProbability = scoreEndOfTurnHeuristic(transcript);
			const eotDecided = eotProbability >= EOT_COMMIT_THRESHOLD;

			const name = extractName(transcript);
			const inferredEntities: string[] = [];
			if (name) {
				const match = groundTruth.participants.find(
					(p) => p.label.toLowerCase() === name && p.entityId,
				);
				if (match?.entityId) inferredEntities.push(match.entityId);
			}

			// Remember a genuine reply so the NEXT turn's echo gate has something to
			// compare against (echo turns set `agentReplyText` on the prior turn).
			if (responded && label.agentReplyText)
				lastAgentReply = label.agentReplyText;

			// Owner inference: accumulate recognized turns and run the REAL resolver
			// (`resolveOwnerCandidate`). Once it commits a candidate, the owner is
			// whoever it named — genuine inference, not ground truth. Until then it
			// is undecided, so fall back to the perfect-attribution `isOwner` flag.
			if (label.entityId && !label.isAgentEcho) {
				ownerObservations.push({ entityId: label.entityId, confidence: 0.9 });
			}
			const ownerCandidate = resolveOwnerCandidate(ownerObservations);
			const predictedOwner =
				ownerCandidate.ownerEntityId !== null
					? label.entityId === ownerCandidate.ownerEntityId
					: label.isOwner === true;

			return {
				hypothesisTranscript: transcript,
				predictedSpeakerLabel: label.speaker,
				eotDecided,
				responded,
				inferredEntities,
				matchedEntityId: label.entityId ?? null,
				predictedOwner,
				...(responded ? { firstAudioMs: 250 } : {}),
			};
		},
	};
}

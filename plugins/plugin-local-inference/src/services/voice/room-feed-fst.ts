/**
 * Deterministic room-feed finite-state classifier for meeting audio/video.
 * It classifies whether one platform participant is likely one person, a room
 * feed, a multi-speaker room, or a speaker-split candidate without binding
 * identity unless provenance comes from voice profile or user correction.
 */

export type RoomFeedState =
	| "unknown"
	| "individual_feed_likely"
	| "room_feed_suspected"
	| "room_feed_confirmed"
	| "multi_speaker_room"
	| "speaker_candidates_split"
	| "profile_bound";

export type RoomFeedCaptureMode =
	| "bot"
	| "platform_artifact"
	| "bot_free_tab"
	| "system_audio"
	| "local_mic"
	| "mobile_room_mic"
	| "room_mic"
	| "benchmark_import"
	| "unknown";

export type RoomFeedParticipantKind =
	| "person"
	| "room"
	| "device"
	| "shared_screen"
	| "unknown";

export type RoomFeedSourceKind =
	| "participant_audio"
	| "mixed_system_audio"
	| "tab_audio"
	| "local_mic"
	| "mobile_mic"
	| "room_mic"
	| "recording"
	| "benchmark_corpus"
	| "unknown";

export type RoomFeedNameEvidenceSource =
	| "platform_roster"
	| "calendar"
	| "self_introduction"
	| "user_correction"
	| "voice_profile";

export type RoomFeedReasonCode =
	| "active_speaker_continuity"
	| "ambiguous_low_confidence"
	| "audio_visual_count_agree"
	| "candidate_speakers_inside_participant"
	| "capture_mode_room"
	| "contradictory_signals"
	| "diarized_multiple_speakers"
	| "insufficient_evidence"
	| "mixed_capture_source"
	| "participant_declared_person"
	| "participant_declared_room"
	| "profile_match_with_provenance"
	| "review_required"
	| "sensitive_attribute_guardrail"
	| "single_speaker_single_face"
	| "user_corrected_identity"
	| "visible_multiple_people";

export interface RoomFeedParticipantMetadata {
	id?: string;
	displayName?: string;
	kind?: RoomFeedParticipantKind;
	isRoomResource?: boolean;
}

export interface RoomFeedSourceStreamMetadata {
	id?: string;
	kind?: RoomFeedSourceKind;
	isMixed?: boolean;
}

export interface RoomFeedNameEvidence {
	speakerId: string;
	name: string;
	source: RoomFeedNameEvidenceSource;
	confidence: number;
}

export interface RoomFeedVoiceProfileMatch {
	speakerId: string;
	profileId: string;
	entityId?: string;
	displayName?: string;
	confidence: number;
}

export interface ClassifyRoomFeedInput {
	captureMode?: RoomFeedCaptureMode;
	platformParticipant?: RoomFeedParticipantMetadata;
	sourceStream?: RoomFeedSourceStreamMetadata;
	diarizedSpeakerCount?: number;
	speakerCountConfidence?: number;
	overlapRatio?: number;
	visiblePersonCount?: number;
	faceCountConfidence?: number;
	activeSpeakerContinuity?: number;
	nameEvidence?: RoomFeedNameEvidence[];
	voiceProfileMatches?: RoomFeedVoiceProfileMatch[];
	sensitiveAttributeGuardrail?: boolean;
}

export interface RoomFeedCandidateSpeaker {
	speakerId: string;
	displayName?: string;
	profileId?: string;
	entityId?: string;
	confidence: number;
	provenance: RoomFeedNameEvidenceSource[];
	bindingAllowed: boolean;
	requiresReview: boolean;
}

export interface RoomFeedUiHint {
	code:
		| "participant_may_represent_room"
		| "split_speaker_candidates"
		| "review_before_identity_binding"
		| "withhold_sensitive_identity";
	message: string;
}

export interface RoomFeedClassification {
	state: RoomFeedState;
	confidence: number;
	confidenceLevel: "low" | "medium" | "high";
	reasonCodes: RoomFeedReasonCode[];
	candidateSpeakers: RoomFeedCandidateSpeaker[];
	uiHints: RoomFeedUiHint[];
	requiresReview: boolean;
	withholdSpeakerNames: boolean;
}

const ROOM_CAPTURE_MODES = new Set<RoomFeedCaptureMode>([
	"local_mic",
	"mobile_room_mic",
	"room_mic",
	"system_audio",
	"bot_free_tab",
]);

const MIXED_SOURCE_KINDS = new Set<RoomFeedSourceKind>([
	"mixed_system_audio",
	"tab_audio",
	"local_mic",
	"mobile_mic",
	"room_mic",
	"recording",
	"benchmark_corpus",
]);

const BINDING_PROVENANCE = new Set<RoomFeedNameEvidenceSource>([
	"user_correction",
	"voice_profile",
]);

const ALLOWED_TRANSITIONS: Record<RoomFeedState, ReadonlySet<RoomFeedState>> = {
	unknown: new Set([
		"unknown",
		"individual_feed_likely",
		"room_feed_suspected",
		"room_feed_confirmed",
		"multi_speaker_room",
		"speaker_candidates_split",
		"profile_bound",
	]),
	individual_feed_likely: new Set([
		"individual_feed_likely",
		"room_feed_suspected",
		"profile_bound",
		"unknown",
	]),
	room_feed_suspected: new Set([
		"room_feed_suspected",
		"room_feed_confirmed",
		"multi_speaker_room",
		"speaker_candidates_split",
		"unknown",
	]),
	room_feed_confirmed: new Set([
		"room_feed_confirmed",
		"multi_speaker_room",
		"speaker_candidates_split",
		"unknown",
	]),
	multi_speaker_room: new Set([
		"multi_speaker_room",
		"speaker_candidates_split",
		"profile_bound",
		"unknown",
	]),
	speaker_candidates_split: new Set([
		"speaker_candidates_split",
		"multi_speaker_room",
		"profile_bound",
		"unknown",
	]),
	profile_bound: new Set(["profile_bound", "room_feed_suspected", "unknown"]),
};

function assertNonNegativeInteger(
	name: string,
	value: number | undefined,
): void {
	if (value === undefined) return;
	if (!Number.isInteger(value) || value < 0) {
		throw new Error(`[room-feed-fst] ${name} must be a non-negative integer`);
	}
}

function assertRatio(name: string, value: number | undefined): void {
	if (value === undefined) return;
	if (!Number.isFinite(value) || value < 0 || value > 1) {
		throw new Error(`[room-feed-fst] ${name} must be between 0 and 1`);
	}
}

function round(value: number): number {
	return Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000;
}

function confidenceLevel(
	confidence: number,
): RoomFeedClassification["confidenceLevel"] {
	if (confidence >= 0.8) return "high";
	if (confidence >= 0.55) return "medium";
	return "low";
}

function uniqueReasons(reasons: RoomFeedReasonCode[]): RoomFeedReasonCode[] {
	return [...new Set(reasons)].sort();
}

function maxConfidence(
	values: Array<number | undefined>,
	fallback: number,
): number {
	let max = fallback;
	for (const value of values) {
		if (value !== undefined && value > max) max = value;
	}
	return max;
}

function validateInput(input: ClassifyRoomFeedInput): void {
	assertNonNegativeInteger("diarizedSpeakerCount", input.diarizedSpeakerCount);
	assertNonNegativeInteger("visiblePersonCount", input.visiblePersonCount);
	assertRatio("speakerCountConfidence", input.speakerCountConfidence);
	assertRatio("overlapRatio", input.overlapRatio);
	assertRatio("faceCountConfidence", input.faceCountConfidence);
	assertRatio("activeSpeakerContinuity", input.activeSpeakerContinuity);
	for (const evidence of input.nameEvidence ?? []) {
		assertRatio(
			`nameEvidence.${evidence.speakerId}.confidence`,
			evidence.confidence,
		);
	}
	for (const match of input.voiceProfileMatches ?? []) {
		assertRatio(
			`voiceProfileMatches.${match.speakerId}.confidence`,
			match.confidence,
		);
	}
}

function buildCandidates(
	input: ClassifyRoomFeedInput,
	withholdSpeakerNames: boolean,
): RoomFeedCandidateSpeaker[] {
	const candidates = new Map<string, RoomFeedCandidateSpeaker>();
	const ensure = (speakerId: string): RoomFeedCandidateSpeaker => {
		const existing = candidates.get(speakerId);
		if (existing) return existing;
		const created: RoomFeedCandidateSpeaker = {
			speakerId,
			confidence: 0,
			provenance: [],
			bindingAllowed: false,
			requiresReview: true,
		};
		candidates.set(speakerId, created);
		return created;
	};

	for (const evidence of input.nameEvidence ?? []) {
		const candidate = ensure(evidence.speakerId);
		candidate.confidence = Math.max(candidate.confidence, evidence.confidence);
		if (!candidate.provenance.includes(evidence.source)) {
			candidate.provenance.push(evidence.source);
		}
		if (!withholdSpeakerNames && !candidate.displayName) {
			candidate.displayName = evidence.name;
		}
		if (BINDING_PROVENANCE.has(evidence.source)) {
			candidate.bindingAllowed = true;
		}
	}

	for (const match of input.voiceProfileMatches ?? []) {
		const candidate = ensure(match.speakerId);
		candidate.confidence = Math.max(candidate.confidence, match.confidence);
		candidate.profileId = match.profileId;
		candidate.entityId = match.entityId;
		if (!candidate.provenance.includes("voice_profile")) {
			candidate.provenance.push("voice_profile");
		}
		if (!withholdSpeakerNames && !candidate.displayName) {
			candidate.displayName = match.displayName;
		}
		candidate.bindingAllowed = true;
	}

	for (const candidate of candidates.values()) {
		candidate.provenance.sort();
		candidate.requiresReview =
			withholdSpeakerNames ||
			!candidate.bindingAllowed ||
			candidate.confidence < 0.85;
		if (withholdSpeakerNames) {
			delete candidate.displayName;
			delete candidate.entityId;
		}
	}

	return [...candidates.values()].sort((a, b) =>
		a.speakerId.localeCompare(b.speakerId),
	);
}

export function classifyRoomFeed(
	input: ClassifyRoomFeedInput,
): RoomFeedClassification {
	validateInput(input);

	const participant = input.platformParticipant;
	const stream = input.sourceStream;
	const speakerCount = input.diarizedSpeakerCount ?? 0;
	const speakerConfidence = input.speakerCountConfidence ?? 0;
	const visibleCount = input.visiblePersonCount ?? 0;
	const faceConfidence = input.faceCountConfidence ?? 0;
	const activeContinuity = input.activeSpeakerContinuity ?? 0;
	const overlap = input.overlapRatio ?? 0;
	const captureMode = input.captureMode ?? "unknown";

	const reasons: RoomFeedReasonCode[] = [];
	const uiHints: RoomFeedUiHint[] = [];
	const participantRoom =
		participant?.isRoomResource === true || participant?.kind === "room";
	const participantPerson = participant?.kind === "person";
	const mixedSource =
		stream?.isMixed === true ||
		(stream?.kind !== undefined && MIXED_SOURCE_KINDS.has(stream.kind));
	const roomCapture = ROOM_CAPTURE_MODES.has(captureMode);
	const audioMulti = speakerCount >= 2 && speakerConfidence >= 0.7;
	const visualMulti = visibleCount >= 2 && faceConfidence >= 0.65;
	const highProfileMatches = (input.voiceProfileMatches ?? []).filter(
		(match) => match.confidence >= 0.85,
	);
	const userCorrections = (input.nameEvidence ?? []).filter(
		(evidence) =>
			evidence.source === "user_correction" && evidence.confidence >= 0.85,
	);
	const withholdSpeakerNames = input.sensitiveAttributeGuardrail === true;

	if (input.sensitiveAttributeGuardrail)
		reasons.push("sensitive_attribute_guardrail");
	if (participantRoom) reasons.push("participant_declared_room");
	if (participantPerson) reasons.push("participant_declared_person");
	if (mixedSource) reasons.push("mixed_capture_source");
	if (roomCapture) reasons.push("capture_mode_room");
	if (audioMulti) reasons.push("diarized_multiple_speakers");
	if (visualMulti) reasons.push("visible_multiple_people");
	if (activeContinuity >= 0.85) reasons.push("active_speaker_continuity");
	if (speakerCount <= 1 && visibleCount <= 1 && activeContinuity >= 0.7) {
		reasons.push("single_speaker_single_face");
	}
	if (audioMulti && visualMulti) reasons.push("audio_visual_count_agree");
	if (highProfileMatches.length > 0)
		reasons.push("profile_match_with_provenance");
	if (userCorrections.length > 0) reasons.push("user_corrected_identity");

	const contradictory =
		(participantPerson &&
			audioMulti &&
			visibleCount <= 1 &&
			faceConfidence >= 0.75) ||
		(activeContinuity >= 0.9 && audioMulti && overlap < 0.08);
	if (contradictory) reasons.push("contradictory_signals");

	let state: RoomFeedState = "unknown";
	let confidence = 0.35;
	let requiresReview = true;

	if (withholdSpeakerNames) {
		state = "unknown";
		confidence = 0.2;
		reasons.push("review_required");
	} else if (
		(highProfileMatches.length > 0 || userCorrections.length > 0) &&
		speakerCount <= 1 &&
		!audioMulti
	) {
		state = "profile_bound";
		confidence = maxConfidence(
			[
				...highProfileMatches.map((match) => match.confidence),
				...userCorrections.map((evidence) => evidence.confidence),
			],
			0.85,
		);
		requiresReview = confidence < 0.92;
	} else if (audioMulti && (participantRoom || mixedSource || roomCapture)) {
		state = "multi_speaker_room";
		confidence = maxConfidence(
			[speakerConfidence, faceConfidence, overlap >= 0.2 ? 0.86 : undefined],
			0.82,
		);
		requiresReview = false;
	} else if (audioMulti && participantPerson && !participantRoom) {
		state = "speaker_candidates_split";
		confidence = maxConfidence([speakerConfidence], 0.78);
		requiresReview = true;
		reasons.push("candidate_speakers_inside_participant", "review_required");
	} else if (
		participantRoom ||
		(mixedSource && roomCapture && (audioMulti || visualMulti))
	) {
		state = "room_feed_confirmed";
		confidence = maxConfidence([speakerConfidence, faceConfidence], 0.8);
		requiresReview = false;
	} else if (audioMulti || visualMulti || mixedSource || roomCapture) {
		state = "room_feed_suspected";
		confidence = maxConfidence([speakerConfidence, faceConfidence], 0.58);
		requiresReview = true;
		reasons.push("review_required");
	} else if (
		participantPerson &&
		speakerCount <= 1 &&
		visibleCount <= 1 &&
		activeContinuity >= 0.7
	) {
		state = "individual_feed_likely";
		confidence = maxConfidence(
			[activeContinuity, speakerConfidence, faceConfidence],
			0.74,
		);
		requiresReview = false;
	} else {
		state = "unknown";
		confidence = 0.35;
		reasons.push("insufficient_evidence");
	}

	if (contradictory && state !== "speaker_candidates_split") {
		state = "unknown";
		confidence = 0.38;
		requiresReview = true;
		reasons.push("review_required");
	}
	if (confidence < 0.55) reasons.push("ambiguous_low_confidence");

	if (
		state === "room_feed_suspected" ||
		state === "room_feed_confirmed" ||
		state === "multi_speaker_room"
	) {
		uiHints.push({
			code: "participant_may_represent_room",
			message: "This participant may represent a room or shared audio feed.",
		});
	}
	if (state === "speaker_candidates_split" || state === "multi_speaker_room") {
		uiHints.push({
			code: "split_speaker_candidates",
			message: "Suggest splitting transcript speakers inside this participant.",
		});
	}
	if (requiresReview) {
		uiHints.push({
			code: "review_before_identity_binding",
			message: "Review evidence before binding speaker identity.",
		});
	}
	if (withholdSpeakerNames) {
		uiHints.push({
			code: "withhold_sensitive_identity",
			message:
				"Speaker names are withheld until sensitive-attribute review is complete.",
		});
	}

	return {
		state,
		confidence: round(confidence),
		confidenceLevel: confidenceLevel(confidence),
		reasonCodes: uniqueReasons(reasons),
		candidateSpeakers: buildCandidates(input, withholdSpeakerNames),
		uiHints,
		requiresReview,
		withholdSpeakerNames,
	};
}

export function isRoomFeedTransitionAllowed(
	from: RoomFeedState,
	to: RoomFeedState,
): boolean {
	return ALLOWED_TRANSITIONS[from].has(to);
}

export function assertRoomFeedTransition(
	from: RoomFeedState,
	to: RoomFeedState,
): void {
	if (!isRoomFeedTransitionAllowed(from, to)) {
		throw new Error(`[room-feed-fst] invalid transition ${from} -> ${to}`);
	}
}

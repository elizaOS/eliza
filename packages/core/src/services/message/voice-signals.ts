/** Interprets voice channel, speaker, and turn metadata for message response arbitration. */
import type { Memory } from "../../types/memory";
import { ChannelType } from "../../types/primitives";

export function isVoiceChannelMessage(
	message: Pick<Memory, "content">,
): boolean {
	return (
		message.content?.channelType === ChannelType.VOICE_DM ||
		message.content?.channelType === ChannelType.VOICE_GROUP
	);
}

/** A multi-party voice room (≥1 agent, ≥1 human / other agents). */
export function isVoiceGroupChannelMessage(
	message: Pick<Memory, "content">,
): boolean {
	return message.content?.channelType === ChannelType.VOICE_GROUP;
}

/**
 * Multi-agent / multi-speaker voice-room turn-taking (#8786). An agent DEFERS
 * (suppresses its reply) when the turn is explicitly addressed to OTHER
 * participants and not to this agent — the "only the addressed agent replies"
 * contract that keeps ≥3-participant rooms from devolving into a cross-talk
 * storm where every agent answers every utterance.
 *
 * Pure + deterministic. An empty `addressedTo` (no explicit target) never
 * suppresses — normal `shouldRespond` decides — so a single-agent group room
 * and undirected questions are unaffected; only an utterance directed AT a
 * named participant who is not this agent is gated. Fails OPEN (no suppression)
 * when this agent cannot be identified.
 */
export function voiceGroupAddressSuppressesAgent(
	addressedTo: readonly string[] | undefined,
	selfIdentifiers: readonly string[],
): boolean {
	if (!Array.isArray(addressedTo) || addressedTo.length === 0) return false;
	const self = new Set(
		selfIdentifiers.map((s) => s.trim().toLowerCase()).filter(Boolean),
	);
	if (self.size === 0) return false; // can't identify self → fail open
	const targets = addressedTo
		.map((t) => t.trim().toLowerCase())
		.filter(Boolean);
	if (targets.length === 0) return false;
	// Addressed to me (possibly among others) → not suppressed. Addressed only
	// to others → defer to the agent who was named.
	return !targets.some((t) => self.has(t));
}

export type VoiceTurnSignalMetadata = {
	endOfTurnProbability?: number;
	nextSpeaker?: "agent" | "user" | "unknown";
	agentShouldSpeak?: boolean | null;
	source?: string;
	model?: string;
};

export function getVoiceTurnSignalMetadata(
	message: Pick<Memory, "content">,
): VoiceTurnSignalMetadata | null {
	const content = message.content;
	// The in-process voice path writes `content.voiceTurnSignal` at top level,
	// but chat clients nest custom fields under `content.metadata` — that's where
	// the conversation route persists a request's `metadata` object (see
	// buildUserMessages in agent/api/server-helpers). Read both so the gate sees
	// the ambient signal regardless of which entry point produced the turn.
	const nested =
		content?.metadata &&
		typeof content.metadata === "object" &&
		!Array.isArray(content.metadata)
			? (content.metadata as Record<string, unknown>).voiceTurnSignal
			: undefined;
	const value = content?.voiceTurnSignal ?? nested;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	const raw = value as Record<string, unknown>;
	const signal: VoiceTurnSignalMetadata = {};
	if (typeof raw.endOfTurnProbability === "number") {
		signal.endOfTurnProbability = raw.endOfTurnProbability;
	}
	if (
		raw.nextSpeaker === "agent" ||
		raw.nextSpeaker === "user" ||
		raw.nextSpeaker === "unknown"
	) {
		signal.nextSpeaker = raw.nextSpeaker;
	}
	const agentShouldSpeak = raw.agentShouldSpeak;
	if (typeof agentShouldSpeak === "boolean") {
		signal.agentShouldSpeak = agentShouldSpeak;
	} else if (agentShouldSpeak === null) {
		signal.agentShouldSpeak = null;
	}
	if (typeof raw.source === "string") signal.source = raw.source;
	if (typeof raw.model === "string") signal.model = raw.model;
	return Object.keys(signal).length > 0 ? signal : null;
}

/**
 * The resolved speaker entity for a voice turn (#8786). Voice attribution
 * (imprint cluster → entityId) writes `speakerEntityId` onto the turn; like
 * {@link getVoiceTurnSignalMetadata} it can arrive top-level (`content.speaker
 * EntityId`, the in-process engine path) or nested under `content.metadata`
 * (chat clients). Returns the trimmed id, or null when the speaker is unbound.
 */
export function getVoiceSpeakerEntityId(
	message: Pick<Memory, "content">,
): string | null {
	const content = message.content;
	const nested =
		content?.metadata &&
		typeof content.metadata === "object" &&
		!Array.isArray(content.metadata)
			? (content.metadata as Record<string, unknown>).speakerEntityId
			: undefined;
	const value =
		(content as { speakerEntityId?: unknown } | undefined)?.speakerEntityId ??
		nested;
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export function voiceTurnSignalSuppressesAgent(
	signal: VoiceTurnSignalMetadata | null,
): boolean {
	if (!signal) return false;
	return (
		signal.agentShouldSpeak === false ||
		signal.nextSpeaker === "user" ||
		(typeof signal.endOfTurnProbability === "number" &&
			signal.endOfTurnProbability < 0.4)
	);
}

/**
 * The turn signal POSITIVELY confirms the agent should reply — the server-side
 * "decide, don't just veto" path (#8786). Conservative: it only fires on the
 * EXPLICIT `agentShouldSpeak === true` signal (the client sets this on a
 * wake-word / direct-address turn), and only when end-of-turn doesn't read as
 * the user still talking. Used to PROMOTE an IGNORE to RESPOND; it never
 * overrides an explicit STOP or an already-RESPOND decision.
 */
export function voiceTurnSignalConfirmsAgent(
	signal: VoiceTurnSignalMetadata | null,
): boolean {
	if (!signal) return false;
	return (
		signal.agentShouldSpeak === true &&
		signal.nextSpeaker !== "user" &&
		(typeof signal.endOfTurnProbability !== "number" ||
			signal.endOfTurnProbability >= 0.4)
	);
}

/**
 * Read the transcription-mode flag off a turn. Mirrors
 * {@link getVoiceTurnSignalMetadata}: chat clients nest custom fields under
 * `content.metadata` (where the conversation route persists a request's
 * `metadata`), while in-process callers may set `content.transcriptionMode`
 * at top level — read both. Transcription mode records the user turn into the
 * conversation but suppresses the agent's reply (long-form "transcribe, agent
 * stays silent until an exit phrase").
 */
export function transcriptionModeActive(
	message: Pick<Memory, "content">,
): boolean {
	const content = message.content;
	if (content?.transcriptionMode === true) return true;
	const metadata = content?.metadata;
	if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
		return (metadata as Record<string, unknown>).transcriptionMode === true;
	}
	return false;
}

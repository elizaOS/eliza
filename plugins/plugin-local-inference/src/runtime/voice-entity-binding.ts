/**
 * Voice ⇄ entity binding seam (producer + round-trip consumer).
 *
 * Producer (`emitVoiceTurnObserved`): emit `VOICE_TURN_OBSERVED` so a
 * merge-engine owner (plugin-lifeops) can fold the recognized voice turn
 * into the entity/relationship graph. The voice-profile store is owned
 * here; the entity graph is owned there; the only shared surface is the
 * core event seam — neither plugin imports the other.
 *
 * Consumer (`handleVoiceEntityBound`): when the merge engine reports a
 * binding via `VOICE_ENTITY_BOUND`, persist the resulting `entityId` onto
 * every profile in that imprint cluster (`VoiceProfileStore.bindEntity`).
 * This is the runtime path that was missing in issue #8234 — without it a
 * profile's `entityId` stayed `null` and recognized speakers never reached
 * the relationship graph.
 */

import crypto from "node:crypto";
import path from "node:path";
import {
	EventType,
	type IAgentRuntime,
	logger,
	resolveStateDir,
	type VoiceEntityBoundPayload,
} from "@elizaos/core";
import {
	AGENT_SELF_VOICE_THRESHOLD,
	ECHO_WINDOW_MS,
} from "@elizaos/shared/voice/respond-gate";
import type {
	VoiceNextSpeaker,
	VoiceTurnSignal,
} from "../services/voice/eot-classifier.js";
import { VoiceProfileStore } from "../services/voice/profile-store.js";
import type { VoiceAttributionOutput } from "../services/voice/speaker/attribution-pipeline.js";

// ---------------------------------------------------------------------------
// Store wiring (injectable for tests, mirrors the route handlers)
// ---------------------------------------------------------------------------

let storeOverride: VoiceProfileStore | null = null;

export function setVoiceEntityBindingStore(
	store: VoiceProfileStore | null,
): void {
	storeOverride = store;
}

export async function getVoiceProfileStore(): Promise<VoiceProfileStore> {
	if (storeOverride) return storeOverride;
	const store = new VoiceProfileStore({
		rootDir: path.join(resolveStateDir(), "voice-profiles"),
	});
	await store.init();
	return store;
}

// ---------------------------------------------------------------------------
// Producer
// ---------------------------------------------------------------------------

export interface EmitVoiceTurnObservedArgs {
	/** Stable utterance id; a random one is minted when omitted. */
	turnId?: string;
	/** Recognized text (drives name/partner-claim extraction downstream). */
	text: string;
	/** Imprint cluster id from the voice-profile store. */
	imprintClusterId: string;
	/** Confidence of the imprint match (0..1). */
	matchConfidence: number;
	/** Entity the imprint already resolved to, or `null`/omitted when unbound. */
	matchedEntityId?: string | null;
	/** True when the OWNER spoke this turn. */
	isOwner?: boolean;
	/** ISO timestamp; defaults to now. */
	observedAt?: string;
}

/**
 * Emit `VOICE_TURN_OBSERVED`. No-op in effect when no merge-engine plugin
 * is loaded (the event simply has no handler). `emitEvent` awaits every
 * handler, so by the time this resolves the binding round-trip (including
 * `VOICE_ENTITY_BOUND` → profile persist) has completed.
 */
export async function emitVoiceTurnObserved(
	runtime: IAgentRuntime,
	args: EmitVoiceTurnObservedArgs,
): Promise<void> {
	await runtime.emitEvent(EventType.VOICE_TURN_OBSERVED, {
		runtime,
		turnId: args.turnId ?? `vturn_${crypto.randomUUID()}`,
		text: args.text,
		imprintClusterId: args.imprintClusterId,
		matchConfidence: args.matchConfidence,
		matchedEntityId: args.matchedEntityId ?? null,
		observedAt: args.observedAt ?? new Date().toISOString(),
		...(args.isOwner !== undefined ? { isOwner: args.isOwner } : {}),
	});
}

// ---------------------------------------------------------------------------
// Live-turn attribution → VOICE_TURN_OBSERVED + voiceTurnSignal (gating)
// ---------------------------------------------------------------------------

/** Server SUPPRESS threshold for EOT — below this reads as "user still talking". */
const SERVER_EOT_SUPPRESS_THRESHOLD = 0.4;
/** Only a CONFIDENT bystander attribution is allowed to silence a turn. */
const BYSTANDER_SUPPRESS_CONFIDENCE = 0.7;

export interface HandleLiveVoiceAttributionOptions {
	/**
	 * Entity id the agent treats as the device owner / primary enrolled
	 * speaker. A turn attributed to this entity is always allowed to speak.
	 */
	ownerEntityId?: string | null;
	/**
	 * Entity ids the agent answers to without a wake word (owner + enrolled
	 * household members). A confident bystander is anyone attributed to an
	 * entity NOT in this set.
	 */
	knownSpeakerEntityIds?: readonly string[];
	/**
	 * The EOT-based turn signal the turn-controller already computed for this
	 * turn (from `eot-classifier` / `turn-controller`). The speaker decision is
	 * folded into it. When omitted, a neutral base is synthesized from
	 * `endOfTurnProbability` (default 0.5 — "unknown", fail open).
	 */
	baseSignal?: VoiceTurnSignal;
	/** P(turn complete) when no `baseSignal` is supplied (default 0.5). */
	endOfTurnProbability?: number;
	/** True when a wake word fired within the recent listen window. */
	wakeWordActive?: boolean;
	/**
	 * The ASR transcript for this turn, joined from the streaming-ASR path. When
	 * provided it rides on `VOICE_TURN_OBSERVED` (and the turn signal) so the
	 * merge engine's name/partner extraction (`VoiceObserver.ingestTurn`) runs
	 * from LIVE audio, so live recognition identifies both *who* spoke and
	 * *what* they said (#8786). Diarization-
	 * only callers (audio-frame path) leave it unset; the in-process voice engine
	 * (which has both ASR + diarization) passes the real transcript.
	 */
	transcript?: string;
	/**
	 * Cosine similarity (0..1) between this turn's live WeSpeaker embedding and
	 * the agent's own TTS-voice centroid. High means the open mic is hearing the
	 * agent's playback, not a human user.
	 */
	selfVoiceSimilarity?: number | null;
	/** True while the agent is currently playing TTS. */
	agentSpeaking?: boolean;
	/** Age of the most recent agent-spoken reply in ms. */
	replyAgeMs?: number;
}

/**
 * Resolve owner / enrolled state for the attributed primary speaker.
 *
 * `isOwner` is `entityId === ownerEntityId`; "enrolled" is owner OR an entity
 * id present in `knownSpeakerEntityIds`. An unbound speaker (`entityId == null`)
 * is neither — it can never be a "confident bystander" (fail open).
 */
function resolveSpeakerStanding(
	output: VoiceAttributionOutput,
	opts: HandleLiveVoiceAttributionOptions,
): {
	entityId: string | null;
	confidence: number;
	isOwner: boolean;
	enrolled: boolean;
} {
	const speaker = output.primarySpeaker;
	const entityId = speaker?.entityId ?? output.observation?.entityId ?? null;
	const confidence = speaker?.confidence ?? output.observation?.confidence ?? 0;
	const ownerEntityId = opts.ownerEntityId ?? null;
	const isOwner = entityId !== null && entityId === ownerEntityId;
	const known = new Set<string>(opts.knownSpeakerEntityIds ?? []);
	const enrolled = isOwner || (entityId !== null && known.has(entityId));
	return { entityId, confidence, isOwner, enrolled };
}

/**
 * Compose the EOT base signal with the live speaker decision.
 *
 * Mirrors `packages/ui/src/voice/voice-turn-signal.ts buildVoiceTurnSignal`
 * (the transcript-only producer) on the audio-frame side: a CONFIDENT bystander
 * who did NOT say the wake word is cross-talk → suppress. A wake word is an
 * explicit address → always speak. Uncertain attribution never silences a real
 * turn. The server gate `core.voice_turn_signal` reads the returned object.
 */
function foldSpeakerIntoSignal(
	base: VoiceTurnSignal,
	standing: {
		entityId: string | null;
		confidence: number;
		isOwner: boolean;
		enrolled: boolean;
	},
	opts: HandleLiveVoiceAttributionOptions,
): VoiceTurnSignal {
	let agentShouldSpeak = base.agentShouldSpeak !== false;

	const confidentBystander =
		!standing.enrolled &&
		standing.entityId !== null &&
		standing.confidence >= BYSTANDER_SUPPRESS_CONFIDENCE;
	if (agentShouldSpeak && opts.wakeWordActive !== true && confidentBystander) {
		agentShouldSpeak = false;
	}

	// Wake word overrides bystander doubt — the user deliberately summoned us.
	if (opts.wakeWordActive === true) agentShouldSpeak = true;

	const replyRecent =
		opts.agentSpeaking === true ||
		(opts.replyAgeMs ?? Number.POSITIVE_INFINITY) <= ECHO_WINDOW_MS;
	const isSelfVoice =
		typeof opts.selfVoiceSimilarity === "number" &&
		opts.selfVoiceSimilarity >= AGENT_SELF_VOICE_THRESHOLD &&
		replyRecent;
	if (isSelfVoice) agentShouldSpeak = false;

	const eot = base.endOfTurnProbability;
	const nextSpeaker: VoiceNextSpeaker = !agentShouldSpeak
		? "user"
		: eot < SERVER_EOT_SUPPRESS_THRESHOLD
			? "user"
			: "agent";

	const source = isSelfVoice
		? "voice-bridge+self-voice"
		: opts.wakeWordActive
			? "voice-bridge+wakeword"
			: "voice-bridge+diarization";

	return {
		endOfTurnProbability: eot,
		nextSpeaker,
		agentShouldSpeak,
		source: "custom",
		transcript: base.transcript,
		...(base.model ? { model: base.model } : {}),
		...(base.latencyMs !== undefined ? { latencyMs: base.latencyMs } : {}),
		// Stash the human-readable provenance so traces show the fold source even
		// though the typed `source` enum stays "custom".
		metadata: {
			provenance: source,
			...(typeof opts.selfVoiceSimilarity === "number"
				? { selfVoiceSimilarity: opts.selfVoiceSimilarity }
				: {}),
		},
	} as VoiceTurnSignal & {
		metadata: { provenance: string; selfVoiceSimilarity?: number };
	};
}

/**
 * Handle a live per-turn attribution result. This is the single automatic seam
 * the engine bridge calls from its `onAttribution` path: any caller that wires a
 * `profileStore` gets diarization-driven gating for free.
 *
 * 1. Emits `VOICE_TURN_OBSERVED` when the turn produced a profile observation
 *    (so the merge engine can fold the recognized speaker into the entity
 *    graph and round-trip the binding back onto the profile).
 * 2. Composes the EOT-based turn signal with the speaker decision and stamps it
 *    onto `output.turn.metadata.voiceTurnSignal`, which the chat-view producer
 *    forwards to the server gate verbatim.
 *
 * Returns the composed signal (also written onto the turn metadata in place).
 * Never throws on the emit path — observation emission is best-effort and is
 * logged, never propagated, so an attribution turn never crashes a voice turn.
 */
export async function handleLiveVoiceAttribution(
	runtime: IAgentRuntime,
	output: VoiceAttributionOutput,
	opts: HandleLiveVoiceAttributionOptions = {},
): Promise<VoiceTurnSignal> {
	const standing = resolveSpeakerStanding(output, opts);
	// Carry the real ASR transcript when the caller joined it (in-process engine);
	// fall back to a base-signal transcript, else "" for diarization-only callers.
	const transcript = opts.transcript ?? opts.baseSignal?.transcript ?? "";

	if (output.observation) {
		const obs = output.observation;
		try {
			await emitVoiceTurnObserved(runtime, {
				turnId: output.turnId,
				text: transcript,
				imprintClusterId: obs.imprintClusterId,
				matchConfidence: obs.confidence,
				matchedEntityId: obs.entityId,
				isOwner: standing.isOwner,
			});
		} catch (err) {
			logger.warn(
				{
					turnId: output.turnId,
					imprintClusterId: obs.imprintClusterId,
					error: err instanceof Error ? err.message : String(err),
				},
				"[local-inference] VOICE_TURN_OBSERVED emit failed during live attribution",
			);
		}
	}

	const base: VoiceTurnSignal = opts.baseSignal ?? {
		endOfTurnProbability: opts.endOfTurnProbability ?? 0.5,
		nextSpeaker: "unknown",
		agentShouldSpeak: null,
		source: "custom",
		transcript,
	};

	const signal = foldSpeakerIntoSignal(base, standing, opts);

	const turn = output.turn;
	// Stamp the resolved speaker entity onto the turn (#8786): the imprint →
	// entityId match rides with the transcript so the server/providers/extraction
	// attribute the turn to the right person (not just the EOT gate). Omitted when
	// the speaker is unbound (`entityId == null`) — never write a null speaker.
	turn.metadata = {
		...(turn.metadata ?? {}),
		voiceTurnSignal: signal,
		...(standing.entityId ? { speakerEntityId: standing.entityId } : {}),
	};

	return signal;
}

// ---------------------------------------------------------------------------
// Consumer
// ---------------------------------------------------------------------------

/**
 * Handler for `VOICE_ENTITY_BOUND`. Persists `entityId` onto every profile
 * in the cluster that is not already bound to it. Returns nothing (the
 * `EventHandler` contract); the bound count is logged.
 */
export async function handleVoiceEntityBound(
	payload: VoiceEntityBoundPayload,
): Promise<void> {
	const store = await getVoiceProfileStore();
	const records = await store.list();
	const targets = records.filter(
		(r) =>
			r.imprintClusterId === payload.imprintClusterId &&
			r.entityId !== payload.entityId,
	);
	let bound = 0;
	for (const record of targets) {
		const updated = await store.bindEntity({
			profileId: record.profileId,
			entityId: payload.entityId,
			...(payload.displayName ? { label: payload.displayName } : {}),
		});
		if (updated) bound += 1;
	}
	if (bound > 0) {
		logger.info(
			{
				imprintClusterId: payload.imprintClusterId,
				entityId: payload.entityId,
				bound,
			},
			"[local-inference] persisted voice→entity binding onto profile(s)",
		);
	}
}

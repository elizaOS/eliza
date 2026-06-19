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
import { VoiceProfileStore } from "../services/voice/profile-store.js";

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

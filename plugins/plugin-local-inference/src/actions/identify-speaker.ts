/**
 * @module plugin-local-inference/actions/identify-speaker
 *
 * `IDENTIFY_SPEAKER` agent action — the explicit, user-driven half of the
 * voice → entity binding (issue #8234, shape #2).
 *
 * When the OWNER names a voice the agent just heard but hasn't identified
 * ("that was Jill", "this is my friend Sam"), this action binds the most
 * recently observed *unidentified* speaker profile to a named person. It
 * does not touch the entity graph directly — it emits `VOICE_TURN_OBSERVED`
 * so the merge engine (plugin-lifeops) creates/merges the Entity, then the
 * round-trip `VOICE_ENTITY_BOUND` handler persists `entityId` back onto the
 * voice profile. If no merge-engine plugin is loaded the action is inert
 * beyond logging intent.
 *
 * Target selection: an explicit `profileId` option wins; otherwise the
 * single most-recently-observed profile whose `entityId` is still `null`
 * (i.e. "the person who just spoke and isn't known yet").
 */

import {
	type Action,
	type ActionResult,
	type HandlerCallback,
	type IAgentRuntime,
	logger,
	type Memory,
} from "@elizaos/core";
import {
	emitVoiceTurnObserved,
	getVoiceProfileStore,
} from "../runtime/voice-entity-binding.js";
import type { VoiceProfileRecord } from "../services/voice/profile-store.js";

function extractMessageText(message: Memory | null | undefined): string {
	const content = message?.content;
	if (!content) return "";
	const text = (content as { text?: unknown }).text;
	return typeof text === "string" ? text : "";
}

/**
 * Extract a person name the owner is attaching to a heard voice. Mirrors
 * the trigger phrases lifeops' `extractSelfNameClaim` understands so the
 * downstream entity gets the same `preferredName`. Returns the name or
 * `null`.
 */
const NAME = "[A-Z][A-Za-z'.-]{1,40}(?:\\s+[A-Z][A-Za-z'.-]{1,40}){0,2}";
const SPEAKER_NAME_PATTERNS: RegExp[] = [
	new RegExp(`\\bthat\\s+(?:was|is)\\s+(${NAME})\\b`, "i"),
	new RegExp(`\\bthis\\s+is\\s+(?:my\\s+\\w+\\s+)?(${NAME})\\b`, "i"),
	new RegExp(`\\bcall\\s+(?:him|her|them)\\s+(${NAME})\\b`, "i"),
	new RegExp(`\\b(?:his|her|their)\\s+name\\s+is\\s+(${NAME})\\b`, "i"),
	new RegExp(`\\bnamed?\\s+(${NAME})\\b`, "i"),
	new RegExp(`\\bspeaker\\s+(?:was|is)\\s+(${NAME})\\b`, "i"),
];

export function extractSpeakerName(text: string): string | null {
	for (const pattern of SPEAKER_NAME_PATTERNS) {
		const m = pattern.exec(text);
		if (m?.[1]) {
			const cleaned = m[1].replace(/[.,;:!?]+$/, "").trim();
			if (cleaned.length > 0) return cleaned;
		}
	}
	return null;
}

function pickTarget(
	records: VoiceProfileRecord[],
	explicitProfileId: string | null,
): VoiceProfileRecord | null {
	if (explicitProfileId) {
		return records.find((r) => r.profileId === explicitProfileId) ?? null;
	}
	const unbound = records
		.filter((r) => r.entityId === null)
		.sort((a, b) => b.lastObservedAt.localeCompare(a.lastObservedAt));
	return unbound[0] ?? null;
}

function optionString(options: unknown, key: string): string | null {
	if (!options || typeof options !== "object") return null;
	const value = (options as Record<string, unknown>)[key];
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: null;
}

async function handler(
	runtime: IAgentRuntime,
	message: Memory,
	_state?: unknown,
	options?: unknown,
	callback?: HandlerCallback,
): Promise<ActionResult> {
	const text = extractMessageText(message);
	const name = optionString(options, "name") ?? extractSpeakerName(text);
	if (!name) {
		const out =
			'Tell me the name to attach to the voice you just heard — e.g. "that was Jill".';
		await callback?.({ text: out });
		return { success: false, text: out };
	}

	const store = await getVoiceProfileStore();
	const records = await store.list();
	const target = pickTarget(records, optionString(options, "profileId"));
	if (!target) {
		const out = `I don't have an unidentified recent voice to attach "${name}" to yet.`;
		await callback?.({ text: out });
		return { success: false, text: out };
	}

	// Drive the merge engine through the event seam. `emitEvent` awaits all
	// handlers, so when this resolves the round-trip binding has run.
	try {
		await emitVoiceTurnObserved(runtime, {
			turnId: typeof message.id === "string" ? message.id : undefined,
			text: `This is ${name}.`,
			imprintClusterId: target.imprintClusterId,
			matchConfidence: 1,
			matchedEntityId: null,
			isOwner: false,
		});
	} catch (err) {
		logger.error(
			{ err, profileId: target.profileId, name },
			"[IDENTIFY_SPEAKER] failed to emit voice-turn observation",
		);
		const out = `I couldn't save ${name}'s voice just now.`;
		await callback?.({ text: out });
		return { success: false, text: out, error: out };
	}

	const updated = await store.get(target.profileId);
	const entityId = updated?.entityId ?? null;
	const out = entityId
		? `Got it — I'll remember ${name}'s voice from now on.`
		: `Noted ${name}. I'll bind the voice once identity sync is available.`;
	await callback?.({ text: out });
	return {
		success: true,
		text: out,
		data: {
			profileId: target.profileId,
			imprintClusterId: target.imprintClusterId,
			entityId,
			name,
		},
	};
}

async function validate(
	_runtime: IAgentRuntime,
	message: Memory,
): Promise<boolean> {
	return extractMessageText(message).trim().length > 0;
}

export const identifySpeakerAction: Action = {
	name: "IDENTIFY_SPEAKER",
	similes: ["NAME_SPEAKER", "REMEMBER_VOICE", "THIS_IS_SPEAKER", "TAG_VOICE"],
	description:
		'Attach a name to the most recently heard, still-unidentified voice so the agent recognizes that person across sessions. Use when the owner says who a recent speaker is ("that was Jill", "this is my friend Sam").',
	routingHint:
		"owner names a recent unknown speaker -> IDENTIFY_SPEAKER; not for naming the owner themselves or contacts unrelated to a heard voice",
	validate,
	handler,
	examples: [],
};

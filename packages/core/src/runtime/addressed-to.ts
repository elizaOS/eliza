/**
 * Resolves and persists the message handler's `addressedTo` targets. Upserts
 * "addressed" relationship edges from the speaker to each resolved participant,
 * and decides whether an inbound turn is directed at another participant (so the
 * agent is merely overhearing and should not act on it). All name/id resolution
 * runs against the room's entity list, without an LLM call.
 */
import type { Entity, UUID } from "../types/index";
import type { Memory } from "../types/memory";
import type { IAgentRuntime } from "../types/runtime";

/**
 * Post-parse persistence for the messageHandler's `extract.addressedTo`
 * field. No LLM call: each entry is either a UUID (validated) or a
 * participant name resolved against the room's entity list. For each
 * resolved target we upsert an "addressed" relationship edge from the
 * speaker to the target.
 *
 * The point of folding this into Stage 1 is precisely that it does NOT
 * require its own LLM call — every inbound message already runs the
 * messageHandler, so picking up addressee data is free.
 */

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ADDRESSED_RELATIONSHIP_TAGS = ["addressed", "addressed:auto"] as const;
const ADDRESSED_METADATA_SOURCE = "message_handler_addressedTo";

export interface ApplyAddressedToArgs {
	runtime: IAgentRuntime;
	message: Memory;
	addressedTo: readonly string[];
}

export interface ApplyAddressedToResult {
	created: number;
	updated: number;
	resolved: UUID[];
}

export async function applyAddressedTo(
	args: ApplyAddressedToArgs,
): Promise<ApplyAddressedToResult> {
	const { runtime, message, addressedTo } = args;
	const empty: ApplyAddressedToResult = {
		created: 0,
		updated: 0,
		resolved: [],
	};
	if (!addressedTo || addressedTo.length === 0) {
		return empty;
	}
	const speakerId = message.entityId as UUID | undefined;
	if (!speakerId) {
		return empty;
	}

	const targets = await resolveAddressedTargets({
		runtime,
		message,
		addressedTo,
	});
	if (targets.length === 0) {
		return empty;
	}

	const resolved: UUID[] = [];
	let created = 0;
	let updated = 0;
	const nowIso = new Date().toISOString();

	for (const targetId of targets) {
		if (targetId === speakerId) {
			continue;
		}
		resolved.push(targetId);

		const existingList = await runtime.getRelationships({
			entityIds: [speakerId],
			tags: [ADDRESSED_RELATIONSHIP_TAGS[0]],
		});
		const existing = existingList.find(
			(rel) =>
				rel.sourceEntityId === speakerId && rel.targetEntityId === targetId,
		);

		if (existing) {
			const existingMetadata =
				(existing.metadata as Record<string, unknown> | undefined) ?? {};
			await runtime.updateRelationship({
				...existing,
				tags: dedupeTags([...existing.tags, ...ADDRESSED_RELATIONSHIP_TAGS]),
				metadata: {
					...existingMetadata,
					lastInteractionAt: nowIso,
					source: ADDRESSED_METADATA_SOURCE,
				},
			});
			updated += 1;
			continue;
		}

		await runtime.createRelationship({
			sourceEntityId: speakerId,
			targetEntityId: targetId,
			tags: [...ADDRESSED_RELATIONSHIP_TAGS],
			metadata: {
				lastInteractionAt: nowIso,
				source: ADDRESSED_METADATA_SOURCE,
			},
		});
		created += 1;
	}

	return { created, updated, resolved };
}

interface ResolveTargetsArgs {
	runtime: IAgentRuntime;
	message: Memory;
	addressedTo: readonly string[];
}

/**
 * Detects that the inbound message is explicitly directed at ANOTHER known
 * participant — not this agent — so the agent is merely overhearing. Used to
 * skip the simple→requiresTool promotion so the agent does not fabricate a tool
 * task from a turn it was not asked to act on (#9874 item 1).
 *
 * Uniform, NOT bot-specific: it fires identically whether the other participant
 * is a human or a bot. Bot-ness is surfaced to the model as CONTEXT instead (the
 * conversation transcript tags `fromBot` senders as "Name (bot)"), so how to
 * treat overheard bot crosstalk is the model's call with full context — there is
 * no runtime type-branch on bot-ness here.
 *
 * Returns true only when ALL hold:
 *  - the message carries explicit `addressedTo` targets,
 *  - this agent is NOT among them (by literal name/id/username OR a resolved room
 *    alias),
 *  - at least one addressee RESOLVES to a real room participant other than us.
 *
 * Fails SAFE (returns false) whenever it cannot positively confirm that a
 * different real participant was addressed: empty `addressedTo`, a turn
 * addressed to us, or an addressee that resolves to no real room entity (a bare
 * unrecognized name) all return false — the agent keeps acting on requests meant
 * for it, and DMs / undirected asks (which carry no other-participant addressee)
 * are never gated.
 */
export async function messageAddressedToOtherParticipant(
	args: ApplyAddressedToArgs,
): Promise<boolean> {
	const { runtime, message, addressedTo } = args;
	if (!addressedTo || addressedTo.length === 0) {
		return false;
	}

	const normalize = (value: string) =>
		value.trim().toLowerCase().replace(/^@/, "");
	const self = new Set<string>();
	const selfId = runtime.agentId;
	if (selfId) self.add(selfId.toLowerCase());
	const selfName = runtime.character?.name;
	if (selfName) self.add(normalize(selfName));
	const selfUsername = runtime.character?.username;
	if (selfUsername) self.add(normalize(selfUsername));

	const cleaned = addressedTo
		.map((entry) => (typeof entry === "string" ? entry.trim() : ""))
		.filter((entry) => entry.length > 0);
	if (cleaned.length === 0) {
		return false;
	}

	// Addressed to us by literal name/id → handle normally, never suppress.
	if (cleaned.some((entry) => self.has(normalize(entry)))) {
		return false;
	}

	// Resolve names→ids against the room. This also maps the agent's OWN entity
	// aliases (platform handles like @samantha_ai_bot that connectors store on
	// the agent's entity) to selfId, so a turn addressed to us by an alias is NOT
	// mistaken for an other-participant address.
	const targets = await resolveAddressedTargets({
		runtime,
		message,
		addressedTo,
	});
	if (selfId && targets.some((id) => id === selfId)) {
		return false;
	}

	// Suppress only on a positively-resolved OTHER participant (every remaining
	// target is non-self here). An addressee that resolves to no real entity (a
	// bare unrecognized name) does not gate — the agent keeps acting, and the
	// (bot) transcript tag lets the model handle any residual overheard crosstalk.
	return targets.length > 0;
}

export async function resolveAddressedTargets(
	args: ResolveTargetsArgs,
): Promise<UUID[]> {
	const { runtime, message, addressedTo } = args;
	const cleaned = Array.from(
		new Set(
			addressedTo
				.map((entry) => (typeof entry === "string" ? entry.trim() : ""))
				.filter((entry) => entry.length > 0),
		),
	);
	if (cleaned.length === 0) {
		return [];
	}

	// Direct UUID hits don't require room lookups.
	const uuids = new Set<UUID>();
	const names: string[] = [];
	for (const entry of cleaned) {
		if (UUID_PATTERN.test(entry)) {
			uuids.add(entry as UUID);
		} else {
			names.push(entry);
		}
	}

	if (names.length > 0) {
		const participants = await runtime.getEntitiesForRoom(message.roomId);
		const normalize = (value: string) => value.trim().toLowerCase();
		const byName = new Map<string, UUID>();
		const agentName = runtime.character.name;
		if (agentName) {
			byName.set(normalize(agentName), runtime.agentId);
		}
		for (const entity of participants) {
			const id = entity.id as UUID | undefined;
			if (!id) continue;
			for (const name of entityNames(entity)) {
				byName.set(normalize(name), id);
			}
		}
		for (const name of names) {
			const stripped = name.replace(/^@/, "");
			const hit = byName.get(normalize(stripped));
			if (hit) {
				uuids.add(hit);
			}
		}
	}

	return Array.from(uuids);
}

function entityNames(entity: Entity): string[] {
	const names = entity.names;
	if (!Array.isArray(names)) return [];
	return names.filter(
		(n): n is string => typeof n === "string" && n.length > 0,
	);
}

function dedupeTags(tags: readonly string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const tag of tags) {
		if (typeof tag !== "string" || tag.length === 0) continue;
		if (seen.has(tag)) continue;
		seen.add(tag);
		result.push(tag);
	}
	return result;
}

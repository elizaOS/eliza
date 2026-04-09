import type { UUID } from "../types/primitives.ts";
import type { IAgentRuntime } from "../types/runtime.ts";

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normToken(s: string): string {
	return s.trim().toLowerCase().replace(/^@+/, "");
}

function splitNameTokens(raw: string): string[] {
	const n = normToken(raw);
	if (!n) return [];
	const out = new Set<string>([n]);
	const first = n.split(/\s+/)[0];
	if (first) out.add(first);
	return [...out];
}

/**
 * Fast addressee / mention resolution without an LLM (plugin-autonomous–style).
 * Maps entity (and optional agent) ids to normalized name tokens for @mentions and lead-in patterns.
 */
export class NameVariationRegistry {
	private readonly entityToTokens = new Map<UUID, Set<string>>();
	private readonly tokenToEntities = new Map<string, Set<UUID>>();

	registerEntity(entityId: UUID, rawNames: readonly string[]): void {
		const tokens = new Set<string>();
		for (const raw of rawNames) {
			for (const t of splitNameTokens(raw)) {
				if (t.length > 0) tokens.add(t);
			}
		}
		if (tokens.size === 0) return;
		this.entityToTokens.set(entityId, tokens);
		for (const t of tokens) {
			let set = this.tokenToEntities.get(t);
			if (!set) {
				set = new Set();
				this.tokenToEntities.set(t, set);
			}
			set.add(entityId);
		}
	}

	/** Register the same token set under another id (e.g. agentId vs entity id). */
	aliasEntity(alternateId: UUID, canonicalEntityId: UUID): void {
		const tokens = this.entityToTokens.get(canonicalEntityId);
		if (!tokens) return;
		this.entityToTokens.set(alternateId, tokens);
		for (const t of tokens) {
			let set = this.tokenToEntities.get(t);
			if (!set) {
				set = new Set();
				this.tokenToEntities.set(t, set);
			}
			set.add(alternateId);
		}
	}

	hasEntity(id: UUID): boolean {
		return this.entityToTokens.has(id);
	}

	private resolveUuid(value: unknown): UUID | null {
		if (typeof value !== "string") return null;
		const t = value.trim();
		if (!UUID_RE.test(t)) return null;
		return t as UUID;
	}

	/**
	 * Primary addressee: explicit metadata first (replyToEntityId, inReplyToEntityId, replyTo, inReplyTo as UUID),
	 * then leading @Name, "Name,", "Name:".
	 */
	checkAddressedTo(
		messageText: string,
		metadata?: Record<string, unknown>,
	): UUID | null {
		if (metadata) {
			for (const key of [
				"replyToEntityId",
				"inReplyToEntityId",
				"replyTo",
				"inReplyTo",
			] as const) {
				const id = this.resolveUuid(metadata[key]);
				if (id && this.entityToTokens.has(id)) return id;
			}
		}

		const text = messageText.trim();
		if (!text) return null;

		const at = text.match(/^@([\w.-]+)\b/);
		if (at) {
			const id = this.resolveSingleToken(at[1]);
			if (id) return id;
		}

		const comma = text.match(/^([^,:\n]{1,80}),\s/);
		if (comma) {
			const id = this.resolveSingleToken(comma[1]);
			if (id) return id;
		}

		const colon = text.match(/^([^,:\n]{1,80}):\s/);
		if (colon) {
			const id = this.resolveSingleToken(colon[1]);
			if (id) return id;
		}

		const hey = text.match(/^(?:hey|hi|hello)\s+([\w.-]+)\b/i);
		if (hey) {
			const id = this.resolveSingleToken(hey[1]);
			if (id) return id;
		}

		return null;
	}

	private resolveSingleToken(fragment: string): UUID | null {
		const t = normToken(fragment);
		if (!t) return null;
		const set = this.tokenToEntities.get(t);
		if (!set || set.size === 0) return null;
		if (set.size === 1) return [...set][0];
		return null;
	}

	/** All entities whose names appear as @mentions in the text. */
	getMentionedAgents(messageText: string): UUID[] {
		const found = new Set<UUID>();
		const re = /@([\w.-]+)\b/g;
		for (;;) {
			const m = re.exec(messageText);
			if (m === null) break;
			const id = this.resolveSingleToken(m[1]);
			if (id) found.add(id);
		}
		return [...found];
	}

	isAddressedToOther(
		messageText: string,
		myEntityId: UUID,
		metadata?: Record<string, unknown>,
	): boolean {
		const to = this.checkAddressedTo(messageText, metadata);
		return to !== null && to !== myEntityId;
	}

	isAddressedToSelf(
		messageText: string,
		myEntityId: UUID,
		metadata?: Record<string, unknown>,
	): boolean {
		const to = this.checkAddressedTo(messageText, metadata);
		return to === myEntityId;
	}
}

export interface AddresseeDetection {
	explicitMentions: string[];
	namedAgents: string[];
}

/**
 * Parse @mentions and simple "Name," / "Hey Name" / "Name and" patterns against known agent display names.
 */
export function detectAddressees(
	text: string,
	agentDisplayNames: string[],
): AddresseeDetection {
	const explicitMentions: string[] = [];
	const namedAgents: string[] = [];
	const lowerNames = new Set(agentDisplayNames.map((n) => normToken(n)));

	const mentionMatches = text.matchAll(/@([\w.-]+)\b/g);
	for (const m of mentionMatches) {
		const name = m[1];
		if (lowerNames.has(normToken(name))) explicitMentions.push(name);
	}

	const comma = text.match(/^([^,:\n]{1,80}),\s/);
	if (comma && lowerNames.has(normToken(comma[1]))) {
		namedAgents.push(comma[1].trim());
	}

	const hey = text.match(/^(?:hey|hi|hello)\s+([\w.-]+)\b/i);
	if (hey && lowerNames.has(normToken(hey[1]))) {
		namedAgents.push(hey[1].trim());
	}

	const andPat = text.match(/^([\w.-]+)\s+and\s+/i);
	if (andPat && lowerNames.has(normToken(andPat[1]))) {
		namedAgents.push(andPat[1].trim());
	}

	return { explicitMentions, namedAgents };
}

/** Build a registry from current room participants (entity + optional agent id aliases). */
export async function buildNameRegistryForRoom(
	runtime: IAgentRuntime,
	roomId: UUID,
): Promise<NameVariationRegistry> {
	const registry = new NameVariationRegistry();
	const participants = await runtime.getParticipantsForRoom(roomId);
	if (participants.length === 0) return registry;
	const entities = await runtime.getEntitiesByIds(participants);
	for (const e of entities) {
		const id = e.id;
		if (!id) continue;
		const names = [...(e.names ?? [])];
		registry.registerEntity(id, names);
		const agentId = e.agentId;
		if (agentId && agentId !== id) {
			registry.aliasEntity(agentId as UUID, id);
		}
	}
	return registry;
}

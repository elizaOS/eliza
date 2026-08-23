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
import {
	distinctiveNameTokens,
	escapeRegex,
	normalizeName,
} from "../utils/agent-name-match";

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
 * Normalized set of the agent's own names: character name, username, and
 * each distinctive (>= 4 char) token of a multi-word name, so
 * "remilio nubilio" also answers to "nubilio" (live 2026-08-22).
 */
function agentSelfNames(runtime: IAgentRuntime): Set<string> {
	const self = new Set<string>();
	for (const name of [runtime.character?.name, runtime.character?.username]) {
		if (!name) continue;
		for (const token of distinctiveNameTokens(name)) {
			self.add(normalizeName(token));
		}
	}
	return self;
}

/**
 * True only when a turn is verifiably directed at a resolvable OTHER room
 * participant. Two independent evidence sources are OR-composed — a
 * text-corroborated Stage-1 tag, or a structural leading vocative — so a
 * hallucinated tag never blocks the vocative evidence and an empty tag list
 * never blocks the tag path. Three invariants bound the answer, because a
 * positive here converts the turn into deliberate silence:
 *
 *  - addressed to US (by name, name token, id, or platform alias) never
 *    gates, and short-circuits both evidence sources — the turn is ours;
 *  - a tag that resolves to the message's own AUTHOR never gates (a message
 *    cannot be addressed to its own speaker — that is a Stage-1 extraction
 *    error);
 *  - corroboration: the gate may only silence on evidence it can verify
 *    itself — the message text must actually address the tagged participant
 *    by one of their names ("Hey Eliza …" corroborates a tag of Eliza). An
 *    uncorroborated model tag never gates on its own; it falls through to
 *    the vocative check.
 *
 * Fails SAFE (returns false) whenever it cannot positively confirm the
 * above: unresolvable bare names, DMs and undirected asks all return false
 * and the agent keeps acting on requests meant for it. The room's entity
 * list is fetched ONCE and shared by tag resolution, corroboration, and the
 * vocative fallback.
 */
export async function messageAddressedToOtherParticipant(
	args: ApplyAddressedToArgs,
): Promise<boolean> {
	const { runtime, message, addressedTo } = args;
	const text =
		typeof message.content?.text === "string" ? message.content.text : "";
	const cleaned = (addressedTo ?? [])
		.map((entry) => (typeof entry === "string" ? entry.trim() : ""))
		.filter((entry) => entry.length > 0);
	if (cleaned.length === 0 && !text.trim()) {
		return false;
	}

	const self = agentSelfNames(runtime);
	const selfId = runtime.agentId;

	// Addressed to us by literal name/name-token/id → handle normally, never
	// suppress (and never consult the vocative fallback: the turn is ours).
	if (
		cleaned.some((entry) => {
			const normalized = normalizeName(entry);
			return (
				self.has(normalized) ||
				(selfId ? normalized === selfId.toLowerCase() : false)
			);
		})
	) {
		return false;
	}

	// ONE room fetch serves tag resolution, corroboration, and the vocative
	// fallback below.
	const participants = await runtime.getEntitiesForRoom(message.roomId);

	if (cleaned.length > 0) {
		// Resolve names→ids against the room. This also maps the agent's OWN
		// entity aliases (platform handles like @samantha_ai_bot that connectors
		// store on the agent's entity) to selfId, so a turn addressed to us by an
		// alias is NOT mistaken for an other-participant address.
		const targets = resolveAddressedTargetsFromParticipants({
			runtime,
			addressedTo: cleaned,
			participants,
		});
		if (selfId && targets.some((id) => id === selfId)) {
			return false;
		}

		// A message cannot be addressed to its own author: a tag that resolves to
		// the SPEAKER is a Stage-1 extraction error, never an other-participant
		// address (live 2026-08-22: "hello?" / "did u see what i said?" were
		// tagged with the asker's own name and silently suppressed).
		const speakerId = message.entityId;
		const others = speakerId
			? targets.filter((id) => id !== speakerId)
			: targets;

		// Corroboration invariant: a deterministic gate may only SILENCE a turn
		// on evidence it can verify itself. The Stage-1 tag picks WHO, but
		// suppression additionally requires the message text to actually address
		// that participant by one of their names ("Hey Eliza …" corroborates a
		// tag of Eliza). An uncorroborated tag — the model hallucinating an
		// addressee the text never names (live 2026-08-22: "nubilio whats the
		// setting …" tagged as addressed to shaw) — must never convert a turn
		// into silence.
		const othersSet = new Set(others);
		const corroborated = participants.some((participant) => {
			if (!participant.id || !othersSet.has(participant.id)) return false;
			return entityNames(participant).some((name) => {
				const candidate = normalizeName(name);
				if (candidate.length < 2) return false;
				return new RegExp(
					`(^|[^\\p{L}\\p{N}])@?${escapeRegex(candidate)}(?=$|[^\\p{L}\\p{N}])`,
					"iu",
				).test(text);
			});
		});
		if (corroborated) {
			return true;
		}
	}

	// OR-composition: the tag path found nothing it could verify (empty,
	// unresolvable, author-only, or uncorroborated tags), but the text itself
	// may still open by addressing another participant — a hallucinated tag
	// must not block that independent evidence.
	return vocativelyAddressesOtherParticipant({
		runtime,
		message,
		participants,
		self,
	});
}

export async function resolveAddressedTargets(
	args: ResolveTargetsArgs,
): Promise<UUID[]> {
	const { runtime, message, addressedTo } = args;
	// Bare names need the room's entity list; pure-UUID tags resolve without it.
	const needsRoomEntities = addressedTo.some((entry) => {
		const cleaned = typeof entry === "string" ? entry.trim() : "";
		return cleaned.length > 0 && !UUID_PATTERN.test(cleaned);
	});
	const participants = needsRoomEntities
		? await runtime.getEntitiesForRoom(message.roomId)
		: [];
	return resolveAddressedTargetsFromParticipants({
		runtime,
		addressedTo,
		participants,
	});
}

function resolveAddressedTargetsFromParticipants(args: {
	runtime: IAgentRuntime;
	addressedTo: readonly string[];
	participants: readonly Entity[];
}): UUID[] {
	const { runtime, addressedTo, participants } = args;
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
		const byName = new Map<string, UUID>();
		const agentName = runtime.character.name;
		if (agentName) {
			byName.set(normalizeName(agentName), runtime.agentId);
		}
		for (const entity of participants) {
			const id = entity.id as UUID | undefined;
			if (!id) continue;
			for (const name of entityNames(entity)) {
				byName.set(normalizeName(name), id);
			}
		}
		for (const name of names) {
			const hit = byName.get(normalizeName(name));
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

/**
 * Optional greeting word before a leading vocative. The boundary lookahead
 * is required so a greeting only counts when it ends the word — without it
 * the alternation could consume a prefix of an ordinary word and match a
 * short participant name against the remainder ("gmsol" parsing as
 * "gm"+"sol", "hiro" as "hi"+"ro"), converting normal chatter into silence.
 */
const VOCATIVE_GREETING_PREFIX =
	"(?:(?:hey|hi|yo|sup|hello|gm|gn|ok|okay)(?=$|[^\\p{L}\\p{N}]))?";

/** Anchored leading-vocative matcher for one normalized participant name. */
function leadingVocative(name: string): RegExp {
	return new RegExp(
		`^\\s*${VOCATIVE_GREETING_PREFIX}\\s*[,–—-]?\\s*@?${escapeRegex(name)}(?=$|[^\\p{L}\\p{N}])`,
		"iu",
	);
}

/**
 * Structural vocative detection: true when the message TEXT opens by
 * addressing another room participant by name — "hey eliza", "eliza, can you
 * …", "gm sol" — and that participant is not us. This needs no Stage-1 tag:
 * a leading vocative is evidence the gate can verify itself, so an
 * interjection-prone model that leaves `addressedTo` empty (live 2026-08-22:
 * "hey eliza" → tags []; the agent answered "hey. you alright?") no longer
 * fails open. Deliberately narrow: only a name in the vocative position at
 * the very start (optionally after a greeting word) counts — "i was talking
 * to eliza" or "can you ping eliza for me" never match, because a mid-text
 * name is a mention, not an address.
 */
export async function messageVocativelyAddressesOtherParticipant(args: {
	runtime: IAgentRuntime;
	message: Memory;
}): Promise<boolean> {
	const { runtime, message } = args;
	const text =
		typeof message.content?.text === "string" ? message.content.text : "";
	if (!text.trim()) return false;

	const participants = await runtime.getEntitiesForRoom(message.roomId);
	return vocativelyAddressesOtherParticipant({
		runtime,
		message,
		participants,
		self: agentSelfNames(runtime),
	});
}

/**
 * Core of the structural vocative check, operating on a pre-fetched room
 * entity list so the combined addressing gate pays a single room lookup.
 * `self` holds the agent's normalized names (see agentSelfNames).
 */
function vocativelyAddressesOtherParticipant(args: {
	runtime: IAgentRuntime;
	message: Memory;
	participants: readonly Entity[];
	self: ReadonlySet<string>;
}): boolean {
	const { runtime, message, participants, self } = args;
	const text =
		typeof message.content?.text === "string" ? message.content.text : "";
	if (!text.trim()) return false;

	const lead = text;
	// A leading vocative of OUR name keeps the turn ours ("nubilio, ask
	// eliza …" opens with us, not them). Loop-invariant: computed once.
	for (const own of self) {
		if (leadingVocative(own).test(lead)) return false;
	}

	const speakerId = message.entityId;
	for (const participant of participants) {
		if (!participant.id) continue;
		if (participant.id === runtime.agentId) continue;
		if (speakerId && participant.id === speakerId) continue;
		for (const rawName of entityNames(participant)) {
			const name = normalizeName(rawName);
			if (name.length < 2 || self.has(name)) continue;
			if (leadingVocative(name).test(lead)) return true;
		}
	}
	return false;
}

/**
 * Interjections and generic address words that occupy the vocative position
 * in ordinary chat ("ok cool", "hey bro") without naming anyone. A token on
 * this list never classifies as an unresolved vocative.
 */
const VOCATIVE_STOP_TOKENS = new Set([
	"ok",
	"okay",
	"cool",
	"thanks",
	"thx",
	"ty",
	"lol",
	"lmao",
	"yes",
	"no",
	"yeah",
	"yep",
	"nah",
	"sure",
	"hey",
	"hi",
	"yo",
	"sup",
	"hello",
	"gm",
	"gn",
	"wtf",
	"omg",
	"bro",
	"dude",
	"man",
	"guys",
	"everyone",
	"all",
	"team",
	"chat",
	"u",
	"you",
	"pls",
	"please",
	"wait",
	"stop",
	"what",
	"whats",
	"why",
	"how",
	"who",
	"when",
]);

/** Vocative-position token: "hey NAME …", "NAME, …", or a bare "NAME". */
const VOCATIVE_TOKEN_RE =
	/^\s*(?:(?:hey|hi|yo|sup|hello|gm|gn)(?=$|[^\p{L}\p{N}])\s*[,–—-]?\s*@?([\p{L}\p{N}_.-]{2,32})(?=$|[^\p{L}\p{N}])|@?([\p{L}\p{N}_.-]{2,32})\s*(?:[,!?.:;]|$))/iu;

export type LeadingVocativeClass =
	| { kind: "none" }
	| { kind: "self"; name: string }
	| { kind: "participant"; name: string }
	| { kind: "unresolved"; name: string };

/**
 * Classifies who a message's opening vocative addresses. Deliberately
 * narrower than the suppression matcher above: only "greeting NAME …",
 * "NAME, …" and a bare "NAME" shapes count, and interjection tokens never
 * classify — so an ordinary sentence's first word is not read as a name.
 * "unresolved" (a name that is neither the agent nor any room participant)
 * feeds the Stage-1 identity notice: live 2026-08-23, "hey eliza" and then a
 * bare "eliza" in a room with no Eliza drew "hey. what's on your mind?" and
 * "yeah?" — the agent answering AS a name that is not its own.
 */
export async function classifyLeadingVocative(args: {
	runtime: IAgentRuntime;
	message: Memory;
}): Promise<LeadingVocativeClass> {
	const { runtime, message } = args;
	const text =
		typeof message.content?.text === "string" ? message.content.text : "";
	const match = VOCATIVE_TOKEN_RE.exec(text);
	const raw = match?.[1] ?? match?.[2];
	if (!raw) return { kind: "none" };
	const name = normalizeName(raw);
	if (name.length < 2 || VOCATIVE_STOP_TOKENS.has(name))
		return { kind: "none" };

	if (agentSelfNames(runtime).has(name)) return { kind: "self", name };

	const speakerId = message.entityId;
	const participants = await runtime.getEntitiesForRoom(message.roomId);
	for (const participant of participants) {
		if (!participant.id || participant.id === runtime.agentId) continue;
		if (speakerId && participant.id === speakerId) continue;
		for (const rawName of entityNames(participant)) {
			if (normalizeName(rawName) === name) {
				return { kind: "participant", name };
			}
		}
	}
	return { kind: "unresolved", name };
}

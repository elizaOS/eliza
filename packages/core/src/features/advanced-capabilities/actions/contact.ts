/**
 * CONTACT — single polymorphic action consolidating Rolodex / contact /
 * entity / relationship lifecycle.
 *
 * Replaces the former
 *   - agent: SEARCH_CONTACT, READ_CONTACT, LINK_CONTACT, MERGE_CONTACT,
 *            CONTACT_ACTIVITY, CREATE_CONTACT, UPDATE_CONTACT, DELETE_CONTACT
 *   - core:  ADD_CONTACT, REMOVE_CONTACT, SEARCH_CONTACTS, UPDATE_CONTACT
 *
 * Op-based dispatch — provide an `op` parameter:
 *   create   — create a new contact entity (and optionally a contact_info
 *              component when categories/tags/preferences/customFields are
 *              supplied).
 *   read     — load identity + facts + recent conversations + relationships
 *              for an entity by id or name.
 *   search   — search the Rolodex by name/handle/platform OR by structured
 *              category/tag filters.
 *   update   — update an existing contact: scalar fields by replacement;
 *              list/map fields obey `mode` ∈ {replace, add_to, remove_from}.
 *   delete   — permanently delete a contact entity (requires confirm:true).
 *   link     — propose / confirm a merge of two entities representing the
 *              same person across platforms.
 *   merge    — accept or reject a pending merge candidate by id.
 *   activity — paginated relationship/identity/fact activity timeline.
 */

import type {
	RelationshipsGraphService,
	RelationshipsPersonDetail,
	RelationshipsPersonSummary,
} from "../../../services/relationships-graph-builder";
import type {
	ContactInfo,
	ContactPreferences,
	RelationshipsService,
} from "../../../services/relationships";
import type {
	Action,
	ActionResult,
	Entity,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	JsonValue,
	Memory,
	State,
	UUID,
} from "../../../types/index";
import { asUUID } from "../../../types/index";
import { logger } from "../../../logger";
import { stringToUuid } from "../../../utils";

// ---------------------------------------------------------------------------
// Op dispatch
// ---------------------------------------------------------------------------

const CONTACT_OPS = [
	"create",
	"read",
	"search",
	"update",
	"delete",
	"link",
	"merge",
	"activity",
] as const;
type ContactOp = (typeof CONTACT_OPS)[number];

const CONTACT_ACTION = "CONTACT";

const ACTIVITY_DEFAULT_LIMIT = 50;
const ACTIVITY_MAX_LIMIT = 100;

const UUID_REGEX =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type UpdateMode = "replace" | "add_to" | "remove_from";

interface ContactParams {
	op?: ContactOp;
	entityId?: string;
	name?: string;
	query?: string;
	platform?: string;
	limit?: number;
	offset?: number;
	categories?: string[] | string;
	tags?: string[] | string;
	preferences?: Record<string, string> | string;
	customFields?: Record<string, JsonValue> | string;
	notes?: string;
	timezone?: string;
	language?: string;
	mode?: UpdateMode;
	confirm?: boolean;
	entityA?: string;
	entityB?: string;
	confirmation?: boolean;
	reason?: string;
	candidateId?: string;
	action?: "accept" | "reject";
}

// ---------------------------------------------------------------------------
// Param coercion
// ---------------------------------------------------------------------------

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const v = value.trim().toLowerCase();
		if (v === "true" || v === "yes" || v === "y") return true;
		if (v === "false" || v === "no" || v === "n") return false;
	}
	return undefined;
}

function readNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function readStringArray(value: unknown): string[] | undefined {
	if (Array.isArray(value)) {
		const out = value
			.map((v) => readString(v))
			.filter((v): v is string => Boolean(v));
		return out.length > 0 ? out : undefined;
	}
	if (typeof value === "string") {
		const out = value
			.split(",")
			.map((v) => v.trim())
			.filter(Boolean);
		return out.length > 0 ? out : undefined;
	}
	return undefined;
}

function readRecord(
	value: unknown,
): Record<string, JsonValue> | undefined {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, JsonValue>;
	}
	if (typeof value === "string") {
		const out: Record<string, JsonValue> = {};
		for (const pair of value.split(",")) {
			const [rawKey, ...rawVal] = pair.split(":");
			const key = rawKey?.trim();
			const val = rawVal.join(":").trim();
			if (key && val) out[key] = val;
		}
		return Object.keys(out).length > 0 ? out : undefined;
	}
	return undefined;
}

function readMode(value: unknown): UpdateMode {
	const s = readString(value);
	if (s === "add_to" || s === "remove_from" || s === "replace") return s;
	return "replace";
}

function readParams(options?: HandlerOptions): Record<string, unknown> {
	return options?.parameters && typeof options.parameters === "object"
		? (options.parameters as Record<string, unknown>)
		: {};
}

function readContactParams(
	message: Memory,
	options?: HandlerOptions,
): ContactParams {
	const p = readParams(options);
	const c = (message.content ?? {}) as Record<string, unknown>;
	const op = readString(p.op ?? c.op);
	return {
		op:
			op && (CONTACT_OPS as readonly string[]).includes(op)
				? (op as ContactOp)
				: undefined,
		entityId: readString(p.entityId ?? c.entityId),
		name: readString(p.name ?? p.contactName ?? c.name ?? c.contactName),
		query: readString(p.query ?? p.searchTerm ?? c.query ?? c.searchTerm),
		platform: readString(p.platform ?? c.platform),
		limit: readNumber(p.limit ?? c.limit),
		offset: readNumber(p.offset ?? c.offset),
		categories: readStringArray(p.categories ?? c.categories),
		tags: readStringArray(p.tags ?? c.tags),
		preferences: readRecord(p.preferences ?? c.preferences) as
			| Record<string, string>
			| undefined,
		customFields: readRecord(p.customFields ?? c.customFields),
		notes: readString(p.notes ?? c.notes),
		timezone: readString(p.timezone ?? c.timezone),
		language: readString(p.language ?? c.language),
		mode: readMode(p.mode ?? p.operation ?? c.mode ?? c.operation),
		confirm: readBoolean(p.confirm ?? p.confirmed ?? c.confirm ?? c.confirmed),
		entityA: readString(p.entityA ?? c.entityA),
		entityB: readString(p.entityB ?? c.entityB),
		confirmation: readBoolean(p.confirmation ?? c.confirmation),
		reason: readString(p.reason ?? c.reason),
		candidateId: readString(p.candidateId ?? c.candidateId),
		action: ((): "accept" | "reject" | undefined => {
			const a = readString(p.action ?? c.action);
			return a === "accept" || a === "reject" ? a : undefined;
		})(),
	};
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

function failure(
	op: ContactOp | undefined,
	text: string,
	error: string,
	extra: Record<string, unknown> = {},
): ActionResult {
	return {
		success: false,
		text,
		error,
		values: { success: false, error },
		data: { actionName: CONTACT_ACTION, op, error, ...extra },
	};
}

function ok(
	op: ContactOp,
	text: string,
	data: Record<string, unknown> = {},
	values: Record<string, unknown> = {},
): ActionResult {
	return {
		success: true,
		text,
		values: { success: true, ...values },
		data: { actionName: CONTACT_ACTION, op, ...data },
	};
}

function getRelationships(
	runtime: IAgentRuntime,
): (RelationshipsService & RelationshipsGraphService) | null {
	const service = runtime.getService("relationships");
	if (!service) return null;
	return service as unknown as RelationshipsService & RelationshipsGraphService;
}

// ---------------------------------------------------------------------------
// Op handlers
// ---------------------------------------------------------------------------

async function handleCreate(
	runtime: IAgentRuntime,
	rs: RelationshipsService & RelationshipsGraphService,
	params: ContactParams,
): Promise<ActionResult> {
	const name = params.name;
	if (!name) {
		return failure(
			"create",
			"CONTACT.create requires a name parameter.",
			"INVALID_PARAMETERS",
		);
	}

	let entityId =
		params.entityId && UUID_REGEX.test(params.entityId)
			? asUUID(params.entityId)
			: stringToUuid(`contact-${runtime.agentId}-${name}-${Date.now()}`);

	const existing = await runtime.getEntityById(entityId);
	if (!existing) {
		await runtime.createEntity({
			id: entityId,
			names: [name],
			agentId: runtime.agentId,
		});
	}

	const categories = readStringArray(params.categories) ?? ["acquaintance"];
	const preferences: ContactPreferences = {};
	if (params.notes) preferences.notes = params.notes;
	if (params.timezone) preferences.timezone = params.timezone;
	if (params.language) preferences.language = params.language;
	if (params.preferences && typeof params.preferences === "object") {
		Object.assign(preferences, params.preferences);
	}

	const customFields: Record<string, JsonValue> = { displayName: name };
	if (params.customFields && typeof params.customFields === "object") {
		Object.assign(customFields, params.customFields);
	}

	const contact = await rs.addContact(
		entityId,
		categories,
		preferences,
		customFields,
	);

	const tags = readStringArray(params.tags);
	if (tags && tags.length > 0) {
		await rs.updateContact(entityId, { tags });
	}

	return ok(
		"create",
		`Created contact "${name}" (entityId: ${entityId}).`,
		{ entityId, name, categories, contact },
		{ entityId, name },
	);
}

async function handleRead(
	rs: RelationshipsService & RelationshipsGraphService,
	params: ContactParams,
): Promise<ActionResult> {
	let entityId =
		params.entityId && UUID_REGEX.test(params.entityId)
			? asUUID(params.entityId)
			: undefined;

	if (!entityId && params.name) {
		const snapshot = await rs.getGraphSnapshot({
			search: params.name,
			limit: 1,
		});
		entityId = snapshot.people[0]?.primaryEntityId;
	}

	if (!entityId) {
		return failure(
			"read",
			"CONTACT.read requires entityId or name.",
			"INVALID_PARAMETERS",
		);
	}

	const detail = await rs.getPersonDetail(entityId);
	if (!detail) {
		return failure("read", `No contact found for ${entityId}.`, "NOT_FOUND", {
			entityId,
		});
	}

	return ok(
		"read",
		formatPersonDetail(detail),
		{ entityId, detail },
		{ entityId },
	);
}

async function handleSearch(
	rs: RelationshipsService & RelationshipsGraphService,
	params: ContactParams,
): Promise<ActionResult> {
	const limit = Math.min(Math.max(1, params.limit ?? 10), 25);
	const query = params.query;
	const categories = readStringArray(params.categories);
	const tags = readStringArray(params.tags);

	if (!query && !categories && !tags) {
		return failure(
			"search",
			"CONTACT.search requires a query, categories, or tags.",
			"INVALID_PARAMETERS",
		);
	}

	if (categories || tags) {
		const contacts = (
			await rs.searchContacts({
				searchTerm: query,
				categories,
				tags,
			})
		).slice(0, limit);
		return ok(
			"search",
			`Found ${contacts.length} contact${contacts.length === 1 ? "" : "s"}.`,
			{ contacts, count: contacts.length },
			{ count: contacts.length },
		);
	}

	const snapshot = await rs.getGraphSnapshot({
		search: query,
		platform: params.platform ?? null,
		limit,
	});

	if (snapshot.people.length === 0) {
		return ok("search", `No contacts found for "${query}".`, {
			query,
			count: 0,
			results: [],
		});
	}

	return ok(
		"search",
		formatSearchResults(query ?? "", snapshot.people),
		{
			query,
			platform: params.platform,
			count: snapshot.people.length,
			results: snapshot.people.map((p, i) => ({
				line: i + 1,
				primaryEntityId: p.primaryEntityId,
				displayName: p.displayName,
				platforms: p.platforms,
				factCount: p.factCount,
			})),
		},
		{ count: snapshot.people.length },
	);
}

async function handleUpdate(
	rs: RelationshipsService & RelationshipsGraphService,
	params: ContactParams,
): Promise<ActionResult> {
	let entityId =
		params.entityId && UUID_REGEX.test(params.entityId)
			? asUUID(params.entityId)
			: undefined;

	if (!entityId && params.name) {
		const matches = await rs.searchContacts({ searchTerm: params.name });
		entityId = matches[0]?.entityId;
	}

	if (!entityId) {
		return failure(
			"update",
			"CONTACT.update requires entityId or name.",
			"INVALID_PARAMETERS",
		);
	}

	const existing = await rs.getContact(entityId);
	if (!existing) {
		return failure(
			"update",
			`No contact found for ${entityId}.`,
			"NOT_FOUND",
			{ entityId },
		);
	}

	const mode = params.mode ?? "replace";
	const updates: Partial<ContactInfo> = {};

	const newCategories = readStringArray(params.categories);
	if (newCategories) {
		updates.categories = applySetUpdate(existing.categories, newCategories, mode);
	}

	const newTags = readStringArray(params.tags);
	if (newTags) {
		updates.tags = applySetUpdate(existing.tags, newTags, mode);
	}

	if (params.preferences && typeof params.preferences === "object") {
		updates.preferences = {
			...existing.preferences,
			...(params.preferences as ContactPreferences),
		};
	}

	if (params.customFields && typeof params.customFields === "object") {
		updates.customFields = {
			...existing.customFields,
			...(params.customFields as Record<string, JsonValue>),
		};
	}

	if (params.notes !== undefined) {
		updates.preferences = {
			...(updates.preferences ?? existing.preferences ?? {}),
			notes: params.notes,
		};
	}

	if (Object.keys(updates).length === 0) {
		return failure(
			"update",
			"CONTACT.update requires at least one field to update.",
			"INVALID_PARAMETERS",
			{ entityId },
		);
	}

	const updated = await rs.updateContact(entityId, updates);
	if (!updated) {
		return failure(
			"update",
			`Failed to update ${entityId}.`,
			"UPDATE_FAILED",
			{ entityId },
		);
	}

	return ok(
		"update",
		`Updated contact ${entityId}.`,
		{ entityId, contact: updated, fields: Object.keys(updates) },
		{ entityId },
	);
}

function applySetUpdate(
	current: string[],
	incoming: string[],
	mode: UpdateMode,
): string[] {
	if (mode === "add_to") {
		return Array.from(new Set([...current, ...incoming]));
	}
	if (mode === "remove_from") {
		const drop = new Set(incoming);
		return current.filter((value) => !drop.has(value));
	}
	return incoming;
}

async function handleDelete(
	runtime: IAgentRuntime,
	rs: RelationshipsService & RelationshipsGraphService,
	params: ContactParams,
): Promise<ActionResult> {
	if (params.confirm !== true) {
		return failure(
			"delete",
			"CONTACT.delete requires confirm:true to acknowledge irreversibility.",
			"CONFIRMATION_REQUIRED",
		);
	}

	let entityId =
		params.entityId && UUID_REGEX.test(params.entityId)
			? asUUID(params.entityId)
			: undefined;

	if (!entityId && params.name) {
		const matches = await rs.searchContacts({ searchTerm: params.name });
		entityId = matches[0]?.entityId;
	}

	if (!entityId) {
		return failure(
			"delete",
			"CONTACT.delete requires entityId or name.",
			"INVALID_PARAMETERS",
		);
	}

	const removed = await rs.removeContact(entityId);

	const runtimeWithDelete = runtime as IAgentRuntime & {
		deleteEntities?: (ids: UUID[]) => Promise<void>;
	};
	if (typeof runtimeWithDelete.deleteEntities === "function") {
		try {
			await runtimeWithDelete.deleteEntities([entityId]);
		} catch (err) {
			logger.warn(
				`[CONTACT.delete] Entity removal failed for ${entityId}: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}

	return ok(
		"delete",
		removed
			? `Deleted contact ${entityId}.`
			: `Removed contact info for ${entityId}; entity record may persist.`,
		{ entityId, removed },
		{ entityId },
	);
}

async function handleLink(
	rs: RelationshipsService & RelationshipsGraphService,
	params: ContactParams,
	message: Memory,
): Promise<ActionResult> {
	const entityA = params.entityA && UUID_REGEX.test(params.entityA)
		? asUUID(params.entityA)
		: undefined;
	const entityB = params.entityB && UUID_REGEX.test(params.entityB)
		? asUUID(params.entityB)
		: undefined;

	if (!entityA || !entityB) {
		return failure(
			"link",
			"CONTACT.link requires entityA and entityB UUIDs.",
			"INVALID_PARAMETERS",
		);
	}
	if (entityA === entityB) {
		return failure(
			"link",
			"Cannot link an entity to itself.",
			"INVALID_PARAMETERS",
			{ entityA, entityB },
		);
	}

	const evidence = {
		notes: params.reason ?? "user-requested manual link",
		source: "CONTACT.link",
		userMessageId: message.id,
	};
	const candidateId = await rs.proposeMerge(entityA, entityB, evidence);

	if (params.confirmation !== true) {
		return ok(
			"link",
			`Proposed merge ${candidateId} (${entityA} ↔ ${entityB}). Pass confirmation:true to apply.`,
			{ entityA, entityB, candidateId, applied: false },
			{ candidateId, applied: false },
		);
	}

	await rs.acceptMerge(candidateId);
	return ok(
		"link",
		`Linked ${entityA} with ${entityB} via candidate ${candidateId}.`,
		{ entityA, entityB, candidateId, applied: true },
		{ candidateId, applied: true },
	);
}

async function handleMerge(
	rs: RelationshipsService & RelationshipsGraphService,
	params: ContactParams,
): Promise<ActionResult> {
	const candidateId =
		params.candidateId && UUID_REGEX.test(params.candidateId)
			? asUUID(params.candidateId)
			: undefined;
	if (!candidateId) {
		return failure(
			"merge",
			"CONTACT.merge requires a candidateId UUID.",
			"INVALID_PARAMETERS",
		);
	}
	if (params.action !== "accept" && params.action !== "reject") {
		return failure(
			"merge",
			'CONTACT.merge action must be "accept" or "reject".',
			"INVALID_PARAMETERS",
			{ candidateId },
		);
	}

	if (params.action === "accept") {
		await rs.acceptMerge(candidateId);
		return ok(
			"merge",
			`Accepted merge candidate ${candidateId}.`,
			{ candidateId, status: "accepted" },
			{ candidateId, action: "accept" },
		);
	}

	await rs.rejectMerge(candidateId);
	return ok(
		"merge",
		`Rejected merge candidate ${candidateId}.`,
		{ candidateId, status: "rejected" },
		{ candidateId, action: "reject" },
	);
}

async function handleActivity(
	runtime: IAgentRuntime,
	rs: RelationshipsService & RelationshipsGraphService,
	params: ContactParams,
): Promise<ActionResult> {
	const limit = clampActivityLimit(params.limit);
	const offset = clampActivityOffset(params.offset);

	const snapshot = await rs.getGraphSnapshot();
	const personByEntityId = new Map<
		string,
		{ personId: string; personName: string }
	>();
	for (const person of snapshot.people) {
		const entry = {
			personId: person.primaryEntityId,
			personName: person.displayName,
		};
		personByEntityId.set(person.primaryEntityId, entry);
		for (const memberEntityId of person.memberEntityIds) {
			personByEntityId.set(memberEntityId, entry);
		}
	}

	type ActivityItem = {
		type: "relationship" | "identity" | "fact";
		personName: string;
		personId: string;
		summary: string;
		detail: string | null;
		timestamp: string | null;
	};

	const activity: ActivityItem[] = [];

	for (const edge of snapshot.relationships) {
		const types = edge.relationshipTypes.join(", ") || "connected";
		activity.push({
			type: "relationship",
			personName: edge.sourcePersonName,
			personId: edge.sourcePersonId,
			summary: `${edge.sourcePersonName} ↔ ${edge.targetPersonName}`,
			detail: `${types} · ${edge.sentiment} · strength ${edge.strength.toFixed(2)} · ${edge.interactionCount} interactions`,
			timestamp: edge.lastInteractionAt ?? null,
		});
	}

	for (const person of snapshot.people) {
		const platforms = person.platforms.join(", ") || "no platform";
		const count = person.memberEntityIds.length;
		activity.push({
			type: "identity",
			personName: person.displayName,
			personId: person.primaryEntityId,
			summary: person.displayName,
			detail: `${count} identit${count === 1 ? "y" : "ies"} on ${platforms} · ${person.factCount} facts`,
			timestamp: person.lastInteractionAt ?? null,
		});
	}

	const recentFacts = await runtime.getMemories({
		agentId: runtime.agentId,
		tableName: "facts",
		limit: 200,
	});
	for (const fact of recentFacts) {
		const text =
			typeof fact.content?.text === "string" ? fact.content.text.trim() : "";
		if (!text) continue;
		const person = fact.entityId
			? personByEntityId.get(fact.entityId) ?? null
			: null;
		activity.push({
			type: "fact",
			personName: person?.personName ?? "Unknown person",
			personId: person?.personId ?? fact.entityId ?? "unknown",
			summary: person?.personName
				? `Fact for ${person.personName}`
				: "Fact extracted",
			detail: text,
			timestamp:
				typeof fact.createdAt === "number"
					? new Date(fact.createdAt).toISOString()
					: null,
		});
	}

	activity.sort((a, b) => {
		const ta = a.timestamp ? Date.parse(a.timestamp) : 0;
		const tb = b.timestamp ? Date.parse(b.timestamp) : 0;
		return tb - ta;
	});

	const total = activity.length;
	const slice = activity.slice(offset, offset + limit);

	return ok(
		"activity",
		`Relationships activity | ${slice.length}/${total} items shown (offset ${offset}, limit ${limit})`,
		{
			activity: slice,
			total,
			count: slice.length,
			offset,
			limit,
			hasMore: offset + limit < total,
		},
		{ total, count: slice.length, offset, limit },
	);
}

function clampActivityLimit(value?: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
		return ACTIVITY_DEFAULT_LIMIT;
	}
	return Math.min(Math.trunc(value), ACTIVITY_MAX_LIMIT);
}

function clampActivityOffset(value?: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return 0;
	}
	return Math.trunc(value);
}

// ---------------------------------------------------------------------------
// Display formatting
// ---------------------------------------------------------------------------

function formatPersonSummary(person: RelationshipsPersonSummary): string {
	const lines: string[] = [];
	lines.push(`Name: ${person.displayName}${person.isOwner ? " [OWNER]" : ""}`);
	if (person.aliases.length > 0) {
		lines.push(`Aliases: ${person.aliases.join(", ")}`);
	}
	lines.push(`Platforms: ${person.platforms.join(", ") || "none"}`);
	for (const identity of person.identities) {
		for (const handle of identity.handles) {
			lines.push(
				`  @${handle.handle} on ${handle.platform}${handle.verified ? " (verified)" : ""}`,
			);
		}
	}
	if (person.emails.length > 0) lines.push(`Emails: ${person.emails.join(", ")}`);
	if (person.phones.length > 0) lines.push(`Phones: ${person.phones.join(", ")}`);
	if (person.websites.length > 0)
		lines.push(`Websites: ${person.websites.join(", ")}`);
	if (person.preferredCommunicationChannel) {
		lines.push(`Preferred channel: ${person.preferredCommunicationChannel}`);
	}
	if (person.categories.length > 0) {
		lines.push(`Categories: ${person.categories.join(", ")}`);
	}
	if (person.tags.length > 0) lines.push(`Tags: ${person.tags.join(", ")}`);
	lines.push(
		`Facts: ${person.factCount} | Relationships: ${person.relationshipCount}`,
	);
	if (person.lastInteractionAt) {
		lines.push(`Last interaction: ${person.lastInteractionAt.slice(0, 10)}`);
	}
	return lines.join("\n");
}

function formatPersonDetail(detail: RelationshipsPersonDetail): string {
	const sections: string[] = [];
	sections.push("## Identity", formatPersonSummary(detail));

	if (detail.facts.length > 0) {
		sections.push("\n## Facts");
		for (const fact of detail.facts) {
			const confidence =
				fact.confidence != null
					? ` (${Math.round(fact.confidence * 100)}%)`
					: "";
			sections.push(`- [${fact.sourceType}]${confidence} ${fact.text}`);
		}
	}

	if (detail.recentConversations.length > 0) {
		sections.push("\n## Recent Conversations");
		for (const convo of detail.recentConversations) {
			sections.push(
				`### ${convo.roomName} (${convo.lastActivityAt?.slice(0, 10) ?? "?"})`,
			);
			for (const msg of convo.messages.slice(0, 5)) {
				const ts = msg.createdAt
					? new Date(msg.createdAt).toISOString().slice(0, 19)
					: "";
				sections.push(`  ${ts} ${msg.speaker}: ${msg.text.slice(0, 200)}`);
			}
		}
	}

	if (detail.relationships.length > 0) {
		sections.push("\n## Relationships");
		for (const rel of detail.relationships) {
			const types = rel.relationshipTypes.join(", ") || "unknown";
			const target =
				rel.sourcePersonId === detail.primaryEntityId
					? rel.targetPersonName
					: rel.sourcePersonName;
			sections.push(
				`- ${target}: ${types} (strength: ${Math.round(rel.strength * 100)}%, sentiment: ${rel.sentiment}, interactions: ${rel.interactionCount})`,
			);
		}
	}

	return sections.join("\n");
}

function formatSearchResults(
	query: string,
	people: RelationshipsPersonSummary[],
): string {
	const lines: string[] = [];
	for (let i = 0; i < people.length; i++) {
		const person = people[i];
		const platforms = person.platforms.join(", ") || "none";
		const aliases =
			person.aliases.length > 0
				? ` (aka ${person.aliases.slice(0, 2).join(", ")})`
				: "";
		lines.push(
			`${String(i + 1).padStart(3, " ")} | ${person.displayName}${aliases} — ${platforms} — ${person.factCount} facts — entityId: ${person.primaryEntityId}`,
		);
	}
	return [
		`Search results for "${query}" | ${people.length} contacts found`,
		"─".repeat(60),
		lines.join("\n"),
	].join("\n");
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export const contactAction: Action = {
	name: CONTACT_ACTION,
	contexts: ["contacts", "messaging", "documents"],
	roleGate: { minRole: "ADMIN" },
	similes: [],
	description:
		"Manage Rolodex contacts. Op-based dispatch via the `op` parameter:\n" +
		"  create   — create a new contact (name required).\n" +
		"  read     — load full identity, facts, recent conversations, and relationships.\n" +
		"  search   — search by query/platform OR by category/tag filters.\n" +
		"  update   — update fields with mode={replace|add_to|remove_from}.\n" +
		"  delete   — permanently delete (confirm:true required).\n" +
		"  link     — propose / confirm a merge of two entities.\n" +
		"  merge    — accept or reject a pending merge candidate.\n" +
		"  activity — paginated activity timeline.",
	descriptionCompressed:
		"Rolodex contact management — op dispatch (create/read/search/update/delete/link/merge/activity)",

	validate: async (runtime: IAgentRuntime): Promise<boolean> => {
		return runtime.getService("relationships") !== null;
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		options?: HandlerOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const params = readContactParams(message, options);
		const op = params.op;

		if (!op) {
			const result = failure(
				op,
				`CONTACT requires an op parameter. Allowed: ${CONTACT_OPS.join(", ")}.`,
				"CONTACT_INVALID_OP",
			);
			await callback?.({ text: result.text, action: CONTACT_ACTION });
			return result;
		}

		const rs = getRelationships(runtime);
		if (!rs) {
			const result = failure(
				op,
				"Relationships service is not available.",
				"SERVICE_NOT_FOUND",
			);
			await callback?.({ text: result.text, action: CONTACT_ACTION });
			return result;
		}

		try {
			let result: ActionResult;
			switch (op) {
				case "create":
					result = await handleCreate(runtime, rs, params);
					break;
				case "read":
					result = await handleRead(rs, params);
					break;
				case "search":
					result = await handleSearch(rs, params);
					break;
				case "update":
					result = await handleUpdate(rs, params);
					break;
				case "delete":
					result = await handleDelete(runtime, rs, params);
					break;
				case "link":
					result = await handleLink(rs, params, message);
					break;
				case "merge":
					result = await handleMerge(rs, params);
					break;
				case "activity":
					result = await handleActivity(runtime, rs, params);
					break;
				default: {
					const _exhaustive: never = op;
					void _exhaustive;
					result = failure(
						op,
						`Unknown op "${String(op)}".`,
						"CONTACT_INVALID_OP",
					);
				}
			}

			await callback?.({
				text: result.text ?? "",
				action: CONTACT_ACTION,
				metadata: { op, success: result.success },
			});
			return result;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.error(`[CONTACT.${op}] Error: ${message}`);
			const result = failure(
				op,
				`CONTACT.${op} failed: ${message}`,
				`CONTACT_${op.toUpperCase()}_FAILED`,
			);
			await callback?.({
				text: result.text ?? "",
				action: CONTACT_ACTION,
				error: message,
			});
			return result;
		}
	},

	parameters: [
		{
			name: "op",
			description: `Operation: ${CONTACT_OPS.join(", ")}.`,
			required: true,
			schema: { type: "string" as const, enum: [...CONTACT_OPS] },
		},
		{
			name: "entityId",
			description:
				"Entity id (UUID). Required for read/update/delete/activity; optional for create/link.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "name",
			description:
				"Display name. Required for create; fallback look-up for read/update/delete.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "query",
			description: "search: name, handle, or search term.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "platform",
			description: "search: filter to a specific platform.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "limit",
			description: "search/activity: max results.",
			required: false,
			schema: { type: "number" as const },
		},
		{
			name: "offset",
			description: "activity: pagination offset.",
			required: false,
			schema: { type: "number" as const },
		},
		{
			name: "categories",
			description: "create/update/search: contact categories.",
			required: false,
			schema: {
				type: "array" as const,
				items: { type: "string" as const },
			},
		},
		{
			name: "tags",
			description: "create/update/search: contact tags.",
			required: false,
			schema: {
				type: "array" as const,
				items: { type: "string" as const },
			},
		},
		{
			name: "preferences",
			description: "create/update: contact preferences map.",
			required: false,
			schema: {
				type: "object" as const,
				additionalProperties: { type: "string" as const },
			},
		},
		{
			name: "customFields",
			description: "create/update: arbitrary custom fields.",
			required: false,
			schema: {
				type: "object" as const,
				additionalProperties: true,
			},
		},
		{
			name: "notes",
			description: "create/update: notes stored under preferences.notes.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "timezone",
			description: "create: contact timezone.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "language",
			description: "create: contact preferred language.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "mode",
			description:
				"update: how to apply list/map updates. One of replace, add_to, remove_from (default replace).",
			required: false,
			schema: {
				type: "string" as const,
				enum: ["replace", "add_to", "remove_from"] as const,
			},
		},
		{
			name: "confirm",
			description: "delete: must be true to acknowledge irreversibility.",
			required: false,
			schema: { type: "boolean" as const },
		},
		{
			name: "entityA",
			description: "link: first entity UUID.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "entityB",
			description: "link: second entity UUID.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "confirmation",
			description: "link: true to apply merge immediately, false to only propose.",
			required: false,
			schema: { type: "boolean" as const },
		},
		{
			name: "reason",
			description: "link: short explanation for the link.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "candidateId",
			description: "merge: candidate UUID.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "action",
			description: "merge: accept or reject.",
			required: false,
			schema: {
				type: "string" as const,
				enum: ["accept", "reject"] as const,
			},
		},
	],
};

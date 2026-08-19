/**
 * Implements the DOCUMENT umbrella action for the documents capability. One
 * planner-routed action whose structured `action`/`subaction` enum dispatches to
 * a per-subaction handler (list / search / read / write / edit / delete /
 * import_file / import_url), each backed by {@link DocumentService}. Routing
 * goes through {@link resolveActionArgs} on the structured params, never
 * natural-language keyword matching. Enforces the four visibility scopes
 * (global / owner-private / user-private / agent-private) and role-gated
 * write/mutation access, and registers the `documents` search category as a
 * side effect of validate/handler.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	resolveActionArgs,
	type SubactionsMap,
} from "../../actions/resolve-action-args";
import { ElizaError } from "../../errors";
import { logger } from "../../logger";
import { hasRoleAccess, isAgentSelf } from "../../roles";
import { unwrapUserMessageText } from "../../security/incoming-message-security.ts";
import type {
	Action,
	ActionExample,
	ActionResult,
	Content,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	SearchCategoryRegistration,
	State,
	UUID,
} from "../../types";
import { getActiveRoutingContextsForTurn } from "../../utils/context-routing.ts";
import {
	describeUserReference,
	userReferenceLogView as queryLogView,
} from "../../utils/reference-echo.ts";
import { addDocumentFromFilePath } from "./docs-loader.ts";
import {
	type DocumentListResult,
	DocumentService,
	resolveDocumentRequesterRole,
	type SearchMode,
} from "./service.ts";
import type {
	DocumentAddedByRole,
	DocumentAddedFrom,
	DocumentVisibilityScope,
	StoredDocument,
} from "./types.ts";
import { fetchDocumentFromUrl, isYouTubeUrl } from "./url-ingest.ts";
import { createDocumentNoteFilename, deriveDocumentTitle } from "./utils.ts";

// Blob-safe rendering rationale lives in utils/reference-echo.ts.
const describeQuery = (query: string): string =>
	describeUserReference(query, "that search");

type DocumentSubAction =
	| "list"
	| "search"
	| "read"
	| "write"
	| "edit"
	| "delete"
	| "import_file"
	| "import_url";

type DocumentActionParameters = {
	action?: string;
	subaction?: string;
	query?: string;
	id?: string;
	documentId?: string;
	text?: string;
	content?: string;
	title?: string;
	filePath?: string;
	url?: string;
	tags?: string[];
	limit?: number;
	offset?: number;
	searchMode?: string;
	includeImageDescriptions?: boolean;
	scope?: string;
	scopedToEntityId?: string;
	addedBy?: string;
	timeRangeStart?: string | number;
	timeRangeEnd?: string | number;
};

/**
 * Route-only subaction map: the planner selects the DOCUMENT subaction by
 * emitting a structured English-enum `action`/`subaction` value, and
 * {@link resolveActionArgs} routes on it. Subactions whose values are natural
 * language (`search.query`, `write.text`) require the planner/extractor to
 * supply those values instead of trimming English command prefixes from the
 * user's text. ID/path/URL subactions keep `required: []` because their
 * handlers can recover values from structural machine extractors (UUID /
 * file-path / URL patterns) before prompting for missing details. The
 * `optional` lists mirror the {@link DocumentActionParameters} keys each
 * handler reads so the resolver forwards them through.
 */
const DOCUMENT_SUBACTIONS: SubactionsMap<DocumentSubAction> = {
	list: {
		description: "List available stored documents, optionally filtered.",
		descriptionCompressed: "list stored documents w/ filters",
		required: [],
		optional: [
			"query",
			"limit",
			"offset",
			"scope",
			"scopedToEntityId",
			"addedBy",
			"timeRangeStart",
			"timeRangeEnd",
			"tags",
		],
	},
	search: {
		description: "Semantic + keyword search over stored document fragments.",
		descriptionCompressed: "search document fragments by query",
		required: ["query"],
		optional: [
			"limit",
			"searchMode",
			"scope",
			"scopedToEntityId",
			"addedBy",
			"timeRangeStart",
			"timeRangeEnd",
			"tags",
		],
	},
	read: {
		description: "Read the full text of one stored document by id.",
		descriptionCompressed: "read document by id",
		required: [],
		optional: ["id", "documentId"],
	},
	write: {
		description: "Create a new text-backed document from supplied content.",
		descriptionCompressed: "create text document",
		required: ["text"],
		optional: ["content", "title", "tags", "scope", "scopedToEntityId"],
	},
	edit: {
		description: "Replace the content of an existing document by id.",
		descriptionCompressed: "edit document content by id",
		required: [],
		optional: ["id", "documentId", "text", "content"],
	},
	delete: {
		description: "Delete a stored document by id.",
		descriptionCompressed: "delete document by id",
		required: [],
		optional: ["id", "documentId"],
	},
	import_file: {
		description: "Import a document from a local file path or text content.",
		descriptionCompressed: "import document from file path",
		required: [],
		optional: ["filePath", "content", "title", "scope", "scopedToEntityId"],
	},
	import_url: {
		description: "Import a document from an HTTP or HTTPS URL.",
		descriptionCompressed: "import document from url",
		required: [],
		optional: ["url", "includeImageDescriptions", "scope", "scopedToEntityId"],
	},
};

const DOCUMENT_SUB_ACTION_KEYS = Object.keys(
	DOCUMENT_SUBACTIONS,
) as DocumentSubAction[];

/**
 * Subactions that only read the document store. On `knowledge`-routed turns
 * (retrieval-only by taxonomy) the DOCUMENT action is admitted so the model
 * can dereference the document IDs the DOCUMENTS provider advertises, but the
 * handler restricts execution to this read-only surface — mutations require
 * `documents` routing. See the operation gate in the handler.
 */
const READ_ONLY_DOCUMENT_SUBACTIONS: ReadonlySet<DocumentSubAction> = new Set([
	"list",
	"search",
	"read",
]);

/**
 * Rejects mutating subactions on turns stage-1 routed to `knowledge` without
 * also routing to `documents`. The context gate admits DOCUMENT on knowledge
 * turns for reads only; blanket-widening `contexts` alone would expose
 * write/edit/delete/import on a retrieval-only routing surface. Unrouted
 * invocations (no routing metadata on state or message) are unaffected — the
 * gate narrows knowledge-routed turns, it does not invent a restriction for
 * direct callers.
 */
function knowledgeReadOnlyRejection(
	subaction: DocumentSubAction,
	message: Memory,
	state: State | undefined,
): string | null {
	if (READ_ONLY_DOCUMENT_SUBACTIONS.has(subaction)) {
		return null;
	}
	const activeContexts = getActiveRoutingContextsForTurn(state, message).map(
		(context) => `${context}`.toLowerCase(),
	);
	if (
		!activeContexts.includes("knowledge") ||
		activeContexts.includes("documents")
	) {
		return null;
	}
	return (
		`The documents ${subaction.replace("_", " ")} operation is not available on a knowledge-routed turn; ` +
		"knowledge is retrieval-only (list, search, read). Ask again as an explicit document request to modify stored documents."
	);
}

const DOCUMENT_SCOPES = new Set<DocumentVisibilityScope>([
	"global",
	"owner-private",
	"user-private",
	"agent-private",
]);
const DOCUMENT_SCOPE_OPTIONS = [...DOCUMENT_SCOPES, "all-visible"] as const;

const DOCUMENT_PATH_PATTERN =
	/(?:\/[\w .-]+)+|(?:[a-zA-Z]:[\\/][\w\s.-]+(?:[\\/][\w\s.-]+)*)/;
const URL_PATTERN = /https?:\/\/[^\s)]+/i;

const DOCUMENTS_SEARCH_CATEGORY: SearchCategoryRegistration = {
	category: "documents",
	label: "Documents",
	description: "Search stored documents and fragments.",
	contexts: ["documents"],
	filters: [
		{
			name: "scope",
			label: "Scope",
			description: "Optional visibility scope for stored documents.",
			type: "enum",
			options: [
				{ label: "Global", value: "global" },
				{ label: "Owner private", value: "owner-private" },
				{ label: "User private", value: "user-private" },
				{ label: "Agent private", value: "agent-private" },
			],
		},
	],
	resultSchemaSummary:
		"StoredDocument[] with id, content.text, similarity, metadata, and worldId.",
	capabilities: ["semantic", "documents", "fragments"],
	source: "core:documents",
	serviceType: DocumentService.serviceType,
};

function hasSearchCategory(runtime: IAgentRuntime, category: string): boolean {
	try {
		runtime.getSearchCategory(category, { includeDisabled: true });
		return true;
	} catch {
		// error-policy:J4 getSearchCategory uses a throw to signal an absent
		// optional registry entry; callers register it on this explicit miss.
		return false;
	}
}

export function registerDocumentsSearchCategory(runtime: IAgentRuntime): void {
	if (!hasSearchCategory(runtime, DOCUMENTS_SEARCH_CATEGORY.category)) {
		runtime.registerSearchCategory(DOCUMENTS_SEARCH_CATEGORY);
	}
}

function isUuid(value: string): value is UUID {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
		value,
	);
}

function getDocumentId(
	params: DocumentActionParameters,
	message: Memory,
): UUID | null {
	const candidate = (params.documentId ?? params.id)?.trim();
	if (candidate && isUuid(candidate)) return candidate;

	// Extract from the user's actual words: on hardened connectors
	// content.text is core's external-content security envelope.
	const match = unwrapUserMessageText(message).match(
		/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
	);
	return match?.[0] && isUuid(match[0]) ? match[0] : null;
}

function getSearchMode(value: unknown): SearchMode | undefined {
	return value === "hybrid" || value === "vector" || value === "keyword"
		? value
		: undefined;
}

function getLimit(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 1
		? Math.min(100, Math.floor(value))
		: fallback;
}

function getScope(
	runtime: IAgentRuntime,
	message: Memory,
	params: DocumentActionParameters,
): DocumentVisibilityScope {
	const raw = params.scope?.trim() as DocumentVisibilityScope | undefined;
	if (raw && DOCUMENT_SCOPES.has(raw)) {
		return raw;
	}
	return message.entityId && message.entityId !== runtime.agentId
		? "user-private"
		: "agent-private";
}

function getScopedToEntityId(
	runtime: IAgentRuntime,
	message: Memory,
	scope: DocumentVisibilityScope,
	params?: DocumentActionParameters,
): UUID | undefined {
	if (scope === "global") return undefined;
	if (scope === "agent-private") return runtime.agentId;
	if (scope === "owner-private") {
		const ownerId = runtime.getSetting("ELIZA_ADMIN_ENTITY_ID");
		return typeof ownerId === "string" && ownerId.trim()
			? (ownerId.trim() as UUID)
			: message.entityId;
	}
	if (
		typeof params?.scopedToEntityId === "string" &&
		isUuid(params.scopedToEntityId)
	) {
		return params.scopedToEntityId;
	}
	return message.entityId;
}

async function getAddedByRole(
	runtime: IAgentRuntime,
	message: Memory,
): Promise<DocumentAddedByRole> {
	return (await resolveDocumentRequesterRole(runtime, message)).role;
}

async function ensureWriteAccess(
	runtime: IAgentRuntime,
	message: Memory,
	scope: DocumentVisibilityScope,
	scopedToEntityId?: UUID,
): Promise<string | null> {
	if (scope === "global" || scope === "owner-private") {
		return (await hasRoleAccess(runtime, message, "OWNER"))
			? null
			: "Only the owner can write global or owner-private documents.";
	}
	if (scope === "agent-private") {
		return isAgentSelf(runtime, message) ||
			(await hasRoleAccess(runtime, message, "OWNER"))
			? null
			: "Only the owner or agent runtime can write agent-private documents.";
	}
	if (
		scopedToEntityId &&
		message.entityId &&
		scopedToEntityId !== message.entityId &&
		!(await hasRoleAccess(runtime, message, "OWNER")) &&
		!isAgentSelf(runtime, message)
	) {
		return "Users can only write documents to their own private scope.";
	}
	return null;
}

function getCleanWriteText(params: DocumentActionParameters): string {
	const explicit = params.text ?? params.content;
	if (typeof explicit === "string" && explicit.trim()) {
		return explicit.trim();
	}
	return "";
}

function getQuery(params: DocumentActionParameters): string {
	if (typeof params.query === "string" && params.query.trim()) {
		return params.query.trim();
	}
	return "";
}

function getOptionalPlannerString(
	value: unknown,
	message: Memory,
): string | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	const normalized = value.trim();
	if (
		normalized === "0" &&
		!/(?:^|\D)0(?:\D|$)/.test(message.content.text ?? "")
	) {
		return undefined;
	}
	return normalized;
}

function getDocumentFilterParams(
	params: DocumentActionParameters,
	message: Memory,
): {
	scope?: DocumentVisibilityScope;
	scopedToEntityId?: UUID;
	addedBy?: UUID;
	timeRangeStart?: number;
	timeRangeEnd?: number;
	tags?: string[];
} {
	const scope =
		typeof params.scope === "string" &&
		DOCUMENT_SCOPES.has(params.scope as DocumentVisibilityScope)
			? (params.scope as DocumentVisibilityScope)
			: undefined;
	const scopedToEntityId =
		typeof params.scopedToEntityId === "string" &&
		isUuid(params.scopedToEntityId)
			? (params.scopedToEntityId as UUID)
			: undefined;
	const addedBy =
		typeof params.addedBy === "string" && isUuid(params.addedBy)
			? (params.addedBy as UUID)
			: undefined;
	const timeRangeStart = parseTimestampParam(
		getOptionalPlannerString(params.timeRangeStart, message),
	);
	const timeRangeEnd = parseTimestampParam(
		getOptionalPlannerString(params.timeRangeEnd, message),
	);
	const tags = Array.isArray(params.tags)
		? params.tags.filter((tag): tag is string => typeof tag === "string")
		: undefined;
	return {
		...(scope ? { scope } : {}),
		...(scopedToEntityId ? { scopedToEntityId } : {}),
		...(addedBy ? { addedBy } : {}),
		...(typeof timeRangeStart === "number" ? { timeRangeStart } : {}),
		...(typeof timeRangeEnd === "number" ? { timeRangeEnd } : {}),
		...(tags && tags.length > 0 ? { tags } : {}),
	};
}

function storedDocumentMatchesFilters(
	document: StoredDocument,
	filters: ReturnType<typeof getDocumentFilterParams>,
): boolean {
	const metadata = (document.metadata ?? {}) as Record<string, unknown>;
	if (filters.scope && metadata.scope !== filters.scope) return false;
	if (
		filters.scopedToEntityId &&
		metadata.scopedToEntityId !== filters.scopedToEntityId
	) {
		return false;
	}
	if (filters.addedBy && metadata.addedBy !== filters.addedBy) return false;
	if (filters.tags && filters.tags.length > 0) {
		const documentTags = Array.isArray(metadata.tags)
			? metadata.tags.filter(
					(value): value is string => typeof value === "string",
				)
			: [];
		if (!filters.tags.every((tag) => documentTags.includes(tag))) {
			return false;
		}
	}
	const timestamp =
		typeof metadata.timestamp === "number"
			? metadata.timestamp
			: typeof metadata.addedAt === "number"
				? metadata.addedAt
				: undefined;
	if (
		typeof filters.timeRangeStart === "number" &&
		(typeof timestamp !== "number" || timestamp < filters.timeRangeStart)
	) {
		return false;
	}
	if (
		typeof filters.timeRangeEnd === "number" &&
		(typeof timestamp !== "number" || timestamp > filters.timeRangeEnd)
	) {
		return false;
	}
	return true;
}

function getFilePath(
	params: DocumentActionParameters,
	message: Memory,
): string | null {
	if (typeof params.filePath === "string" && params.filePath.trim()) {
		return params.filePath.trim();
	}
	return (
		unwrapUserMessageText(message).match(DOCUMENT_PATH_PATTERN)?.[0] ?? null
	);
}

function getUrl(
	params: DocumentActionParameters,
	message: Memory,
): string | null {
	if (typeof params.url === "string" && params.url.trim()) {
		return params.url.trim();
	}
	return unwrapUserMessageText(message).match(URL_PATTERN)?.[0] ?? null;
}

async function scopedAddOptions(
	runtime: IAgentRuntime,
	message: Memory,
	scope: DocumentVisibilityScope,
	addedFrom: DocumentAddedFrom,
	params?: DocumentActionParameters,
) {
	const scopedToEntityId = getScopedToEntityId(runtime, message, scope, params);
	const addedBy = message.entityId;
	let worldId = message.worldId as UUID | undefined;
	if (!worldId) {
		let room: Awaited<ReturnType<typeof runtime.getRoom>>;
		try {
			room = await runtime.getRoom(message.roomId as UUID);
		} catch (cause) {
			// error-policy:J2 Required document scope lookup failed; preserve the adapter failure.
			throw new ElizaError("Document room lookup failed", {
				code: "DOCUMENT_ROOM_LOOKUP_FAILED",
				context: { roomId: message.roomId },
				cause,
			});
		}
		if (!room?.worldId) {
			throw new ElizaError("Document world resolution failed", {
				code: "DOCUMENT_WORLD_MISSING",
				context: { roomId: message.roomId },
			});
		}
		worldId = room.worldId as UUID;
	}
	return {
		agentId: runtime.agentId,
		worldId,
		roomId: message.roomId,
		entityId: scopedToEntityId ?? addedBy,
		scope,
		scopedToEntityId,
		addedBy,
		addedByRole: await getAddedByRole(runtime, message),
		addedFrom,
	};
}

function result(
	success: boolean,
	text: string,
	subaction: DocumentSubAction,
	extra: Omit<ActionResult, "success" | "text" | "data"> & {
		data?: Record<string, unknown>;
	} = {},
): ActionResult {
	return {
		...extra,
		success,
		text,
		data: {
			actionName: "DOCUMENT",
			subaction,
			...(extra.data ?? {}),
		},
	};
}

async function emit(
	callback: HandlerCallback | undefined,
	content: Content,
): Promise<void> {
	await callback?.(content);
}

async function handleSearch(
	service: DocumentService,
	message: Memory,
	params: DocumentActionParameters,
	_callback?: HandlerCallback,
): Promise<ActionResult> {
	const query = getQuery(params);
	if (!query) {
		// Planner-facing only: canned clarifications double-message next to the
		// evaluator's in-voice reply. The evaluator owns asking the user, in voice.
		const text =
			"No search query found in the request; ask the user what they'd like to search for in documents.";
		return result(false, text, "search", {
			values: { error: "missing_query" },
		});
	}

	const searchMessage: Memory = {
		...message,
		content: { ...message.content, text: query },
	};
	const filters = getDocumentFilterParams(params, message);
	const matches = await service.searchDocuments(
		searchMessage,
		filters.scopedToEntityId
			? { entityId: filters.scopedToEntityId }
			: undefined,
		getSearchMode(params.searchMode),
	);
	const limit = getLimit(params.limit, 5);
	const filteredMatches = matches.filter((item) =>
		storedDocumentMatchesFilters(item, filters),
	);
	const hasMoreInWindow = filteredMatches.length > limit;
	const visible = filteredMatches.slice(0, limit);
	const projected = visible.map((item) => {
		const metadata = item.metadata as Record<string, unknown> | undefined;
		return {
			...item,
			transcriptId:
				typeof metadata?.transcriptId === "string"
					? metadata.transcriptId
					: undefined,
			startMs:
				typeof metadata?.startMs === "number" ? metadata.startMs : undefined,
			endMs: typeof metadata?.endMs === "number" ? metadata.endMs : undefined,
		};
	});
	const retrievalScope = `Searched a bounded ranked retrieval window of ${matches.length} fragment(s); completeness beyond that window is unknown.`;
	const text = `${
		projected.length === 0
			? `No document fragments matching ${describeQuery(query)} were returned from that window.`
			: `Found ${projected.length} document fragment(s) for ${describeQuery(query)}:\n\n${projected
					.map((item, index) => `${index + 1}. ${item.content.text ?? ""}`)
					.join("\n\n")}`
	} ${retrievalScope}${
		hasMoreInWindow
			? ` More filtered matches exist within the retrieved window beyond the ${limit} shown.`
			: ""
	}`;
	const filtersApplied = [
		filters.scope ? "scope" : undefined,
		filters.scopedToEntityId ? "scopedToEntityId" : undefined,
		filters.addedBy ? "addedBy" : undefined,
		filters.timeRangeStart !== undefined ? "timeRangeStart" : undefined,
		filters.timeRangeEnd !== undefined ? "timeRangeEnd" : undefined,
		filters.tags ? "tags" : undefined,
	].filter((name): name is string => name !== undefined);
	// No visible callback: fragments are intermediate retrieval data for the
	// planner to synthesize into the answer, not the answer itself.
	return result(true, text, "search", {
		values: {
			query: queryLogView(query),
			results: projected,
			scope: {
				retrieved: matches.length,
				matchedInWindow: filteredMatches.length,
				shown: projected.length,
				limit,
				hasMoreInWindow,
				retrievalCompleteness: "unknown_beyond_ranked_window",
				filtersApplied,
			},
		},
		data: {
			query: queryLogView(query),
			results: projected,
			scope: {
				retrieved: matches.length,
				matchedInWindow: filteredMatches.length,
				shown: projected.length,
				limit,
				hasMoreInWindow,
				retrievalCompleteness: "unknown_beyond_ranked_window",
				filtersApplied,
			},
		},
	});
}

async function handleRead(
	service: DocumentService,
	message: Memory,
	params: DocumentActionParameters,
	_callback?: HandlerCallback,
): Promise<ActionResult> {
	const documentId = getDocumentId(params, message);
	if (!documentId) {
		const text =
			"No valid document id found in the request; ask the user which document to read.";
		return result(false, text, "read", { values: { error: "invalid_id" } });
	}

	const document = await service.getDocumentById(documentId, message);
	if (!document) {
		const text = `Document ${documentId} was not found; tell the user it doesn't exist.`;
		return result(false, text, "read", { values: { error: "not_found" } });
	}

	// No visible callback: dumping the raw document text as a chat bubble is
	// not the answer — the planner presents the content in voice.
	const text = document.content.text ?? "";
	return result(true, text, "read", {
		values: { documentId, textLength: text.length },
		data: { document },
	});
}

async function handleWrite(
	runtime: IAgentRuntime,
	service: DocumentService,
	message: Memory,
	params: DocumentActionParameters,
	callback?: HandlerCallback,
): Promise<ActionResult> {
	const text = getCleanWriteText(params);
	if (!text) {
		const response =
			"No document text found in the request; ask the user what the document should contain.";
		return result(false, response, "write", {
			values: { error: "missing_text" },
		});
	}

	const scope = getScope(runtime, message, params);
	const scopedToEntityId = getScopedToEntityId(runtime, message, scope, params);
	const accessError = await ensureWriteAccess(
		runtime,
		message,
		scope,
		scopedToEntityId,
	);
	if (accessError) {
		return result(false, accessError, "write", {
			values: { error: "forbidden" },
		});
	}

	const title =
		typeof params.title === "string" && params.title.trim()
			? params.title.trim()
			: deriveDocumentTitle(text, "Stored document");
	const filename = createDocumentNoteFilename(title);
	const addOptions = await scopedAddOptions(
		runtime,
		message,
		scope,
		"chat",
		params,
	);
	const tags = Array.isArray(params.tags) ? params.tags : [];
	const stored = await service.addDocument({
		...addOptions,
		clientDocumentId: "" as UUID,
		contentType: "text/plain",
		originalFilename: filename,
		content: text,
		metadata: {
			source: "chat",
			title,
			filename,
			originalFilename: filename,
			fileExt: "txt",
			fileType: "text/plain",
			contentType: "text/plain",
			fileSize: Buffer.byteLength(text, "utf8"),
			textBacked: true,
			...(tags.length > 0 ? { tags } : {}),
		},
	});

	// Humanized single delivery: the save confirmation is the complete answer,
	// so verified + turnComplete keep the evaluator from double-messaging. The
	// UUID and fragment count stay planner-facing in values/data.
	const response = `Saved "${title}" to your documents.`;
	await emit(callback, { text: response, actions: ["DOCUMENT"] });
	return result(true, response, "write", {
		userFacingText: response,
		verifiedUserFacing: true,
		turnComplete: true,
		values: {
			documentId: stored.clientDocumentId,
			fragmentCount: stored.fragmentCount,
			title,
			scope,
		},
		data: { documentId: stored.clientDocumentId, filename, scope },
	});
}

async function handleEdit(
	service: DocumentService,
	message: Memory,
	params: DocumentActionParameters,
	callback?: HandlerCallback,
): Promise<ActionResult> {
	const documentId = getDocumentId(params, message);
	const text = typeof params.text === "string" ? params.text : params.content;
	if (!documentId) {
		const response =
			"No valid document id found in the request; ask the user which document to edit.";
		return result(false, response, "edit", { values: { error: "invalid_id" } });
	}
	if (typeof text !== "string" || !text.trim()) {
		const response =
			"No replacement text found in the request; ask the user what the document should say.";
		return result(false, response, "edit", {
			values: { error: "missing_text" },
		});
	}

	const updated = await service.updateDocument({
		documentId,
		content: text.trim(),
		message,
	});
	// Humanized single delivery: the update confirmation is the complete
	// answer; the UUID and fragment count stay planner-facing in values.
	const response = "Updated the document.";
	await emit(callback, { text: response, actions: ["DOCUMENT"] });
	return result(true, response, "edit", {
		userFacingText: response,
		verifiedUserFacing: true,
		turnComplete: true,
		values: {
			documentId: updated.documentId,
			fragmentCount: updated.fragmentCount,
		},
	});
}

async function handleDelete(
	service: DocumentService,
	message: Memory,
	params: DocumentActionParameters,
	callback?: HandlerCallback,
): Promise<ActionResult> {
	const documentId = getDocumentId(params, message);
	if (!documentId) {
		const text =
			"No valid document id found in the request; ask the user which document to delete.";
		return result(false, text, "delete", { values: { error: "invalid_id" } });
	}

	// error-policy:J1 boundary translation — the action IS the boundary between
	// the document service's typed errors and the model-visible ActionResult. An
	// escaping ElizaError aborts the whole turn, so the two outcomes a caller can
	// legitimately provoke (no such document, not allowed to delete it) become
	// structured refusals the planner can read. Anything else still propagates:
	// an adapter/transport fault is not a refusal and must not be reported as one.
	try {
		await service.deleteDocument(documentId, message);
	} catch (error) {
		// error-policy:J1 Delete translates authorization and persistence
		// failures into explicit action results.
		const code = error instanceof ElizaError ? error.code : undefined;
		if (code === "DOCUMENT_MUTATION_FORBIDDEN") {
			const text =
				"Only the owner can edit or delete global and owner-private documents; tell the user this one is off limits.";
			return result(false, text, "delete", {
				values: { error: "forbidden", documentId },
			});
		}
		if (code === "DOCUMENT_NOT_FOUND") {
			const text = `Document ${documentId} was not found; tell the user there's nothing to delete.`;
			return result(false, text, "delete", {
				values: { error: "not_found", documentId },
			});
		}
		throw error;
	}
	// Humanized single delivery: the delete confirmation is the complete
	// answer; the UUID stays planner-facing in values.
	const text = "Deleted the document.";
	await emit(callback, { text, actions: ["DOCUMENT"] });
	return result(true, text, "delete", {
		userFacingText: text,
		verifiedUserFacing: true,
		turnComplete: true,
		values: { documentId },
	});
}

function parseTimestampParam(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Date.parse(value.trim());
		if (Number.isFinite(parsed)) return parsed;
		const numeric = Number(value.trim());
		if (Number.isFinite(numeric)) return numeric;
	}
	return undefined;
}

function formatDocumentList(documents: Memory[]): string {
	return `Available documents:\n${documents
		.map((document, index) => {
			const metadata = document.metadata as Record<string, unknown> | undefined;
			const title =
				typeof metadata?.title === "string"
					? metadata.title
					: typeof metadata?.filename === "string"
						? metadata.filename
						: `Document ${index + 1}`;
			return `${index + 1}. ${title} (${document.id})`;
		})
		.join("\n")}`;
}

function formatDocumentListResult(result: DocumentListResult): string {
	switch (result.status) {
		case "empty_store":
			return "No documents are available.";
		case "filter_miss":
			return "No documents matched the requested filters.";
		case "query_miss":
			if (result.availableDocuments.length === 0) {
				return `No documents matched ${describeQuery(result.query ?? "")}. Available-document offset ${result.availableOffset} is past the ${result.totalAvailable} documents allowed by the requested filters.`;
			}
			return `No documents matched ${describeQuery(result.query ?? "")}. Showing available documents${result.availableOffset > 0 ? ` from offset ${result.availableOffset}` : ""} instead:\n${formatDocumentList(result.availableDocuments)}`;
		case "page_exhausted": {
			const matchDescription = result.query
				? `documents matching ${describeQuery(result.query)}`
				: "available documents";
			return `Offset ${result.offset} is past the ${result.totalMatched} ${matchDescription}.`;
		}
		case "ok":
			return formatDocumentList(result.documents);
	}
}

async function handleList(
	service: DocumentService,
	message: Memory,
	params: DocumentActionParameters,
	callback?: HandlerCallback,
): Promise<ActionResult> {
	const scope =
		typeof params.scope === "string" &&
		DOCUMENT_SCOPES.has(params.scope as DocumentVisibilityScope)
			? (params.scope as DocumentVisibilityScope)
			: undefined;
	const scopedToEntityId =
		typeof params.scopedToEntityId === "string" &&
		isUuid(params.scopedToEntityId)
			? (params.scopedToEntityId as UUID)
			: undefined;
	const addedBy =
		typeof params.addedBy === "string" && isUuid(params.addedBy)
			? (params.addedBy as UUID)
			: undefined;
	const timeRangeStart = parseTimestampParam(
		getOptionalPlannerString(params.timeRangeStart, message),
	);
	const timeRangeEnd = parseTimestampParam(
		getOptionalPlannerString(params.timeRangeEnd, message),
	);
	const query = getOptionalPlannerString(params.query, message);
	const offset =
		typeof params.offset === "number" && params.offset >= 0
			? Math.floor(params.offset)
			: undefined;

	const listResult = await service.listDocumentsDetailed(message, {
		limit: getLimit(params.limit, 25),
		offset,
		query,
		scope,
		scopedToEntityId,
		addedBy,
		timeRangeStart,
		timeRangeEnd,
		tags: Array.isArray(params.tags) ? params.tags : undefined,
	});
	const text = formatDocumentListResult(listResult);
	const listData = {
		documents: listResult.documents,
		availableDocuments: listResult.availableDocuments,
		status: listResult.status,
		...(listResult.query ? { query: queryLogView(listResult.query) } : {}),
		limit: listResult.limit,
		offset: listResult.offset,
		totalVisible: listResult.totalVisible,
		totalAvailable: listResult.totalAvailable,
		totalMatched: listResult.totalMatched,
		hasMore: listResult.hasMore,
		availableOffset: listResult.availableOffset,
		availableHasMore: listResult.availableHasMore,
		...(listResult.nextCursor ? { nextCursor: listResult.nextCursor } : {}),
		...(listResult.availableNextCursor
			? { availableNextCursor: listResult.availableNextCursor }
			: {}),
	};
	await emit(callback, { text, actions: ["DOCUMENT"] });
	// The listing IS the complete answer: verified + turnComplete make the
	// callback the sole delivery instead of double-messaging with the evaluator.
	return result(true, text, "list", {
		userFacingText: text,
		verifiedUserFacing: true,
		turnComplete: true,
		values: listData,
		data: listData,
	});
}

async function handleImportFile(
	runtime: IAgentRuntime,
	service: DocumentService,
	message: Memory,
	params: DocumentActionParameters,
	callback?: HandlerCallback,
): Promise<ActionResult> {
	const filePath = getFilePath(params, message);
	const content =
		typeof params.content === "string" ? params.content.trim() : "";
	if (!filePath && !content) {
		const text =
			"No file path or text content found in the request; ask the user what to import.";
		return result(false, text, "import_file", {
			values: { error: "missing_source" },
		});
	}

	const scope = getScope(runtime, message, params);
	const scopedToEntityId = getScopedToEntityId(runtime, message, scope, params);
	const accessError = await ensureWriteAccess(
		runtime,
		message,
		scope,
		scopedToEntityId,
	);
	if (accessError) {
		return result(false, accessError, "import_file", {
			values: { error: "forbidden" },
		});
	}

	const addOptions = await scopedAddOptions(
		runtime,
		message,
		scope,
		"file",
		params,
	);
	if (filePath) {
		const canReadHostFile =
			isAgentSelf(runtime, message) ||
			(await hasRoleAccess(runtime, message, "OWNER"));
		if (!canReadHostFile) {
			const text =
				"Only the owner or agent runtime can import a local host file. Upload the document content or use a URL instead.";
			return result(false, text, "import_file", {
				values: { error: "forbidden", filePath: queryLogView(filePath) },
			});
		}
		if (!fs.existsSync(filePath)) {
			const text = `No file exists at ${describeUserReference(filePath, "that path")}; tell the user it couldn't be found.`;
			return result(false, text, "import_file", {
				values: { error: "not_found", filePath: queryLogView(filePath) },
			});
		}
		const stored = await addDocumentFromFilePath({
			service,
			filePath,
			...addOptions,
			metadata: {
				source: "file",
				importedFromPath: filePath,
			},
		});
		const filename = path.basename(filePath);
		// Humanized single delivery: the import confirmation is the complete
		// answer; the UUID and fragment count stay planner-facing in values.
		const text = `Imported "${filename}" into your documents.`;
		await emit(callback, { text, actions: ["DOCUMENT"] });
		return result(true, text, "import_file", {
			userFacingText: text,
			verifiedUserFacing: true,
			turnComplete: true,
			values: {
				documentId: stored.clientDocumentId,
				fragmentCount: stored.fragmentCount,
				filename,
				scope,
			},
		});
	}

	const title =
		typeof params.title === "string" && params.title.trim()
			? params.title.trim()
			: deriveDocumentTitle(content, "Stored document");
	const filename = createDocumentNoteFilename(title);
	const stored = await service.addDocument({
		...addOptions,
		clientDocumentId: "" as UUID,
		contentType: "text/plain",
		originalFilename: filename,
		content,
		metadata: {
			source: "file",
			title,
			filename,
			originalFilename: filename,
			fileExt: "txt",
			fileType: "text/plain",
			contentType: "text/plain",
			fileSize: Buffer.byteLength(content, "utf8"),
			textBacked: true,
		},
	});
	const text = `Imported "${title}" into your documents.`;
	await emit(callback, { text, actions: ["DOCUMENT"] });
	return result(true, text, "import_file", {
		userFacingText: text,
		verifiedUserFacing: true,
		turnComplete: true,
		values: {
			documentId: stored.clientDocumentId,
			fragmentCount: stored.fragmentCount,
			title,
			scope,
		},
	});
}

async function handleImportUrl(
	runtime: IAgentRuntime,
	service: DocumentService,
	message: Memory,
	params: DocumentActionParameters,
	callback?: HandlerCallback,
): Promise<ActionResult> {
	const url = getUrl(params, message);
	if (!url) {
		const text =
			"No URL found in the request; ask the user which URL to import.";
		return result(false, text, "import_url", {
			values: { error: "missing_url" },
		});
	}

	const fetched = await fetchDocumentFromUrl(url, {
		includeImageDescriptions: params.includeImageDescriptions === true,
	});
	const scope = getScope(runtime, message, params);
	const scopedToEntityId = getScopedToEntityId(runtime, message, scope, params);
	const accessError = await ensureWriteAccess(
		runtime,
		message,
		scope,
		scopedToEntityId,
	);
	if (accessError) {
		return result(false, accessError, "import_url", {
			values: { error: "forbidden" },
		});
	}
	const addOptions = await scopedAddOptions(
		runtime,
		message,
		scope,
		"url",
		params,
	);
	const isTextBacked = fetched.contentType !== "binary";
	const isYouTube = isYouTubeUrl(url);
	const stored = await service.addDocument({
		...addOptions,
		clientDocumentId: "" as UUID,
		contentType: fetched.mimeType,
		originalFilename: fetched.filename,
		content: fetched.content,
		metadata: {
			url,
			source: isYouTube ? "youtube" : "url",
			filename: fetched.filename,
			originalFilename: fetched.filename,
			fileType: fetched.mimeType,
			contentType: fetched.mimeType,
			textBacked: isTextBacked,
			includeImageDescriptions: params.includeImageDescriptions === true,
			...(fetched.contentType === "transcript"
				? { isYouTubeTranscript: true }
				: {}),
		},
	});

	const label =
		fetched.contentType === "transcript"
			? "transcript"
			: fetched.contentType === "html"
				? "page"
				: "document";
	// Humanized single delivery: the import confirmation is the complete
	// answer; filename and fragment count stay planner-facing in values.
	const text = `Imported the ${label} from ${url} into your documents.`;
	await emit(callback, { text, actions: ["DOCUMENT"] });
	return result(true, text, "import_url", {
		userFacingText: text,
		verifiedUserFacing: true,
		turnComplete: true,
		values: {
			documentId: stored.clientDocumentId,
			fragmentCount: stored.fragmentCount,
			filename: fetched.filename,
			scope,
		},
	});
}

export const documentAction: Action = {
	name: "DOCUMENT",
	// Exact-membership context gates do not expand parent/child relationships
	// (#19701), and the DOCUMENTS provider composes for both `documents` and
	// `knowledge` — advertising document IDs "for follow-up reads". The action
	// must be admitted in both contexts or knowledge-routed turns hand the
	// model IDs it cannot dereference. `knowledge` stays retrieval-only via the
	// handler's operation gate (see knowledgeReadOnlyRejection): mutating
	// subactions require `documents` routing.
	contexts: ["documents", "knowledge"],
	contextGate: { anyOf: ["documents", "knowledge"] },
	roleGate: { minRole: "USER" },
	description:
		"List, search, read, write, edit, delete, and import stored documents. Select one action and provide the fields needed for that operation.",
	descriptionCompressed:
		"documents action=list|search|read|write|edit|delete|import_file|import_url",
	suppressPostActionContinuation: true,
	parameters: [
		{
			name: "action",
			description:
				"Document operation to perform: list, search, read, write, edit, delete, import_file, or import_url.",
			required: true,
			schema: {
				type: "string",
				enum: [...DOCUMENT_SUB_ACTION_KEYS],
			},
		},
		{
			name: "query",
			description: "Search or list filter query.",
			required: false,
			schema: { type: "string" },
		},
		{
			name: "id",
			description: "Document UUID for read, edit, or delete.",
			required: false,
			schema: { type: "string" },
		},
		{
			name: "documentId",
			description: "Document UUID for read, edit, or delete.",
			required: false,
			schema: { type: "string" },
		},
		{
			name: "text",
			description: "Text to write or replacement text for edit.",
			required: false,
			schema: { type: "string" },
		},
		{
			name: "content",
			description: "Text content to import or write.",
			required: false,
			schema: { type: "string" },
		},
		{
			name: "title",
			description: "Optional title for text-backed documents.",
			required: false,
			schema: { type: "string" },
		},
		{
			name: "filePath",
			description: "Local file path for import_file.",
			required: false,
			schema: { type: "string" },
		},
		{
			name: "url",
			description: "HTTP or HTTPS URL for import_url.",
			required: false,
			schema: { type: "string" },
		},
		{
			name: "tags",
			description: "Optional tags for created text documents.",
			required: false,
			schema: { type: "array", items: { type: "string" } },
		},
		{
			name: "limit",
			description:
				"Maximum number of results or listed documents (1-100). Use 0 when this field is not applicable to the selected action.",
			required: false,
			schema: { type: "number", minimum: 0, maximum: 100 },
		},
		{
			name: "searchMode",
			description: "Search mode: hybrid, vector, or keyword.",
			required: false,
			schema: { type: "string", enum: ["hybrid", "vector", "keyword"] },
		},
		{
			name: "scope",
			description:
				"Visibility scope. For list/search, use all-visible unless the user explicitly names global, owner-private, user-private, or agent-private; phrases such as 'my documents' mean all documents visible to the requester. For newly-created documents, select the requested visibility scope.",
			required: false,
			schema: {
				type: "string",
				enum: [...DOCUMENT_SCOPE_OPTIONS],
			},
		},
		{
			name: "scopedToEntityId",
			description:
				"Entity UUID for user-private documents when the owner or runtime is creating a document for a user. Also filters list/search to documents scoped to this entity.",
			required: false,
			schema: { type: "string" },
		},
		{
			name: "addedBy",
			description:
				"Filter list results to documents created by this entity UUID.",
			required: false,
			schema: { type: "string" },
		},
		{
			name: "timeRangeStart",
			description:
				"ISO date or epoch ms — list results created at or after this time.",
			required: false,
			schema: { type: "string" },
		},
		{
			name: "timeRangeEnd",
			description:
				"ISO date or epoch ms — list results created at or before this time.",
			required: false,
			schema: { type: "string" },
		},
		{
			name: "offset",
			description: "Pagination offset for list.",
			required: false,
			schema: { type: "number", minimum: 0 },
		},
		{
			name: "includeImageDescriptions",
			description:
				"When importing URLs, request image descriptions from the upstream pipeline.",
			required: false,
			schema: { type: "boolean" },
		},
	],
	similes: [
		"search documents",
		"read document",
		"save document",
		"edit document",
		"delete document",
		"list documents",
		"import file",
		"import url",
	],
	examples: [
		[
			{
				name: "user",
				content: { text: "Search documents for launch notes" },
			},
			{
				name: "assistant",
				content: {
					text: "I'll search documents for launch notes.",
					actions: ["DOCUMENT"],
				},
			},
		],
		[
			{
				name: "user",
				content: { text: "Save this as a document: Launch is Friday." },
			},
			{
				name: "assistant",
				content: {
					text: "I'll save that in documents.",
					actions: ["DOCUMENT"],
				},
			},
		],
	] as ActionExample[][],

	validate: async (
		runtime: IAgentRuntime,
		_message: Memory,
	): Promise<boolean> => {
		registerDocumentsSearchCategory(runtime);
		return Boolean(runtime.getService(DocumentService.serviceType));
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		options?: HandlerOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		registerDocumentsSearchCategory(runtime);
		const service = runtime.getService<DocumentService>(
			DocumentService.serviceType,
		);

		if (!service) {
			// Planner-facing only: infrastructure-speak next to the evaluator's
			// reply was a live double message. The evaluator explains in voice.
			const text =
				"The documents service is not available; tell the user documents can't be used right now.";
			return result(false, text, "search", {
				values: { error: "service_unavailable" },
			});
		}

		const resolved = await resolveActionArgs<
			DocumentSubAction,
			DocumentActionParameters
		>({
			runtime,
			message,
			state,
			options,
			actionName: "DOCUMENT",
			subactions: DOCUMENT_SUBACTIONS,
		});
		if (!resolved.ok) {
			return result(false, resolved.clarification, "search", {
				values: { error: "missing_sub_action", missing: resolved.missing },
			});
		}

		const { subaction, params } = resolved;

		const readOnlyRejection = knowledgeReadOnlyRejection(
			subaction,
			message,
			state,
		);
		if (readOnlyRejection) {
			return result(false, readOnlyRejection, subaction, {
				values: { error: "knowledge_context_read_only" },
			});
		}

		try {
			switch (subaction) {
				case "search":
					return await handleSearch(service, message, params, callback);
				case "read":
					return await handleRead(service, message, params, callback);
				case "write":
					return await handleWrite(runtime, service, message, params, callback);
				case "edit":
					return await handleEdit(service, message, params, callback);
				case "delete":
					return await handleDelete(service, message, params, callback);
				case "list":
					return await handleList(service, message, params, callback);
				case "import_file":
					return await handleImportFile(
						runtime,
						service,
						message,
						params,
						callback,
					);
				case "import_url":
					return await handleImportUrl(
						runtime,
						service,
						message,
						params,
						callback,
					);
			}
		} catch (error) {
			// error-policy:J1 The polymorphic documents action translates
			// failures into its explicit unsuccessful result shape.
			logger.error({ error }, `Error in DOCUMENT ${subaction} action`);
			// Planner-facing only: internal exception text must not leak to chat.
			const detail = error instanceof Error ? error.message : String(error);
			const errorCode = error instanceof ElizaError ? error.code : detail;
			const text = `The documents ${subaction.replace("_", " ")} operation failed: ${detail}`;
			return result(false, text, subaction, {
				error: detail,
				values: {
					error: errorCode,
				},
			});
		}
	},
};

export const documentActions: Action[] = [documentAction];

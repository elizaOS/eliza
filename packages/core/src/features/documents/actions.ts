import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "../../logger";
import { checkSenderRole, hasRoleAccess, isAgentSelf } from "../../roles";
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
import { addDocumentFromFilePath } from "./docs-loader.ts";
import { DocumentService, type SearchMode } from "./service.ts";
import type {
	DocumentAddedByRole,
	DocumentAddedFrom,
	DocumentVisibilityScope,
	StoredDocument,
} from "./types.ts";
import { fetchDocumentFromUrl, isYouTubeUrl } from "./url-ingest.ts";
import { createDocumentNoteFilename, deriveDocumentTitle } from "./utils.ts";

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

const DOCUMENT_SUB_ACTIONS = new Set<DocumentSubAction>([
	"list",
	"search",
	"read",
	"write",
	"edit",
	"delete",
	"import_file",
	"import_url",
]);

const DOCUMENT_SCOPES = new Set<DocumentVisibilityScope>([
	"global",
	"owner-private",
	"user-private",
	"agent-private",
]);

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
		return false;
	}
}

export function registerDocumentsSearchCategory(runtime: IAgentRuntime): void {
	if (!hasSearchCategory(runtime, DOCUMENTS_SEARCH_CATEGORY.category)) {
		runtime.registerSearchCategory(DOCUMENTS_SEARCH_CATEGORY);
	}
}

function getParams(
	options?: HandlerOptions | unknown,
): DocumentActionParameters {
	const maybeOptions = options as HandlerOptions | undefined;
	const params = maybeOptions?.parameters;
	return params && typeof params === "object"
		? (params as DocumentActionParameters)
		: {};
}

function normalizeSubAction(value: unknown): DocumentSubAction | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim().toLowerCase().replace(/-/g, "_");
	return DOCUMENT_SUB_ACTIONS.has(normalized as DocumentSubAction)
		? (normalized as DocumentSubAction)
		: null;
}

function inferSubAction(
	params: DocumentActionParameters,
	message: Memory,
): DocumentSubAction | null {
	const explicit = normalizeSubAction(params.subaction);
	if (explicit) return explicit;

	const text = message.content?.text ?? "";
	if (
		(params.url || URL_PATTERN.test(text)) &&
		/\b(add|import|save)\b/i.test(text)
	) {
		return "import_url";
	}
	if (
		(params.filePath || DOCUMENT_PATH_PATTERN.test(text)) &&
		/\b(add|import|process|save)\b/i.test(text)
	) {
		return "import_file";
	}
	if (/\b(read|open|show)\b/i.test(text)) return "read";
	if (/\b(list|recent|available)\b/i.test(text)) return "list";
	if (/\b(delete|remove|drop|forget)\b/i.test(text)) return "delete";
	if (/\b(edit|update|replace|rewrite)\b/i.test(text)) return "edit";
	if (/\b(save|store|write|create|remember|add)\b/i.test(text)) return "write";
	if (/\b(search|find|lookup|look up|query)\b/i.test(text)) return "search";
	return null;
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

	const match = (message.content?.text ?? "").match(
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
	return typeof value === "number" && Number.isFinite(value)
		? Math.max(1, Math.min(100, Math.floor(value)))
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
			: (message.entityId ?? runtime.agentId);
	}
	if (
		typeof params?.scopedToEntityId === "string" &&
		isUuid(params.scopedToEntityId)
	) {
		return params.scopedToEntityId;
	}
	return message.entityId ?? runtime.agentId;
}

async function getAddedByRole(
	runtime: IAgentRuntime,
	message: Memory,
): Promise<DocumentAddedByRole> {
	if (!message.entityId) return "RUNTIME";
	if (message.entityId === runtime.agentId) return "AGENT";
	const role = await checkSenderRole(runtime, message).catch(() => null);
	if (role?.role === "OWNER" || role?.role === "ADMIN") return role.role;
	return "USER";
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

async function ensureDocumentMutationAccess(
	runtime: IAgentRuntime,
	message: Memory,
	document: Memory,
): Promise<string | null> {
	const metadata = (document.metadata ?? {}) as Record<string, unknown>;
	const scope =
		typeof metadata.scope === "string" &&
		DOCUMENT_SCOPES.has(metadata.scope as DocumentVisibilityScope)
			? (metadata.scope as DocumentVisibilityScope)
			: "global";
	if (scope === "global" || scope === "owner-private") {
		return (await hasRoleAccess(runtime, message, "OWNER"))
			? null
			: "Only the owner can edit or delete global and owner-private documents.";
	}
	if (scope === "agent-private") {
		return isAgentSelf(runtime, message) ||
			(await hasRoleAccess(runtime, message, "OWNER"))
			? null
			: "Only the owner or agent runtime can edit or delete agent-private documents.";
	}
	const scopedToEntityId =
		typeof metadata.scopedToEntityId === "string"
			? metadata.scopedToEntityId
			: typeof document.entityId === "string"
				? document.entityId
				: undefined;
	if (scopedToEntityId && message.entityId === scopedToEntityId) {
		return null;
	}
	return (await hasRoleAccess(runtime, message, "ADMIN"))
		? null
		: "Users can only edit or delete their own private documents.";
}

function getCleanWriteText(
	params: DocumentActionParameters,
	message: Memory,
): string {
	const explicit = params.text ?? params.content;
	if (typeof explicit === "string" && explicit.trim()) {
		return explicit.trim();
	}
	return (message.content?.text ?? "")
		.replace(
			/^(save|store|write|create|remember|add)\s+(this|that|the following|a document|document)?:?\s*/i,
			"",
		)
		.trim();
}

function getQuery(params: DocumentActionParameters, message: Memory): string {
	if (typeof params.query === "string" && params.query.trim()) {
		return params.query.trim();
	}
	return (message.content?.text ?? "")
		.replace(
			/^(search|find|lookup|look up|query)\s+(my\s+|your\s+|the\s+)?documents?\s*(for|about)?\s*/i,
			"",
		)
		.trim();
}

function getDocumentFilterParams(params: DocumentActionParameters): {
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
	const timeRangeStart = parseTimestampParam(params.timeRangeStart);
	const timeRangeEnd = parseTimestampParam(params.timeRangeEnd);
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
		(message.content?.text ?? "").match(DOCUMENT_PATH_PATTERN)?.[0] ?? null
	);
}

function getUrl(
	params: DocumentActionParameters,
	message: Memory,
): string | null {
	if (typeof params.url === "string" && params.url.trim()) {
		return params.url.trim();
	}
	return (message.content?.text ?? "").match(URL_PATTERN)?.[0] ?? null;
}

async function scopedAddOptions(
	runtime: IAgentRuntime,
	message: Memory,
	scope: DocumentVisibilityScope,
	addedFrom: DocumentAddedFrom,
	params?: DocumentActionParameters,
) {
	const scopedToEntityId = getScopedToEntityId(runtime, message, scope, params);
	const addedBy = message.entityId ?? runtime.agentId;
	return {
		agentId: runtime.agentId,
		worldId: message.worldId ?? runtime.agentId,
		roomId: message.roomId ?? runtime.agentId,
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
	callback?: HandlerCallback,
): Promise<ActionResult> {
	const query = getQuery(params, message);
	if (!query) {
		const text = "What would you like me to search for in documents?";
		await emit(callback, { text });
		return result(false, text, "search", {
			values: { error: "missing_query" },
		});
	}

	const searchMessage: Memory = {
		...message,
		content: { ...message.content, text: query },
	};
	const filters = getDocumentFilterParams(params);
	const matches = await service.searchDocuments(
		searchMessage,
		filters.scopedToEntityId
			? { entityId: filters.scopedToEntityId }
			: undefined,
		getSearchMode(params.searchMode),
	);
	const limit = getLimit(params.limit, 5);
	const visible = matches
		.filter((item) => storedDocumentMatchesFilters(item, filters))
		.slice(0, limit);
	const text =
		visible.length === 0
			? `I couldn't find any documents matching "${query}".`
			: `Found ${visible.length} document fragment(s) for "${query}":\n\n${visible
					.map((item, index) => `${index + 1}. ${item.content.text ?? ""}`)
					.join("\n\n")}`;
	await emit(callback, { text, actions: ["DOCUMENT"] });
	return result(true, text, "search", {
		values: { query, results: visible },
		data: { query, results: visible },
	});
}

async function handleRead(
	service: DocumentService,
	message: Memory,
	params: DocumentActionParameters,
	callback?: HandlerCallback,
): Promise<ActionResult> {
	const documentId = getDocumentId(params, message);
	if (!documentId) {
		const text = "I need a valid document id to read.";
		await emit(callback, { text });
		return result(false, text, "read", { values: { error: "invalid_id" } });
	}

	const document = await service.getDocumentById(documentId, message);
	if (!document) {
		const text = `Document ${documentId} not found.`;
		await emit(callback, { text });
		return result(false, text, "read", { values: { error: "not_found" } });
	}

	const text = document.content?.text ?? "";
	await emit(callback, { text, actions: ["DOCUMENT"] });
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
	const text = getCleanWriteText(params, message);
	if (!text) {
		const response = "I need non-empty text to create a document.";
		await emit(callback, { text: response });
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
		await emit(callback, { text: accessError });
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

	const response = `Created document "${title}" with ${stored.fragmentCount} fragment(s). Document id: ${stored.clientDocumentId}.`;
	await emit(callback, { text: response, actions: ["DOCUMENT"] });
	return result(true, response, "write", {
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
	runtime: IAgentRuntime,
	service: DocumentService,
	message: Memory,
	params: DocumentActionParameters,
	callback?: HandlerCallback,
): Promise<ActionResult> {
	const documentId = getDocumentId(params, message);
	const text = typeof params.text === "string" ? params.text : params.content;
	if (!documentId) {
		const response = "I need a valid document id to edit.";
		await emit(callback, { text: response });
		return result(false, response, "edit", { values: { error: "invalid_id" } });
	}
	if (typeof text !== "string" || !text.trim()) {
		const response = "I need non-empty text to update the document.";
		await emit(callback, { text: response });
		return result(false, response, "edit", {
			values: { error: "missing_text" },
		});
	}

	const document = await service.getDocumentById(documentId, message);
	if (!document) {
		const response = `Document ${documentId} not found.`;
		await emit(callback, { text: response });
		return result(false, response, "edit", { values: { error: "not_found" } });
	}
	const accessError = await ensureDocumentMutationAccess(
		runtime,
		message,
		document,
	);
	if (accessError) {
		await emit(callback, { text: accessError });
		return result(false, accessError, "edit", {
			values: { error: "forbidden" },
		});
	}

	const updated = await service.updateDocument({
		documentId,
		content: text.trim(),
		message,
	});
	const response = `Updated document ${updated.documentId}. Re-fragmented into ${updated.fragmentCount} piece(s).`;
	await emit(callback, { text: response, actions: ["DOCUMENT"] });
	return result(true, response, "edit", {
		values: {
			documentId: updated.documentId,
			fragmentCount: updated.fragmentCount,
		},
	});
}

async function handleDelete(
	runtime: IAgentRuntime,
	service: DocumentService,
	message: Memory,
	params: DocumentActionParameters,
	callback?: HandlerCallback,
): Promise<ActionResult> {
	const documentId = getDocumentId(params, message);
	if (!documentId) {
		const text = "I need a valid document id to delete.";
		await emit(callback, { text });
		return result(false, text, "delete", { values: { error: "invalid_id" } });
	}

	const document = await service.getDocumentById(documentId, message);
	if (!document) {
		const text = `Document ${documentId} not found.`;
		await emit(callback, { text });
		return result(false, text, "delete", { values: { error: "not_found" } });
	}
	const accessError = await ensureDocumentMutationAccess(
		runtime,
		message,
		document,
	);
	if (accessError) {
		await emit(callback, { text: accessError });
		return result(false, accessError, "delete", {
			values: { error: "forbidden" },
		});
	}

	await service.deleteDocument(documentId, message);
	const text = `Deleted document ${documentId}.`;
	await emit(callback, { text, actions: ["DOCUMENT"] });
	return result(true, text, "delete", { values: { documentId } });
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
	const timeRangeStart = parseTimestampParam(params.timeRangeStart);
	const timeRangeEnd = parseTimestampParam(params.timeRangeEnd);
	const offset =
		typeof params.offset === "number" && params.offset >= 0
			? Math.floor(params.offset)
			: undefined;

	const documents = await service.listDocuments(message, {
		limit: getLimit(params.limit, 25),
		offset,
		query: params.query,
		scope,
		scopedToEntityId,
		addedBy,
		timeRangeStart,
		timeRangeEnd,
		tags: Array.isArray(params.tags) ? params.tags : undefined,
	});
	const text =
		documents.length === 0
			? "No documents are available."
			: `Available documents:\n${documents
					.map((document, index) => {
						const metadata = document.metadata as
							| Record<string, unknown>
							| undefined;
						const title =
							typeof metadata?.title === "string"
								? metadata.title
								: typeof metadata?.filename === "string"
									? metadata.filename
									: `Document ${index + 1}`;
						return `${index + 1}. ${title} (${document.id})`;
					})
					.join("\n")}`;
	await emit(callback, { text, actions: ["DOCUMENT"] });
	return result(true, text, "list", {
		values: { documents },
		data: { documents },
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
		const text = "I need a file path or text content to import.";
		await emit(callback, { text });
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
		await emit(callback, { text: accessError });
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
		if (!fs.existsSync(filePath)) {
			const text = `I couldn't find the file at ${filePath}.`;
			await emit(callback, { text });
			return result(false, text, "import_file", {
				values: { error: "not_found" },
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
		const text = `Imported "${filename}" with ${stored.fragmentCount} fragment(s). Document id: ${stored.clientDocumentId}.`;
		await emit(callback, { text, actions: ["DOCUMENT"] });
		return result(true, text, "import_file", {
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
	const text = `Imported "${title}" with ${stored.fragmentCount} fragment(s). Document id: ${stored.clientDocumentId}.`;
	await emit(callback, { text, actions: ["DOCUMENT"] });
	return result(true, text, "import_file", {
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
		const text = "I need a URL to import.";
		await emit(callback, { text });
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
		await emit(callback, { text: accessError });
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
	const text = `Imported ${label} from ${url}. Stored as ${fetched.filename} with ${stored.fragmentCount} fragment(s).`;
	await emit(callback, { text, actions: ["DOCUMENT"] });
	return result(true, text, "import_url", {
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
	contexts: ["documents"],
	contextGate: { anyOf: ["documents"] },
	roleGate: { minRole: "USER" },
	description:
		"List, search, read, write, edit, delete, and import stored documents. Select one subaction and provide the fields needed for that operation.",
	descriptionCompressed:
		"Dispatches document operations using subaction: list, search, read, write, edit, delete, import_file, import_url.",
	suppressPostActionContinuation: true,
	parameters: [
		{
			name: "subaction",
			description:
				"Document operation to perform: list, search, read, write, edit, delete, import_file, or import_url.",
			required: true,
			schema: {
				type: "string",
				enum: [...DOCUMENT_SUB_ACTIONS],
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
			description: "Maximum number of results or listed documents.",
			required: false,
			schema: { type: "number", minimum: 1, maximum: 100 },
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
				"Visibility scope for newly-created documents: global, owner-private, user-private, or agent-private.",
			required: false,
			schema: {
				type: "string",
				enum: [...DOCUMENT_SCOPES],
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
		message: Memory,
		_state?: State,
		options?: unknown,
	): Promise<boolean> => {
		registerDocumentsSearchCategory(runtime);
		if (!runtime.getService(DocumentService.serviceType)) return false;
		const params = getParams(options);
		return Boolean(inferSubAction(params, message));
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		options?: HandlerOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		registerDocumentsSearchCategory(runtime);
		const service = runtime.getService<DocumentService>(
			DocumentService.serviceType,
		);
		const params = getParams(options);
		const subaction = inferSubAction(params, message);

		if (!service) {
			const text = "Documents service not available.";
			await emit(callback, { text });
			return result(false, text, subaction ?? "search", {
				values: { error: "service_unavailable" },
			});
		}
		if (!subaction) {
			const text = "I need a document subaction to perform.";
			await emit(callback, { text });
			return result(false, text, "search", {
				values: { error: "missing_sub_action" },
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
					return await handleEdit(runtime, service, message, params, callback);
				case "delete":
					return await handleDelete(
						runtime,
						service,
						message,
						params,
						callback,
					);
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
			logger.error({ error }, `Error in DOCUMENT ${subaction} action`);
			const text = `I couldn't ${subaction.replace("_", " ")} documents: ${
				error instanceof Error ? error.message : String(error)
			}`;
			await emit(callback, { text });
			return result(false, text, subaction, {
				error: error instanceof Error ? error.message : String(error),
				values: {
					error: error instanceof Error ? error.message : String(error),
				},
			});
		}
	},
};

export const documentActions: Action[] = [documentAction];

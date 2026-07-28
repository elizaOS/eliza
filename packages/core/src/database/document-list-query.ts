/**
 * Shared document-list contract enforcement and in-memory execution for
 * database adapters. Native adapters advertise the versioned capability;
 * older adapters use a bounded compatibility scan that returns exact results
 * or fails before an incomplete corpus can impersonate a complete one.
 */
import { ElizaError } from "../errors";
import {
	type DocumentListCursor,
	type DocumentListQueryParams,
	type DocumentListQueryResult,
	type IDatabaseAdapter,
	type Memory,
	MemoryType,
	type UUID,
} from "../types";

export const DOCUMENT_LIST_QUERY_CAPABILITY_VERSION = 1 as const;
export const DOCUMENT_LIST_MAX_LIMIT = 100;
export const DOCUMENT_LIST_MAX_OFFSET = 10_000;
export const DOCUMENT_LIST_MAX_QUERY_LENGTH = 512;
export const DOCUMENT_LIST_MAX_TAGS = 32;
export const DOCUMENT_LIST_MAX_TAG_LENGTH = 128;
export const DOCUMENT_LIST_MAX_REQUESTER_ROOMS = 1_000;
export const DOCUMENT_LIST_COMPATIBILITY_SCAN_LIMIT = 10_000;

export interface DocumentListQueryCapableAdapter {
	readonly documentListQueryCapability: typeof DOCUMENT_LIST_QUERY_CAPABILITY_VERSION;
	queryDocuments(
		params: DocumentListQueryParams,
	): Promise<DocumentListQueryResult>;
}

const DOCUMENT_LIST_ROLES = new Set([
	"OWNER",
	"ADMIN",
	"USER",
	"AGENT",
	"RUNTIME",
]);
const DOCUMENT_LIST_SCOPES = new Set([
	"global",
	"owner-private",
	"user-private",
	"agent-private",
]);
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function invalidPagination(
	message: string,
	context: Record<string, unknown>,
): never {
	throw new ElizaError(message, {
		code: "DOCUMENT_LIST_INVALID_PAGINATION",
		context,
	});
}

function isUuid(value: unknown): value is UUID {
	return typeof value === "string" && UUID_PATTERN.test(value);
}

function documentCreatedAt(memory: Memory): number {
	const createdAt = memory.createdAt ?? 0;
	return Number.isFinite(createdAt) ? Math.trunc(createdAt) : 0;
}

function compareDocumentOrder(left: Memory, right: Memory): number {
	const timeDifference = documentCreatedAt(right) - documentCreatedAt(left);
	if (timeDifference !== 0) return timeDifference;
	const leftId = left.id?.toLowerCase() ?? "";
	const rightId = right.id?.toLowerCase() ?? "";
	if (leftId === rightId) return 0;
	return rightId < leftId ? -1 : 1;
}

function documentCursor(memory: Memory): DocumentListCursor {
	if (!isUuid(memory.id)) {
		throw new ElizaError("Stored document is missing a valid UUID", {
			code: "DOCUMENT_LIST_INVALID_MEMORY",
			context: { agentId: memory.agentId, documentId: memory.id },
			severity: "fatal",
		});
	}
	return { createdAt: documentCreatedAt(memory), id: memory.id };
}

function isAfterDocumentCursor(
	memory: Memory,
	cursor: DocumentListCursor,
): boolean {
	const createdAt = documentCreatedAt(memory);
	if (createdAt !== cursor.createdAt) return createdAt < cursor.createdAt;
	return (
		typeof memory.id === "string" &&
		memory.id.toLowerCase() < cursor.id.toLowerCase()
	);
}

function isDocumentMemory(memory: Memory): boolean {
	return memory.metadata?.type === MemoryType.DOCUMENT;
}

function isDocumentVisible(
	memory: Memory,
	params: DocumentListQueryParams,
): boolean {
	if (!params.requesterRoomIds.includes(memory.roomId)) return false;
	if (
		params.requesterRole === "OWNER" ||
		params.requesterRole === "AGENT" ||
		params.requesterRole === "RUNTIME"
	) {
		return true;
	}

	const metadata = (memory.metadata ?? {}) as Record<string, unknown>;
	const scope = typeof metadata.scope === "string" ? metadata.scope : "global";
	if (scope === "global") return true;
	if (scope !== "user-private") return false;

	return (
		metadata.scopedToEntityId === params.requesterEntityId ||
		metadata.addedBy === params.requesterEntityId ||
		memory.entityId === params.requesterEntityId
	);
}

function matchesDocumentFilters(
	memory: Memory,
	params: DocumentListQueryParams,
): boolean {
	const metadata = (memory.metadata ?? {}) as Record<string, unknown>;
	if (params.scope && (metadata.scope ?? "global") !== params.scope) {
		return false;
	}
	if (
		params.scopedToEntityId &&
		metadata.scopedToEntityId !== params.scopedToEntityId
	) {
		return false;
	}
	if (params.addedBy && metadata.addedBy !== params.addedBy) return false;

	const timestamp =
		typeof metadata.timestamp === "number"
			? metadata.timestamp
			: documentCreatedAt(memory);
	if (
		params.timeRangeStart !== undefined &&
		timestamp < params.timeRangeStart
	) {
		return false;
	}
	if (params.timeRangeEnd !== undefined && timestamp > params.timeRangeEnd) {
		return false;
	}

	if (params.tags?.length) {
		const tags = Array.isArray(metadata.tags)
			? metadata.tags.filter((tag): tag is string => typeof tag === "string")
			: [];
		if (!params.tags.every((tag) => tags.includes(tag))) return false;
	}
	return true;
}

function matchesDocumentQuery(memory: Memory, query: string): boolean {
	const metadata = (memory.metadata ?? {}) as Record<string, unknown>;
	const haystack = [
		memory.content.text,
		metadata.title,
		metadata.filename,
		metadata.originalFilename,
		metadata.source,
	]
		.filter((value): value is string => typeof value === "string")
		.join("\n")
		.toLowerCase();
	return haystack.includes(query);
}

function paginateDocuments(
	memories: Memory[],
	params: DocumentListQueryParams,
): {
	documents: Memory[];
	hasMore: boolean;
	nextCursor?: DocumentListCursor;
} {
	const cursorFiltered = params.cursor
		? memories.filter((memory) =>
				isAfterDocumentCursor(memory, params.cursor as DocumentListCursor),
			)
		: memories;
	const offset = params.cursor ? 0 : params.offset;
	const page = cursorFiltered.slice(offset, offset + params.limit + 1);
	const hasMore = page.length > params.limit;
	const documents = page.slice(0, params.limit);
	const last = documents.at(-1);
	return {
		documents,
		hasMore,
		...(hasMore && last ? { nextCursor: documentCursor(last) } : {}),
	};
}

export function validateDocumentListQueryParams(
	params: DocumentListQueryParams,
): void {
	if (!isUuid(params.agentId) || !isUuid(params.requesterEntityId)) {
		invalidPagination("Document list requester identity is invalid", {
			agentId: params.agentId,
			requesterEntityId: params.requesterEntityId,
		});
	}
	if (!DOCUMENT_LIST_ROLES.has(params.requesterRole)) {
		invalidPagination("Document list requester role is invalid", {
			requesterRole: params.requesterRole,
		});
	}
	if (
		!Array.isArray(params.requesterRoomIds) ||
		params.requesterRoomIds.length > DOCUMENT_LIST_MAX_REQUESTER_ROOMS ||
		params.requesterRoomIds.some((roomId) => !isUuid(roomId))
	) {
		invalidPagination("Document list requester rooms are invalid", {
			roomCount: params.requesterRoomIds?.length,
		});
	}
	if (
		!Number.isSafeInteger(params.limit) ||
		params.limit < 1 ||
		params.limit > DOCUMENT_LIST_MAX_LIMIT
	) {
		invalidPagination(
			`Document list limit must be an integer between 1 and ${DOCUMENT_LIST_MAX_LIMIT}`,
			{ limit: params.limit },
		);
	}
	if (
		!Number.isSafeInteger(params.offset) ||
		params.offset < 0 ||
		params.offset > DOCUMENT_LIST_MAX_OFFSET
	) {
		invalidPagination(
			`Document list offset must be an integer between 0 and ${DOCUMENT_LIST_MAX_OFFSET}`,
			{ offset: params.offset },
		);
	}
	if (
		params.cursor &&
		(!Number.isSafeInteger(params.cursor.createdAt) ||
			!isUuid(params.cursor.id))
	) {
		invalidPagination("Document list cursor is invalid", {
			cursor: params.cursor,
		});
	}
	if (params.cursor && params.offset !== 0) {
		invalidPagination(
			"Document list cursor cannot be combined with a non-zero offset",
			{ offset: params.offset },
		);
	}
	if ((params.query?.length ?? 0) > DOCUMENT_LIST_MAX_QUERY_LENGTH) {
		invalidPagination(
			`Document list query cannot exceed ${DOCUMENT_LIST_MAX_QUERY_LENGTH} characters`,
			{ queryLength: params.query?.length },
		);
	}
	if (params.scope !== undefined && !DOCUMENT_LIST_SCOPES.has(params.scope)) {
		invalidPagination("Document list scope is invalid", {
			scope: params.scope,
		});
	}
	if (
		params.scopedToEntityId !== undefined &&
		!isUuid(params.scopedToEntityId)
	) {
		invalidPagination("Document list scoped entity is invalid", {
			scopedToEntityId: params.scopedToEntityId,
		});
	}
	if (params.addedBy !== undefined && !isUuid(params.addedBy)) {
		invalidPagination("Document list addedBy entity is invalid", {
			addedBy: params.addedBy,
		});
	}
	for (const [name, value] of [
		["timeRangeStart", params.timeRangeStart],
		["timeRangeEnd", params.timeRangeEnd],
	] as const) {
		if (value !== undefined && !Number.isSafeInteger(value)) {
			invalidPagination(`Document list ${name} must be a safe integer`, {
				[name]: value,
			});
		}
	}
	if (
		params.timeRangeStart !== undefined &&
		params.timeRangeEnd !== undefined &&
		params.timeRangeStart > params.timeRangeEnd
	) {
		invalidPagination("Document list time range is inverted", {
			timeRangeStart: params.timeRangeStart,
			timeRangeEnd: params.timeRangeEnd,
		});
	}
	if (
		(params.tags?.length ?? 0) > DOCUMENT_LIST_MAX_TAGS ||
		params.tags?.some(
			(tag) =>
				typeof tag !== "string" ||
				tag.length === 0 ||
				tag.length > DOCUMENT_LIST_MAX_TAG_LENGTH,
		)
	) {
		invalidPagination("Document list tags exceed the supported bounds", {
			tagCount: params.tags?.length,
		});
	}
}

export function queryDocumentsInMemory(
	memories: Memory[],
	params: DocumentListQueryParams,
): DocumentListQueryResult {
	validateDocumentListQueryParams(params);
	const visibleDocuments = memories
		.filter(
			(memory) =>
				memory.agentId === params.agentId &&
				isDocumentMemory(memory) &&
				isDocumentVisible(memory, params),
		)
		.sort(compareDocumentOrder);
	const availableDocuments = visibleDocuments.filter((memory) =>
		matchesDocumentFilters(memory, params),
	);
	const normalizedQuery = params.query?.trim().toLowerCase();
	const matchedDocuments = normalizedQuery
		? availableDocuments.filter((memory) =>
				matchesDocumentQuery(memory, normalizedQuery),
			)
		: availableDocuments;
	const matchedPage = paginateDocuments(matchedDocuments, params);
	const availablePage =
		normalizedQuery &&
		matchedDocuments.length === 0 &&
		availableDocuments.length > 0
			? paginateDocuments(availableDocuments, params)
			: { documents: [], hasMore: false };

	return {
		documents: matchedPage.documents,
		availableDocuments: availablePage.documents,
		totalVisible: visibleDocuments.length,
		totalAvailable: availableDocuments.length,
		totalMatched: matchedDocuments.length,
		hasMore: matchedPage.hasMore,
		availableHasMore: availablePage.hasMore,
		...(matchedPage.nextCursor ? { nextCursor: matchedPage.nextCursor } : {}),
		...(availablePage.nextCursor
			? { availableNextCursor: availablePage.nextCursor }
			: {}),
	};
}

export function hasDocumentListQueryCapability(
	adapter: IDatabaseAdapter,
): adapter is IDatabaseAdapter & DocumentListQueryCapableAdapter {
	const candidate = adapter as IDatabaseAdapter &
		Partial<DocumentListQueryCapableAdapter>;
	return (
		candidate.documentListQueryCapability ===
			DOCUMENT_LIST_QUERY_CAPABILITY_VERSION &&
		typeof candidate.queryDocuments === "function"
	);
}

async function queryDocumentsCompatibility(
	adapter: IDatabaseAdapter,
	params: DocumentListQueryParams,
): Promise<DocumentListQueryResult> {
	const memories: Memory[] = [];
	const batchSize = DOCUMENT_LIST_MAX_LIMIT;
	for (
		let offset = 0;
		offset < DOCUMENT_LIST_COMPATIBILITY_SCAN_LIMIT;
		offset += batchSize
	) {
		const page = await adapter.getMemories({
			tableName: "documents",
			agentId: params.agentId,
			limit: batchSize,
			offset,
			includeEmbedding: false,
		});
		memories.push(...page);
		if (page.length < batchSize) {
			return queryDocumentsInMemory(memories, params);
		}
	}

	const overflow = await adapter.getMemories({
		tableName: "documents",
		agentId: params.agentId,
		limit: 1,
		offset: DOCUMENT_LIST_COMPATIBILITY_SCAN_LIMIT,
		includeEmbedding: false,
	});
	if (overflow.length > 0) {
		throw new ElizaError(
			"Database adapter must implement native document listing for this corpus",
			{
				code: "DOCUMENT_LIST_QUERY_CAPABILITY_REQUIRED",
				context: {
					adapter: adapter.constructor.name,
					scanLimit: DOCUMENT_LIST_COMPATIBILITY_SCAN_LIMIT,
				},
				severity: "fatal",
			},
		);
	}
	return queryDocumentsInMemory(memories, params);
}

export async function queryDocumentsWithCompatibility(
	adapter: IDatabaseAdapter,
	params: DocumentListQueryParams,
): Promise<DocumentListQueryResult> {
	validateDocumentListQueryParams(params);
	return hasDocumentListQueryCapability(adapter)
		? adapter.queryDocuments(params)
		: queryDocumentsCompatibility(adapter, params);
}

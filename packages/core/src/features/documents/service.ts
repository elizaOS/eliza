/**
 * `DocumentService`: the documents capability's runtime service and the core of
 * the RAG subsystem. It ingests documents from uploads, URLs, files, and
 * character config; extracts text, splits it into fragments, embeds them (batched
 * when a `TEXT_EMBEDDING_BATCH` model is registered, else serial per-fragment),
 * and persists documents + fragments into their own memory partitions. It answers
 * recall queries via `searchDocuments` in vector, keyword (BM25), or hybrid mode,
 * degrading to keyword when no embedding model is available.
 *
 * Registered under service type `documents` and consumed by `documentsProvider`
 * and the document actions; recall queries are embedded through `embedRecallQuery`
 * (per-turn cached, fail-open). All reads, searches, and mutations cross the
 * adapter's required document capability so authorization is evaluated against
 * the stored parent document under the database isolation context. On start it
 * also migrates the legacy `knowledge` partition into the document partitions.
 */
import { existsSync, statSync } from "node:fs";
import { filterByAccessContext } from "../../access-control/filter";
import {
	canRequesterManageDocumentDirectGrants,
	canRequesterMutateDocument,
	DOCUMENT_LIST_MAX_LIMIT,
	DOCUMENT_LIST_MAX_OFFSET,
	documentRoleHasGlobalVisibility,
	isDocumentVisibleToRequester,
	queryDocumentsWithCapability,
	readDocumentMutationSnapshot,
	validateDocumentDirectGrantEntityIds,
} from "../../database/document-list-query";
import { createUniqueUuid } from "../../entities";
import { ElizaError } from "../../errors";
import { logger } from "../../logger";
import { checkSenderRole } from "../../roles";
import {
	type AccessContext,
	type Content,
	type CustomMetadata,
	type DocumentListCursor,
	type DocumentListQueryParams,
	type DocumentListRequesterRole,
	type DocumentMutationSnapshot,
	type IAgentRuntime,
	type Memory,
	MemoryType,
	type Metadata,
	ModelType,
	Service,
	type UUID,
} from "../../types";
import { splitChunks, validateUuid } from "../../utils";
import { Semaphore } from "../../utils/prompt-batcher/shared";
import { bm25Scores, normalizeBm25Scores } from "./bm25.ts";
import { validateModelConfig } from "./config";
import { addDocumentFromFilePath, loadDocumentsFromPath } from "./docs-loader";
import {
	createDocumentMemory,
	extractTextFromDocument,
	hasDocumentEmbeddingModel,
	preparePreChunkedFragmentMemories,
	processFragmentsSynchronously,
} from "./document-processor.ts";
import { embedRecallQuery } from "./recall-embed.ts";
import type {
	AddDocumentOptions,
	DocumentAddedFrom,
	DocumentFragmentMemoryMetadata,
	DocumentMemoryMetadata,
	DocumentsConfig,
	DocumentVisibilityScope,
	LoadResult,
	StoredDocument,
} from "./types.ts";
import {
	createDocumentNoteFilename,
	deriveDocumentTitle,
	generateContentBasedId,
	isBinaryContentType,
	isTextBackedDocumentContent,
	looksLikeBase64,
	normalizeDocumentContentType,
	stripDocumentFilenameExtension,
} from "./utils.ts";

/**
 * Controls how document search combines vector and keyword scores.
 *
 * - "hybrid"  — (default) vector cosine + BM25, weighted 0.6/0.4.
 *               Falls back to "keyword" automatically when no TEXT_EMBEDDING
 *               model is registered (e.g. the cerebras runner).
 * - "vector"  — Pure vector / cosine-similarity search.
 * - "keyword" — Pure BM25 keyword search; does not require an embedding model.
 */
export type SearchMode = "hybrid" | "vector" | "keyword";

/** Filters and pagination accepted by document list operations. */
export interface DocumentListOptions {
	limit?: number;
	offset?: number;
	cursor?: DocumentListCursor;
	query?: string;
	scope?: DocumentVisibilityScope;
	scopedToEntityId?: UUID;
	addedBy?: UUID;
	timeRangeStart?: number;
	timeRangeEnd?: number;
	tags?: string[];
}

/** Machine-readable outcome of a document list request. */
export type DocumentListStatus =
	| "ok"
	| "query_miss"
	| "filter_miss"
	| "page_exhausted"
	| "empty_store";

/** Complete document-list semantics after visibility, filtering, and pagination. */
export interface DocumentListResult {
	status: DocumentListStatus;
	documents: Memory[];
	availableDocuments: Memory[];
	query?: string;
	limit: number;
	offset: number;
	cursor?: DocumentListCursor;
	totalVisible: number;
	totalAvailable: number;
	totalMatched: number;
	hasMore: boolean;
	availableOffset: number;
	availableHasMore: boolean;
	nextCursor?: DocumentListCursor;
	availableNextCursor?: DocumentListCursor;
}

/** Weight given to the normalized vector score in hybrid mode. */
const HYBRID_VECTOR_WEIGHT = 0.6;
/** Weight given to the normalized BM25 score in hybrid mode. */
const HYBRID_BM25_WEIGHT = 1 - HYBRID_VECTOR_WEIGHT;
const DOCUMENTS_TABLE = "documents";
const DOCUMENT_FRAGMENTS_TABLE = "document_fragments";
const PRE_DOCUMENTS_TABLE = "knowledge";
const DOCUMENT_INGESTION_PENDING_TIMEOUT_MS = 5 * 60 * 1_000;
const CHARACTER_DOCUMENT_EMBEDDING_WAIT_TIMEOUT_MS = 120_000;
const CHARACTER_DOCUMENT_EMBEDDING_WAIT_INTERVAL_MS = 1_000;
const DOCUMENT_SCOPES = new Set<DocumentVisibilityScope>([
	"global",
	"owner-private",
	"user-private",
	"agent-private",
]);
const DOCUMENT_ADDED_FROM_VALUES = new Set<DocumentAddedFrom>([
	"import",
	"chat",
	"upload",
	"url",
	"file",
	"agent-autonomous",
	"runtime-internal",
	"lifeops",
	"default-seed",
	"character",
]);

/** Requester identity and role resolved once for document authorization. */
export interface DocumentRequester {
	entityId: UUID;
	roomIds: UUID[];
	role: DocumentListRequesterRole;
}

export async function resolveDocumentRequesterRole(
	runtime: IAgentRuntime,
	message?: Memory,
): Promise<Pick<DocumentRequester, "entityId" | "role">> {
	if (!message?.entityId) {
		return { entityId: runtime.agentId, role: "RUNTIME" };
	}
	if (message.entityId === runtime.agentId) {
		return { entityId: runtime.agentId, role: "AGENT" };
	}

	try {
		const result = await checkSenderRole(runtime, message);
		return {
			entityId: message.entityId,
			role: result?.role ?? "UNRESOLVED",
		};
	} catch (cause) {
		// error-policy:J2 Preserve role-resolution context and fail the read/write.
		const error = new ElizaError("Document requester role lookup failed", {
			code: "DOCUMENT_ROLE_LOOKUP_FAILED",
			cause,
			context: {
				agentId: runtime.agentId,
				entityId: message.entityId,
				roomId: message.roomId,
			},
			severity: "ephemeral",
		});
		runtime.reportError("DocumentService.resolveRequesterRole", error, {
			agentId: runtime.agentId,
			entityId: message.entityId,
			roomId: message.roomId,
		});
		throw error;
	}
}

/**
 * Build the document requester from a caller-supplied {@link AccessContext}.
 *
 * The read runs for the entity the caller named, not the message author, so a
 * privileged sender cannot widen a request the caller deliberately scoped. An
 * absent role remains `UNRESOLVED` rather than inheriting or fabricating a
 * lower role. The storage authorization boundary denies that state.
 */
export async function resolveDocumentRequesterFromAccessContext(
	runtime: IAgentRuntime,
	accessContext: AccessContext,
): Promise<DocumentRequester> {
	const role: DocumentListRequesterRole = accessContext.role ?? "UNRESOLVED";
	if (documentRoleHasGlobalVisibility(role)) {
		return { entityId: accessContext.requesterEntityId, roomIds: [], role };
	}
	try {
		const roomIds = await runtime.getRoomsForParticipants([
			accessContext.requesterEntityId,
		]);
		return {
			entityId: accessContext.requesterEntityId,
			roomIds: [...new Set(roomIds)],
			role,
		};
	} catch (cause) {
		// error-policy:J2 Preserve room-resolution context and fail the read.
		throw new ElizaError("Document requester room lookup failed", {
			code: "DOCUMENT_ROOM_LOOKUP_FAILED",
			cause,
			context: {
				agentId: runtime.agentId,
				entityId: accessContext.requesterEntityId,
			},
		});
	}
}

export async function resolveDocumentRequester(
	runtime: IAgentRuntime,
	message?: Memory,
): Promise<DocumentRequester> {
	const requester = await resolveDocumentRequesterRole(runtime, message);
	if (documentRoleHasGlobalVisibility(requester.role)) {
		return { ...requester, roomIds: [] };
	}
	try {
		const roomIds = await runtime.getRoomsForParticipants([requester.entityId]);
		return {
			...requester,
			roomIds: [...new Set(roomIds)],
		};
	} catch (cause) {
		// error-policy:J2 Preserve room-resolution context and fail the read.
		const error = new ElizaError("Document requester room lookup failed", {
			code: "DOCUMENT_ROOM_LOOKUP_FAILED",
			cause,
			context: {
				agentId: runtime.agentId,
				entityId: requester.entityId,
				roomId: message?.roomId,
			},
			severity: "ephemeral",
		});
		runtime.reportError("DocumentService.resolveRequesterRooms", error, {
			agentId: runtime.agentId,
			entityId: requester.entityId,
			roomId: message?.roomId,
		});
		throw error;
	}
}

type DocumentRequesterResolver = () => Promise<DocumentRequester>;

function documentListCursorKey(cursor: DocumentListCursor): string {
	return [
		cursor.createdAt,
		cursor.id.toLowerCase(),
		cursor.snapshotCreatedAt ?? "",
		cursor.snapshotId?.toLowerCase() ?? "",
	].join(":");
}

/**
 * Coalesces requester authorization only for one caller-owned read composition.
 * Rejections are evicted so a retry re-reads the authoritative role and room
 * membership instead of retaining a transient authorization failure.
 */
export function createDocumentProviderRequesterResolver(
	runtime: IAgentRuntime,
	message?: Memory,
): DocumentRequesterResolver {
	let pending: Promise<DocumentRequester> | undefined;
	return () => {
		if (pending) return pending;
		const current = resolveDocumentRequester(runtime, message);
		pending = current;
		// error-policy:J5 callers await current; this observer only evicts a rejected read memo.
		void current.catch(() => {
			if (pending === current) pending = undefined;
		});
		return current;
	};
}

function normalizeDocumentScope(
	scope: AddDocumentOptions["scope"] | undefined,
): DocumentVisibilityScope {
	if (scope === undefined) return "global";
	if (DOCUMENT_SCOPES.has(scope)) return scope;
	throw new ElizaError("Document scope is invalid", {
		code: "DOCUMENT_SCOPE_INVALID",
		context: { scope },
	});
}

/**
 * worldId/roomId/entityId are UUID-typed Postgres columns (see
 * plugins/plugin-sql/src/schema/memory.ts); an explicit "" is not a
 * representable scope value, only an omitted (undefined) one defaults to
 * agentId. Reject invalid input at this boundary instead of letting it reach
 * createMemory, where a real adapter fails opaquely and the in-memory test
 * adapter accepts an unqueryable row.
 */
function requireDocumentScopeUuid(value: UUID, field: string): void {
	if (validateUuid(value) === null) {
		throw new ElizaError(`Document ${field} must be a valid UUID`, {
			code: "DOCUMENT_SCOPE_ID_INVALID",
			context: { field, value },
		});
	}
}

function resolveWriteDocumentScope({
	scope,
	entityId,
	agentId,
}: {
	scope: AddDocumentOptions["scope"] | undefined;
	entityId: UUID | undefined;
	agentId: UUID;
}): DocumentVisibilityScope {
	if (scope !== undefined) return normalizeDocumentScope(scope);
	return entityId && entityId !== agentId ? "user-private" : "global";
}

function getCharacterDocumentSources(runtime: IAgentRuntime): string[] {
	const character = runtime.character as {
		documents?: unknown[];
		knowledge?: unknown[];
	};
	const sources = [
		...(character.documents ?? []),
		...(character.knowledge ?? []),
	];
	return sources
		.map((item) => {
			const itemAny = item as {
				item?: {
					case?: string;
					value?: string | { path?: string; directory?: string };
				};
				path?: string;
				directory?: string;
			};
			if (
				itemAny.item?.case === "path" &&
				typeof itemAny.item.value === "string"
			) {
				return itemAny.item.value;
			}
			if (
				itemAny.item?.case === "directory" &&
				typeof itemAny.item.value === "object" &&
				itemAny.item.value !== null
			) {
				return itemAny.item.value.path || itemAny.item.value.directory || null;
			}
			if (typeof itemAny.path === "string") return itemAny.path;
			if (typeof itemAny.directory === "string") return itemAny.directory;
			if (typeof item === "string") return item;
			return null;
		})
		.filter((item): item is string => item !== null && item.trim().length > 0);
}

function describeEmbeddingConfig(config: {
	EMBEDDING_PROVIDER?: string;
	TEXT_EMBEDDING_MODEL: string;
	EMBEDDING_DIMENSION?: number;
}): string {
	const dimensionLabel =
		typeof config.EMBEDDING_DIMENSION === "number"
			? `${config.EMBEDDING_DIMENSION}D`
			: "default dimensions";
	return `${config.EMBEDDING_PROVIDER || "auto"} embeddings with ${config.TEXT_EMBEDDING_MODEL} (${dimensionLabel})`;
}

export class DocumentService extends Service {
	reportError(
		scope: string,
		error: unknown,
		context?: Record<string, unknown>,
	): void {
		this.runtime.reportError(scope, error, context);
	}
	static readonly serviceType = "documents";
	public override config: Metadata = {};
	capabilityDescription =
		"Provides Retrieval Augmented Generation capabilities, including document upload and querying.";

	private documentProcessingSemaphore: Semaphore;

	constructor(runtime?: IAgentRuntime, _config?: Partial<DocumentsConfig>) {
		super(runtime);
		this.documentProcessingSemaphore = new Semaphore(10);
	}

	private async loadInitialDocuments(): Promise<void> {
		logger.info(
			`Loading documents on startup for agent ${this.runtime.agentId}`,
		);
		try {
			await new Promise((resolve) => setTimeout(resolve, 1000));

			const documentsPathSetting = this.runtime.getSetting("DOCUMENTS_PATH");
			const documentsPath =
				typeof documentsPathSetting === "string"
					? documentsPathSetting
					: undefined;

			const result: LoadResult = await loadDocumentsFromPath(
				this as DocumentService,
				this.runtime.agentId,
				undefined,
				documentsPath,
			);

			if (result.successful > 0) {
				logger.info(`Loaded ${result.successful} documents on startup`);
			}
		} catch (error) {
			// error-policy:J7 Startup document loading is detached so service
			// registration is not delayed; failures remain observable.
			logger.error({ error }, "Error loading documents on startup");
			this.runtime.reportError("DocumentService.loadInitialDocuments", error);
			throw error;
		}
	}

	static async start(runtime: IAgentRuntime): Promise<DocumentService> {
		logger.info(`Starting Documents service for agent: ${runtime.agentId}`);

		const validatedConfig = validateModelConfig(runtime);
		const ctxEnabled = validatedConfig.CTX_DOCUMENTS_ENABLED;
		const documentsPathSetting = runtime.getSetting("DOCUMENTS_PATH");
		const characterDocuments = getCharacterDocumentSources(runtime);
		const hasConfiguredDocuments =
			validatedConfig.LOAD_DOCS_ON_STARTUP ||
			(typeof documentsPathSetting === "string" &&
				documentsPathSetting.trim().length > 0) ||
			characterDocuments.length > 0;

		if (ctxEnabled) {
			logger.info(
				`Contextual documents enabled: ${describeEmbeddingConfig(validatedConfig)}, ${validatedConfig.TEXT_PROVIDER} text generation`,
			);
			logger.info(`Text model: ${validatedConfig.TEXT_MODEL}`);
		} else if (hasConfiguredDocuments) {
			logger.debug(
				`Documents service running in embedding-only mode with ${describeEmbeddingConfig(validatedConfig)}`,
			);
			logger.debug(
				"To enable contextual enrichment: Set CTX_DOCUMENTS_ENABLED=true and configure TEXT_PROVIDER/TEXT_MODEL",
			);
		}

		const service = new DocumentService(runtime);
		service.config = validatedConfig;

		if (service.config.LOAD_DOCS_ON_STARTUP) {
			service.loadInitialDocuments().catch((error) => {
				// error-policy:J5 loadInitialDocuments reports the failure before
				// this detached startup task suppresses its rejection.
				logger.error({ error }, "Error loading initial documents");
			});
		}

		await service.migratePreDocumentsPartition();
		await service.backfillDocumentScopes();

		if (characterDocuments.length > 0) {
			await service.processCharacterDocuments(characterDocuments);
		}

		return service;
	}

	static async stop(runtime: IAgentRuntime): Promise<void> {
		logger.info(`Stopping Documents service for agent: ${runtime.agentId}`);
		const service = runtime.getService(DocumentService.serviceType);
		if (!service) {
			logger.warn(
				`DocumentService not found for agent ${runtime.agentId} during stop.`,
			);
		}
		if (service instanceof DocumentService) {
			await service.stop();
		}
	}

	async stop(): Promise<void> {
		logger.info(
			`Documents service stopping for agent: ${this.runtime.character.name}`,
		);
	}

	private isDocumentMemory(memory: Memory): boolean {
		return memory.metadata?.type === MemoryType.DOCUMENT;
	}

	private isDocumentFragmentMemory(memory: Memory): boolean {
		return memory.metadata?.type === MemoryType.FRAGMENT;
	}

	async canAccessDocument(memory: Memory, message?: Memory): Promise<boolean> {
		const requester = await resolveDocumentRequester(this.runtime, message);
		return isDocumentVisibleToRequester(memory, {
			agentId: this.runtime.agentId,
			requesterEntityId: requester.entityId,
			requesterRoomIds: requester.roomIds,
			requesterRole: requester.role,
		});
	}

	async getDocumentById(
		documentId: UUID,
		message?: Memory,
	): Promise<Memory | null> {
		const requester = await resolveDocumentRequester(this.runtime, message);
		return this.runtime.adapter.getDocument({
			agentId: this.runtime.agentId,
			documentId,
			requesterEntityId: requester.entityId,
			requesterRoomIds: requester.roomIds,
			requesterRole: requester.role,
		});
	}

	async getDocumentByIdWithAccessContext(
		documentId: UUID,
		accessContext: AccessContext,
	): Promise<Memory | null> {
		const requester = await resolveDocumentRequesterFromAccessContext(
			this.runtime,
			accessContext,
		);
		return this.runtime.adapter.getDocument({
			agentId: this.runtime.agentId,
			documentId,
			requesterEntityId: requester.entityId,
			requesterRoomIds: requester.roomIds,
			requesterRole: requester.role,
		});
	}

	async getMutableDocumentWithAccessContext(
		documentId: UUID,
		accessContext: AccessContext,
	): Promise<Memory | null> {
		const requester = await resolveDocumentRequesterFromAccessContext(
			this.runtime,
			accessContext,
		);
		const requestContext = {
			agentId: this.runtime.agentId,
			requesterEntityId: requester.entityId,
			requesterRoomIds: requester.roomIds,
			requesterRole: requester.role,
		};
		const document = await this.runtime.adapter.getDocument({
			...requestContext,
			documentId,
		});
		return document && canRequesterMutateDocument(document, requestContext)
			? document
			: null;
	}

	async setDocumentDirectGrantsWithAccessContext(
		documentId: UUID,
		directGrantEntityIds: UUID[],
		accessContext: AccessContext,
	): Promise<Memory> {
		const grants = validateDocumentDirectGrantEntityIds(directGrantEntityIds);
		const { snapshot, requestContext } =
			await this.getDocumentDirectGrantManagementTarget(
				documentId,
				accessContext,
			);
		const result = await this.runtime.adapter.updateDocumentDirectGrants({
			...requestContext,
			documentId,
			expected: snapshot,
			directGrantEntityIds: grants,
		});
		if (result.status !== "updated") {
			throw new ElizaError("Document grant authority changed before mutation", {
				code:
					result.status === "not_found"
						? "DOCUMENT_GRANT_TARGET_NOT_FOUND"
						: result.status === "forbidden"
							? "DOCUMENT_GRANT_MUTATION_FORBIDDEN"
							: "DOCUMENT_GRANT_MUTATION_CONFLICT",
				context: { documentId, status: result.status },
			});
		}
		return result.document;
	}

	async getDocumentDirectGrantsWithAccessContext(
		documentId: UUID,
		accessContext: AccessContext,
	): Promise<UUID[]> {
		const { snapshot } = await this.getDocumentDirectGrantManagementTarget(
			documentId,
			accessContext,
		);
		return snapshot.directGrantEntityIds ?? [];
	}

	private async getDocumentDirectGrantManagementTarget(
		documentId: UUID,
		accessContext: AccessContext,
	) {
		const requester = await resolveDocumentRequesterFromAccessContext(
			this.runtime,
			accessContext,
		);
		const requestContext = {
			agentId: this.runtime.agentId,
			requesterEntityId: requester.entityId,
			requesterRoomIds: requester.roomIds,
			requesterRole: requester.role,
		};
		const document = await this.runtime.adapter.getDocument({
			...requestContext,
			documentId,
		});
		if (!document) {
			throw new ElizaError(`Document ${documentId} not found`, {
				code: "DOCUMENT_NOT_FOUND",
				context: { documentId },
			});
		}
		const snapshot = readDocumentMutationSnapshot(document);
		if (!snapshot) {
			throw new ElizaError(
				"Stored document authorization metadata is invalid",
				{
					code: "DOCUMENT_AUTHORIZATION_INVALID",
					context: { documentId },
					severity: "fatal",
				},
			);
		}
		if (!canRequesterManageDocumentDirectGrants(document, requestContext)) {
			throw new ElizaError("Requester cannot manage document grants", {
				code: "DOCUMENT_GRANT_MUTATION_FORBIDDEN",
				context: {
					documentId,
					requesterEntityId: requester.entityId,
					requesterRole: requester.role,
				},
			});
		}
		return { snapshot, requestContext };
	}

	async listDocumentFragmentsWithAccessContext(
		documentId: UUID,
		accessContext: AccessContext,
	): Promise<Memory[]> {
		const requester = await resolveDocumentRequesterFromAccessContext(
			this.runtime,
			accessContext,
		);
		const fragments: Memory[] = [];
		const pageSize = 1_000;
		for (let offset = 0; ; offset += pageSize) {
			const page = await this.runtime.adapter.queryDocumentFragments({
				agentId: this.runtime.agentId,
				documentId,
				requesterEntityId: requester.entityId,
				requesterRoomIds: requester.roomIds,
				requesterRole: requester.role,
				limit: pageSize,
				offset,
			});
			fragments.push(...page);
			if (page.length < pageSize) return fragments;
		}
	}

	async listDocuments(
		message?: Memory,
		options: DocumentListOptions = {},
	): Promise<Memory[]> {
		return (await this.listDocumentsDetailed(message, options)).documents;
	}

	async listDocumentsDetailed(
		message?: Memory,
		options: DocumentListOptions = {},
	): Promise<DocumentListResult> {
		return this.listDocumentsDetailedWithRequester(options, () =>
			resolveDocumentRequester(this.runtime, message),
		);
	}

	async listAllDocumentsWithAccessContext(
		accessContext: AccessContext,
	): Promise<Memory[]> {
		const documents: Memory[] = [];
		let cursor: DocumentListCursor | undefined;
		const seenCursors = new Set<string>();
		do {
			const page = await this.listDocumentsDetailedWithRequester(
				{
					limit: DOCUMENT_LIST_MAX_LIMIT,
					...(cursor ? { cursor } : {}),
				},
				() =>
					resolveDocumentRequesterFromAccessContext(
						this.runtime,
						accessContext,
					),
			);
			documents.push(...page.documents);
			if (!page.hasMore) break;
			if (!page.nextCursor) {
				throw new ElizaError(
					"Document list reported another page without a continuation cursor",
					{
						code: "DOCUMENT_LIST_CURSOR_MISSING",
						context: { returnedDocuments: page.documents.length },
						severity: "fatal",
					},
				);
			}
			const serializedCursor = documentListCursorKey(page.nextCursor);
			if (seenCursors.has(serializedCursor)) {
				throw new ElizaError(
					"Document list reported a repeating pagination cursor",
					{
						code: "DOCUMENT_LIST_CURSOR_LOOP",
						context: { cursor: page.nextCursor },
						severity: "fatal",
					},
				);
			}
			seenCursors.add(serializedCursor);
			cursor = page.nextCursor;
		} while (cursor);

		const finalRequester = await resolveDocumentRequesterFromAccessContext(
			this.runtime,
			accessContext,
		);
		return documents.filter((document) =>
			isDocumentVisibleToRequester(document, {
				agentId: this.runtime.agentId,
				requesterEntityId: finalRequester.entityId,
				requesterRoomIds: finalRequester.roomIds,
				requesterRole: finalRequester.role,
			}),
		);
	}

	private async listDocumentsDetailedWithRequester(
		options: DocumentListOptions,
		resolveRequester: DocumentRequesterResolver,
	): Promise<DocumentListResult> {
		const limit =
			typeof options.limit === "number" && Number.isFinite(options.limit)
				? Math.max(
						1,
						Math.min(Math.floor(options.limit), DOCUMENT_LIST_MAX_LIMIT),
					)
				: 25;
		const offset = options.offset ?? 0;
		if (
			!Number.isSafeInteger(offset) ||
			offset < 0 ||
			offset > DOCUMENT_LIST_MAX_OFFSET
		) {
			throw new ElizaError(
				`Document list offset must be an integer between 0 and ${DOCUMENT_LIST_MAX_OFFSET}`,
				{
					code: "DOCUMENT_LIST_INVALID_PAGINATION",
					context: { offset },
				},
			);
		}
		if (options.cursor && offset !== 0) {
			throw new ElizaError(
				"Document list cursor cannot be combined with a non-zero offset",
				{
					code: "DOCUMENT_LIST_INVALID_PAGINATION",
					context: { offset },
				},
			);
		}

		const requester = await resolveRequester();
		const query = options.query?.trim();
		const normalizedQuery = query?.toLowerCase();
		const queryParams: DocumentListQueryParams = {
			agentId: this.runtime.agentId,
			requesterEntityId: requester.entityId,
			requesterRoomIds: requester.roomIds,
			requesterRole: requester.role,
			limit,
			offset,
			...(options.cursor ? { cursor: options.cursor } : {}),
			...(normalizedQuery ? { query: normalizedQuery } : {}),
			...(options.scope ? { scope: options.scope } : {}),
			...(options.scopedToEntityId
				? { scopedToEntityId: options.scopedToEntityId }
				: {}),
			...(options.addedBy ? { addedBy: options.addedBy } : {}),
			...(options.timeRangeStart !== undefined
				? { timeRangeStart: options.timeRangeStart }
				: {}),
			...(options.timeRangeEnd !== undefined
				? { timeRangeEnd: options.timeRangeEnd }
				: {}),
			...(options.tags?.length ? { tags: options.tags } : {}),
		};
		const stored = await queryDocumentsWithCapability(
			this.runtime.adapter,
			queryParams,
		);
		const status: DocumentListStatus =
			stored.totalVisible === 0
				? "empty_store"
				: stored.totalAvailable === 0
					? "filter_miss"
					: normalizedQuery && stored.totalMatched === 0
						? "query_miss"
						: stored.documents.length === 0
							? "page_exhausted"
							: "ok";

		return {
			status,
			documents: stored.documents,
			availableDocuments:
				status === "query_miss" ? stored.availableDocuments : [],
			query,
			limit,
			offset,
			...(options.cursor ? { cursor: options.cursor } : {}),
			totalVisible: stored.totalVisible,
			totalAvailable: stored.totalAvailable,
			totalMatched: stored.totalMatched,
			hasMore: stored.hasMore,
			availableOffset: offset,
			availableHasMore:
				status === "query_miss" ? stored.availableHasMore : false,
			...(stored.nextCursor ? { nextCursor: stored.nextCursor } : {}),
			...(status === "query_miss" && stored.availableNextCursor
				? { availableNextCursor: stored.availableNextCursor }
				: {}),
		};
	}

	/** Runs the DOCUMENTS provider's search and inventory reads on one snapshot. */
	async composeProviderDocuments(
		message: Memory,
		listOptions: DocumentListOptions,
	): Promise<{
		relevantFragments: StoredDocument[];
		documents: Memory[];
		pinnedDocuments: Memory[];
	}> {
		const resolveRequester = createDocumentProviderRequesterResolver(
			this.runtime,
			message,
		);
		const [relevantFragments, listResult, pinnedDocuments] = await Promise.all([
			this.searchDocumentsWithRequester(
				message,
				undefined,
				undefined,
				undefined,
				undefined,
				resolveRequester,
			),
			this.listDocumentsDetailedWithRequester(listOptions, resolveRequester),
			this.listPinnedDocumentsWithRequester(resolveRequester),
		]);
		return {
			relevantFragments,
			documents: listResult.documents,
			pinnedDocuments,
		};
	}

	/** Lists every pinned document visible to the provider's requester. */
	private async listPinnedDocumentsWithRequester(
		resolveRequester: DocumentRequesterResolver,
	): Promise<Memory[]> {
		const pinnedDocuments: Memory[] = [];
		let cursor: DocumentListCursor | undefined;
		const seenCursors = new Set<string>();
		do {
			const page = await this.listDocumentsDetailedWithRequester(
				{
					limit: DOCUMENT_LIST_MAX_LIMIT,
					...(cursor ? { cursor } : {}),
				},
				resolveRequester,
			);
			pinnedDocuments.push(
				...page.documents.filter((document) => {
					const metadata = document.metadata as
						| DocumentMemoryMetadata
						| undefined;
					return (
						metadata?.type === MemoryType.DOCUMENT && metadata.pinned === true
					);
				}),
			);
			if (!page.hasMore) break;
			if (!page.nextCursor) {
				throw new ElizaError(
					"Document list reported another page without a continuation cursor",
					{
						code: "DOCUMENT_LIST_CURSOR_MISSING",
						context: { returnedDocuments: page.documents.length },
						severity: "fatal",
					},
				);
			}
			const serializedCursor = documentListCursorKey(page.nextCursor);
			if (seenCursors.has(serializedCursor)) {
				throw new ElizaError(
					"Document list reported a repeating pagination cursor",
					{
						code: "DOCUMENT_LIST_CURSOR_LOOP",
						context: { cursor: page.nextCursor },
						severity: "fatal",
					},
				);
			}
			seenCursors.add(serializedCursor);
			cursor = page.nextCursor;
		} while (cursor);
		return pinnedDocuments;
	}

	async deleteDocument(documentId: UUID, message?: Memory): Promise<void> {
		const requester = await resolveDocumentRequester(this.runtime, message);
		await this.deleteDocumentForRequester(documentId, requester);
	}

	async deleteDocumentWithAccessContext(
		documentId: UUID,
		accessContext: AccessContext,
	): Promise<void> {
		const requester = await resolveDocumentRequesterFromAccessContext(
			this.runtime,
			accessContext,
		);
		await this.deleteDocumentForRequester(documentId, requester);
	}

	private async deleteDocumentForRequester(
		documentId: UUID,
		requester: DocumentRequester,
	): Promise<void> {
		const document = await this.runtime.adapter.getDocument({
			agentId: this.runtime.agentId,
			documentId,
			requesterEntityId: requester.entityId,
			requesterRoomIds: requester.roomIds,
			requesterRole: requester.role,
		});
		if (!document) {
			throw new ElizaError(`Document ${documentId} not found`, {
				code: "DOCUMENT_NOT_FOUND",
				context: { documentId },
			});
		}
		const snapshot = readDocumentMutationSnapshot(document);
		if (!snapshot) {
			throw new ElizaError(
				"Stored document authorization metadata is invalid",
				{
					code: "DOCUMENT_AUTHORIZATION_INVALID",
					context: { documentId },
					severity: "fatal",
				},
			);
		}
		const result = await this.runtime.adapter.deleteDocumentWithSnapshot({
			agentId: this.runtime.agentId,
			documentId,
			expected: snapshot,
			requesterEntityId: requester.entityId,
			requesterRoomIds: requester.roomIds,
			requesterRole: requester.role,
		});
		if (result.status !== "deleted") {
			throw new ElizaError(
				"Document delete authorization changed before mutation",
				{
					code:
						result.status === "forbidden"
							? "DOCUMENT_MUTATION_FORBIDDEN"
							: result.status === "not_found"
								? "DOCUMENT_NOT_FOUND"
								: "DOCUMENT_MUTATION_CONFLICT",
					context: { documentId, status: result.status },
				},
			);
		}
	}

	private async backfillDocumentScopes(): Promise<void> {
		const backfillTable = async (tableName: string): Promise<void> => {
			let offset = 0;
			while (true) {
				const memories = await this.runtime.getMemories({
					tableName,
					agentId: this.runtime.agentId,
					count: 500,
					offset,
				});
				if (memories.length === 0) return;

				for (const memory of memories) {
					if (!memory.id) continue;
					const metadata = (memory.metadata ?? {}) as Record<string, unknown>;
					if (typeof metadata.scope === "string") continue;
					await this.runtime.updateMemory({
						id: memory.id,
						metadata: {
							...metadata,
							scope: "global",
							scopedToEntityId: undefined,
							addedBy: memory.entityId,
							addedByRole: "RUNTIME",
							addedFrom:
								metadata.source === "eliza-default-documents"
									? "default-seed"
									: "runtime-internal",
							addedAt:
								typeof memory.createdAt === "number"
									? memory.createdAt
									: Date.now(),
						},
					});
				}

				if (memories.length < 500) return;
				offset += memories.length;
			}
		};

		await backfillTable(DOCUMENTS_TABLE);
		await backfillTable(DOCUMENT_FRAGMENTS_TABLE);
	}

	private buildScopedMetadata(
		memory: Memory,
		type: MemoryType,
	): Record<string, unknown> {
		const metadata = (memory.metadata ?? {}) as Record<string, unknown>;
		if (typeof metadata.scope === "string") {
			return { ...metadata, type };
		}
		return {
			...metadata,
			type,
			scope: "global",
			scopedToEntityId: undefined,
			addedBy: memory.entityId,
			addedByRole: "RUNTIME",
			addedFrom:
				metadata.source === "eliza-default-documents" ||
				metadata.source === "eliza-default-knowledge"
					? "default-seed"
					: "runtime-internal",
			addedAt:
				typeof memory.createdAt === "number" ? memory.createdAt : Date.now(),
		};
	}

	private async migratePreDocumentsPartition(): Promise<void> {
		const memories: Memory[] = [];
		let offset = 0;
		while (true) {
			const batch = await this.runtime.getMemories({
				tableName: PRE_DOCUMENTS_TABLE,
				agentId: this.runtime.agentId,
				count: 500,
				offset,
			});
			if (batch.length === 0) break;
			memories.push(...batch);
			if (batch.length < 500) break;
			offset += batch.length;
		}
		if (memories.length === 0) return;

		const documents = memories.filter((memory) =>
			this.isDocumentMemory(memory),
		);
		const fragments = memories.filter((memory) =>
			this.isDocumentFragmentMemory(memory),
		);
		const migratedFragmentIds = new Set<UUID>();

		for (const document of documents) {
			if (!document.id) continue;
			const documentId = document.id as UUID;
			const relatedFragments = fragments.filter((fragment) => {
				const metadata = fragment.metadata as
					| Record<string, unknown>
					| undefined;
				return metadata?.documentId === documentId;
			});

			await this.runtime.deleteMemory(documentId);
			await this.runtime.createMemory(
				{
					...document,
					id: documentId,
					metadata: this.buildScopedMetadata(document, MemoryType.DOCUMENT),
				},
				DOCUMENTS_TABLE,
			);

			for (const fragment of relatedFragments) {
				if (!fragment.id) continue;
				const fragmentId = fragment.id as UUID;
				await this.runtime.createMemory(
					{
						...fragment,
						id: fragmentId,
						metadata: this.buildScopedMetadata(fragment, MemoryType.FRAGMENT),
					},
					DOCUMENT_FRAGMENTS_TABLE,
				);
				migratedFragmentIds.add(fragmentId);
			}
		}

		for (const fragment of fragments) {
			if (!fragment.id || migratedFragmentIds.has(fragment.id as UUID))
				continue;
			const fragmentId = fragment.id as UUID;
			await this.runtime.deleteMemory(fragmentId);
			await this.runtime.createMemory(
				{
					...fragment,
					id: fragmentId,
					metadata: this.buildScopedMetadata(fragment, MemoryType.FRAGMENT),
				},
				DOCUMENT_FRAGMENTS_TABLE,
			);
		}

		logger.info(
			`Migrated ${documents.length} document(s) and ${fragments.length} fragment(s) into document partitions`,
		);
	}

	async addDocument(options: AddDocumentOptions): Promise<{
		clientDocumentId: string;
		storedDocumentMemoryId: UUID;
		fragmentCount: number;
	}> {
		const agentId = options.agentId || (this.runtime.agentId as UUID);
		requireDocumentScopeUuid(options.worldId, "worldId");
		requireDocumentScopeUuid(options.roomId, "roomId");
		requireDocumentScopeUuid(options.entityId, "entityId");

		const contentBasedId = generateContentBasedId(options.content, agentId, {
			includeFilename: options.originalFilename,
			contentType: options.contentType,
		}) as UUID;

		logger.info(
			`Processing "${options.originalFilename}" (${options.contentType})`,
		);

		const existingDocument = await this.runtime.getMemoryById(contentBasedId);
		if (
			existingDocument &&
			(existingDocument.metadata?.type === MemoryType.DOCUMENT ||
				existingDocument.metadata?.type === MemoryType.CUSTOM)
		) {
			const snapshot = readDocumentMutationSnapshot(existingDocument);
			if (!snapshot) {
				const metadata = existingDocument.metadata as
					| Record<string, unknown>
					| undefined;
				if (
					metadata?.ingestionAttemptId !== undefined ||
					metadata?.ingestionState !== undefined
				) {
					throw new ElizaError(
						"Stored document ingestion metadata is invalid",
						{
							code: "DOCUMENT_AUTHORIZATION_INVALID",
							context: { documentId: contentBasedId },
							severity: "fatal",
						},
					);
				}
				const legacyFragmentCount =
					await this.getDocumentFragmentCount(contentBasedId);
				if (legacyFragmentCount > 0) {
					return {
						clientDocumentId: contentBasedId,
						storedDocumentMemoryId: existingDocument.id as UUID,
						fragmentCount: legacyFragmentCount,
					};
				}
				logger.warn(
					`"${options.originalFilename}" has a legacy zero-fragment stub; deleting it before attempt-fenced reprocessing`,
				);
				await this.runtime.deleteMemory(contentBasedId);
			} else if (snapshot.ingestionState === "pending") {
				if (!this.pendingIngestionHasExpired(existingDocument)) {
					throw new ElizaError(
						`Document ${contentBasedId} ingestion is already in progress`,
						{
							code: "DOCUMENT_INGESTION_IN_PROGRESS",
							context: { documentId: contentBasedId },
						},
					);
				}
				logger.warn(
					`"${options.originalFilename}" has an expired pending ingestion; deleting its exact snapshot and reprocessing`,
				);
				await this.deleteDocumentSnapshotForIngestion(contentBasedId, snapshot);
				return this.processDocument({
					...options,
					clientDocumentId: contentBasedId,
				});
			} else {
				const fragmentCount =
					await this.getDocumentFragmentCount(contentBasedId);
				if (snapshot.ingestionState !== "failed" && fragmentCount > 0) {
					logger.info(
						`"${options.originalFilename}" already exists with ${fragmentCount} fragments - skipping`,
					);

					return {
						clientDocumentId: contentBasedId,
						storedDocumentMemoryId: existingDocument.id as UUID,
						fragmentCount,
					};
				}
				logger.warn(
					`"${options.originalFilename}" has an incomplete prior ingestion; deleting its exact snapshot and reprocessing`,
				);
				await this.deleteDocumentSnapshotForIngestion(contentBasedId, snapshot);
			}
		}

		return this.processDocument({
			...options,
			clientDocumentId: contentBasedId,
		});
	}

	private async processDocument({
		agentId: passedAgentId,
		clientDocumentId,
		contentType,
		originalFilename,
		worldId,
		content,
		roomId,
		entityId,
		scope,
		scopedToEntityId,
		addedBy,
		addedByRole,
		addedFrom,
		metadata,
		pinned = false,
		fragments,
	}: AddDocumentOptions): Promise<{
		clientDocumentId: string;
		storedDocumentMemoryId: UUID;
		fragmentCount: number;
	}> {
		const agentId = passedAgentId || (this.runtime.agentId as UUID);

		try {
			logger.debug(
				`Processing document ${originalFilename} (type: ${contentType}) for agent: ${agentId}`,
			);

			let fileBuffer: Buffer | null = null;
			let extractedText: string;
			let documentContentToStore: string;
			const normalizedContentType = normalizeDocumentContentType(contentType);
			const isPdfFile =
				normalizedContentType === "application/pdf" ||
				originalFilename.toLowerCase().endsWith(".pdf");

			if (isPdfFile) {
				try {
					fileBuffer = Buffer.from(content, "base64");
				} catch (e) {
					// error-policy:J2 Preserve the decoder failure as the cause of
					// a document-specific validation error.
					logger.error(
						{ error: e },
						`Failed to convert base64 to buffer for ${originalFilename}`,
					);
					throw new ElizaError(
						`Invalid base64 content for PDF file ${originalFilename}`,
						{
							code: "DOCUMENT_BASE64_INVALID",
							context: { originalFilename, contentType },
							cause: e,
						},
					);
				}
				extractedText = await extractTextFromDocument(
					fileBuffer,
					normalizedContentType,
					originalFilename,
				);
				documentContentToStore = content;
			} else if (isBinaryContentType(normalizedContentType, originalFilename)) {
				try {
					fileBuffer = Buffer.from(content, "base64");
				} catch (e) {
					// error-policy:J2 Preserve the decoder failure as the cause of
					// a document-specific validation error.
					logger.error(
						{ error: e },
						`Failed to convert base64 to buffer for ${originalFilename}`,
					);
					throw new ElizaError(
						`Invalid base64 content for binary file ${originalFilename}`,
						{
							code: "DOCUMENT_BASE64_INVALID",
							context: { originalFilename, contentType },
							cause: e,
						},
					);
				}
				extractedText = await extractTextFromDocument(
					fileBuffer,
					normalizedContentType,
					originalFilename,
				);
				documentContentToStore = extractedText;
			} else {
				if (looksLikeBase64(content)) {
					try {
						const decodedBuffer = Buffer.from(content, "base64");
						const decodedText = decodedBuffer.toString("utf8");

						const invalidCharCount = (decodedText.match(/\ufffd/g) || [])
							.length;
						const textLength = decodedText.length;

						if (invalidCharCount > 0 && invalidCharCount / textLength > 0.1) {
							throw new Error(
								"Decoded content contains too many invalid characters",
							);
						}

						logger.debug(
							`Successfully decoded base64 content for text file: ${originalFilename}`,
						);
						extractedText = decodedText;
						documentContentToStore = decodedText;
					} catch (e) {
						// error-policy:J2 Preserve the decoding failure as the cause
						// of a document-specific validation error.
						logger.error(
							{ error: e instanceof Error ? e : new Error(String(e)) },
							`Failed to decode base64 for ${originalFilename}`,
						);
						throw new ElizaError(
							`File ${originalFilename} appears to be corrupted or incorrectly encoded`,
							{
								code: "DOCUMENT_ENCODING_INVALID",
								context: { originalFilename, contentType },
								cause: e,
							},
						);
					}
				} else {
					logger.debug(
						`Treating content as plain text for file: ${originalFilename}`,
					);
					extractedText = content;
					documentContentToStore = content;
				}
			}

			if (!extractedText || extractedText.trim() === "") {
				throw new Error(
					`No text content extracted from ${originalFilename} (type: ${contentType})`,
				);
			}

			const documentScope = resolveWriteDocumentScope({
				scope,
				entityId,
				agentId,
			});
			const targetEntityId =
				documentScope === "user-private"
					? (scopedToEntityId ?? entityId)
					: documentScope === "owner-private"
						? ((this.runtime.getSetting("ELIZA_ADMIN_ENTITY_ID") as
								| UUID
								| undefined) ??
							entityId ??
							agentId)
						: agentId;
			const scopedEntityId =
				documentScope === "global" ? undefined : targetEntityId;
			const ingestionAttemptId = this.runtime.createRunId();
			const scopedMetadata = {
				...metadata,
				scope: documentScope,
				scopedToEntityId: scopedEntityId,
				addedBy: addedBy ?? entityId,
				addedByRole: addedByRole ?? "RUNTIME",
				addedFrom: addedFrom ?? "runtime-internal",
				addedAt: Date.now(),
				ingestionAttemptId,
				ingestionState: "pending" as const,
				pinned,
			};

			const documentMemory = createDocumentMemory({
				text: documentContentToStore,
				agentId,
				clientDocumentId,
				originalFilename,
				contentType,
				worldId,
				fileSize: fileBuffer
					? fileBuffer.length
					: Buffer.byteLength(extractedText, "utf8"),
				documentId: clientDocumentId,
				customMetadata: scopedMetadata,
			});

			const memoryWithScope = {
				...documentMemory,
				id: clientDocumentId,
				agentId: agentId,
				// requireDocumentScopeUuid above already rejected an explicit "",
				// so roomId here is always a real UUID or omitted; || vs ?? is moot.
				roomId: roomId || agentId,
				entityId: targetEntityId,
			};
			if (fragments !== undefined) {
				memoryWithScope.content = {
					...memoryWithScope.content,
					text: this.runtime.redactSecrets(extractedText),
				};
			}

			await this.runtime.createMemory(memoryWithScope, DOCUMENTS_TABLE);
			const persistedDocument =
				await this.runtime.getMemoryById(clientDocumentId);
			const ingestionSnapshot = persistedDocument
				? readDocumentMutationSnapshot(persistedDocument)
				: null;
			if (
				!persistedDocument ||
				!ingestionSnapshot ||
				ingestionSnapshot.ingestionAttemptId !== ingestionAttemptId ||
				ingestionSnapshot.ingestionState !== "pending"
			) {
				const existingFragmentCount =
					await this.getDocumentFragmentCount(clientDocumentId);
				if (
					persistedDocument?.id &&
					ingestionSnapshot &&
					(ingestionSnapshot.ingestionState === "ready" ||
						ingestionSnapshot.ingestionState === undefined) &&
					existingFragmentCount > 0
				) {
					return {
						clientDocumentId,
						storedDocumentMemoryId: persistedDocument.id as UUID,
						fragmentCount: existingFragmentCount,
					};
				}
				throw new ElizaError(
					`Document ${clientDocumentId} ingestion is owned by another attempt`,
					{
						code: "DOCUMENT_INGESTION_IN_PROGRESS",
						context: { clientDocumentId },
					},
				);
			}

			let fragmentCount: number;
			try {
				if (fragments !== undefined) {
					const fragmentMemories = await preparePreChunkedFragmentMemories({
						runtime: this.runtime,
						documentId: clientDocumentId,
						fragments,
						agentId,
						// requireDocumentScopeUuid above already validated roomId, so
						// it's always a real UUID here; || vs ?? is moot.
						roomId: roomId || agentId,
						entityId: targetEntityId,
						worldId: worldId ?? agentId,
						documentTitle: originalFilename,
						documentMetadata:
							(documentMemory.metadata as Record<string, unknown>) ?? undefined,
					});
					await this.runtime.createMemories(
						fragmentMemories.map((memory) => ({
							memory,
							tableName: DOCUMENT_FRAGMENTS_TABLE,
							unique: false,
						})),
					);
					fragmentCount = fragmentMemories.length;
				} else {
					fragmentCount = await processFragmentsSynchronously({
						runtime: this.runtime,
						documentId: clientDocumentId,
						fullDocumentText: extractedText,
						agentId,
						contentType,
						roomId: roomId || agentId,
						entityId: targetEntityId,
						worldId: worldId ?? agentId,
						documentTitle: originalFilename,
						documentMetadata:
							(documentMemory.metadata as Record<string, unknown>) ?? undefined,
					});
				}
				if (fragmentCount === 0) {
					throw new ElizaError(
						`All fragments failed processing for ${originalFilename}`,
						{
							code: "DOCUMENT_EMBED_FAILED",
							context: { originalFilename, contentType, clientDocumentId },
						},
					);
				}

				const completed = await this.runtime.adapter.compareAndSwapDocument({
					...this.ingestionMutationContext(),
					documentId: clientDocumentId,
					expected: ingestionSnapshot,
					replacement: {
						...persistedDocument,
						metadata: {
							...(persistedDocument.metadata ?? {}),
							ingestionState: "ready",
						} as unknown as Metadata,
					},
				});
				if (completed.status !== "updated") {
					throw new ElizaError(
						"Document ingestion ownership changed before completion",
						{
							code: "DOCUMENT_INGESTION_CONFLICT",
							context: { clientDocumentId, status: completed.status },
						},
					);
				}
			} catch (fragmentError) {
				await this.compensateFailedIngestion(
					clientDocumentId,
					ingestionAttemptId,
				);
				throw fragmentError;
			}

			logger.debug(
				`"${originalFilename}" stored with ${fragmentCount} fragments`,
			);

			return {
				clientDocumentId,
				storedDocumentMemoryId: memoryWithScope.id as UUID,
				fragmentCount,
			};
		} catch (error) {
			// error-policy:J2 Attach document identity while preserving the cause.
			logger.error({ error }, `Error processing document ${originalFilename}`);
			throw new ElizaError(`Failed to process document ${originalFilename}`, {
				code: "DOCUMENT_PROCESSING_FAILED",
				context: { originalFilename, contentType },
				cause: error,
			});
		}
	}

	private ingestionMutationContext() {
		return {
			agentId: this.runtime.agentId,
			requesterEntityId: this.runtime.agentId,
			requesterRoomIds: [] as UUID[],
			requesterRole: "OWNER" as const,
		};
	}

	private pendingIngestionHasExpired(document: Memory): boolean {
		const addedAt = (document.metadata as DocumentMemoryMetadata | undefined)
			?.addedAt;
		return (
			typeof addedAt === "number" &&
			Number.isFinite(addedAt) &&
			Date.now() - addedAt >= DOCUMENT_INGESTION_PENDING_TIMEOUT_MS
		);
	}

	private async deleteDocumentSnapshotForIngestion(
		documentId: UUID,
		expected: DocumentMutationSnapshot,
	): Promise<void> {
		const deleted = await this.runtime.adapter.deleteDocumentWithSnapshot({
			...this.ingestionMutationContext(),
			documentId,
			expected,
		});
		if (deleted.status !== "deleted") {
			throw new ElizaError(
				"Document ingestion snapshot changed before cleanup",
				{
					code: "DOCUMENT_INGESTION_CONFLICT",
					context: { documentId, status: deleted.status },
				},
			);
		}
	}

	/**
	 * Persist a failed lifecycle marker before transactional cleanup. The marker
	 * survives a cleanup outage, so retries never accept partial fragments as a
	 * healthy document. Every write and delete is fenced by the attempt token.
	 */
	private async compensateFailedIngestion(
		documentId: UUID,
		ingestionAttemptId: UUID,
	): Promise<void> {
		try {
			const current = await this.runtime.getMemoryById(documentId);
			const pendingSnapshot = current
				? readDocumentMutationSnapshot(current)
				: null;
			if (
				!current ||
				!pendingSnapshot ||
				pendingSnapshot.ingestionAttemptId !== ingestionAttemptId ||
				pendingSnapshot.ingestionState !== "pending"
			) {
				throw new ElizaError(
					"Document ingestion ownership changed before compensation",
					{
						code: "DOCUMENT_INGESTION_CONFLICT",
						context: { documentId },
					},
				);
			}

			const failed = await this.runtime.adapter.compareAndSwapDocument({
				...this.ingestionMutationContext(),
				documentId,
				expected: pendingSnapshot,
				replacement: {
					...current,
					metadata: {
						...(current.metadata ?? {}),
						ingestionState: "failed" as const,
					} as unknown as Metadata,
				},
			});
			if (failed.status !== "updated") {
				throw new ElizaError(
					"Document ingestion ownership changed while marking failure",
					{
						code: "DOCUMENT_INGESTION_CONFLICT",
						context: { documentId, status: failed.status },
					},
				);
			}
			const failedSnapshot = readDocumentMutationSnapshot(failed.document);
			if (
				!failedSnapshot ||
				failedSnapshot.ingestionAttemptId !== ingestionAttemptId ||
				failedSnapshot.ingestionState !== "failed"
			) {
				throw new ElizaError("Failed document lifecycle snapshot is invalid", {
					code: "DOCUMENT_INGESTION_CONFLICT",
					context: { documentId },
				});
			}

			await this.deleteDocumentSnapshotForIngestion(documentId, failedSnapshot);
			logger.warn(
				`DocumentService: rolled back failed ingestion ${ingestionAttemptId} for document ${documentId}`,
			);
		} catch (cleanupError) {
			// error-policy:J7 Cleanup is best effort and must not mask the original
			// extraction/embedding failure. A successfully persisted `failed` marker
			// makes the next retry clean the exact snapshot before starting again.
			this.runtime.reportError(
				"DocumentService.compensateFailedIngestion",
				cleanupError instanceof Error
					? cleanupError
					: new Error(String(cleanupError)),
				{ documentId, ingestionAttemptId },
			);
		}
	}

	private async getDocumentFragmentCount(documentId: UUID): Promise<number> {
		return this.runtime.countMemories({
			tableName: DOCUMENT_FRAGMENTS_TABLE,
			agentId: this.runtime.agentId,
			metadata: {
				type: MemoryType.FRAGMENT,
				documentId,
			},
		});
	}

	async checkExistingDocument(documentId: UUID): Promise<boolean> {
		const existingDocument = await this.runtime.getMemoryById(documentId);
		if (!existingDocument) {
			return false;
		}

		if (
			existingDocument.metadata?.type === MemoryType.DOCUMENT ||
			existingDocument.metadata?.type === MemoryType.CUSTOM
		) {
			const snapshot = readDocumentMutationSnapshot(existingDocument);
			if (!snapshot) {
				return false;
			}
			if (snapshot.ingestionState === "pending") {
				if (!this.pendingIngestionHasExpired(existingDocument)) return true;
				logger.warn(
					`Document ${documentId} has an expired pending ingestion; deleting its exact snapshot before retry`,
				);
				await this.deleteDocumentSnapshotForIngestion(documentId, snapshot);
				return false;
			}
			const fragmentCount = await this.getDocumentFragmentCount(documentId);
			if (snapshot.ingestionState === "failed" || fragmentCount === 0) {
				logger.warn(
					`Document ${documentId} has an incomplete ingestion; deleting its exact snapshot before retry`,
				);
				await this.deleteDocumentSnapshotForIngestion(documentId, snapshot);
				return false;
			}
		}

		return true;
	}

	async searchDocuments(
		message: Memory,
		scope?: { roomId?: UUID; worldId?: UUID; entityId?: UUID },
		searchMode?: SearchMode,
		accessContext?: AccessContext,
		options?: { turnMessageId?: UUID; signal?: AbortSignal },
	): Promise<StoredDocument[]> {
		return this.searchDocumentsWithRequester(
			message,
			scope,
			searchMode,
			accessContext,
			options,
			() => resolveDocumentRequester(this.runtime, message),
		);
	}

	private async searchDocumentsWithRequester(
		message: Memory,
		scope: { roomId?: UUID; worldId?: UUID; entityId?: UUID } | undefined,
		searchMode: SearchMode | undefined,
		accessContext: AccessContext | undefined,
		options: { turnMessageId?: UUID; signal?: AbortSignal } | undefined,
		resolveRequester: DocumentRequesterResolver,
	): Promise<StoredDocument[]> {
		if (!message.content.text || message.content.text.trim().length === 0) {
			logger.warn("Invalid or empty message content for document query");
			return [];
		}

		const queryText = message.content.text;
		// The caller's AccessContext governs the read when supplied. Deriving the
		// requester from the message sender alone is wrong whenever the two
		// differ — an agent-authored search carries the AGENT role, which has
		// global document visibility, so an owner-private document would reach a
		// requester the caller explicitly scoped down to a plain user.
		const requester = accessContext
			? await resolveDocumentRequesterFromAccessContext(
					this.runtime,
					accessContext,
				)
			: await resolveRequester();
		const filterScope: { roomId?: UUID; worldId?: UUID; entityId?: UUID } = {};
		if (scope?.roomId) filterScope.roomId = scope.roomId;
		if (scope?.worldId) filterScope.worldId = scope.worldId;
		if (scope?.entityId) filterScope.entityId = scope.entityId;

		// Determine effective mode, falling back to keyword when no embedding model
		const hasEmbeddingModel = Boolean(
			this.runtime.getModel(ModelType.TEXT_EMBEDDING),
		);
		let effectiveMode: SearchMode = searchMode ?? "hybrid";
		if (!hasEmbeddingModel && effectiveMode !== "keyword") {
			logger.debug(
				"No TEXT_EMBEDDING model registered — falling back to keyword search",
			);
			effectiveMode = "keyword";
		}

		let results: StoredDocument[];
		if (effectiveMode === "keyword") {
			results = await this._keywordSearch(queryText, filterScope, requester);
		} else if (effectiveMode === "vector") {
			results = await this._vectorSearch(
				queryText,
				filterScope,
				requester,
				options?.turnMessageId,
				options?.signal,
			);
		} else {
			// hybrid: vector + BM25 combined
			results = await this._hybridSearch(
				queryText,
				filterScope,
				requester,
				options?.turnMessageId,
				options?.signal,
			);
		}

		// The caller-supplied AccessContext stays a second, strictly-subtractive
		// gate on top of the adapter-level requester filtering. The adapter query
		// filters by who the MESSAGE says is asking; a caller whose identity
		// differs from the message identity (an agent-initiated search on behalf
		// of a user) must still be narrowed to ITS view, and no caller can widen
		// its view by threading a context. Fragments missing an entityId fall to
		// the deny side of scoped reads (fail closed). Pinned by
		// packages/agent/src/api/chat-augmentation.access-context.test.ts.
		if (!accessContext) return results;
		return filterByAccessContext(results, accessContext, this.runtime.agentId);
	}

	/** Pure vector (cosine-similarity) search. */
	private async _vectorSearch(
		queryText: string,
		filterScope: { roomId?: UUID; worldId?: UUID; entityId?: UUID },
		requester: DocumentRequester,
		turnMessageId?: UUID,
		signal?: AbortSignal,
	): Promise<StoredDocument[]> {
		// Bound the recall embed and fail open to keyword/BM25 recall on a
		// slow/unavailable embed (issue #47): a slow embed costs recall richness,
		// never reply latency. `embedRecallQuery` caches + dedupes per turn; the
		// pre-run augmentation caller threads `turnMessageId` so the in-run
		// prefetch adopts this vector instead of re-embedding (#15253).
		const embedding = await embedRecallQuery(this.runtime, queryText, {
			messageId: turnMessageId,
			signal,
		});
		if (!embedding) {
			return this._keywordSearch(queryText, filterScope, requester);
		}

		const fragments = await this.runtime.adapter.queryDocumentFragments({
			agentId: this.runtime.agentId,
			requesterEntityId: requester.entityId,
			requesterRoomIds: requester.roomIds,
			requesterRole: requester.role,
			embedding,
			...filterScope,
			limit: 20,
			matchThreshold: 0.1,
		});

		return fragments
			.filter((fragment) => fragment.id !== undefined)
			.map((fragment) => ({
				id: fragment.id as UUID,
				entityId: fragment.entityId,
				content: fragment.content as Content,
				similarity: fragment.similarity,
				metadata: fragment.metadata,
				worldId: fragment.worldId,
			})) as StoredDocument[];
	}

	/**
	 * Pure BM25 keyword search over all stored fragments.
	 * Does not require an embedding model.
	 */
	private async _keywordSearch(
		queryText: string,
		filterScope: { roomId?: UUID; worldId?: UUID; entityId?: UUID },
		requester: DocumentRequester,
	): Promise<StoredDocument[]> {
		const allFragments = await this.runtime.adapter.queryDocumentFragments({
			agentId: this.runtime.agentId,
			requesterEntityId: requester.entityId,
			requesterRoomIds: requester.roomIds,
			requesterRole: requester.role,
			...filterScope,
			limit: 1_000,
		});
		const valid = allFragments.filter(
			(f) => f.id !== undefined && f.content.text,
		);
		if (valid.length === 0) return [];

		const docs = valid.map((f) => ({
			id: f.id as string,
			text: f.content.text ?? "",
		}));

		const rawScores = bm25Scores(queryText, docs);
		const normScores = normalizeBm25Scores(rawScores);
		const scoreMap = new Map(normScores.map((s) => [s.id, s.score]));

		return valid
			.map((fragment) => ({
				id: fragment.id as UUID,
				entityId: fragment.entityId,
				content: fragment.content as Content,
				similarity: scoreMap.get(fragment.id as string) ?? 0,
				metadata: fragment.metadata,
				worldId: fragment.worldId,
			}))
			.filter((item) => item.similarity > 0)
			.sort((a, b) => b.similarity - a.similarity) as StoredDocument[];
	}

	/**
	 * Hybrid search: vector top-K re-ranked with BM25, combined as
	 *   score = 0.6 * normalised_vector + 0.4 * normalised_bm25
	 */
	private async _hybridSearch(
		queryText: string,
		filterScope: { roomId?: UUID; worldId?: UUID; entityId?: UUID },
		requester: DocumentRequester,
		turnMessageId?: UUID,
		signal?: AbortSignal,
	): Promise<StoredDocument[]> {
		// Bound the recall embed and fail open to keyword/BM25 recall on a
		// slow/unavailable embed (issue #47). `_keywordSearch` is the same BM25
		// path hybrid would otherwise blend in, so a slow embed degrades
		// gracefully to keyword-only recall instead of blocking the reply.
		// `turnMessageId` lets the pre-run augmentation caller warm the per-turn
		// cache the in-run prefetch adopts (#15253).
		const embedding = await embedRecallQuery(this.runtime, queryText, {
			messageId: turnMessageId,
			signal,
		});
		if (!embedding) {
			return this._keywordSearch(queryText, filterScope, requester);
		}

		// Fetch a larger PURE-VECTOR candidate set so the explicit BM25 blend below
		// can re-rank meaningfully. Do NOT pass `query`: that triggers a runtime
		// BM25 rerank that drops zero-overlap candidates *before* the blend, so the
		// 0.6·vector + 0.4·bm25 combine never sees the semantic-only matches. And
		// use `count` (the adapter honours it; `limit` was ignored → pool capped at
		// the default 10, defeating "fetch a larger candidate set").
		const candidates = await this.runtime.adapter.queryDocumentFragments({
			agentId: this.runtime.agentId,
			requesterEntityId: requester.entityId,
			requesterRoomIds: requester.roomIds,
			requesterRole: requester.role,
			embedding,
			...filterScope,
			limit: 40,
			matchThreshold: 0.05,
		});
		const valid = candidates.filter(
			(f) => f.id !== undefined && f.content.text,
		);
		if (valid.length === 0) return [];

		// Normalise vector scores to [0, 1]
		const rawSimilarities = valid.map((f) =>
			typeof f.similarity === "number" ? f.similarity : 0,
		);
		const maxSim = Math.max(...rawSimilarities);
		const minSim = Math.min(...rawSimilarities);
		const simRange = maxSim - minSim;

		const normVectorScore = (raw: number): number =>
			simRange === 0 ? 1 : (raw - minSim) / simRange;

		// BM25 over candidate set
		const docs = valid.map((f) => ({
			id: f.id as string,
			text: f.content.text ?? "",
		}));
		const rawBm25 = bm25Scores(queryText, docs);
		const normBm25 = normalizeBm25Scores(rawBm25);
		const bm25Map = new Map(normBm25.map((s) => [s.id, s.score]));

		return valid
			.map((fragment) => {
				const vectorNorm = normVectorScore(
					typeof fragment.similarity === "number" ? fragment.similarity : 0,
				);
				const bm25Norm = bm25Map.get(fragment.id as string) ?? 0;
				const combined =
					HYBRID_VECTOR_WEIGHT * vectorNorm + HYBRID_BM25_WEIGHT * bm25Norm;
				return {
					id: fragment.id as UUID,
					entityId: fragment.entityId,
					content: fragment.content as Content,
					similarity: combined,
					metadata: fragment.metadata,
					worldId: fragment.worldId,
				};
			})
			.sort((a, b) => b.similarity - a.similarity) as StoredDocument[];
	}

	async enrichConversationMemoryWithRAG(
		memoryId: UUID,
		ragMetadata: {
			retrievedFragments: Array<{
				fragmentId: UUID;
				documentTitle: string;
				similarityScore?: number;
				contentPreview: string;
			}>;
			queryText: string;
			totalFragments: number;
			retrievalTimestamp: number;
		},
	): Promise<void> {
		try {
			const existingMemory = await this.runtime.getMemoryById(memoryId);
			if (!existingMemory) {
				logger.warn(`Cannot enrich memory ${memoryId} - memory not found`);
				return;
			}

			const ragUsageData = {
				retrievedFragments: ragMetadata.retrievedFragments,
				queryText: ragMetadata.queryText,
				totalFragments: ragMetadata.totalFragments,
				retrievalTimestamp: ragMetadata.retrievalTimestamp,
				usedInResponse: true,
			};
			const updatedMetadata: CustomMetadata = {
				...(existingMemory.metadata as CustomMetadata),
				documentsUsed: true,
				ragUsage: JSON.stringify(ragUsageData),
				timestamp: existingMemory.metadata?.timestamp ?? Date.now(),
				type: MemoryType.CUSTOM,
			};

			await this.runtime.updateMemory({
				id: memoryId,
				metadata: updatedMetadata,
			});
		} catch (error) {
			// error-policy:J7 RAG usage metadata is diagnostic enrichment; the
			// conversation memory remains valid and the failure is reported.
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			logger.warn(
				`Failed to enrich conversation memory ${memoryId} with RAG data: ${errorMessage}`,
			);
			this.runtime.reportError(
				"DocumentService.enrichConversationMemory",
				error,
				{ memoryId },
			);
		}
	}

	private pendingRAGEnrichment: Array<{
		ragMetadata: {
			retrievedFragments: Array<{
				fragmentId: UUID;
				documentTitle: string;
				similarityScore?: number;
				contentPreview: string;
			}>;
			queryText: string;
			totalFragments: number;
			retrievalTimestamp: number;
		};
		timestamp: number;
	}> = [];

	setPendingRAGMetadata(ragMetadata: {
		retrievedFragments: Array<{
			fragmentId: UUID;
			documentTitle: string;
			similarityScore?: number;
			contentPreview: string;
		}>;
		queryText: string;
		totalFragments: number;
		retrievalTimestamp: number;
	}): void {
		const now = Date.now();
		this.pendingRAGEnrichment = this.pendingRAGEnrichment.filter(
			(entry) => now - entry.timestamp < 30000,
		);

		this.pendingRAGEnrichment.push({
			ragMetadata,
			timestamp: now,
		});
	}

	async enrichRecentMemoriesWithPendingRAG(): Promise<void> {
		if (this.pendingRAGEnrichment.length === 0) {
			return;
		}

		try {
			const recentMemories = await this.runtime.getMemories({
				tableName: "messages",
				limit: 10,
			});

			const now = Date.now();
			const recentConversationMemories = recentMemories
				.filter(
					(memory) =>
						memory.metadata?.type === "message" &&
						now - (memory.createdAt || 0) < 10000 &&
						!(
							memory.metadata &&
							"ragUsage" in memory.metadata &&
							memory.metadata.ragUsage
						),
				)
				.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

			for (const pendingEntry of this.pendingRAGEnrichment) {
				const matchingMemory = recentConversationMemories.find(
					(memory) => (memory.createdAt || 0) > pendingEntry.timestamp,
				);

				if (matchingMemory?.id) {
					await this.enrichConversationMemoryWithRAG(
						matchingMemory.id,
						pendingEntry.ragMetadata,
					);

					const index = this.pendingRAGEnrichment.indexOf(pendingEntry);
					if (index > -1) {
						this.pendingRAGEnrichment.splice(index, 1);
					}
				}
			}
		} catch (error) {
			// error-policy:J7 Pending RAG metadata is diagnostic enrichment; the
			// underlying conversation remains valid and failure is reported.
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			logger.warn(
				`Error enriching recent memories with RAG data: ${errorMessage}`,
			);
			this.runtime.reportError("DocumentService.enrichRecentMemories", error);
		}
	}

	private async waitForCharacterDocumentEmbeddingModel(options?: {
		timeoutMs?: number;
		intervalMs?: number;
	}): Promise<boolean> {
		if (this.runtime.getModel(ModelType.TEXT_EMBEDDING)) {
			return true;
		}

		const timeoutMs =
			options?.timeoutMs ?? CHARACTER_DOCUMENT_EMBEDDING_WAIT_TIMEOUT_MS;
		const intervalMs = Math.max(
			1,
			options?.intervalMs ?? CHARACTER_DOCUMENT_EMBEDDING_WAIT_INTERVAL_MS,
		);
		const deadline = Date.now() + timeoutMs;
		let attempts = 0;

		logger.info(
			`TEXT_EMBEDDING model is not registered yet; waiting up to ${timeoutMs}ms before processing character documents`,
		);

		while (Date.now() < deadline) {
			attempts++;
			await new Promise((resolve) =>
				setTimeout(
					resolve,
					Math.min(intervalMs, Math.max(1, deadline - Date.now())),
				),
			);

			if (this.runtime.getModel(ModelType.TEXT_EMBEDDING)) {
				logger.info(
					`TEXT_EMBEDDING model registered after ${attempts} wait attempt(s); processing character documents`,
				);
				return true;
			}
		}

		logger.warn(
			`TEXT_EMBEDDING model was still not registered after ${timeoutMs}ms; skipping character document ingestion to avoid creating empty-fragment stubs`,
		);
		return false;
	}

	async processCharacterDocuments(
		items: string[],
		options?: {
			embeddingWaitTimeoutMs?: number;
			embeddingWaitIntervalMs?: number;
		},
	): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, 1000));
		const hasEmbeddingModel = await this.waitForCharacterDocumentEmbeddingModel(
			{
				timeoutMs: options?.embeddingWaitTimeoutMs,
				intervalMs: options?.embeddingWaitIntervalMs,
			},
		);
		if (!hasEmbeddingModel) {
			return;
		}

		logger.info(`Processing ${items.length} character documents items`);

		const processingPromises = items.map(async (item) => {
			await this.documentProcessingSemaphore.acquire();
			try {
				const trimmedItem = item.trim();
				if (trimmedItem.length === 0) {
					return;
				}

				if (existsSync(trimmedItem) && statSync(trimmedItem).isDirectory()) {
					await loadDocumentsFromPath(
						this,
						this.runtime.agentId as UUID,
						this.runtime.agentId as UUID,
						trimmedItem,
						{
							roomId: this.runtime.agentId as UUID,
							entityId: this.runtime.agentId as UUID,
							scope: "global",
							scopedToEntityId: undefined,
							addedBy: this.runtime.agentId as UUID,
							addedByRole: "AGENT",
							addedFrom: "character",
							metadata: {
								source: "character",
								characterDocumentDirectory: trimmedItem,
							},
						},
					);
					return;
				}

				if (existsSync(trimmedItem) && statSync(trimmedItem).isFile()) {
					await addDocumentFromFilePath({
						service: this,
						agentId: this.runtime.agentId as UUID,
						worldId: this.runtime.agentId as UUID,
						roomId: this.runtime.agentId as UUID,
						entityId: this.runtime.agentId as UUID,
						filePath: trimmedItem,
						scope: "global",
						scopedToEntityId: undefined,
						addedBy: this.runtime.agentId as UUID,
						addedByRole: "AGENT",
						addedFrom: "character",
						metadata: {
							source: "character",
							characterDocumentPath: trimmedItem,
						},
					});
					return;
				}

				const title = deriveDocumentTitle(trimmedItem, "Character document");
				const filename = createDocumentNoteFilename(title);
				const documentId = generateContentBasedId(
					trimmedItem,
					this.runtime.agentId,
					{ includeFilename: filename },
				) as UUID;

				if (await this.checkExistingDocument(documentId)) {
					return;
				}

				await this._internalAddDocument(
					{
						id: documentId,
						content: {
							text: trimmedItem,
						} as Content,
						metadata: {
							type: MemoryType.DOCUMENT,
							documentId: documentId,
							timestamp: Date.now(),
							source: "character",
							scope: "global",
							scopedToEntityId: undefined,
							addedBy: this.runtime.agentId,
							addedByRole: "AGENT",
							addedFrom: "character",
							addedAt: Date.now(),
							title,
							filename,
							originalFilename: filename,
							fileExt: "txt",
							fileType: "text/plain",
							contentType: "text/plain",
							fileSize: Buffer.byteLength(trimmedItem, "utf8"),
							textBacked: true,
						} satisfies DocumentMemoryMetadata,
					},
					undefined,
					{
						roomId: this.runtime.agentId,
						entityId: this.runtime.agentId,
						worldId: this.runtime.agentId,
					},
				);
			} finally {
				this.documentProcessingSemaphore.release();
			}
		});

		await Promise.all(processingPromises);
	}

	async updateDocument(options: {
		documentId: UUID;
		content: string;
		message?: Memory;
		accessContext?: AccessContext;
	}): Promise<{
		documentId: UUID;
		fragmentCount: number;
	}> {
		const requester = options.accessContext
			? await resolveDocumentRequesterFromAccessContext(
					this.runtime,
					options.accessContext,
				)
			: await resolveDocumentRequester(this.runtime, options.message);
		const requestContext = {
			agentId: this.runtime.agentId,
			requesterEntityId: requester.entityId,
			requesterRoomIds: requester.roomIds,
			requesterRole: requester.role,
		};
		const existingDocument = await this.runtime.adapter.getDocument({
			...requestContext,
			documentId: options.documentId,
		});
		if (!existingDocument) {
			throw new ElizaError(`Document ${options.documentId} not found`, {
				code: "DOCUMENT_NOT_FOUND",
				context: { documentId: options.documentId },
			});
		}
		const snapshot = readDocumentMutationSnapshot(existingDocument);
		if (!snapshot) {
			throw new ElizaError(
				"Stored document authorization metadata is invalid",
				{
					code: "DOCUMENT_AUTHORIZATION_INVALID",
					context: { documentId: options.documentId },
					severity: "fatal",
				},
			);
		}
		if (!canRequesterMutateDocument(existingDocument, requestContext)) {
			throw new ElizaError("Requester cannot mutate this document", {
				code: "DOCUMENT_MUTATION_FORBIDDEN",
				context: {
					documentId: options.documentId,
					requesterEntityId: requester.entityId,
					requesterRole: requester.role,
				},
			});
		}

		const existingMetadata = (existingDocument.metadata ??
			{}) as DocumentMemoryMetadata;
		const filename =
			typeof existingMetadata.filename === "string" &&
			existingMetadata.filename.trim().length > 0
				? existingMetadata.filename.trim()
				: typeof existingMetadata.originalFilename === "string" &&
						existingMetadata.originalFilename.trim().length > 0
					? existingMetadata.originalFilename.trim()
					: createDocumentNoteFilename(
							deriveDocumentTitle(options.content, "Document note"),
						);
		const fileExt =
			typeof existingMetadata.fileExt === "string" &&
			existingMetadata.fileExt.trim().length > 0
				? existingMetadata.fileExt.trim()
				: (() => {
						const stripped = stripDocumentFilenameExtension(filename);
						return stripped === filename
							? "txt"
							: filename.slice(stripped.length + 1);
					})();
		const contentType =
			typeof existingMetadata.contentType === "string" &&
			existingMetadata.contentType.trim().length > 0
				? existingMetadata.contentType.trim()
				: "text/plain";
		const updatedMetadata: DocumentMemoryMetadata = {
			...existingMetadata,
			type: MemoryType.DOCUMENT,
			documentId: options.documentId,
			source:
				typeof existingMetadata.source === "string" &&
				existingMetadata.source.trim().length > 0
					? existingMetadata.source.trim()
					: "unknown",
			filename,
			originalFilename:
				typeof existingMetadata.originalFilename === "string" &&
				existingMetadata.originalFilename.trim().length > 0
					? existingMetadata.originalFilename.trim()
					: filename,
			title:
				typeof existingMetadata.title === "string" &&
				existingMetadata.title.trim().length > 0
					? existingMetadata.title.trim()
					: deriveDocumentTitle(options.content, "Document note"),
			fileExt,
			fileType:
				typeof existingMetadata.fileType === "string" &&
				existingMetadata.fileType.trim().length > 0
					? existingMetadata.fileType.trim()
					: contentType,
			contentType,
			fileSize: Buffer.byteLength(options.content, "utf8"),
			textBacked: isTextBackedDocumentContent(contentType, filename),
			timestamp: Date.now(),
			editedAt: Date.now(),
			documentRevision: snapshot.revision + 1,
			// Fences this attempt's staged fragments: concurrent updates stage the
			// same revision number, so readers additionally match this token.
			revisionAttemptId: this.runtime.createRunId(),
		};

		const replacement: Memory = {
			id: options.documentId,
			agentId: this.runtime.agentId,
			roomId: existingDocument.roomId,
			worldId: existingDocument.worldId,
			entityId: existingDocument.entityId,
			content: { text: options.content },
			metadata: updatedMetadata,
			createdAt: existingDocument.createdAt,
		};
		const fragments = await this.splitAndCreateFragments(
			{
				id: options.documentId,
				content: { text: options.content },
				metadata: updatedMetadata,
			},
			1500,
			200,
			{
				roomId: existingDocument.roomId,
				// Original ingestion coerces fragment worldId to the agent id when the
				// parent document has none; replacement fragments must match or they
				// fall out of worldId-scoped retrieval that still sees the old ones.
				worldId: existingDocument.worldId ?? this.runtime.agentId,
				entityId: existingDocument.entityId,
			},
		);
		await this.prepareDocumentFragmentEmbeddings(fragments);
		const mutation = await this.runtime.adapter.replaceDocumentRevision({
			...requestContext,
			documentId: options.documentId,
			expected: snapshot,
			replacement,
			fragments,
		});
		if (mutation.status !== "updated") {
			throw new ElizaError("Document authorization changed before update", {
				code:
					mutation.status === "forbidden"
						? "DOCUMENT_MUTATION_FORBIDDEN"
						: mutation.status === "not_found"
							? "DOCUMENT_NOT_FOUND"
							: "DOCUMENT_MUTATION_CONFLICT",
				context: { documentId: options.documentId, status: mutation.status },
			});
		}

		return {
			documentId: options.documentId,
			fragmentCount: fragments.length,
		};
	}

	/** Stages every embedding before the atomic parent/fragment replacement. */
	private async prepareDocumentFragmentEmbeddings(
		fragments: Memory[],
	): Promise<void> {
		if (fragments.length === 0 || !hasDocumentEmbeddingModel(this.runtime))
			return;
		const batchModel = this.runtime.getModel(ModelType.TEXT_EMBEDDING_BATCH);
		if (batchModel) {
			try {
				const texts = fragments.map((fragment) => {
					if (typeof fragment.content.text !== "string") {
						throw new Error("Document fragment is missing text");
					}
					return fragment.content.text;
				});
				const vectors = await this.runtime.useModel(
					ModelType.TEXT_EMBEDDING_BATCH,
					{ texts },
				);
				if (
					!Array.isArray(vectors) ||
					vectors.length !== fragments.length ||
					vectors.some(
						(vector) => !Array.isArray(vector) || vector.length === 0,
					)
				) {
					throw new Error(
						"Batch embedding returned an incomplete fragment set",
					);
				}
				for (let index = 0; index < fragments.length; index++) {
					fragments[index].embedding = vectors[index];
				}
				return;
			} catch (error) {
				// error-policy:J4 The serial embedding provider is the documented
				// fallback, and no storage mutation has happened at this point.
				this.runtime.reportError(
					"DocumentService.stageBatchFragmentEmbedding",
					error,
					{ fragmentCount: fragments.length },
				);
			}
		}
		for (const fragment of fragments) {
			await this.runtime.addEmbeddingToMemory(fragment);
		}
	}

	async _internalAddDocument(
		item: StoredDocument,
		options = {
			targetTokens: 1500,
			overlap: 200,
			modelContextSize: 4096,
		},
		scope = {
			roomId: this.runtime.agentId,
			entityId: this.runtime.agentId,
			worldId: this.runtime.agentId,
		},
	): Promise<void> {
		const finalScope = {
			roomId: scope?.roomId,
			worldId: scope?.worldId,
			entityId: scope?.entityId,
		};

		const documentMetadata = {
			...(item.metadata ?? {}),
			type: MemoryType.DOCUMENT,
			documentId: item.id,
			source:
				typeof item.metadata?.source === "string" &&
				item.metadata.source.trim().length > 0
					? item.metadata.source.trim()
					: "unknown",
			scope: normalizeDocumentScope(
				item.metadata?.scope as AddDocumentOptions["scope"] | undefined,
			),
			scopedToEntityId:
				typeof item.metadata?.scopedToEntityId === "string"
					? item.metadata.scopedToEntityId
					: undefined,
			addedBy:
				typeof item.metadata?.addedBy === "string"
					? item.metadata.addedBy
					: finalScope.entityId,
			addedByRole:
				item.metadata?.addedByRole === "OWNER" ||
				item.metadata?.addedByRole === "ADMIN" ||
				item.metadata?.addedByRole === "USER" ||
				item.metadata?.addedByRole === "AGENT" ||
				item.metadata?.addedByRole === "RUNTIME"
					? item.metadata.addedByRole
					: "RUNTIME",
			addedFrom:
				typeof item.metadata?.addedFrom === "string" &&
				DOCUMENT_ADDED_FROM_VALUES.has(
					item.metadata.addedFrom as DocumentAddedFrom,
				)
					? (item.metadata.addedFrom as DocumentAddedFrom)
					: "runtime-internal",
			addedAt:
				typeof item.metadata?.addedAt === "number"
					? item.metadata.addedAt
					: Date.now(),
		} satisfies DocumentMemoryMetadata;

		const documentMemory: Memory = {
			id: item.id,
			agentId: this.runtime.agentId,
			roomId: finalScope.roomId,
			worldId: finalScope.worldId,
			entityId: finalScope.entityId,
			content: item.content as Content,
			metadata: documentMetadata,
			createdAt: Date.now(),
		};

		const existingDocument = await this.runtime.getMemoryById(item.id);
		if (existingDocument) {
			await this.runtime.updateMemory({
				...documentMemory,
				id: item.id,
			});
		} else {
			await this.runtime.createMemory(documentMemory, DOCUMENTS_TABLE);
		}

		const fragments = await this.splitAndCreateFragments(
			item,
			options.targetTokens,
			options.overlap,
			finalScope,
		);

		await this.processDocumentFragmentsBatched(fragments, {
			continueOnError: true,
		});
	}

	private async processDocumentFragment(fragment: Memory): Promise<void> {
		try {
			await this.runtime.addEmbeddingToMemory(fragment);

			await this.runtime.createMemory(fragment, DOCUMENT_FRAGMENTS_TABLE);
		} catch (error) {
			// error-policy:J2 Attach fragment identity while preserving the cause.
			logger.error({ error }, `Error processing fragment ${fragment.id}`);
			throw new ElizaError(
				`Failed to process document fragment ${fragment.id}`,
				{
					code: "DOCUMENT_FRAGMENT_PROCESSING_FAILED",
					context: { fragmentId: fragment.id },
					cause: error,
				},
			);
		}
	}

	/**
	 * Embed + persist a batch of document fragments.
	 *
	 * When a {@link ModelType.TEXT_EMBEDDING_BATCH} model is registered (e.g. the
	 * cloud plugin), every fragment is embedded in ONE round-trip instead of N
	 * serial single-text embeds, the returned vectors are written back IN ORDER
	 * (`fragments[i].embedding = vectors[i]`), then each fragment is persisted.
	 *
	 * The embedded text is exactly `fragment.content.text` — the same value
	 * {@link IAgentRuntime.addEmbeddingToMemory} embeds (see runtime.ts:
	 * `useModel(TEXT_EMBEDDING, { text: memory.content.text })`) — so batched and
	 * serial fragments receive byte-for-byte identical embedding input.
	 *
	 * Any batch failure (no batch model registered, the model call throwing, a
	 * returned vector count that does not match the fragment count, or an empty
	 * vector for any fragment) falls back to the existing serial per-fragment path
	 * so no fragment is left unembedded — and none is persisted with an empty
	 * embedding.
	 *
	 * @param fragments fragments to embed + persist, processed in array order.
	 * @param options.continueOnError when true, a single fragment's persist
	 *   failure is logged and skipped (matching the per-fragment try/catch at the
	 *   `_internalAddDocument` call site); when false the error propagates
	 *   (matching the `updateDocument` call site).
	 */
	private async processDocumentFragmentsBatched(
		fragments: Memory[],
		options: { continueOnError: boolean },
	): Promise<void> {
		if (fragments.length === 0) {
			return;
		}
		if (!hasDocumentEmbeddingModel(this.runtime)) {
			for (const fragment of fragments) {
				try {
					await this.runtime.createMemory(fragment, DOCUMENT_FRAGMENTS_TABLE);
				} catch (error) {
					if (!options.continueOnError) throw error;
					// error-policy:J4 Keyword-only fragment persistence reports each
					// omitted fragment while allowing explicitly partial ingestion.
					this.runtime.reportError(
						"DocumentService.persistKeywordFragment",
						error,
						{ fragmentId: fragment.id },
					);
				}
			}
			return;
		}

		// No batch model → keep the original serial behaviour unchanged.
		if (!this.runtime.getModel(ModelType.TEXT_EMBEDDING_BATCH)) {
			await this.processDocumentFragmentsSerial(fragments, options);
			return;
		}

		let vectors: number[][];
		try {
			// Text source matches addEmbeddingToMemory exactly: memory.content.text.
			// Document fragments are built from text chunks, so text is always a
			// string; surface a genuinely-malformed fragment explicitly rather than
			// silently embedding "" (the try/catch below then falls back to serial).
			const texts = fragments.map((fragment) => {
				const text = fragment.content.text;
				if (typeof text !== "string") {
					throw new Error(
						"[DocumentService] document fragment missing text; cannot batch-embed",
					);
				}
				return text;
			});
			vectors = await this.runtime.useModel(ModelType.TEXT_EMBEDDING_BATCH, {
				texts,
			});
			if (!Array.isArray(vectors) || vectors.length !== fragments.length) {
				// A count/shape mismatch can't be mapped back to fragments safely.
				throw new Error(
					`TEXT_EMBEDDING_BATCH returned ${
						Array.isArray(vectors) ? vectors.length : "a non-array"
					} vectors for ${fragments.length} fragments`,
				);
			}
			// An empty inner vector is a failed generation, not a real embedding;
			// persisting it would silently mark the fragment "embedded" with no
			// vector (a recall gap) — the same case services/embedding.ts refuses in
			// persistEmbedding. Treat it as a batch failure and fall back to serial.
			if (
				vectors.some((vector) => !Array.isArray(vector) || vector.length === 0)
			) {
				throw new Error(
					"TEXT_EMBEDDING_BATCH returned an empty vector for at least one fragment",
				);
			}
		} catch (error) {
			// error-policy:J4 Batch embedding has an explicit serial fallback;
			// report the degraded path before retrying each fragment.
			logger.warn(
				{ error },
				"[DocumentService] Batch fragment embedding failed; falling back to serial per-fragment embedding",
			);
			this.runtime.reportError(
				"DocumentService.batchFragmentEmbedding",
				error,
				{
					fragmentCount: fragments.length,
				},
			);
			await this.processDocumentFragmentsSerial(fragments, options);
			return;
		}

		// Vectors are valid + count-matched. Assign in order, then persist each.
		for (let i = 0; i < fragments.length; i++) {
			fragments[i].embedding = vectors[i];
		}

		for (const fragment of fragments) {
			try {
				await this.runtime.createMemory(fragment, DOCUMENT_FRAGMENTS_TABLE);
			} catch (error) {
				logger.error(
					{ error },
					`[DocumentService] Error persisting fragment ${fragment.id}`,
				);
				if (!options.continueOnError) {
					throw error;
				}
				// error-policy:J4 continueOnError explicitly requests partial
				// persistence; every omitted fragment is reported.
				this.runtime.reportError(
					"DocumentService.persistDocumentFragment",
					error,
					{ fragmentId: fragment.id },
				);
			}
		}
	}

	/**
	 * Serial per-fragment embed + persist path. The fallback used when no
	 * TEXT_EMBEDDING_BATCH model is registered or the batch call fails.
	 */
	private async processDocumentFragmentsSerial(
		fragments: Memory[],
		options: { continueOnError: boolean },
	): Promise<void> {
		for (const fragment of fragments) {
			try {
				await this.processDocumentFragment(fragment);
			} catch (error) {
				if (!options.continueOnError) {
					throw error;
				}
				// error-policy:J4 continueOnError explicitly requests partial
				// persistence; every omitted fragment is reported.
				logger.error(
					{ error },
					`[DocumentService] Error processing fragment ${fragment.id} during serial fallback`,
				);
				this.runtime.reportError(
					"DocumentService.processDocumentFragment",
					error,
					{ fragmentId: fragment.id },
				);
			}
		}
	}

	private async splitAndCreateFragments(
		document: StoredDocument,
		targetTokens: number,
		overlap: number,
		scope: { roomId: UUID; worldId?: UUID; entityId: UUID },
	): Promise<Memory[]> {
		if (!document.content.text) {
			return [];
		}

		const text = document.content.text;
		const chunks = await splitChunks(text, targetTokens, overlap);

		return chunks.map((chunk, index) => {
			const fragmentIdContent = `${document.id}-fragment-${index}-${Date.now()}`;
			const fragmentId = createUniqueUuid(this.runtime, fragmentIdContent);
			const fragmentMetadata: DocumentFragmentMemoryMetadata = {
				...(document.metadata || {}),
				type: MemoryType.FRAGMENT,
				documentId: document.id,
				position: index,
				timestamp: Date.now(),
			};

			return {
				id: fragmentId,
				entityId: scope.entityId,
				agentId: this.runtime.agentId,
				roomId: scope.roomId,
				worldId: scope.worldId,
				content: {
					text: chunk,
				},
				metadata: fragmentMetadata,
				createdAt: Date.now(),
			};
		});
	}

	async getMemories(params: {
		tableName: string;
		roomId?: UUID;
		count?: number;
		offset?: number;
		end?: number;
	}): Promise<Memory[]> {
		return this.runtime.getMemories({
			...params,
			agentId: this.runtime.agentId,
		});
	}

	async countMemories(params: {
		tableName: string;
		roomId?: UUID;
		unique?: boolean;
	}): Promise<number> {
		return this.runtime.countMemories({
			roomIds: params.roomId ? [params.roomId] : undefined,
			unique: params.unique ?? false,
			tableName: params.tableName,
			agentId: this.runtime.agentId,
		});
	}

	async deleteMemory(memoryId: UUID): Promise<void> {
		await this.runtime.deleteMemory(memoryId);
	}
}

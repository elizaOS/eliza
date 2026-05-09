import { existsSync, statSync } from "node:fs";
import { createUniqueUuid } from "../../entities";
import { logger } from "../../logger";
import { checkSenderRole } from "../../roles";
import {
	type Content,
	type CustomMetadata,
	type IAgentRuntime,
	type Memory,
	MemoryType,
	type Metadata,
	ModelType,
	Service,
	type UUID,
} from "../../types";
import { splitChunks } from "../../utils";
import { Semaphore } from "../../utils/prompt-batcher/shared";
import { bm25Scores, normalizeBm25Scores } from "./bm25.ts";
import { validateModelConfig } from "./config";
import { addDocumentFromFilePath, loadDocumentsFromPath } from "./docs-loader";
import {
	createDocumentMemory,
	extractTextFromDocument,
	processFragmentsSynchronously,
} from "./document-processor.ts";
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
	stripDocumentFilenameExtension,
} from "./utils.ts";

/**
 * Controls how document search combines vector and keyword scores.
 *
 * - "hybrid"  — (default) vector cosine + BM25, weighted 0.6/0.4.
 *               Falls back to "keyword" automatically when no TEXT_EMBEDDING
 *               model is registered (e.g. the cerebras runner).
 * - "vector"  — Pure vector / cosine-similarity search (original behaviour).
 * - "keyword" — Pure BM25 keyword search; does not require an embedding model.
 */
export type SearchMode = "hybrid" | "vector" | "keyword";

/** Weight given to the normalized vector score in hybrid mode. */
const HYBRID_VECTOR_WEIGHT = 0.6;
/** Weight given to the normalized BM25 score in hybrid mode. */
const HYBRID_BM25_WEIGHT = 1 - HYBRID_VECTOR_WEIGHT;
const DOCUMENTS_TABLE = "documents";
const DOCUMENT_FRAGMENTS_TABLE = "document_fragments";
const PRE_DOCUMENTS_TABLE = "knowledge";
const DOCUMENT_SCOPES = new Set<DocumentVisibilityScope>([
	"global",
	"owner-private",
	"user-private",
	"agent-private",
]);
const DOCUMENT_ADDED_FROM_VALUES = new Set<DocumentAddedFrom>([
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

function normalizeDocumentScope(
	scope: AddDocumentOptions["scope"] | undefined,
): DocumentVisibilityScope {
	return scope && DOCUMENT_SCOPES.has(scope) ? scope : "global";
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
	if (scope && DOCUMENT_SCOPES.has(scope)) return scope;
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
				itemAny?.item?.case === "path" &&
				typeof itemAny.item.value === "string"
			) {
				return itemAny.item.value;
			}
			if (
				itemAny?.item?.case === "directory" &&
				typeof itemAny.item.value === "object" &&
				itemAny.item.value !== null
			) {
				return itemAny.item.value.path || itemAny.item.value.directory || null;
			}
			if (typeof itemAny?.path === "string") return itemAny.path;
			if (typeof itemAny?.directory === "string") return itemAny.directory;
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
			logger.error({ error }, "Error loading documents on startup");
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
				logger.error({ error }, "Error loading initial documents");
			});
		}

		await service.migratePreDocumentsPartition().catch((err) => {
			logger.error({ error: err }, "Error migrating pre-documents rows");
		});

		await service.backfillDocumentScopes().catch((err) => {
			logger.error({ error: err }, "Error backfilling document scopes");
		});

		if (characterDocuments.length > 0) {
			await service
				.processCharacterDocuments(characterDocuments)
				.catch((err) => {
					logger.error({ error: err }, "Error processing character documents");
				});
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
			`Documents service stopping for agent: ${this.runtime.character?.name}`,
		);
	}

	private isDocumentMemory(memory: Memory): boolean {
		return memory.metadata?.type === MemoryType.DOCUMENT;
	}

	private isDocumentFragmentMemory(memory: Memory): boolean {
		return memory.metadata?.type === MemoryType.FRAGMENT;
	}

	private async getSenderDocumentRole(
		message?: Memory,
	): Promise<"OWNER" | "ADMIN" | "USER" | "AGENT" | "RUNTIME"> {
		if (!message?.entityId) {
			return "RUNTIME";
		}
		if (message.entityId === this.runtime.agentId) {
			return "AGENT";
		}

		const role = await checkSenderRole(this.runtime, message).catch(() => null);
		if (role?.role === "OWNER" || role?.role === "ADMIN") {
			return role.role;
		}
		return "USER";
	}

	async canAccessDocument(memory: Memory, message?: Memory): Promise<boolean> {
		if (!message?.entityId || message.entityId === this.runtime.agentId) {
			return true;
		}

		const senderRole = await this.getSenderDocumentRole(message);
		if (senderRole === "OWNER") return true;

		const metadata = (memory.metadata ?? {}) as Record<string, unknown>;
		const scope = normalizeDocumentScope(
			metadata.scope as AddDocumentOptions["scope"] | undefined,
		);

		if (scope === "global") return true;
		if (scope === "owner-private" || scope === "agent-private") return false;

		const senderId = message.entityId;
		const scopedToEntityId =
			typeof metadata.scopedToEntityId === "string"
				? metadata.scopedToEntityId
				: undefined;
		const addedBy =
			typeof metadata.addedBy === "string" ? metadata.addedBy : undefined;

		return (
			scope === "user-private" &&
			(scopedToEntityId === senderId ||
				addedBy === senderId ||
				memory.entityId === senderId)
		);
	}

	private async filterVisibleMemories(
		memories: Memory[],
		message?: Memory,
	): Promise<Memory[]> {
		const visible: Memory[] = [];
		for (const memory of memories) {
			if (await this.canAccessDocument(memory, message)) {
				visible.push(memory);
			}
		}
		return visible;
	}

	async getDocumentById(
		documentId: UUID,
		message?: Memory,
	): Promise<Memory | null> {
		const memory = await this.runtime.getMemoryById(documentId);
		if (!memory || !this.isDocumentMemory(memory)) {
			return null;
		}
		return (await this.canAccessDocument(memory, message)) ? memory : null;
	}

	async listDocuments(
		message?: Memory,
		options: {
			limit?: number;
			offset?: number;
			query?: string;
			scope?: DocumentVisibilityScope;
			scopedToEntityId?: UUID;
			addedBy?: UUID;
			timeRangeStart?: number;
			timeRangeEnd?: number;
			tags?: string[];
		} = {},
	): Promise<Memory[]> {
		const limit = Math.max(1, Math.min(options.limit ?? 25, 100));
		const offset = Math.max(0, options.offset ?? 0);
		const memories = await this.runtime.getMemories({
			tableName: DOCUMENTS_TABLE,
			agentId: this.runtime.agentId,
			count: Math.max((limit + offset) * 4, 50),
		});
		const documents = await this.filterVisibleMemories(
			memories.filter((memory) => this.isDocumentMemory(memory)),
			message,
		);
		const query = options.query?.trim().toLowerCase();
		const filtered = documents.filter((memory) => {
			const metadata = (memory.metadata ?? {}) as Record<string, unknown>;
			if (options.scope && metadata.scope !== options.scope) return false;
			if (
				options.scopedToEntityId &&
				metadata.scopedToEntityId !== options.scopedToEntityId
			) {
				return false;
			}
			if (options.addedBy && metadata.addedBy !== options.addedBy) return false;

			if (options.tags && options.tags.length > 0) {
				const docTags = Array.isArray(metadata.tags)
					? (metadata.tags as unknown[]).filter(
							(value): value is string => typeof value === "string",
						)
					: [];
				const wanted = options.tags;
				if (!wanted.every((tag) => docTags.includes(tag))) return false;
			}

			const docTimestamp =
				typeof metadata.timestamp === "number"
					? metadata.timestamp
					: typeof memory.createdAt === "number"
						? memory.createdAt
						: 0;
			if (
				typeof options.timeRangeStart === "number" &&
				docTimestamp < options.timeRangeStart
			) {
				return false;
			}
			if (
				typeof options.timeRangeEnd === "number" &&
				docTimestamp > options.timeRangeEnd
			) {
				return false;
			}

			if (query) {
				const haystack = [
					memory.content?.text,
					metadata.title,
					metadata.filename,
					metadata.originalFilename,
					metadata.source,
				]
					.filter((value): value is string => typeof value === "string")
					.join("\n")
					.toLowerCase();
				if (!haystack.includes(query)) return false;
			}

			return true;
		});
		return filtered.slice(offset, offset + limit);
	}

	async deleteDocument(documentId: UUID, message?: Memory): Promise<void> {
		const document = await this.getDocumentById(documentId, message);
		if (!document) {
			throw new Error(`Document ${documentId} not found`);
		}

		const memories = await this.runtime.getMemories({
			tableName: DOCUMENT_FRAGMENTS_TABLE,
			agentId: this.runtime.agentId,
			count: 10_000,
		});
		const relatedFragments = memories.filter((memory) => {
			const metadata = memory.metadata as Record<string, unknown> | undefined;
			return (
				this.isDocumentFragmentMemory(memory) &&
				metadata?.documentId === documentId
			);
		});

		for (const fragment of relatedFragments) {
			if (fragment.id) {
				await this.runtime.deleteMemory(fragment.id as UUID);
			}
		}
		await this.runtime.deleteMemory(documentId);
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
							addedBy: memory.entityId ?? this.runtime.agentId,
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
			addedBy: memory.entityId ?? this.runtime.agentId,
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

		const contentBasedId = generateContentBasedId(options.content, agentId, {
			includeFilename: options.originalFilename,
			contentType: options.contentType,
			maxChars: 2000,
		}) as UUID;

		logger.info(
			`Processing "${options.originalFilename}" (${options.contentType})`,
		);

		try {
			const existingDocument = await this.runtime.getMemoryById(contentBasedId);
			if (
				existingDocument &&
				(existingDocument.metadata?.type === MemoryType.DOCUMENT ||
					existingDocument.metadata?.type === MemoryType.CUSTOM)
			) {
				logger.info(`"${options.originalFilename}" already exists - skipping`);

				const fragments = await this.runtime.getMemories({
					tableName: DOCUMENT_FRAGMENTS_TABLE,
				});

				const relatedFragments = fragments.filter(
					(f) =>
						f.metadata?.type === MemoryType.FRAGMENT &&
						(f.metadata as DocumentFragmentMemoryMetadata | undefined)
							?.documentId === contentBasedId,
				);

				return {
					clientDocumentId: contentBasedId,
					storedDocumentMemoryId: existingDocument.id as UUID,
					fragmentCount: relatedFragments.length,
				};
			}
		} catch (error) {
			logger.debug(
				`Document ${contentBasedId} not found or error checking existence, proceeding with processing: ${error instanceof Error ? error.message : String(error)}`,
			);
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
			const isPdfFile =
				contentType === "application/pdf" ||
				originalFilename.toLowerCase().endsWith(".pdf");

			if (isPdfFile) {
				try {
					fileBuffer = Buffer.from(content, "base64");
				} catch (e) {
					logger.error(
						{ error: e },
						`Failed to convert base64 to buffer for ${originalFilename}`,
					);
					throw new Error(
						`Invalid base64 content for PDF file ${originalFilename}`,
					);
				}
				extractedText = await extractTextFromDocument(
					fileBuffer,
					contentType,
					originalFilename,
				);
				documentContentToStore = content;
			} else if (isBinaryContentType(contentType, originalFilename)) {
				try {
					fileBuffer = Buffer.from(content, "base64");
				} catch (e) {
					logger.error(
						{ error: e },
						`Failed to convert base64 to buffer for ${originalFilename}`,
					);
					throw new Error(
						`Invalid base64 content for binary file ${originalFilename}`,
					);
				}
				extractedText = await extractTextFromDocument(
					fileBuffer,
					contentType,
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
						logger.error(
							{ error: e instanceof Error ? e : new Error(String(e)) },
							`Failed to decode base64 for ${originalFilename}`,
						);
						throw new Error(
							`File ${originalFilename} appears to be corrupted or incorrectly encoded`,
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
					? (scopedToEntityId ?? entityId ?? agentId)
					: documentScope === "owner-private"
						? ((this.runtime.getSetting("ELIZA_ADMIN_ENTITY_ID") as
								| UUID
								| undefined) ??
							entityId ??
							agentId)
						: agentId;
			const scopedEntityId =
				documentScope === "global" ? undefined : targetEntityId;
			const scopedMetadata = {
				...metadata,
				scope: documentScope,
				scopedToEntityId: scopedEntityId,
				addedBy: addedBy ?? entityId ?? agentId,
				addedByRole: addedByRole ?? "RUNTIME",
				addedFrom: addedFrom ?? "runtime-internal",
				addedAt: Date.now(),
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
				roomId: roomId || agentId,
				entityId: targetEntityId,
			};

			await this.runtime.createMemory(memoryWithScope, DOCUMENTS_TABLE);

			const fragmentCount = await processFragmentsSynchronously({
				runtime: this.runtime,
				documentId: clientDocumentId,
				fullDocumentText: extractedText,
				agentId,
				contentType,
				roomId: roomId || agentId,
				entityId: targetEntityId,
				worldId: worldId || agentId,
				documentTitle: originalFilename,
				documentMetadata:
					(documentMemory.metadata as Record<string, unknown>) ?? undefined,
			});

			logger.debug(
				`"${originalFilename}" stored with ${fragmentCount} fragments`,
			);

			return {
				clientDocumentId,
				storedDocumentMemoryId: memoryWithScope.id as UUID,
				fragmentCount,
			};
		} catch (error) {
			logger.error({ error }, `Error processing document ${originalFilename}`);
			throw error;
		}
	}

	async checkExistingDocument(documentId: UUID): Promise<boolean> {
		const existingDocument = await this.runtime.getMemoryById(documentId);
		return !!existingDocument;
	}

	async searchDocuments(
		message: Memory,
		scope?: { roomId?: UUID; worldId?: UUID; entityId?: UUID },
		searchMode?: SearchMode,
	): Promise<StoredDocument[]> {
		if (!message?.content?.text || message?.content?.text.trim().length === 0) {
			logger.warn("Invalid or empty message content for document query");
			return [];
		}

		const queryText = message.content.text;
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

		if (effectiveMode === "keyword") {
			return this._keywordSearch(queryText, filterScope, message);
		}

		if (effectiveMode === "vector") {
			return this._vectorSearch(queryText, filterScope, message);
		}

		// hybrid: vector + BM25 combined
		return this._hybridSearch(queryText, filterScope, message);
	}

	/** Pure vector (cosine-similarity) search — original behaviour. */
	private async _vectorSearch(
		queryText: string,
		filterScope: { roomId?: UUID; worldId?: UUID; entityId?: UUID },
		message?: Memory,
	): Promise<StoredDocument[]> {
		const embedding = await this.runtime.useModel(ModelType.TEXT_EMBEDDING, {
			text: queryText,
		});

		const fragments = await this.runtime.searchMemories({
			tableName: DOCUMENT_FRAGMENTS_TABLE,
			embedding,
			query: queryText,
			...filterScope,
			limit: 20,
			match_threshold: 0.1,
		});

		const visibleFragments = await this.filterVisibleMemories(
			fragments.filter((fragment) => this.isDocumentFragmentMemory(fragment)),
			message,
		);

		return visibleFragments
			.filter((fragment) => fragment.id !== undefined)
			.map((fragment) => ({
				id: fragment.id as UUID,
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
		message?: Memory,
	): Promise<StoredDocument[]> {
		const allFragments = await this.runtime.getMemories({
			tableName: DOCUMENT_FRAGMENTS_TABLE,
			agentId: this.runtime.agentId,
			...filterScope,
			count: 1000,
		});

		const visibleFragments = await this.filterVisibleMemories(
			allFragments.filter((fragment) =>
				this.isDocumentFragmentMemory(fragment),
			),
			message,
		);
		const valid = visibleFragments.filter(
			(f) => f.id !== undefined && f.content?.text,
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
				content: fragment.content as Content,
				similarity: scoreMap.get(fragment.id as string) ?? 0,
				metadata: fragment.metadata,
				worldId: fragment.worldId,
			}))
			.filter((item) => item.similarity > 0)
			.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0))
			.slice(0, 20) as StoredDocument[];
	}

	/**
	 * Hybrid search: vector top-K re-ranked with BM25, combined as
	 *   score = 0.6 * normalised_vector + 0.4 * normalised_bm25
	 */
	private async _hybridSearch(
		queryText: string,
		filterScope: { roomId?: UUID; worldId?: UUID; entityId?: UUID },
		message?: Memory,
	): Promise<StoredDocument[]> {
		const embedding = await this.runtime.useModel(ModelType.TEXT_EMBEDDING, {
			text: queryText,
		});

		// Fetch a larger candidate set so BM25 can re-rank meaningfully
		const candidates = await this.runtime.searchMemories({
			tableName: DOCUMENT_FRAGMENTS_TABLE,
			embedding,
			query: queryText,
			...filterScope,
			limit: 40,
			match_threshold: 0.05,
		});

		const visibleCandidates = await this.filterVisibleMemories(
			candidates.filter((fragment) => this.isDocumentFragmentMemory(fragment)),
			message,
		);
		const valid = visibleCandidates.filter(
			(f) => f.id !== undefined && f.content?.text,
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
					content: fragment.content as Content,
					similarity: combined,
					metadata: fragment.metadata,
					worldId: fragment.worldId,
				};
			})
			.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0))
			.slice(0, 20) as StoredDocument[];
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
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			logger.warn(
				`Failed to enrich conversation memory ${memoryId} with RAG data: ${errorMessage}`,
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
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			logger.warn(
				`Error enriching recent memories with RAG data: ${errorMessage}`,
			);
		}
	}

	async processCharacterDocuments(items: string[]): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, 1000));
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
					{
						maxChars: 2000,
						includeFilename: filename,
					},
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
			} catch (error) {
				logger.error({ error }, "Error processing character documents");
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
	}): Promise<{
		documentId: UUID;
		fragmentCount: number;
	}> {
		const existingDocument = await this.getDocumentById(
			options.documentId,
			options.message,
		);
		if (!existingDocument) {
			throw new Error(`Document ${options.documentId} not found`);
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
		};

		await this.runtime.updateMemory({
			id: options.documentId,
			agentId: this.runtime.agentId,
			roomId: existingDocument.roomId,
			worldId: existingDocument.worldId,
			entityId: existingDocument.entityId,
			content: { text: options.content },
			metadata: updatedMetadata,
			createdAt: existingDocument.createdAt,
		});

		const existingFragments = await this.runtime.getMemories({
			tableName: DOCUMENT_FRAGMENTS_TABLE,
			agentId: this.runtime.agentId,
			roomId: existingDocument.roomId,
			count: 10_000,
		});
		const relatedFragments = existingFragments.filter((fragment) => {
			const metadata = fragment.metadata as Record<string, unknown> | undefined;
			return (
				this.isDocumentFragmentMemory(fragment) &&
				metadata?.documentId === options.documentId
			);
		});

		for (const fragment of relatedFragments) {
			if (typeof fragment.id === "string") {
				await this.runtime.deleteMemory(fragment.id as UUID);
			}
		}

		const fragments = await this.splitAndCreateFragments(
			{
				id: options.documentId,
				content: { text: options.content },
				metadata: updatedMetadata,
			},
			1500,
			200,
			{
				roomId: existingDocument.roomId ?? this.runtime.agentId,
				worldId: existingDocument.worldId ?? this.runtime.agentId,
				entityId: existingDocument.entityId ?? this.runtime.agentId,
			},
		);

		for (const fragment of fragments) {
			await this.processDocumentFragment(fragment);
		}

		return {
			documentId: options.documentId,
			fragmentCount: fragments.length,
		};
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
			roomId: scope?.roomId ?? this.runtime.agentId,
			worldId: scope?.worldId ?? this.runtime.agentId,
			entityId: scope?.entityId ?? this.runtime.agentId,
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
			content: item.content as unknown as Content,
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

		for (const fragment of fragments) {
			try {
				await this.processDocumentFragment(fragment);
			} catch (error) {
				logger.error(
					{ error },
					`DocumentService: Error processing fragment ${fragment.id} for document ${item.id}`,
				);
			}
		}
	}

	private async processDocumentFragment(fragment: Memory): Promise<void> {
		try {
			await this.runtime.addEmbeddingToMemory(fragment);

			await this.runtime.createMemory(fragment, DOCUMENT_FRAGMENTS_TABLE);
		} catch (error) {
			logger.error({ error }, `Error processing fragment ${fragment.id}`);
			throw error;
		}
	}

	private async splitAndCreateFragments(
		document: StoredDocument,
		targetTokens: number,
		overlap: number,
		scope: { roomId: UUID; worldId: UUID; entityId: UUID },
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

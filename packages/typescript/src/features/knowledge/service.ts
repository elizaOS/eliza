import { existsSync, statSync } from "node:fs";
import { createUniqueUuid } from "../../entities";
import { logger } from "../../logger";
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
import { validateModelConfig } from "./config";
import { addKnowledgeFromFilePath, loadDocsFromPath } from "./docs-loader";
import {
	createDocumentMemory,
	extractTextFromDocument,
	processFragmentsSynchronously,
} from "./document-processor.ts";
import type {
	KnowledgeConfig,
	KnowledgeDocumentMemoryMetadata,
	KnowledgeFragmentMemoryMetadata,
	LoadResult,
	StoredKnowledgeItem,
} from "./types";
import type { AddKnowledgeOptions } from "./types.ts";
import {
	createKnowledgeNoteFilename,
	deriveKnowledgeTitle,
	generateContentBasedId,
	isBinaryContentType,
	isTextBackedKnowledgeContent,
	looksLikeBase64,
	stripKnowledgeFilenameExtension,
} from "./utils.ts";

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

export class KnowledgeService extends Service {
	static readonly serviceType = "knowledge";
	public override config: Metadata = {};
	capabilityDescription =
		"Provides Retrieval Augmented Generation capabilities, including knowledge upload and querying.";

	private knowledgeProcessingSemaphore: Semaphore;

	constructor(runtime?: IAgentRuntime, _config?: Partial<KnowledgeConfig>) {
		super(runtime);
		this.knowledgeProcessingSemaphore = new Semaphore(10);
	}

	private async loadInitialDocuments(): Promise<void> {
		logger.info(
			`Loading documents on startup for agent ${this.runtime.agentId}`,
		);
		try {
			await new Promise((resolve) => setTimeout(resolve, 1000));

			const knowledgePathSetting = this.runtime.getSetting("KNOWLEDGE_PATH");
			const knowledgePath =
				typeof knowledgePathSetting === "string"
					? knowledgePathSetting
					: undefined;

			const result: LoadResult = await loadDocsFromPath(
				this as KnowledgeService,
				this.runtime.agentId,
				undefined,
				knowledgePath,
			);

			if (result.successful > 0) {
				logger.info(`Loaded ${result.successful} documents on startup`);
			}
		} catch (error) {
			logger.error({ error }, "Error loading documents on startup");
		}
	}

	static async start(runtime: IAgentRuntime): Promise<KnowledgeService> {
		logger.info(`Starting Knowledge service for agent: ${runtime.agentId}`);

		const validatedConfig = validateModelConfig(runtime);
		const ctxEnabled = validatedConfig.CTX_KNOWLEDGE_ENABLED;
		const knowledgePathSetting = runtime.getSetting("KNOWLEDGE_PATH");
		const hasConfiguredKnowledge =
			validatedConfig.LOAD_DOCS_ON_STARTUP ||
			(typeof knowledgePathSetting === "string" &&
				knowledgePathSetting.trim().length > 0) ||
			(runtime.character?.knowledge?.length ?? 0) > 0;

		if (ctxEnabled) {
			logger.info(
				`Contextual knowledge enabled: ${describeEmbeddingConfig(validatedConfig)}, ${validatedConfig.TEXT_PROVIDER} text generation`,
			);
			logger.info(`Text model: ${validatedConfig.TEXT_MODEL}`);
		} else if (hasConfiguredKnowledge) {
			logger.debug(
				`Knowledge service running in embedding-only mode with ${describeEmbeddingConfig(validatedConfig)}`,
			);
			logger.debug(
				"To enable contextual enrichment: Set CTX_KNOWLEDGE_ENABLED=true and configure TEXT_PROVIDER/TEXT_MODEL",
			);
		}

		const service = new KnowledgeService(runtime);
		service.config = validatedConfig;

		if (service.config.LOAD_DOCS_ON_STARTUP) {
			service.loadInitialDocuments().catch((error) => {
				logger.error({ error }, "Error loading initial documents");
			});
		}

		if (
			service.runtime.character?.knowledge &&
			service.runtime.character.knowledge.length > 0
		) {
			const stringKnowledge = service.runtime.character.knowledge
				.map((item) => {
					const itemAny = item as {
						item?: {
							case?: string;
							value?:
								| string
								| {
										path?: string;
										directory?: string;
								  };
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
						return (
							itemAny.item.value.path || itemAny.item.value.directory || null
						);
					}
					if (typeof itemAny?.path === "string") {
						return itemAny.path;
					}
					if (typeof itemAny?.directory === "string") {
						return itemAny.directory;
					}
					if (typeof item === "string") {
						return item;
					}
					return null;
				})
				.filter((item): item is string => item !== null);
			await service.processCharacterKnowledge(stringKnowledge).catch((err) => {
				logger.error({ error: err }, "Error processing character knowledge");
			});
		}

		return service;
	}

	static async stop(runtime: IAgentRuntime): Promise<void> {
		logger.info(`Stopping Knowledge service for agent: ${runtime.agentId}`);
		const service = runtime.getService(KnowledgeService.serviceType);
		if (!service) {
			logger.warn(
				`KnowledgeService not found for agent ${runtime.agentId} during stop.`,
			);
		}
		if (service instanceof KnowledgeService) {
			await service.stop();
		}
	}

	async stop(): Promise<void> {
		logger.info(
			`Knowledge service stopping for agent: ${this.runtime.character?.name}`,
		);
	}

	async addKnowledge(options: AddKnowledgeOptions): Promise<{
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
					tableName: "knowledge",
				});

				const relatedFragments = fragments.filter(
					(f) =>
						f.metadata?.type === MemoryType.FRAGMENT &&
						(f.metadata as KnowledgeFragmentMemoryMetadata | undefined)
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
		metadata,
	}: AddKnowledgeOptions): Promise<{
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
				customMetadata: metadata,
			});

			const memoryWithScope = {
				...documentMemory,
				id: clientDocumentId,
				agentId: agentId,
				roomId: roomId || agentId,
				entityId: entityId || agentId,
			};

			await this.runtime.createMemory(memoryWithScope, "documents");

			const fragmentCount = await processFragmentsSynchronously({
				runtime: this.runtime,
				documentId: clientDocumentId,
				fullDocumentText: extractedText,
				agentId,
				contentType,
				roomId: roomId || agentId,
				entityId: entityId || agentId,
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

	async checkExistingKnowledge(knowledgeId: UUID): Promise<boolean> {
		const existingDocument = await this.runtime.getMemoryById(knowledgeId);
		return !!existingDocument;
	}

	async getKnowledge(
		message: Memory,
		scope?: { roomId?: UUID; worldId?: UUID; entityId?: UUID },
	): Promise<StoredKnowledgeItem[]> {
		if (!message?.content?.text || message?.content?.text.trim().length === 0) {
			logger.warn("Invalid or empty message content for knowledge query");
			return [];
		}

		const embedding = await this.runtime.useModel(ModelType.TEXT_EMBEDDING, {
			text: message.content.text,
		});

		const filterScope: { roomId?: UUID; worldId?: UUID; entityId?: UUID } = {};
		if (scope?.roomId) filterScope.roomId = scope.roomId;
		if (scope?.worldId) filterScope.worldId = scope.worldId;
		if (scope?.entityId) filterScope.entityId = scope.entityId;

		const fragments = await this.runtime.searchMemories({
			tableName: "knowledge",
			embedding,
			query: message.content.text,
			...filterScope,
			limit: 20,
			match_threshold: 0.1,
		});

		return fragments
			.filter((fragment) => fragment.id !== undefined)
			.map((fragment) => ({
				id: fragment.id as UUID,
				content: fragment.content as Content,
				similarity: fragment.similarity,
				metadata: fragment.metadata,
				worldId: fragment.worldId,
			})) as StoredKnowledgeItem[];
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
				knowledgeUsed: true,
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

	async processCharacterKnowledge(items: string[]): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, 1000));
		logger.info(`Processing ${items.length} character knowledge items`);

		const processingPromises = items.map(async (item) => {
			await this.knowledgeProcessingSemaphore.acquire();
			try {
				const trimmedItem = item.trim();
				if (trimmedItem.length === 0) {
					return;
				}

				if (existsSync(trimmedItem) && statSync(trimmedItem).isDirectory()) {
					await loadDocsFromPath(
						this,
						this.runtime.agentId as UUID,
						this.runtime.agentId as UUID,
						trimmedItem,
						{
							roomId: this.runtime.agentId as UUID,
							entityId: this.runtime.agentId as UUID,
							metadata: {
								source: "character",
								characterKnowledgeDirectory: trimmedItem,
							},
						},
					);
					return;
				}

				if (existsSync(trimmedItem) && statSync(trimmedItem).isFile()) {
					await addKnowledgeFromFilePath({
						service: this,
						agentId: this.runtime.agentId as UUID,
						worldId: this.runtime.agentId as UUID,
						roomId: this.runtime.agentId as UUID,
						entityId: this.runtime.agentId as UUID,
						filePath: trimmedItem,
						metadata: {
							source: "character",
							characterKnowledgePath: trimmedItem,
						},
					});
					return;
				}

				const title = deriveKnowledgeTitle(trimmedItem, "Character knowledge");
				const filename = createKnowledgeNoteFilename(title);
				const knowledgeId = generateContentBasedId(
					trimmedItem,
					this.runtime.agentId,
					{
						maxChars: 2000,
						includeFilename: filename,
					},
				) as UUID;

				if (await this.checkExistingKnowledge(knowledgeId)) {
					return;
				}

				await this._internalAddKnowledge(
					{
						id: knowledgeId,
						content: {
							text: trimmedItem,
						} as Content,
						metadata: {
							type: MemoryType.DOCUMENT,
							documentId: knowledgeId,
							timestamp: Date.now(),
							source: "character",
							title,
							filename,
							originalFilename: filename,
							fileExt: "txt",
							fileType: "text/plain",
							contentType: "text/plain",
							fileSize: Buffer.byteLength(trimmedItem, "utf8"),
							textBacked: true,
						} satisfies KnowledgeDocumentMemoryMetadata,
					},
					undefined,
					{
						roomId: this.runtime.agentId,
						entityId: this.runtime.agentId,
						worldId: this.runtime.agentId,
					},
				);
			} catch (error) {
				logger.error({ error }, "Error processing character knowledge");
			} finally {
				this.knowledgeProcessingSemaphore.release();
			}
		});

		await Promise.all(processingPromises);
	}

	async updateKnowledgeDocument(options: {
		documentId: UUID;
		content: string;
	}): Promise<{
		documentId: UUID;
		fragmentCount: number;
	}> {
		const existingDocument = await this.runtime.getMemoryById(
			options.documentId,
		);
		if (!existingDocument) {
			throw new Error(`Knowledge document ${options.documentId} not found`);
		}

		const existingMetadata = (existingDocument.metadata ??
			{}) as KnowledgeDocumentMemoryMetadata;
		const filename =
			typeof existingMetadata.filename === "string" &&
			existingMetadata.filename.trim().length > 0
				? existingMetadata.filename.trim()
				: typeof existingMetadata.originalFilename === "string" &&
						existingMetadata.originalFilename.trim().length > 0
					? existingMetadata.originalFilename.trim()
					: createKnowledgeNoteFilename(
							deriveKnowledgeTitle(options.content, "Knowledge note"),
						);
		const fileExt =
			typeof existingMetadata.fileExt === "string" &&
			existingMetadata.fileExt.trim().length > 0
				? existingMetadata.fileExt.trim()
				: (() => {
						const stripped = stripKnowledgeFilenameExtension(filename);
						return stripped === filename
							? "txt"
							: filename.slice(stripped.length + 1);
					})();
		const contentType =
			typeof existingMetadata.contentType === "string" &&
			existingMetadata.contentType.trim().length > 0
				? existingMetadata.contentType.trim()
				: "text/plain";
		const updatedMetadata: KnowledgeDocumentMemoryMetadata = {
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
					: deriveKnowledgeTitle(options.content, "Knowledge note"),
			fileExt,
			fileType:
				typeof existingMetadata.fileType === "string" &&
				existingMetadata.fileType.trim().length > 0
					? existingMetadata.fileType.trim()
					: contentType,
			contentType,
			fileSize: Buffer.byteLength(options.content, "utf8"),
			textBacked: isTextBackedKnowledgeContent(contentType, filename),
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
			tableName: "knowledge",
			agentId: this.runtime.agentId,
			roomId: existingDocument.roomId,
			limit: 10_000,
		});
		const relatedFragments = existingFragments.filter((fragment) => {
			const metadata = fragment.metadata as Record<string, unknown> | undefined;
			return metadata?.documentId === options.documentId;
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

	async _internalAddKnowledge(
		item: StoredKnowledgeItem,
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
		} satisfies KnowledgeDocumentMemoryMetadata;

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
			await this.runtime.createMemory(documentMemory, "documents");
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
					`KnowledgeService: Error processing fragment ${fragment.id} for document ${item.id}`,
				);
			}
		}
	}

	private async processDocumentFragment(fragment: Memory): Promise<void> {
		try {
			await this.runtime.addEmbeddingToMemory(fragment);

			await this.runtime.createMemory(fragment, "knowledge");
		} catch (error) {
			logger.error({ error }, `Error processing fragment ${fragment.id}`);
			throw error;
		}
	}

	private async splitAndCreateFragments(
		document: StoredKnowledgeItem,
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
			const fragmentMetadata: KnowledgeFragmentMemoryMetadata = {
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

/**
 * Core ingestion pipeline for the documents capability: turns raw document text
 * into stored FRAGMENT memories. `processFragmentsSynchronously`
 * splits text into overlapping token-sized chunks, optionally contextualizes
 * each chunk through an LLM (the contextual-retrieval step, gated by
 * CTX_DOCUMENTS_ENABLED), generates embeddings when a model is registered, and
 * persists each generic fragment with `runtime.createMemory`. Without an
 * embedding model it persists unembedded fragments for the service's supported
 * BM25 keyword path. Producer-owned pre-chunked fragments retain verbatim
 * metadata and are fully validated before their caller's atomic batch write.
 * A token/request rate limiter derived from
 * {@link getProviderRateLimits} throttles generic ingestion, and 429s are
 * retried. Also exposes text extraction and parent-memory construction.
 */
import type { Buffer } from "node:buffer";
import { v4 as uuidv4 } from "uuid";
import { ElizaError } from "../../errors";
import { logger } from "../../logger";
import {
	type IAgentRuntime,
	type Memory,
	MemoryType,
	ModelType,
	type UUID,
} from "../../types";
import { splitChunks } from "../../utils";
import { BatchProcessor } from "../../utils/batch-queue";
import { getProviderRateLimits, validateModelConfig } from "./config.ts";
import {
	DEFAULT_CHUNK_OVERLAP_TOKENS,
	DEFAULT_CHUNK_TOKEN_SIZE,
	getCachingContextualizationPrompt,
	getCachingPromptForMimeType,
	getChunkWithContext,
	getContextualizationPrompt,
	getPromptForMimeType,
} from "./ctx-embeddings.ts";
import { generateText } from "./llm.ts";
import type {
	DocumentFragmentMemoryMetadata,
	DocumentMemoryMetadata,
	ModelConfig,
	PreChunkedFragmentInput,
} from "./types.ts";
import {
	convertPdfToTextFromBuffer,
	extractTextFromFileBuffer,
} from "./utils.ts";

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function getCtxDocumentsEnabled(runtime?: IAgentRuntime): boolean {
	let result: boolean;
	let _source: string;
	let rawValue: string | undefined;

	if (runtime) {
		const settingValue = runtime.getSetting("CTX_DOCUMENTS_ENABLED");
		rawValue =
			typeof settingValue === "string"
				? settingValue
				: settingValue?.toString();
		const cleanValue = rawValue?.trim().toLowerCase();
		result = cleanValue === "true";
	} else {
		rawValue = process.env.CTX_DOCUMENTS_ENABLED;
		const cleanValue = rawValue?.toString().trim().toLowerCase();
		result = cleanValue === "true";
	}

	return result;
}

function shouldUseCustomLLM(config: ModelConfig): boolean {
	const textProvider = config.TEXT_PROVIDER;
	const textModel = config.TEXT_MODEL;

	if (!textProvider || !textModel) {
		return false;
	}

	// config values are validated strings; guard toLowerCase to string-only
	// so non-string can never throw (see #19147 P1). Blank/whitespace and
	// model-gateway transformations are already resolved by validateModelConfig.
	const normalizedProvider =
		typeof textProvider === "string" ? textProvider.toLowerCase() : "";

	switch (normalizedProvider) {
		case "openrouter":
			return !!config.OPENROUTER_API_KEY;
		case "openai":
			return !!config.OPENAI_API_KEY;
		case "anthropic":
			return !!config.ANTHROPIC_API_KEY;
		case "google":
			return !!config.GOOGLE_API_KEY;
		default:
			return false;
	}
}

/** Whether vector enrichment is available for newly ingested documents. */
export function hasDocumentEmbeddingModel(runtime: IAgentRuntime): boolean {
	return Boolean(
		runtime.getModel(ModelType.TEXT_EMBEDDING) ||
			runtime.getModel(ModelType.TEXT_EMBEDDING_BATCH),
	);
}

async function persistKeywordOnlyFragments(args: {
	runtime: IAgentRuntime;
	documentId: UUID;
	chunks: string[];
	agentId: UUID;
	roomId?: UUID;
	entityId?: UUID;
	worldId?: UUID;
	documentTitle?: string;
	documentMetadata?: Record<string, unknown>;
}): Promise<number> {
	let savedCount = 0;
	for (let position = 0; position < args.chunks.length; position++) {
		const text = args.runtime.redactSecrets(args.chunks[position] ?? "");
		const source =
			typeof args.documentMetadata?.source === "string"
				? args.documentMetadata.source
				: "upload";
		const metadata: DocumentFragmentMemoryMetadata = {
			...(args.documentMetadata ?? {}),
			type: MemoryType.FRAGMENT,
			documentId: args.documentId,
			position,
			timestamp: Date.now(),
			source,
			documentTitle: args.documentTitle,
		};
		const memory: Memory = {
			id: uuidv4() as UUID,
			agentId: args.agentId,
			roomId: args.roomId ?? args.agentId,
			entityId: args.entityId ?? args.agentId,
			worldId: args.worldId ?? args.agentId,
			content: { text },
			metadata,
		};
		try {
			await args.runtime.createMemory(memory, "document_fragments");
			savedCount++;
		} catch (error) {
			// error-policy:J4 Keyword-only ingestion returns the exact persisted
			// count and reports every omitted fragment instead of inventing success.
			args.runtime.reportError(
				"DocumentProcessor.persistKeywordFragment",
				error,
				{ documentId: args.documentId, position },
			);
		}
	}
	return savedCount;
}

export async function processFragmentsSynchronously({
	runtime,
	documentId,
	fullDocumentText,
	agentId,
	contentType,
	roomId,
	entityId,
	worldId,
	documentTitle,
	documentMetadata,
}: {
	runtime: IAgentRuntime;
	documentId: UUID;
	fullDocumentText: string;
	agentId: UUID;
	contentType?: string;
	roomId?: UUID;
	entityId?: UUID;
	worldId?: UUID;
	documentTitle?: string;
	documentMetadata?: Record<string, unknown>;
}): Promise<number> {
	if (!fullDocumentText || fullDocumentText.trim() === "") {
		logger.warn(`No text content available for document ${documentId}`);
		return 0;
	}

	const chunks = await splitDocumentIntoChunks(fullDocumentText);

	if (chunks.length === 0) {
		logger.warn(`No chunks generated for document ${documentId}`);
		return 0;
	}

	logger.info(`Split into ${chunks.length} chunks`);

	if (!hasDocumentEmbeddingModel(runtime)) {
		logger.debug(
			`No document embedding model registered; persisting ${chunks.length} keyword-searchable fragment(s)`,
		);
		return persistKeywordOnlyFragments({
			runtime,
			documentId,
			chunks,
			agentId,
			roomId,
			entityId,
			worldId,
			documentTitle,
			documentMetadata,
		});
	}

	const providerLimits = await getProviderRateLimits(runtime);
	const CONCURRENCY_LIMIT = providerLimits.maxConcurrentRequests || 30;
	const rateLimiter = createRateLimiter(
		providerLimits.requestsPerMinute || 60,
		providerLimits.tokensPerMinute,
		providerLimits.rateLimitEnabled,
	);

	const { savedCount, failedCount } = await processAndSaveFragments({
		runtime,
		documentId,
		chunks,
		fullDocumentText,
		contentType,
		agentId,
		// service.ts's addDocument (this function's only caller) already
		// validates worldId/roomId/entityId via requireDocumentScopeUuid, so
		// each argument here is always a real UUID and || vs ?? is moot.
		roomId: roomId || agentId,
		entityId: entityId || agentId,
		worldId: worldId ?? agentId,
		concurrencyLimit: CONCURRENCY_LIMIT,
		rateLimiter,
		documentTitle,
		documentMetadata,
		batchDelayMs: providerLimits.batchDelayMs,
	});

	if (failedCount > 0) {
		logger.warn(`${failedCount}/${chunks.length} chunks failed processing`);
	}

	return savedCount;
}

export async function extractTextFromDocument(
	fileBuffer: Buffer,
	contentType: string,
	originalFilename: string,
): Promise<string> {
	if (!fileBuffer || fileBuffer.length === 0) {
		throw new Error(`Empty file buffer provided for ${originalFilename}`);
	}

	try {
		if (contentType === "application/pdf") {
			logger.debug(`Extracting text from PDF: ${originalFilename}`);
			return convertPdfToTextFromBuffer(fileBuffer, originalFilename);
		} else {
			if (
				contentType.includes("text/") ||
				contentType.includes("application/json") ||
				contentType.includes("application/xml")
			) {
				return fileBuffer.toString("utf8");
			}

			return extractTextFromFileBuffer(
				fileBuffer,
				contentType,
				originalFilename,
			);
		}
	} catch (error) {
		// error-policy:J2 Add document identity while preserving the extraction cause.
		const errorMessage = error instanceof Error ? error.message : String(error);
		logger.error(
			`Error extracting text from ${originalFilename}: ${errorMessage}`,
		);
		throw new ElizaError(
			`Failed to extract text from ${originalFilename}: ${errorMessage}`,
			{
				code: "DOCUMENT_TEXT_EXTRACTION_FAILED",
				context: { originalFilename, contentType },
				cause: error,
			},
		);
	}
}

export function createDocumentMemory({
	text,
	agentId,
	clientDocumentId,
	originalFilename,
	contentType,
	worldId,
	fileSize,
	documentId,
	customMetadata,
}: {
	text: string;
	agentId: UUID;
	clientDocumentId: UUID;
	originalFilename: string;
	contentType: string;
	worldId: UUID;
	fileSize: number;
	documentId?: UUID;
	customMetadata?: Record<string, unknown>;
}): Memory {
	const fileExt = originalFilename.split(".").pop()?.toLowerCase() || "";
	const title = originalFilename.replace(`.${fileExt}`, "");
	const docId = documentId || (uuidv4() as UUID);
	const metadata: DocumentMemoryMetadata = {
		type: MemoryType.DOCUMENT,
		documentId: clientDocumentId,
		filename: originalFilename,
		originalFilename,
		contentType,
		fileType: contentType,
		title,
		fileExt,
		fileSize,
		source: "upload",
		textBacked: false,
		timestamp: Date.now(),
		...(customMetadata || {}),
	};

	return {
		id: docId,
		agentId,
		roomId: agentId,
		worldId,
		entityId: agentId,
		content: { text },
		metadata,
	};
}

async function splitDocumentIntoChunks(
	documentText: string,
): Promise<string[]> {
	const tokenChunkSize = DEFAULT_CHUNK_TOKEN_SIZE;
	const tokenChunkOverlap = DEFAULT_CHUNK_OVERLAP_TOKENS;

	return splitChunks(documentText, tokenChunkSize, tokenChunkOverlap);
}

/**
 * Validate and embed producer-owned fragments before any document row is
 * written. Contextual retrieval is intentionally bypassed: changing fragment
 * text would invalidate its segment/time anchors.
 */
export async function preparePreChunkedFragmentMemories({
	runtime,
	documentId,
	fragments,
	agentId,
	roomId,
	entityId,
	worldId,
	documentTitle,
	documentMetadata,
}: {
	runtime: IAgentRuntime;
	documentId: UUID;
	fragments: PreChunkedFragmentInput[];
	agentId: UUID;
	roomId: UUID;
	entityId: UUID;
	worldId: UUID;
	documentTitle?: string;
	documentMetadata?: Record<string, unknown>;
}): Promise<Memory[]> {
	if (fragments.length === 0) {
		throw new ElizaError("Pre-chunked document fragments must be non-empty", {
			code: "DOCUMENT_FRAGMENTS_EMPTY",
			context: { documentId },
		});
	}

	let previousEndMs = 0;
	const seenSegmentIds = new Set<string>();
	const prepared: Memory[] = [];
	for (let position = 0; position < fragments.length; position++) {
		const fragment = fragments[position];
		const metadata = fragment.metadata ?? {};
		const startMs = metadata.startMs;
		const endMs = metadata.endMs;
		const segmentIds = metadata.segmentIds;
		if (!fragment.text.trim()) {
			throw new ElizaError("Pre-chunked document fragment has empty text", {
				code: "DOCUMENT_FRAGMENT_EMPTY_TEXT",
				context: { documentId, position },
			});
		}
		if (
			typeof startMs !== "number" ||
			!Number.isFinite(startMs) ||
			typeof endMs !== "number" ||
			!Number.isFinite(endMs) ||
			startMs < 0 ||
			endMs < startMs ||
			startMs < previousEndMs
		) {
			throw new ElizaError(
				"Pre-chunked document fragment has invalid anchors",
				{
					code: "DOCUMENT_FRAGMENT_INVALID_ANCHOR",
					context: { documentId, position, startMs, endMs, previousEndMs },
				},
			);
		}
		if (
			!Array.isArray(segmentIds) ||
			segmentIds.length === 0 ||
			segmentIds.some((id) => typeof id !== "string" || !id)
		) {
			throw new ElizaError(
				"Pre-chunked document fragment has invalid segment ids",
				{
					code: "DOCUMENT_FRAGMENT_INVALID_SEGMENT_IDS",
					context: { documentId, position },
				},
			);
		}
		for (const segmentId of segmentIds as string[]) {
			if (seenSegmentIds.has(segmentId)) {
				throw new ElizaError(
					"Pre-chunked document fragment repeats a segment id",
					{
						code: "DOCUMENT_FRAGMENT_DUPLICATE_SEGMENT_ID",
						context: { documentId, position, segmentId },
					},
				);
			}
			seenSegmentIds.add(segmentId);
		}

		const fragmentSource =
			typeof documentMetadata?.source === "string"
				? documentMetadata.source
				: "upload";
		const fragmentMemoryMetadata: DocumentFragmentMemoryMetadata = {
			...(documentMetadata ?? {}),
			...metadata,
			type: MemoryType.FRAGMENT,
			documentId,
			position,
			timestamp: Date.now(),
			source: fragmentSource,
			documentTitle,
		};
		const memory: Memory = {
			id: uuidv4() as UUID,
			agentId,
			roomId,
			entityId,
			worldId,
			content: { text: runtime.redactSecrets(fragment.text) },
			metadata: fragmentMemoryMetadata,
			unique: false,
		};
		if (hasDocumentEmbeddingModel(runtime)) {
			try {
				await runtime.addEmbeddingToMemory(memory);
			} catch (error) {
				// error-policy:J2 addEmbeddingToMemory rejects unusable provider
				// output itself (#18900), and its error identifies only a memory
				// id. Ingestion is per-document, so re-throw with the document and
				// fragment position this failure belongs to and keep the provider
				// error as `cause`. Without this the caller sees a bare
				// EMBEDDING_MODEL_OUTPUT_INVALID and cannot say which document or
				// which fragment refused to embed.
				throw new ElizaError(
					"Pre-chunked document fragment embedding is unavailable",
					{
						code: "DOCUMENT_FRAGMENT_EMBED_FAILED",
						context: { documentId, position },
						cause: error,
					},
				);
			}
			// Still reachable when the runtime skips generation instead of
			// throwing (no provider survived the dimension probe), which returns
			// the memory unchanged rather than rejecting.
			if (!memory.embedding || memory.embedding.length === 0) {
				throw new ElizaError(
					"Pre-chunked document fragment embedding is unavailable",
					{
						code: "DOCUMENT_FRAGMENT_EMBED_FAILED",
						context: { documentId, position },
					},
				);
			}
		}
		prepared.push(memory);
		previousEndMs = endMs;
	}

	return prepared;
}

async function processAndSaveFragments({
	runtime,
	documentId,
	chunks,
	fullDocumentText,
	contentType,
	agentId,
	roomId,
	entityId,
	worldId,
	concurrencyLimit,
	rateLimiter,
	documentTitle,
	documentMetadata,
	batchDelayMs = 500,
}: {
	runtime: IAgentRuntime;
	documentId: UUID;
	chunks: string[];
	fullDocumentText: string;
	contentType?: string;
	agentId: UUID;
	roomId?: UUID;
	entityId?: UUID;
	worldId?: UUID;
	concurrencyLimit: number;
	rateLimiter: (estimatedTokens?: number) => Promise<void>;
	documentTitle?: string;
	documentMetadata?: Record<string, unknown>;
	batchDelayMs?: number;
}): Promise<{
	savedCount: number;
	failedCount: number;
	failedChunks: number[];
}> {
	let savedCount = 0;
	let failedCount = 0;
	const failedChunks: number[] = [];

	for (let i = 0; i < chunks.length; i += concurrencyLimit) {
		const batchChunks = chunks.slice(i, i + concurrencyLimit);
		const batchOriginalIndices = Array.from(
			{ length: batchChunks.length },
			(_, k) => i + k,
		);

		const contextualizedChunks = await getContextualizedChunks(
			runtime,
			fullDocumentText,
			batchChunks,
			contentType,
			batchOriginalIndices,
			documentTitle,
		);

		const embeddingResults = await generateEmbeddingsForChunks(
			runtime,
			contextualizedChunks,
			rateLimiter,
		);

		for (const result of embeddingResults) {
			const originalChunkIndex = result.index;

			if (!result.success) {
				failedCount++;
				failedChunks.push(originalChunkIndex);
				logger.warn(
					`Failed to process chunk ${originalChunkIndex} for document ${documentId}`,
				);
				continue;
			}

			const contextualizedChunkText = result.text;
			const embedding = result.embedding;

			if (!embedding || embedding.length === 0) {
				failedCount++;
				failedChunks.push(originalChunkIndex);
				continue;
			}

			try {
				const fragmentSource =
					typeof documentMetadata?.source === "string"
						? documentMetadata.source
						: "upload";
				const fragmentMetadata: DocumentFragmentMemoryMetadata = {
					...(documentMetadata ?? {}),
					type: MemoryType.FRAGMENT,
					documentId,
					position: originalChunkIndex,
					timestamp: Date.now(),
					source: fragmentSource,
					documentTitle,
				};
				const fragmentMemory: Memory = {
					id: uuidv4() as UUID,
					agentId,
					roomId: roomId || agentId,
					worldId: worldId ?? agentId,
					entityId: entityId || agentId,
					embedding,
					content: { text: contextualizedChunkText },
					metadata: fragmentMetadata,
				};

				await runtime.createMemory(fragmentMemory, "document_fragments");
				savedCount++;
			} catch (saveError) {
				// error-policy:J4 Batch ingestion returns explicit failed counts;
				// each omitted fragment is also reported to the agent.
				const errorMessage =
					saveError instanceof Error ? saveError.message : String(saveError);
				logger.error(
					`Error saving chunk ${originalChunkIndex} to database: ${errorMessage}`,
				);
				failedCount++;
				failedChunks.push(originalChunkIndex);
				runtime.reportError("DocumentProcessor.saveFragment", saveError, {
					documentId,
					chunkIndex: originalChunkIndex,
				});
			}
		}

		if (i + concurrencyLimit < chunks.length && batchDelayMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, batchDelayMs));
		}
	}

	return { savedCount, failedCount, failedChunks };
}

const EMBEDDING_BATCH_SIZE = 100;

interface EmbeddingResult {
	embedding?: number[];
	success: boolean;
	index: number;
	error?: Error;
	text: string;
}

async function generateEmbeddingsForChunks(
	runtime: IAgentRuntime,
	contextualizedChunks: Array<{
		contextualizedText: string;
		index: number;
		success: boolean;
	}>,
	rateLimiter: (estimatedTokens?: number) => Promise<void>,
): Promise<Array<EmbeddingResult>> {
	const validChunks = contextualizedChunks.filter((chunk) => chunk.success);
	const failedChunks = contextualizedChunks.filter((chunk) => !chunk.success);

	const results: Array<EmbeddingResult> = [];
	for (const chunk of failedChunks) {
		results.push({
			success: false,
			index: chunk.index,
			error: new Error("Chunk processing failed"),
			text: chunk.contextualizedText,
		});
	}

	if (validChunks.length === 0) {
		return results;
	}

	const useBatchEmbeddings = shouldUseBatchEmbeddings(runtime);

	if (useBatchEmbeddings) {
		return generateEmbeddingsBatch(runtime, validChunks, rateLimiter, results);
	} else {
		return generateEmbeddingsIndividual(
			runtime,
			validChunks,
			rateLimiter,
			results,
		);
	}
}

function shouldUseBatchEmbeddings(runtime: IAgentRuntime): boolean {
	const setting =
		runtime.getSetting("BATCH_EMBEDDINGS") ?? process.env.BATCH_EMBEDDINGS;
	// Default to false — batch embeddings require a cloud provider that
	// supports the batch API.  Local embedding (the default) only handles
	// single texts.  Opt-in with BATCH_EMBEDDINGS=true.
	return setting === "true" || setting === true;
}

async function generateEmbeddingsBatch(
	runtime: IAgentRuntime,
	validChunks: Array<{
		contextualizedText: string;
		index: number;
		success: boolean;
	}>,
	rateLimiter: (estimatedTokens?: number) => Promise<void>,
	results: Array<EmbeddingResult>,
): Promise<Array<EmbeddingResult>> {
	for (
		let batchStart = 0;
		batchStart < validChunks.length;
		batchStart += EMBEDDING_BATCH_SIZE
	) {
		const batchEnd = Math.min(
			batchStart + EMBEDDING_BATCH_SIZE,
			validChunks.length,
		);
		const batch = validChunks.slice(batchStart, batchEnd);
		const batchTexts = batch.map((c) => c.contextualizedText);

		const totalTokens = batchTexts.reduce(
			(sum, text) => sum + estimateTokens(text),
			0,
		);
		await rateLimiter(totalTokens);

		try {
			const embeddings = await generateBatchEmbeddingsViaRuntime(
				runtime,
				batchTexts,
			);

			for (let i = 0; i < batch.length; i++) {
				const chunk = batch[i];
				const embedding = embeddings[i];

				if (embedding && embedding.length > 0 && embedding[0] !== 0) {
					results.push({
						embedding,
						success: true,
						index: chunk.index,
						text: chunk.contextualizedText,
					});
				} else {
					results.push({
						success: false,
						index: chunk.index,
						error: new Error("Empty or invalid embedding returned"),
						text: chunk.contextualizedText,
					});
				}
			}
		} catch (error) {
			// error-policy:J4 Batch embedding has an explicit per-chunk fallback.
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			logger.error(`Batch embedding error: ${errorMessage}`);
			runtime.reportError("DocumentProcessor.batchEmbedding", error, {
				batchSize: batch.length,
			});
			for (const chunk of batch) {
				try {
					const result = await generateEmbeddingWithValidation(
						runtime,
						chunk.contextualizedText,
					);
					if (result.success && result.embedding) {
						results.push({
							embedding: result.embedding,
							success: true,
							index: chunk.index,
							text: chunk.contextualizedText,
						});
					} else {
						results.push({
							success: false,
							index: chunk.index,
							error:
								result.error instanceof Error
									? result.error
									: new Error("Embedding failed"),
							text: chunk.contextualizedText,
						});
					}
				} catch (fallbackError) {
					// error-policy:J1 Per-chunk fallback failures become explicit
					// failed EmbeddingResult entries.
					runtime.reportError(
						"DocumentProcessor.fallbackEmbedding",
						fallbackError,
						{ chunkIndex: chunk.index },
					);
					results.push({
						success: false,
						index: chunk.index,
						error:
							fallbackError instanceof Error
								? fallbackError
								: new Error(String(fallbackError)),
						text: chunk.contextualizedText,
					});
				}
			}
		}
	}

	return results;
}

async function generateBatchEmbeddingsViaRuntime(
	runtime: IAgentRuntime,
	texts: string[],
): Promise<number[][]> {
	const batchResult = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
		texts,
	} as {
		text: string;
	} & { texts: string[] });

	const isEmbeddingBatch = (val: unknown): val is number[][] =>
		Array.isArray(val) &&
		val.length > 0 &&
		Array.isArray(val[0]) &&
		typeof val[0][0] === "number";

	const isEmbeddingVector = (val: unknown): val is number[] =>
		Array.isArray(val) && val.length > 0 && typeof val[0] === "number";

	if (isEmbeddingBatch(batchResult)) {
		return batchResult;
	}

	if (isEmbeddingVector(batchResult)) {
		// Provider returned one vector for many texts — fall back to per-text calls with bounded
		// concurrency (same stack as action-filter / embedding batch paths).
		const slots: number[][] = new Array(texts.length);
		const processor = new BatchProcessor<number>({
			maxParallel: 10,
			maxRetriesAfterFailure: 2,
			process: async (idx) => {
				const text = texts[idx];
				if (text === undefined) {
					return;
				}
				const result = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
					text,
				});
				if (isEmbeddingVector(result)) {
					slots[idx] = result;
				} else {
					const embeddingResult = result as
						| { embedding?: number[] }
						| undefined;
					slots[idx] = embeddingResult?.embedding ?? [];
				}
			},
			onExhausted: (idx) => {
				slots[idx] = [];
			},
		});
		const indices = texts.map((_, idx) => idx);
		await processor.processBatch(indices);
		return slots;
	}

	throw new Error("Unexpected batch embedding result format");
}

async function generateEmbeddingsIndividual(
	runtime: IAgentRuntime,
	validChunks: Array<{
		contextualizedText: string;
		index: number;
		success: boolean;
	}>,
	rateLimiter: (estimatedTokens?: number) => Promise<void>,
	results: Array<EmbeddingResult>,
): Promise<Array<EmbeddingResult>> {
	for (const chunk of validChunks) {
		const embeddingTokens = estimateTokens(chunk.contextualizedText);
		await rateLimiter(embeddingTokens);

		try {
			const generateEmbeddingOperation = async () => {
				return generateEmbeddingWithValidation(
					runtime,
					chunk.contextualizedText,
				);
			};

			const { embedding, success, error } = await withRateLimitRetry(
				generateEmbeddingOperation,
				`embedding generation for chunk ${chunk.index}`,
			);

			if (!success) {
				results.push({
					success: false,
					index: chunk.index,
					error,
					text: chunk.contextualizedText,
				});
			} else {
				results.push({
					embedding: embedding ?? undefined,
					success: true,
					index: chunk.index,
					text: chunk.contextualizedText,
				});
			}
		} catch (error) {
			// error-policy:J1 Per-chunk failures become explicit failed
			// EmbeddingResult entries returned to the ingestion boundary.
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			logger.error(
				`Error generating embedding for chunk ${chunk.index}: ${errorMessage}`,
			);
			runtime.reportError("DocumentProcessor.generateEmbedding", error, {
				chunkIndex: chunk.index,
			});
			results.push({
				success: false,
				index: chunk.index,
				error: error instanceof Error ? error : new Error(String(error)),
				text: chunk.contextualizedText,
			});
		}
	}

	return results;
}

async function getContextualizedChunks(
	runtime: IAgentRuntime,
	fullDocumentText: string | undefined,
	chunks: string[],
	contentType: string | undefined,
	batchOriginalIndices: number[],
	documentTitle?: string,
): Promise<
	Array<{ contextualizedText: string; index: number; success: boolean }>
> {
	const ctxEnabled = getCtxDocumentsEnabled(runtime);

	if (ctxEnabled && fullDocumentText) {
		return generateContextsInBatch(
			runtime,
			fullDocumentText,
			chunks,
			contentType,
			batchOriginalIndices,
			documentTitle,
		);
	}

	return chunks.map((chunkText, idx) => ({
		contextualizedText: chunkText,
		index: batchOriginalIndices[idx],
		success: true,
	}));
}

async function generateContextsInBatch(
	runtime: IAgentRuntime,
	fullDocumentText: string,
	chunks: string[],
	contentType?: string,
	batchIndices?: number[],
	_documentTitle?: string,
): Promise<
	Array<{ contextualizedText: string; success: boolean; index: number }>
> {
	if (!chunks || chunks.length === 0) {
		return [];
	}

	const providerLimits = await getProviderRateLimits(runtime);
	const rateLimiter = createRateLimiter(
		providerLimits.requestsPerMinute || 60,
		providerLimits.tokensPerMinute,
		providerLimits.rateLimitEnabled,
	);

	const config = validateModelConfig(runtime);
	// Resolved once per batch: the gate is configuration, not per-chunk state, so
	// deriving it inside generateTextOperation below re-ran it for every chunk
	// AND every rate-limit retry.
	const useCustomLLM = shouldUseCustomLLM(config);
	const isUsingOpenRouter = config.TEXT_PROVIDER === "openrouter";
	const isUsingCacheCapableModel =
		isUsingOpenRouter &&
		(config.TEXT_MODEL?.toLowerCase().includes("claude") ||
			config.TEXT_MODEL?.toLowerCase().includes("gemini"));

	logger.debug(
		`Contextualizing ${chunks.length} chunks with ${config.TEXT_PROVIDER}/${config.TEXT_MODEL} (cache: ${isUsingCacheCapableModel})`,
	);

	const promptConfigs = prepareContextPrompts(
		runtime,
		chunks,
		fullDocumentText,
		contentType,
		batchIndices,
		isUsingCacheCapableModel,
	);

	const contextualizedChunks = await Promise.all(
		promptConfigs.map(async (item) => {
			if (!item.valid) {
				return {
					contextualizedText: item.chunkText,
					success: false,
					index: item.originalIndex,
				};
			}

			const llmTokens = estimateTokens(item.chunkText + (item.prompt || ""));
			await rateLimiter(llmTokens);

			try {
				const generateTextOperation = async () => {
					if (useCustomLLM) {
						if (item.usesCaching && item.promptText) {
							return generateText(runtime, item.promptText, item.systemPrompt, {
								cacheDocument: item.fullDocumentTextForContext,
								cacheOptions: { type: "ephemeral" },
								autoCacheContextualRetrieval: true,
							});
						} else if (item.prompt) {
							return generateText(runtime, item.prompt);
						}
						throw new Error("Missing prompt for text generation");
					} else {
						if (item.usesCaching && item.promptText) {
							const combinedPrompt = item.systemPrompt
								? `${item.systemPrompt}\n\n${item.promptText}`
								: item.promptText;
							return runtime.useModel(ModelType.TEXT_LARGE, {
								prompt: combinedPrompt,
							});
						} else if (item.prompt) {
							return runtime.useModel(ModelType.TEXT_LARGE, {
								prompt: item.prompt,
							});
						}
						throw new Error("Missing prompt for text generation");
					}
				};

				const llmResponse = await withRateLimitRetry(
					generateTextOperation,
					`context generation for chunk ${item.originalIndex}`,
				);

				const generatedContext =
					typeof llmResponse === "string" ? llmResponse : llmResponse.text;
				const contextualizedText = getChunkWithContext(
					item.chunkText,
					generatedContext,
				);

				return {
					contextualizedText,
					success: true,
					index: item.originalIndex,
				};
			} catch (error) {
				// error-policy:J4 Contextualization is optional; preserve the
				// original chunk with success=false and report the failure.
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				logger.error(
					`Error generating context for chunk ${item.originalIndex}: ${errorMessage}`,
				);
				runtime.reportError("DocumentProcessor.contextualizeChunk", error, {
					chunkIndex: item.originalIndex,
				});
				return {
					contextualizedText: item.chunkText,
					success: false,
					index: item.originalIndex,
				};
			}
		}),
	);

	return contextualizedChunks;
}

interface ContextPromptConfig {
	valid: boolean;
	originalIndex: number;
	chunkText: string;
	usesCaching: boolean;
	prompt?: string | null;
	systemPrompt?: string;
	promptText?: string;
	fullDocumentTextForContext?: string;
}

function prepareContextPrompts(
	runtime: IAgentRuntime,
	chunks: string[],
	fullDocumentText: string,
	contentType?: string,
	batchIndices?: number[],
	isUsingCacheCapableModel = false,
): Array<ContextPromptConfig> {
	return chunks.map((chunkText, idx) => {
		const originalIndex = batchIndices ? batchIndices[idx] : idx;
		try {
			if (isUsingCacheCapableModel) {
				const cachingPromptInfo = contentType
					? getCachingPromptForMimeType(contentType, chunkText)
					: getCachingContextualizationPrompt(chunkText);

				if (cachingPromptInfo.prompt.startsWith("Error:")) {
					return {
						originalIndex,
						chunkText,
						valid: false,
						usesCaching: false,
					};
				}

				return {
					valid: true,
					originalIndex,
					chunkText,
					usesCaching: true,
					systemPrompt: cachingPromptInfo.systemPrompt,
					promptText: cachingPromptInfo.prompt,
					fullDocumentTextForContext: fullDocumentText,
				};
			} else {
				const prompt = contentType
					? getPromptForMimeType(contentType, fullDocumentText, chunkText)
					: getContextualizationPrompt(fullDocumentText, chunkText);

				if (prompt.startsWith("Error:")) {
					return {
						prompt: null,
						originalIndex,
						chunkText,
						valid: false,
						usesCaching: false,
					};
				}

				return {
					prompt,
					originalIndex,
					chunkText,
					valid: true,
					usesCaching: false,
				};
			}
		} catch (error) {
			// error-policy:J3 Prompt construction validates derived document
			// input and returns an explicit invalid config for this chunk.
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			logger.error(
				`Error preparing prompt for chunk ${originalIndex}: ${errorMessage}`,
			);
			runtime.reportError("DocumentProcessor.prepareContextPrompt", error, {
				chunkIndex: originalIndex,
			});
			return {
				prompt: null,
				originalIndex,
				chunkText,
				valid: false,
				usesCaching: false,
			};
		}
	});
}

async function generateEmbeddingWithValidation(
	runtime: IAgentRuntime,
	text: string,
): Promise<{
	embedding: number[] | null;
	success: boolean;
	error?: Error;
}> {
	try {
		const embeddingResult = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
			text,
		});

		const embedding = Array.isArray(embeddingResult)
			? embeddingResult
			: (embeddingResult as { embedding: number[] })?.embedding;

		if (!embedding || embedding.length === 0) {
			return {
				embedding: null,
				success: false,
				error: new Error("Zero vector detected"),
			};
		}

		return { embedding, success: true };
	} catch (error) {
		// error-policy:J1 Embedding provider failures become explicit failed
		// results for the fragment-ingestion boundary.
		runtime.reportError("DocumentProcessor.embeddingValidation", error);
		return {
			embedding: null,
			success: false,
			error: error instanceof Error ? error : new Error(String(error)),
		};
	}
}

function retryAfterSeconds(error: unknown): number | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const headers = Reflect.get(error, "headers");
	if (typeof headers !== "object" || headers === null) return undefined;
	const value = Reflect.get(headers, "retry-after");
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
		return value;
	}
	if (typeof value === "string") {
		const parsed = Number(value);
		if (Number.isFinite(parsed) && parsed >= 0) return parsed;
	}
	return undefined;
}

async function withRateLimitRetry<T>(
	operation: () => Promise<T>,
	errorContext: string,
	retryDelay?: number,
): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		// error-policy:J4 A provider-declared rate limit gets one bounded retry;
		// all other failures propagate immediately.
		const status =
			typeof error === "object" && error !== null
				? Reflect.get(error, "status")
				: undefined;
		if (status === 429) {
			const delay = retryDelay ?? retryAfterSeconds(error) ?? 5;
			await new Promise((resolve) => setTimeout(resolve, delay * 1000));

			try {
				return await operation();
			} catch (retryError) {
				// error-policy:J2 Log retry context and preserve the provider cause.
				const retryErrorMessage =
					retryError instanceof Error ? retryError.message : String(retryError);
				logger.error(
					`Failed after retry for ${errorContext}: ${retryErrorMessage}`,
				);
				throw retryError;
			}
		}
		throw error;
	}
}

function createRateLimiter(
	requestsPerMinute: number,
	tokensPerMinute?: number,
	rateLimitEnabled: boolean = true,
) {
	const requestTimes: number[] = [];
	const tokenUsage: Array<{ timestamp: number; tokens: number }> = [];
	const intervalMs = 60 * 1000;

	return async function rateLimiter(estimatedTokens: number = 1000) {
		if (!rateLimitEnabled) return;

		const now = Date.now();

		while (requestTimes.length > 0 && now - requestTimes[0] > intervalMs) {
			requestTimes.shift();
		}
		while (
			tokenUsage.length > 0 &&
			now - tokenUsage[0].timestamp > intervalMs
		) {
			tokenUsage.shift();
		}

		const currentTokens = tokenUsage.reduce(
			(sum, usage) => sum + usage.tokens,
			0,
		);
		const requestLimitExceeded = requestTimes.length >= requestsPerMinute;
		const tokenLimitExceeded =
			tokensPerMinute && currentTokens + estimatedTokens > tokensPerMinute;

		if (requestLimitExceeded || tokenLimitExceeded) {
			let timeToWait = 0;
			if (requestLimitExceeded) {
				timeToWait = Math.max(timeToWait, requestTimes[0] + intervalMs - now);
			}
			if (tokenLimitExceeded && tokenUsage.length > 0) {
				timeToWait = Math.max(
					timeToWait,
					tokenUsage[0].timestamp + intervalMs - now,
				);
			}
			if (timeToWait > 0) {
				await new Promise((resolve) => setTimeout(resolve, timeToWait));
			}
		}

		requestTimes.push(now);
		if (tokensPerMinute) {
			tokenUsage.push({ timestamp: now, tokens: estimatedTokens });
		}
	};
}

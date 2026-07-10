/**
 * Core ingestion pipeline for the documents capability: turns raw document text
 * into stored, embedded FRAGMENT memories. `processFragmentsSynchronously`
 * splits text into overlapping token-sized chunks, optionally contextualizes
 * each chunk through an LLM (the contextual-retrieval step, gated by
 * CTX_DOCUMENTS_ENABLED), generates embeddings (batched or one-at-a-time via the
 * runtime's TEXT_EMBEDDING model), and persists each fragment with
 * `runtime.createMemory`. A token/request rate limiter derived from
 * {@link getProviderRateLimits} throttles the calls, and 429s are retried. Also
 * exposes `extractTextFromDocument` (PDF and text extraction) and
 * `createDocumentMemory` (the parent DOCUMENT memory record).
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

function shouldUseCustomLLM(): boolean {
	const textProvider = process.env.TEXT_PROVIDER;
	const textModel = process.env.TEXT_MODEL;

	if (!textProvider || !textModel) {
		return false;
	}

	switch (textProvider.toLowerCase()) {
		case "openrouter":
			return !!process.env.OPENROUTER_API_KEY;
		case "openai":
			return !!process.env.OPENAI_API_KEY;
		case "anthropic":
			return !!process.env.ANTHROPIC_API_KEY;
		case "google":
			return !!process.env.GOOGLE_API_KEY;
		default:
			return false;
	}
}

const useCustomLLM = shouldUseCustomLLM();

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
	fragments,
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
	/**
	 * Pre-chunked fragments from a producer that owns its chunk boundaries
	 * (e.g. transcript segment groups carrying startMs/endMs anchors, #14806).
	 * When present these are stored verbatim instead of splitting
	 * `fullDocumentText`; each fragment's metadata merges onto the stored
	 * FRAGMENT memory.
	 */
	fragments?: PreChunkedFragmentInput[];
}): Promise<number> {
	let chunks: string[];
	let fragmentMetadatas: Array<Record<string, unknown> | undefined> | undefined;
	const preChunked = fragments !== undefined;
	if (fragments) {
		// The seam is public API (AddDocumentOptions.fragments); a producer that
		// hands us fragments but no body has a broken pipeline — fail fast rather
		// than silently drop the batch.
		validatePreChunkedFragments(fragments, documentId);
		chunks = fragments.map((f) => f.text);
		fragmentMetadatas = fragments.map((f) => f.metadata);
		logger.info(
			`Using ${chunks.length} producer-supplied pre-chunked fragments`,
		);
	} else {
		if (!fullDocumentText || fullDocumentText.trim() === "") {
			logger.warn(`No text content available for document ${documentId}`);
			return 0;
		}
		chunks = await splitDocumentIntoChunks(fullDocumentText);

		if (chunks.length === 0) {
			logger.warn(`No chunks generated for document ${documentId}`);
			return 0;
		}

		logger.info(`Split into ${chunks.length} chunks`);
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
		fragmentMetadatas,
		preChunked,
		fullDocumentText,
		contentType,
		agentId,
		roomId: roomId || agentId,
		entityId: entityId || agentId,
		worldId: worldId || agentId,
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
				try {
					return fileBuffer.toString("utf8");
				} catch (_textError) {
					logger.warn(`Failed to decode ${originalFilename} as UTF-8`);
				}
			}

			return extractTextFromFileBuffer(
				fileBuffer,
				contentType,
				originalFilename,
			);
		}
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		logger.error(
			`Error extracting text from ${originalFilename}: ${errorMessage}`,
		);
		throw new Error(
			`Failed to extract text from ${originalFilename}: ${errorMessage}`,
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
 * Reject malformed producer-supplied fragments before anything is persisted —
 * a fragment with empty text or an inverted/non-finite time anchor would
 * silently poison search results and the PII span projection built on top of
 * the anchors, so the whole batch fails fast instead. Callers must run this
 * BEFORE the parent DOCUMENT row is written (see `DocumentService.addDocument`)
 * so a rejected batch leaves no orphaned zero-fragment document stub.
 */
export function validatePreChunkedFragments(
	fragments: PreChunkedFragmentInput[],
	documentId: UUID,
): void {
	if (fragments.length === 0) {
		throw new ElizaError(
			`Pre-chunked fragments for document ${documentId} must be non-empty when provided`,
			{ code: "DOCUMENT_FRAGMENTS_EMPTY", context: { documentId } },
		);
	}
	fragments.forEach((fragment, index) => {
		if (!fragment.text || fragment.text.trim() === "") {
			throw new ElizaError(
				`Pre-chunked fragment ${index} for document ${documentId} has empty text`,
				{
					code: "DOCUMENT_FRAGMENT_EMPTY_TEXT",
					context: { documentId, index },
				},
			);
		}
		const { startMs, endMs } = (fragment.metadata ?? {}) as {
			startMs?: unknown;
			endMs?: unknown;
		};
		for (const [key, value] of [
			["startMs", startMs],
			["endMs", endMs],
		] as const) {
			if (
				value !== undefined &&
				(typeof value !== "number" || !Number.isFinite(value) || value < 0)
			) {
				throw new ElizaError(
					`Pre-chunked fragment ${index} for document ${documentId} has invalid ${key}: ${String(value)}`,
					{
						code: "DOCUMENT_FRAGMENT_INVALID_ANCHOR",
						context: { documentId, index, key, value: String(value) },
					},
				);
			}
		}
		if (
			typeof startMs === "number" &&
			typeof endMs === "number" &&
			endMs < startMs
		) {
			throw new ElizaError(
				`Pre-chunked fragment ${index} for document ${documentId} has endMs ${endMs} before startMs ${startMs}`,
				{
					code: "DOCUMENT_FRAGMENT_INVERTED_ANCHOR",
					context: { documentId, index, startMs, endMs },
				},
			);
		}
	});
}

async function processAndSaveFragments({
	runtime,
	documentId,
	chunks,
	fragmentMetadatas,
	preChunked = false,
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
	/** Per-chunk producer metadata, indexed like `chunks` (pre-chunked path). */
	fragmentMetadatas?: Array<Record<string, unknown> | undefined>;
	/**
	 * Producer-owned chunk boundaries (#14806): skip contextual retrieval so the
	 * stored FRAGMENT text stays byte-exact against the segment anchors, and make
	 * persistence all-or-nothing — any embed/save failure throws instead of
	 * silently dropping a fragment, which would make redacted audio look covered.
	 */
	preChunked?: boolean;
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

	// Pre-chunked producer fragments (#14806) take an all-or-nothing path:
	// contextual retrieval is skipped (the stored text must stay byte-exact
	// against the segment anchors) and every embedding is generated + validated
	// BEFORE any fragment is persisted, so a failure can never leave a partial
	// index that hides an anchor gap — which would make redacted audio look
	// fully covered to the #14807 PII projection.
	if (preChunked) {
		const saved = await persistPreChunkedFragmentsAtomically({
			runtime,
			documentId,
			chunks,
			fragmentMetadatas,
			agentId,
			roomId,
			entityId,
			worldId,
			rateLimiter,
			concurrencyLimit,
			documentTitle,
			documentMetadata,
			batchDelayMs,
		});
		return { savedCount: saved, failedCount: 0, failedChunks: [] };
	}

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
				const fragmentMemory = buildFragmentMemory({
					documentId,
					originalChunkIndex,
					text: contextualizedChunkText,
					embedding,
					fragmentMetadata: fragmentMetadatas?.[originalChunkIndex],
					documentMetadata,
					documentTitle,
					agentId,
					roomId,
					entityId,
					worldId,
				});

				await runtime.createMemory(fragmentMemory, "document_fragments");
				savedCount++;
			} catch (saveError) {
				const errorMessage =
					saveError instanceof Error ? saveError.message : String(saveError);
				logger.error(
					`Error saving chunk ${originalChunkIndex} to database: ${errorMessage}`,
				);
				failedCount++;
				failedChunks.push(originalChunkIndex);
			}
		}

		if (i + concurrencyLimit < chunks.length && batchDelayMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, batchDelayMs));
		}
	}

	return { savedCount, failedCount, failedChunks };
}

/** Assemble a FRAGMENT memory, merging producer metadata under structural fields. */
function buildFragmentMemory({
	documentId,
	originalChunkIndex,
	text,
	embedding,
	fragmentMetadata,
	documentMetadata,
	documentTitle,
	agentId,
	roomId,
	entityId,
	worldId,
}: {
	documentId: UUID;
	originalChunkIndex: number;
	text: string;
	embedding: number[];
	fragmentMetadata?: Record<string, unknown>;
	documentMetadata?: Record<string, unknown>;
	documentTitle?: string;
	agentId: UUID;
	roomId?: UUID;
	entityId?: UUID;
	worldId?: UUID;
}): Memory {
	const fragmentSource =
		typeof documentMetadata?.source === "string"
			? documentMetadata.source
			: "upload";
	// Producer metadata (time anchors etc.) sits between the inherited document
	// metadata and the structural fields, so it can annotate a fragment but never
	// corrupt type/documentId/position.
	const metadata: DocumentFragmentMemoryMetadata = {
		...(documentMetadata ?? {}),
		...(fragmentMetadata ?? {}),
		type: MemoryType.FRAGMENT,
		documentId,
		position: originalChunkIndex,
		timestamp: Date.now(),
		source: fragmentSource,
		documentTitle,
	};
	return {
		id: uuidv4() as UUID,
		agentId,
		roomId: roomId || agentId,
		worldId: worldId || agentId,
		entityId: entityId || agentId,
		embedding,
		content: { text },
		metadata,
	};
}

/**
 * Persist producer-supplied pre-chunked fragments (#14806) atomically: embed
 * every chunk first (throwing on the first embed failure, before any write),
 * then persist all fragments. Because no fragment is written until every
 * embedding is in hand, an embed failure leaves the index untouched rather than
 * partially populated. Contextual retrieval is deliberately not run — the stored
 * text must equal the producer's chunk byte-for-byte to stay aligned with its
 * `startMs`/`endMs` anchors. Returns the number of fragments persisted.
 */
async function persistPreChunkedFragmentsAtomically({
	runtime,
	documentId,
	chunks,
	fragmentMetadatas,
	agentId,
	roomId,
	entityId,
	worldId,
	rateLimiter,
	concurrencyLimit,
	documentTitle,
	documentMetadata,
	batchDelayMs = 0,
}: {
	runtime: IAgentRuntime;
	documentId: UUID;
	chunks: string[];
	fragmentMetadatas?: Array<Record<string, unknown> | undefined>;
	agentId: UUID;
	roomId?: UUID;
	entityId?: UUID;
	worldId?: UUID;
	rateLimiter: (estimatedTokens?: number) => Promise<void>;
	concurrencyLimit: number;
	documentTitle?: string;
	documentMetadata?: Record<string, unknown>;
	batchDelayMs?: number;
}): Promise<number> {
	const embeddings: number[][] = new Array(chunks.length);

	for (let i = 0; i < chunks.length; i += concurrencyLimit) {
		const batchChunks = chunks.slice(i, i + concurrencyLimit);
		const batchOriginalIndices = Array.from(
			{ length: batchChunks.length },
			(_, k) => i + k,
		);
		// Identity-map: no contextualization on the byte-exact anchor path.
		const contextualizedChunks = batchChunks.map((chunkText, idx) => ({
			contextualizedText: chunkText,
			index: batchOriginalIndices[idx],
			success: true,
		}));

		const embeddingResults = await generateEmbeddingsForChunks(
			runtime,
			contextualizedChunks,
			rateLimiter,
		);

		for (const result of embeddingResults) {
			if (
				!result.success ||
				!result.embedding ||
				result.embedding.length === 0
			) {
				throw new ElizaError(
					`Failed to embed pre-chunked fragment ${result.index} for document ${documentId}`,
					{
						code: "DOCUMENT_FRAGMENT_EMBED_FAILED",
						context: { documentId, index: result.index },
						cause: result.error,
					},
				);
			}
			embeddings[result.index] = result.embedding;
		}

		if (i + concurrencyLimit < chunks.length && batchDelayMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, batchDelayMs));
		}
	}

	// Every embedding is in hand — now persist. A createMemory failure here is a
	// genuine store fault: throw (context-adding) rather than log-and-continue, so
	// the caller sees a broken write instead of a silently short fragment set.
	let savedCount = 0;
	for (let index = 0; index < chunks.length; index++) {
		const fragmentMemory = buildFragmentMemory({
			documentId,
			originalChunkIndex: index,
			text: chunks[index],
			embedding: embeddings[index],
			fragmentMetadata: fragmentMetadatas?.[index],
			documentMetadata,
			documentTitle,
			agentId,
			roomId,
			entityId,
			worldId,
		});
		try {
			await runtime.createMemory(fragmentMemory, "document_fragments");
		} catch (saveError) {
			// error-policy:J2 context-adding rethrow — a store fault on the atomic
			// path must surface, not degrade to a partial index.
			throw new ElizaError(
				`Failed to persist pre-chunked fragment ${index} for document ${documentId}`,
				{
					code: "DOCUMENT_FRAGMENT_SAVE_FAILED",
					context: { documentId, index },
					cause: saveError,
				},
			);
		}
		savedCount++;
	}
	return savedCount;
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
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			logger.error(`Batch embedding error: ${errorMessage}`);
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
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			logger.error(
				`Error generating embedding for chunk ${chunk.index}: ${errorMessage}`,
			);
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
	const isUsingOpenRouter = config.TEXT_PROVIDER === "openrouter";
	const isUsingCacheCapableModel =
		isUsingOpenRouter &&
		(config.TEXT_MODEL?.toLowerCase().includes("claude") ||
			config.TEXT_MODEL?.toLowerCase().includes("gemini"));

	logger.debug(
		`Contextualizing ${chunks.length} chunks with ${config.TEXT_PROVIDER}/${config.TEXT_MODEL} (cache: ${isUsingCacheCapableModel})`,
	);

	const promptConfigs = prepareContextPrompts(
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
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				logger.error(
					`Error generating context for chunk ${item.originalIndex}: ${errorMessage}`,
				);
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
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			logger.error(
				`Error preparing prompt for chunk ${originalIndex}: ${errorMessage}`,
			);
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
		return {
			embedding: null,
			success: false,
			error: error instanceof Error ? error : new Error(String(error)),
		};
	}
}

async function withRateLimitRetry<T>(
	operation: () => Promise<T>,
	errorContext: string,
	retryDelay?: number,
): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		const errorWithStatus = error as {
			status?: number;
			headers?: { "retry-after"?: number };
		};
		if (errorWithStatus.status === 429) {
			const delay = retryDelay || errorWithStatus.headers?.["retry-after"] || 5;
			await new Promise((resolve) => setTimeout(resolve, delay * 1000));

			try {
				return await operation();
			} catch (retryError) {
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

import logger from "./logger";
import {
	type EmbeddingSearchResult,
	type IAgentRuntime,
	type IMemoryManager,
	type Memory,
	type MemoryMetadata,
	type MemoryRetrievalOptions,
	type MemorySearchOptions,
	MemoryType,
	ModelTypes,
	type MultiRoomMemoryOptions,
	type UUID
} from "./types";

const defaultMatchThreshold = 0.1;
const defaultMatchCount = 10;

/**
 * Manage memories in the database.
 */
/**
 * The AgentRuntime instance associated with this manager.
 */
export class MemoryManager implements IMemoryManager {
	/**
	 * The AgentRuntime instance associated with this manager.
	 */
	readonly runtime: IAgentRuntime;

	/**
	 * The name of the database table this manager operates on.
	 */
	readonly tableName: string;

	/**
	 * Constructs a new MemoryManager instance.
	 * @param opts Options for the manager.
	 * @param opts.tableName The name of the table this manager will operate on.
	 * @param opts.runtime The AgentRuntime instance associated with this manager.
	 */
	constructor(opts: { tableName: string; runtime: IAgentRuntime }) {
		this.runtime = opts.runtime;
		this.tableName = opts.tableName;
	}

	private validateMetadata(metadata: MemoryMetadata): void {
		// Check type first before any other validation
		if (!metadata.type) {
			throw new Error("Metadata type is required");
		}

		// Then validate other fields
		if (metadata.source && typeof metadata.source !== "string") {
			throw new Error("Metadata source must be a string");
		}

		if (metadata.sourceId && typeof metadata.sourceId !== "string") {
			throw new Error("Metadata sourceId must be a UUID string");
		}

		if (
			metadata.scope &&
			!["shared", "private", "room"].includes(metadata.scope)
		) {
			throw new Error('Metadata scope must be "shared", "private", or "room"');
		}

		if (metadata.tags && !Array.isArray(metadata.tags)) {
			throw new Error("Metadata tags must be an array of strings");
		}
	}

	/**
	 * Adds an embedding vector to a memory object if one doesn't already exist.
	 * The embedding is generated from the memory's text content using the runtime's
	 * embedding model. If the memory has no text content, an error is thrown.
	 *
	 * @param memory The memory object to add an embedding to
	 * @returns The memory object with an embedding vector added
	 * @throws Error if the memory content is empty
	 */
	async addEmbeddingToMemory(memory: Memory): Promise<Memory> {
		// Return early if embedding already exists
		if (memory.embedding) {
			return memory;
		}

		const memoryText = memory.content.text;

		// Validate memory has text content
		if (!memoryText) {
			throw new Error("Cannot generate embedding: Memory content is empty");
		}

		try {
			// Generate embedding from text content
			memory.embedding = await this.runtime.useModel(
				ModelTypes.TEXT_EMBEDDING,
				{
					text: memoryText,
				},
			);
		} catch (error) {
			logger.error("Failed to generate embedding:", error);
			// Fallback to zero vector if embedding fails
			memory.embedding = await this.runtime.useModel(
				ModelTypes.TEXT_EMBEDDING,
				null,
			);
		}

		return memory;
	}

	/**
	 * Retrieves a list of memories for a specific room, with optional deduplication.
	 * @param opts Options for memory retrieval
	 * @returns A Promise resolving to an array of Memory objects.
	 */
	async getMemories(opts: MemoryRetrievalOptions): Promise<Memory[]> {
		return await this.runtime.getMemories({
			roomId: opts.roomId,
			count: opts.count,
			unique: opts.unique,
			tableName: this.tableName,
			start: opts.start,
			end: opts.end,
		});
	}

	/**
	 * Gets cached embeddings for a given content string.
	 * @param content The content to find similar embeddings for
	 * @returns Promise resolving to array of embeddings with similarity scores
	 */
	async getCachedEmbeddings(content: string): Promise<EmbeddingSearchResult[]> {
		return await this.runtime.getCachedEmbeddings({
			query_table_name: this.tableName,
			query_threshold: 2,
			query_input: content,
			query_field_name: "content",
			query_field_sub_name: "text",
			query_match_count: 10,
		});
	}

	/**
	 * Searches for memories similar to a given embedding vector.
	 * @param opts Options for the memory search
	 * @returns A Promise resolving to an array of Memory objects that match the embedding.
	 */
	async searchMemories(opts: MemorySearchOptions): Promise<Memory[]> {
		const {
			match_threshold = defaultMatchThreshold,
			embedding,
			count = defaultMatchCount,
			roomId,
			agentId,
			unique = true,
		} = opts;

		return await this.runtime.searchMemories({
			tableName: this.tableName,
			roomId,
			embedding,
			match_threshold,
			count,
			unique,
		});
	}

	/**
	 * Creates a new memory in the database, with an option to check for similarity before insertion.
	 * @param memory The memory object to create.
	 * @param unique Whether to check for similarity before insertion.
	 * @returns A Promise that resolves to the UUID of the created memory.
	 */
	async createMemory(memory: Memory, unique = false): Promise<UUID> {
		if (memory.metadata) {
			this.validateMetadata(memory.metadata); // This will check type first
			this.validateMetadataRequirements(memory.metadata);
		}
		const existingMessage = await this.runtime.getMemoryById(memory.id);

		if (existingMessage) {
			logger.debug("Memory already exists, skipping");
			return memory.id;
		}

		if (!memory.metadata) {
			memory.metadata = {
				type: this.tableName,
				scope: memory.agentId ? "private" : "shared",
				timestamp: Date.now(),
			} as MemoryMetadata;
		}

		// Handle metadata if present
		if (memory.metadata) {
			// Validate metadata
			this.validateMetadata(memory.metadata);

			// Ensure timestamp
			if (!memory.metadata.timestamp) {
				memory.metadata.timestamp = Date.now();
			}

			// Set default scope if not present
			if (!memory.metadata.scope) {
				memory.metadata.scope = memory.agentId ? "private" : "shared";
			}
		}

		logger.log("Creating Memory", memory.id, memory.content.text);

		if (!memory.embedding) {
			memory.embedding = await this.runtime.useModel(
				ModelTypes.TEXT_EMBEDDING,
				null,
			);
		}

		const memoryId = await this.runtime.createMemory(memory, this.tableName, unique);

		return memoryId;
	}

	/**
	 * Gets memories for multiple rooms.
	 * @param params Parameters for retrieval
	 * @returns Promise resolving to array of memories
	 */
	async getMemoriesByRoomIds(params: MultiRoomMemoryOptions): Promise<Memory[]> {
		return await this.runtime.getMemoriesByRoomIds({
			tableName: this.tableName,
			roomIds: params.roomIds,
			limit: params.limit,
		});
	}

	/**
	 * Gets a memory by its ID.
	 * @param id The UUID of the memory to retrieve
	 * @returns Promise resolving to the memory or null if not found
	 */
	async getMemoryById(id: UUID): Promise<Memory | null> {
		const result = await this.runtime.getMemoryById(id);
		if (result && result.agentId !== this.runtime.agentId) return null;
		return result;
	}

	/**
	 * Removes a memory from the database by its ID.
	 * @param memoryId The ID of the memory to remove.
	 * @returns A Promise that resolves when the operation completes.
	 */
	async removeMemory(memoryId: UUID): Promise<void> {
		await this.runtime.removeMemory(memoryId, this.tableName);
	}

	/**
	 * Removes all memories associated with a room.
	 * @param roomId The room ID to remove memories for.
	 * @returns A Promise that resolves when the operation completes.
	 */
	async removeAllMemories(roomId: UUID): Promise<void> {
		await this.runtime.removeAllMemories(roomId, this.tableName);
	}

	/**
	 * Counts the number of memories associated with a room, with an option for uniqueness.
	 * @param roomId The room ID to count memories for.
	 * @param unique Whether to count unique memories only.
	 * @returns A Promise resolving to the count of memories.
	 */
	async countMemories(roomId: UUID, unique = true): Promise<number> {
		return await this.runtime.countMemories(roomId, unique, this.tableName);
	}

	/**
	 * Validates that a metadata object meets the requirements for its type.
	 * @param metadata The metadata to validate
	 * @throws Error if metadata doesn't meet requirements for its type
	 */
	private validateMetadataRequirements(metadata: MemoryMetadata): void {
		if (metadata.type === MemoryType.FRAGMENT) {
			if (!metadata.documentId) {
				throw new Error("Fragment metadata must include documentId");
			}
			if (typeof metadata.position !== "number") {
				throw new Error("Fragment metadata must include position");
			}
		}
	}
}

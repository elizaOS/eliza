import { logger } from "../../logger.ts";
import {
	type IAgentRuntime,
	Service,
	type ServiceTypeName,
	type UUID,
} from "../../types/index.ts";
import type { MemoryStorageProvider } from "../../types/memory-storage.ts";
import type {
	LongTermMemory,
	LongTermMemoryCategory,
	MemoryConfig,
	SessionSummary,
} from "../types.ts";

export class MemoryService extends Service {
	static serviceType: ServiceTypeName = "memory" as ServiceTypeName;

	private sessionMessageCounts: Map<UUID, number>;
	private memoryConfig: MemoryConfig;
	private lastExtractionCheckpoints: Map<string, number>;

	/** Resolved at initialize(). null means no storage backend is available. */
	private storage: MemoryStorageProvider | null = null;

	capabilityDescription =
		"Memory management with short-term summarization and long-term persistent facts";

	constructor(runtime?: IAgentRuntime) {
		super(runtime);
		this.sessionMessageCounts = new Map();
		this.lastExtractionCheckpoints = new Map();
		this.memoryConfig = {
			shortTermSummarizationThreshold: 16,
			shortTermRetainRecent: 6,
			shortTermSummarizationInterval: 10,
			longTermExtractionEnabled: true,
			longTermVectorSearchEnabled: false,
			longTermConfidenceThreshold: 0.85,
			longTermExtractionThreshold: 30,
			longTermExtractionInterval: 10,
			summaryModelType: "TEXT_LARGE",
			summaryMaxTokens: 2500,
			summaryMaxNewMessages: 20,
		};
	}

	static async start(runtime: IAgentRuntime): Promise<Service> {
		const service = new MemoryService(runtime);
		await service.initialize(runtime);
		return service;
	}

	async stop(): Promise<void> {
		logger.info({ src: "service:memory" }, "MemoryService stopped");
	}

	async initialize(runtime: IAgentRuntime): Promise<void> {
		this.runtime = runtime;

		// Discover the storage provider registered by a database plugin.
		// If none exists, storage-backed features are disabled.
		const provider = runtime.getService(
			"memoryStorage",
		) as unknown as MemoryStorageProvider | null;
		if (!provider) {
			logger.warn(
				{ src: "service:memory", agentId: runtime.agentId },
				"No MemoryStorageProvider found — long-term memory and session summaries disabled. " +
					"Register a memoryStorage service from your database plugin to enable them.",
			);
		}
		this.storage = provider;

		// Read config overrides from environment / character settings.
		const threshold = runtime.getSetting("MEMORY_SUMMARIZATION_THRESHOLD");
		if (threshold) {
			this.memoryConfig.shortTermSummarizationThreshold = Number.parseInt(
				String(threshold),
				10,
			);
		}

		const retainRecent = runtime.getSetting("MEMORY_RETAIN_RECENT");
		if (retainRecent) {
			this.memoryConfig.shortTermRetainRecent = Number.parseInt(
				String(retainRecent),
				10,
			);
		}

		const summarizationInterval = runtime.getSetting(
			"MEMORY_SUMMARIZATION_INTERVAL",
		);
		if (summarizationInterval) {
			this.memoryConfig.shortTermSummarizationInterval = Number.parseInt(
				String(summarizationInterval),
				10,
			);
		}

		const maxNewMessages = runtime.getSetting("MEMORY_MAX_NEW_MESSAGES");
		if (maxNewMessages) {
			this.memoryConfig.summaryMaxNewMessages = Number.parseInt(
				String(maxNewMessages),
				10,
			);
		}

		const longTermEnabled = runtime.getSetting("MEMORY_LONG_TERM_ENABLED");
		if (longTermEnabled === "false" || longTermEnabled === false) {
			this.memoryConfig.longTermExtractionEnabled = false;
		} else if (longTermEnabled === "true" || longTermEnabled === true) {
			this.memoryConfig.longTermExtractionEnabled = true;
		}

		const confidenceThreshold = runtime.getSetting(
			"MEMORY_CONFIDENCE_THRESHOLD",
		);
		if (confidenceThreshold) {
			this.memoryConfig.longTermConfidenceThreshold = Number.parseFloat(
				String(confidenceThreshold),
			);
		}

		const extractionThreshold = runtime.getSetting(
			"MEMORY_EXTRACTION_THRESHOLD",
		);
		if (extractionThreshold) {
			this.memoryConfig.longTermExtractionThreshold = Number.parseInt(
				String(extractionThreshold),
				10,
			);
		}

		const extractionInterval = runtime.getSetting("MEMORY_EXTRACTION_INTERVAL");
		if (extractionInterval) {
			this.memoryConfig.longTermExtractionInterval = Number.parseInt(
				String(extractionInterval),
				10,
			);
		}

		logger.debug(
			{
				summarizationThreshold:
					this.memoryConfig.shortTermSummarizationThreshold,
				summarizationInterval: this.memoryConfig.shortTermSummarizationInterval,
				maxNewMessages: this.memoryConfig.summaryMaxNewMessages,
				retainRecent: this.memoryConfig.shortTermRetainRecent,
				longTermEnabled: this.memoryConfig.longTermExtractionEnabled,
				extractionThreshold: this.memoryConfig.longTermExtractionThreshold,
				extractionInterval: this.memoryConfig.longTermExtractionInterval,
				confidenceThreshold: this.memoryConfig.longTermConfidenceThreshold,
				storageAvailable: !!this.storage,
			},
			"MemoryService initialized",
			{ src: "service:memory" },
		);
	}

	// ── Helpers ──────────────────────────────────────────────────────────

	private requireStorage(): MemoryStorageProvider {
		if (!this.storage) {
			throw new Error(
				"MemoryStorageProvider not available. Register a memoryStorage service from your database plugin.",
			);
		}
		return this.storage;
	}

	getConfig(): MemoryConfig {
		return { ...this.memoryConfig };
	}

	updateConfig(updates: Partial<MemoryConfig>): void {
		this.memoryConfig = { ...this.memoryConfig, ...updates };
	}

	incrementMessageCount(roomId: UUID): number {
		const current = this.sessionMessageCounts.get(roomId) || 0;
		const newCount = current + 1;
		this.sessionMessageCounts.set(roomId, newCount);
		return newCount;
	}

	resetMessageCount(roomId: UUID): void {
		this.sessionMessageCounts.set(roomId, 0);
	}

	async shouldSummarize(roomId: UUID): Promise<boolean> {
		const count = await this.runtime.countMemories({
			roomIds: [roomId],
			unique: false,
			tableName: "messages",
		});
		return count >= this.memoryConfig.shortTermSummarizationThreshold;
	}

	private getExtractionKey(entityId: UUID, roomId: UUID): string {
		return `memory:extraction:${entityId}:${roomId}`;
	}

	async getLastExtractionCheckpoint(
		entityId: UUID,
		roomId: UUID,
	): Promise<number> {
		const key = this.getExtractionKey(entityId, roomId);

		const cached = this.lastExtractionCheckpoints.get(key);
		if (cached !== undefined) {
			return cached;
		}

		try {
			const checkpoint = await this.runtime.getCache<number>(key);
			const messageCount = checkpoint ?? 0;
			this.lastExtractionCheckpoints.set(key, messageCount);
			return messageCount;
		} catch (error) {
			const err = error instanceof Error ? error.message : String(error);
			logger.warn(
				{ src: "service:memory", err },
				"Failed to get extraction checkpoint from cache",
			);
			return 0;
		}
	}

	async setLastExtractionCheckpoint(
		entityId: UUID,
		roomId: UUID,
		messageCount: number,
	): Promise<void> {
		const key = this.getExtractionKey(entityId, roomId);
		this.lastExtractionCheckpoints.set(key, messageCount);

		try {
			await this.runtime.setCache(key, messageCount);
			logger.debug(
				{ src: "service:memory" },
				`Set extraction checkpoint for ${entityId} in room ${roomId} at count ${messageCount}`,
			);
		} catch (error) {
			const err = error instanceof Error ? error.message : String(error);
			logger.error(
				{ src: "service:memory", err },
				"Failed to persist extraction checkpoint to cache",
			);
		}
	}

	async shouldRunExtraction(
		entityId: UUID,
		roomId: UUID,
		currentMessageCount: number,
	): Promise<boolean> {
		const threshold = this.memoryConfig.longTermExtractionThreshold;
		const interval = this.memoryConfig.longTermExtractionInterval;

		if (currentMessageCount < threshold) {
			return false;
		}

		const lastCheckpoint = await this.getLastExtractionCheckpoint(
			entityId,
			roomId,
		);
		const currentCheckpoint =
			Math.floor(currentMessageCount / interval) * interval;
		const shouldRun =
			currentMessageCount >= threshold && currentCheckpoint > lastCheckpoint;

		logger.debug(
			{
				entityId,
				roomId,
				currentMessageCount,
				threshold,
				interval,
				lastCheckpoint,
				currentCheckpoint,
				shouldRun,
			},
			"Extraction check",
			{ src: "service:memory" },
		);

		return shouldRun;
	}

	// ── Storage operations (delegated to provider) ──────────────────────

	async storeLongTermMemory(
		memory: Omit<
			LongTermMemory,
			"id" | "createdAt" | "updatedAt" | "accessCount"
		>,
	): Promise<LongTermMemory> {
		const stored = await this.requireStorage().storeLongTermMemory(memory);
		logger.info(
			{ src: "service:memory" },
			`Stored long-term memory: ${stored.category} for entity ${stored.entityId}`,
		);
		return stored;
	}

	async getLongTermMemories(
		entityId: UUID,
		category?: LongTermMemoryCategory,
		limit = 10,
	): Promise<LongTermMemory[]> {
		if (limit <= 0) return [];
		return this.requireStorage().getLongTermMemories(
			this.runtime.agentId,
			entityId,
			{ category, limit },
		);
	}

	async updateLongTermMemory(
		id: UUID,
		entityId: UUID,
		updates: Partial<
			Omit<LongTermMemory, "id" | "agentId" | "entityId" | "createdAt">
		>,
	): Promise<void> {
		await this.requireStorage().updateLongTermMemory(
			id,
			this.runtime.agentId,
			entityId,
			updates,
		);
		logger.info(
			{ src: "service:memory" },
			`Updated long-term memory: ${id} for entity ${entityId}`,
		);
	}

	async deleteLongTermMemory(id: UUID, entityId: UUID): Promise<void> {
		await this.requireStorage().deleteLongTermMemory(
			id,
			this.runtime.agentId,
			entityId,
		);
		logger.info(
			{ src: "service:memory" },
			`Deleted long-term memory: ${id} for entity ${entityId}`,
		);
	}

	async getCurrentSessionSummary(roomId: UUID): Promise<SessionSummary | null> {
		return this.requireStorage().getCurrentSessionSummary(
			this.runtime.agentId,
			roomId,
		);
	}

	async storeSessionSummary(
		summary: Omit<SessionSummary, "id" | "createdAt" | "updatedAt">,
	): Promise<SessionSummary> {
		const stored = await this.requireStorage().storeSessionSummary(summary);
		logger.info(
			{ src: "service:memory" },
			`Stored session summary for room ${stored.roomId}`,
		);
		return stored;
	}

	async updateSessionSummary(
		id: UUID,
		roomId: UUID,
		updates: Partial<
			Omit<
				SessionSummary,
				"id" | "agentId" | "roomId" | "createdAt" | "updatedAt"
			>
		>,
	): Promise<void> {
		await this.requireStorage().updateSessionSummary(
			id,
			this.runtime.agentId,
			roomId,
			updates,
		);
		logger.info(
			{ src: "service:memory" },
			`Updated session summary: ${id} for room ${roomId}`,
		);
	}

	async getSessionSummaries(
		roomId: UUID,
		limit = 5,
	): Promise<SessionSummary[]> {
		return this.requireStorage().getSessionSummaries(
			this.runtime.agentId,
			roomId,
			limit,
		);
	}

	// ── Vector search (JS fallback; provider can override with native) ──

	async searchLongTermMemories(
		entityId: UUID,
		queryEmbedding: number[],
		limit = 5,
		matchThreshold = 0.7,
	): Promise<LongTermMemory[]> {
		if (limit <= 0) return [];
		if (!this.memoryConfig.longTermVectorSearchEnabled) {
			logger.warn(
				{ src: "service:memory" },
				"Vector search is not enabled, falling back to recent memories",
			);
			return this.getLongTermMemories(entityId, undefined, limit);
		}

		try {
			const candidates = await this.getLongTermMemories(
				entityId,
				undefined,
				200,
			);
			const scored: Array<{ memory: LongTermMemory; similarity: number }> = [];
			for (const memory of candidates) {
				if ((memory.embedding?.length ?? 0) === 0) continue;
				const similarity = cosineSimilarity(
					memory.embedding ?? [],
					queryEmbedding,
				);
				if (similarity < matchThreshold) continue;
				if (scored.length < limit) {
					scored.push({ memory, similarity });
					scored.sort((a, b) => b.similarity - a.similarity);
					continue;
				}
				if (similarity <= scored[scored.length - 1]?.similarity) continue;
				let index = 0;
				while (index < scored.length && scored[index].similarity > similarity) {
					index += 1;
				}
				scored.splice(index, 0, { memory, similarity });
				if (scored.length > limit) {
					scored.pop();
				}
			}
			return scored.map((x) => ({
				...x.memory,
				similarity: x.similarity,
			}));
		} catch (error) {
			logger.warn(
				{ error },
				"Vector search failed, falling back to recent memories",
				{ src: "service:memory" },
			);
			return this.getLongTermMemories(entityId, undefined, limit);
		}
	}

	// ── Formatting ──────────────────────────────────────────────────────

	async getFormattedLongTermMemories(entityId: UUID): Promise<string> {
		const memories = await this.getLongTermMemories(entityId, undefined, 20);
		if (memories.length === 0) return "";

		const grouped = new Map<LongTermMemoryCategory, LongTermMemory[]>();
		for (const memory of memories) {
			const existing = grouped.get(memory.category);
			if (existing) {
				existing.push(memory);
			} else {
				grouped.set(memory.category, [memory]);
			}
		}

		const sections: string[] = [];
		for (const [category, categoryMemories] of grouped.entries()) {
			const categoryName = category
				.split("_")
				.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
				.join(" ");
			const items = categoryMemories.map((m) => `- ${m.content}`).join("\n");
			sections.push(`**${categoryName}**:\n${items}`);
		}

		return sections.join("\n\n");
	}
}

function cosineSimilarity(a: number[], b: number[]): number {
	if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i += 1) {
		const x = a[i] ?? 0;
		const y = b[i] ?? 0;
		dot += x * y;
		normA += x * x;
		normB += y * y;
	}
	const denom = Math.sqrt(normA) * Math.sqrt(normB);
	return denom === 0 ? 0 : dot / denom;
}

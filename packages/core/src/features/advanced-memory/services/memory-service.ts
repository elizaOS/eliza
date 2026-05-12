import {
	getRelatedEntityIds,
	resolvePrimaryEntityId,
} from "../../../identity-clusters.ts";
import { logger } from "../../../logger.ts";
import {
	type IAgentRuntime,
	ModelType,
	Service,
	type ServiceTypeName,
	type TextGenerationModelType,
	type UUID,
} from "../../../types/index.ts";
import type { MemoryStorageProvider } from "../../../types/memory-storage.ts";
import type {
	LongTermMemory,
	LongTermMemoryCategory,
	MemoryConfig,
	SessionSummary,
} from "../types.ts";

const TEXT_GENERATION_MODEL_TYPES = new Set<TextGenerationModelType>([
	ModelType.TEXT_NANO,
	ModelType.TEXT_SMALL,
	ModelType.TEXT_MEDIUM,
	ModelType.TEXT_LARGE,
	ModelType.TEXT_MEGA,
	ModelType.RESPONSE_HANDLER,
	ModelType.ACTION_PLANNER,
	ModelType.TEXT_REASONING_SMALL,
	ModelType.TEXT_REASONING_LARGE,
	ModelType.TEXT_COMPLETION,
]);

function memoryCreatedAtMs(memory: LongTermMemory): number {
	const value = memory.createdAt;
	const timestamp =
		value instanceof Date ? value.getTime() : new Date(value).getTime();
	return Number.isFinite(timestamp) ? timestamp : 0;
}

function resolveConfiguredTextGenerationModelType(
	value: string | boolean | number | null,
): TextGenerationModelType | null {
	if (typeof value !== "string") {
		return null;
	}

	const normalized = value.trim() as TextGenerationModelType;
	return TEXT_GENERATION_MODEL_TYPES.has(normalized) ? normalized : null;
}

function isMemoryStorageProvider(
	service: unknown,
): service is MemoryStorageProvider {
	return (
		typeof service === "object" &&
		service !== null &&
		"storeLongTermMemory" in service &&
		typeof service.storeLongTermMemory === "function" &&
		"storeSessionSummary" in service &&
		typeof service.storeSessionSummary === "function"
	);
}

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
			summaryModelType: ModelType.TEXT_NANO,
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
		let provider: MemoryStorageProvider | null = null;
		if (runtime.hasService("memoryStorage")) {
			try {
				const loaded = await runtime.getServiceLoadPromise("memoryStorage");
				provider = isMemoryStorageProvider(loaded) ? loaded : null;
			} catch (error) {
				const err = error instanceof Error ? error.message : String(error);
				logger.warn(
					{ src: "service:memory", agentId: runtime.agentId, err },
					"MemoryStorageProvider failed to start — storage-backed advanced memory disabled",
				);
			}
		}
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

		const configuredModelType = resolveConfiguredTextGenerationModelType(
			runtime.getSetting("MEMORY_SUMMARY_MODEL_TYPE") ??
				runtime.getSetting("MEMORY_MODEL_TYPE"),
		);
		if (configuredModelType) {
			this.memoryConfig.summaryModelType = configuredModelType;
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

	private async getStorage(): Promise<MemoryStorageProvider | null> {
		if (!this.storage && this.runtime.hasService("memoryStorage")) {
			try {
				const loaded =
					await this.runtime.getServiceLoadPromise("memoryStorage");
				this.storage = isMemoryStorageProvider(loaded) ? loaded : null;
			} catch (error) {
				const err = error instanceof Error ? error.message : String(error);
				logger.warn(
					{ src: "service:memory", agentId: this.runtime.agentId, err },
					"MemoryStorageProvider lookup failed during lazy resolution",
				);
			}
		}
		return this.storage;
	}

	private async requireStorage(op: string): Promise<MemoryStorageProvider> {
		const storage = await this.getStorage();
		if (!storage) {
			throw new Error(
				`MemoryStorageProvider is not registered — cannot ${op} (register a storage service or disable advancedMemory).`,
			);
		}
		return storage;
	}

	private async countRoomMemories(roomId: UUID): Promise<number> {
		type ModernCounter = (params: {
			roomIds: UUID[];
			unique: boolean;
			tableName: string;
		}) => Promise<number>;
		type LegacyCounter = (
			roomId: UUID,
			unique?: boolean,
			tableName?: string,
		) => Promise<number>;

		const counter = this.runtime.countMemories as ModernCounter | LegacyCounter;
		if (counter.length >= 2) {
			return (counter as LegacyCounter)(roomId, false, "messages");
		}
		return (counter as ModernCounter)({
			roomIds: [roomId],
			unique: false,
			tableName: "messages",
		});
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
		const count = await this.countRoomMemories(roomId);
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
		const entityId = await resolvePrimaryEntityId(
			this.runtime,
			memory.entityId,
		);
		const stored = await (
			await this.requireStorage("store long-term memory")
		).storeLongTermMemory({ ...memory, entityId });
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
		const storage = await this.getStorage();
		if (!storage) return [];
		const entityIds = await getRelatedEntityIds(this.runtime, entityId);
		const memories = (
			await Promise.all(
				entityIds.map((relatedEntityId) =>
					storage.getLongTermMemories(this.runtime.agentId, relatedEntityId, {
						category,
						limit,
					}),
				),
			)
		).flat();
		return memories
			.sort((left, right) => memoryCreatedAtMs(right) - memoryCreatedAtMs(left))
			.slice(0, limit);
	}

	async updateLongTermMemory(
		id: UUID,
		entityId: UUID,
		updates: Partial<
			Omit<LongTermMemory, "id" | "agentId" | "entityId" | "createdAt">
		>,
	): Promise<void> {
		const storage = await this.requireStorage("update long-term memory");
		await storage.updateLongTermMemory(
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
		const storage = await this.requireStorage("delete long-term memory");
		await storage.deleteLongTermMemory(id, this.runtime.agentId, entityId);
		logger.info(
			{ src: "service:memory" },
			`Deleted long-term memory: ${id} for entity ${entityId}`,
		);
	}

	async getCurrentSessionSummary(roomId: UUID): Promise<SessionSummary | null> {
		const storage = await this.getStorage();
		if (!storage) return null;
		return storage.getCurrentSessionSummary(this.runtime.agentId, roomId);
	}

	async storeSessionSummary(
		summary: Omit<SessionSummary, "id" | "createdAt" | "updatedAt">,
	): Promise<SessionSummary> {
		const storage = await this.requireStorage("store session summary");
		const stored = await storage.storeSessionSummary(summary);
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
		const storage = await this.requireStorage("update session summary");
		await storage.updateSessionSummary(
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
		const storage = await this.getStorage();
		if (!storage) return [];
		return storage.getSessionSummaries(this.runtime.agentId, roomId, limit);
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
				.map((word: string) => word.charAt(0).toUpperCase() + word.slice(1))
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

/**
 * Memory Storage Provider interface.
 *
 * Abstracts advanced-memory storage so MemoryService in core has zero
 * database or ORM dependencies. Database plugins (plugin-sql, etc.)
 * register a service that implements this interface. MemoryService
 * discovers it at init time via runtime.getService("memoryStorage").
 *
 * If no provider is registered, MemoryService gracefully disables
 * storage-backed features. Non-SQL adapters (in-memory, file-based)
 * simply don't register one.
 */

import type {
	LongTermMemory,
	LongTermMemoryCategory,
	SessionSummary,
} from "../features/advanced-memory/types.ts";
import type { UUID } from "./primitives.ts";

export interface MemoryStorageProvider {
	// ── Long-term memories ──────────────────────────────────────────────

	storeLongTermMemory(
		memory: Omit<
			LongTermMemory,
			"id" | "createdAt" | "updatedAt" | "accessCount"
		>,
	): Promise<LongTermMemory>;

	getLongTermMemories(
		agentId: UUID,
		entityId: UUID,
		opts?: { category?: LongTermMemoryCategory; limit?: number },
	): Promise<LongTermMemory[]>;

	updateLongTermMemory(
		id: UUID,
		agentId: UUID,
		entityId: UUID,
		updates: Partial<
			Omit<LongTermMemory, "id" | "agentId" | "entityId" | "createdAt">
		>,
	): Promise<void>;

	deleteLongTermMemory(id: UUID, agentId: UUID, entityId: UUID): Promise<void>;

	// ── Session summaries ───────────────────────────────────────────────

	storeSessionSummary(
		summary: Omit<SessionSummary, "id" | "createdAt" | "updatedAt">,
	): Promise<SessionSummary>;

	getCurrentSessionSummary(
		agentId: UUID,
		roomId: UUID,
	): Promise<SessionSummary | null>;

	updateSessionSummary(
		id: UUID,
		agentId: UUID,
		roomId: UUID,
		updates: Partial<
			Omit<
				SessionSummary,
				"id" | "agentId" | "roomId" | "createdAt" | "updatedAt"
			>
		>,
	): Promise<void>;

	getSessionSummaries(
		agentId: UUID,
		roomId: UUID,
		limit?: number,
	): Promise<SessionSummary[]>;
}

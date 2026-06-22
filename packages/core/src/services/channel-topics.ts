/**
 * ChannelTopicsService — per-channel topic LRU.
 *
 * Maintains, per `roomId`, a bounded most-recently-used list of short topic
 * labels extracted at Stage-1 (the `topics` field-evaluator). The list is the
 * running answer to "what is this channel about lately?" and is surfaced back
 * into Stage-1 routing through the `CHANNEL_TOPICS` provider so shouldRespond /
 * the planner can weigh topic relevance.
 *
 * Semantics:
 *   - Bounded LRU per room. {@link CHANNEL_TOPICS_LRU_CAPACITY} slots
 *     (≈ the last ~100 messages worth of distinct topics). FIFO eviction:
 *     when the list is full, the oldest entry is dropped to make room.
 *   - Dedupe on insert: re-recording an existing topic refreshes its recency
 *     (moves it to the most-recent end) rather than adding a duplicate.
 *   - Ordering: index 0 is the OLDEST, the last index is the MOST RECENT.
 *
 * Persistence:
 *   - Each room's list is mirrored to `room.metadata.currentTopics` via
 *     `runtime.updateRoom` so it survives a restart.
 *   - The in-memory cache is hydrated from `room.metadata.currentTopics` the
 *     first time a room is touched.
 *   - All persistence is defensive: any failure is logged and swallowed — it
 *     must never throw into the message loop.
 *
 * This service is PURE LOGIC (no fs / process / native deps) so it is safe for
 * the Node, browser, and edge build targets.
 */

import { logger } from "../logger";
import type { Room, UUID } from "../types/index";
import type { IAgentRuntime } from "../types/runtime";
import { Service } from "../types/service";

/** Metadata key under which a room's topic LRU is persisted. */
export const CHANNEL_TOPICS_METADATA_KEY = "currentTopics";

/**
 * Max distinct topics retained per room. ~20 slots ≈ the last ~100 messages
 * worth of salient topics (each message contributes 0-5 topics, most repeat).
 */
export const CHANNEL_TOPICS_LRU_CAPACITY = 20;

const LOG_PREFIX = "[ChannelTopicsService]";

/**
 * Coerce an unknown value (e.g. read back from room metadata) into a clean
 * topic list: strings only, trimmed, non-empty, deduped, capped at capacity.
 * Mirrors the normalization the Stage-1 evaluator applies on the way in, so a
 * hand-edited or legacy metadata blob can never poison the cache.
 */
function coerceTopicList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const result: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") continue;
		const normalized = item.trim();
		if (!normalized) continue;
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		result.push(normalized);
	}
	// Keep the most-recent tail if a persisted list somehow exceeds capacity.
	return result.length > CHANNEL_TOPICS_LRU_CAPACITY
		? result.slice(result.length - CHANNEL_TOPICS_LRU_CAPACITY)
		: result;
}

export class ChannelTopicsService extends Service {
	static override serviceType = "channel_topics";
	override capabilityDescription =
		"Maintains a per-channel LRU of recent topic labels extracted at Stage-1.";

	/** roomId → ordered topic list (index 0 oldest, last most recent). */
	private readonly topicsByRoom = new Map<UUID, string[]>();
	/** Rooms whose metadata has already been hydrated into the cache. */
	private readonly hydrated = new Set<UUID>();

	static override async start(
		runtime: IAgentRuntime,
	): Promise<ChannelTopicsService> {
		return new ChannelTopicsService(runtime);
	}

	override async stop(): Promise<void> {
		this.topicsByRoom.clear();
		this.hydrated.clear();
	}

	/**
	 * Hydrate a room's LRU from `room.metadata.currentTopics` the first time it
	 * is accessed. Defensive: any failure leaves the room with an empty list.
	 */
	private async hydrateRoom(roomId: UUID): Promise<void> {
		if (this.hydrated.has(roomId)) return;
		this.hydrated.add(roomId);
		try {
			const room = await this.runtime.getRoom(roomId);
			const persisted = coerceTopicList(
				room?.metadata?.[CHANNEL_TOPICS_METADATA_KEY],
			);
			if (persisted.length > 0) {
				this.topicsByRoom.set(roomId, persisted);
			}
		} catch (error) {
			logger.warn(
				{ src: "service:channel_topics", roomId, err: error },
				`${LOG_PREFIX} hydrate from room metadata failed`,
			);
		}
	}

	/**
	 * Apply new topics to a room's in-memory LRU. Dedupe refreshes recency
	 * (move-to-most-recent); FIFO eviction drops the oldest when over capacity.
	 * Returns the updated list (a fresh array, safe to hand out).
	 */
	private applyTopics(roomId: UUID, incoming: string[]): string[] {
		const current = this.topicsByRoom.get(roomId) ?? [];
		// Work on a Map keyed by topic to dedupe while preserving insertion
		// order — re-inserting a key after delete moves it to the end (most
		// recent), which is exactly the recency-refresh semantics we want.
		const ordered = new Map<string, true>();
		for (const topic of current) {
			ordered.set(topic, true);
		}
		for (const raw of incoming) {
			const topic = raw.trim();
			if (!topic) continue;
			// Refresh recency: delete then re-set pushes it to the tail.
			ordered.delete(topic);
			ordered.set(topic, true);
		}
		let next = Array.from(ordered.keys());
		if (next.length > CHANNEL_TOPICS_LRU_CAPACITY) {
			// FIFO eviction: drop the oldest (front) entries.
			next = next.slice(next.length - CHANNEL_TOPICS_LRU_CAPACITY);
		}
		this.topicsByRoom.set(roomId, next);
		return next;
	}

	/**
	 * Persist a room's topic list to `room.metadata.currentTopics`. Defensive:
	 * a missing room or a failed update is logged and swallowed — it must never
	 * throw into the message loop.
	 */
	private async persistRoom(roomId: UUID, topics: string[]): Promise<void> {
		try {
			const room = await this.runtime.getRoom(roomId);
			if (!room) {
				logger.debug(
					{ src: "service:channel_topics", roomId },
					`${LOG_PREFIX} room not found; skipping topic persistence`,
				);
				return;
			}
			const updated: Room = {
				...room,
				metadata: {
					...room.metadata,
					[CHANNEL_TOPICS_METADATA_KEY]: topics,
				},
			};
			await this.runtime.updateRoom(updated);
		} catch (error) {
			logger.warn(
				{ src: "service:channel_topics", roomId, err: error },
				`${LOG_PREFIX} persist topics to room metadata failed`,
			);
		}
	}

	/**
	 * Record newly-extracted topics for a room: hydrate (first touch) → apply to
	 * the LRU (dedupe + FIFO evict) → persist to room metadata. A no-op when
	 * `topics` is empty. Never throws — safe to fire-and-forget from the loop.
	 */
	async recordTopics(roomId: UUID, topics: string[]): Promise<void> {
		if (!roomId || !Array.isArray(topics) || topics.length === 0) {
			return;
		}
		try {
			await this.hydrateRoom(roomId);
			const next = this.applyTopics(roomId, topics);
			await this.persistRoom(roomId, next);
		} catch (error) {
			// Belt-and-suspenders: the inner helpers already swallow, but the
			// public entry point must NEVER throw into the turn.
			logger.warn(
				{ src: "service:channel_topics", roomId, err: error },
				`${LOG_PREFIX} recordTopics failed`,
			);
		}
	}

	/**
	 * Synchronous accessor for a room's current LRU, most-recent last. Returns a
	 * defensive copy (mutating it does not affect the cache). Returns the
	 * cached list only — call {@link recordTopics} to hydrate from metadata. The
	 * `CHANNEL_TOPICS` provider drives hydration via {@link ensureHydrated}.
	 */
	getTopicsForRoom(roomId: UUID): string[] {
		const topics = this.topicsByRoom.get(roomId);
		return topics ? [...topics] : [];
	}

	/**
	 * Hydrate a room from metadata if not already done, then return its LRU.
	 * Async variant used by read paths (e.g. the provider) that need the
	 * persisted state on a cold cache (after restart).
	 */
	async ensureHydrated(roomId: UUID): Promise<string[]> {
		await this.hydrateRoom(roomId);
		return this.getTopicsForRoom(roomId);
	}

	/**
	 * Snapshot of every room's LRU currently in memory. Each list is a
	 * defensive copy. Reflects only rooms touched since process start (plus
	 * whatever was hydrated on access).
	 */
	getTopicsForAllRooms(): Record<string, string[]> {
		const out: Record<string, string[]> = {};
		for (const [roomId, topics] of this.topicsByRoom.entries()) {
			out[roomId] = [...topics];
		}
		return out;
	}
}

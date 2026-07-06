/**
 * NotificationService
 *
 * The single runtime seam for producing user-facing notifications. Any code
 * with a runtime handle — an action, a scheduled-task dispatcher, a workflow
 * completion hook, an orchestrator event — calls `notify(...)`. The service:
 *
 *   1. stamps a canonical `AgentNotification`,
 *   2. persists it to a durable inbox (DB-backed runtime cache; survives
 *      restart), collapsing by `groupKey`,
 *   3. fans it out live on the agent event bus as `stream: "notification"`,
 *      which the server already forwards over WebSocket to every client.
 *
 * Clients (in-app center, toast, desktop OS, mobile native) render FROM the
 * one shape. The inbox is the source of truth for history + unread state; live
 * fan-out is best-effort (a headless runtime with no event bus still records
 * notifications and serves them over the HTTP inbox API).
 */

import { logger } from "../logger.ts";
import {
	type AgentNotification,
	DEFAULT_NOTIFICATION_CATEGORY,
	DEFAULT_NOTIFICATION_SOURCE,
	defaultPriorityForCategory,
	NOTIFICATION_COUNT_KEY,
	NOTIFICATION_STREAM,
	type NotificationEventData,
	type NotificationInput,
	type NotificationPriority,
	type NotificationQuery,
	SILENT_TIER_DEFAULT_EXPIRY_MS,
	tierForPriority,
} from "../types/notification.ts";
import { asUUID, type UUID } from "../types/primitives.ts";
import type { IAgentRuntime } from "../types/runtime.ts";
import { Service, ServiceType } from "../types/service.ts";

/** Max notifications retained per agent in the inbox (oldest evicted). */
const MAX_NOTIFICATIONS = 300;

/**
 * True once a notification's explicit `expiresAt` (unix ms) has passed. Only
 * caller-set expiry is honored — there is no per-category default retention.
 */
function isExpired(n: AgentNotification, now: number): boolean {
	return n.expiresAt != null && n.expiresAt <= now;
}

/** Minimal structural view of the event bus we publish onto. */
interface EventBusLike {
	emit: (event: {
		runId: string;
		stream: string;
		data: Record<string, unknown>;
		agentId?: string;
	}) => void;
}

function isEventBus(value: unknown): value is EventBusLike {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as EventBusLike).emit === "function"
	);
}

/** Generate a fresh notification id. */
function newNotificationId(): UUID {
	return asUUID(crypto.randomUUID());
}

export class NotificationService extends Service {
	static serviceType: string = ServiceType.NOTIFICATION;
	capabilityDescription =
		"Creates, persists, and fans out user-facing notifications across every client surface";

	/** Newest-last ordered list (mirrors the persisted store). */
	private notifications: AgentNotification[] = [];

	/** Resolved cache key (scoped per agent). */
	private get cacheKey(): string {
		return `notifications:${this.runtime.agentId}`;
	}

	static async start(runtime: IAgentRuntime): Promise<Service> {
		const service = new NotificationService(runtime);
		await service.hydrate();
		logger.debug(
			{ src: "service:notification", count: service.notifications.length },
			"NotificationService started",
		);
		return service;
	}

	async stop(): Promise<void> {
		this.notifications = [];
	}

	/** Load persisted notifications from the DB-backed cache. */
	private async hydrate(): Promise<void> {
		try {
			const stored = await this.runtime.getCache<AgentNotification[]>(
				this.cacheKey,
			);
			if (Array.isArray(stored)) {
				const now = Date.now();
				this.notifications = stored
					.filter((n) => n && typeof n.id === "string" && n.title)
					.filter((n) => !isExpired(n, now))
					.slice(-MAX_NOTIFICATIONS);
			}
		} catch (error) {
			// A cold/headless runtime may have no cache adapter yet; start empty.
			logger.debug(
				{ src: "service:notification", error },
				"No persisted notifications to hydrate",
			);
		}
	}

	private async persist(): Promise<void> {
		await this.runtime.setCache(this.cacheKey, this.notifications);
	}

	/**
	 * Create, persist, and broadcast a notification. Returns the stamped record.
	 */
	async notify(input: NotificationInput): Promise<AgentNotification> {
		const title = input.title?.trim();
		if (!title) {
			throw new Error("[NotificationService] notification.title is required");
		}

		const category = input.category ?? DEFAULT_NOTIFICATION_CATEGORY;
		// §C.1: an explicit priority always wins; otherwise the category names the
		// tier (approval→interrupt, task/workflow→digest, system→silent).
		const priority: NotificationPriority =
			input.priority ?? defaultPriorityForCategory(category);

		const createdAt = Date.now();
		const groupKey = input.groupKey;

		// Drop any entries whose explicit expiry has passed before we inspect the
		// group for supersede/count — an expired prior must not seed a new count.
		this.notifications = this.notifications.filter(
			(n) => !isExpired(n, createdAt),
		);

		// §C.3 Count-aware supersede: a same-groupKey notify replaces the prior
		// record and carries the coalesced count so the row can render "3 new
		// files" instead of the last event silently eating the earlier ones. The
		// producer may set data.count explicitly to override the auto-increment.
		let superseded: AgentNotification | undefined;
		if (groupKey) {
			superseded = this.notifications.find((n) => n.groupKey === groupKey);
			this.notifications = this.notifications.filter(
				(n) => n.groupKey !== groupKey,
			);
		}
		const data = this.resolveCoalescedData(input.data, superseded);

		// §C.1 Silent-tier default expiry: a `low` (silent) notification with no
		// producer-set expiry ages out after 24h so the inbox self-cleans.
		// Interrupt/digest tiers never default an expiry (an unread approval must
		// not evaporate).
		let expiresAt = input.expiresAt;
		if (expiresAt === undefined && tierForPriority(priority) === "silent") {
			expiresAt = createdAt + SILENT_TIER_DEFAULT_EXPIRY_MS;
		}

		const notification: AgentNotification = {
			id: newNotificationId(),
			title,
			body: input.body?.trim() || undefined,
			category,
			priority,
			source: input.source ?? DEFAULT_NOTIFICATION_SOURCE,
			deepLink: input.deepLink,
			icon: input.icon,
			groupKey,
			data,
			createdAt,
			readAt: null,
			expiresAt,
			agentId: input.agentId ?? (this.runtime.agentId as UUID),
		};

		this.notifications.push(notification);
		if (this.notifications.length > MAX_NOTIFICATIONS) {
			this.notifications = this.notifications.slice(-MAX_NOTIFICATIONS);
		}

		// Fan out live before awaiting the DB write so clients aren't gated on disk.
		this.broadcast(notification);

		await this.persist();
		logger.debug(
			{
				src: "service:notification",
				id: notification.id,
				category: notification.category,
				priority: notification.priority,
			},
			`[NotificationService] ${notification.source}: ${notification.title}`,
		);
		return notification;
	}

	private broadcast(
		notification: AgentNotification,
		type: NotificationEventData["type"] = "notification",
	): void {
		const bus = this.runtime.getService(ServiceType.AGENT_EVENT);
		if (!isEventBus(bus)) {
			return; // No live bus (headless/test) — inbox API still serves it.
		}
		const data: NotificationEventData = {
			type,
			notification,
			unreadCount: this.getUnreadCount(),
		};
		bus.emit({
			runId: notification.id,
			stream: NOTIFICATION_STREAM,
			data,
			agentId: notification.agentId,
		});
	}

	/** List notifications, newest first, with optional filtering. */
	list(query: NotificationQuery = {}): AgentNotification[] {
		const now = Date.now();
		let result = [...this.notifications]
			.filter((n) => !isExpired(n, now))
			.reverse();
		if (query.unreadOnly) {
			result = result.filter((n) => !n.readAt);
		}
		if (query.category) {
			result = result.filter((n) => n.category === query.category);
		}
		if (typeof query.limit === "number" && query.limit >= 0) {
			result = result.slice(0, query.limit);
		}
		return result;
	}

	getUnreadCount(): number {
		const now = Date.now();
		let count = 0;
		for (const n of this.notifications) {
			// §C.1 Silent tier (`low`) is inbox-only with no badge weight.
			if (!n.readAt && n.priority !== "low" && !isExpired(n, now)) count++;
		}
		return count;
	}

	/**
	 * Compute the `data` for a notification that may be coalescing onto a prior
	 * same-`groupKey` record (§C.3). A producer-set `data.count` always wins; a
	 * bare supersede increments the surviving count (prior `count`, defaulting to
	 * 1, plus one). A first (un-superseded) notification carries no count key.
	 */
	private resolveCoalescedData(
		inputData: AgentNotification["data"],
		superseded: AgentNotification | undefined,
	): AgentNotification["data"] {
		const producerCount = inputData?.[NOTIFICATION_COUNT_KEY];
		// Producer stated the count explicitly — honor it verbatim.
		if (typeof producerCount === "number") {
			return inputData;
		}
		// No supersede — nothing to coalesce; leave data untouched (no count key).
		if (!superseded) {
			return inputData;
		}
		const priorCount = superseded.data?.[NOTIFICATION_COUNT_KEY];
		const nextCount = (typeof priorCount === "number" ? priorCount : 1) + 1;
		return { ...(inputData ?? {}), [NOTIFICATION_COUNT_KEY]: nextCount };
	}

	/** Mark one notification read. Returns true if it existed and changed. */
	async markRead(id: string): Promise<boolean> {
		const notification = this.notifications.find((n) => n.id === id);
		if (!notification || notification.readAt) {
			return false;
		}
		notification.readAt = Date.now();
		await this.persist();
		return true;
	}

	/**
	 * §C.5 Acted-upon auto-read: mark every unread notification pointing at a
	 * given `groupKey` read, without removing it (read is history, not deletion).
	 * A producer whose action completed — an approval approved, a task opened —
	 * calls this so the inbox never nags about a done thing. Returns the number of
	 * records changed (0 for an unknown/already-read group). Never reorders the
	 * inbox (§C.2): read state styles rows but does not move them.
	 */
	async markReadByGroupKey(groupKey: string): Promise<number> {
		if (!groupKey) {
			return 0;
		}
		const now = Date.now();
		const changedNotifications: AgentNotification[] = [];
		for (const n of this.notifications) {
			if (n.groupKey === groupKey && !n.readAt) {
				n.readAt = now;
				changedNotifications.push(n);
			}
		}
		if (changedNotifications.length > 0) {
			await this.persist();
			for (const n of changedNotifications) {
				// Push a non-interruptive update so open clients clear unread state without
				// re-toasting/re-alerting the notification that just became read.
				this.broadcast(n, "notification_update");
			}
		}
		return changedNotifications.length;
	}

	/** Mark every notification read. Returns the number changed. */
	async markAllRead(): Promise<number> {
		let changed = 0;
		const now = Date.now();
		for (const n of this.notifications) {
			if (!n.readAt) {
				n.readAt = now;
				changed++;
			}
		}
		if (changed > 0) {
			await this.persist();
		}
		return changed;
	}

	/** Remove one notification. Returns true if it existed. */
	async remove(id: string): Promise<boolean> {
		const before = this.notifications.length;
		this.notifications = this.notifications.filter((n) => n.id !== id);
		const removed = this.notifications.length !== before;
		if (removed) {
			await this.persist();
		}
		return removed;
	}

	/** Clear the entire inbox. */
	async clear(): Promise<void> {
		this.notifications = [];
		await this.persist();
	}
}

export default NotificationService;

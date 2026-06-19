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
	DEFAULT_NOTIFICATION_PRIORITY,
	DEFAULT_NOTIFICATION_SOURCE,
	NOTIFICATION_STREAM,
	type NotificationEventData,
	type NotificationInput,
	type NotificationQuery,
} from "../types/notification.ts";
import { asUUID, type UUID } from "../types/primitives.ts";
import type { IAgentRuntime } from "../types/runtime.ts";
import { Service, ServiceType } from "../types/service.ts";

/** Max notifications retained per agent in the inbox (oldest evicted). */
const MAX_NOTIFICATIONS = 300;

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
				this.notifications = stored
					.filter((n) => n && typeof n.id === "string" && n.title)
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

		const notification: AgentNotification = {
			id: newNotificationId(),
			title,
			body: input.body?.trim() || undefined,
			category: input.category ?? DEFAULT_NOTIFICATION_CATEGORY,
			priority: input.priority ?? DEFAULT_NOTIFICATION_PRIORITY,
			source: input.source ?? DEFAULT_NOTIFICATION_SOURCE,
			deepLink: input.deepLink,
			icon: input.icon,
			groupKey: input.groupKey,
			data: input.data,
			createdAt: Date.now(),
			readAt: null,
			agentId: input.agentId ?? (this.runtime.agentId as UUID),
		};

		// Collapse by groupKey: a newer notification supersedes an older one for
		// the same logical thing instead of stacking duplicates.
		if (notification.groupKey) {
			this.notifications = this.notifications.filter(
				(n) => n.groupKey !== notification.groupKey,
			);
		}
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

	private broadcast(notification: AgentNotification): void {
		const bus = this.runtime.getService(ServiceType.AGENT_EVENT);
		if (!isEventBus(bus)) {
			return; // No live bus (headless/test) — inbox API still serves it.
		}
		const data: NotificationEventData = {
			type: "notification",
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
		let result = [...this.notifications].reverse();
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
		let count = 0;
		for (const n of this.notifications) {
			if (!n.readAt) count++;
		}
		return count;
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

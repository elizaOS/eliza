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

const RECOVERY_BASE_DELAY_MS = 1_000;
const RECOVERY_MAX_DELAY_MS = 30_000;

export type NotificationServiceAvailability =
	| "disabled"
	| "pending"
	| "registering"
	| "failed"
	| "registered";

export interface NotificationServiceRecovery {
	state: "started" | "in-flight" | "backoff" | "unavailable";
	retryAfterSeconds: number;
}

/** Runtime lifecycle surface required by notification transports. */
export interface NotificationServiceLifecycleRuntime {
	readonly agentId?: string;
	reportError(
		scope: string,
		error: unknown,
		context?: Record<string, unknown>,
	): void;
	getService(serviceType: string): unknown;
	hasService(serviceType: string): boolean;
	getServiceRegistrationStatus(
		serviceType: string,
	): "pending" | "registering" | "registered" | "failed" | "unknown";
	getServiceLoadPromise(serviceType: string): Promise<Service>;
}

interface NotificationRecoveryState {
	failures: number;
	nextAttemptAt: number;
	inFlight: Promise<NotificationService | null> | null;
}

const recoveryByRuntime = new WeakMap<
	NotificationServiceLifecycleRuntime,
	NotificationRecoveryState
>();
const availabilityByRuntime = new WeakMap<
	NotificationServiceLifecycleRuntime,
	NotificationServiceAvailability
>();

function retryAfterSeconds(delayMs: number): number {
	return Math.max(1, Math.ceil(delayMs / 1_000));
}

function recoveryDelayMs(failures: number): number {
	return Math.min(
		RECOVERY_MAX_DELAY_MS,
		RECOVERY_BASE_DELAY_MS * 2 ** Math.max(0, failures - 1),
	);
}

function recordAvailability(
	runtime: NotificationServiceLifecycleRuntime,
	availability: NotificationServiceAvailability,
): NotificationServiceAvailability {
	if (availabilityByRuntime.get(runtime) === availability) return availability;
	availabilityByRuntime.set(runtime, availability);
	const context = {
		src: "service:notification",
		agentId: runtime.agentId,
		availability,
	};
	if (availability === "failed") {
		logger.warn(
			context,
			"NotificationService unavailable after startup failure",
		);
	} else if (availability === "disabled") {
		logger.info(context, "NotificationService intentionally disabled");
	} else {
		logger.debug(context, "NotificationService availability changed");
	}
	return availability;
}

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

	/**
	 * Resolve the runtime lifecycle state without treating a failed instance as
	 * an intentionally empty inbox. A registered class with no live instance is
	 * fail-closed even if the runtime reports an inconsistent `registered` state.
	 */
	static getAvailability(
		runtime: NotificationServiceLifecycleRuntime,
	): NotificationServiceAvailability {
		const service = runtime.getService(ServiceType.NOTIFICATION);
		if (service instanceof NotificationService) {
			recoveryByRuntime.delete(runtime);
			return recordAvailability(runtime, "registered");
		}
		if (!runtime.hasService(ServiceType.NOTIFICATION)) {
			return recordAvailability(runtime, "disabled");
		}
		const status = runtime.getServiceRegistrationStatus(
			ServiceType.NOTIFICATION,
		);
		if (status === "pending" || status === "registering") {
			return recordAvailability(runtime, status);
		}
		if (status === "failed" || status === "registered") {
			return recordAvailability(runtime, "failed");
		}
		return recordAvailability(runtime, "pending");
	}

	/**
	 * Start one background recovery attempt after a failed hydration. The
	 * runtime already deduplicates concurrent service starts; this coordinator
	 * adds a bounded cooldown so repeated HTTP and Android requests cannot turn
	 * a persistent adapter outage into a retry stampede.
	 */
	static requestRecovery(
		runtime: NotificationServiceLifecycleRuntime,
	): NotificationServiceRecovery {
		const existing = recoveryByRuntime.get(runtime);
		if (existing?.inFlight) {
			return { state: "in-flight", retryAfterSeconds: 1 };
		}
		if (NotificationService.getAvailability(runtime) !== "failed") {
			return { state: "unavailable", retryAfterSeconds: 1 };
		}

		const now = Date.now();
		if (existing && existing.nextAttemptAt > now) {
			return {
				state: "backoff",
				retryAfterSeconds: retryAfterSeconds(existing.nextAttemptAt - now),
			};
		}

		const recovery: NotificationRecoveryState = existing ?? {
			failures: 0,
			nextAttemptAt: 0,
			inFlight: null,
		};
		const attempt = recovery.failures + 1;
		const inFlight = runtime
			.getServiceLoadPromise(ServiceType.NOTIFICATION)
			.then((service) => {
				if (!(service instanceof NotificationService)) {
					throw new Error(
						"Recovered notification service has an unexpected implementation",
					);
				}
				recoveryByRuntime.delete(runtime);
				recordAvailability(runtime, "registered");
				logger.info(
					{
						src: "service:notification",
						agentId: runtime.agentId,
						attempt,
					},
					"NotificationService recovery succeeded",
				);
				return service;
			})
			// error-policy:J7 service recovery telemetry must not turn a handled
			// background retry failure into an unhandled rejection.
			.catch((error: unknown) => {
				const failures = recovery.failures + 1;
				const delayMs = recoveryDelayMs(failures);
				recovery.failures = failures;
				recovery.nextAttemptAt = Date.now() + delayMs;
				runtime.reportError("NotificationService.recovery", error, {
					attempt,
					retryAfterSeconds: retryAfterSeconds(delayMs),
				});
				logger.warn(
					{
						src: "service:notification",
						agentId: runtime.agentId,
						attempt,
						retryAfterSeconds: retryAfterSeconds(delayMs),
						error: error instanceof Error ? error.message : String(error),
					},
					"NotificationService recovery failed; backing off",
				);
				return null;
			})
			.finally(() => {
				recovery.inFlight = null;
			});
		recovery.inFlight = inFlight;
		recoveryByRuntime.set(runtime, recovery);
		logger.info(
			{
				src: "service:notification",
				agentId: runtime.agentId,
				attempt,
			},
			"NotificationService recovery started",
		);
		return { state: "started", retryAfterSeconds: 1 };
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

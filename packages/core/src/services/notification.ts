/**
 * NotificationService
 *
 * The single runtime seam for producing user-facing notifications. Any code
 * with a runtime handle — an action, a scheduled-task dispatcher, a workflow
 * completion hook, an orchestrator event — calls `notify(...)`. The service:
 *
 * 1. stamps a canonical `AgentNotification`,
 * 2. persists it to a durable inbox (DB-backed runtime cache; survives
 * restart), collapsing by `groupKey`,
 * 3. fans it out live on the agent event bus as `stream: "notification"`,
 * which the server already forwards over WebSocket to every client.
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
	NATIVE_NOTIFICATION_PAGE_BYTES,
	NATIVE_NOTIFICATION_PAGE_LIMIT,
	NATIVE_NOTIFICATION_RECORD_BYTES,
	type NativeNotification,
	type NativeNotificationPage,
	type NativeNotificationQuery,
	NOTIFICATION_COUNT_KEY,
	NOTIFICATION_STREAM,
	type NotificationEventData,
	type NotificationInboxSnapshot,
	type NotificationInput,
	type NotificationPriority,
	type NotificationQuery,
	SILENT_TIER_DEFAULT_EXPIRY_MS,
	tierForPriority,
} from "../types/notification.ts";
import { asUUID, type UUID } from "../types/primitives.ts";
import type { IAgentRuntime } from "../types/runtime.ts";
import { Service, ServiceType } from "../types/service.ts";

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

/** Typed native protocol errors are translated by the HTTP owner. */
export class NotificationNativeError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 400,
	) {
		super(message);
		this.name = "NotificationNativeError";
	}
}

export class NotificationService extends Service {
	static serviceType: string = ServiceType.NOTIFICATION;
	capabilityDescription =
		"Creates, persists, and fans out user-facing notifications across every client surface";

	/** Newest-last ordered list (mirrors the persisted store). */
	private notifications: AgentNotification[] = [];
	private nativeEpoch: string = crypto.randomUUID();
	private nativeSequence = 0;
	private nativeSequences: Record<string, number> = {};
	private persistenceUncertain = false;
	private notificationWriteTail: Promise<void> = Promise.resolve();
	/**
	 * Set once {@link stop} begins. Write admission closes immediately so a
	 * caller racing after teardown receives an explicit failure instead of a
	 * silently accepted mutation that could outlive the service.
	 */
	private stopped = false;

	/** Serialize every mutation of the shared inbox and its durable snapshot. */
	private enqueueWrite<T>(write: () => Promise<T>): Promise<T> {
		if (this.stopped) {
			// Teardown has begun; a write admitted now could persist and fan out
			// after the service reports it is stopped. Fail explicitly instead.
			return Promise.reject(
				new Error(
					"[NotificationService] notification write rejected: service is stopped",
				),
			);
		}
		const admitted = async () => {
			// An unreadable ambiguous commit cannot authorize a later overwrite or fence.
			if (this.persistenceUncertain) await this.reconcilePersistFailure();
			return write();
		};
		const operation = this.notificationWriteTail.then(admitted, admitted);
		// error-policy:J5 the caller observes `operation`; the tail converts either
		// outcome to completion so a rejected write cannot poison later mutations.
		this.notificationWriteTail = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

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
		// Close write admission first: any caller racing this teardown from now
		// on receives an explicit rejection instead of a silently accepted
		// mutation that could persist after the service reports it stopped.
		this.stopped = true;
		// Drain the serialized durable-write tail so a notification accepted
		// before shutdown finishes persisting (and broadcasting) BEFORE the
		// service reports teardown complete. error-policy:J5 — the tail never
		// rejects, but await defensively so a future tail change cannot leak an
		// unhandled rejection out of stop().
		await this.notificationWriteTail.catch(() => undefined);
		this.notifications = [];
	}

	/** Load/migrate the single persisted inbox before publishing readiness. */
	private async hydrate(): Promise<void> {
		const stored = await this.runtime.getCache<unknown>(this.cacheKey);
		if (stored == null || Array.isArray(stored)) {
			// Legacy insertion order is the durable order; timestamps never become a fence.
			this.notifications = Array.isArray(stored)
				? stored.filter((n) => n && typeof n.id === "string" && n.title)
				: [];
			for (const n of this.notifications) {
				if (Object.hasOwn(this.nativeSequences, n.id)) {
					throw new NotificationNativeError(
						"NOTIFICATION_INBOX_INVALID",
						"Duplicate persisted notification id",
						503,
					);
				}
				this.nativeSequences[n.id] = ++this.nativeSequence;
			}
			await this.persist();
		} else {
			this.restore(stored);
		}
	}

	private snapshot(): NotificationInboxSnapshot {
		const nativeSequences: Record<string, number> = {};
		for (const n of this.notifications)
			nativeSequences[n.id] = this.nativeSequences[n.id];
		return {
			version: 2,
			notifications: this.notifications,
			nativeEpoch: this.nativeEpoch,
			nativeSequence: this.nativeSequence,
			nativeSequences,
		};
	}

	private restore(value: unknown): void {
		const invalid = () =>
			new NotificationNativeError(
				"NOTIFICATION_INBOX_INVALID",
				"Invalid persisted notification coordinates",
				503,
			);
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw invalid();
		const state = value as NotificationInboxSnapshot;
		if (
			state.version !== 2 ||
			typeof state.nativeEpoch !== "string" ||
			!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
				state.nativeEpoch,
			) ||
			!Number.isSafeInteger(state.nativeSequence) ||
			state.nativeSequence < 0 ||
			!Array.isArray(state.notifications) ||
			!state.nativeSequences ||
			typeof state.nativeSequences !== "object" ||
			Array.isArray(state.nativeSequences) ||
			Object.keys(state.nativeSequences).length !== state.notifications.length
		)
			throw invalid();
		let previous = 0;
		for (const n of state.notifications) {
			if (
				!n ||
				typeof n.id !== "string" ||
				!n.title ||
				!Object.hasOwn(state.nativeSequences, n.id)
			)
				throw invalid();
			const sequence = state.nativeSequences[n.id];
			if (
				!Number.isSafeInteger(sequence) ||
				sequence <= previous ||
				sequence > state.nativeSequence
			)
				throw invalid();
			previous = sequence;
		}
		this.notifications = state.notifications;
		this.nativeEpoch = state.nativeEpoch;
		this.nativeSequence = state.nativeSequence;
		this.nativeSequences = state.nativeSequences;
	}

	private async persist(): Promise<void> {
		const state = this.snapshot();
		if (!(await this.runtime.setCache(this.cacheKey, state))) {
			throw new Error(
				"[NotificationService] notification cache persistence was rejected",
			);
		}
		this.nativeSequences = state.nativeSequences;
	}

	private async reconcilePersistFailure(): Promise<void> {
		this.persistenceUncertain = true;
		const stored = await this.runtime.getCache<unknown>(this.cacheKey);
		// Startup persisted version2 before any writes. Missing/legacy state after
		// that boundary is data loss or a competing old writer, not an empty inbox.
		if (stored == null) {
			throw new NotificationNativeError(
				"NOTIFICATION_INBOX_INVALID",
				"Notification snapshot disappeared",
				503,
			);
		}
		this.restore(stored);
		this.persistenceUncertain = false;
	}

	private async failAfterMutationPersistence(cause: unknown): Promise<never> {
		try {
			await this.reconcilePersistFailure();
		} catch (reconcileCause) {
			throw new AggregateError(
				[cause, reconcileCause],
				"notification persistence and reconciliation failed",
			);
		}
		throw cause;
	}

	/**
	 * Create, persist, and broadcast a notification. Returns the stamped record.
	 */
	async notify(input: NotificationInput): Promise<AgentNotification> {
		return this.enqueueWrite(() => this.notifySerialized(input, true));
	}

	/**
	 * Compatibility boundary for exact import owners. The inbox retains all
	 * notifications, so this has the same lossless behavior as {@link notify}.
	 */
	async notifyWithoutEviction(
		input: NotificationInput,
	): Promise<AgentNotification> {
		return this.enqueueWrite(() => this.notifySerialized(input, true));
	}

	/**
	 * Verify or replace one grouped projection within the inbox write queue.
	 * This is the quiescent seam for durable owners that retry after an earlier
	 * fire-and-forget projection may still be settling.
	 */
	async ensureGroupedNotification(
		input: NotificationInput & { groupKey: string },
		isExact: (notification: AgentNotification) => boolean,
	): Promise<AgentNotification> {
		return this.enqueueWrite(async () => {
			const grouped = this.notifications.filter(
				(entry) => entry.groupKey === input.groupKey,
			);
			if (grouped.length === 1 && isExact(grouped[0]))
				return this.withNativeCoordinates(grouped[0]);
			return this.notifySerialized(input, false);
		});
	}

	private async notifySerialized(
		input: NotificationInput,
		coalesceGroup: boolean,
	): Promise<AgentNotification> {
		const previousNotifications = this.snapshot();
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
		const data = this.resolveCoalescedData(
			input.data,
			coalesceGroup ? superseded : undefined,
		);

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
			body: input.body?.trim()
				? category === "reminder" && input.source === "lifeops"
					? input.body
					: input.body.trim()
				: undefined,
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

		if (this.nativeSequence >= Number.MAX_SAFE_INTEGER) {
			this.restore(previousNotifications);
			throw new NotificationNativeError(
				"NOTIFICATION_SEQUENCE_EXHAUSTED",
				"Notification sequence exhausted",
				503,
			);
		}
		this.nativeSequences = {
			...this.nativeSequences,
			[notification.id]: ++this.nativeSequence,
		};
		this.notifications = [...this.notifications, notification];

		try {
			await this.persist();
		} catch (error) {
			try {
				await this.reconcilePersistFailure();
			} catch (reconcileError) {
				// error-policy:J2 preserve both the write ambiguity and failed
				// authoritative reconciliation for the receipt-owning caller.
				throw new AggregateError(
					[error, reconcileError],
					"notification persistence and reconciliation failed",
				);
			}
			throw error;
		}
		// Durable inbox state is authoritative. Fan out only after persistence so
		// a failed write cannot expose a ghost success to live clients.
		this.broadcast(notification);
		logger.debug(
			{
				src: "service:notification",
				id: notification.id,
				category: notification.category,
				priority: notification.priority,
			},
			`[NotificationService] ${notification.source}: ${notification.title}`,
		);
		return this.withNativeCoordinates(notification);
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
			notification: this.withNativeCoordinates(notification),
			unreadCount: this.getUnreadCount(),
		};
		try {
			data.nativeNotification = this.projectNative(notification);
		} catch (error) {
			if (!(error instanceof NotificationNativeError)) throw error;
			data.nativeProjectionError = {
				code: error.code,
				notificationId: notification.id,
				nativeEpoch: this.nativeEpoch,
				nativeSequence: this.nativeSequences[notification.id],
			};
			this.runtime.reportError("NotificationService.nativeProjection", error, {
				notificationId: notification.id,
			});
		}
		try {
			bus.emit({
				runId: notification.id,
				stream: NOTIFICATION_STREAM,
				data,
				agentId: notification.agentId,
			});
		} catch (error) {
			// error-policy:J7 durable notification success must not be reversed by
			// a diagnostic/live-fanout observer failure.
			this.runtime.reportError("NotificationService.broadcast", error, {
				notificationId: notification.id,
			});
			logger.warn(
				{ error, notificationId: notification.id },
				"[NotificationService] live fan-out failed after durable persistence",
			);
		}
	}

	private withNativeCoordinates(n: AgentNotification): AgentNotification {
		return {
			...n,
			nativeEpoch: this.nativeEpoch,
			nativeSequence: this.nativeSequences[n.id],
		};
	}

	/** Closed native projection shared by live events and native inbox pages. */
	private projectNative(n: AgentNotification): NativeNotification {
		const record: NativeNotification = {
			id: n.id,
			title: n.title,
			body: n.body ?? "",
			category: n.category,
			priority: n.priority,
			createdAt: n.createdAt,
			readAt: n.readAt ?? null,
			expiresAt: n.expiresAt ?? null,
			nativeEpoch: this.nativeEpoch,
			nativeSequence: this.nativeSequences[n.id],
		};
		// Navigation is a closed presentation route; producer URLs and credentials never cross.
		if (
			n.deepLink &&
			[
				"/chat",
				"/automations",
				"/clock",
				"/notes",
				"/calendar",
				"/reminders",
				"/tasks",
				"/apps/tasks",
			].includes(n.deepLink)
		)
			record.deepLink = n.deepLink;
		if (n.groupKey != null) record.groupKey = n.groupKey;
		const data: NonNullable<NativeNotification["data"]> = {};
		if (n.data?.ownerType === "clock" || n.data?.ownerType === "reminder")
			data.ownerType = n.data.ownerType;
		for (const field of ["conversationId", "messageId"] as const) {
			const id = n.data?.[field];
			if (
				typeof id === "string" &&
				/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
					id,
				)
			)
				data[field] = id;
		}
		if (Object.keys(data).length) record.data = data;
		if (
			record.title.length > 512 ||
			record.body.length > 4096 ||
			record.title.includes("\0") ||
			record.body.includes("\0") ||
			(record.groupKey != null &&
				(record.groupKey.length > 512 ||
					[...record.groupKey].some(
						(char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
					))) ||
			new TextEncoder().encode(JSON.stringify(record)).byteLength >
				NATIVE_NOTIFICATION_RECORD_BYTES
		) {
			throw new NotificationNativeError(
				"NATIVE_NOTIFICATION_RECORD_TOO_LARGE",
				"Notification cannot fit the native record contract",
				413,
			);
		}
		return record;
	}

	/** A page waits for durable writes; its append fence stays fixed across later requests.
	 * Deletion/read/expiry can change between pages. No filtered subset may close a sequence gap. */
	async listNativePage(
		query: NativeNotificationQuery = {},
	): Promise<NativeNotificationPage> {
		await this.notificationWriteTail;
		if (this.persistenceUncertain || this.stopped)
			throw new NotificationNativeError(
				"NOTIFICATION_INBOX_UNAVAILABLE",
				"Notification inbox is not durably available",
				503,
			);
		const after = query.afterSequence ?? 0,
			through = query.throughSequence ?? this.nativeSequence;
		const limit = query.limit ?? NATIVE_NOTIFICATION_PAGE_LIMIT;
		if (
			![after, through].every(
				(value) => Number.isSafeInteger(value) && value >= 0,
			) ||
			through < after ||
			through > this.nativeSequence ||
			!Number.isSafeInteger(limit) ||
			limit < 1 ||
			limit > NATIVE_NOTIFICATION_PAGE_LIMIT ||
			((after > 0 || query.throughSequence != null) && !query.nativeEpoch)
		) {
			throw new NotificationNativeError(
				"INVALID_NATIVE_NOTIFICATION_CURSOR",
				"Invalid native notification cursor or limit",
			);
		}
		if (query.nativeEpoch != null && query.nativeEpoch !== this.nativeEpoch)
			throw new NotificationNativeError(
				"NATIVE_NOTIFICATION_EPOCH_CHANGED",
				"Notification inbox epoch changed",
				409,
			);
		const page: NativeNotificationPage = {
			notifications: [],
			nativeEpoch: this.nativeEpoch,
			throughSequence: through,
			nextSequence: through,
			complete: true,
			unreadCount: this.getUnreadCount(),
			serviceStatus: "ready",
		};
		for (const n of this.notifications) {
			const sequence = this.nativeSequences[n.id];
			if (sequence <= after || sequence > through) continue;
			if (page.notifications.length >= limit) {
				page.complete = false;
				break;
			}
			const projected = this.projectNative(n);
			page.notifications.push(projected);
			// Include the complete envelope in the encoded budget, not just the row array.
			if (
				new TextEncoder().encode(JSON.stringify(page)).byteLength + 1 >
				NATIVE_NOTIFICATION_PAGE_BYTES
			) {
				page.notifications.pop();
				if (!page.notifications.length)
					throw new NotificationNativeError(
						"NATIVE_NOTIFICATION_RECORD_TOO_LARGE",
						"Notification cannot fit a native page",
						413,
					);
				page.complete = false;
				break;
			}
		}
		if (!page.complete)
			page.nextSequence =
				page.notifications[page.notifications.length - 1].nativeSequence;
		if (!page.complete && page.nextSequence <= after)
			throw new NotificationNativeError(
				"INVALID_NATIVE_NOTIFICATION_CURSOR",
				"Native page did not advance",
				503,
			);
		return page;
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
		return result.map((n) => this.withNativeCoordinates(n));
	}

	/**
	 * Enumerate the persisted inbox without applying wall-clock expiry filters.
	 * Lifecycle owners use this boundary for exact cleanup and residue proofs;
	 * user-facing inbox reads should continue to call {@link list}.
	 */
	listIncludingExpired(): AgentNotification[] {
		return [...this.notifications]
			.reverse()
			.map((n) => this.withNativeCoordinates(n));
	}

	/** The lossless inbox has no item-count capacity boundary. */
	getAvailableCapacity(): number {
		return Number.POSITIVE_INFINITY;
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
		return this.enqueueWrite(() => this.markReadSerialized(id));
	}

	private async markReadSerialized(id: string): Promise<boolean> {
		const notification = this.notifications.find((n) => n.id === id);
		if (!notification || notification.readAt) {
			return false;
		}
		this.notifications = this.notifications.map((entry) =>
			entry.id === id ? { ...entry, readAt: Date.now() } : entry,
		);
		try {
			await this.persist();
		} catch (error) {
			return this.failAfterMutationPersistence(error);
		}
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
		return this.enqueueWrite(() => this.markReadByGroupKeySerialized(groupKey));
	}

	private async markReadByGroupKeySerialized(
		groupKey: string,
	): Promise<number> {
		if (!groupKey) {
			return 0;
		}
		const now = Date.now();
		const changedNotifications: AgentNotification[] = [];
		this.notifications = this.notifications.map((entry) => {
			if (entry.groupKey !== groupKey || entry.readAt) return entry;
			const changed = { ...entry, readAt: now };
			changedNotifications.push(changed);
			return changed;
		});
		if (changedNotifications.length > 0) {
			try {
				await this.persist();
			} catch (error) {
				return this.failAfterMutationPersistence(error);
			}
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
		return this.enqueueWrite(() => this.markAllReadSerialized());
	}

	private async markAllReadSerialized(): Promise<number> {
		let changed = 0;
		const now = Date.now();
		this.notifications = this.notifications.map((entry) => {
			if (entry.readAt) return entry;
			changed++;
			return { ...entry, readAt: now };
		});
		if (changed > 0) {
			try {
				await this.persist();
			} catch (error) {
				return this.failAfterMutationPersistence(error);
			}
		}
		return changed;
	}

	/** Remove one notification. Returns true if it existed. */
	async remove(id: string): Promise<boolean> {
		return this.enqueueWrite(() => this.removeSerialized(id));
	}

	private async removeSerialized(id: string): Promise<boolean> {
		const before = this.notifications.length;
		this.notifications = this.notifications.filter((n) => n.id !== id);
		const removed = this.notifications.length !== before;
		if (removed) {
			try {
				await this.persist();
			} catch (error) {
				return this.failAfterMutationPersistence(error);
			}
		}
		return removed;
	}

	/** Clear the entire inbox. */
	async clear(): Promise<void> {
		return this.enqueueWrite(async () => {
			this.notifications = [];
			try {
				await this.persist();
			} catch (error) {
				return this.failAfterMutationPersistence(error);
			}
		});
	}
}

export default NotificationService;

/**
 * Notification Types
 *
 * The canonical, cross-platform notification contract for elizaOS. A single
 * `AgentNotification` shape is produced by the runtime (`NotificationService`)
 * and rendered by every client surface — the in-app notification center, an
 * in-app toast, a desktop OS notification (Electrobun), and a mobile local
 * notification (iOS/Android). Leaf renderers map FROM this type to their
 * platform API; they never invent their own shape.
 *
 * Notifications are distinct from chat messages: they carry priority, a
 * category, an optional deep link, a dedupe/group key, and read/unread state,
 * and are persisted for an inbox history rather than streamed as conversation.
 */

import type { JsonValue, UUID } from "./primitives.ts";

/**
 * Delivery urgency. Drives OS urgency/sound and whether a focused client also
 * raises an OS-level notification (only `high`/`urgent` interrupt a focused
 * window; `low`/`normal` land silently in the inbox while focused).
 */
export type NotificationPriority = "low" | "normal" | "high" | "urgent";

/**
 * Triage tier (spec §C.1). A derived, human-facing name for the delivery
 * behavior a `NotificationPriority` binds to. Producers still pass a priority;
 * the tier is what the priority *means*:
 *
 * | Tier        | Priority        | Behavior                                             |
 * |-------------|-----------------|------------------------------------------------------|
 * | `interrupt` | `urgent`,`high` | OS notification (even focused for `urgent`), toast, inbox, badge |
 * | `digest`    | `normal`        | inbox + unread badge, no OS interrupt while focused  |
 * | `silent`    | `low`           | inbox only, no badge weight, auto-expires            |
 *
 * The tier is never stored on the record — it is a pure function of priority so
 * the two can never drift. Use {@link tierForPriority} to name it.
 */
export type NotificationTier = "interrupt" | "digest" | "silent";

/**
 * What produced the notification. Lets clients group, filter, and icon
 * notifications without parsing free text.
 */
export type NotificationCategory =
	| "reminder" // LifeOps reminders / check-ins / follow-ups
	| "task" // task-coordinator / scheduled task completion
	| "workflow" // workflow run completed / failed
	| "agent" // background / coding agent finished
	| "approval" // human-in-the-loop approval needed
	| "message" // a proactive inbound message worth surfacing
	| "health" // health alerts (sleep missed, threshold crossed)
	| "system" // updates, restarts, errors
	| "general"; // anything else

/**
 * A single notification record. Required fields are required — a missing title
 * is a bug, not a default. `readAt`/`body`/`deepLink` are genuinely optional.
 */
export interface AgentNotification {
	/** Stable unique id (also the dedupe identity for the inbox). */
	id: UUID;
	/** Short, human-facing headline. Required. */
	title: string;
	/** Longer detail line. Optional. */
	body?: string;
	/** Producer category for grouping/iconography. */
	category: NotificationCategory;
	/** Delivery urgency. */
	priority: NotificationPriority;
	/** Free-form producer id, e.g. "lifeops", "workflow", "orchestrator". */
	source: string;
	/**
	 * App route or URL to open when the notification is tapped/clicked.
	 * In-app routes are app-relative (e.g. "/tasks"); external links are full URLs.
	 */
	deepLink?: string;
	/** Optional icon hint (lucide icon name or asset path) for the renderer. */
	icon?: string;
	/**
	 * Collapse key: a newer notification with the same `groupKey` supersedes the
	 * older one in the inbox instead of stacking (e.g. repeated reminders for the
	 * same task). Omit for independent notifications.
	 */
	groupKey?: string;
	/**
	 * Structured metadata for renderers / deep-link handlers.
	 *
	 * Reserved key `count` (see {@link NOTIFICATION_COUNT_KEY}): when a producer
	 * emits N notifications sharing a `groupKey` in a window, the surviving
	 * (superseding) record carries `data.count = N` so the row can render "3 new
	 * files" instead of the last event silently eating the earlier ones (§C.3).
	 * The service increments this automatically on same-`groupKey` supersede
	 * unless the producer set `data.count` explicitly.
	 */
	data?: Record<string, JsonValue>;
	/** Unix ms when created. */
	createdAt: number;
	/** Unix ms when the user marked it read; `null`/absent means unread. */
	readAt?: number | null;
	/**
	 * Optional unix ms after which this notification self-destroys (dropped from
	 * the inbox on the next hydrate/notify/read). Honored only when explicitly
	 * set by the caller; `null`/absent means it never expires.
	 */
	expiresAt?: number | null;
	/** Agent that produced it (multi-agent hosts). */
	agentId?: UUID;
}

/**
 * Input to `NotificationService.notify` — the caller supplies the meaningful
 * fields; the service stamps `id`, `createdAt`, and the unread state.
 */
export interface NotificationInput {
	title: string;
	body?: string;
	category?: NotificationCategory;
	priority?: NotificationPriority;
	source?: string;
	deepLink?: string;
	icon?: string;
	groupKey?: string;
	data?: Record<string, JsonValue>;
	/** Optional unix ms self-destroy time; absent/null means it never expires. */
	expiresAt?: number | null;
	agentId?: UUID;
}

/** Query for listing notifications from the inbox. */
export interface NotificationQuery {
	/** Only return unread notifications. */
	unreadOnly?: boolean;
	/** Restrict to one category. */
	category?: NotificationCategory;
	/** Cap the number returned (newest first). */
	limit?: number;
}

/** The shape the notification stream carries over the agent event bus. */
export interface NotificationEventData {
	type: "notification" | "notification_update";
	notification: AgentNotification;
	/** Total unread after this notification, so clients can update a badge. */
	unreadCount: number;
	/** Index signature for Record<string, unknown> compatibility on the bus. */
	[key: string]: unknown;
}

/** Default category when a caller doesn't specify one. */
export const DEFAULT_NOTIFICATION_CATEGORY: NotificationCategory = "general";
/** Default priority when a caller doesn't specify one. */
export const DEFAULT_NOTIFICATION_PRIORITY: NotificationPriority = "normal";
/** Default producer label when a caller doesn't specify one. */
export const DEFAULT_NOTIFICATION_SOURCE = "agent";

/** The agent event stream notifications ride on. */
export const NOTIFICATION_STREAM = "notification" as const;

/**
 * Reserved `data` key carrying the coalesced count of same-`groupKey`
 * notifications (§C.3). `data.count > 1` means the row should render a count
 * chip ("3 new files"). Absent or `1` means a single event.
 */
export const NOTIFICATION_COUNT_KEY = "count" as const;

/**
 * Default self-destroy window for silent-tier (`low`) notifications (§C.1): 24h.
 * A `low` notification with no producer-set `expiresAt` ages out so the inbox
 * self-cleans. Interrupt-tier notifications never default an expiry.
 */
export const SILENT_TIER_DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000;

/**
 * Name the triage tier (§C.1) a priority binds to. Pure function of priority so
 * the tier can never drift from the stored record.
 */
export function tierForPriority(
	priority: NotificationPriority,
): NotificationTier {
	switch (priority) {
		case "urgent":
		case "high":
			return "interrupt";
		case "normal":
			return "digest";
		case "low":
			return "silent";
	}
}

/**
 * Category → default priority (§C.1 producer rule). A producer that omits an
 * explicit priority gets the tier the category implies:
 *
 * - `approval` → `high` (interrupt — the user must act)
 * - `task` / `workflow` → `normal` (digest — completions worth surfacing)
 * - `system` → `low` (silent — routine confirmations, self-expiring)
 * - everything else → {@link DEFAULT_NOTIFICATION_PRIORITY} (`normal`/digest)
 *
 * A producer can always downgrade by passing an explicit priority; these are
 * only the defaults applied when none is given.
 */
export function defaultPriorityForCategory(
	category: NotificationCategory,
): NotificationPriority {
	switch (category) {
		case "approval":
			return "high";
		case "task":
		case "workflow":
			return "normal";
		case "system":
			return "low";
		default:
			return DEFAULT_NOTIFICATION_PRIORITY;
	}
}

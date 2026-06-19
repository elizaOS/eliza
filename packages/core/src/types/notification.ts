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
	/** Structured metadata for renderers / deep-link handlers. */
	data?: Record<string, JsonValue>;
	/** Unix ms when created. */
	createdAt: number;
	/** Unix ms when the user marked it read; `null`/absent means unread. */
	readAt?: number | null;
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
	type: "notification";
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

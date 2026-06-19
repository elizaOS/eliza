/**
 * View-facing type surface for @elizaos/plugin-inbox.
 *
 * These are the display contract the `InboxView` renders against. The triage
 * back-end types (TriageEntry, TriageClassification, InboundMessage, …) live in
 * `./inbox/types.ts`; the INBOX action's fan-out types live in
 * `./actions/inbox.ts`. This plugin must not import from
 * @elizaos/plugin-personal-assistant.
 */

/**
 * Channels the unified inbox aggregates. These mirror the wire channel ids the
 * inbox route emits (`LIFEOPS_INBOX_CHANNELS` in @elizaos/shared) so the view
 * can group the real payload without a translation table. Defined locally —
 * this plugin must not import from @elizaos/plugin-personal-assistant.
 */
export const INBOX_CHANNELS = [
  "gmail",
  "x_dm",
  "discord",
  "telegram",
  "signal",
  "imessage",
  "whatsapp",
  "sms",
] as const;
export type InboxChannel = (typeof INBOX_CHANNELS)[number];

/** Human-readable label per channel, in display order. */
export const INBOX_CHANNEL_LABELS: Record<InboxChannel, string> = {
  gmail: "Email",
  x_dm: "X",
  discord: "Discord",
  telegram: "Telegram",
  signal: "Signal",
  imessage: "iMessage",
  whatsapp: "WhatsApp",
  sms: "SMS",
};

/**
 * One triage item rendered by the InboxView. This is the view's local display
 * DTO, mapped at the fetch boundary from a `LifeOpsInboxMessage` on the wire
 * (`GET /api/lifeops/inbox`). It is intentionally a flat, display-only shape —
 * the view reads these fields and formats them, it never computes.
 */
export interface InboxItem {
  /** Channel-prefixed, globally unique message id. */
  id: string;
  channel: InboxChannel;
  /** Display name of the sender. */
  sender: string;
  /** Gmail-style subject; null for chat channels. */
  subject: string | null;
  /** One-line preview of the latest message. */
  preview: string;
  /** ISO-8601 timestamp the message was received. */
  receivedAt: string;
  unread: boolean;
  /** Stable per-conversation key, when the wire supplies one. */
  threadId: string | null;
}

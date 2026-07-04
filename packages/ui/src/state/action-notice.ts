/**
 * Types and shared timing constants for transient shell toasts (the
 * `setActionNotice` surface). ShellOverlays renders the notices; settings hooks
 * thread the `ActionNoticeFn` callback.
 */
import type { NotificationPriority } from "@elizaos/core";

/** The three visual tones a transient shell toast can render in. */
export type ActionTone = "info" | "success" | "error";

export interface ActionNotice {
  tone: ActionTone;
  text: string;
  /** When true, ShellOverlays shows an indeterminate spinner (long-running work). */
  busy?: boolean;
}

/** Signature of the shell `setActionNotice` callback threaded through settings hooks. */
export type ActionNoticeFn = (
  text: string,
  tone?: ActionTone,
  ttlMs?: number,
  once?: boolean,
  busy?: boolean,
) => void;

/**
 * Canonical auto-dismiss windows for transient surfaces, in milliseconds.
 *
 * Single source of truth for the shell's toast timings — `setActionNotice`'s
 * 2800ms default, the notification store's 4000/7000ms deliveries, and the
 * system warning banner's 20000ms — so they stay coherent across surfaces.
 */
export const TOAST_TTL_MS = {
  /** Default dwell for a plain `setActionNotice` (quick confirmations). */
  default: 2800,
  /** A non-interruptive notification toast (normal/low priority). */
  notification: 4000,
  /** An interruptive notification toast (high/urgent priority). */
  notificationInterruptive: 7000,
  /** A system-warning banner — stays up long enough to be read + acted on. */
  systemWarning: 20_000,
} as const;

/**
 * Map a notification's delivery priority to its toast tone. `urgent` surfaces as
 * an error tone (red, demands attention); everything else is informational.
 * This is the one place priority→tone is decided so the inbox, the toast, and
 * any future surface agree.
 */
export function toastToneForPriority(
  priority: NotificationPriority,
): ActionTone {
  return priority === "urgent" ? "error" : "info";
}

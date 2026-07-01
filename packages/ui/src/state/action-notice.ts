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
 * Previously these were scattered magic numbers — `setActionNotice`'s 2800ms
 * default, the notification store's 4000/7000ms deliveries, and the system
 * warning banner's 20000ms — with no shared definition. Collapsing them here is
 * the single source of truth so the timings stay coherent across the shell.
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

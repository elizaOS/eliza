/**
 * Boot-recovery action channel — the seam that lets the chat's single send
 * funnel short-circuit the in-chat boot-recovery card's controls (re-log in /
 * try again / retry dedicated-agent setup) to the headless boot-recovery
 * conductor, mirroring `model-action-channel.ts`. A control's value is
 * self-identifying via the reserved `__boot_recovery__:` prefix (the CHOICE
 * scope/id are dropped at the widget, so the VALUE carries the discriminator).
 *
 * The prefix is reserved UNCONDITIONALLY: after the agent recovers the handler
 * is cleared and `tryHandleBootRecoveryAction` still consumes the value — a tap
 * on a stale recovery-card control never becomes a chat send.
 */

/** Reserved sentinel prefix for boot-recovery control values. Never a real message. */
export const BOOT_RECOVERY_ACTION_PREFIX = "__boot_recovery__:";

type BootRecoveryActionHandler = (value: string) => boolean;

let handler: BootRecoveryActionHandler | null = null;

/** The boot-recovery conductor registers (and on teardown clears) its handler. */
export function setBootRecoveryActionHandler(
  next: BootRecoveryActionHandler | null,
): void {
  handler = next;
}

/**
 * Consume a reserved `__boot_recovery__:` control value: dispatch it to the
 * active conductor (if any) and report that the value was handled so the
 * caller must NOT forward it to the server. Returns false only for
 * non-boot-recovery values.
 */
export function tryHandleBootRecoveryAction(value: string): boolean {
  if (!value.startsWith(BOOT_RECOVERY_ACTION_PREFIX)) return false;
  handler?.(value);
  return true;
}

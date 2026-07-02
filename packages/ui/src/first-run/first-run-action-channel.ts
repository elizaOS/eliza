/**
 * First-run action channel — the seam that lets the chat's single send funnel
 * (`sendActionMessage`, AppContext) short-circuit first-run-scoped choice picks
 * to the headless in-chat onboarding conductor WITHOUT the conductor having to
 * be assembled before the AppContext value.
 *
 * The conductor (a child of AppContext.Provider) registers its handler here; the
 * wrapped `sendActionMessage` consults `tryHandleFirstRunAction` before the real
 * server send. A first-run choice value is self-identifying via the reserved
 * prefix (the CHOICE scope/id are dropped at the widget, so the VALUE carries
 * the discriminator). The prefix is reserved UNCONDITIONALLY: after onboarding
 * finishes the handler is cleared, and `classifyActionMessage` still drops the
 * value — a tap on a leftover onboarding widget never becomes a chat send.
 *
 * Mirrors the existing in-band sentinel precedent (`__permission_card__:…`).
 */

/** Reserved sentinel prefix for first-run choice values. Never a real message. */
export const FIRST_RUN_ACTION_PREFIX = "__first_run__:";

type FirstRunActionHandler = (value: string) => boolean;

let handler: FirstRunActionHandler | null = null;

/** The conductor registers (and on unmount/finish clears) its action handler. */
export function setFirstRunActionHandler(
  next: FirstRunActionHandler | null,
): void {
  handler = next;
}

/**
 * Returns true when the value was a first-run choice consumed by the active
 * conductor (so the caller must NOT forward it to the server). Returns false
 * for every non-first-run value or when no conductor is active.
 */
export function tryHandleFirstRunAction(value: string): boolean {
  if (!handler) return false;
  if (!value.startsWith(FIRST_RUN_ACTION_PREFIX)) return false;
  return handler(value);
}

/**
 * How the chat's single send funnel must treat an action value:
 * - `"first-run"` — reserved-prefix value: offer it to the conductor and DROP
 *   it unconditionally. Even after onboarding completes (conductor
 *   unregistered), a tap on a leftover onboarding widget must never reach the
 *   server as a literal `__first_run__:` chat message.
 * - `"dropped"` — onboarding is still active: the transcript is choice-driven,
 *   so free text never reaches the server mid-setup (the composer is locked;
 *   this is the send-seam backstop).
 * - `"send"` — a normal post-onboarding value: forward to the real send.
 */
export function classifyActionMessage(
  value: string,
  firstRunComplete: boolean,
): "first-run" | "dropped" | "send" {
  if (value.startsWith(FIRST_RUN_ACTION_PREFIX)) return "first-run";
  return firstRunComplete ? "send" : "dropped";
}

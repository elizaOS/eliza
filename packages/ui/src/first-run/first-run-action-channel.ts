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
 * finishes the handler is cleared, and `isFirstRunAction` still identifies the
 * value — a tap on a leftover onboarding widget never becomes a chat send.
 *
 * Mirrors the existing in-band sentinel precedent (`__permission_card__:…`).
 */

/** Reserved sentinel prefix for first-run choice values. Never a real message. */
export const FIRST_RUN_ACTION_PREFIX = "__first_run__:";
export const FIRST_RUN_CLOUD_LOGIN_ACTION = `${FIRST_RUN_ACTION_PREFIX}runtime:cloud`;
export const FIRST_RUN_CLOUD_LOGIN_FALLBACK_PATH = "/login?returnTo=/chat";

type FirstRunActionHandler = (value: string) => boolean;

let handler: FirstRunActionHandler | null = null;

/** The conductor registers (and on unmount/finish clears) its action handler. */
export function setFirstRunActionHandler(
  next: FirstRunActionHandler | null,
): void {
  handler = next;
}

/** Whether a value belongs to the reserved first-run widget namespace. */
export function isFirstRunAction(value: string): boolean {
  return value.startsWith(FIRST_RUN_ACTION_PREFIX);
}

/**
 * Returns true when the value was a first-run choice consumed by the active
 * conductor (so the caller must NOT forward it to the server). Returns false
 * for every non-first-run value or when no conductor is active.
 */
export function tryHandleFirstRunAction(value: string): boolean {
  if (!handler) return false;
  if (!isFirstRunAction(value)) return false;
  return handler(value);
}

/**
 * Hosted-web fallback for the cloud-only sign-in CTA. Normally the mounted
 * conductor consumes `runtime:cloud` and starts the in-app OAuth handoff. If
 * that handler is absent while first-run is still incomplete, the visible CTA
 * must still navigate to the login route instead of silently dropping the tap.
 */
export function getFirstRunCloudLoginFallbackPath(
  value: string,
  firstRunComplete: boolean,
): string | null {
  if (firstRunComplete) return null;
  return value === FIRST_RUN_CLOUD_LOGIN_ACTION
    ? FIRST_RUN_CLOUD_LOGIN_FALLBACK_PATH
    : null;
}

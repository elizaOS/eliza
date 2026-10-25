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
export const FIRST_RUN_CLOUD_LOGIN_ACTION = `${FIRST_RUN_ACTION_PREFIX}runtime:cloud`;
export const FIRST_RUN_CLOUD_LOGIN_FALLBACK_PATH = "/login?returnTo=/chat";

type FirstRunActionHandler = (value: string) => boolean;
type FirstRunTextHandler = (text: string) => boolean;

let handler: FirstRunActionHandler | null = null;
let textHandler: FirstRunTextHandler | null = null;

/** The conductor registers (and on unmount/finish clears) its action handler. */
export function setFirstRunActionHandler(
  next: FirstRunActionHandler | null,
): void {
  handler = next;
}

/**
 * The conductor registers (and on unmount/finish clears) its free-text handler:
 * the seam that lets the user type freely during onboarding and get a
 * deterministic in-chat reply WITHOUT the text ever reaching the server.
 */
export function setFirstRunTextHandler(next: FirstRunTextHandler | null): void {
  textHandler = next;
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

/**
 * Offer free text to the active onboarding conductor. Returns true when the
 * conductor consumed it (rendered a local turn + reply); false when no
 * conductor is active. The caller decides whether onboarding still owns free
 * text: before a runtime is chosen it must stay local, but the first-run
 * bootstrap window for a provisioned Cloud agent must be allowed through to the
 * real chat bridge.
 */
export function tryHandleFirstRunText(text: string): boolean {
  if (!textHandler) return false;
  return textHandler(text);
}

/**
 * How the chat's single send funnel must treat an action value:
 * - `"first-run"` — reserved-prefix value: offer it to the conductor and DROP
 *   it unconditionally. Even after onboarding completes (conductor
 *   unregistered), a tap on a leftover onboarding widget must never reach the
 *   server as a literal `__first_run__:` chat message.
 * - `"conductor"` — onboarding is still active and no provisioned chat bridge
 *   is available: free text is answered locally by the in-chat conductor
 *   (`tryHandleFirstRunText`) and never reaches the server mid-choice. The
 *   composer is unlocked (#12178, a deliberate reversal of the #9952 onboarding
 *   lock), so this is the real delivery path, not a backstop.
 * - `"send"` — a normal post-onboarding value: forward to the real send.
 */
export function classifyActionMessage(
  value: string,
  firstRunComplete: boolean,
  opts: { allowFirstRunTextSend?: boolean } = {},
): "first-run" | "conductor" | "send" {
  if (value.startsWith(FIRST_RUN_ACTION_PREFIX)) return "first-run";
  return firstRunComplete || opts.allowFirstRunTextSend ? "send" : "conductor";
}

/**
 * Safe navigation for a notification `deepLink`.
 *
 * `AgentNotification.deepLink` is producer-supplied free-form text — the NOTIFY
 * action, LifeOps, the orchestrator, and the proactive-interaction decider all
 * populate it, and some source it straight from LLM/model output. It is
 * therefore attacker-influenceable (a prompt-injected agent or a compromised
 * connector can set it). A deep link reaches the DOM as a navigation target, so
 * it MUST be scheme-checked before use: a `javascript:` deep link would execute
 * in the app origin (especially dangerous under Electrobun/Capacitor), and an
 * arbitrary `https://attacker` top-window navigation is an open-redirect /
 * phishing pivot.
 *
 * Allowlist (anything else is dropped, no navigation):
 *  - `http(s)://…` → opened in a NEW tab with `noopener,noreferrer` (never a
 *    top-window navigation, so it can't be used to redirect the app away);
 *  - `/…` (root-relative app route) → dispatched as the in-app
 *    `eliza:navigate:view` event (no full reload).
 *
 * This is the single source of truth for both the in-app notification center
 * and the OS/web notification click handler so the two cannot diverge.
 */

import { dispatchNavigateViewEvent } from "../../events";

/** Whether a deep link is a safe navigation target (see module doc). */
export function isSafeDeepLink(deepLink: string): boolean {
  if (typeof deepLink !== "string") return false;
  if (/^https?:\/\//i.test(deepLink)) return true;
  // Root-relative app path, but not a scheme-relative `//host` URL.
  return deepLink.startsWith("/") && !deepLink.startsWith("//");
}

/** Best-effort, scheme-checked navigation for a notification deep link. */
export function navigateDeepLink(deepLink: string): void {
  if (typeof window === "undefined") return;
  if (/^https?:\/\//i.test(deepLink)) {
    window.open(deepLink, "_blank", "noopener,noreferrer");
    return;
  }
  if (deepLink.startsWith("/") && !deepLink.startsWith("//")) {
    const viewId = deepLink.slice(1).split("/")[0] || undefined;
    dispatchNavigateViewEvent({ viewId, viewPath: deepLink });
  }
  // Any other scheme (javascript:, data:, custom foo://, scheme-relative //) is
  // intentionally dropped — no navigation.
}

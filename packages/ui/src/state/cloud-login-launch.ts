/**
 * Popup-vs-same-tab launch decision for the cloud sign-in flow (#15143).
 *
 * Mobile web browsers block `window.open` by default (iOS Safari's Block
 * Pop-ups, Chrome on iPhone/Android), so the popup-based cloud login dead-ends
 * on hosted web: the pre-opened window comes back null and the user is told to
 * change browser settings — a consumer flow can't ask that. The decision here
 * is browser-agnostic: the popup path is kept only while a live popup handle
 * exists; when the handle is null/closed (the runtime popup-blocked signal, on
 * any browser) the current tab navigates to the same-origin Steward
 * `/login?returnTo=…` page instead. Touch-primary web browsers skip the popup
 * attempt outright — a capability hint (coarse pointer + no hover), not a
 * user-agent sniff — because even a popup that opens there is a disorienting
 * tab switch. Native (Capacitor) keeps the external Browser plugin and desktop
 * (Electrobun) keeps the RPC external-open; neither is popup-hostile.
 *
 * The same-tab round trip needs no new flow: the `/login` page sanitizes and
 * honors `returnTo` (login-return-to.ts), the Steward token lands in this
 * origin's localStorage, and the first-run conductor's mount-time token poll /
 * cloud-resume marker (first-run-cloud-resume.ts) finish onboarding on return.
 */

import { resolveDirectCloudWebBase } from "../api/client-cloud";
import { isElectrobunRuntime } from "../bridge/electrobun-runtime";
import { configuredStewardApiUrlOverride } from "../cloud/shell/steward-config";
import { ELIZA_CLOUD_DIRECT_API_BY_HOST } from "../cloud/shell/steward-url";
import { preOpenWindow } from "../utils/openExternalUrl";

export const CLOUD_LOGIN_POPUP_NAME = "eliza-cloud-auth";

function isCapacitorNativeRuntime(): boolean {
  if (typeof globalThis === "undefined") return false;
  const capacitor = (
    globalThis as {
      Capacitor?: { isNativePlatform?: () => boolean };
    }
  ).Capacitor;
  return Boolean(capacitor?.isNativePlatform?.());
}

/** Plain web page — no native/desktop external-open affordance to prefer. */
function isPlainWebPlatform(): boolean {
  if (typeof window === "undefined") return false;
  if (isCapacitorNativeRuntime()) return false;
  if (isElectrobunRuntime()) return false;
  return true;
}

/**
 * Capability hint for popup-hostile browsers: a touch-primary device with no
 * hover (phones/tablets in any browser engine). Deliberately not a user-agent
 * check — the owner repro was Chrome on iPhone, and Android Chrome blocks the
 * post-await popups of this flow just the same.
 */
export function isTouchPrimaryWebBrowser(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof window.matchMedia !== "function") return false;
  return (
    window.matchMedia("(pointer: coarse)").matches &&
    window.matchMedia("(hover: none)").matches
  );
}

/**
 * Whether this page's origin can complete a same-origin Steward `/login` round
 * trip: the hosted elizacloud web hosts (steward-url.ts host map) or any host
 * with an explicit Steward API override. Elsewhere (self-hosted dashboards,
 * localhost dev) the `/login` page may have no reachable Steward API, so the
 * legacy device-code flow with its copyable fallback link stays the degrade.
 */
export function hasSameOriginStewardLogin(): boolean {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname.toLowerCase();
  if (ELIZA_CLOUD_DIRECT_API_BY_HOST[host]) return true;
  return Boolean(configuredStewardApiUrlOverride());
}

/**
 * Pre-open the cloud-login popup for a user gesture, EXCEPT where the same-tab
 * decision below prefers redirect-first — skipping the attempt avoids flashing
 * a popup/tab the flow would immediately abandon.
 */
export function preOpenCloudLoginWindow(): Window | null {
  if (
    isPlainWebPlatform() &&
    hasSameOriginStewardLogin() &&
    isTouchPrimaryWebBrowser()
  ) {
    return null;
  }
  return preOpenWindow(CLOUD_LOGIN_POPUP_NAME);
}

/**
 * Whether the cloud sign-in should navigate THIS tab to the same-origin
 * `/login` page instead of driving the popup device-code flow. True on plain
 * web with a same-origin Steward login when the popup handle is dead (blocked
 * at pre-open — the browser-agnostic runtime signal — or never attempted) or
 * when the touch-primary hint prefers same-tab outright.
 */
export function shouldUseSameTabCloudLogin(
  prePoppedWindow: Window | null,
): boolean {
  if (!isPlainWebPlatform()) return false;
  if (!hasSameOriginStewardLogin()) return false;
  if (isTouchPrimaryWebBrowser()) return true;
  return !prePoppedWindow || prePoppedWindow.closed;
}

/**
 * The same-origin login path carrying the caller's location as `returnTo`, so
 * the round trip lands back where sign-in started (onboarding chat, settings,
 * the cloud dashboard). Falls back to `/chat` — the onboarding landing — when
 * the current path is unusable (already on `/login`, or protocol-relative).
 */
export function buildSameTabCloudLoginPath(location?: {
  pathname: string;
  search: string;
}): string {
  const loc =
    location ?? (typeof window !== "undefined" ? window.location : undefined);
  const current = loc ? `${loc.pathname}${loc.search}` : "";
  const returnTo =
    current.startsWith("/") &&
    !current.startsWith("//") &&
    !current.startsWith("/login")
      ? current
      : "/chat";
  return `/login?returnTo=${encodeURIComponent(returnTo)}`;
}

/** Hard-navigate the current tab into the same-origin Steward login page. */
export function navigateToSameTabCloudLogin(): void {
  if (typeof window === "undefined") return;
  window.location.assign(buildSameTabCloudLoginPath());
}

/**
 * Whether a blocked popup may degrade to navigating the CURRENT tab to the
 * (already https-validated) authorization URL instead of dead-ending on an
 * "allow pop-ups" instruction. Only on plain web: the app survives the round
 * trip via its persisted state, and browsers restore the tab on back
 * navigation. Native/desktop keep their error state — their external-open
 * affordances are not popup-blocked, so a null there is a real failure.
 */
export function canNavigateSameTabForBlockedPopup(): boolean {
  return isPlainWebPlatform();
}

/**
 * Direct-navigation target for the onboarding "Connect Eliza Cloud" card. Must
 * be a browser-renderable login PAGE: pointing the card at the raw configured
 * cloud base navigated escaped popups into API-host/www-edge responses that
 * mobile browsers download as `document.txt` instead of rendering (#15143).
 * On a hosted-web https origin with a same-origin Steward login the URL stays
 * on THIS origin with a `returnTo`, so the sign-in round trip actually lands
 * the token where onboarding resumes; everywhere else it is the cloud web
 * base's login page.
 */
export function resolveCloudSignInPageUrl(cloudApiBase: string): string {
  if (
    isPlainWebPlatform() &&
    hasSameOriginStewardLogin() &&
    typeof window !== "undefined" &&
    window.location.protocol === "https:"
  ) {
    return `${window.location.origin}${buildSameTabCloudLoginPath()}`;
  }
  return `${resolveDirectCloudWebBase(cloudApiBase)}/login`;
}

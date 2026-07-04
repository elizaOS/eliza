// === Phase 5D: extracted from main.tsx ===
// App-shell deep-link dispatcher. Recognizes the white-label `<scheme>://`
// links emitted by the iOS/Android intents, the desktop share target, and
// first-run redirects. Pure routing logic — share-target persistence and
// CONNECT event dispatch are injected so the dispatcher stays test-friendly.

import {
  CONNECT_EVENT,
  createNavigateViewEvent,
  dispatchAppEvent,
  dispatchOpenNotificationCenter,
} from "@elizaos/ui/events";
import { routeFirstRunDeepLink } from "@elizaos/ui/first-run/deep-link-handler";
import type { ShareTargetPayload } from "@elizaos/ui/platform";
import { applyLaunchConnection } from "@elizaos/ui/platform/browser-launch";
import {
  buildAssistantLaunchHashRoute,
  type DeepLinkNavigationIntent,
  resolveDeepLinkNavigationIntent,
} from "./deep-link-routing";
import type { UrlTrustPolicy } from "./url-trust-policy";

export interface DeepLinkHandlerContext {
  urlScheme: string;
  appId: string;
  desktopBundleId: string | undefined;
  logPrefix: string;
  trustPolicy: UrlTrustPolicy;
  dispatchShareTarget: (payload: ShareTargetPayload) => void;
  dispatchDeepLinkCallback: (url: string) => void;
  /**
   * Universal/App-Link hosts (e.g. `eliza.app`) whose `https://<host>/<path>`
   * links route into the same hash routes as the custom `<scheme>://` links.
   * iOS associated-domains + Android `assetlinks.json` make the OS hand these
   * to the installed app; this is the in-app routing half. Subdomains match.
   */
  appLinkHosts?: string[];
  /**
   * Dispatch seam for top-level-surface navigation intents (Settings, Wallet,
   * Browser, Connectors, the cloud-apps Deploy studio). Defaults to the in-app
   * `eliza:navigate:view` CustomEvent bus — the platform-agnostic navigation
   * path the rest of the app uses (a raw `window.location.hash` write never
   * opens a tab on the mobile/Capacitor entrypoint). Injectable for tests.
   */
  dispatchNavigationIntent?: (intent: DeepLinkNavigationIntent) => void;
  /**
   * iOS keyboard app-handoff dictation (#12185): `<scheme>://keyboard-dictation`
   * from the ElizaKeyboard extension starts an app-side record + transcribe
   * session that publishes the transcript to the App Group. Wired to
   * `startKeyboardDictationSession` in the live handler.
   */
  startKeyboardDictation?: (params: URLSearchParams) => void;
}

function defaultDispatchNavigationIntent(
  intent: DeepLinkNavigationIntent,
): void {
  window.dispatchEvent(createNavigateViewEvent(intent));
}

/** True for an `https://<trusted-host>/<path>` universal/App link. */
export function isTrustedAppLink(
  parsed: URL,
  appLinkHosts: string[] | undefined,
): boolean {
  if (parsed.protocol !== "https:") return false;
  const host = parsed.host.toLowerCase();
  return (appLinkHosts ?? []).some(
    (h) => host === h.toLowerCase() || host.endsWith(`.${h.toLowerCase()}`),
  );
}

export function createDeepLinkHandler(ctx: DeepLinkHandlerContext) {
  function handle(url: string): void {
    if (routeFirstRunDeepLink(url, ctx.urlScheme)) {
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }

    const isCustomScheme = parsed.protocol === `${ctx.urlScheme}:`;
    const isAppLink = isTrustedAppLink(parsed, ctx.appLinkHosts);
    if (!isCustomScheme && !isAppLink) return;
    // A universal link's path is its URL pathname; a custom-scheme link encodes
    // it as host(+pathname). Both feed the same route switch below.
    const path = isAppLink
      ? parsed.pathname.replace(/^\/+|\/+$/g, "")
      : getDeepLinkPath(parsed);

    // Top-level-surface deep links (settings, wallet, browser, connectors,
    // apps/deploy). Dispatched on the `eliza:navigate:view` bus — same as the
    // live main.tsx handler — because a hash write never opens a tab on the
    // mobile/Capacitor entrypoint (see resolveDeepLinkNavigationIntent).
    const navigationIntent = resolveDeepLinkNavigationIntent(path);
    if (navigationIntent) {
      (ctx.dispatchNavigationIntent ?? defaultDispatchNavigationIntent)(
        navigationIntent,
      );
      return;
    }

    const assistantLaunchHashRoute = buildAssistantLaunchHashRoute(
      path,
      parsed.searchParams,
    );
    if (assistantLaunchHashRoute) {
      window.location.hash = assistantLaunchHashRoute;
      return;
    }

    switch (path) {
      case "phone":
      case "phone/call":
        setHashRoute("phone", parsed.searchParams);
        break;
      case "messages":
      case "messages/compose":
        setHashRoute("messages", parsed.searchParams);
        break;
      case "contacts":
        setHashRoute("contacts", parsed.searchParams);
        break;
      case "notifications":
        // Desktop-native entry point (#10706): the "Notifications" menu/tray
        // item opens the notification center in place (no route change), the
        // one visible way in where the floating bell is hidden.
        dispatchOpenNotificationCenter();
        ctx.dispatchDeepLinkCallback(url);
        break;
      case "keyboard-dictation":
        if (ctx.startKeyboardDictation) {
          ctx.startKeyboardDictation(parsed.searchParams);
        } else {
          console.warn(
            `${ctx.logPrefix} keyboard-dictation deep link received but no dictation handler is wired`,
          );
        }
        break;
      case "connect":
        handleConnect(parsed);
        break;
      case "share":
        handleShare(parsed.searchParams);
        break;
      default:
        console.warn(`${ctx.logPrefix} Unknown deep link path:`, path);
        break;
    }
  }

  function handleConnect(parsed: URL): void {
    const gatewayUrl = parsed.searchParams.get("url");
    if (!gatewayUrl) return;
    let validatedUrl: URL;
    try {
      validatedUrl = new URL(gatewayUrl);
    } catch {
      console.error(`${ctx.logPrefix} Invalid gateway URL format`);
      return;
    }
    if (
      validatedUrl.protocol !== "https:" &&
      validatedUrl.protocol !== "http:"
    ) {
      console.error(
        `${ctx.logPrefix} Invalid gateway URL protocol:`,
        validatedUrl.protocol,
      );
      return;
    }
    if (!ctx.trustPolicy.isTrustedDeepLinkApiBaseUrl(validatedUrl)) {
      console.warn(
        `${ctx.logPrefix} Rejected untrusted gateway URL host:`,
        validatedUrl.hostname,
      );
      return;
    }
    // SECURITY: never accept a bearer token from an OS-delivered deep link. A
    // crafted `<scheme>://connect?url=…&token=…` would otherwise authenticate the
    // session with an ATTACKER-supplied token against an attacker gateway (full
    // MITM of subsequent agent traffic). No legitimate flow passes a token this
    // way — remote auth goes through the cloudLaunchSession exchange
    // (applyLaunchConnectionFromUrl already refuses raw `token` params). The
    // host repoint is preserved for the legitimate local-agent connect feature.
    const connection = applyLaunchConnection({
      kind: "remote",
      apiBase: validatedUrl.href,
      token: null,
      allowPublicHttps: true,
    });
    dispatchAppEvent(CONNECT_EVENT, {
      gatewayUrl: connection.apiBase,
      token: connection.token ?? undefined,
    });
  }

  function handleShare(params: URLSearchParams): void {
    const title = params.get("title")?.trim() || undefined;
    const text = params.get("text")?.trim() || undefined;
    const sharedUrl = params.get("url")?.trim() || undefined;
    const files = params
      .getAll("file")
      .map((filePath) => filePath.trim())
      .filter((filePath) => filePath.length > 0)
      .map((filePath) => {
        const slash = Math.max(
          filePath.lastIndexOf("/"),
          filePath.lastIndexOf("\\"),
        );
        const name = slash >= 0 ? filePath.slice(slash + 1) : filePath;
        return { name, path: filePath };
      });

    ctx.dispatchShareTarget({
      source: "deep-link",
      title,
      text,
      url: sharedUrl,
      files,
    });
  }

  function getDeepLinkPath(parsed: URL): string {
    const host = parsed.host.replace(/^\/+|\/+$/g, "");
    const pathname = parsed.pathname.replace(/^\/+|\/+$/g, "");
    if (host === ctx.appId || host === ctx.desktopBundleId) {
      return pathname;
    }
    return [host, pathname].filter(Boolean).join("/");
  }

  function setHashRoute(route: string, params: URLSearchParams): void {
    const query = params.toString();
    window.location.hash = query ? `#${route}?${query}` : `#${route}`;
  }

  return handle;
}

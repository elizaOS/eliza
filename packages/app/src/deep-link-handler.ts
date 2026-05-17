// === Phase 5D: extracted from main.tsx ===
// App-shell deep-link dispatcher. Recognizes the white-label `<scheme>://`
// links emitted by the iOS/Android intents, the desktop share target, and
// onboarding redirects. Pure routing logic — share-target persistence and
// CONNECT event dispatch are injected so the dispatcher stays test-friendly.

import {
  applyLaunchConnection,
  CONNECT_EVENT,
  dispatchAppEvent,
  routeOnboardingDeepLink,
  type ShareTargetPayload,
} from "@elizaos/ui";
import { buildAssistantLaunchHashRoute } from "./deep-link-routing";
import type { UrlTrustPolicy } from "./url-trust-policy";

export interface DeepLinkHandlerContext {
  urlScheme: string;
  appId: string;
  desktopBundleId: string | undefined;
  logPrefix: string;
  trustPolicy: UrlTrustPolicy;
  dispatchShareTarget: (payload: ShareTargetPayload) => void;
  dispatchLifeOpsCallback: (url: string) => void;
}

export function createDeepLinkHandler(ctx: DeepLinkHandlerContext) {
  function handle(url: string): void {
    if (routeOnboardingDeepLink(url, ctx.urlScheme)) {
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }

    if (parsed.protocol !== `${ctx.urlScheme}:`) return;
    const path = getDeepLinkPath(parsed);

    if (/^settings\/connectors\/[a-z0-9-]+$/i.test(path)) {
      window.location.hash = "#connectors";
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
      case "wallet":
      case "inventory":
        setHashRoute("wallet", parsed.searchParams);
        break;
      case "browser":
        setHashRoute("browser", parsed.searchParams);
        break;
      case "lifeops":
        window.location.hash = "#lifeops";
        ctx.dispatchLifeOpsCallback(url);
        break;
      case "settings":
        window.location.hash = "#settings";
        ctx.dispatchLifeOpsCallback(url);
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
    const token =
      parsed.searchParams.get("token") ??
      parsed.searchParams.get("accessToken") ??
      null;
    const connection = applyLaunchConnection({
      kind: "remote",
      apiBase: validatedUrl.href,
      token,
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

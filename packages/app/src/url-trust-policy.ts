/**
 * Host trust policy for the white-label app shell: decides whether a given
 * apiBase, deep-link target, or native WebSocket URL is safe to dial, keeping
 * that decision out of the boot orchestration in `main.tsx`. A strict iOS path
 * (App Store / TestFlight builds and cloud-runtime modes, which App Review
 * forbids from reaching non-HTTPS or private-network hosts) and a dev-friendly
 * loopback/private-LAN path live side by side. `createUrlTrustPolicy` closes
 * over a `UrlTrustPolicyContext` and returns the per-URL guards; URL parse
 * failures fail closed (treated as untrusted).
 */

import {
  IOS_LOCAL_AGENT_IPC_BASE,
  isMobileLocalAgentIpcUrl,
} from "@elizaos/ui/first-run/mobile-runtime-mode";

export interface UrlTrustPolicyContext {
  isNative: boolean;
  isIOS: boolean;
  /**
   * True iff the current build is the App Store / TestFlight variant. iOS
   * App Review forbids any non-HTTPS / private-network access, so we layer
   * stricter rules on top of the normal dev allowances.
   */
  isStoreBuild: boolean;
  cloudApiBase: string | undefined;
  /**
   * `?popout=1` window — these can dial arbitrary HTTPS hosts the user
   * provided via the apiBase query parameter (used by Electrobun popouts).
   */
  isPopoutWindow: boolean;
  /**
   * Returns the current iOS runtime mode (local / cloud / cloud-hybrid /
   * tunnel-to-mobile). This is a callback rather than a value because the
   * mode can flip at runtime via the mobile runtime mode listener.
   */
  getIosRuntimeMode: () => string;
}

export function isTrustedPrivateHttpHost(host: string): boolean {
  return (
    host === "0.0.0.0" ||
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^169\.254\.\d{1,3}\.\d{1,3}$/.test(host) ||
    host === "local" ||
    host === "internal" ||
    host === "lan" ||
    host === "ts.net" ||
    host.endsWith(".local") ||
    host.endsWith(".lan") ||
    host.endsWith(".internal") ||
    host.endsWith(".ts.net")
  );
}

export function isLoopbackApiHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1"
  );
}

/**
 * Canonical Eliza Cloud shared-tier control-plane hosts. The free shared agent
 * is served in-Worker off the apex `elizacloud.ai` / its `www.` and `api.`
 * siblings (the shared REST adapter lives at
 * `<host>/api/v1/eliza/agents/<id>`), NOT a per-agent `*.elizacloud.ai`
 * subdomain — so the dedicated-subdomain trust does not cover it. A store iOS
 * build must trust these HTTPS hosts regardless of whether `cloudApiBase` was
 * pinned to the exact host, or shared-tier bootstrap (the instant, always-on,
 * $0 path — the mobile default) is rejected under the strict network policy.
 * Prod hosts only; staging/dev are reached via a configured `cloudApiBase`.
 */
const ELIZA_CLOUD_SHARED_HOSTS: ReadonlySet<string> = new Set([
  "elizacloud.ai",
  "www.elizacloud.ai",
  "api.elizacloud.ai",
]);

export function isElizaCloudSharedHost(host: string): boolean {
  return ELIZA_CLOUD_SHARED_HOSTS.has(host.toLowerCase());
}

function isIosLocalAgentIpcUrl(parsed: URL): boolean {
  return isMobileLocalAgentIpcUrl(parsed);
}

function isPrivateOrLoopbackApiHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    isLoopbackApiHost(normalized) ||
    (normalized.includes(":") &&
      (normalized.startsWith("fc") ||
        normalized.startsWith("fd") ||
        normalized.startsWith("fe80:"))) ||
    isTrustedPrivateHttpHost(normalized)
  );
}

export function createUrlTrustPolicy(ctx: UrlTrustPolicyContext) {
  function isNativeIosStoreBuild(): boolean {
    return ctx.isNative && ctx.isIOS && ctx.isStoreBuild;
  }

  function isNativeIosCloudRuntimeMode(): boolean {
    if (!ctx.isNative || !ctx.isIOS) return false;
    const mode = ctx.getIosRuntimeMode();
    return mode === "cloud" || mode === "cloud-hybrid";
  }

  function usesStrictIosNetworkPolicy(): boolean {
    return isNativeIosStoreBuild() || isNativeIosCloudRuntimeMode();
  }

  function canUseIosLocalAgentIpc(): boolean {
    return ctx.isNative && ctx.isIOS && ctx.getIosRuntimeMode() === "local";
  }

  function isCurrentOriginHost(host: string): boolean {
    return typeof window !== "undefined" && host === window.location.hostname;
  }

  function isConfiguredCloudApiHost(host: string): boolean {
    if (!ctx.cloudApiBase) return false;
    try {
      return host === new URL(ctx.cloudApiBase).hostname;
    } catch {
      // error-policy:J3 fail-closed URL parse: a malformed cloudApiBase is not
      // a trusted host match.
      return false;
    }
  }

  function isTrustedApiBaseUrl(parsed: URL): boolean {
    if (isIosLocalAgentIpcUrl(parsed)) return canUseIosLocalAgentIpc();
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    const host = parsed.hostname;
    if (usesStrictIosNetworkPolicy()) {
      if (parsed.protocol !== "https:" || isPrivateOrLoopbackApiHost(host)) {
        return false;
      }
      return (
        isCurrentOriginHost(host) ||
        isConfiguredCloudApiHost(host) ||
        isElizaCloudSharedHost(host)
      );
    }
    if (ctx.isPopoutWindow && parsed.protocol === "https:") return true;
    return (
      isLoopbackApiHost(host) ||
      isCurrentOriginHost(host) ||
      (parsed.protocol === "https:" && isConfiguredCloudApiHost(host)) ||
      isTrustedPrivateHttpHost(host)
    );
  }

  function isTrustedDeepLinkApiBaseUrl(parsed: URL): boolean {
    if (isIosLocalAgentIpcUrl(parsed)) return canUseIosLocalAgentIpc();
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    const host = parsed.hostname;
    if (usesStrictIosNetworkPolicy()) {
      if (parsed.protocol !== "https:" || isPrivateOrLoopbackApiHost(host)) {
        return false;
      }
      return (
        isCurrentOriginHost(host) ||
        (parsed.protocol === "https:" && isConfiguredCloudApiHost(host)) ||
        (parsed.protocol === "https:" && isElizaCloudSharedHost(host))
      );
    }
    return (
      isLoopbackApiHost(host) ||
      isCurrentOriginHost(host) ||
      (parsed.protocol === "https:" && isConfiguredCloudApiHost(host)) ||
      isTrustedPrivateHttpHost(host)
    );
  }

  function isTrustedNativeWebSocketUrl(value: string): boolean {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
        return false;
      }
      if (!usesStrictIosNetworkPolicy()) return true;
      return (
        parsed.protocol === "wss:" &&
        !isPrivateOrLoopbackApiHost(parsed.hostname)
      );
    } catch {
      // error-policy:J3 fail-closed URL parse: an unparseable WebSocket URL is
      // never trusted.
      return false;
    }
  }

  return {
    isTrustedApiBaseUrl,
    isTrustedDeepLinkApiBaseUrl,
    isTrustedNativeWebSocketUrl,
    usesStrictIosNetworkPolicy,
    isNativeIosStoreBuild,
  };
}

export type UrlTrustPolicy = ReturnType<typeof createUrlTrustPolicy>;

// Re-export the IPC base so consumers don't need to depend on @elizaos/ui
// directly when wiring the policy. Pure convenience.
export { IOS_LOCAL_AGENT_IPC_BASE };

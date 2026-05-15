// === Phase 5D: extracted from main.tsx ===
// Host trust policy for the white-label app shell. Decides whether a given
// apiBase / deep-link target / native WebSocket URL is safe to dial. The
// strict iOS path (store builds, cloud-runtime modes) and the dev-friendly
// loopback path live side by side so the boot orchestration stays in main.

import { IOS_LOCAL_AGENT_IPC_BASE } from "@elizaos/ui";

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

function isIosLocalAgentIpcUrl(parsed: URL): boolean {
  return parsed.protocol === "eliza-local-agent:" && parsed.hostname === "ipc";
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
      return isCurrentOriginHost(host) || isConfiguredCloudApiHost(host);
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
        (parsed.protocol === "https:" && isConfiguredCloudApiHost(host))
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

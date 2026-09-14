/**
 * Classifies explicitly configured loopback Steward development without loading
 * the agent API client. Public login and app login share this host/tenant gate.
 */
import { isElectrobunRuntime } from "../bridge/electrobun-runtime";
import {
  configuredStewardApiUrlOverride,
  configuredStewardTenantId,
} from "../cloud/shell/steward-config";

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
export function isPlainWebPlatform(): boolean {
  if (typeof window === "undefined") return false;
  if (isCapacitorNativeRuntime()) return false;
  if (isElectrobunRuntime()) return false;
  return true;
}

function isCliReturnLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "127.0.0.1" ||
    normalized === "::1"
  );
}

/**
 * Plain-web origin accepted by the hosted CLI-login returnTo sanitizer.
 * Keep this policy exact: a launch origin that the hosted page would discard
 * cannot complete the bridge back to the local app.
 */
export function isCliReturnLoopbackWebOrigin(): boolean {
  return (
    isPlainWebPlatform() &&
    (window.location.protocol === "http:" ||
      window.location.protocol === "https:") &&
    isCliReturnLoopbackHostname(window.location.hostname)
  );
}

/**
 * Classify an explicitly configured loopback Steward development target.
 * Staging is special because its OAuth tenant rejects localhost callback URLs;
 * callers route it through the hosted CLI-session exchange instead.
 */
export function loopbackStewardDevelopmentTarget(): "staging" | "other" | null {
  if (!isCliReturnLoopbackWebOrigin()) return null;

  const configuredUrl = configuredStewardApiUrlOverride();
  if (!configuredUrl) return null;
  try {
    const parsed = new URL(configuredUrl);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    const isStaging =
      (parsed.hostname.toLowerCase() === "staging.eliza.app" ||
        parsed.hostname.toLowerCase() === "staging.elizacloud.ai") &&
      pathname === "/steward" &&
      configuredStewardTenantId() === "elizacloud-staging";
    return isStaging ? "staging" : "other";
  } catch {
    return "other";
  }
}

/** True only for the launcher-stamped localhost → staging Steward target. */
export function isLoopbackStagingStewardDevelopment(): boolean {
  return loopbackStewardDevelopmentTarget() === "staging";
}

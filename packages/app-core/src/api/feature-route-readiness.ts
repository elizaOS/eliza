/**
 * Declares HTTP prefixes mounted by app route plugins after runtime readiness.
 * The API middleware uses this manifest to distinguish a capability that is
 * still registering from a route that genuinely does not exist.
 */
import type { DeferredBootPhaseStatus } from "@elizaos/agent/runtime/deferred-boot-status";

export const DEFERRED_FEATURE_ROUTE_PREFIXES = [
  "/api/asr/cloud",
  "/api/cloud",
  "/api/coding-agents",
  "/api/computer-use",
  "/api/documents",
  "/api/github",
  "/api/issues",
  "/api/lifeops",
  "/api/orchestrator",
  "/api/tts/cloud",
  "/api/v1/advertising",
  "/api/wallet",
] as const;

export type FeatureRouteReadinessFailure = {
  error: "feature_starting" | "feature_unavailable";
  phase: "app-route-tail";
  status: "runtime_starting" | DeferredBootPhaseStatus;
};

function matchesPathPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** Returns a structured failure only for a known deferred feature route. */
export function resolveFeatureRouteReadinessFailure(
  pathname: string,
  runtimeAvailable: boolean,
  phase: DeferredBootPhaseStatus | undefined,
): FeatureRouteReadinessFailure | null {
  if (
    !DEFERRED_FEATURE_ROUTE_PREFIXES.some((prefix) =>
      matchesPathPrefix(pathname, prefix),
    )
  ) {
    return null;
  }
  if (!runtimeAvailable) {
    return {
      error: "feature_starting",
      phase: "app-route-tail",
      status: "runtime_starting",
    };
  }
  if (phase === "pending") {
    return {
      error: "feature_starting",
      phase: "app-route-tail",
      status: phase,
    };
  }
  if (phase === "failed") {
    return {
      error: "feature_unavailable",
      phase: "app-route-tail",
      status: phase,
    };
  }
  return null;
}

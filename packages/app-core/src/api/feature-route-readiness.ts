/**
 * Declares HTTP prefixes mounted by app route plugins after runtime readiness.
 * The API middleware uses this manifest to distinguish a capability that is
 * still registering from a route that genuinely does not exist.
 */
import { matchPluginRoutePath } from "@elizaos/agent/api/runtime-plugin-routes";
import type { DeferredBootPhaseStatus } from "@elizaos/agent/runtime/deferred-boot-status";
import type { Route } from "@elizaos/core";

export const DEFERRED_FEATURE_ROUTE_PREFIXES = [
  "/api/asr/cloud",
  "/api/browser-workspace",
  "/api/cloud",
  "/api/coding-agents",
  "/api/computer-use",
  "/api/documents",
  "/api/github",
  "/api/issues",
  "/api/lifeops",
  "/api/notes",
  "/api/orchestrator",
  "/api/tts/cloud",
  "/api/v1/advertising",
  "/api/wallet",
  "/api/views/notes",
] as const;

const FEATURE_ROUTE_BOOT_PHASES = [
  "agent-deferred-boot",
  "app-route-tail",
] as const;

export type FeatureRouteBootPhase = (typeof FEATURE_ROUTE_BOOT_PHASES)[number];

export type FeatureRouteReadinessFailure = {
  error: "feature_starting" | "feature_unavailable";
  code: "feature_starting" | "feature_unavailable";
  phase: FeatureRouteBootPhase;
  status: "runtime_starting" | DeferredBootPhaseStatus;
  retryable: boolean;
};

/**
 * Namespaces owned by the agent HTTP host rather than deferred runtime route
 * registration. Their handlers may lazy-load an optional implementation or
 * return a capability-specific fallback, but a global plugin-tail status must
 * never shadow them after the runtime has been published.
 */
const HOST_OWNED_FEATURE_ROUTE_PREFIXES = [
  "/api/browser-workspace",
  "/api/computer-use",
  "/api/wallet",
] as const;

/** Exact host fallbacks that share a prefix with genuinely deferred routes. */
const HOST_OWNED_FEATURE_ROUTES = [
  { method: "GET", pathname: "/api/coding-agents/preflight" },
  { method: "GET", pathname: "/api/coding-agents/coordinator/status" },
  { method: "GET", pathname: "/api/lifeops/inbox" },
  { method: "GET", pathname: "/api/lifeops/activity-signals" },
  { method: "POST", pathname: "/api/lifeops/activity-signals" },
] as const;

function matchesPathPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Whether the live host already owns this request. Registered plugin routes
 * are matched with the same path matcher as the agent HTTP dispatcher; direct
 * host namespaces are declared above because they do not appear in
 * `runtime.routes`.
 */
export function isFeatureRouteHandlerAvailable(options: {
  method: string;
  pathname: string;
  runtimeRoutes?: readonly Route[] | null;
}): boolean {
  const method = options.method.toUpperCase();
  if (
    HOST_OWNED_FEATURE_ROUTE_PREFIXES.some((prefix) =>
      matchesPathPrefix(options.pathname, prefix),
    ) ||
    HOST_OWNED_FEATURE_ROUTES.some(
      (route) => route.method === method && route.pathname === options.pathname,
    )
  ) {
    return true;
  }

  return Boolean(
    options.runtimeRoutes?.some(
      (route) =>
        route.type === method &&
        (route.handler !== undefined || route.routeHandler !== undefined) &&
        matchPluginRoutePath(route.path, options.pathname) !== null,
    ),
  );
}

/** Returns a structured failure only for a known deferred feature route. */
export function resolveFeatureRouteReadinessFailure(
  pathname: string,
  runtimeAvailable: boolean,
  phases: Readonly<
    Partial<Record<FeatureRouteBootPhase, DeferredBootPhaseStatus>>
  >,
  routeHandlerAvailable = false,
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
      code: "feature_starting",
      phase: "app-route-tail",
      status: "runtime_starting",
      retryable: true,
    };
  }
  // Registration is route-specific while deferred phase status is global. A
  // later, unrelated task may fail after this route mounted successfully, so
  // an executable handler is stronger evidence than the aggregate phase.
  if (routeHandlerAvailable) return null;

  const pendingPhase = FEATURE_ROUTE_BOOT_PHASES.find(
    (phase) => phases[phase] === "pending",
  );
  if (pendingPhase) {
    return {
      error: "feature_starting",
      code: "feature_starting",
      phase: pendingPhase,
      status: "pending",
      retryable: true,
    };
  }

  const failedPhase = FEATURE_ROUTE_BOOT_PHASES.find(
    (phase) => phases[phase] === "failed",
  );
  if (failedPhase) {
    return {
      error: "feature_unavailable",
      code: "feature_unavailable",
      phase: failedPhase,
      status: "failed",
      retryable: false,
    };
  }
  return null;
}

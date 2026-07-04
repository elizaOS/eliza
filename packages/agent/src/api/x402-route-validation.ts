/**
 * Guard that detects whether any runtime-registered route declares an `x402`
 * field (the payment-gating marker). A non-nullish `x402` — even a malformed or
 * `false` value — means the route set must go through x402 validation before it
 * is served, so callers fail closed rather than silently mounting an unvalidated
 * paid route.
 */
import type { Route } from "@elizaos/core";

type MaybeX402Route = Route & {
  x402?: unknown;
};

export function routeNeedsX402Validation(route: Route): boolean {
  return (route as MaybeX402Route).x402 != null;
}

export function runtimeRoutesNeedX402Validation(
  routes: readonly Route[] | null | undefined,
): boolean {
  return Array.isArray(routes) && routes.some(routeNeedsX402Validation);
}

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

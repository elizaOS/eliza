/**
 * Public barrel for the agent HTTP API surface (`@elizaos/agent/api`):
 * re-exports the route handlers, dispatch helpers, and transport types the
 * server dispatcher and sibling `@elizaos/plugin-*` packages consume.
 *
 * App-manager and wallet routes live in their own plugins; the re-exports here
 * preserve the historical `@elizaos/agent` import path. Wallet loads lazily so
 * importing this barrel during server startup does not drag in the full
 * wallet/trading stack before any wallet route is used.
 */

// Compatibility re-export: apps routes live in @elizaos/plugin-app-manager;
// new callers should import from that package directly.
export {
  type AppManagerLike,
  type AppsRouteContext,
  type FavoriteAppsStore,
  handleAppsRoutes,
} from "@elizaos/plugin-app-manager";
// Compatibility re-export: wallet routes live in @elizaos/plugin-wallet.
// Lazy-load the implementation — this barrel is imported during local-server
// startup, and a static re-export would force every runtime to pull in the
// full wallet/trading stack before any wallet route is used.
export type {
  WalletAddressesSnapshot,
  WalletRouteContext,
  WalletRouteDependencies,
  WalletRpcReadinessSnapshot,
} from "@elizaos/plugin-wallet";
export const handleWalletRoutes: typeof import("@elizaos/plugin-wallet").handleWalletRoutes =
  async (context) => {
    const walletApi = await import(/* @vite-ignore */ "@elizaos/plugin-wallet");
    return walletApi.handleWalletRoutes(context);
  };
export * from "./accounts-routes.ts";
export * from "./agent-admin-routes.ts";
export * from "./agent-lifecycle-routes.ts";
export * from "./agent-model.ts";
export * from "./agent-transfer-routes.ts";
export * from "./approval-routes.ts";
export * from "./auth-routes.ts";
export * from "./bug-report-routes.ts";
export * from "./character-routes.ts";
export * from "./compat-utils.ts";
export * from "./connector-health.ts";
export * from "./credit-detection.ts";
export * from "./database.ts";
export * from "./diagnostics-routes.ts";
export {
  type DispatchRouteArgs,
  dispatchRoute,
} from "./dispatch-route.ts";
export * from "./documents-service-loader.ts";
export * from "./early-logs.ts";
export * from "./memory-bounds.ts";
export * from "./memory-routes.ts";
export * from "./models-routes.ts";
export * from "./parse-action-block.ts";
export * from "./permission-request-prompt.ts";
export * from "./permissions-routes.ts";
export * from "./plugin-validation.ts";
export * from "./provider-switch-config.ts";
export * from "./rate-limiter.ts";
export * from "./registry-routes.ts";
export * from "./registry-service.ts";
// `runtime-plugin-routes.ts` exports `matchPluginRoutePath` (used by plugin
// authors and their tests) and the request-handling helper
// `tryHandleRuntimePluginRoute` (used by
// agent runtime wiring). Both are part of the public agent surface.
export {
  matchPluginRoutePath,
  tryHandleRuntimePluginRoute,
} from "./runtime-plugin-routes.ts";
// The Android in-process bridge serves /api/first-run/* itself (the stdio
// dispatch bypasses the HTTP server layer that owns those routes) and needs
// the same completion predicate the server uses.
export { hasPersistedFirstRunState } from "./server-helpers.ts";
export * from "./subscription-routes.ts";
export * from "./terminal-run-limits.ts";
export * from "./training-backend-check.ts";
export * from "./training-service-like.ts";
export * from "./tx-service.ts";
export * from "./wallet.ts";
export * from "./wallet-evm-balance.ts";
export * from "./wallet-rpc.ts";
export * from "./wallet-trading-profile.ts";
export * from "./workbench-vfs-routes.ts";
export * from "./zip-utils.ts";

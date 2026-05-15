const computerUseModule = (await import(
  "@elizaos/plugin-computeruse"
)) as unknown as {
  handleSandboxRoute: (...args: unknown[]) => unknown;
};
const signalModule = (await import("@elizaos/plugin-signal")) as unknown as {
  applySignalQrOverride: (...args: unknown[]) => unknown;
};
const whatsAppModule = (await import(
  "@elizaos/plugin-whatsapp"
)) as unknown as {
  applyWhatsAppQrOverride: (...args: unknown[]) => unknown;
  handleWhatsAppRoute: (...args: unknown[]) => unknown;
};
const workflowModule = (await import(
  "@elizaos/plugin-workflow"
)) as unknown as {
  handleTriggerRoutes: (...args: unknown[]) => unknown;
};
const appManagerModule = (await import(
  "@elizaos/plugin-app-manager"
)) as unknown as {
  handleAppsRoutes: (...args: unknown[]) => unknown;
};
const walletModule = (await import("@elizaos/plugin-wallet")) as unknown as {
  handleWalletRoutes: (...args: unknown[]) => unknown;
};

export const { handleSandboxRoute } = computerUseModule;
export const { applySignalQrOverride } = signalModule;
export const { applyWhatsAppQrOverride, handleWhatsAppRoute } = whatsAppModule;
export const { handleTriggerRoutes } = workflowModule;
export const { handleAppsRoutes } = appManagerModule;
export const { handleWalletRoutes } = walletModule;

export type WhatsAppPairingEventLike = Record<string, unknown>;
export interface WhatsAppPairingSessionLike {
  stop: () => void | Promise<void>;
}
export type WhatsAppRouteDeps = Record<string, unknown>;
export type WhatsAppRouteState = Record<string, unknown>;
export type TriggerRouteContext = Parameters<typeof handleTriggerRoutes>[0];
export type TriggerRouteHelpers = Record<string, unknown>;
export type AppManagerLike = Record<string, unknown>;
export type AppsRouteContext = Parameters<typeof handleAppsRoutes>[0];
export type FavoriteAppsStore = Record<string, unknown>;
export type WalletAddressesSnapshot = Record<string, unknown>;
export type WalletRouteContext = Parameters<typeof handleWalletRoutes>[0];
export type WalletRouteDependencies = Record<string, unknown>;
export type WalletRpcReadinessSnapshot = Record<string, unknown>;
export * from "./accounts-routes.ts";
export * from "./agent-admin-routes.ts";
export * from "./agent-lifecycle-routes.ts";
export * from "./agent-model.ts";
export * from "./agent-transfer-routes.ts";
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
export * from "./documents-routes.ts";
export * from "./documents-service-loader.ts";
export * from "./early-logs.ts";
export * from "./memory-bounds.ts";
export * from "./memory-routes.ts";
export * from "./models-routes.ts";
export * from "./nfa-routes.ts";
export * from "./parse-action-block.ts";
export * from "./permission-request-prompt.ts";
export * from "./permissions-routes.ts";
export * from "./plugin-validation.ts";
export * from "./provider-switch-config.ts";
export * from "./rate-limiter.ts";
export * from "./registry-routes.ts";
export * from "./registry-service.ts";
// `runtime-plugin-routes.ts` exports `matchPluginRoutePath` (used by plugin
// authors and their tests, e.g. plugins/plugin-vincent/src/vincent-plugin-dispatch.test.ts)
// and the request-handling helper `tryHandleRuntimePluginRoute` (used by
// agent runtime wiring). Both are part of the public agent surface.
export {
  matchPluginRoutePath,
  tryHandleRuntimePluginRoute,
} from "./runtime-plugin-routes.ts";
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

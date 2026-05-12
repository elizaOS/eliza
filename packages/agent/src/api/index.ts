export { handleSandboxRoute } from "@elizaos/plugin-computeruse";
export { applySignalQrOverride } from "@elizaos/plugin-signal";
export {
  applyWhatsAppQrOverride,
  handleWhatsAppRoute,
  type WhatsAppPairingEventLike,
  type WhatsAppPairingSessionLike,
  type WhatsAppRouteDeps,
  type WhatsAppRouteState,
} from "@elizaos/plugin-whatsapp";
export {
  handleTriggerRoutes,
  type TriggerRouteContext,
  type TriggerRouteHelpers,
} from "@elizaos/plugin-workflow";
export * from "./accounts-routes.ts";
export * from "./agent-admin-routes.ts";
export * from "./agent-lifecycle-routes.ts";
export * from "./agent-model.ts";
export * from "./agent-transfer-routes.ts";
export * from "./apps-routes.ts";
export * from "./auth-routes.ts";
export * from "./bug-report-routes.ts";
export * from "./character-routes.ts";
export * from "./compat-utils.ts";
export * from "./connector-health.ts";
export * from "./credit-detection.ts";
export * from "./database.ts";
export * from "./diagnostics-routes.ts";
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
// authors and their tests, e.g. plugins/app-vincent/src/vincent-plugin-dispatch.test.ts)
// and the request-handling helper `tryHandleRuntimePluginRoute` (used by
// agent runtime wiring). Both are part of the public agent surface.
export {
  matchPluginRoutePath,
  tryHandleRuntimePluginRoute,
} from "./runtime-plugin-routes.ts";
export {
  dispatchRoute,
  type DispatchRouteArgs,
} from "./dispatch-route.ts";
export * from "./subscription-routes.ts";
export * from "./terminal-run-limits.ts";
export * from "./training-backend-check.ts";
export * from "./training-service-like.ts";
export * from "./tx-service.ts";
export * from "./wallet.ts";
export * from "./wallet-evm-balance.ts";
export * from "./wallet-routes.ts";
export * from "./wallet-rpc.ts";
export * from "./wallet-trading-profile.ts";
export * from "./workbench-vfs-routes.ts";
export * from "./zip-utils.ts";

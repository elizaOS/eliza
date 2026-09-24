/**
 * Barrel for the config surface. Re-exports the app-config types from
 * `@elizaos/core` (the canonical app-config lives in
 * `@elizaos/app/config/app-config`) alongside the local config modules.
 */

export {
  type AllowedHostPattern,
  parseAllowedHostEnv,
  toCapacitorAllowNavigation,
  toViteAllowedHosts,
} from "@elizaos/core/config/allowed-hosts";
export {
  type AndroidUserAgentMarker,
  type AospVariantConfig,
  type AppAndroidConfig,
  type AppConfig,
  type AppDesktopConfig,
  type AppPackagingConfig,
  type AppWebConfig,
  resolveAppBranding,
} from "@elizaos/core/config/app-config";
export { shouldUseCloudOnlyBranding } from "@elizaos/core/config/cloud-only";
export {
  buildPluginConfigUiSpec,
  buildPluginListUiSpec,
} from "@elizaos/core/config/plugin-ui-spec";
export type {
  ActionConfirm,
  ActionOnError,
  ActionOnSuccess,
  AndVisibility,
  AuthState,
  AuthVisibility,
  BuiltinValidator,
  CondExpr,
  DynamicProp,
  NotVisibility,
  OrVisibility,
  PatchOp,
  PathVisibility,
  RepeatConfig,
  UIStreamConfig,
  UiAction,
  UiComponentType,
  UiElement,
  UiEventBindings,
  UiRenderContext,
  UiSpec,
  UiSpecValidationCheck,
  UiSpecValidationConfig,
  UiSpecVisibilityCondition,
  VisibilityOperator,
} from "@elizaos/core/config/ui-spec";
export * from "./boot-config";
// boot-config-react.hooks eagerly imports React; not barrel-exported so node-side
// consumers (bench server, agent boot) can import @elizaos/core without
// pulling React into the runtime closure.
export * from "./branding";
export * from "./config-catalog";

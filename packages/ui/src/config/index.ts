/**
 * Barrel for the config surface. Re-exports the app-config types from
 * `@elizaos/core` (the canonical app-config lives in
 * `@elizaos/app/config/app-config`) alongside the local config modules.
 */

export type {
  ActionConfirm,
  ActionOnError,
  ActionOnSuccess,
  AndVisibility,
  AuthState,
  AuthVisibility,
  BuiltinValidator,
  CondExpr,
  ConfigUiPatchOp as PatchOp,
  DynamicProp,
  NotVisibility,
  OrVisibility,
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
} from "@elizaos/host/protocol";
export {
  type AllowedHostPattern,
  type AndroidUserAgentMarker,
  type AospVariantConfig,
  type AppAndroidConfig,
  type AppConfig,
  type AppDesktopConfig,
  type AppPackagingConfig,
  type AppWebConfig,
  buildPluginConfigUiSpec,
  buildPluginListUiSpec,
  parseAllowedHostEnv,
  resolveAppBranding,
  shouldUseCloudOnlyBranding,
  toCapacitorAllowNavigation,
  toViteAllowedHosts,
} from "@elizaos/host/protocol";
export * from "./boot-config";
// boot-config-react.hooks eagerly imports React; not barrel-exported so node-side
// consumers (bench server, agent boot) can import @elizaos/core without
// pulling React into the runtime closure.
export * from "./branding";
export * from "./config-catalog";

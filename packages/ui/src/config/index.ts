/**
 * Barrel for the config surface. Re-exports the app-config types from
 * `@elizaos/shared` (the canonical app-config lives in
 * `@elizaos/app/config/app-config`) alongside the local config modules.
 */
export type {
  ActionConfirm,
  ActionOnError,
  ActionOnSuccess,
  AllowedHostPattern,
  AndroidUserAgentMarker,
  AndVisibility,
  AospVariantConfig,
  AppAndroidConfig,
  AppConfig,
  AppDesktopConfig,
  AppPackagingConfig,
  AppWebConfig,
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
} from "@elizaos/shared";
export {
  parseAllowedHostEnv,
  toCapacitorAllowNavigation,
  toViteAllowedHosts,
} from "@elizaos/shared/config/allowed-hosts";
export { resolveAppBranding } from "@elizaos/shared/config/app-config";
export { shouldUseCloudOnlyBranding } from "@elizaos/shared/config/cloud-only";
export {
  buildPluginConfigUiSpec,
  buildPluginListUiSpec,
} from "@elizaos/shared/config/plugin-ui-spec";
export * from "./boot-config";
// boot-config-react.hooks eagerly imports React; not barrel-exported so node-side
// consumers (bench server, agent boot) can import @elizaos/shared without
// pulling React into the runtime closure.
export * from "./branding";
export * from "./config-catalog";

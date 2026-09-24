/**
 * Barrel for the config surface. Re-exports the app-config types from
 * `@elizaos/shared` (the canonical app-config lives in
 * `@elizaos/app/config/app-config`) alongside the local config modules.
 */
export { type ActionConfirm, type ActionOnError, type ActionOnSuccess, type AndVisibility, type AuthState, type AuthVisibility, type BuiltinValidator, type CondExpr, type DynamicProp, type NotVisibility, type OrVisibility, type PatchOp, type PathVisibility, type RepeatConfig, type UIStreamConfig, type UiAction, type UiComponentType, type UiElement, type UiEventBindings, type UiRenderContext, type UiSpec, type UiSpecValidationCheck, type UiSpecValidationConfig, type UiSpecVisibilityCondition, type VisibilityOperator } from "@elizaos/core/config/ui-spec";
export { type AndroidUserAgentMarker, type AospVariantConfig, type AppAndroidConfig, type AppConfig, type AppDesktopConfig, type AppPackagingConfig, type AppWebConfig } from "@elizaos/core/config/app-config";
export { type AllowedHostPattern, parseAllowedHostEnv, toCapacitorAllowNavigation, toViteAllowedHosts } from "@elizaos/core/config/allowed-hosts";
export { buildPluginConfigUiSpec, buildPluginListUiSpec } from "@elizaos/core/config/plugin-ui-spec";
export { resolveAppBranding } from "@elizaos/core/config/app-config";
export { shouldUseCloudOnlyBranding } from "@elizaos/core/config/cloud-only";
export * from "./boot-config";
// boot-config-react.hooks eagerly imports React; not barrel-exported so node-side
// consumers (bench server, agent boot) can import @elizaos/shared without
// pulling React into the runtime closure.
export * from "./branding";
export * from "./config-catalog";

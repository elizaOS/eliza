/**
 * Barrel for the config surface. Re-exports the app-config types from
 * `@elizaos/shared` (the canonical app-config lives in
 * `@elizaos/app-core/config/app-config`) alongside the local config modules.
 */
export type {
  AndroidUserAgentMarker,
  AospVariantConfig,
  AppAndroidConfig,
  AppConfig,
  AppDesktopConfig,
  AppPackagingConfig,
  AppWebConfig,
} from "@elizaos/shared";
export { resolveAppBranding } from "@elizaos/shared";
export * from "./allowed-hosts";
export * from "./boot-config";
// boot-config-react.hooks eagerly imports React; not barrel-exported so node-side
// consumers (bench server, agent boot) can import @elizaos/shared without
// pulling React into the runtime closure.
export * from "./branding";
export * from "./cloud-only";
export * from "./config-catalog";
export {
  buildPluginConfigUiSpec,
  buildPluginListUiSpec,
} from "./plugin-ui-spec";
export * from "./ui-spec";

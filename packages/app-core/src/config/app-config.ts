/**
 * Config barrel: re-exports the AppConfig type family plus DEFAULT_APP_CONFIG
 * and resolveAppBranding from @elizaos/shared, so app-core consumers import app
 * configuration from one local path rather than reaching into shared directly.
 */
export {
  type AndroidUserAgentMarker,
  type AospVariantConfig,
  type AppAndroidConfig,
  type AppConfig,
  type AppDesktopConfig,
  type AppPackagingConfig,
  type AppWebConfig,
  DEFAULT_APP_CONFIG,
  resolveAppBranding,
} from "@elizaos/shared";

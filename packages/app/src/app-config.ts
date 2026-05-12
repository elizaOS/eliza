import { resolveAppBranding } from "@elizaos/ui/config/app-config";
import appConfig from "../app.config";

export const APP_CONFIG = appConfig;
export const APP_BRANDING_BASE = resolveAppBranding(APP_CONFIG);
export const APP_LOG_PREFIX = `[${APP_CONFIG.appName}]`;
export const APP_NAMESPACE =
  APP_CONFIG.namespace?.trim() || APP_CONFIG.cliName.trim();
export const APP_URL_SCHEME =
  APP_CONFIG.desktop?.urlScheme?.trim() || APP_CONFIG.cliName.trim();

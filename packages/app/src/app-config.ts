/**
 * App-identity re-exports for the shell. Surfaces the package-root
 * `app.config.ts` as `APP_CONFIG` and derives the values the rest of
 * `packages/app` reads: the branding base (`APP_BRANDING_BASE`), log prefix,
 * namespace, and desktop URL scheme. Namespace and URL scheme fall back to the
 * CLI name when unset. This is the white-label seam — swap `app.config.ts` to
 * rebrand.
 */
import { resolveAppBranding } from "@elizaos/app-core";
import appConfig from "../app.config";

export const APP_CONFIG = appConfig;
export const APP_BRANDING_BASE = resolveAppBranding(APP_CONFIG);
export const APP_LOG_PREFIX = `[${APP_CONFIG.appName}]`;
export const APP_NAMESPACE =
  APP_CONFIG.namespace?.trim() || APP_CONFIG.cliName.trim();
export const APP_URL_SCHEME =
  APP_CONFIG.desktop?.urlScheme?.trim() || APP_CONFIG.cliName.trim();

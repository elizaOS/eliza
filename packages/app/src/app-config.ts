/**
 * App-identity re-exports for the shell. Surfaces the package-root
 * `app.config.ts` as `APP_CONFIG` and derives the values the rest of
 * `packages/app` reads: the branding base (`APP_BRANDING_BASE`), log prefix,
 * namespace, and desktop URL scheme. Namespace and URL scheme fall back to the
 * CLI name when unset. This is the white-label seam — swap `app.config.ts` to
 * rebrand.
 */
import { resolveAppBranding } from "@elizaos/app-core";
import type { DesktopHostConfig } from "@elizaos/ui/config";
import appConfig from "../app.config";

export const APP_CONFIG = appConfig;
export const APP_BRANDING_BASE = resolveAppBranding(APP_CONFIG);
export const APP_LOG_PREFIX = `[${APP_CONFIG.appName}]`;
export const APP_NAMESPACE =
  APP_CONFIG.namespace?.trim() || APP_CONFIG.cliName.trim();
export const APP_URL_SCHEME =
  APP_CONFIG.desktop?.urlScheme?.trim() || APP_CONFIG.cliName.trim();

/**
 * Resolve the pre-React API-base signal used by desktop branding.
 *
 * Electrobun injects the canonical boot config before the renderer module
 * runs. Legacy host globals remain fallbacks for older embedders, but must not
 * be the only signals: otherwise a packaged local desktop points at its local
 * API while still rendering the cloud-only sign-in pill.
 */
export function resolveInjectedAppApiBase(input: {
  legacyApiBase?: string;
  brandedApiBase?: unknown;
  bootConfigApiBase?: string;
}): string | undefined {
  return (
    input.bootConfigApiBase ??
    input.legacyApiBase ??
    (typeof input.brandedApiBase === "string"
      ? input.brandedApiBase
      : undefined)
  );
}

/** Resolve only a complete native-owned desktop identity from boot or URL. */
export function resolveDesktopHostBootConfig(
  search: string,
  injected?: DesktopHostConfig,
): DesktopHostConfig | undefined {
  if (injected) return injected;
  const params = new URLSearchParams(search);
  const platform = params.get("elizaDesktopPlatform");
  const surface = params.get("elizaDesktopSurface");
  if (
    (platform === "darwin" || platform === "linux" || platform === "win32") &&
    (surface === "bottom-bar" || surface === "default" || surface === "kiosk")
  ) {
    return { platform, surface };
  }
  return undefined;
}

import fs from "node:fs";
import path from "node:path";

/**
 * Parses appId / appName / urlScheme out of a host app's `app.config.ts`
 * via regex (no TS evaluation, so callers stay bun-import-free).
 *
 * Used by desktop and mobile build scripts to forward identity into
 * downstream env vars (`ELIZA_APP_NAME`, `ELIZA_APP_ID`, `ELIZA_URL_SCHEME`,
 * `ELIZA_NAMESPACE`).
 */
export function readAppIdentity(appDir) {
  const cfgPath = path.join(appDir, "app.config.ts");
  if (!fs.existsSync(cfgPath)) {
    throw new Error(`app.config.ts not found at ${cfgPath}`);
  }
  const src = fs.readFileSync(cfgPath, "utf8");
  const appId = src.match(/appId:\s*["']([^"']+)["']/)?.[1];
  const appName = src.match(/appName:\s*["']([^"']+)["']/)?.[1];
  const desktopBundleId = src.match(
    /desktop\s*:\s*\{[\s\S]*?bundleId\s*:\s*["']([^"']+)["']/,
  )?.[1];
  const desktopUrlScheme = src.match(
    /desktop\s*:\s*\{[\s\S]*?urlScheme\s*:\s*["']([^"']+)["']/,
  )?.[1];
  const topLevelUrlScheme = src.match(/urlScheme:\s*["']([^"']+)["']/)?.[1];
  const namespace = src.match(/namespace:\s*["']([^"']+)["']/)?.[1];
  if (!appId || !appName) {
    throw new Error(
      `Could not parse appId/appName from ${cfgPath} (regex failed)`,
    );
  }
  return {
    appId: desktopBundleId ?? appId,
    appName,
    urlScheme: desktopUrlScheme ?? topLevelUrlScheme ?? appId,
    namespace: namespace ?? "eliza",
  };
}

/**
 * Builds an env-var fragment that propagates app identity to the
 * Electrobun shell config. Caller-supplied env wins so explicit
 * overrides keep working.
 */
export function appIdentityEnv(appDir, existing = process.env) {
  const identity = readAppIdentity(appDir);
  return {
    ELIZA_APP_NAME: existing.ELIZA_APP_NAME?.trim() || identity.appName,
    ELIZA_APP_ID: existing.ELIZA_APP_ID?.trim() || identity.appId,
    ELIZA_URL_SCHEME: existing.ELIZA_URL_SCHEME?.trim() || identity.urlScheme,
    ELIZA_NAMESPACE: existing.ELIZA_NAMESPACE?.trim() || identity.namespace,
  };
}

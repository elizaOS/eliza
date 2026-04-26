/**
 * Auto-enable `@elizaos/plugin-plugin-manager` via `plugins.allow` so the
 * dashboard "Install Plugin" flow works. The plugin is bundled but optional
 * (see OPTIONAL_CORE_PLUGINS in the agent runtime).
 *
 * Skipped when `ELIZA_DISABLE_PLUGIN_MANAGER_AUTO_ENABLE=1` is set.
 */

import {
  loadElizaConfig,
  saveElizaConfig,
} from "@elizaos/agent";

let _checked = false;
let _lastResult: PluginManagerGuardResult = "error";

export const PLUGIN_MANAGER_UNAVAILABLE_ERROR =
  "Plugin manager service not found";

export type PluginManagerGuardResult =
  | "enabled"
  | "already-enabled"
  | "disabled-by-user"
  | "disabled-by-env"
  | "error";

export function getPluginManagerBlockReason(
  result: PluginManagerGuardResult,
): string | null {
  if (result === "disabled-by-user") {
    return "plugin-manager is explicitly disabled in config";
  }
  if (result === "disabled-by-env") {
    return "plugin-manager auto-enable is disabled by ELIZA_DISABLE_PLUGIN_MANAGER_AUTO_ENABLE=1";
  }
  return null;
}

export async function ensurePluginManagerAllowed(): Promise<PluginManagerGuardResult> {
  if (_checked) return _lastResult;
  if (process.env.ELIZA_DISABLE_PLUGIN_MANAGER_AUTO_ENABLE === "1") {
    _checked = true;
    _lastResult = "disabled-by-env";
    return _lastResult;
  }
  // Renderer/browser bundles cannot safely load the local config helpers from
  // the agent runtime. In that environment we surface a non-fatal error state
  // and let the server-side action path handle plugin-manager recovery.
  if (typeof window !== "undefined") {
    _checked = true;
    _lastResult = "error";
    return _lastResult;
  }
  try {
    const config = loadElizaConfig();
    const PKG = "@elizaos/plugin-plugin-manager";
    const entries =
      config.plugins?.entries ?? ({} as Record<string, { enabled?: boolean }>);
    const id = "plugin-manager";
    const allow = config.plugins?.allow ?? [];
    if (entries[id]?.enabled === false) {
      _checked = true;
      _lastResult = "disabled-by-user";
      return _lastResult;
    }
    if (
      allow.includes(PKG) ||
      allow.includes("plugin-manager") ||
      entries[id]?.enabled === true
    ) {
      _checked = true;
      _lastResult = "already-enabled";
      return _lastResult;
    }
    // The upstream ElizaConfig type marks `plugins` as a complex branded type
    // that doesn't allow direct property assignment. We know the runtime shape
    // is a plain object with an `entries` record, so we cast through unknown.
    config.plugins ??= {} as unknown as typeof config.plugins;
    const nextAllow = [...allow];
    if (!nextAllow.includes(PKG)) {
      nextAllow.push(PKG);
    }
    (config.plugins as Record<string, unknown>).allow = nextAllow;
    saveElizaConfig(config);
    console.info(
      "[eliza] Auto-enabled plugin-manager for dashboard plugin installs. " +
        "Set ELIZA_DISABLE_PLUGIN_MANAGER_AUTO_ENABLE=1 to prevent this.",
    );
    _checked = true;
    _lastResult = "enabled";
    return _lastResult;
  } catch {
    // Non-fatal — plugin install button won't work but everything else is fine
    _checked = true;
    _lastResult = "error";
    return _lastResult;
  }
}

/** Reset the in-process guard (for testing only). @internal */
export function _resetPluginManagerChecked(): void {
  _checked = false;
  _lastResult = "error";
}

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to `eliza/plugins` — workspace plugin root. Native plugins
 * live under `plugin-native-*` (formerly `packages/native-plugins/*`).
 * Resolved from `packages/app/scripts/` so build scripts and repo utilities share one root.
 */
const NATIVE_PLUGIN_PREFIX = "plugin-native-";
export const NATIVE_PLUGINS_ROOT = path.resolve(__dirname, "../../../plugins");

/**
 * Short names of each real native workspace plugin (without the
 * `plugin-native-` prefix), matching the historical directory names that
 * lived under `packages/native-plugins/`.
 */
export const CAPACITOR_PLUGIN_NAMES = fs
  .readdirSync(NATIVE_PLUGINS_ROOT, { withFileTypes: true })
  .filter(
    (entry) =>
      entry.isDirectory() && entry.name.startsWith(NATIVE_PLUGIN_PREFIX),
  )
  .map((entry) => entry.name.slice(NATIVE_PLUGIN_PREFIX.length))
  .filter((name) => {
    const pluginDir = path.join(
      NATIVE_PLUGINS_ROOT,
      `${NATIVE_PLUGIN_PREFIX}${name}`,
    );
    return (
      fs.existsSync(path.join(pluginDir, "package.json")) &&
      fs.existsSync(path.join(pluginDir, "src", "index.ts"))
    );
  })
  .sort((left, right) => left.localeCompare(right));

/** Resolve the absolute plugin directory for a short native plugin name. */
export function resolveNativePluginDir(name) {
  return path.join(NATIVE_PLUGINS_ROOT, `${NATIVE_PLUGIN_PREFIX}${name}`);
}

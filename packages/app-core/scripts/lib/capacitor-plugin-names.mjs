import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to `eliza/plugins` — the workspace plugin root. Native
 * plugins live under `plugin-native-*` (formerly
 * `packages/native-plugins/*`). Resolved relative to this script so build
 * scripts and repo utilities share one root regardless of the host fork's
 * layout.
 */
const NATIVE_PLUGIN_DIR_PREFIX = "plugin-native-";
const sourcePluginsRoot = path.resolve(__dirname, "../../../../plugins");

export const NATIVE_PLUGINS_ROOT = fs.existsSync(sourcePluginsRoot)
  ? sourcePluginsRoot
  : path.resolve(process.cwd(), "node_modules");

/**
 * Short names of each real native workspace plugin (without the
 * `plugin-native-` prefix), matching the historical directory names that
 * lived under `packages/native-plugins/`.
 */
export const CAPACITOR_PLUGIN_NAMES = fs.existsSync(sourcePluginsRoot)
  ? fs
      .readdirSync(NATIVE_PLUGINS_ROOT, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && entry.name.startsWith(NATIVE_PLUGIN_DIR_PREFIX),
      )
      .map((entry) => entry.name.slice(NATIVE_PLUGIN_DIR_PREFIX.length))
      .filter((name) => {
        const pluginDir = path.join(
          NATIVE_PLUGINS_ROOT,
          `${NATIVE_PLUGIN_DIR_PREFIX}${name}`,
        );
        return (
          fs.existsSync(path.join(pluginDir, "package.json")) &&
          fs.existsSync(path.join(pluginDir, "src", "index.ts"))
        );
      })
      .sort((left, right) => left.localeCompare(right))
  : [];

/** Resolve the absolute plugin directory for a short native plugin name. */
export function resolveNativePluginDir(name) {
  return path.join(NATIVE_PLUGINS_ROOT, `${NATIVE_PLUGIN_DIR_PREFIX}${name}`);
}

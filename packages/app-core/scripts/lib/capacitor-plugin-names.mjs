import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to `eliza/packages/native-plugins` (Capacitor + Electrobun
 * plugin packages). Resolved relative to this script so build scripts and
 * repo utilities share one root regardless of the host fork's layout.
 */
const sourceNativePluginsRoot = path.resolve(
  __dirname,
  "../../../native-plugins",
);

export const NATIVE_PLUGINS_ROOT = fs.existsSync(sourceNativePluginsRoot)
  ? sourceNativePluginsRoot
  : path.resolve(process.cwd(), "node_modules");

/** Short names of each real workspace package under {@link NATIVE_PLUGINS_ROOT}. */
export const CAPACITOR_PLUGIN_NAMES = fs.existsSync(sourceNativePluginsRoot)
  ? fs
      .readdirSync(NATIVE_PLUGINS_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => {
        const pluginDir = path.join(NATIVE_PLUGINS_ROOT, name);
        return (
          fs.existsSync(path.join(pluginDir, "package.json")) &&
          fs.existsSync(path.join(pluginDir, "src", "index.ts"))
        );
      })
      .sort((left, right) => left.localeCompare(right))
  : [];

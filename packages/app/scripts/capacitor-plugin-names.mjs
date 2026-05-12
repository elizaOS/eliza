import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to `eliza/packages/native-plugins` (Capacitor + Electrobun plugin packages).
 * Resolved from `packages/app/scripts/` so build scripts and repo utilities share one root.
 */
export const NATIVE_PLUGINS_ROOT = path.resolve(
  __dirname,
  "../../../packages/native-plugins",
);

/** Short names of each real workspace package under {@link NATIVE_PLUGINS_ROOT}. */
export const CAPACITOR_PLUGIN_NAMES = fs
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
  .sort((left, right) => left.localeCompare(right));

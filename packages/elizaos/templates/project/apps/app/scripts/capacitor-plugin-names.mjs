import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const localNativePluginsRoot = path.resolve(
  repoRoot,
  "eliza/packages/native-plugins",
);

function readSourceModeMarker() {
  try {
    const raw = fs
      .readFileSync(path.join(repoRoot, ".elizaos/source-mode"), "utf8")
      .trim()
      .toLowerCase();
    if (["local", "source", "workspace"].includes(raw)) return "local";
  } catch {
    return null;
  }
  return null;
}

function shouldUseLocalNativePlugins() {
  const sourceMode = (
    process.env.ELIZA_SOURCE ??
    readSourceModeMarker() ??
    "packages"
  ).toLowerCase();
  return (
    ["local", "source", "workspace"].includes(sourceMode) &&
    fs.existsSync(localNativePluginsRoot)
  );
}

/**
 * Absolute path to local native plugin packages when source mode is local.
 * Package mode intentionally has no local native plugin build step.
 */
export const NATIVE_PLUGINS_ROOT = localNativePluginsRoot;

/** Short names of each workspace package under {@link NATIVE_PLUGINS_ROOT}. */
export const CAPACITOR_PLUGIN_NAMES = shouldUseLocalNativePlugins()
  ? [
      "gateway",
      "swabble",
      "camera",
      "screencapture",
      "canvas",
      "desktop",
      "location",
      "mobile-signals",
      "talkmode",
      "agent",
      "websiteblocker",
    ]
  : [];

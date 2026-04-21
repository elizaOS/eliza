import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to `eliza/packages/native-plugins` (Capacitor + Electrobun plugin packages).
 * Resolved from `apps/app/scripts/` so build scripts and repo utilities share one root.
 */
export const NATIVE_PLUGINS_ROOT = path.resolve(
  __dirname,
  "../../../eliza/packages/native-plugins",
);

/** Short names of each workspace package under {@link NATIVE_PLUGINS_ROOT}. */
export const CAPACITOR_PLUGIN_NAMES = [
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
];

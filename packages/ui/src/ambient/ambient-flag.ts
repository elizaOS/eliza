/**
 * Ambient-mode build flag.
 *
 * Ambient (always-listening) capture is a distinct, privacy-loaded surface from
 * the pendant transcript view. It ships OFF by default and is only reachable
 * when the operator opts in via `VITE_ENABLE_AMBIENT`. The flag mirrors the
 * `VOICE_AMBIENT_ENABLED` server gate from AMBIENT-MODE-DESIGN section 9: when
 * off, none of the ambient nav/route/settings surfaces mount, so ambient adds
 * zero behavior to the existing app.
 *
 * This is intentionally the same string-compare shape the navigation module
 * uses for its own vite flags so the semantics ("anything but the literal
 * string false is on") stay identical across the codebase.
 */

type RuntimeImportMeta = ImportMeta & {
  env?: Record<string, unknown>;
};

const ambientViteEnv = (import.meta as RuntimeImportMeta).env;

/**
 * Read a vite env flag with an explicit default. `null`/`undefined` returns the
 * default; any value other than the literal string "false" (case-insensitive)
 * is treated as enabled.
 */
export function readAmbientFlag(
  name: string,
  defaultValue: boolean,
  env: Record<string, unknown> | undefined = ambientViteEnv,
): boolean {
  const value = env?.[name];
  if (value == null) return defaultValue;
  return String(value).toLowerCase() !== "false";
}

/**
 * Master ambient-mode toggle. Default OFF — ambient must be explicitly enabled.
 */
export const AMBIENT_ENABLED = readAmbientFlag("VITE_ENABLE_AMBIENT", false);

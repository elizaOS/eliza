/**
 * Gate for the first-run runtime chooser (the local / remote onboarding paths).
 *
 * The product onboards through Eliza Cloud only by default (#13377/#15527): the
 * chooser is OFF unless a developer/test build explicitly enables it. The
 * Play-Store cloud-locked Android variant can never enable the chooser because
 * that build must not expose a local backend regardless of developer overrides.
 * The local and remote paths stay in-tree for development: a build can enable
 * the chooser with `VITE_ELIZA_ENABLE_RUNTIME_CHOOSER=1`, and tests or a
 * running shell can flip the localStorage override without a rebuild (explicit
 * "1"/"0" beats the build default).
 */

import { isAndroidCloudBuild } from "../platform/android-runtime";

/** localStorage override: "1" enables the chooser, "0" disables, unset defers to the build default. */
export const RUNTIME_CHOOSER_OVERRIDE_STORAGE_KEY =
  "eliza:enable-runtime-chooser";

function readOverride(): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(
      RUNTIME_CHOOSER_OVERRIDE_STORAGE_KEY,
    );
    if (raw === "1") return true;
    if (raw === "0") return false;
    return null;
  } catch {
    // error-policy:J3 storage blocked (embedded shells) — defer to the build default
    return null;
  }
}

function readBuildDefault(): boolean {
  // import.meta.env is statically replaced by Vite at compile time, so this
  // read collapses to a constant in the shipped bundle.
  const env =
    typeof import.meta !== "undefined" &&
    (import.meta as { env?: Record<string, unknown> }).env
      ? (import.meta as { env: Record<string, unknown> }).env
      : {};
  return env.VITE_ELIZA_ENABLE_RUNTIME_CHOOSER === "1";
}

/**
 * Whether onboarding offers the full runtime chooser (cloud / local / remote).
 * False (the default on production builds) means cloud-only onboarding:
 * sign in to Eliza Cloud is the one and only path, and completing it completes
 * first-run. Development and test builds opt into the local/remote chooser via
 * the Vite flag or the localStorage override; Android local sideloads no longer
 * special-case the production default.
 */
export function isRuntimeChooserEnabled(): boolean {
  if (isAndroidCloudBuild()) return false;
  const override = readOverride();
  if (override !== null) return override;
  return readBuildDefault();
}

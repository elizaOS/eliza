/**
 * Gate for the first-run runtime chooser (the local / remote onboarding paths).
 *
 * The product onboards through Eliza Cloud only by default in production
 * (#13377/#15527): the chooser is OFF unless a developer/test build explicitly
 * enables it. In Vite dev mode (`bun run dev`), the chooser defaults to ON so
 * developers see the full local/cloud/remote options without manual flag-wiring.
 * The Play-Store cloud-locked Android variant can never enable the chooser
 * because that build must not expose a local backend regardless of developer
 * overrides. The local and remote paths stay in-tree for development: a
 * production build can enable the chooser with
 * `VITE_ELIZA_ENABLE_RUNTIME_CHOOSER=1`, and tests or a running shell can flip
 * the localStorage override without a rebuild (explicit "1"/"0" beats the
 * build default).
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

function readEnv(): Record<string, unknown> {
  if (
    typeof import.meta !== "undefined" &&
    (import.meta as { env?: Record<string, unknown> }).env
  ) {
    return (import.meta as { env: Record<string, unknown> }).env;
  }
  return {};
}

/**
 * True only when running under the Vite dev server (`bun run dev`). The
 * runtime chooser defaults to ON in this mode so developers can pick
 * local/cloud/remote without setting the localStorage override or the
 * VITE_ELIZA_ENABLE_RUNTIME_CHOOSER flag. Production builds compile
 * `import.meta.env.DEV` to `false`, so this is a no-op in shipped bundles.
 */
function readDevMode(): boolean {
  const env = readEnv();
  // Vitest also sets DEV=true, but MODE="test". Requiring both values keeps
  // the developer convenience scoped to the actual default Vite dev server.
  return env.DEV === true && env.MODE === "development";
}

function readBuildDefault(): boolean {
  return readEnv().VITE_ELIZA_ENABLE_RUNTIME_CHOOSER === "1";
}

/** Inputs to the environment-independent runtime-chooser policy. */
export interface RuntimeChooserGateInputs {
  isCloudOnlyBuild: boolean;
  isCloudLockedAndroid: boolean;
  override: boolean | null;
  isViteDev: boolean;
  isBuildEnabled: boolean;
}

/**
 * Resolve chooser availability without depending on Vite's compile-time env.
 * The cloud-locked Android invariant is absolute, then an explicit runtime
 * override wins over the development and build defaults.
 */
export function resolveRuntimeChooserEnabled({
  isCloudOnlyBuild,
  isCloudLockedAndroid,
  override,
  isViteDev,
  isBuildEnabled,
}: RuntimeChooserGateInputs): boolean {
  if (isCloudOnlyBuild || isCloudLockedAndroid) return false;
  if (override !== null) return override;
  return isViteDev || isBuildEnabled;
}

/**
 * Whether onboarding offers the full runtime chooser (cloud / local / remote).
 * False (the default on production builds) means cloud-only onboarding:
 * sign in to Eliza Cloud is the one and only path, and completing it completes
 * first-run. In Vite dev mode (`bun run dev`) the chooser defaults to ON so
 * developers can choose local without manual configuration. Production and
 * test builds opt into the local/remote chooser via the Vite flag or the
 * localStorage override; Android local sideloads no longer special-case the
 * production default.
 */
export function isRuntimeChooserEnabled(isCloudOnlyBuild = false): boolean {
  return resolveRuntimeChooserEnabled({
    isCloudOnlyBuild,
    isCloudLockedAndroid: isAndroidCloudBuild(),
    override: readOverride(),
    isViteDev: readDevMode(),
    isBuildEnabled: readBuildDefault(),
  });
}

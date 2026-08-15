/**
 * Lightweight environment boot seed for the hosted public renderer.
 *
 * The public entry must not import `main.tsx`, but `/join` still reads
 * `getBootConfig().cloudApiBase` through `resolveJoinCloudApiBase()`. Without
 * this seed, staging builds that supply `VITE_ELIZA_CLOUD_BASE` keep the
 * production default and can provision against the wrong Cloud API origin.
 */

import { getBootConfig, setBootConfig } from "@elizaos/ui/config";
import { resolveIosRuntimeConfig } from "./ios-runtime";

type RuntimeEnv = Record<string, string | boolean | undefined>;

/**
 * Apply environment-derived Cloud API (and related) boot fields before public
 * routes mount. Safe to call more than once; only writes when values change.
 */
export function seedPublicWebBootConfig(
  env: RuntimeEnv = import.meta.env as RuntimeEnv,
): void {
  const runtime = resolveIosRuntimeConfig(env);
  const current = getBootConfig();
  if (current.cloudApiBase === runtime.cloudApiBase) {
    return;
  }
  setBootConfig({
    ...current,
    cloudApiBase: runtime.cloudApiBase,
  });
}

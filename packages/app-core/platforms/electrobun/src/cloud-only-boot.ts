/**
 * Promotes a packaged cloud-only brand flag into the runtime env contract.
 *
 * Cloud-only consumer bundles are produced with `ELIZA_DESKTOP_CLOUD_ONLY=1`,
 * which bakes `cloudOnly: true` into the shipped `brand-config.json` and drops
 * the embedded runtime tree from the package. The packaged app launches with a
 * clean env, so at boot the flag must be re-raised as the env vars every
 * existing decision point already reads: `ELIZA_DESKTOP_CLOUD_ONLY` (the
 * cloud-only renderer branding signal in `resolveDesktopRuntimeModeSignal`)
 * `ELIZA_DESKTOP_SKIP_EMBEDDED_AGENT` (there is no runtime dist to spawn), and
 * the baked Cloud API base. That base makes the no-runtime shell external on a
 * clean install instead of leaving its renderer pointed at dead loopback.
 * Values an operator set explicitly always win; this only fills gaps.
 */

export interface CloudOnlyEnvHydration {
  /** Env keys this call actually set (empty when nothing changed). */
  applied: string[];
}

/**
 * Raise the cloud-only env contract from packaged brand config. Idempotent and
 * non-destructive: keys already present in the env (even set to an explicit
 * falsy opt-out or invalid API base for diagnostics) are left untouched.
 */
export function hydrateCloudOnlyEnv(
  brandCloudOnly: boolean,
  cloudApiBase: string | null,
  env: Record<string, string | undefined> = process.env as Record<
    string,
    string | undefined
  >,
): CloudOnlyEnvHydration {
  if (!brandCloudOnly) {
    return { applied: [] };
  }
  const applied: string[] = [];
  if (env.ELIZA_DESKTOP_CLOUD_ONLY === undefined) {
    env.ELIZA_DESKTOP_CLOUD_ONLY = "1";
    applied.push("ELIZA_DESKTOP_CLOUD_ONLY");
  }
  if (env.ELIZA_DESKTOP_SKIP_EMBEDDED_AGENT === undefined) {
    env.ELIZA_DESKTOP_SKIP_EMBEDDED_AGENT = "1";
    applied.push("ELIZA_DESKTOP_SKIP_EMBEDDED_AGENT");
  }
  const hasExplicitApiBase = [
    "ELIZA_DESKTOP_TEST_API_BASE",
    "ELIZA_DESKTOP_API_BASE",
    "ELIZA_API_BASE_URL",
    "ELIZA_API_BASE",
  ].some((key) => env[key] !== undefined);
  if (!hasExplicitApiBase && cloudApiBase) {
    env.ELIZA_DESKTOP_API_BASE = cloudApiBase;
    applied.push("ELIZA_DESKTOP_API_BASE");
  }
  return { applied };
}

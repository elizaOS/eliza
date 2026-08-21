/**
 * Resolves the explicit Cloud environment baked into desktop renderer builds.
 */

const CLOUD_TARGET_ORIGINS = Object.freeze({
  production: "https://eliza.app",
  staging: "https://staging.eliza.app",
});

/**
 * Resolve a desktop Cloud target from CLI arguments or the CI-friendly env.
 * An omitted target preserves the renderer's existing production default and
 * any explicit `VITE_ELIZA_CLOUD_BASE` override supplied by the operator.
 */
export function resolveDesktopCloudTarget(args, env = process.env) {
  const inline = args.find((arg) => arg.startsWith("--cloud-target="));
  const exactIndex = args.indexOf("--cloud-target");
  if (
    exactIndex >= 0 &&
    (!args[exactIndex + 1] || args[exactIndex + 1].startsWith("--"))
  ) {
    throw new Error(
      'Desktop Cloud target is missing. Expected "production" or "staging".',
    );
  }
  const cliValue = inline
    ? inline.slice("--cloud-target=".length)
    : exactIndex >= 0
      ? args[exactIndex + 1]
      : undefined;
  const raw = cliValue ?? env.ELIZA_DESKTOP_CLOUD_TARGET;

  if (raw === undefined || raw === null || raw.trim() === "") {
    return null;
  }

  const target = raw.trim().toLowerCase();
  if (!(target in CLOUD_TARGET_ORIGINS)) {
    throw new Error(
      `Unknown desktop Cloud target "${raw}". Expected "production" or "staging".`,
    );
  }

  return {
    target,
    origin: CLOUD_TARGET_ORIGINS[target],
  };
}

/** Return the renderer env with an explicit target baked in when requested. */
export function applyDesktopCloudTarget(env, target) {
  if (!target) return env;
  return {
    ...env,
    VITE_ELIZA_CLOUD_BASE: target.origin,
  };
}

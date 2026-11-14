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
export function resolveDesktopCloudTarget(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
) {
  let cliValue: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg !== "--cloud-target" && !arg.startsWith("--cloud-target="))
      continue;
    if (cliValue !== undefined)
      throw new Error("Desktop Cloud target was supplied more than once.");
    cliValue =
      arg === "--cloud-target"
        ? args[++index]
        : arg.slice("--cloud-target=".length);
    if (!cliValue?.trim() || cliValue.startsWith("--")) {
      throw new Error(
        'Desktop Cloud target is missing. Expected "production" or "staging".',
      );
    }
  }
  const raw = cliValue ?? env.ELIZA_DESKTOP_CLOUD_TARGET;

  if (raw === undefined || raw === null || raw.trim() === "") {
    return null;
  }

  const target = raw.trim().toLowerCase();
  if (target !== "production" && target !== "staging") {
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
export function applyDesktopCloudTarget(
  env: NodeJS.ProcessEnv,
  target: ReturnType<typeof resolveDesktopCloudTarget>,
) {
  if (!target) return env;
  return {
    ...env,
    VITE_ELIZA_CLOUD_BASE: target.origin,
  };
}

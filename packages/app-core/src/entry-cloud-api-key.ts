/**
 * Promote the staging-specific development credential only inside a launcher
 * process that explicitly selected a compatible target. Direct and packaged
 * entrypoints default to production, so NODE_ENV alone is not an authority.
 */
export function promoteLauncherScopedDevCloudApiKey(
  env: NodeJS.ProcessEnv,
): boolean {
  // Read the launch markers directly: the shared resolver freezes the process
  // authority snapshot on first access, so promotion must happen before it.
  const authority =
    env.ELIZA_DEV_SOURCE === "1"
      ? env.ELIZA_DEV_CLOUD_ENV_AUTHORITY?.trim().toLowerCase()
      : undefined;
  const permitsStagingCredential =
    authority === "staging-explicit" || authority === "self-hosted";
  if (
    env.NODE_ENV === "production" ||
    env.ELIZA_DESKTOP_PACKAGED_RUNTIME === "1" ||
    !permitsStagingCredential ||
    !env.ELIZA_DEV_CLOUD_API_KEY ||
    env.ELIZAOS_CLOUD_API_KEY
  ) {
    return false;
  }

  env.ELIZAOS_CLOUD_API_KEY = env.ELIZA_DEV_CLOUD_API_KEY;
  return true;
}

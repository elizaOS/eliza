function envFlagEnabled(raw: string | undefined): boolean {
  const normalized = String(raw ?? "")
    .trim()
    .toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
}

export function allowEphemeralCloudStateFallback(): boolean {
  if (envFlagEnabled(process.env.AGENT_ALLOW_EPHEMERAL_CLOUD_STATE)) {
    return true;
  }

  const productionLike =
    process.env.NODE_ENV === "production" || process.env.ENVIRONMENT === "production";

  return !productionLike;
}

export function assertPersistentCloudStateConfigured(
  feature: string,
  hasPersistentBackend: boolean,
): void {
  if (hasPersistentBackend || allowEphemeralCloudStateFallback()) {
    return;
  }

  throw new Error(
    `[${feature}] Redis-backed shared storage is required in production. Configure REDIS_URL or KV_* credentials, or set AGENT_ALLOW_EPHEMERAL_CLOUD_STATE=true only for local/testing.`,
  );
}

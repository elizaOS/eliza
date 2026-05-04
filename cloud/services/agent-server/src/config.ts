type Env = Record<string, string | undefined>;

export function normalizeServerName(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const normalized = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || undefined;
}

export function ensureServerName(env: Env = process.env): string | undefined {
  const explicit = env.SERVER_NAME?.trim();
  if (explicit) {
    env.SERVER_NAME = explicit;
    return explicit;
  }

  const railwayName =
    normalizeServerName(env.RAILWAY_SERVICE_NAME) ?? normalizeServerName(env.RAILWAY_SERVICE_ID);
  if (railwayName) {
    env.SERVER_NAME = railwayName;
  }

  return railwayName;
}

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function getAdvertisedServerUrl(env: Env = process.env): string {
  const explicitUrl = env.AGENT_SERVER_URL?.trim();
  if (explicitUrl) {
    return withoutTrailingSlash(explicitUrl);
  }

  const railwayPrivateDomain = env.RAILWAY_PRIVATE_DOMAIN?.trim();
  if (railwayPrivateDomain) {
    const port = env.PORT?.trim() || "3000";
    return `http://${railwayPrivateDomain}:${port}`;
  }

  const railwayPublicDomain = env.RAILWAY_PUBLIC_DOMAIN?.trim();
  if (railwayPublicDomain) {
    return `https://${railwayPublicDomain}`;
  }

  const namespace = env.POD_NAMESPACE || "eliza-agents";
  return `http://${env.SERVER_NAME}.${namespace}.svc:3000`;
}

const DEFAULT_CLOUD_SITE_URL = "https://elizacloud.ai";

function normalizeSecret(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toUpperCase() === "[REDACTED]") return null;
  return trimmed;
}

export function normalizeCloudSiteUrl(rawUrl?: string | null): string {
  const trimmed = rawUrl?.trim();
  if (!trimmed) return DEFAULT_CLOUD_SITE_URL;
  return trimmed.replace(/\/+$/, "");
}

export function resolveCloudApiBaseUrl(rawUrl?: string | null): string {
  const siteUrl = normalizeCloudSiteUrl(rawUrl);
  return siteUrl.endsWith("/api/v1") ? siteUrl : `${siteUrl}/api/v1`;
}

export function resolveCloudApiKey(
  config?: { cloud?: { apiKey?: string | null } } | null,
  runtime?: {
    getSetting?: (key: string) => unknown;
  } | null,
): string | null {
  return (
    normalizeSecret(runtime?.getSetting?.("ELIZAOS_CLOUD_API_KEY")) ??
    normalizeSecret(config?.cloud?.apiKey) ??
    normalizeSecret(process.env.ELIZAOS_CLOUD_API_KEY)
  );
}

export async function validateCloudBaseUrl(
  rawUrl?: string | null,
): Promise<string | null> {
  try {
    const parsed = new URL(normalizeCloudSiteUrl(rawUrl));
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? null
      : "Cloud base URL must use http or https.";
  } catch {
    return "Cloud base URL is invalid.";
  }
}

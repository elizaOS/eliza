import type { Service } from "@elizaos/core";

export interface CloudAuthApiKeyService {
  isAuthenticated: () => boolean;
  getApiKey?: () => string | undefined;
}

export function isCloudAuthApiKeyService(
  value: Service | null | undefined,
): value is Service & CloudAuthApiKeyService {
  return (
    value !== null &&
    value !== undefined &&
    typeof (value as Partial<CloudAuthApiKeyService>).isAuthenticated ===
      "function"
  );
}

export function normalizeCloudApiKey(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toUpperCase() === "[REDACTED]") return null;
  return trimmed;
}

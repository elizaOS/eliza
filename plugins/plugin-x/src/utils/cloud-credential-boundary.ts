import {
  resolveDevCloudAuthorityEnvValue,
  resolveDevCloudEnvAuthority,
} from "@elizaos/shared";

const LEGACY_ELIZA_CLOUD_ORIGINS = [
  "https://api.eliza.app",
  "https://api-staging.eliza.app",
  "https://cloud.eliza.app",
  "https://cloud-staging.eliza.app",
] as const;

function normalizedPathname(url: URL): string {
  const pathname = url.pathname.replace(/\/+$/, "");
  return pathname || "/";
}

/**
 * Returns true only when `endpoint` stays on the base's normalized origin and
 * at or below its path. The path-boundary check prevents `/api/v10` from being
 * treated as a child of `/api/v1`.
 */
export function isEndpointOwnedByCloudBase(
  endpoint: string,
  cloudBase: string,
): boolean {
  let endpointUrl: URL;
  let cloudBaseUrl: URL;
  try {
    endpointUrl = new URL(endpoint);
    cloudBaseUrl = new URL(cloudBase);
  } catch {
    return false;
  }
  if (
    endpointUrl.username ||
    endpointUrl.password ||
    cloudBaseUrl.username ||
    cloudBaseUrl.password ||
    endpointUrl.origin !== cloudBaseUrl.origin
  ) {
    return false;
  }

  const endpointPath = normalizedPathname(endpointUrl);
  const basePath = normalizedPathname(cloudBaseUrl);
  return (
    basePath === "/" ||
    endpointPath === basePath ||
    endpointPath.startsWith(`${basePath}/`)
  );
}

/**
 * Resolves the Eliza Cloud credential that may be delegated to an X broker or
 * personal-DM router. A launcher authority always wins over mutable runtime or
 * process configuration: the endpoint must belong to the frozen Cloud base,
 * and the credential comes only from the frozen tuple. Without an authority,
 * preserve the legacy fallback for Eliza-owned Cloud origins while refusing
 * to disclose the Cloud key to a custom endpoint.
 */
export function resolveCloudApiKeyForXEndpoint(
  endpoint: string,
  legacyCloudApiKey: string | undefined,
): string | undefined {
  if (resolveDevCloudEnvAuthority()) {
    const cloudBase = resolveDevCloudAuthorityEnvValue(
      "ELIZAOS_CLOUD_BASE_URL",
    )?.trim();
    if (!cloudBase || !isEndpointOwnedByCloudBase(endpoint, cloudBase)) {
      return undefined;
    }
    return (
      resolveDevCloudAuthorityEnvValue("ELIZAOS_CLOUD_API_KEY")?.trim() ||
      undefined
    );
  }

  const isLegacyElizaCloudEndpoint = LEGACY_ELIZA_CLOUD_ORIGINS.some((origin) =>
    isEndpointOwnedByCloudBase(endpoint, origin),
  );
  return isLegacyElizaCloudEndpoint
    ? legacyCloudApiKey?.trim() || undefined
    : undefined;
}

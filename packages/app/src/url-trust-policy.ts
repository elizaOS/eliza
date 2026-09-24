/** Pure host classifiers shared by the live shell network policy. */
import {
  ELIZA_DOMAIN_CONTRACTS,
  LEGACY_ELIZA_DOMAIN_CONTRACTS,
} from "@elizaos/shared";

export function isTrustedPrivateHttpHost(host: string): boolean {
  return (
    host === "0.0.0.0" ||
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^169\.254\.\d{1,3}\.\d{1,3}$/.test(host) ||
    host === "local" ||
    host === "internal" ||
    host === "lan" ||
    host === "ts.net" ||
    host.endsWith(".local") ||
    host.endsWith(".lan") ||
    host.endsWith(".internal") ||
    host.endsWith(".ts.net")
  );
}

export function isLoopbackApiHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1"
  );
}

const ELIZA_CLOUD_SHARED_HOSTS: ReadonlySet<string> = new Set([
  ...Object.values(ELIZA_DOMAIN_CONTRACTS).flatMap((contract) => [
    new URL(contract.marketingOrigin).hostname,
    new URL(contract.cloudAppOrigin).hostname,
    new URL(contract.cloudApiOrigin).hostname,
  ]),
  ...Object.values(LEGACY_ELIZA_DOMAIN_CONTRACTS).flatMap((contract) => [
    ...contract.marketingHostnames,
    ...contract.cloudAppHostnames,
    ...contract.cloudApiHostnames,
  ]),
]);

export function isElizaCloudSharedHost(host: string): boolean {
  return ELIZA_CLOUD_SHARED_HOSTS.has(host.toLowerCase());
}

export function isTrustedCloudOnlyApiBaseUrl(
  parsed: URL,
  cloudOnly: boolean,
): boolean {
  return (
    cloudOnly &&
    parsed.protocol === "https:" &&
    isElizaCloudSharedHost(parsed.hostname)
  );
}

export function isPrivateOrLoopbackApiHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    isLoopbackApiHost(normalized) ||
    (normalized.includes(":") &&
      (normalized.startsWith("fc") ||
        normalized.startsWith("fd") ||
        normalized.startsWith("fe80:"))) ||
    isTrustedPrivateHttpHost(normalized)
  );
}

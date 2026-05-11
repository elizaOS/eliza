import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";
import { logger } from "@elizaos/core";
import type { RegistryEndpoint } from "../config/types.eliza.ts";
import {
  isBlockedPrivateOrLinkLocalIp,
  normalizeHostLike,
} from "../security/network-policy.ts";
import type { RegistryPluginInfo } from "./registry-client-types.ts";

const BLOCKED_REGISTRY_HOST_LITERALS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "0.0.0.0",
  "169.254.169.254",
]);
const REGISTRY_ENDPOINT_FETCH_TIMEOUT_MS = 2_500;

function createRegistryEndpointFetchInit(): RequestInit {
  return {
    redirect: "error",
    signal: AbortSignal.timeout(REGISTRY_ENDPOINT_FETCH_TIMEOUT_MS),
  };
}

export function normaliseEndpointUrl(url: string): string {
  return url.replace(/\/{1,1024}$/, "");
}

export function isDefaultEndpoint(url: string, defaultUrl: string): boolean {
  return normaliseEndpointUrl(url) === normaliseEndpointUrl(defaultUrl);
}

export function parseRegistryEndpointUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Endpoint URL must be a valid absolute URL");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("Endpoint URL must use https://");
  }

  const hostname = normalizeHostLike(parsed.hostname);
  if (!hostname) throw new Error("Endpoint URL hostname is required");

  if (
    BLOCKED_REGISTRY_HOST_LITERALS.has(hostname) ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  ) {
    throw new Error(`Endpoint host "${hostname}" is blocked`);
  }

  if (net.isIP(hostname) && isBlockedPrivateOrLinkLocalIp(hostname)) {
    throw new Error(`Endpoint host "${hostname}" is blocked`);
  }

  return parsed;
}

type ResolvedRegistryEndpoint = {
  parsed: URL;
  hostname: string;
  pinnedAddress: string | null;
};

async function resolveRegistryEndpointUrlRejection(rawUrl: string): Promise<{
  rejection: string | null;
  endpoint: ResolvedRegistryEndpoint | null;
}> {
  let parsed: URL;
  try {
    parsed = parseRegistryEndpointUrl(rawUrl);
  } catch (error) {
    return {
      rejection: String(error),
      endpoint: null,
    };
  }

  const hostname = normalizeHostLike(parsed.hostname);
  if (!hostname) {
    return {
      rejection: "Endpoint URL hostname is required",
      endpoint: null,
    };
  }

  if (net.isIP(hostname)) {
    return {
      rejection: null,
      endpoint: { parsed, hostname, pinnedAddress: hostname },
    };
  }

  let addresses: Array<{ address: string }>;
  try {
    const resolved = await dnsLookup(hostname, { all: true });
    addresses = Array.isArray(resolved) ? resolved : [resolved];
  } catch {
    return {
      rejection: `Could not resolve endpoint host "${hostname}"`,
      endpoint: null,
    };
  }

  if (addresses.length === 0) {
    return {
      rejection: `Could not resolve endpoint host "${hostname}"`,
      endpoint: null,
    };
  }

  for (const entry of addresses) {
    if (isBlockedPrivateOrLinkLocalIp(entry.address)) {
      return {
        rejection: `Endpoint host "${hostname}" resolves to blocked address ${entry.address}`,
        endpoint: null,
      };
    }
  }

  return {
    rejection: null,
    endpoint: {
      parsed,
      hostname,
      pinnedAddress: addresses[0]?.address ?? null,
    },
  };
}

async function fetchSingleEndpoint(
  url: string,
  label: string,
): Promise<Map<string, RegistryPluginInfo> | null> {
  const { rejection, endpoint } =
    await resolveRegistryEndpointUrlRejection(url);
  if (rejection || !endpoint) {
    logger.warn(
      `[registry-client] Endpoint "${label}" (${url}) blocked: ${rejection ?? "validation failed"}`,
    );
    return null;
  }

  try {
    if (endpoint.pinnedAddress && !net.isIP(endpoint.hostname)) {
      const refreshed = await dnsLookup(endpoint.hostname, { all: true });
      const refreshedAddresses = new Set(
        (Array.isArray(refreshed) ? refreshed : [refreshed]).map((entry) =>
          normalizeHostLike(entry.address),
        ),
      );

      if (!refreshedAddresses.has(normalizeHostLike(endpoint.pinnedAddress))) {
        logger.warn(
          `[registry-client] Endpoint "${label}" (${url}) blocked: host resolution changed before fetch`,
        );
        return null;
      }

      for (const address of refreshedAddresses) {
        if (isBlockedPrivateOrLinkLocalIp(address)) {
          logger.warn(
            `[registry-client] Endpoint "${label}" (${url}) blocked: host resolves to blocked address ${address}`,
          );
          return null;
        }
      }
    }

    const resp = await fetch(url, createRegistryEndpointFetchInit());
    if (!resp.ok) {
      logger.warn(
        `[registry-client] Endpoint "${label}" (${url}): ${resp.status} ${resp.statusText}`,
      );
      return null;
    }
    const data = (await resp.json()) as {
      registry?: Record<string, unknown>;
    };
    if (!data.registry || typeof data.registry !== "object") {
      logger.warn(
        `[registry-client] Endpoint "${label}" (${url}): missing registry field`,
      );
      return null;
    }
    const plugins = new Map<string, RegistryPluginInfo>();
    for (const [name, raw] of Object.entries(data.registry)) {
      const e = raw as Record<string, unknown>;
      const git = (e.git ?? {}) as Record<string, unknown>;
      const npm = (e.npm ?? {}) as Record<string, unknown>;
      const supports = (e.supports ?? { v0: false, v1: false, v2: false }) as {
        v0: boolean;
        v1: boolean;
        v2: boolean;
      };
      plugins.set(name, {
        name,
        gitRepo: (git.repo as string) ?? "unknown/unknown",
        gitUrl: `https://github.com/${(git.repo as string) ?? "unknown/unknown"}.git`,
        directory: (e.directory as string | null) ?? null,
        description: (e.description as string) ?? "",
        homepage: (e.homepage as string) ?? null,
        topics: (e.topics as string[]) ?? [],
        stars: (e.stargazers_count as number) ?? 0,
        language: (e.language as string) ?? "TypeScript",
        npm: {
          package: (npm.repo as string) ?? name,
          v0Version: (npm.v0 as string) ?? null,
          v1Version: (npm.v1 as string) ?? null,
          v2Version: (npm.v2 as string) ?? null,
        },
        git: {
          v0Branch:
            ((git.v0 as Record<string, unknown>)?.branch as string) ?? null,
          v1Branch:
            ((git.v1 as Record<string, unknown>)?.branch as string) ?? null,
          v2Branch:
            ((git.v2 as Record<string, unknown>)?.branch as string) ?? null,
        },
        supports,
        kind: e.kind as string | undefined,
        registryKind: e.registryKind as string | undefined,
        origin: e.origin as string | undefined,
        source: e.source as string | undefined,
        support: e.support as string | undefined,
        builtIn: e.builtIn as boolean | undefined,
        firstParty: e.firstParty as boolean | undefined,
        thirdParty: e.thirdParty as boolean | undefined,
        status: e.status as string | undefined,
      });
    }
    return plugins;
  } catch (err) {
    logger.warn(
      `[registry-client] Endpoint "${label}" (${url}) failed: ${String(err)}`,
    );
    return null;
  }
}

export async function mergeCustomEndpoints(
  plugins: Map<string, RegistryPluginInfo>,
  endpoints: RegistryEndpoint[],
): Promise<void> {
  const enabledEndpoints = endpoints.filter((ep) => ep.enabled !== false);
  if (enabledEndpoints.length === 0) return;

  const results = await Promise.allSettled(
    enabledEndpoints.map((ep) => fetchSingleEndpoint(ep.url, ep.label)),
  );

  for (const result of results) {
    if (result.status === "fulfilled" && result.value) {
      for (const [name, info] of result.value) {
        if (plugins.has(name)) {
          logger.warn(
            `[registry-client] Ignoring custom endpoint override for ${name}`,
          );
          continue;
        }
        plugins.set(name, info);
      }
    }
  }
}

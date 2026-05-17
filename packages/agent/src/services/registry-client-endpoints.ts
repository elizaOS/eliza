import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";
import { logger } from "@elizaos/core";
import type { RegistryEndpoint } from "../config/types.eliza.ts";
import {
  isBlockedPrivateOrLinkLocalIp,
  normalizeHostLike,
} from "../security/network-policy.ts";
import type { RegistryPluginInfo } from "./registry-client-types.ts";

/** Raw shape of a single entry returned by a registry endpoint's JSON response. */
interface RawRegistryVersionRef {
  branch?: string;
}

interface RawRegistryGit {
  repo?: string;
  v0?: RawRegistryVersionRef;
  v1?: RawRegistryVersionRef;
  v2?: RawRegistryVersionRef;
}

interface RawRegistryNpm {
  repo?: string;
  v0?: string;
  v1?: string;
  v2?: string;
}

interface RawRegistryEntry {
  git?: RawRegistryGit;
  npm?: RawRegistryNpm;
  supports?: { v0: boolean; v1: boolean; v2: boolean };
  directory?: string | null;
  description?: string;
  homepage?: string | null;
  topics?: string[];
  stargazers_count?: number;
  language?: string;
  kind?: string;
  registryKind?: string;
  origin?: string;
  source?: string;
  support?: string;
  builtIn?: boolean;
  firstParty?: boolean;
  thirdParty?: boolean;
  status?: string;
}

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
      registry?: Record<string, RawRegistryEntry>;
    };
    if (!data.registry || typeof data.registry !== "object") {
      logger.warn(
        `[registry-client] Endpoint "${label}" (${url}): missing registry field`,
      );
      return null;
    }
    const plugins = new Map<string, RegistryPluginInfo>();
    for (const [name, e] of Object.entries(data.registry)) {
      const git = e.git ?? {};
      const npm = e.npm ?? {};
      const supports = e.supports ?? { v0: false, v1: false, v2: false };
      plugins.set(name, {
        name,
        gitRepo: git.repo ?? "unknown/unknown",
        gitUrl: `https://github.com/${git.repo ?? "unknown/unknown"}.git`,
        directory: e.directory ?? null,
        description: e.description ?? "",
        homepage: e.homepage ?? null,
        topics: e.topics ?? [],
        stars: e.stargazers_count ?? 0,
        language: e.language ?? "TypeScript",
        npm: {
          package: npm.repo ?? name,
          v0Version: npm.v0 ?? null,
          v1Version: npm.v1 ?? null,
          v2Version: npm.v2 ?? null,
        },
        git: {
          v0Branch: git.v0?.branch ?? null,
          v1Branch: git.v1?.branch ?? null,
          v2Branch: git.v2?.branch ?? null,
        },
        supports,
        kind: e.kind,
        registryKind: e.registryKind,
        origin: e.origin,
        source: e.source,
        support: e.support,
        builtIn: e.builtIn,
        firstParty: e.firstParty,
        thirdParty: e.thirdParty,
        status: e.status,
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

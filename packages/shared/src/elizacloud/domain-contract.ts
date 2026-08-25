/**
 * Canonical public-domain and retired-dashboard route contract for the Eliza
 * site, managed Cloud app, Cloud API, and managed-agent ingress. Legacy
 * elizacloud.ai names remain classified so request boundaries can redirect or
 * proxy them without treating them as canonical product origins.
 */

import { trimEndCharacters } from "../utils/string-boundaries.js";

export type ElizaCloudEnvironment = "production" | "staging";

export interface ElizaDomainContract {
  marketingOrigin: string;
  cloudAppOrigin: string;
  cloudApiOrigin: string;
  dedicatedAgentHostnameSuffix: string;
}

export interface ElizaServiceDomainContract {
  publicBlobOrigin: string;
  pluginRegistryOrigin: string;
  relayOrigin: string;
  headscaleOrigin: string;
  tunnelProxyOrigin: string;
  tunnelSessionHostnameSuffix: string;
  x402Origin: string;
  hostedAppHostnameSuffix: string;
  hostedSiteHostnameSuffix: string;
}

export const ELIZA_DOMAIN_CONTRACTS: Readonly<
  Record<ElizaCloudEnvironment, ElizaDomainContract>
> = Object.freeze({
  production: Object.freeze({
    marketingOrigin: "https://eliza.app",
    cloudAppOrigin: "https://cloud.eliza.app",
    cloudApiOrigin: "https://api.eliza.app",
    dedicatedAgentHostnameSuffix: ".cloud.eliza.app",
  }),
  staging: Object.freeze({
    marketingOrigin: "https://staging.eliza.app",
    cloudAppOrigin: "https://cloud-staging.eliza.app",
    cloudApiOrigin: "https://api-staging.eliza.app",
    dedicatedAgentHostnameSuffix: ".cloud-staging.eliza.app",
  }),
});

/** Public service hosts that must move in lockstep with each product domain. */
export const ELIZA_SERVICE_DOMAIN_CONTRACTS: Readonly<
  Record<ElizaCloudEnvironment, ElizaServiceDomainContract>
> = Object.freeze({
  production: Object.freeze({
    publicBlobOrigin: "https://blob.eliza.app",
    pluginRegistryOrigin: "https://plugins.eliza.app",
    relayOrigin: "https://relay.eliza.app",
    headscaleOrigin: "https://headscale.eliza.app",
    tunnelProxyOrigin: "https://tunnel.eliza.app",
    tunnelSessionHostnameSuffix: ".tunnel.eliza.app",
    x402Origin: "https://x402.eliza.app",
    hostedAppHostnameSuffix: ".apps.eliza.app",
    hostedSiteHostnameSuffix: ".sites.eliza.app",
  }),
  staging: Object.freeze({
    publicBlobOrigin: "https://blob-staging.eliza.app",
    pluginRegistryOrigin: "https://plugins-staging.eliza.app",
    relayOrigin: "https://relay-staging.eliza.app",
    headscaleOrigin: "https://headscale-staging.eliza.app",
    tunnelProxyOrigin: "https://tunnel-staging.eliza.app",
    tunnelSessionHostnameSuffix: ".tunnel-staging.eliza.app",
    x402Origin: "https://x402-staging.eliza.app",
    hostedAppHostnameSuffix: ".apps-staging.eliza.app",
    hostedSiteHostnameSuffix: ".sites-staging.eliza.app",
  }),
});

/**
 * Hosts that serve an A/B variant of the public landing from their own Pages
 * project. They classify as marketing so the shell renders the page instead of
 * booting the agent app, and they are exempt from canonical-host redirection —
 * bouncing them to eliza.app would defeat the experiment.
 */
export const LANDING_AB_HOSTNAMES: readonly string[] = Object.freeze([
  "b.eliza.app",
  "eliza-app-b.pages.dev",
]);

export const LEGACY_ELIZA_DOMAIN_CONTRACTS = Object.freeze({
  production: Object.freeze({
    marketingHostnames: Object.freeze([
      "elizacloud.ai",
      "www.elizacloud.ai",
      "dev.elizacloud.ai",
      // A/B variant of the public landing (see LANDING_AB_HOSTNAMES).
      ...LANDING_AB_HOSTNAMES,
    ]),
    cloudAppHostnames: Object.freeze(["app.elizacloud.ai"]),
    cloudApiHostnames: Object.freeze(["api.elizacloud.ai"]),
    dedicatedAgentHostnameSuffix: ".elizacloud.ai",
  }),
  staging: Object.freeze({
    marketingHostnames: Object.freeze(["staging.elizacloud.ai"]),
    cloudAppHostnames: Object.freeze(["app-staging.elizacloud.ai"]),
    cloudApiHostnames: Object.freeze(["api-staging.elizacloud.ai"]),
    dedicatedAgentHostnameSuffix: ".staging.elizacloud.ai",
  }),
});

export const LEGACY_ELIZA_SERVICE_DOMAIN_CONTRACTS = Object.freeze({
  production: Object.freeze({
    publicBlobOrigin: "https://blob.elizacloud.ai",
    pluginRegistryOrigin: "https://plugins.elizacloud.ai",
    relayOrigin: "https://relay.elizacloud.ai",
    headscaleOrigin: "https://headscale.elizacloud.ai",
    tunnelProxyOrigin: "https://tunnel.elizacloud.ai",
    tunnelSessionHostnameSuffix: ".tunnel.elizacloud.ai",
    x402Origin: "https://x402.elizacloud.ai",
    hostedAppHostnameSuffix: ".apps.elizacloud.ai",
    hostedSiteHostnameSuffix: ".sites.elizacloud.ai",
  }),
  staging: Object.freeze({
    publicBlobOrigin: "https://blob-staging.elizacloud.ai",
    pluginRegistryOrigin: "https://plugins.staging.elizacloud.ai",
    relayOrigin: "https://relay-staging.elizacloud.ai",
    headscaleOrigin: "https://headscale-staging.elizacloud.ai",
    tunnelProxyOrigin: "https://tunnel-staging.elizacloud.ai",
    tunnelSessionHostnameSuffix: ".tunnel-staging.elizacloud.ai",
    x402Origin: "https://x402-staging.elizacloud.ai",
    hostedAppHostnameSuffix: ".apps-staging.elizacloud.ai",
    hostedSiteHostnameSuffix: ".sites-staging.elizacloud.ai",
  }),
});

export type ElizaHostnameRole =
  | "marketing"
  | "cloud-app"
  | "cloud-api"
  | "dedicated-agent"
  | "legacy-marketing"
  | "legacy-cloud-app"
  | "legacy-cloud-api"
  | "legacy-dedicated-agent"
  | "unknown";

export interface ElizaHostnameClassification {
  role: ElizaHostnameRole;
  environment: ElizaCloudEnvironment | null;
  canonicalHostname: string | null;
  agentId: string | null;
}

const LEGACY_DASHBOARD_STATIC_TARGETS: Readonly<Record<string, string>> =
  Object.freeze({
    "/dashboard": "/cloud",
    "/dashboard/image": "/cloud/api-explorer",
    "/dashboard/video": "/cloud/api-explorer",
    "/dashboard/gallery": "/cloud/api-explorer",
    "/dashboard/voices": "/cloud/api-explorer",
    "/dashboard/containers": "/cloud/agents",
    "/dashboard/apps/create": "/cloud/apps",
    "/dashboard/earnings": "/cloud/monetization",
    "/dashboard/affiliates": "/cloud/monetization",
    "/dashboard/documents": "/cloud/agents",
  });

const LEGACY_DASHBOARD_SETTINGS_TARGETS: Readonly<Record<string, string>> =
  Object.freeze({
    connections: "/cloud/connectors",
    billing: "/cloud/billing",
    organization: "/cloud/organization",
    agents: "/cloud/agents",
  });

function hostnameOf(origin: string): string {
  return new URL(origin).hostname;
}

function mapServiceHostname(
  hostname: string,
  legacy: ElizaServiceDomainContract,
  canonical: ElizaServiceDomainContract,
): string | null {
  for (const key of [
    "publicBlobOrigin",
    "pluginRegistryOrigin",
    "relayOrigin",
    "headscaleOrigin",
    "tunnelProxyOrigin",
    "x402Origin",
  ] as const) {
    if (hostname === hostnameOf(legacy[key])) return hostnameOf(canonical[key]);
  }
  for (const key of [
    "tunnelSessionHostnameSuffix",
    "hostedAppHostnameSuffix",
    "hostedSiteHostnameSuffix",
  ] as const) {
    if (!hostname.endsWith(legacy[key])) continue;
    const label = hostname.slice(0, -legacy[key].length);
    if (/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) {
      return `${label}${canonical[key]}`;
    }
  }
  return null;
}

/** Map a legacy service hostname to its canonical eliza.app peer. */
export function canonicalElizaServiceHostname(
  rawHostname: string,
): string | null {
  const hostname = rawHostname.trim().toLowerCase().replace(/\.$/, "");
  for (const environment of ["staging", "production"] as const) {
    const mapped = mapServiceHostname(
      hostname,
      LEGACY_ELIZA_SERVICE_DOMAIN_CONTRACTS[environment],
      ELIZA_SERVICE_DOMAIN_CONTRACTS[environment],
    );
    if (mapped) return mapped;
  }
  return null;
}

/** Map a retired dashboard pathname onto its equivalent managed Cloud route. */
export function canonicalCloudPathForLegacyDashboard(
  pathname: string,
  search = "",
): string | null {
  if (pathname !== "/dashboard" && !pathname.startsWith("/dashboard/")) {
    return null;
  }

  const normalizedPathname =
    pathname.length > 1 ? trimEndCharacters(pathname, "/") : pathname;
  const staticTarget = LEGACY_DASHBOARD_STATIC_TARGETS[normalizedPathname];
  if (staticTarget) return staticTarget;

  if (
    normalizedPathname === "/dashboard/build" ||
    normalizedPathname.startsWith("/dashboard/build/")
  ) {
    return "/cloud/my-agents";
  }

  const nestedContainerMatch = normalizedPathname.match(
    /^\/dashboard\/containers\/agents\/([^/]+)$/,
  );
  if (nestedContainerMatch) {
    return `/cloud/agents/${nestedContainerMatch[1]}`;
  }

  const containerMatch = normalizedPathname.match(
    /^\/dashboard\/containers\/([^/]+)$/,
  );
  if (containerMatch) return `/cloud/agents/${containerMatch[1]}`;

  const agentChatMatch = normalizedPathname.match(
    /^\/dashboard\/agents\/([^/]+)\/chat$/,
  );
  if (agentChatMatch) return `/cloud/agents/${agentChatMatch[1]}`;

  if (normalizedPathname === "/dashboard/settings") {
    const tab = new URLSearchParams(search).get("tab") ?? "";
    return LEGACY_DASHBOARD_SETTINGS_TARGETS[tab] ?? "/cloud";
  }

  return pathname.replace(/^\/dashboard(?=\/|$)/, "/cloud");
}

function dedicatedAgentId(hostname: string, suffix: string): string | null {
  if (!hostname.endsWith(suffix)) return null;
  const label = hostname.slice(0, -suffix.length);
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label) ? label : null;
}

function classification(
  role: ElizaHostnameRole,
  environment: ElizaCloudEnvironment,
  canonicalHostname: string,
  agentId: string | null = null,
): ElizaHostnameClassification {
  return { role, environment, canonicalHostname, agentId };
}

/** Classify a hostname without consulting browser or process-global state. */
export function classifyElizaHostname(
  rawHostname: string,
): ElizaHostnameClassification {
  const hostname = rawHostname.trim().toLowerCase().replace(/\.$/, "");

  // Staging suffixes are more specific (`*.staging.elizacloud.ai`) than the
  // legacy production suffix (`*.elizacloud.ai`), so classify staging first.
  for (const environment of ["staging", "production"] as const) {
    const canonical = ELIZA_DOMAIN_CONTRACTS[environment];
    const marketingHostname = hostnameOf(canonical.marketingOrigin);
    const cloudAppHostname = hostnameOf(canonical.cloudAppOrigin);
    const cloudApiHostname = hostnameOf(canonical.cloudApiOrigin);

    if (
      hostname === marketingHostname ||
      (environment === "production" && hostname === `www.${marketingHostname}`)
    ) {
      return classification("marketing", environment, marketingHostname);
    }
    if (hostname === cloudAppHostname) {
      return classification("cloud-app", environment, cloudAppHostname);
    }
    if (hostname === cloudApiHostname) {
      return classification("cloud-api", environment, cloudApiHostname);
    }

    const canonicalAgentId = dedicatedAgentId(
      hostname,
      canonical.dedicatedAgentHostnameSuffix,
    );
    if (canonicalAgentId) {
      return classification(
        "dedicated-agent",
        environment,
        `${canonicalAgentId}${canonical.dedicatedAgentHostnameSuffix}`,
        canonicalAgentId,
      );
    }

    const legacy = LEGACY_ELIZA_DOMAIN_CONTRACTS[environment];
    if (legacy.marketingHostnames.includes(hostname)) {
      return classification("legacy-marketing", environment, marketingHostname);
    }
    if (legacy.cloudAppHostnames.includes(hostname)) {
      return classification("legacy-cloud-app", environment, cloudAppHostname);
    }
    if (legacy.cloudApiHostnames.includes(hostname)) {
      return classification("legacy-cloud-api", environment, cloudApiHostname);
    }

    const legacyAgentId = dedicatedAgentId(
      hostname,
      legacy.dedicatedAgentHostnameSuffix,
    );
    if (legacyAgentId) {
      return classification(
        "legacy-dedicated-agent",
        environment,
        `${legacyAgentId}${canonical.dedicatedAgentHostnameSuffix}`,
        legacyAgentId,
      );
    }
  }

  return {
    role: "unknown",
    environment: null,
    canonicalHostname: null,
    agentId: null,
  };
}

export function isElizaCloudControlPlaneHostname(hostname: string): boolean {
  const role = classifyElizaHostname(hostname).role;
  return (
    role === "marketing" ||
    role === "cloud-app" ||
    role === "cloud-api" ||
    role === "legacy-marketing" ||
    role === "legacy-cloud-app" ||
    role === "legacy-cloud-api"
  );
}

export function isElizaManagedCloudUiHostname(hostname: string): boolean {
  const role = classifyElizaHostname(hostname).role;
  return (
    role === "cloud-app" ||
    role === "dedicated-agent" ||
    role === "legacy-cloud-app" ||
    role === "legacy-dedicated-agent"
  );
}

export function isElizaDedicatedAgentHostname(hostname: string): boolean {
  const role = classifyElizaHostname(hostname).role;
  return role === "dedicated-agent" || role === "legacy-dedicated-agent";
}

export function elizaCloudEnvironmentForHostname(
  hostname: string | null | undefined,
): ElizaCloudEnvironment | null {
  return hostname ? classifyElizaHostname(hostname).environment : null;
}

export function buildElizaDedicatedAgentOrigin(
  agentId: string,
  environment: ElizaCloudEnvironment,
): string | null {
  const label = agentId.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) {
    return null;
  }
  return `https://${label}${ELIZA_DOMAIN_CONTRACTS[environment].dedicatedAgentHostnameSuffix}`;
}

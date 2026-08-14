/**
 * Canonical and legacy Eliza hostname and retired-dashboard route contracts
 * are exercised as a pure compatibility matrix so redirects, API routing, and
 * managed-runtime gates cannot silently disagree during the domain migration.
 */

import { describe, expect, it } from "vitest";
import {
  buildElizaDedicatedAgentOrigin,
  canonicalCloudPathForLegacyDashboard,
  canonicalElizaServiceHostname,
  classifyElizaHostname,
  ELIZA_DOMAIN_CONTRACTS,
  ELIZA_SERVICE_DOMAIN_CONTRACTS,
  isElizaCloudControlPlaneHostname,
  isElizaDedicatedAgentHostname,
  isElizaManagedCloudUiHostname,
} from "./domain-contract";

describe("Eliza domain contract", () => {
  it("publishes the canonical production and staging origins", () => {
    expect(ELIZA_DOMAIN_CONTRACTS.production).toEqual({
      marketingOrigin: "https://eliza.app",
      cloudAppOrigin: "https://cloud.eliza.app",
      cloudApiOrigin: "https://api.eliza.app",
      dedicatedAgentHostnameSuffix: ".cloud.eliza.app",
    });
    expect(ELIZA_DOMAIN_CONTRACTS.staging).toEqual({
      marketingOrigin: "https://staging.eliza.app",
      cloudAppOrigin: "https://cloud-staging.eliza.app",
      cloudApiOrigin: "https://api-staging.eliza.app",
      dedicatedAgentHostnameSuffix: ".cloud-staging.eliza.app",
    });
    expect(ELIZA_SERVICE_DOMAIN_CONTRACTS.production).toMatchObject({
      publicBlobOrigin: "https://blob.eliza.app",
      pluginRegistryOrigin: "https://plugins.eliza.app",
      relayOrigin: "https://relay.eliza.app",
      tunnelSessionHostnameSuffix: ".tunnel.eliza.app",
      hostedAppHostnameSuffix: ".apps.eliza.app",
    });
    expect(ELIZA_SERVICE_DOMAIN_CONTRACTS.staging).toMatchObject({
      publicBlobOrigin: "https://blob-staging.eliza.app",
      pluginRegistryOrigin: "https://plugins-staging.eliza.app",
      relayOrigin: "https://relay-staging.eliza.app",
      tunnelSessionHostnameSuffix: ".tunnel-staging.eliza.app",
      hostedAppHostnameSuffix: ".apps-staging.eliza.app",
    });
  });

  it.each([
    ["eliza.app", "marketing", "production", "eliza.app"],
    ["www.eliza.app", "marketing", "production", "eliza.app"],
    ["cloud.eliza.app", "cloud-app", "production", "cloud.eliza.app"],
    ["api.eliza.app", "cloud-api", "production", "api.eliza.app"],
    [
      "agent-7.cloud.eliza.app",
      "dedicated-agent",
      "production",
      "agent-7.cloud.eliza.app",
    ],
    ["staging.eliza.app", "marketing", "staging", "staging.eliza.app"],
    [
      "cloud-staging.eliza.app",
      "cloud-app",
      "staging",
      "cloud-staging.eliza.app",
    ],
    ["api-staging.eliza.app", "cloud-api", "staging", "api-staging.eliza.app"],
    [
      "agent-7.cloud-staging.eliza.app",
      "dedicated-agent",
      "staging",
      "agent-7.cloud-staging.eliza.app",
    ],
  ] as const)(
    "classifies canonical host %s",
    (hostname, role, environment, canonicalHostname) => {
      expect(classifyElizaHostname(hostname)).toMatchObject({
        role,
        environment,
        canonicalHostname,
      });
    },
  );

  it.each([
    ["elizacloud.ai", "legacy-marketing", "eliza.app"],
    ["www.elizacloud.ai", "legacy-marketing", "eliza.app"],
    ["app.elizacloud.ai", "legacy-cloud-app", "cloud.eliza.app"],
    ["api.elizacloud.ai", "legacy-cloud-api", "api.eliza.app"],
    ["staging.elizacloud.ai", "legacy-marketing", "staging.eliza.app"],
    [
      "app-staging.elizacloud.ai",
      "legacy-cloud-app",
      "cloud-staging.eliza.app",
    ],
    ["api-staging.elizacloud.ai", "legacy-cloud-api", "api-staging.eliza.app"],
    [
      "agent-7.elizacloud.ai",
      "legacy-dedicated-agent",
      "agent-7.cloud.eliza.app",
    ],
    [
      "agent-7.staging.elizacloud.ai",
      "legacy-dedicated-agent",
      "agent-7.cloud-staging.eliza.app",
    ],
  ] as const)(
    "maps legacy host %s to its canonical host",
    (hostname, role, canonicalHostname) => {
      expect(classifyElizaHostname(hostname)).toMatchObject({
        role,
        canonicalHostname,
      });
    },
  );

  it("keeps control-plane, managed-UI, and agent classifications distinct", () => {
    expect(isElizaCloudControlPlaneHostname("cloud.eliza.app")).toBe(true);
    expect(isElizaCloudControlPlaneHostname("agent-7.cloud.eliza.app")).toBe(
      false,
    );
    expect(isElizaManagedCloudUiHostname("cloud.eliza.app")).toBe(true);
    expect(isElizaManagedCloudUiHostname("api.eliza.app")).toBe(false);
    expect(isElizaDedicatedAgentHostname("agent-7.elizacloud.ai")).toBe(true);
    expect(classifyElizaHostname("vps.example.com").role).toBe("unknown");
  });

  it("builds only valid single-label dedicated agent origins", () => {
    expect(buildElizaDedicatedAgentOrigin("Agent-7", "production")).toBe(
      "https://agent-7.cloud.eliza.app",
    );
    expect(buildElizaDedicatedAgentOrigin("agent-7", "staging")).toBe(
      "https://agent-7.cloud-staging.eliza.app",
    );
    expect(buildElizaDedicatedAgentOrigin("nested.agent", "production")).toBe(
      null,
    );
  });

  it.each([
    ["blob.elizacloud.ai", "blob.eliza.app"],
    ["plugins.elizacloud.ai", "plugins.eliza.app"],
    ["headscale-staging.elizacloud.ai", "headscale-staging.eliza.app"],
    ["relay.elizacloud.ai", "relay.eliza.app"],
    ["relay-staging.elizacloud.ai", "relay-staging.eliza.app"],
    ["x402.elizacloud.ai", "x402.eliza.app"],
    ["session-7.tunnel.elizacloud.ai", "session-7.tunnel.eliza.app"],
    [
      "session-7.tunnel-staging.elizacloud.ai",
      "session-7.tunnel-staging.eliza.app",
    ],
    ["app-7.apps.elizacloud.ai", "app-7.apps.eliza.app"],
    ["site-7.sites-staging.elizacloud.ai", "site-7.sites-staging.eliza.app"],
  ])("maps legacy service host %s", (legacyHostname, canonicalHostname) => {
    expect(canonicalElizaServiceHostname(legacyHostname)).toBe(
      canonicalHostname,
    );
  });

  it.each([
    ["/dashboard", "", "/cloud"],
    ["/dashboard/build/new", "?template=starter", "/cloud/my-agents"],
    ["/dashboard/image", "", "/cloud/api-explorer"],
    ["/dashboard/containers", "", "/cloud/agents"],
    ["/dashboard/containers/agents/agent-7", "", "/cloud/agents/agent-7"],
    ["/dashboard/containers/agent-8", "", "/cloud/agents/agent-8"],
    ["/dashboard/agents/agent-9/chat", "", "/cloud/agents/agent-9"],
    ["/dashboard/apps/create", "", "/cloud/apps"],
    ["/dashboard/affiliates", "", "/cloud/monetization"],
    ["/dashboard/documents", "", "/cloud/agents"],
    ["/dashboard/settings", "?tab=billing", "/cloud/billing"],
    ["/dashboard/settings", "?tab=unknown", "/cloud"],
    ["/dashboard/api-keys", "", "/cloud/api-keys"],
  ])(
    "maps retired dashboard path %s with search %s",
    (pathname, search, canonicalPathname) => {
      expect(canonicalCloudPathForLegacyDashboard(pathname, search)).toBe(
        canonicalPathname,
      );
    },
  );

  it("does not rewrite non-dashboard paths", () => {
    expect(canonicalCloudPathForLegacyDashboard("/cloud/agents")).toBeNull();
    expect(canonicalCloudPathForLegacyDashboard("/dashboard-old")).toBeNull();
  });
});

/**
 * Unit coverage for cloud agent-base resolution/classification. Capacitor mocked,
 * no live cloud.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
  CapacitorHttp: { get: vi.fn(), post: vi.fn(), request: vi.fn() },
}));

import {
  buildCloudSharedAgentApiBase,
  buildDedicatedCloudAgentApiBase,
  dedicatedCloudAgentIdFromBase,
  directCloudSharedAgentIdFromBase,
  isCloudAgentsCollectionBase,
  isElizaCloudControlPlaneAgentlessBase,
  isManagedCloudSharedAgentBase,
  isTrustedHostedCloudOnboardingBase,
  resolveCloudEnvironmentBase,
} from "../utils/cloud-agent-base";
import { resolveCloudAgentApiBase } from "./client-cloud";

/**
 * After cloud provisioning, the client must pick the agent's API base.
 *
 * Verified against live Eliza Cloud (2026-05-31): a running agent is exposed
 * only as a raw `bridgeUrl` (http://<ip>:<port>); the per-agent subdomain
 * `<agentId>.elizacloud.ai` that the cloud code intends is NOT deployed (Vercel
 * 404). So the resolver must NEVER fabricate that subdomain — pinning a 404
 * wedges first-run on BACKEND_NOT_FOUND (worse than the recoverable
 * connection-error path). It prefers a server-provided `webUiUrl` if/when the
 * cloud ever returns one, and otherwise uses the raw bridgeUrl.
 */
describe("resolveCloudAgentApiBase", () => {
  it("uses a server-provided webUiUrl when present (trailing slash trimmed)", () => {
    expect(
      resolveCloudAgentApiBase({
        bridgeUrl: "http://195.201.57.227:19411",
        webUiUrl: "https://agent.example.test/",
      }),
    ).toBe("https://agent.example.test");
  });

  it("prefers webUiUrl over bridgeUrl", () => {
    expect(
      resolveCloudAgentApiBase({
        bridgeUrl: "http://10.0.0.1:3000",
        webUiUrl: "https://reachable.example.test",
      }),
    ).toBe("https://reachable.example.test");
  });

  it("falls back to bridgeUrl when no webUiUrl is provided", () => {
    expect(
      resolveCloudAgentApiBase({ bridgeUrl: "http://195.201.57.227:19411" }),
    ).toBe("http://195.201.57.227:19411");
  });

  it("uses the shared-agent REST adapter when the bridge URL is the direct Cloud JSON-RPC bridge", () => {
    expect(
      resolveCloudAgentApiBase({
        bridgeUrl:
          "https://api.elizacloud.ai/api/v1/eliza/agents/shared-agent/bridge",
      }),
    ).toBe("https://api.elizacloud.ai/api/v1/eliza/agents/shared-agent");
  });

  it("normalizes a server-provided shared-agent webUiUrl without changing its REST base", () => {
    expect(
      resolveCloudAgentApiBase({
        bridgeUrl:
          "https://api.elizacloud.ai/api/v1/eliza/agents/shared-agent/bridge",
        webUiUrl: "https://api.elizacloud.ai/api/v1/eliza/agents/shared-agent/",
      }),
    ).toBe("https://api.elizacloud.ai/api/v1/eliza/agents/shared-agent");
  });

  it("does NOT fabricate a per-agent subdomain (the gateway isn't deployed)", () => {
    const out = resolveCloudAgentApiBase({
      bridgeUrl: "http://195.201.57.227:19411",
    });
    expect(out).not.toContain("elizacloud.ai");
    expect(out).toBe("http://195.201.57.227:19411");
  });

  it("returns empty when neither is available", () => {
    expect(resolveCloudAgentApiBase({ bridgeUrl: null })).toBe("");
  });

  // Regression: the cloud occasionally returns a webUiUrl/bridgeUrl that is the
  // agent-id-LESS collection (`.../api/v1/eliza/agents`). Pinning that made every
  // /api/* call resolve to `.../agents/api/...` and 404 ("Backend Unreachable").
  it("derives the per-agent base from agentId when the server URL is the id-less collection", () => {
    expect(
      resolveCloudAgentApiBase({
        bridgeUrl: null,
        webUiUrl: "https://api.elizacloud.ai/api/v1/eliza/agents",
        agentId: "agent-123",
        cloudApiBase: "https://www.elizacloud.ai",
      }),
    ).toBe("https://api.eliza.app/api/v1/eliza/agents/agent-123");
  });

  it("derives from agentId when both server URLs are missing", () => {
    expect(
      resolveCloudAgentApiBase({
        bridgeUrl: null,
        webUiUrl: null,
        agentId: "agent-xyz",
        cloudApiBase: "https://api.elizacloud.ai",
      }),
    ).toBe("https://api.eliza.app/api/v1/eliza/agents/agent-xyz");
  });

  it("does NOT clobber a raw dedicated bridge even when agentId is supplied", () => {
    // A dedicated agent's raw http://ip:port bridge is a valid base on a
    // non-cloud host — it must be left untouched, not rewritten to a shared base.
    expect(
      resolveCloudAgentApiBase({
        bridgeUrl: "http://195.201.57.227:19411",
        agentId: "agent-123",
        cloudApiBase: "https://api.elizacloud.ai",
      }),
    ).toBe("http://195.201.57.227:19411");
  });

  it("keeps a valid per-agent server base instead of re-deriving", () => {
    expect(
      resolveCloudAgentApiBase({
        bridgeUrl: null,
        webUiUrl: "https://api.elizacloud.ai/api/v1/eliza/agents/real-id",
        agentId: "other-id",
        cloudApiBase: "https://api.elizacloud.ai",
      }),
    ).toBe("https://api.elizacloud.ai/api/v1/eliza/agents/real-id");
  });
});

describe("cloud-agent-base helpers", () => {
  it("restricts account-scoped shared-agent classification to managed Cloud hosts", () => {
    expect(
      isManagedCloudSharedAgentBase(
        "https://api.eliza.app/api/v1/eliza/agents/agent-123",
      ),
    ).toBe(true);
    expect(
      isManagedCloudSharedAgentBase(
        "https://vps.example/api/v1/eliza/agents/agent-123",
      ),
    ).toBe(false);
  });

  it("buildCloudSharedAgentApiBase appends the per-agent REST path", () => {
    expect(
      buildCloudSharedAgentApiBase("https://api.elizacloud.ai/", "abc"),
    ).toBe("https://api.elizacloud.ai/api/v1/eliza/agents/abc");
  });

  it("buildDedicatedCloudAgentApiBase preserves production as the default", () => {
    expect(buildDedicatedCloudAgentApiBase("agent-123")).toBe(
      "https://agent-123.cloud.eliza.app",
    );
    expect(
      buildDedicatedCloudAgentApiBase(
        "agent-123",
        "https://api.elizacloud.ai/api/v1",
      ),
    ).toBe("https://agent-123.cloud.eliza.app");
  });

  it("buildDedicatedCloudAgentApiBase keeps staging agents on staging ingress", () => {
    for (const cloudBase of [
      "https://staging.elizacloud.ai",
      "https://api-staging.elizacloud.ai/api/v1",
      "https://app-staging.elizacloud.ai",
      "https://existing.staging.elizacloud.ai",
      "https://cloud-staging.eliza.app",
      "https://api-staging.eliza.app/api/v1",
      "https://existing.cloud-staging.eliza.app",
    ]) {
      expect(buildDedicatedCloudAgentApiBase("agent-123", cloudBase)).toBe(
        "https://agent-123.cloud-staging.eliza.app",
      );
    }
  });

  it("resolveCloudEnvironmentBase prefers page/staging-persisted over prod boot default", () => {
    expect(
      resolveCloudEnvironmentBase({
        pageHostname: "agent-123.staging.elizacloud.ai",
        apiBase: "https://agent-123.staging.elizacloud.ai",
        bootCloudApiBase: "https://elizacloud.ai",
      }),
    ).toBe("https://cloud-staging.eliza.app");

    expect(
      resolveCloudEnvironmentBase({
        pageHostname: "localhost",
        apiBase: "https://agent-123.staging.elizacloud.ai",
        bootCloudApiBase: "https://elizacloud.ai",
      }),
    ).toBe("https://cloud-staging.eliza.app");

    expect(
      resolveCloudEnvironmentBase({
        pageHostname: "localhost",
        apiBase: "https://agent-123.elizacloud.ai",
        bootCloudApiBase: "https://staging.elizacloud.ai",
      }),
    ).toBe("https://cloud-staging.eliza.app");
  });

  it("dedicatedCloudAgentIdFromBase extracts production and staging ids", () => {
    expect(
      dedicatedCloudAgentIdFromBase("https://agent-123.elizacloud.ai"),
    ).toBe("agent-123");
    expect(
      dedicatedCloudAgentIdFromBase("https://agent-123.staging.elizacloud.ai"),
    ).toBe("agent-123");
    expect(
      dedicatedCloudAgentIdFromBase("https://agent-123.cloud.eliza.app"),
    ).toBe("agent-123");
    expect(
      dedicatedCloudAgentIdFromBase(
        "https://agent-123.cloud-staging.eliza.app",
      ),
    ).toBe("agent-123");
  });

  it("directCloudSharedAgentIdFromBase extracts REST and legacy bridge agent ids", () => {
    expect(
      directCloudSharedAgentIdFromBase(
        "https://api.elizacloud.ai/api/v1/eliza/agents/agent-123",
      ),
    ).toBe("agent-123");
    expect(
      directCloudSharedAgentIdFromBase(
        "https://api-staging.elizacloud.ai/api/v1/eliza/agents/agent%20id/bridge",
      ),
    ).toBe("agent id");
    expect(
      directCloudSharedAgentIdFromBase("https://agent-123.elizacloud.ai"),
    ).toBeNull();
  });

  it("isCloudAgentsCollectionBase flags blank/bare/collection bases", () => {
    expect(isCloudAgentsCollectionBase("")).toBe(true);
    expect(isCloudAgentsCollectionBase(null)).toBe(true);
    expect(isCloudAgentsCollectionBase("https://api.elizacloud.ai")).toBe(true);
    expect(
      isCloudAgentsCollectionBase(
        "https://api.elizacloud.ai/api/v1/eliza/agents",
      ),
    ).toBe(true);
    expect(
      isCloudAgentsCollectionBase(
        "https://api.elizacloud.ai/api/v1/eliza/agents/abc",
      ),
    ).toBe(false);
    expect(isCloudAgentsCollectionBase("http://10.0.0.1:3000")).toBe(true);
  });

  it("isElizaCloudControlPlaneAgentlessBase is host-checked (only cloud hosts)", () => {
    expect(
      isElizaCloudControlPlaneAgentlessBase("https://app.elizacloud.ai"),
    ).toBe(true);
    expect(
      isElizaCloudControlPlaneAgentlessBase(
        "https://app-staging.elizacloud.ai",
      ),
    ).toBe(true);
    expect(
      isElizaCloudControlPlaneAgentlessBase("https://api.elizacloud.ai"),
    ).toBe(true);
    expect(
      isElizaCloudControlPlaneAgentlessBase(
        "https://api.elizacloud.ai/api/v1/eliza/agents",
      ),
    ).toBe(true);
    expect(
      isElizaCloudControlPlaneAgentlessBase(
        "https://api.elizacloud.ai/api/v1/eliza/agents/abc",
      ),
    ).toBe(false);
    // A raw dedicated bridge (non-cloud host) is NOT agentless.
    expect(
      isElizaCloudControlPlaneAgentlessBase("http://195.201.57.227:19411"),
    ).toBe(false);
    expect(
      isElizaCloudControlPlaneAgentlessBase(
        "https://ff479713-41c8-4d82-92b8-5f0881062189.elizacloud.ai",
      ),
    ).toBe(false);
  });

  it("trusts canonical Cloud and the exact branded HTTPS staging Pages alias", () => {
    expect(
      isTrustedHostedCloudOnboardingBase("https://cloud.eliza.app", false),
    ).toBe(true);
    expect(
      isTrustedHostedCloudOnboardingBase("https://app.elizacloud.ai", false),
    ).toBe(true);
    expect(
      isTrustedHostedCloudOnboardingBase(
        "https://develop.eliza-app.pages.dev",
        true,
      ),
    ).toBe(true);
  });

  it("rejects unbranded, insecure, self-hosted, and lookalike Pages bases", () => {
    for (const [base, cloudOnlyBranding] of [
      ["https://develop.eliza-app.pages.dev", false],
      ["http://develop.eliza-app.pages.dev", true],
      ["https://develop.eliza-app.pages.dev:8443", true],
      ["https://eliza-app.pages.dev", true],
      ["https://preview.eliza-app.pages.dev", true],
      ["https://pr-30375.preview.eliza-app.pages.dev", true],
      ["https://agent.example.com", true],
      ["https://other-project.pages.dev", true],
      ["https://evil-eliza-app.pages.dev", true],
      ["https://eliza-app.pages.dev.evil.example", true],
      ["https://develop.eliza-app.pages.dev/api/v1/eliza/agents/agent", true],
    ] as const) {
      expect(isTrustedHostedCloudOnboardingBase(base, cloudOnlyBranding)).toBe(
        false,
      );
    }
  });
});

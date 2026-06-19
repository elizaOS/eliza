import { describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
  CapacitorHttp: { get: vi.fn(), post: vi.fn(), request: vi.fn() },
}));

import {
  buildCloudSharedAgentApiBase,
  isCloudAgentsCollectionBase,
  isElizaCloudControlPlaneAgentlessBase,
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
    ).toBe("https://api.elizacloud.ai/api/v1/eliza/agents/agent-123");
  });

  it("derives from agentId when both server URLs are missing", () => {
    expect(
      resolveCloudAgentApiBase({
        bridgeUrl: null,
        webUiUrl: null,
        agentId: "agent-xyz",
        cloudApiBase: "https://api.elizacloud.ai",
      }),
    ).toBe("https://api.elizacloud.ai/api/v1/eliza/agents/agent-xyz");
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
  it("buildCloudSharedAgentApiBase appends the per-agent REST path", () => {
    expect(
      buildCloudSharedAgentApiBase("https://api.elizacloud.ai/", "abc"),
    ).toBe("https://api.elizacloud.ai/api/v1/eliza/agents/abc");
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
  });
});

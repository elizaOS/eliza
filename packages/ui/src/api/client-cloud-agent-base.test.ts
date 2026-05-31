import { describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
  CapacitorHttp: { get: vi.fn(), post: vi.fn(), request: vi.fn() },
}));

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
});

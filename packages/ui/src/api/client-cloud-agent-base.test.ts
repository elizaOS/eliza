import { describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
  CapacitorHttp: { get: vi.fn(), post: vi.fn(), request: vi.fn() },
}));

import { resolveCloudAgentApiBase } from "./client-cloud";

/**
 * Regression: the cloud provision endpoint returns `bridgeUrl` as a raw
 * container address (http://<ip>:<port>) that is firewalled from the browser
 * and blocked by the dashboard CSP. Onboarding used to pin that and wedge.
 * resolveCloudAgentApiBase must instead yield the reachable per-agent HTTPS
 * gateway URL (https://<agentId>.<apex>), matching the live `*.elizacloud.ai`
 * gateway and the server's getElizaAgentPublicWebUiUrl().
 */
describe("resolveCloudAgentApiBase", () => {
  it("derives the per-agent https gateway URL from a www. cloud base", () => {
    expect(
      resolveCloudAgentApiBase({
        agentId: "agent-abc",
        cloudApiBase: "https://www.elizacloud.ai",
        bridgeUrl: "http://195.201.57.227:19575",
      }),
    ).toBe("https://agent-abc.elizacloud.ai");
  });

  it("derives from an api. cloud base too", () => {
    expect(
      resolveCloudAgentApiBase({
        agentId: "agent-abc",
        cloudApiBase: "https://api.elizacloud.ai",
        bridgeUrl: "http://10.0.0.1:3000",
      }),
    ).toBe("https://agent-abc.elizacloud.ai");
  });

  it("handles an apex cloud base (no subdomain to strip)", () => {
    expect(
      resolveCloudAgentApiBase({
        agentId: "x",
        cloudApiBase: "https://elizacloud.ai",
        bridgeUrl: null,
      }),
    ).toBe("https://x.elizacloud.ai");
  });

  it("prefers a server-provided web UI URL over derivation (trailing slash trimmed)", () => {
    expect(
      resolveCloudAgentApiBase({
        agentId: "agent-abc",
        cloudApiBase: "https://www.elizacloud.ai",
        bridgeUrl: "http://10.0.0.1:3000",
        webUiUrl: "https://agent-abc.elizacloud.ai/",
      }),
    ).toBe("https://agent-abc.elizacloud.ai");
  });

  it("never pins the unreachable raw http bridgeUrl for a public cloud", () => {
    const out = resolveCloudAgentApiBase({
      agentId: "agent-abc",
      cloudApiBase: "https://www.elizacloud.ai",
      bridgeUrl: "http://195.201.57.227:19575",
    });
    expect(out.startsWith("https://")).toBe(true);
    expect(out).not.toContain("195.201.57.227");
  });

  it("falls back to bridgeUrl for a local-dev cloud (no public gateway)", () => {
    expect(
      resolveCloudAgentApiBase({
        agentId: "agent-abc",
        cloudApiBase: "http://localhost:3000",
        bridgeUrl: "http://127.0.0.1:31337",
      }),
    ).toBe("http://127.0.0.1:31337");
  });
});

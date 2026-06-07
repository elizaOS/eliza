import { describe, expect, it } from "bun:test";
import {
  extractAgentIdFromHost,
  isBridgeHostFallbackEnabled,
  resolveSandboxRouting,
  selectAgentProxyTarget,
} from "./agent-router";

describe("resolveSandboxRouting", () => {
  it("prefers headscale IP for the target when bridge metadata is available", () => {
    expect(
      resolveSandboxRouting({
        status: "running",
        bridge_url: "http://172.18.0.10:18791",
        headscale_ip: "100.64.0.21",
        web_ui_port: 20001,
      }),
    ).toEqual({
      headscaleIp: "100.64.0.21",
      bridgePort: 18791,
      webUiPort: 20001,
      bridgeTarget: "100.64.0.21:18791",
      webTarget: "100.64.0.21:20001",
      target: "100.64.0.21:20001",
    });
  });

  it("prefers persisted bridge port over bridge URL metadata", () => {
    expect(
      resolveSandboxRouting({
        status: "running",
        bridge_url: "http://172.18.0.10:18791",
        bridge_port: 18888,
        headscale_ip: "100.64.0.21",
        web_ui_port: 20001,
      }),
    ).toMatchObject({
      bridgePort: 18888,
      bridgeTarget: "100.64.0.21:18888",
      webTarget: "100.64.0.21:20001",
    });
  });

  it("does not route running sandboxes without a persisted headscale IP by default", () => {
    expect(
      resolveSandboxRouting({
        status: "running",
        bridge_url: "http://172.18.0.10:18791",
        headscale_ip: null,
        web_ui_port: 20001,
      }),
    ).toBeNull();
  });

  it("can opt into bridge URL host fallback for legacy sandboxes", () => {
    expect(
      resolveSandboxRouting(
        {
          status: "running",
          bridge_url: "http://172.18.0.10:18791",
          headscale_ip: null,
          web_ui_port: 20001,
        },
        { allowBridgeHostFallback: true },
      ),
    ).toMatchObject({
      headscaleIp: "172.18.0.10",
      bridgeTarget: "172.18.0.10:18791",
      webTarget: "172.18.0.10:20001",
      target: "172.18.0.10:20001",
    });
  });

  it("routes valid headscale IP even when bridge URL is malformed", () => {
    expect(
      resolveSandboxRouting({
        status: "running",
        bridge_url: "not a url",
        headscale_ip: "100.64.0.21",
        web_ui_port: 20001,
      }),
    ).toEqual({
      headscaleIp: "100.64.0.21",
      bridgePort: 20001,
      webUiPort: 20001,
      bridgeTarget: "100.64.0.21:20001",
      webTarget: "100.64.0.21:20001",
      target: "100.64.0.21:20001",
    });
  });

  it("only enables bridge-host fallback through the explicit env flag", () => {
    expect(isBridgeHostFallbackEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(
      isBridgeHostFallbackEnabled({
        AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK: "false",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(
      isBridgeHostFallbackEnabled({
        AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK: "true",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      isBridgeHostFallbackEnabled({
        AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK: "1",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
  });
});

describe("selectAgentProxyTarget", () => {
  const routing = {
    bridgeTarget: "100.64.0.21:18791",
    webTarget: "100.64.0.21:20001",
  };

  it("routes web UI paths to the web UI port", () => {
    expect(selectAgentProxyTarget(routing, "/")).toBe(routing.webTarget);
    expect(selectAgentProxyTarget(routing, "/health")).toBe(routing.webTarget);
    expect(selectAgentProxyTarget(routing, "/assets/app.js")).toBe(
      routing.webTarget,
    );
  });

  it("routes runtime API paths to the bridge port", () => {
    expect(selectAgentProxyTarget(routing, "/bridge")).toBe(
      routing.bridgeTarget,
    );
    expect(selectAgentProxyTarget(routing, "/api/agents")).toBe(
      routing.bridgeTarget,
    );
    expect(
      selectAgentProxyTarget(routing, "/api/conversations/default/messages"),
    ).toBe(routing.bridgeTarget);
    expect(selectAgentProxyTarget(routing, "/api/messaging/sessions")).toBe(
      routing.bridgeTarget,
    );
    expect(selectAgentProxyTarget(routing, "/v1/chat/completions")).toBe(
      routing.bridgeTarget,
    );
  });
});

describe("extractAgentIdFromHost", () => {
  const agentId = "e06bb509-6c52-4c33-a9f7-66addc43e8c8";

  it("extracts generated agent subdomains for the configured base domain", () => {
    expect(
      extractAgentIdFromHost(`${agentId}.elizacloud.ai`, "elizacloud.ai"),
    ).toBe(agentId);
    expect(
      extractAgentIdFromHost(`${agentId}.elizacloud.ai:443`, "elizacloud.ai"),
    ).toBe(agentId);
  });

  it("rejects root, unrelated, and malformed hosts", () => {
    expect(extractAgentIdFromHost("elizacloud.ai", "elizacloud.ai")).toBeNull();
    expect(extractAgentIdFromHost("example.com", "elizacloud.ai")).toBeNull();
    expect(
      extractAgentIdFromHost("not-an-agent.elizacloud.ai", "elizacloud.ai"),
    ).toBeNull();
  });
});

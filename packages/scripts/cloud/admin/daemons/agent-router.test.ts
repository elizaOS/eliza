// Exercises cloud admin daemons agent router.test automation behavior with deterministic script fixtures.

import { describe, expect, it } from "bun:test";
import type { IncomingMessage } from "node:http";
import {
  buildUnresolvedAgentResponse,
  extractAgentIdFromHost,
  handleRequest,
  isBridgeHostFallbackEnabled,
  resolveSandboxRouting,
  selectAgentProxyTarget,
} from "./agent-router";

describe("resolveSandboxRouting", () => {
  it("routes over the tailnet to the container port encoded in bridge_url", () => {
    // After provisioning, bridge_url encodes the agent's tailnet IP + the
    // container-internal port (the app binds 0.0.0.0:<containerPort>). Over the
    // mesh the container is reached directly there, so bridge and web UI share
    // that one port.
    expect(
      resolveSandboxRouting({
        status: "running",
        bridge_url: "http://100.64.0.21:3000",
        headscale_ip: "100.64.0.21",
        web_ui_port: 20001,
      }),
    ).toEqual({
      headscaleIp: "100.64.0.21",
      bridgePort: 3000,
      webUiPort: 3000,
      bridgeTarget: "100.64.0.21:3000",
      webTarget: "100.64.0.21:3000",
      target: "100.64.0.21:3000",
    });
  });

  it("ignores the host bridge_port over the tailnet (container port from bridge_url wins)", () => {
    // bridge_port / web_ui_port are HOST-published ports (docker -p) that do
    // not exist inside the container's netns; routing them over the tailnet
    // would always connection-refuse. The container port from bridge_url wins.
    expect(
      resolveSandboxRouting({
        status: "running",
        bridge_url: "http://100.64.0.21:3000",
        bridge_port: 18888,
        headscale_ip: "100.64.0.21",
        web_ui_port: 20001,
      }),
    ).toMatchObject({
      bridgePort: 3000,
      bridgeTarget: "100.64.0.21:3000",
      webTarget: "100.64.0.21:3000",
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

  it("refuses to route a headscale sandbox when bridge_url has no usable port", () => {
    // Over the tailnet there is no safe fallback — the host ports are
    // unreachable, so without the container port we must not route at all.
    expect(
      resolveSandboxRouting({
        status: "running",
        bridge_url: "not a url",
        headscale_ip: "100.64.0.21",
        web_ui_port: 20001,
      }),
    ).toBeNull();
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

describe("buildUnresolvedAgentResponse — CORS-bearing failure (#15347)", () => {
  const ORIGIN = "https://app-staging.elizacloud.ai";

  it("running row with no routable ingress → 503 agent_unroutable + reflected CORS + retry-after", async () => {
    // A `running` sandbox whose headscale_ip never persisted is the exact 48/48
    // staging state: reachable status, no mesh IP → resolveSandboxRouting = null.
    const res = buildUnresolvedAgentResponse(
      { status: "running", headscale_ip: null, web_ui_port: 20001 },
      ORIGIN,
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(res.headers.get("vary")).toBe("origin");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    expect(res.headers.get("retry-after")).toBe("5");
    const body = (await res.json()) as { code?: string; error?: string };
    expect(body.code).toBe("agent_unroutable");
  });

  it("no such agent (undefined) → 404 not-found, still CORS-bearing", async () => {
    const res = buildUnresolvedAgentResponse(undefined, ORIGIN);
    expect(res.status).toBe(404);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(res.headers.get("retry-after")).toBeNull();
    const body = (await res.json()) as { error?: string; code?: string };
    expect(body.error).toBe("agent not found or not running");
    expect(body.code).toBeUndefined();
  });

  it("non-running row (pending/stopped) with empty ip → 404, NOT 503 (only running is 'unroutable')", () => {
    for (const status of ["pending", "stopped", "disconnected"]) {
      const res = buildUnresolvedAgentResponse(
        { status, headscale_ip: "", web_ui_port: 20001 },
        ORIGIN,
      );
      expect(res.status).toBe(404);
    }
  });

  it("header-less (non-browser) caller → wildcard origin", () => {
    const res = buildUnresolvedAgentResponse(
      { status: "running", headscale_ip: null, web_ui_port: 20001 },
      undefined,
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("handleRequest — agent-host CORS preflight (#15347)", () => {
  const AGENT = "e06bb509-6c52-4c33-a9f7-66addc43e8c8";
  const HOST = `${AGENT}.elizacloud.ai`;
  const ORIGIN = "https://app-staging.elizacloud.ai";

  function fakeReq(
    method: string,
    host: string,
    origin?: string,
  ): IncomingMessage {
    return {
      method,
      headers: origin ? { host, origin } : { host },
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as IncomingMessage;
  }

  it("OPTIONS to an agent subdomain → 204 + reflected CORS, no proxy/DB hop", async () => {
    // The preflight is answered at the router before any sandbox lookup, so a
    // cross-origin agent call is allowed even while the agent itself is
    // unroutable. A DB hit here would throw (no DATABASE_URL in unit env), so a
    // clean 204 also proves the short-circuit ran before proxyAgentRequest.
    const url = new URL(`http://${HOST}/api/agents`);
    const res = await handleRequest(url, fakeReq("OPTIONS", HOST, ORIGIN));
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("non-agent host with no route match → plain 404 (unchanged)", async () => {
    const res = await handleRequest(
      new URL("http://cp-internal.example/nope"),
      fakeReq("GET", "cp-internal.example"),
    );
    expect(res.status).toBe(404);
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

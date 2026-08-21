/**
 * Exercises agent-router routing, proxy headers, and HTTP response behavior
 * with deterministic request and stream fixtures.
 */

import { describe, expect, it } from "bun:test";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import {
  buildProxyHeaders,
  buildUnresolvedAgentResponse,
  corsHeaders,
  extractAgentIdFromHost,
  handleRequest,
  isBridgeHostFallbackEnabled,
  isCredentialedAgentRouterOrigin,
  resolveSandboxRouting,
  selectAgentProxyTarget,
  sendResponse,
  startAgentRouter,
} from "./agent-router";

function makeRequest(
  headers: IncomingMessage["headers"],
  remoteAddress = "127.0.0.1",
): IncomingMessage {
  return {
    headers,
    socket: { remoteAddress },
  } as unknown as IncomingMessage;
}

function makeResponseStub() {
  const output = new PassThrough() as PassThrough & {
    flushHeaders: () => void;
    headersSent: boolean;
    setHeader: (name: string, value: string) => void;
    statusCode: number;
  };
  let headersFlushed = false;
  const headers = new Map<string, string>();
  output.flushHeaders = () => {
    headersFlushed = true;
  };
  Object.defineProperty(output, "headersSent", {
    get: () => headersFlushed,
  });
  output.setHeader = (name, value) => {
    headers.set(name, value);
  };
  output.statusCode = 0;
  return { output, headers, headersFlushed: () => headersFlushed };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("agent-router startup readiness", () => {
  it("binds liveness while a routing dependency warmup is stalled", async () => {
    const reported: Error[] = [];
    const started = await startAgentRouter({
      config: { port: 0, bindHost: "127.0.0.1" },
      warmRoutingDependencies: () => new Promise(() => undefined),
      warmupTimeoutMs: 100,
      onWarmupError: (error) => reported.push(error),
    });
    const { port } = started.server.address() as AddressInfo;

    try {
      const health = await fetch(`http://127.0.0.1:${port}/healthz`);
      const readiness = await fetch(`http://127.0.0.1:${port}/readyz`);
      const route = await fetch(
        `http://127.0.0.1:${port}/agents/e06bb509-6c52-4c33-a9f7-66addc43e8c8/routing`,
      );

      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true });
      expect(readiness.status).toBe(503);
      expect(await readiness.json()).toEqual({
        ok: false,
        code: "router_warming",
      });
      expect(route.status).toBe(503);
      expect(await route.json()).toEqual({
        error: "agent router is not ready",
        code: "router_warming",
      });

      await started.warmupSettled;
      const failedReadiness = await fetch(`http://127.0.0.1:${port}/readyz`);
      expect(failedReadiness.status).toBe(503);
      expect(await failedReadiness.json()).toEqual({
        ok: false,
        code: "router_dependencies_unavailable",
      });
      expect(reported[0]?.message).toBe(
        "routing dependency warmup timed out after 100ms",
      );
    } finally {
      await closeServer(started.server);
    }
  });

  it("transitions to ready only after dependency warmup succeeds", async () => {
    let resolveWarmup: (() => void) | undefined;
    const started = await startAgentRouter({
      config: { port: 0, bindHost: "127.0.0.1" },
      warmRoutingDependencies: () =>
        new Promise<void>((resolve) => {
          resolveWarmup = resolve;
        }),
    });
    const { port } = started.server.address() as AddressInfo;

    try {
      expect((await fetch(`http://127.0.0.1:${port}/readyz`)).status).toBe(503);
      resolveWarmup?.();
      await started.warmupSettled;
      const readiness = await fetch(`http://127.0.0.1:${port}/readyz`);
      expect(readiness.status).toBe(200);
      expect(await readiness.json()).toEqual({ ok: true });
    } finally {
      await closeServer(started.server);
    }
  });

  it("reports rejected warmup without an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const reported: Error[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    const started = await startAgentRouter({
      config: { port: 0, bindHost: "127.0.0.1" },
      warmRoutingDependencies: async () => {
        throw new Error("database unavailable");
      },
      onWarmupError: (error) => reported.push(error),
    });
    const { port } = started.server.address() as AddressInfo;

    try {
      await started.warmupSettled;
      await new Promise((resolve) => setTimeout(resolve, 0));
      const readiness = await fetch(`http://127.0.0.1:${port}/readyz`);

      expect(started.readiness.status).toBe("failed");
      expect(readiness.status).toBe(503);
      expect(await readiness.json()).toEqual({
        ok: false,
        code: "router_dependencies_unavailable",
      });
      expect(reported.map((error) => error.message)).toEqual([
        "database unavailable",
      ]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await closeServer(started.server);
    }
  });
});

describe("sendResponse", () => {
  it("relays streaming response chunks before the upstream body closes", async () => {
    const encoder = new TextEncoder();
    let releaseSecondChunk: (() => void) | undefined;
    const upstream = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("first\n\n"));
          releaseSecondChunk = () => {
            controller.enqueue(encoder.encode("second\n\n"));
            controller.close();
          };
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
    const { output, headers, headersFlushed } = makeResponseStub();

    const firstChunk = new Promise<string>((resolve) => {
      output.once("data", (chunk: Buffer) => resolve(chunk.toString()));
    });
    const relay = sendResponse(output as unknown as ServerResponse, upstream);

    expect(await firstChunk).toBe("first\n\n");
    expect(headersFlushed()).toBe(true);
    expect(headers.get("content-type")).toBe("text/event-stream");
    expect(output.statusCode).toBe(200);

    releaseSecondChunk?.();
    await relay;
  });

  it("ends a bodyless response without forcing streaming headers", async () => {
    const { output, headersFlushed } = makeResponseStub();

    await sendResponse(
      output as unknown as ServerResponse,
      new Response(null, { status: 204 }),
    );

    expect(output.statusCode).toBe(204);
    expect(headersFlushed()).toBe(false);
    expect(output.writableEnded).toBe(true);
  });
});

describe("buildProxyHeaders", () => {
  const AGENT = "e06bb509-6c52-4c33-a9f7-66addc43e8c8";
  const PUBLIC_HOST = `${AGENT}.elizacloud.ai`;
  const CONTROL_PLANE_HOST = "eliza-production-1.elizacloud.ai";
  const TARGET = "100.64.0.21:3000";

  it("preserves the Worker-pinned public host while retargeting Host to the agent", () => {
    const headers = buildProxyHeaders(
      makeRequest({
        host: CONTROL_PLANE_HOST,
        "x-forwarded-host": PUBLIC_HOST,
        "x-forwarded-proto": "https",
      }),
      TARGET,
    );

    expect(headers.get("host")).toBe(TARGET);
    expect(headers.get("x-forwarded-host")).toBe(PUBLIC_HOST);
    expect(headers.get("x-forwarded-proto")).toBe("https");
  });

  it("falls back to the direct public Host when no proxy supplied a forwarded host", () => {
    const headers = buildProxyHeaders(
      makeRequest({ host: PUBLIC_HOST }),
      TARGET,
    );

    expect(headers.get("host")).toBe(TARGET);
    expect(headers.get("x-forwarded-host")).toBe(PUBLIC_HOST);
    expect(headers.get("x-forwarded-proto")).toBe("http");
  });

  it("does not invent a forwarded host when neither trusted host signal exists", () => {
    const headers = buildProxyHeaders(makeRequest({}), TARGET);

    expect(headers.get("host")).toBe(TARGET);
    expect(headers.has("x-forwarded-host")).toBe(false);
  });
});

describe("handleRequest routing lookup", () => {
  it("rejects malformed agent ids before consulting routing state", async () => {
    const response = await handleRequest(
      new URL("http://localhost/agents/not-an-agent!/routing"),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid agent id" });
  });
});

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

  it("no such agent (undefined) → 404 agent_not_found, still CORS-bearing", async () => {
    const res = buildUnresolvedAgentResponse(undefined, ORIGIN);
    expect(res.status).toBe(404);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(res.headers.get("retry-after")).toBeNull();
    const body = (await res.json()) as { error?: string; code?: string };
    expect(body.error).toBe("agent not found or not running");
    expect(body.code).toBe("agent_not_found");
  });

  it("non-running row (pending/stopped) → 503 agent_not_running (recoverable, not deleted)", async () => {
    for (const status of ["pending", "stopped", "disconnected"]) {
      const res = buildUnresolvedAgentResponse(
        { status, headscale_ip: "", web_ui_port: 20001 },
        ORIGIN,
      );
      expect(res.status).toBe(503);
      const body = (await res.json()) as {
        error?: string;
        code?: string;
        status?: string;
      };
      expect(body.code).toBe("agent_not_running");
      expect(body.status).toBe(status);
      expect(res.headers.get("retry-after")).toBe("5");
    }
  });

  it("header-less (non-browser) caller → wildcard origin", () => {
    const res = buildUnresolvedAgentResponse(
      { status: "running", headscale_ip: null, web_ui_port: 20001 },
      undefined,
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("does not reflect an untrusted Origin with credentials", () => {
    const res = buildUnresolvedAgentResponse(
      { status: "running", headscale_ip: null, web_ui_port: 20001 },
      "https://evil.example",
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect(res.headers.get("vary")).toBe("origin");
  });
});

describe("corsHeaders — credentialed origin allowlist", () => {
  it("reflects first-party origins with credentials and rejects evil.example", () => {
    expect(isCredentialedAgentRouterOrigin("https://cloud.eliza.app")).toBe(
      true,
    );
    expect(isCredentialedAgentRouterOrigin("https://evil.example")).toBe(false);
    const trusted = corsHeaders("https://cloud.eliza.app");
    expect(trusted["access-control-allow-origin"]).toBe(
      "https://cloud.eliza.app",
    );
    expect(trusted["access-control-allow-credentials"]).toBe("true");
    const evil = corsHeaders("https://evil.example");
    expect(evil["access-control-allow-origin"]).toBeUndefined();
    expect(evil["access-control-allow-credentials"]).toBeUndefined();
    const none = corsHeaders(undefined);
    expect(none["access-control-allow-origin"]).toBe("*");
    expect(none["access-control-allow-credentials"]).toBeUndefined();
  });

  it("uses the complete shared Cloud first-party origin policy", () => {
    for (const origin of [
      "https://www.eliza.app",
      "https://elizaos.ai",
      "https://os.eliza.app",
    ]) {
      expect(isCredentialedAgentRouterOrigin(origin)).toBe(true);
      expect(corsHeaders(origin)["access-control-allow-origin"]).toBe(origin);
    }
  });
});

describe("handleRequest — agent-host CORS preflight (#15347)", () => {
  const AGENT = "e06bb509-6c52-4c33-a9f7-66addc43e8c8";
  const HOST = `${AGENT}.cloud.eliza.app`;
  const ORIGIN = "https://cloud.eliza.app";

  function fakeReq(
    method: string,
    host: string,
    origin?: string,
    forwardedHost?: string,
  ): IncomingMessage {
    return {
      method,
      headers: {
        host,
        ...(origin ? { origin } : {}),
        ...(forwardedHost ? { "x-forwarded-host": forwardedHost } : {}),
      },
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

  it("recognizes the public agent host forwarded through the control-plane origin", async () => {
    const res = await handleRequest(
      new URL("http://eliza-production-1.eliza.app/api/agents"),
      fakeReq("OPTIONS", "eliza-production-1.eliza.app", ORIGIN, HOST),
    );

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });

  it("non-agent host with no route match → plain 404 (unchanged)", async () => {
    const res = await handleRequest(
      new URL("http://cp-internal.example/nope"),
      fakeReq("GET", "cp-internal.example"),
    );
    expect(res.status).toBe(404);
  });

  it("OPTIONS from an untrusted Origin does not reflect credentials", async () => {
    const res = await handleRequest(
      new URL(`http://${HOST}/api/agents`),
      fakeReq("OPTIONS", HOST, "https://evil.example"),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("rejects an untrusted forwarded host instead of falling back to an agent Host", async () => {
    const res = await handleRequest(
      new URL(`http://${HOST}/api/agents`),
      fakeReq("OPTIONS", HOST, ORIGIN, "attacker.example"),
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
    expect(
      extractAgentIdFromHost(
        `${agentId}.staging.elizacloud.ai`,
        "staging.elizacloud.ai",
      ),
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

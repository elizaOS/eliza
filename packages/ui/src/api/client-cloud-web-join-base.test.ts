/**
 * Verifies hosted-web Cloud account requests choose the control plane without
 * crossing agent and Steward credential boundaries. Capacitor is forced to web
 * and fetch is stubbed; no live Cloud service is contacted.
 */
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => false,
  },
  CapacitorHttp: {
    get: vi.fn(),
    post: vi.fn(),
    request: vi.fn(),
  },
}));

import { ElizaClient } from "./client-base";
import "./client-cloud";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function setHostname(hostname: string, protocol = "https:"): void {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      hostname,
      host: hostname,
      protocol,
      origin: `${protocol}//${hostname}`,
      href: `${protocol}//${hostname}/join`,
    },
  });
}

beforeEach(() => {
  localStorage.setItem("steward_session_token", "steward-jwt");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getCloudCompatAgents on hosted web with no agent baseUrl (join flow)", () => {
  it("resolves the control plane from the staging page host and lists agents via the direct v1 route", async () => {
    setHostname("staging.elizacloud.ai");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ success: true, data: [] }));

    const client = new ElizaClient("");
    const result = await client.getCloudCompatAgents();

    // The direct URL is same-site, so it is rewritten to the relative path
    // and rides the co-hosted /api/* proxy with the Bearer attached.
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/eliza/agents");
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer steward-jwt",
    );
    expect(result).toEqual({ success: true, data: [] });

    // The agent-proxy fallback must never fire on a cloud host.
    for (const call of fetchSpy.mock.calls) {
      expect(String(call[0])).not.toContain("/api/cloud/compat/agents");
    }
  });

  it("resolves the prod page host to the prod control plane", async () => {
    setHostname("elizacloud.ai");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ success: true, data: [] }));

    const client = new ElizaClient("");
    await client.getCloudCompatAgents();

    expect(String(fetchSpy.mock.calls[0][0])).toBe("/api/v1/eliza/agents");
  });

  it("resolves app Pages hosts to their matching control plane", async () => {
    for (const hostname of ["app.elizacloud.ai", "app-staging.elizacloud.ai"]) {
      setHostname(hostname);
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(jsonResponse({ success: true, data: [] }));

      const client = new ElizaClient("");
      await client.getCloudCompatAgents();

      expect(String(fetchSpy.mock.calls[0][0])).toBe("/api/v1/eliza/agents");
      vi.restoreAllMocks();
    }
  });

  it("keeps the agent-proxy fallback on non-cloud hosts", async () => {
    setHostname("localhost", "http:");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ success: true, data: [] }));

    const client = new ElizaClient("");
    await client.getCloudCompatAgents();

    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/api/cloud/compat/agents"))).toBe(true);
    expect(urls.some((u) => u.includes("/api/v1/eliza/agents"))).toBe(false);
  });
});

// The regression NubsCarson flagged on PR #11448: the page-host branch is meant
// ONLY for the empty-baseUrl /join state. When the client is connected to a
// NON-cloud agent server (baseUrl = an agent URL that isn't a direct-cloud
// base), the direct-cloud call must route to that connected agent, NOT the
// cloud page host. Firing the page-host branch while connected sent the request
// with the agent's Bearer to the cloud control plane → mis-route / 401.
describe("getCloudCompatAgents connected to a non-cloud agent while served from a cloud host", () => {
  it("routes to the connected agent, NOT the cloud page host", async () => {
    // SPA is being served from a real cloud Pages host...
    setHostname("app.elizacloud.ai");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ success: true, data: [] }));

    // ...but the client is connected to an external, non-cloud agent server.
    const client = new ElizaClient("https://my-agent.example.com");
    await client.getCloudCompatAgents();

    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));

    // The request must hit the connected agent's absolute origin via the
    // agent-proxy compat route.
    expect(urls).toContain(
      "https://my-agent.example.com/api/cloud/compat/agents",
    );

    // It must NOT resolve to the page host: no direct-cloud v1 route, and no
    // same-site rewrite to a relative /api/v1 path against the cloud origin.
    for (const url of urls) {
      expect(url).not.toContain("/api/v1/eliza/agents");
      expect(url).not.toContain("api.elizacloud.ai");
    }
  });
});

describe("Cloud account management while connected to a dedicated Cloud agent", () => {
  const dedicatedStagingBase =
    "https://11111111-1111-4111-8111-111111111111.staging.elizacloud.ai";

  it("uses the page-matched control plane and the stored Steward token for list and force-create", async () => {
    setHostname("app-staging.elizacloud.ai");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ success: true, data: [] }))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            success: true,
            created: true,
            data: {
              id: "22222222-2222-4222-8222-222222222222",
              agentName: "Disposable",
              status: "pending",
            },
          },
          202,
        ),
      );

    const client = new ElizaClient(dedicatedStagingBase, "agent-bearer");
    await client.getCloudCompatAgents();
    await client.createCloudCompatAgent({
      agentName: "Disposable",
      forceCreate: true,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchSpy.mock.calls) {
      expect(String(url)).toBe("/api/v1/eliza/agents");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer steward-jwt",
      );
      expect(String(url)).not.toContain("/api/cloud/compat/agents");
    }
    const createInit = fetchSpy.mock.calls[1][1] as RequestInit;
    expect(createInit.method).toBe("POST");
    expect(JSON.parse(String(createInit.body))).toEqual({
      agentName: "Disposable",
      alwaysOn: true,
      forceCreate: true,
    });
  });

  it("never relabels or sends the dedicated agent bearer when the Steward session is missing", async () => {
    setHostname("app-staging.elizacloud.ai");
    localStorage.removeItem("steward_session_token");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = new ElizaClient(dedicatedStagingBase, "agent-bearer");

    await expect(
      client.selectOrProvisionCloudAgent({
        cloudApiBase: "https://staging.elizacloud.ai",
        authToken: "agent-bearer",
        name: "Disposable",
        forceCreate: true,
      }),
    ).rejects.toThrow("Eliza Cloud login session is missing");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(localStorage.getItem("steward_session_token")).toBeNull();
  });

  it.each(["warm_pool", "warm_pool_recovery"])(
    "accepts authoritative %s freshness when the backend omits created",
    async (source) => {
      setHostname("app-staging.elizacloud.ai");
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        jsonResponse({
          success: true,
          source,
          data: {
            id: "22222222-2222-4222-8222-222222222222",
            agentName: "Disposable",
            status: source === "warm_pool" ? "running" : "provisioning",
          },
        }),
      );
      const client = new ElizaClient(dedicatedStagingBase, "agent-bearer");

      await expect(
        client.createCloudCompatAgent({
          agentName: "Disposable",
          forceCreate: true,
        }),
      ).resolves.toMatchObject({ created: true });
    },
  );

  it.each([false, undefined])(
    "rejects force-create freshness confirmation %s before any agent bind or compat fallback",
    async (created) => {
      setHostname("app-staging.elizacloud.ai");
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        jsonResponse({
          success: true,
          ...(created === undefined ? {} : { created }),
          data: {
            id: "11111111-1111-4111-8111-111111111111",
            agentName: "Existing",
            status: "running",
          },
        }),
      );
      const client = new ElizaClient(dedicatedStagingBase, "agent-bearer");

      await expect(
        client.createCloudCompatAgent({
          agentName: "Disposable",
          forceCreate: true,
        }),
      ).rejects.toThrow("did not confirm that a new agent was created");

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(String(fetchSpy.mock.calls[0][0])).toBe("/api/v1/eliza/agents");
      expect(String(fetchSpy.mock.calls[0][0])).not.toContain(
        "/api/cloud/compat/agents",
      );
    },
  );

  it("surfaces a quota rejection after one direct POST with no retry or compat fallback", async () => {
    setHostname("app-staging.elizacloud.ai");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(
        {
          success: false,
          error: "Agent quota exceeded",
          code: "agent_quota_exceeded",
        },
        429,
      ),
    );
    const client = new ElizaClient(dedicatedStagingBase, "agent-bearer");

    await expect(
      client.createCloudCompatAgent({
        agentName: "Disposable",
        forceCreate: true,
      }),
    ).rejects.toMatchObject({ status: 429 });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toBe("/api/v1/eliza/agents");
    expect(String(fetchSpy.mock.calls[0][0])).not.toContain(
      "/api/cloud/compat/agents",
    );
  });
});

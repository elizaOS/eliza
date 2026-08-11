/**
 * Verifies dedicated-agent account management crosses to the Cloud control
 * plane only from trusted native, desktop, and local-development app shells.
 */
// @vitest-environment jsdom

import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({
  native: false,
  request: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => platform.native },
  CapacitorHttp: {
    get: vi.fn(),
    post: vi.fn(),
    request: platform.request,
  },
}));

import { setBootConfig } from "../config/boot-config";
import { ElizaClient } from "./client-base";
import "./client-cloud";

const DEDICATED_STAGING_BASE =
  "https://11111111-1111-4111-8111-111111111111.staging.elizacloud.ai";
const STAGING_CONTROL_PLANE = "https://api-staging.elizacloud.ai";
const originalLocationDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "location",
);

type ElectrobunWindow = Window & { __electrobunWindowId?: number };

function setPageLocation(
  hostname: string,
  protocol: "http:" | "https:" = "http:",
): void {
  const port = protocol === "http:" ? "2138" : "";
  const host = port ? `${hostname}:${port}` : hostname;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      hostname,
      host,
      port,
      protocol,
      origin: `${protocol}//${host}`,
      href: `${protocol}//${host}/settings`,
    },
  });
}

function setElectrobunRuntime(enabled: boolean): void {
  const runtimeWindow = window as ElectrobunWindow;
  if (enabled) {
    Object.defineProperty(runtimeWindow, "__electrobunWindowId", {
      configurable: true,
      value: 1,
    });
  } else {
    delete runtimeWindow.__electrobunWindowId;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function assertStewardRequests(
  calls: ReadonlyArray<readonly [RequestInfo | URL, RequestInit?]>,
): void {
  for (const [url, init] of calls) {
    expect(String(url)).toMatch(
      /^https:\/\/api-staging\.elizacloud\.ai\/api\/v1\//,
    );
    expect(String(url)).not.toContain("/api/cloud/compat/");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer steward-jwt",
    );
  }
}

beforeEach(() => {
  platform.native = false;
  platform.request.mockReset();
  localStorage.removeItem(STEWARD_TOKEN_KEY);
  setElectrobunRuntime(false);
  setBootConfig({
    branding: {},
    cloudApiBase: "https://staging.elizacloud.ai",
  });
});

afterEach(() => {
  localStorage.removeItem(STEWARD_TOKEN_KEY);
  setElectrobunRuntime(false);
  if (originalLocationDescriptor) {
    Object.defineProperty(window, "location", originalLocationDescriptor);
  }
  vi.restoreAllMocks();
});

describe("dedicated Cloud account boundary on trusted app shells", () => {
  it("uses only the stored Steward session for native list, create, and lifecycle requests", async () => {
    platform.native = true;
    localStorage.setItem(STEWARD_TOKEN_KEY, "steward-jwt");
    platform.request
      .mockResolvedValueOnce({
        status: 200,
        data: { success: true, data: [] },
      })
      .mockResolvedValueOnce({
        status: 202,
        data: {
          success: true,
          created: true,
          data: {
            id: "agent-new",
            agentName: "Disposable",
            status: "provisioning",
          },
        },
      })
      .mockResolvedValueOnce({
        status: 202,
        data: {
          success: true,
          data: {
            jobId: "job-resume",
            status: "queued",
            message: "Resume job created.",
          },
        },
      });
    const client = new ElizaClient(DEDICATED_STAGING_BASE, "agent-bearer");

    await client.getCloudCompatAgents();
    await client.createCloudCompatAgent({
      agentName: "Disposable",
      forceCreate: true,
    });
    await client.resumeCloudCompatAgent("agent-new");

    expect(platform.request).toHaveBeenCalledTimes(3);
    for (const [request] of platform.request.mock.calls) {
      expect(request.url).toMatch(
        /^https:\/\/api-staging\.elizacloud\.ai\/api\/v1\//,
      );
      expect(request.url).not.toContain("/api/cloud/compat/");
      expect(request.headers.Authorization).toBe("Bearer steward-jwt");
    }
    expect(platform.request.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        method: "POST",
        data: expect.objectContaining({ forceCreate: true }),
      }),
    );
    expect(platform.request.mock.calls[2]?.[0]).toEqual(
      expect.objectContaining({
        method: "POST",
        url: `${STAGING_CONTROL_PLANE}/api/v1/eliza/agents/agent-new/resume`,
      }),
    );
  });

  it("fails native list, create, and lifecycle closed when only the agent bearer exists", async () => {
    platform.native = true;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = new ElizaClient(DEDICATED_STAGING_BASE, "agent-bearer");

    await expect(
      client.selectOrProvisionCloudAgent({
        cloudApiBase: "https://staging.elizacloud.ai",
        authToken: "agent-bearer",
        name: "Disposable",
        forceCreate: true,
      }),
    ).rejects.toThrow("Eliza Cloud login session is missing");
    const listed = await client.getCloudCompatAgents();
    const created = await client.createCloudCompatAgent({
      agentName: "Disposable",
      forceCreate: true,
    });
    const resumed = await client.resumeCloudCompatAgent("agent-new");

    expect(listed).toMatchObject({
      success: false,
      error: "Eliza Cloud login session is missing. Sign in again.",
    });
    expect(created).toMatchObject({
      success: false,
      data: { status: "error" },
    });
    expect(resumed).toMatchObject({
      success: false,
      data: { status: "auth-missing" },
    });
    expect(platform.request).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
  });

  it.each([
    { label: "Electrobun", hostname: "127.0.0.1", electrobun: true },
    { label: "localhost dev", hostname: "localhost", electrobun: false },
  ])(
    "routes $label list, create, and lifecycle requests directly with Steward",
    async ({ hostname, electrobun }) => {
      setPageLocation(hostname);
      setElectrobunRuntime(electrobun);
      localStorage.setItem(STEWARD_TOKEN_KEY, "steward-jwt");
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [] }))
        .mockResolvedValueOnce(
          jsonResponse(
            {
              success: true,
              created: true,
              data: {
                id: "agent-new",
                agentName: "Disposable",
                status: "provisioning",
              },
            },
            202,
          ),
        )
        .mockResolvedValueOnce(
          jsonResponse(
            {
              success: true,
              data: {
                jobId: "job-resume",
                status: "queued",
                message: "Resume job created.",
              },
            },
            202,
          ),
        );
      const client = new ElizaClient(DEDICATED_STAGING_BASE, "agent-bearer");

      await client.getCloudCompatAgents();
      await client.createCloudCompatAgent({
        agentName: "Disposable",
        forceCreate: true,
      });
      await client.resumeCloudCompatAgent("agent-new");

      expect(fetchSpy).toHaveBeenCalledTimes(3);
      assertStewardRequests(fetchSpy.mock.calls);
      expect(fetchSpy.mock.calls[1]?.[1]).toEqual(
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining('"forceCreate":true'),
        }),
      );
      expect(String(fetchSpy.mock.calls[2]?.[0])).toBe(
        `${STAGING_CONTROL_PLANE}/api/v1/eliza/agents/agent-new/resume`,
      );
    },
  );

  it.each([
    { label: "Electrobun", hostname: "127.0.0.1", electrobun: true },
    { label: "localhost dev", hostname: "localhost", electrobun: false },
  ])(
    "fails $label closed without Steward and never tries direct or compat transport",
    async ({ hostname, electrobun }) => {
      setPageLocation(hostname);
      setElectrobunRuntime(electrobun);
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const client = new ElizaClient(DEDICATED_STAGING_BASE, "agent-bearer");

      await expect(
        client.selectOrProvisionCloudAgent({
          cloudApiBase: "https://staging.elizacloud.ai",
          authToken: "agent-bearer",
          name: "Disposable",
          forceCreate: true,
        }),
      ).rejects.toThrow("Eliza Cloud login session is missing");
      const listed = await client.getCloudCompatAgents();
      const created = await client.createCloudCompatAgent({
        agentName: "Disposable",
        forceCreate: true,
      });
      const resumed = await client.resumeCloudCompatAgent("agent-new");

      expect(listed).toMatchObject({ success: false, data: [] });
      expect(created).toMatchObject({
        success: false,
        data: { status: "error" },
      });
      expect(resumed).toMatchObject({
        success: false,
        data: { status: "auth-missing" },
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
    },
  );

  it.each([
    {
      label: "native",
      hostname: "localhost",
      native: true,
      electrobun: false,
    },
    {
      label: "Electrobun",
      hostname: "127.0.0.1",
      native: false,
      electrobun: true,
    },
    {
      label: "localhost dev",
      hostname: "localhost",
      native: false,
      electrobun: false,
    },
  ])(
    "rejects a hostile configured Cloud endpoint from $label without any transport",
    async ({ hostname, native, electrobun }) => {
      platform.native = native;
      setPageLocation(hostname);
      setElectrobunRuntime(electrobun);
      setBootConfig({
        branding: {},
        cloudApiBase: "https://attacker.example",
      });
      localStorage.setItem(STEWARD_TOKEN_KEY, "steward-jwt");
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const client = new ElizaClient(DEDICATED_STAGING_BASE, "agent-bearer");

      const listed = await client.getCloudCompatAgents();
      const created = await client.createCloudCompatAgent({
        agentName: "Disposable",
        forceCreate: true,
      });
      const resumed = await client.resumeCloudCompatAgent("agent-new");

      expect(listed).toMatchObject({ success: false, data: [] });
      expect(created).toMatchObject({
        success: false,
        data: { status: "error" },
      });
      expect(resumed).toMatchObject({
        success: false,
        data: { status: "auth-missing" },
      });
      expect(platform.request).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it("keeps an arbitrary self-hosted native client on its own compat origin", async () => {
    platform.native = true;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ success: true, data: [] }));
    const selfHostedBase = "https://agent.example.test";
    const client = new ElizaClient(selfHostedBase, "agent-bearer");

    await client.getCloudCompatAgents();

    expect(platform.request).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      `${selfHostedBase}/api/cloud/compat/agents`,
    );
    expect(String(fetchSpy.mock.calls[0]?.[0])).not.toContain(
      STAGING_CONTROL_PLANE,
    );
    expect(
      new Headers(fetchSpy.mock.calls[0]?.[1]?.headers).get("authorization"),
    ).toBe("Bearer agent-bearer");
  });

  it("does not grant an arbitrary self-hosted page direct control-plane access", async () => {
    setPageLocation("dashboard.example.test", "https:");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ success: true, data: [] }));
    const client = new ElizaClient(DEDICATED_STAGING_BASE, "agent-bearer");

    await expect(
      client.selectOrProvisionCloudAgent({
        cloudApiBase: "https://staging.elizacloud.ai",
        authToken: "agent-bearer",
        name: "Disposable",
        forceCreate: true,
      }),
    ).rejects.toThrow("requires a signed-in direct Eliza Cloud session");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();

    localStorage.setItem(STEWARD_TOKEN_KEY, "steward-jwt");
    await client.getCloudCompatAgents();
    await expect(
      client.createCloudCompatAgent({
        agentName: "Disposable",
        forceCreate: true,
      }),
    ).rejects.toThrow("requires a signed-in direct Eliza Cloud session");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      `${DEDICATED_STAGING_BASE}/api/cloud/compat/agents`,
    );
    expect(String(fetchSpy.mock.calls[0]?.[0])).not.toContain(
      STAGING_CONTROL_PLANE,
    );
  });
});

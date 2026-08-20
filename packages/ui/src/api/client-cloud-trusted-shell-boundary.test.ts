/**
 * Verifies dedicated-agent account management crosses to the Cloud control
 * plane only from trusted native, desktop, and local-development app shells.
 */
// @vitest-environment jsdom

import {
  STEWARD_SESSION_CHANGE_EVENT,
  STEWARD_TOKEN_KEY,
  type StewardSessionChangeDetail,
} from "@elizaos/shared/steward-session-client";
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
import { STAGING_DIRECT_CLOUD_API_BASE_URL } from "./direct-cloud-endpoints";

const DEDICATED_STAGING_BASE =
  "https://11111111-1111-4111-8111-111111111111.staging.elizacloud.ai";
const STAGING_CONTROL_PLANE = STAGING_DIRECT_CLOUD_API_BASE_URL;
const originalLocationDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "location",
);

type ElectrobunWindow = Window & { __electrobunWindowId?: number };

const TRUSTED_SHELL_CASES = [
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
] as const;

const PRESERVED_HTTP_CASES = TRUSTED_SHELL_CASES.flatMap((shell) =>
  [403, 500].map((status) => ({ ...shell, status })),
);

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

function configureTrustedShell(shell: (typeof TRUSTED_SHELL_CASES)[number]) {
  platform.native = shell.native;
  setPageLocation(shell.hostname);
  setElectrobunRuntime(shell.electrobun);
}

function mockTrustedShellResponse(
  body: unknown,
  status = 200,
  beforeResponse?: () => void,
) {
  platform.request.mockImplementationOnce(async () => {
    beforeResponse?.();
    return { status, data: body };
  });
  return vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () => {
    beforeResponse?.();
    return jsonResponse(body, status);
  });
}

function assertStewardRequests(
  calls: ReadonlyArray<readonly [RequestInfo | URL, RequestInit?]>,
): void {
  for (const [url, init] of calls) {
    expect(String(url)).toMatch(
      new RegExp(`^${STAGING_DIRECT_CLOUD_API_BASE_URL}/api/v1/`),
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
  it.each(TRUSTED_SHELL_CASES)(
    "preserves a healthy $label Steward session when the dedicated client mirrors the same token",
    async (shell) => {
      configureTrustedShell(shell);
      localStorage.setItem(STEWARD_TOKEN_KEY, "shared-steward-token");
      const fetchSpy = mockTrustedShellResponse({
        id: "user-1",
        organization_id: "org-1",
      });
      const client = new ElizaClient(
        DEDICATED_STAGING_BASE,
        "shared-steward-token",
      );

      await expect(client.getCloudStatus()).resolves.toMatchObject({
        connected: true,
        userId: "user-1",
        organizationId: "org-1",
      });
      expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe(
        "shared-steward-token",
      );

      if (shell.native) {
        expect(platform.request).toHaveBeenCalledTimes(1);
        expect(platform.request.mock.calls[0]?.[0].headers.Authorization).toBe(
          "Bearer shared-steward-token",
        );
        expect(fetchSpy).not.toHaveBeenCalled();
      } else {
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(
          new Headers(fetchSpy.mock.calls[0]?.[1]?.headers).get(
            "authorization",
          ),
        ).toBe("Bearer shared-steward-token");
      }
    },
  );

  it.each(TRUSTED_SHELL_CASES)(
    "clears only the rejected current $label token after a control-plane 401",
    async (shell) => {
      configureTrustedShell(shell);
      localStorage.setItem(STEWARD_TOKEN_KEY, "  rejected-token  ");
      const fetchSpy = mockTrustedShellResponse({ error: "unauthorized" }, 401);
      const syncListener = vi.fn();
      const sessionTransitions: StewardSessionChangeDetail[] = [];
      const sessionListener = (event: Event) => {
        sessionTransitions.push(
          (event as CustomEvent<StewardSessionChangeDetail>).detail,
        );
      };
      window.addEventListener("steward-token-sync", syncListener);
      window.addEventListener(STEWARD_SESSION_CHANGE_EVENT, sessionListener);
      const client = new ElizaClient(DEDICATED_STAGING_BASE, "rejected-token");

      await expect(client.getCloudStatus()).resolves.toMatchObject({
        connected: false,
        reason: "auth-rejected",
      });
      expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
      expect(syncListener).toHaveBeenCalledTimes(1);
      expect(sessionTransitions).toHaveLength(1);
      expect(sessionTransitions[0]?.state).toBe("cleared");

      await expect(client.getCloudCompatAgents()).resolves.toMatchObject({
        success: false,
        error: "Eliza Cloud login session is missing. Sign in again.",
      });
      if (shell.native) {
        expect(platform.request).toHaveBeenCalledTimes(1);
        expect(fetchSpy).not.toHaveBeenCalled();
      } else {
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      }
      window.removeEventListener("steward-token-sync", syncListener);
      window.removeEventListener(STEWARD_SESSION_CHANGE_EVENT, sessionListener);
    },
  );

  it.each([
    {
      label: "dedicated request switched to self-host",
      initialBase: DEDICATED_STAGING_BASE,
      switchedBase: "https://agent.example.test",
      expectedToken: null,
    },
    {
      label: "direct account request switched to dedicated",
      initialBase: STAGING_CONTROL_PLANE,
      switchedBase: DEDICATED_STAGING_BASE,
      expectedToken: null,
    },
  ])(
    "uses the request-time client scope for a $label 401",
    async ({ initialBase, switchedBase, expectedToken }) => {
      setPageLocation("localhost");
      localStorage.setItem(STEWARD_TOKEN_KEY, "rejected-token");
      let client: ElizaClient;
      vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () => {
        client.setBaseUrl(switchedBase, { persist: false });
        return jsonResponse({ error: "unauthorized" }, 401);
      });
      client = new ElizaClient(initialBase, "rejected-token");

      await expect(client.getCloudStatus()).resolves.toMatchObject({
        connected: false,
        reason: "auth-rejected",
      });

      expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe(expectedToken);
    },
  );

  it.each([
    {
      label: "ordinary canonical direct client",
      baseUrl: STAGING_CONTROL_PLANE,
      native: false,
    },
    {
      label: "arbitrary native self-host",
      baseUrl: "https://agent.example.test",
      native: true,
    },
  ])(
    "preserves a different Steward token after an $label 401",
    async ({ baseUrl, native }) => {
      platform.native = native;
      setPageLocation("localhost");
      const fetchSpy = mockTrustedShellResponse(
        { error: "unauthorized" },
        401,
        () => localStorage.setItem(STEWARD_TOKEN_KEY, "preserved-token"),
      );
      const client = new ElizaClient(baseUrl, "client-token");

      await client.getCloudStatus().catch(() => undefined);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe("preserved-token");
    },
  );

  it.each(TRUSTED_SHELL_CASES)(
    "preserves a refreshed $label token when an older in-flight request returns 401",
    async (shell) => {
      configureTrustedShell(shell);
      localStorage.setItem(STEWARD_TOKEN_KEY, "old-token");
      const fetchSpy = mockTrustedShellResponse(
        { error: "unauthorized" },
        401,
        () => localStorage.setItem(STEWARD_TOKEN_KEY, "fresh-token"),
      );
      const syncListener = vi.fn();
      window.addEventListener("steward-token-sync", syncListener);
      const client = new ElizaClient(DEDICATED_STAGING_BASE, "old-token");

      await expect(client.getCloudStatus()).resolves.toMatchObject({
        connected: false,
        reason: "auth-rejected",
      });
      expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe("fresh-token");
      expect(syncListener).not.toHaveBeenCalled();

      if (shell.native) {
        expect(platform.request).toHaveBeenCalledTimes(1);
        expect(fetchSpy).not.toHaveBeenCalled();
      } else {
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      }
      window.removeEventListener("steward-token-sync", syncListener);
    },
  );

  it.each(PRESERVED_HTTP_CASES)(
    "preserves the stored token after $label HTTP $status",
    async (shell) => {
      configureTrustedShell(shell);
      localStorage.setItem(STEWARD_TOKEN_KEY, "preserved-token");
      mockTrustedShellResponse({ error: "request rejected" }, shell.status);
      const client = new ElizaClient(DEDICATED_STAGING_BASE, "preserved-token");

      if (shell.status === 403) {
        await expect(client.getCloudStatus()).resolves.toMatchObject({
          connected: false,
          reason: "auth-rejected",
        });
      } else {
        await expect(client.getCloudStatus()).rejects.toMatchObject({
          status: shell.status,
        });
      }
      expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe("preserved-token");
    },
  );

  it.each(TRUSTED_SHELL_CASES)(
    "preserves the stored $label token after a network failure",
    async (shell) => {
      configureTrustedShell(shell);
      localStorage.setItem(STEWARD_TOKEN_KEY, "preserved-token");
      platform.request.mockRejectedValueOnce(new Error("offline"));
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("offline"));
      const client = new ElizaClient(DEDICATED_STAGING_BASE, "preserved-token");

      await expect(client.getCloudStatus()).rejects.toThrow("offline");
      expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe("preserved-token");
    },
  );

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
        new RegExp(`^${STAGING_DIRECT_CLOUD_API_BASE_URL}/api/v1/`),
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

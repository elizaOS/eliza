/**
 * Verifies native Cloud control-plane requests keep dedicated-agent and
 * Steward credentials separate. Capacitor HTTP is mocked; no Cloud is called.
 */
// @vitest-environment jsdom

import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const capacitorMocks = vi.hoisted(() => ({
  request: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => true,
  },
  CapacitorHttp: {
    get: vi.fn(),
    post: vi.fn(),
    request: capacitorMocks.request,
  },
}));

import { setBootConfig } from "../config/boot-config";
import { ElizaClient } from "./client-base";
import "./client-cloud";

const dedicatedStagingBase =
  "https://11111111-1111-4111-8111-111111111111.staging.elizacloud.ai";

describe("native dedicated Cloud agent credential boundary", () => {
  beforeEach(() => {
    setBootConfig({
      branding: {},
      cloudApiBase: "https://staging.elizacloud.ai",
    });
    localStorage.removeItem(STEWARD_TOKEN_KEY);
    capacitorMocks.request.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses only the stored Steward token for a dedicated agent's control-plane request", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, "stored-steward-jwt");
    capacitorMocks.request.mockResolvedValue({
      status: 200,
      data: { success: true, data: [] },
    });
    const client = new ElizaClient(dedicatedStagingBase, "agent-bearer");

    await client.getCloudCompatAgents();

    expect(capacitorMocks.request).toHaveBeenCalledTimes(1);
    expect(capacitorMocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api-staging.elizacloud.ai/api/v1/eliza/agents",
        headers: expect.objectContaining({
          Authorization: "Bearer stored-steward-jwt",
        }),
      }),
    );
    expect(
      capacitorMocks.request.mock.calls[0]?.[0]?.headers?.Authorization,
    ).not.toBe("Bearer agent-bearer");
  });

  it("fails closed without issuing a request when Steward is missing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = new ElizaClient(dedicatedStagingBase, "agent-bearer");

    await expect(client.getCloudCompatAgents()).resolves.toEqual({
      success: false,
      data: [],
      error: "Eliza Cloud login session is missing. Sign in again.",
    });

    expect(capacitorMocks.request).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
  });

  it("preserves direct control-plane bearer sessions that are not bound to an agent", async () => {
    capacitorMocks.request.mockResolvedValue({
      status: 200,
      data: { success: true, data: [] },
    });
    const client = new ElizaClient(
      "https://staging.elizacloud.ai",
      "control-plane-session",
    );

    await client.getCloudCompatAgents();

    expect(capacitorMocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api-staging.elizacloud.ai/api/v1/eliza/agents",
        headers: expect.objectContaining({
          Authorization: "Bearer control-plane-session",
        }),
      }),
    );
  });
});

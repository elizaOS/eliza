import type http from "node:http";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { billingRouteMock, compatRouteMock } = vi.hoisted(() => ({
  billingRouteMock: vi.fn(async () => true),
  compatRouteMock: vi.fn(async () => true),
}));

vi.mock("@elizaos/agent/api/cloud-billing-routes", () => ({
  handleCloudBillingRoute: billingRouteMock,
}));

vi.mock("@elizaos/agent/api/cloud-compat-routes", () => ({
  handleCloudCompatRoute: compatRouteMock,
}));

vi.mock("@elizaos/agent/config/config", () => ({
  loadElizaConfig: vi.fn(() => ({})),
  saveElizaConfig: vi.fn(),
}));

vi.mock("./auth", () => ({
  ensureCompatApiAuthorized: vi.fn(() => true),
  ensureCompatSensitiveRouteAuthorized: vi.fn(() => true),
  getCompatApiToken: vi.fn(() => null),
}));

import { handleMiladyCompatRoute } from "./server";
import { loadElizaConfig } from "@elizaos/agent/config/config";

function makeRes() {
  return {
    statusCode: 200,
    setHeader() {},
    end() {},
  } as unknown as http.ServerResponse;
}

describe("handleMiladyCompatRoute cloud proxy wrappers", () => {
  beforeEach(() => {
    billingRouteMock.mockClear();
    compatRouteMock.mockClear();
    vi.mocked(loadElizaConfig).mockReturnValue({} as never);
  });

  it("passes runtime through to the billing proxy handler", async () => {
    const runtime = { agentId: "agent-123", character: { secrets: {} } };

    const handled = await handleMiladyCompatRoute(
      {
        method: "GET",
        url: "/api/cloud/billing/summary",
      } as http.IncomingMessage,
      makeRes(),
      { current: runtime } as never,
    );

    expect(handled).toBe(true);
    expect(billingRouteMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "/api/cloud/billing/summary",
      "GET",
      expect.objectContaining({
        runtime,
      }),
    );
  });

  it("passes runtime through to the compat proxy handler", async () => {
    const runtime = { agentId: "agent-123", character: { secrets: {} } };

    const handled = await handleMiladyCompatRoute(
      {
        method: "GET",
        url: "/api/cloud/compat/agents",
      } as http.IncomingMessage,
      makeRes(),
      { current: runtime } as never,
    );

    expect(handled).toBe(true);
    expect(compatRouteMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "/api/cloud/compat/agents",
      "GET",
      expect.objectContaining({
        runtime,
      }),
    );
  });

  it("backfills the cloud api key from runtime secrets when disk config is missing it", async () => {
    vi.mocked(loadElizaConfig).mockReturnValue({
      cloud: {
        apiKey: null,
      },
    } as never);

    const runtime = {
      agentId: "agent-123",
      character: {
        secrets: {
          ELIZAOS_CLOUD_API_KEY: "runtime-setting-key",
        },
      },
    };

    await handleMiladyCompatRoute(
      {
        method: "GET",
        url: "/api/cloud/billing/summary",
      } as http.IncomingMessage,
      makeRes(),
      { current: runtime } as never,
    );

    expect(billingRouteMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "/api/cloud/billing/summary",
      "GET",
      expect.objectContaining({
        config: expect.objectContaining({
          cloud: expect.objectContaining({
            apiKey: "runtime-setting-key",
          }),
        }),
      }),
    );
  });
});

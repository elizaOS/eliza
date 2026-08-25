/** Exercises authenticated BlueBubbles gateway registration with deterministic Cloud API collaborators. */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: "user-1",
  organization_id: "org-1",
}));
const getAdminStatusForUser = mock(
  async (): Promise<{
    isAdmin: boolean;
    role: "super_admin" | null;
  }> => ({
    isAdmin: true,
    role: "super_admin",
  }),
);
const findByIdAndOrg = mock(async () => ({
  id: "11111111-1111-4111-8111-111111111111",
  user_id: "user-1",
  organization_id: "org-1",
}));
const createBlueBubblesGatewayRegistration = mock(async () => ({
  id: "gateway-1",
  bridgeId: "bb-22222222-2222-4222-8222-222222222222",
  token: `bbg_${"a".repeat(64)}`,
  phoneNumber: "+14155550123",
  organizationId: "org-1",
  userId: "user-1",
  routingMode: "sender-owned" as const,
  agentId: null,
}));
const listBlueBubblesGateways = mock(async () => []);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));
mock.module("@/lib/services/admin", () => ({
  adminService: { getAdminStatusForUser },
}));
mock.module("@/db/repositories/agent-sandboxes", () => ({
  agentSandboxesRepository: { findByIdAndOrg },
}));
mock.module("@/lib/services/phone-gateway-devices", () => ({
  createBlueBubblesGatewayRegistration,
  listBlueBubblesGateways,
}));

const { default: app } = await import("./route");

describe("BlueBubbles gateway registration API", () => {
  beforeEach(() => {
    findByIdAndOrg.mockClear();
    createBlueBubblesGatewayRegistration.mockClear();
    listBlueBubblesGateways.mockClear();
    getAdminStatusForUser.mockClear();
    getAdminStatusForUser.mockResolvedValue({
      isAdmin: true,
      role: "super_admin",
    });
    findByIdAndOrg.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      user_id: "user-1",
      organization_id: "org-1",
    });
  });

  test("rejects sender-owned identity attestation from an ordinary account", async () => {
    getAdminStatusForUser.mockResolvedValueOnce({
      isAdmin: false,
      role: null,
    });

    const response = await app.fetch(
      new Request("https://api.elizacloud.ai/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          routingMode: "sender-owned",
          phoneNumber: "+14155550123",
        }),
      }),
    );

    expect(response.status).toBe(403);
    expect(createBlueBubblesGatewayRegistration).not.toHaveBeenCalled();
  });

  test("lists only gateways owned by the authenticated user", async () => {
    const response = await app.fetch(
      new Request("https://api.elizacloud.ai/", { method: "GET" }),
    );

    expect(response.status).toBe(200);
    expect(listBlueBubblesGateways).toHaveBeenCalledWith("org-1", "user-1");
  });

  test("returns a sender-owned per-device relay credential without requiring an agent", async () => {
    const response = await app.fetch(
      new Request("https://api.elizacloud.ai/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          phoneNumber: "+1 (415) 555-0123",
          friendlyName: "My iPhone",
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        bridgeId: "bb-22222222-2222-4222-8222-222222222222",
        routingMode: "sender-owned",
        agentId: null,
        phoneNumber: "+14155550123",
        webhookUrl:
          "https://api.elizacloud.ai/api/webhooks/bluebubbles/bb-22222222-2222-4222-8222-222222222222",
        token: `bbg_${"a".repeat(64)}`,
        relayEnvironment: {
          BLUEBUBBLES_BRIDGE_ID: "bb-22222222-2222-4222-8222-222222222222",
          BLUEBUBBLES_GATEWAY_TOKEN: `bbg_${"a".repeat(64)}`,
        },
      },
    });
    expect(createBlueBubblesGatewayRegistration).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "user-1",
      routingMode: "sender-owned",
      agentId: null,
      phoneNumber: "+14155550123",
      friendlyName: "My iPhone",
    });
    expect(findByIdAndOrg).not.toHaveBeenCalled();
  });

  test("does not let a fixed-agent gateway bind to another user's agent", async () => {
    findByIdAndOrg.mockResolvedValueOnce({
      id: "11111111-1111-4111-8111-111111111111",
      user_id: "other-user",
      organization_id: "org-1",
    });
    const response = await app.fetch(
      new Request("https://api.elizacloud.ai/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          routingMode: "fixed-agent",
          agentId: "11111111-1111-4111-8111-111111111111",
          phoneNumber: "+14155550123",
        }),
      }),
    );

    expect(response.status).toBe(404);
    expect(getAdminStatusForUser).not.toHaveBeenCalled();
    expect(createBlueBubblesGatewayRegistration).not.toHaveBeenCalled();
  });
});

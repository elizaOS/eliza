/**
 * Contract coverage for BlueBubbles phone-gateway client methods. Capacitor HTTP
 * is mocked so URL, bearer auth, JSON registration payload, and revocation path
 * are verified without a live Eliza Cloud deployment.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const requestMock = vi.hoisted(() => vi.fn());

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true },
  CapacitorHttp: {
    get: vi.fn(),
    post: vi.fn(),
    request: requestMock,
  },
}));

import { setBootConfig } from "../config/boot-config";
import { ElizaClient } from "./client-base";
import "./client-cloud";

describe("ElizaClient BlueBubbles cloud gateway", () => {
  beforeEach(() => {
    setBootConfig({
      branding: {},
      cloudApiBase: "https://api.eliza.app",
    });
    requestMock.mockReset();
  });

  it("lists, registers, and revokes a phone binding through the direct Cloud API", async () => {
    requestMock
      .mockResolvedValueOnce({
        status: 200,
        data: { success: true, data: { gateways: [] } },
      })
      .mockResolvedValueOnce({
        status: 201,
        data: {
          success: true,
          data: {
            id: "gateway-1",
            bridgeId: "bb-bridge-1",
            phoneNumber: "+14155550123",
            routingMode: "sender-owned",
            agentId: null,
            webhookUrl:
              "https://api.eliza.app/api/webhooks/bluebubbles/bb-bridge-1",
            token: "bbg_secret_once",
            relayEnvironment: {
              ELIZA_CLOUD_BLUEBUBBLES_URL:
                "https://api.eliza.app/api/webhooks/bluebubbles/bb-bridge-1",
              BLUEBUBBLES_BRIDGE_ID: "bb-bridge-1",
              BLUEBUBBLES_GATEWAY_TOKEN: "bbg_secret_once",
              BLUEBUBBLES_GATEWAY_PHONE_NUMBER: "+14155550123",
            },
          },
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: { success: true },
      });

    const cloudClient = new ElizaClient(undefined, "cloud-session-token");
    await cloudClient.listCloudBlueBubblesGateways();
    const registered = await cloudClient.registerCloudBlueBubblesGateway({
      routingMode: "sender-owned",
      phoneNumber: "+1 (415) 555-0123",
      friendlyName: "Office iPhone",
    });
    await cloudClient.revokeCloudBlueBubblesGateway("gateway/1");

    expect(registered.data.token).toBe("bbg_secret_once");
    expect(requestMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        url: "https://api.eliza.app/api/v1/phone-gateways/bluebubbles",
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer cloud-session-token",
        }),
      }),
    );
    expect(requestMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        url: "https://api.eliza.app/api/v1/phone-gateways/bluebubbles",
        method: "POST",
        data: {
          routingMode: "sender-owned",
          phoneNumber: "+1 (415) 555-0123",
          friendlyName: "Office iPhone",
        },
      }),
    );
    expect(requestMock).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        url: "https://api.eliza.app/api/v1/phone-gateways/bluebubbles/gateway%2F1",
        method: "DELETE",
      }),
    );
  });
});

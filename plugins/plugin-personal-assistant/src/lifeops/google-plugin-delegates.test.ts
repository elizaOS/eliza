import { getConnectorAccountManager, type IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { LifeOpsServiceBase } from "./service-mixin-core.js";
import { withGoogle } from "./service-mixin-google.js";

const TestGoogleService = withGoogle(LifeOpsServiceBase);

function runtime(): IAgentRuntime {
  return {
    agentId: "11111111-1111-4111-8111-111111111111",
    character: { name: "Test Agent" },
    getService: vi.fn(() => null),
    getSetting: vi.fn(() => undefined),
    setSetting: vi.fn(),
  } as IAgentRuntime;
}

describe("LifeOps Google plugin delegation", () => {
  it("reports plugin-managed connector accounts as LifeOps Google status", async () => {
    const testRuntime = runtime();
    const manager = getConnectorAccountManager(testRuntime);
    manager.registerProvider({ provider: "google", label: "Google" });
    await manager.upsertAccount("google", {
      id: "acct_google_owner",
      role: "OWNER",
      purpose: ["messaging", "calendar"],
      accessGate: "owner_binding",
      status: "connected",
      externalId: "google-sub-1",
      displayHandle: "owner@example.com",
      metadata: {
        isDefault: true,
        grantedCapabilities: [
          "google.basic_identity",
          "google.gmail.triage",
          "google.calendar.read",
        ],
        grantedScopes: [
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/calendar.readonly",
        ],
      },
    });

    const service = new TestGoogleService(testRuntime);
    const status = await service.getGoogleConnectorStatus(
      new URL("http://127.0.0.1/api/connectors/google/accounts"),
      "local",
      "owner",
    );

    expect(status.connected).toBe(true);
    expect(status.sourceOfTruth).toBe("connector_account");
    expect(status.grant?.tokenRef).toBeNull();
    expect(status.grant?.connectorAccountId).toBe("acct_google_owner");
    expect(status.grantedCapabilities).toEqual(
      expect.arrayContaining([
        "google.basic_identity",
        "google.gmail.triage",
        "google.calendar.read",
      ]),
    );
  });

  it("rejects legacy cloud-managed mode instead of falling back", async () => {
    const service = new TestGoogleService(runtime());

    await expect(
      service.getGoogleConnectorStatus(
        new URL("http://127.0.0.1/api/connectors/google/accounts"),
        "cloud_managed",
        "owner",
      ),
    ).rejects.toMatchObject({
      status: 410,
      message: expect.stringContaining("no longer manages cloud or legacy"),
    });
  });
});

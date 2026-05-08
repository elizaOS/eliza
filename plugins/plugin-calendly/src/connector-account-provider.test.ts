import {
  getConnectorAccountManager,
  type IAgentRuntime,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  CALENDLY_PROVIDER_NAME,
  createCalendlyConnectorAccountProvider,
} from "./connector-account-provider.js";

function runtime(settings: Record<string, unknown>): IAgentRuntime {
  return {
    character: {},
    getSetting: vi.fn((key: string) => settings[key]),
  } as unknown as IAgentRuntime;
}

describe("Calendly ConnectorAccountManager provider", () => {
  it("lists legacy access tokens as a default OWNER account", async () => {
    const rt = runtime({ CALENDLY_ACCESS_TOKEN: "calendly-token" });
    const manager = getConnectorAccountManager(rt);
    manager.registerProvider(createCalendlyConnectorAccountProvider(rt));

    const accounts = await manager.listAccounts(CALENDLY_PROVIDER_NAME);

    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      id: "default",
      provider: CALENDLY_PROVIDER_NAME,
      role: "OWNER",
      accessGate: "open",
      status: "connected",
      metadata: expect.objectContaining({
        authMethod: "personal_access_token",
        isDefault: true,
      }),
    });
    expect(accounts[0]?.purpose).toEqual(
      expect.arrayContaining(["admin", "automation"]),
    );
  });

  it("creates, patches, and deletes stored accounts without hiding legacy default", async () => {
    const rt = runtime({ CALENDLY_ACCESS_TOKEN: "calendly-token" });
    const manager = getConnectorAccountManager(rt);
    manager.registerProvider(createCalendlyConnectorAccountProvider(rt));

    const created = await manager.createAccount(CALENDLY_PROVIDER_NAME, {
      label: "Agent Calendly",
      role: "AGENT",
      purpose: ["automation"],
      status: "connected",
    });

    expect(created).toMatchObject({
      provider: CALENDLY_PROVIDER_NAME,
      label: "Agent Calendly",
      role: "AGENT",
      purpose: ["automation"],
      status: "connected",
    });

    const listed = await manager.listAccounts(CALENDLY_PROVIDER_NAME);
    expect(listed.map((account) => account.id)).toEqual(
      expect.arrayContaining([created.id, "default"]),
    );

    const patched = await manager.patchAccount(
      CALENDLY_PROVIDER_NAME,
      created.id,
      {
        label: "Renamed Calendly",
        displayHandle: "agent-calendly",
      },
    );
    expect(patched).toMatchObject({
      id: created.id,
      label: "Renamed Calendly",
      displayHandle: "agent-calendly",
      role: "AGENT",
      purpose: ["automation"],
    });

    await expect(
      manager.deleteAccount(CALENDLY_PROVIDER_NAME, created.id),
    ).resolves.toBe(true);
    await expect(
      manager.getAccount(CALENDLY_PROVIDER_NAME, created.id),
    ).resolves.toBeNull();
  });
});

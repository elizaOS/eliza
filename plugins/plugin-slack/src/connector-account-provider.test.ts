import {
  getConnectorAccountManager,
  type IAgentRuntime,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { createSlackConnectorAccountProvider } from "./connector-account-provider";
import { SLACK_SERVICE_NAME } from "./types";

function runtime(settings: Record<string, unknown>): IAgentRuntime {
  return {
    character: {},
    getSetting: vi.fn((key: string) => settings[key]),
  } as unknown as IAgentRuntime;
}

describe("Slack ConnectorAccountManager provider", () => {
  it("lists legacy env credentials as a default OWNER account", async () => {
    const rt = runtime({ SLACK_BOT_TOKEN: "xoxb-test-token" });
    const manager = getConnectorAccountManager(rt);
    manager.registerProvider(createSlackConnectorAccountProvider(rt));

    const accounts = await manager.listAccounts(SLACK_SERVICE_NAME);

    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      id: "default",
      provider: SLACK_SERVICE_NAME,
      role: "OWNER",
      accessGate: "open",
      status: "connected",
      metadata: expect.objectContaining({
        isDefault: true,
        source: "env",
      }),
    });
    expect(accounts[0]?.purpose).toEqual(
      expect.arrayContaining(["messaging", "posting", "reading"]),
    );
  });

  it("creates, patches, and deletes stored accounts without hiding legacy default", async () => {
    const rt = runtime({ SLACK_BOT_TOKEN: "xoxb-test-token" });
    const manager = getConnectorAccountManager(rt);
    manager.registerProvider(createSlackConnectorAccountProvider(rt));

    const created = await manager.createAccount(SLACK_SERVICE_NAME, {
      label: "Team Slack",
      role: "TEAM",
      purpose: ["automation"],
      status: "connected",
    });

    expect(created).toMatchObject({
      provider: SLACK_SERVICE_NAME,
      label: "Team Slack",
      role: "TEAM",
      purpose: ["automation"],
      status: "connected",
    });

    const listed = await manager.listAccounts(SLACK_SERVICE_NAME);
    expect(listed.map((account) => account.id)).toEqual(
      expect.arrayContaining([created.id, "default"]),
    );

    const patched = await manager.patchAccount(SLACK_SERVICE_NAME, created.id, {
      label: "Renamed Slack",
      displayHandle: "team-slack",
    });
    expect(patched).toMatchObject({
      id: created.id,
      label: "Renamed Slack",
      displayHandle: "team-slack",
      role: "TEAM",
      purpose: ["automation"],
    });

    await expect(
      manager.deleteAccount(SLACK_SERVICE_NAME, created.id),
    ).resolves.toBe(true);
    await expect(
      manager.getAccount(SLACK_SERVICE_NAME, created.id),
    ).resolves.toBeNull();
  });
});

/** Tests connector setup's encrypted-store seam without touching config files. */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { ConnectorSetupService } from "./connector-setup-service";

function runtimeWithStore(store: unknown): IAgentRuntime {
  return {
    agentId: "agent-1",
    getService: (type: string) =>
      type === "connector_credential_store" ? store : null,
  } as unknown as IAgentRuntime;
}

describe("ConnectorSetupService credential persistence", () => {
  it("stores material in the connector credential store and returns only a vault sentinel", async () => {
    const putSecret = vi.fn(async () =>
      Promise.resolve("connector.agent-1.telegram.42.bot-token"),
    );
    const service = new ConnectorSetupService(
      runtimeWithStore({ putSecret, remove: vi.fn() }),
    );

    const reference = await service.persistConnectorCredential({
      provider: "telegram",
      accountId: "42",
      credentialType: "bot-token",
      value: "never-return-this-token",
      caller: "test",
    });

    expect(reference).toBe("vault://connector.agent-1.telegram.42.bot-token");
    expect(putSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        provider: "telegram",
        accountId: "42",
        credentialType: "bot-token",
        value: "never-return-this-token",
      }),
    );
  });

  it("removes only valid vault references", async () => {
    const remove = vi.fn(async () => Promise.resolve());
    const service = new ConnectorSetupService(
      runtimeWithStore({ putSecret: vi.fn(), remove }),
    );

    await expect(
      service.removeConnectorCredentialReference(
        "vault://connector.agent-1.telegram.42.bot-token",
      ),
    ).resolves.toBe(true);
    expect(remove).toHaveBeenCalledWith(
      "connector.agent-1.telegram.42.bot-token",
    );
    await expect(
      service.removeConnectorCredentialReference("plaintext"),
    ).resolves.toBe(false);
  });

  it("falls back without echoing credential material when no store is available", async () => {
    const service = new ConnectorSetupService(runtimeWithStore(null));
    await expect(
      service.persistConnectorCredential({
        provider: "telegram",
        accountId: "42",
        credentialType: "bot-token",
        value: "never-log-this-token",
      }),
    ).resolves.toBeNull();
  });
});

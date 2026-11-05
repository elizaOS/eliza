/** A Google disconnect that names no account (chat, connector registry) must not fall back to the default account when several are connected. Real connector account storage. */
import { getConnectorAccountManager } from "@elizaos/core";
import { expect, it } from "vitest";
import { createLifeOpsTestRuntime } from "../../test/helpers/runtime.js";
import { googleGrantIdForAccount } from "./google-plugin-delegates.js";
import { LifeOpsService, LifeOpsServiceError } from "./service.js";

it("refuses an unnamed disconnect with two connected accounts and removes only the named one", async () => {
  const host = await createLifeOpsTestRuntime();
  try {
    const manager = getConnectorAccountManager(host.runtime);
    manager.registerProvider({ provider: "google" });
    const base = {
      provider: "google",
      role: "OWNER",
      purpose: ["reading", "messaging"],
      accessGate: "owner_binding",
      status: "connected",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as const;
    await manager.upsertAccount("google", {
      ...base,
      id: "personal-mail",
      displayHandle: "personal@example.test",
      metadata: { isDefault: true },
    });
    const work = await manager.upsertAccount("google", {
      ...base,
      id: "work-mail",
      displayHandle: "work@example.test",
      metadata: {},
    });
    const service = new LifeOpsService(host.runtime);
    const url = new URL("http://localhost");
    const handles = async () =>
      (await manager.listAccounts("google"))
        .map((account) => account.displayHandle)
        .sort();

    // The chat path: "disconnect my work Gmail" reaches the service with no
    // account. It must not remove the default (personal) account.
    const refused = await service
      .disconnectGoogleConnector({ side: "owner", mode: "local" }, url)
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(refused).toBeInstanceOf(LifeOpsServiceError);
    expect((refused as LifeOpsServiceError).status).toBe(409);
    expect((refused as Error).message).toContain("work@example.test");
    expect(await handles()).toEqual([
      "personal@example.test",
      "work@example.test",
    ]);

    // The Connections view names the account: only that one is removed.
    await service.disconnectGoogleConnector(
      {
        side: "owner",
        mode: "local",
        grantId: googleGrantIdForAccount(work.id),
      },
      url,
    );
    expect(await handles()).toEqual(["personal@example.test"]);

    // With one connected account, an unnamed disconnect has one target.
    await service.disconnectGoogleConnector(
      { side: "owner", mode: "local" },
      url,
    );
    expect(await handles()).toEqual([]);
  } finally {
    await host.cleanup();
  }
}, 120_000);

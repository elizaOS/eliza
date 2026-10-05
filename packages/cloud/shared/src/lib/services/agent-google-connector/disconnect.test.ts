/**
 * #33189: an explicit `connectionId` that matches nothing must 404 instead of
 * falling through to `connections[0]` and revoking an unrelated connection.
 * Omitted/null connectionId keeps the disconnect-active-or-first contract.
 *
 * Exercises the REAL `disconnectManagedGoogleConnection` with
 * `managedGoogleConnectorDeps.oauthService` spied via `mock.module`-free
 * `spyOn` (the sibling `gmail.test.ts` pattern); the revoke spy keeps a call
 * ledger.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  AgentGoogleConnectorError,
  disconnectManagedGoogleConnection,
  managedGoogleConnectorDeps,
} from "./shared";

const revokeCalls: Array<{ organizationId: string; connectionId: string }> = [];

const CONNECTION_A = {
  id: "3f1c2a4e-0000-4000-8000-00000000000a",
} as never;
const CONNECTION_B = {
  id: "3f1c2a4e-0000-4000-8000-00000000000b",
} as never;

const spies: Array<{ mockRestore(): void }> = [];

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  revokeCalls.length = 0;
});

function stubConnections(connections: unknown[]) {
  spies.push(
    spyOn(managedGoogleConnectorDeps.oauthService, "listConnections")
      .mockReset()
      .mockResolvedValue(connections),
  );
  spies.push(
    spyOn(managedGoogleConnectorDeps.oauthService, "revokeConnection")
      .mockReset()
      .mockImplementation(async (args: { organizationId: string; connectionId: string }) => {
        revokeCalls.push(args);
      }),
  );
}

const baseArgs = {
  organizationId: "org-a",
  userId: "user-a",
  side: "owner" as const,
};

describe("disconnectManagedGoogleConnection explicit id (#33189)", () => {
  test("404s on an explicit-but-unknown id instead of revoking the first connection", async () => {
    stubConnections([CONNECTION_A, CONNECTION_B]);
    await expect(
      disconnectManagedGoogleConnection({
        ...baseArgs,
        connectionId: "3f1c2a4e-0000-4000-8000-0000000000ff",
      }),
    ).rejects.toBeInstanceOf(AgentGoogleConnectorError);
    expect(revokeCalls).toHaveLength(0);
  });

  test("404s on an explicit id when no scoped connections exist", async () => {
    stubConnections([]);
    await expect(
      disconnectManagedGoogleConnection({
        ...baseArgs,
        connectionId: "3f1c2a4e-0000-4000-8000-0000000000ff",
      }),
    ).rejects.toBeInstanceOf(AgentGoogleConnectorError);
    expect(revokeCalls).toHaveLength(0);
  });

  test("revokes exactly the named connection for a known explicit id", async () => {
    stubConnections([CONNECTION_A, CONNECTION_B]);
    await disconnectManagedGoogleConnection({
      ...baseArgs,
      connectionId: "3f1c2a4e-0000-4000-8000-00000000000b",
    });
    expect(revokeCalls).toHaveLength(1);
    expect(revokeCalls[0]?.connectionId).toBe("3f1c2a4e-0000-4000-8000-00000000000b");
  });

  test("keeps the omitted-id active-or-first contract", async () => {
    stubConnections([CONNECTION_A, CONNECTION_B]);
    await disconnectManagedGoogleConnection({ ...baseArgs });
    expect(revokeCalls).toHaveLength(1);
  });

  test("keeps the no-op for an omitted id with no connections", async () => {
    stubConnections([]);
    await disconnectManagedGoogleConnection({ ...baseArgs });
    expect(revokeCalls).toHaveLength(0);
  });
});

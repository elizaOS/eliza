/**
 * Durability coverage for GET /api/connectors/<provider>/accounts against the
 * REAL @elizaos/core connector-account manager (unlike the sibling route test,
 * core is not mocked here). Reproduces the production boot shape where the
 * manager is constructed during plugin registration before the SQL adapter is
 * attached to the runtime, then proves the account written after OAuth lands
 * in the durable adapter and is still listed by the route after a simulated
 * restart (fresh runtime + manager over the same adapter). Deterministic
 * harness — core's InMemoryDatabaseAdapter stands in for plugin-sql.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  getConnectorAccountManager,
  InMemoryDatabaseAdapter,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  type ConnectorAccountRouteContext,
  handleConnectorAccountRoutes,
} from "./connector-account-routes";

type Captured = { status: number; body: unknown };

function createRuntime(adapter?: InMemoryDatabaseAdapter) {
  return {
    agentId: "00000000-0000-0000-0000-000000000001",
    adapter,
    getService: vi.fn(() => null),
    getMessageConnectors: vi.fn(() => []),
    getPostConnectors: vi.fn(() => []),
    registerMessageConnector: vi.fn(),
    registerPostConnector: vi.fn(),
  };
}

function createContext(
  runtime: ReturnType<typeof createRuntime>,
  pathname: string,
): { ctx: ConnectorAccountRouteContext; captured: Captured } {
  const captured: Captured = { status: 200, body: null };
  const ctx: ConnectorAccountRouteContext = {
    req: { url: pathname, on: vi.fn() } as unknown as IncomingMessage,
    res: {
      statusCode: 200,
      setHeader: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
    } as unknown as ServerResponse,
    method: "GET",
    pathname,
    state: { runtime: runtime as never },
    readJsonBody: (async () => ({})) as never,
    json: (_res, data, status = 200) => {
      captured.status = status;
      captured.body = data;
    },
    error: (_res, message, status = 500) => {
      captured.status = status;
      captured.body = { error: message };
    },
    authorize: vi.fn(async () => true),
  };
  return { ctx, captured };
}

describe("connector account route durability (real core manager)", () => {
  it("lists an account after a restart even when the manager was constructed before the adapter registered", async () => {
    // Boot: connector plugin init constructs the manager while
    // runtime.adapter is still undefined (plugin-sql has not finished).
    const bootRuntime = createRuntime();
    const bootManager = getConnectorAccountManager(bootRuntime as never);

    // plugin-sql finishes and attaches the adapter to the runtime.
    const adapter = new InMemoryDatabaseAdapter();
    await adapter.initialize();
    (bootRuntime as { adapter?: InMemoryDatabaseAdapter }).adapter = adapter;

    // OAuth completion writes the connected account through the manager.
    await bootManager.upsertAccount("google", {
      id: "3a899cd0-170f-4b3e-932e-46ec68119b35",
      provider: "google",
      label: "user@example.com",
      externalId: "user@example.com",
      role: "OWNER",
      purpose: ["automation"],
      accessGate: "open",
      status: "connected",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: {},
    });

    // The route on the live process sees the account.
    const live = createContext(bootRuntime, "/api/connectors/google/accounts");
    await expect(handleConnectorAccountRoutes(live.ctx)).resolves.toBe(true);
    expect(live.captured.status).toBe(200);
    expect(
      (live.captured.body as { accounts: Array<{ status: string }> }).accounts,
    ).toHaveLength(1);

    // Restart: a brand-new runtime + manager over the same durable adapter.
    const restartedRuntime = createRuntime(adapter);
    getConnectorAccountManager(restartedRuntime as never);
    const restarted = createContext(
      restartedRuntime,
      "/api/connectors/google/accounts",
    );
    await expect(handleConnectorAccountRoutes(restarted.ctx)).resolves.toBe(
      true,
    );
    expect(restarted.captured.status).toBe(200);
    const body = restarted.captured.body as {
      defaultAccountId?: string;
      accounts: Array<{ provider: string; status: string; label?: string }>;
    };
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0]).toMatchObject({
      provider: "google",
      status: "connected",
    });
    expect(body.defaultAccountId).toBeTruthy();
  });
});

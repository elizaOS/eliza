/**
 * Bounds coverage for the two metadata walks in connector-account-routes.ts
 * against the REAL route handler and the REAL @elizaos/core connector-account
 * manager (core is not mocked here; InMemoryDatabaseAdapter stands in for
 * plugin-sql), modelled on the sibling connector-account-routes.durable.test.ts
 * harness.
 *
 * `metadataSchema` is `z.record(z.string(), z.unknown())`, so a caller-supplied
 * body may nest arbitrarily. `cleanMetadata` (write) and `redactAuditMetadata`
 * (read) both used to recurse once per level with no depth cap, no visit
 * budget and no cycle guard, and neither call site was inside a `try`. Stack
 * exhaustion therefore escaped `handleConnectorAccountRoutes` entirely --
 * neither `json()` nor `error()` ran, so no response was ever written. The read
 * side fails the same way on an adapter-supplied audit row, whose `metadata`
 * column no layer between the row and the redaction walk bounds.
 *
 * These tests pin the bounded behaviour: an over-budget write is rejected with
 * a 400, an over-budget stored value is still served with an explicit marker,
 * and honest nested metadata is untouched.
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

const PROVIDER = "google";
const ACCOUNT_ID = "3a899cd0-170f-4b3e-932e-46ec68119b35";

/** Comfortably past the V8 recursion limit for these frames. */
const OVERFLOW_DEPTH = 60_000;

function deepChain(depth: number): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let cursor = root;
  for (let index = 0; index < depth; index += 1) {
    const next: Record<string, unknown> = {};
    cursor.a = next;
    cursor = next;
  }
  cursor.leaf = "end";
  return root;
}

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
  method: string,
  pathname: string,
  body?: unknown,
): { ctx: ConnectorAccountRouteContext; captured: Captured } {
  const captured: Captured = { status: 0, body: null };
  const ctx: ConnectorAccountRouteContext = {
    req: { url: pathname, on: vi.fn() } as unknown as IncomingMessage,
    res: {
      statusCode: 200,
      setHeader: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
    } as unknown as ServerResponse,
    method,
    pathname,
    state: { runtime: runtime as never },
    readJsonBody: (async () => body ?? {}) as never,
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

async function newAdapter(): Promise<InMemoryDatabaseAdapter> {
  const adapter = new InMemoryDatabaseAdapter();
  await adapter.initialize();
  return adapter;
}

describe("connector account metadata walk bounds (real route handler)", () => {
  it("rejects an over-deep POST body with a 400 instead of escaping the handler", async () => {
    const runtime = createRuntime(await newAdapter());
    const pathname = `/api/connectors/${PROVIDER}/accounts`;
    const { ctx, captured } = createContext(runtime, "POST", pathname, {
      label: "deep",
      metadata: { root: deepChain(OVERFLOW_DEPTH) },
    });

    const handled = await handleConnectorAccountRoutes(ctx);

    expect(handled).toBe(true);
    expect(captured.status).toBe(400);
    expect(String((captured.body as { error: string }).error)).toMatch(
      /metadata/i,
    );
  });

  it("rejects an over-deep PATCH body with a 400", async () => {
    const adapter = await newAdapter();
    const runtime = createRuntime(adapter);
    const manager = getConnectorAccountManager(runtime as never);
    await manager.upsertAccount(PROVIDER, {
      id: ACCOUNT_ID,
      provider: PROVIDER,
      label: "user@example.com",
      role: "OWNER",
      accessGate: "open",
      status: "connected",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: {},
    } as never);

    const pathname = `/api/connectors/${PROVIDER}/accounts/${ACCOUNT_ID}`;
    const { ctx, captured } = createContext(runtime, "PATCH", pathname, {
      metadata: { root: deepChain(OVERFLOW_DEPTH) },
    });

    const handled = await handleConnectorAccountRoutes(ctx);

    expect(handled).toBe(true);
    expect(captured.status).toBe(400);
  });

  it("still serves audit events whose stored row metadata is over-deep, instead of 500ing the read", async () => {
    // Audit rows come back from the adapter (`listConnectorAccountAuditEvents`
    // or the raw SQL fallback); nothing between the row and the redaction walk
    // bounds their `metadata` column.
    const runtime = {
      agentId: "00000000-0000-0000-0000-000000000001",
      adapter: {
        listConnectorAccountAuditEvents: async () => [
          {
            id: "evt-1",
            accountId: "acct-1",
            agentId: "00000000-0000-0000-0000-000000000001",
            provider: PROVIDER,
            actorId: null,
            action: "connect",
            outcome: "success",
            metadata: { root: deepChain(OVERFLOW_DEPTH) },
            createdAt: Date.now(),
          },
        ],
      },
      getService: vi.fn(() => null),
      getMessageConnectors: vi.fn(() => []),
      getPostConnectors: vi.fn(() => []),
      registerMessageConnector: vi.fn(),
      registerPostConnector: vi.fn(),
    } as unknown as ReturnType<typeof createRuntime>;

    const pathname = `/api/connectors/${PROVIDER}/audit/events`;
    const { ctx, captured } = createContext(runtime, "GET", pathname);

    const handled = await handleConnectorAccountRoutes(ctx);

    expect(handled).toBe(true);
    expect(captured.status).toBe(200);
    const body = captured.body as { events: Array<{ metadata: unknown }> };
    // Explicit marker, not a silently truncated object served as success.
    expect(body.events[0]?.metadata).toBe("[UNBOUNDED]");
  });

  it("keeps honest nested metadata byte-for-byte on the write and read paths", async () => {
    const adapter = await newAdapter();
    const runtime = createRuntime(adapter);
    const honest = {
      handle: "user@example.com",
      profile: {
        display: "User",
        tags: ["work", "personal"],
        settings: {
          notifications: { email: true, push: false },
          quota: { daily: 100, nested: { deeper: { deepest: "ok" } } },
        },
      },
      history: [{ at: 1, note: "created" }, { at: 2, note: "verified" }, null],
      empty: {},
      emptyList: [],
      flag: false,
      count: 0,
    };

    const createPath = `/api/connectors/${PROVIDER}/accounts`;
    const create = createContext(runtime, "POST", createPath, {
      label: "user@example.com",
      metadata: honest,
    });
    expect(await handleConnectorAccountRoutes(create.ctx)).toBe(true);
    expect(create.captured.status).toBe(201);

    const created = create.captured.body as {
      id: string;
      metadata: Record<string, unknown>;
    };
    expect(created.metadata).toEqual(honest);

    const readPath = `/api/connectors/${PROVIDER}/accounts/${created.id}`;
    const read = createContext(runtime, "GET", readPath);
    expect(await handleConnectorAccountRoutes(read.ctx)).toBe(true);
    expect(read.captured.status).toBe(200);
    expect((read.captured.body as { metadata: unknown }).metadata).toEqual(
      honest,
    );
  });

  it("still strips secret-shaped and client-reserved metadata keys on write", async () => {
    const runtime = createRuntime(await newAdapter());
    const createPath = `/api/connectors/${PROVIDER}/accounts`;
    const create = createContext(runtime, "POST", createPath, {
      label: "user@example.com",
      metadata: {
        keep: "yes",
        access_token: "sk-should-not-persist",
        ownerBindingId: "spoofed",
        nested: { refresh_token: "nope", ok: 1 },
      },
    });

    expect(await handleConnectorAccountRoutes(create.ctx)).toBe(true);
    expect(create.captured.status).toBe(201);
    const created = create.captured.body as {
      metadata: Record<string, unknown>;
    };
    expect(created.metadata.keep).toBe("yes");
    expect(created.metadata.access_token).toBeUndefined();
    expect(created.metadata.ownerBindingId).toBeUndefined();
    expect(created.metadata.nested).toEqual({ ok: 1 });
  });

  it("redacts secret-shaped keys on read without walking past the budget", async () => {
    const adapter = await newAdapter();
    const runtime = createRuntime(adapter);
    const manager = getConnectorAccountManager(runtime as never);
    await manager.upsertAccount(PROVIDER, {
      id: ACCOUNT_ID,
      provider: PROVIDER,
      label: "user@example.com",
      role: "OWNER",
      accessGate: "open",
      status: "connected",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: { keep: "yes", nested: { access_token: "leaked" } } as never,
    } as never);

    const pathname = `/api/connectors/${PROVIDER}/accounts/${ACCOUNT_ID}`;
    const { ctx, captured } = createContext(runtime, "GET", pathname);
    expect(await handleConnectorAccountRoutes(ctx)).toBe(true);
    expect(captured.status).toBe(200);
    const serialized = captured.body as { metadata: Record<string, unknown> };
    expect(serialized.metadata.keep).toBe("yes");
    expect(serialized.metadata.nested).toEqual({ access_token: "[REDACTED]" });
  });
});

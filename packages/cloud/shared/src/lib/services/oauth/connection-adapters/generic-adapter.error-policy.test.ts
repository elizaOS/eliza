/**
 * Error-policy tests for the generic OAuth connection adapter (#13415). The
 * auth/token/tenant-DB path must FAIL CLOSED: an internal DB failure while
 * looking up a credential (getToken) or listing connections must PROPAGATE,
 * and must stay distinguishable from the legitimately-empty result (no rows),
 * which still yields the designed connectionNotFound / empty-list outcome.
 * dbRead is a mutable thenable query-builder proxy; the real Errors/OAuthError
 * classes run unmocked so the "not found" signal is asserted for real.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

// dbReadBehavior drives every awaited dbRead query in a test: a rejecting
// behavior models an internal failure, a resolving [] models a successful
// empty query. The chain builder is thenable so `.select().from().where()`
// (and optional `.limit()`) resolves to this behavior's result.
let dbReadBehavior: () => Promise<unknown[]> = async () => [];

function makeReadBuilder() {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  builder.from = chain;
  builder.where = chain;
  builder.limit = chain;
  // biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are awaited as thenables in this test harness.
  builder.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    dbReadBehavior().then(resolve, reject);
  return builder;
}

mock.module("../../../../db/client", () => ({
  dbRead: { select: () => makeReadBuilder() },
  dbWrite: {
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  },
}));

mock.module("../../../utils/logger", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

mock.module("../../secrets", () => ({
  secretsService: {
    getDecryptedValue: async () => "token",
    rotate: async () => undefined,
    delete: async () => undefined,
  },
}));

mock.module("../../secrets/encryption", () => ({
  DecryptionError: class DecryptionError extends Error {
    phase: string;
    constructor(message: string, phase = "value_decryption") {
      super(message);
      this.phase = phase;
    }
  },
}));

mock.module("../cache-version", () => ({
  incrementOAuthVersion: async () => 1,
}));

mock.module("../provider-registry", () => ({
  getProvider: () => undefined,
}));

mock.module("../providers", () => ({
  refreshOAuth2Token: async () => ({ accessToken: "new", expiresIn: 3600 }),
}));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";

describe("createGenericAdapter — fail-closed error policy (#13415)", () => {
  beforeEach(() => {
    dbReadBehavior = async () => [];
  });
  afterEach(() => {
    dbReadBehavior = async () => [];
  });

  it("getToken PROPAGATES an internal DB failure (not swallowed to connectionNotFound)", async () => {
    const { createGenericAdapter } = await import("./generic-adapter");
    const { OAuthError } = await import("../errors");
    const adapter = createGenericAdapter("linear");

    dbReadBehavior = async () => {
      throw new Error("DB connection lost");
    };

    let caught: unknown;
    try {
      await adapter.getToken(ORG_ID, CONNECTION_ID);
    } catch (error) {
      caught = error;
    }

    // The raw DB failure must surface — NOT be masked as a domain "not found".
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(OAuthError);
    expect((caught as Error).message).toBe("DB connection lost");
  });

  it("getToken on a successful empty query returns the designed connectionNotFound", async () => {
    const { createGenericAdapter } = await import("./generic-adapter");
    const { OAuthError, OAuthErrorCode } = await import("../errors");
    const adapter = createGenericAdapter("linear");

    dbReadBehavior = async () => []; // query succeeded, zero rows

    let caught: unknown;
    try {
      await adapter.getToken(ORG_ID, CONNECTION_ID);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OAuthError);
    expect((caught as InstanceType<typeof OAuthError>).code).toBe(
      OAuthErrorCode.CONNECTION_NOT_FOUND,
    );
  });

  it("listConnections PROPAGATES an internal DB failure (not swallowed to [])", async () => {
    const { createGenericAdapter } = await import("./generic-adapter");
    const adapter = createGenericAdapter("linear");

    dbReadBehavior = async () => {
      throw new Error("enum type does not exist");
    };

    let caught: unknown;
    try {
      await adapter.listConnections(ORG_ID);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("enum type does not exist");
  });

  it("listConnections on a successful empty query returns the designed empty list", async () => {
    const { createGenericAdapter } = await import("./generic-adapter");
    const adapter = createGenericAdapter("linear");

    dbReadBehavior = async () => []; // query succeeded, zero rows

    const result = await adapter.listConnections(ORG_ID);
    expect(result).toEqual([]);
  });

  it("ownsConnection PROPAGATES an internal DB failure for a well-formed id", async () => {
    const { createGenericAdapter } = await import("./generic-adapter");
    const adapter = createGenericAdapter("linear");

    dbReadBehavior = async () => {
      throw new Error("DB connection lost");
    };

    await expect(adapter.ownsConnection(CONNECTION_ID)).rejects.toThrow("DB connection lost");
  });

  it("ownsConnection returns false (designed not-owned) for a malformed id without touching the DB", async () => {
    const { createGenericAdapter } = await import("./generic-adapter");
    const adapter = createGenericAdapter("linear");

    let touched = false;
    dbReadBehavior = async () => {
      touched = true;
      return [];
    };

    expect(await adapter.ownsConnection("not-a-uuid")).toBe(false);
    expect(touched).toBe(false);
  });
});

/**
 * Error-policy tests for deletePlatformSecrets (#13415): revoke is an auth/secrets
 * path and must fail CLOSED. An internal secret-delete failure must PROPAGATE (so a
 * revoke never reports success while live credentials remain in the DB), while a
 * legitimately-empty match (no secrets found) still returns its designed 0-count —
 * the two must be distinguishable. dbRead + secretsService are mocked; the real
 * exported function runs unmocked.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import * as realDbClient from "../../../../db/client";
import * as realSecrets from "../../secrets";

// bun's `mock.restore()` (called in afterEach below) restores spies but does NOT
// undo `mock.module` overrides — those patch the process-global module registry
// and persist. Under the batched cloud-unit runner (`--isolate` occasionally
// fails to contain these on a memory-pressured runner) these db/client + secrets
// doubles otherwise bleed into later suites (e.g. pii-scrub-jobs, which needs a
// real PGlite db/client), turning them red. Snapshot the real exports now and
// reinstall them in afterAll so this file's stubs are strictly local.
const realDbClientExports = { ...realDbClient };
const realSecretsExports = { ...realSecrets };

let secretsToReturn: Array<{ id: string; name: string; created_at: Date }> = [];
const deleteCalls: Array<{ id: string; organizationId: string }> = [];
let deleteBehavior: (id: string) => Promise<void> = async () => {};

mock.module("../../../../db/client", () => ({
  dbRead: {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(secretsToReturn),
      }),
    }),
  },
  dbWrite: {},
}));

mock.module("../../secrets", () => ({
  secretsService: {
    delete: async (id: string, organizationId: string) => {
      deleteCalls.push({ id, organizationId });
      return deleteBehavior(id);
    },
    get: async () => null,
  },
}));

const ORG_ID = "org-1";
const PREFIX = "TWITTER_OWNER_";

describe("deletePlatformSecrets — fail-closed revoke (#13415)", () => {
  beforeEach(() => {
    secretsToReturn = [];
    deleteCalls.length = 0;
    deleteBehavior = async () => {};
  });

  afterEach(() => {
    mock.restore();
  });

  afterAll(() => {
    mock.module("../../../../db/client", () => realDbClientExports);
    mock.module("../../secrets", () => realSecretsExports);
  });

  it("legitimately-empty match returns designed 0-count, no throw, no delete attempts", async () => {
    const { deletePlatformSecrets } = await import("./secrets-adapter-utils");
    secretsToReturn = [];

    const count = await deletePlatformSecrets(ORG_ID, PREFIX, "oauth-service");

    expect(count).toBe(0);
    expect(deleteCalls).toHaveLength(0);
  });

  it("all secrets deleted returns the real count", async () => {
    const { deletePlatformSecrets } = await import("./secrets-adapter-utils");
    secretsToReturn = [
      { id: "s1", name: "TWITTER_OWNER_ACCESS_TOKEN", created_at: new Date() },
      { id: "s2", name: "TWITTER_OWNER_ACCESS_TOKEN_SECRET", created_at: new Date() },
    ];

    const count = await deletePlatformSecrets(ORG_ID, PREFIX, "oauth-service");

    expect(count).toBe(2);
    expect(deleteCalls.map((c) => c.id)).toEqual(["s1", "s2"]);
  });

  it("internal delete failure PROPAGATES (not swallowed to a success count)", async () => {
    const { deletePlatformSecrets } = await import("./secrets-adapter-utils");
    secretsToReturn = [{ id: "s1", name: "TWITTER_OWNER_ACCESS_TOKEN", created_at: new Date() }];
    deleteBehavior = async () => {
      throw new Error("Failed to delete secret");
    };

    let caught: unknown;
    try {
      await deletePlatformSecrets(ORG_ID, PREFIX, "oauth-service");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("Failed to delete secret");
    // It attempted the delete rather than silently reporting success.
    expect(deleteCalls).toHaveLength(1);
  });

  it("empty (0) and failure (throw) are distinguishable outcomes for the same call", async () => {
    const { deletePlatformSecrets } = await import("./secrets-adapter-utils");

    secretsToReturn = [];
    await expect(deletePlatformSecrets(ORG_ID, PREFIX, "oauth-service")).resolves.toBe(0);

    secretsToReturn = [{ id: "s9", name: "TWITTER_OWNER_X", created_at: new Date() }];
    deleteBehavior = async () => {
      throw new Error("Failed to delete secret");
    };
    await expect(deletePlatformSecrets(ORG_ID, PREFIX, "oauth-service")).rejects.toThrow(
      "Failed to delete secret",
    );
  });
});

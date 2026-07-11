/**
 * Error-policy tests for OAuthService.listConnections (#13415). This is
 * auth/tenant-DB domain: a failed platform-credential read or a failed
 * connection-adapter query must FAIL CLOSED (propagate), never be swallowed to
 * a partial/empty list — a swallowed failure reads as "not connected" and makes
 * callers re-prompt OAuth for an already-connected user. A legitimately-empty
 * result (query succeeds, no rows) must still return []. DB client and adapter
 * registry are mocked; the real listConnections/scoping logic runs unmocked.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import * as realDbClient from "../../../db/client";
import * as realConnectionAdapters from "./connection-adapters";

// bun's `mock.restore()` (called in afterEach below) restores spies but does NOT
// undo `mock.module` overrides — those patch the process-global module registry
// and persist. Under the batched cloud-unit runner (`--isolate` occasionally
// fails to contain these on a memory-pressured runner) these db/client +
// connection-adapters doubles otherwise bleed into later suites (e.g.
// pii-scrub-jobs, which needs a real PGlite db/client), turning them red.
// Snapshot the real exports now and reinstall them in afterAll so this file's
// stubs are strictly local.
const realDbClientExports = { ...realDbClient };
const realConnectionAdaptersExports = { ...realConnectionAdapters };

let dbWhere: () => Promise<unknown[]>;
let getAdapterResult: {
  platform: string;
  listConnections: (orgId: string) => Promise<unknown[]>;
} | null;

const notImplemented = () => {
  throw new Error("db access not stubbed in error-policy test");
};

// Replace the whole module, so provide every export the import graph references;
// only dbRead is exercised here.
mock.module("../../../db/client", () => ({
  dbRead: {
    select: () => ({
      from: () => ({
        where: () => dbWhere(),
      }),
    }),
  },
  db: {},
  dbWrite: {},
  runWithDbCache: <T>(fn: () => T) => fn(),
  runWithDbCacheAsync: <T>(fn: () => Promise<T>) => fn(),
  withReadDb: notImplemented,
  withWriteDb: notImplemented,
  getDbConnectionInfo: notImplemented,
  closeDatabaseConnectionsForTests: async () => {},
  shouldSkipTlsVerification: () => false,
  enforceTlsForRemote: notImplemented,
}));

// provider-registry is left real: listConnections only calls getProvider inside
// the getAllAdapters().filter(...), which never runs because getAllAdapters is [].
mock.module("./connection-adapters", () => ({
  getAdapter: () => getAdapterResult,
  getAllAdapters: () => [],
}));

const ORG_ID = "22222222-2222-4222-8222-222222222222";

describe("OAuthService.listConnections — error policy (#13415)", () => {
  beforeEach(() => {
    dbWhere = async () => [];
    getAdapterResult = null;
  });

  afterEach(() => {
    mock.restore();
  });

  afterAll(() => {
    mock.module("../../../db/client", () => realDbClientExports);
    mock.module("./connection-adapters", () => realConnectionAdaptersExports);
  });

  it("propagates a platform-credential DB read failure (fail closed, not swallowed to [])", async () => {
    const { oauthService } = await import("./oauth-service");
    const cause = new Error("db connection refused");
    dbWhere = async () => {
      throw cause;
    };

    let caught: unknown;
    try {
      await oauthService.listConnections({ organizationId: ORG_ID });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("Failed to load platform credentials");
    expect((caught as Error).message).toContain(ORG_ID);
    expect((caught as Error).cause).toBe(cause);
  });

  it("returns the designed-empty [] when the credential read succeeds with no rows", async () => {
    const { oauthService } = await import("./oauth-service");
    dbWhere = async () => [];

    const result = await oauthService.listConnections({ organizationId: ORG_ID });

    expect(result).toEqual([]);
  });

  it("propagates a connection-adapter query failure (fail closed, not swallowed to [])", async () => {
    const { oauthService } = await import("./oauth-service");
    const cause = new Error("adapter upstream 503");
    getAdapterResult = {
      platform: "google",
      listConnections: async () => {
        throw cause;
      },
    };

    let caught: unknown;
    try {
      await oauthService.listConnections({ organizationId: ORG_ID, platform: "google" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("Failed to list connections for platform google");
    expect((caught as Error).cause).toBe(cause);
  });

  it("returns the designed-empty [] when the adapter reports no connections", async () => {
    const { oauthService } = await import("./oauth-service");
    getAdapterResult = {
      platform: "google",
      listConnections: async () => [],
    };

    const result = await oauthService.listConnections({
      organizationId: ORG_ID,
      platform: "google",
    });

    expect(result).toEqual([]);
  });
});

/**
 * Real error-path coverage for the fail-fast DB adapter sweep (#12269 / #12182):
 * drives a genuinely broken PGlite (its underlying connection is closed out from
 * under the adapter while the manager still reports "not shutting down", so the
 * query itself faults) and asserts that read/count/write methods throw a typed
 * `ElizaError` with the right `code` instead of fabricating a healthy-looking
 * default (`0` / `[]` / `false` / `undefined`). A companion case confirms an API
 * route mounted over the adapter surfaces a structured 5xx, not a fabricated 200.
 *
 * No mocks: the failure is a real closed PGlite client. `VITEST_EXCLUDE_REAL=1`
 * (the PR lane) skips this; the post-merge lane runs it against real PGlite.
 */
import type { PGlite } from "@electric-sql/pglite";
import { type ElizaError, isElizaError, type UUID } from "@elizaos/core";
import { v4 } from "uuid";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PgDatabaseAdapter } from "../../pg/adapter";
import type { PgliteDatabaseAdapter } from "../../pglite/adapter";
import { createIsolatedTestDatabase } from "../test-helpers";

type Adapter = PgliteDatabaseAdapter | PgDatabaseAdapter;

// Close the live PGlite client without going through adapter.close() (which
// flips the manager's shuttingDown flag and short-circuits withDatabase with a
// plain "shutting down" error). Closing only the raw connection leaves the
// shutdown gate open, so the next real query faults and exercises the adapter's
// own catch → ElizaError path — the actual behavior under a broken DB.
async function breakConnection(adapter: Adapter): Promise<void> {
  const raw = (adapter as PgliteDatabaseAdapter).getRawConnection?.() as PGlite | undefined;
  if (!raw) throw new Error("test requires the PGlite adapter (getRawConnection)");
  await raw.close();
}

async function expectElizaError(fn: () => Promise<unknown>, code: string): Promise<ElizaError> {
  let thrown: unknown;
  try {
    await fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown, `expected a throw with code ${code}, got a normal return`).toBeDefined();
  expect(isElizaError(thrown), `expected ElizaError, got ${String(thrown)}`).toBe(true);
  expect((thrown as ElizaError).code).toBe(code);
  return thrown as ElizaError;
}

describe("DB adapter fail-fast error paths (real broken PGlite)", () => {
  let adapter: Adapter;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const setup = await createIsolatedTestDatabase("db-failure-error-path");
    adapter = setup.adapter;
    cleanup = setup.cleanup;
  }, 60_000);

  afterEach(async () => {
    // cleanup() calls adapter.close(); the raw connection may already be closed,
    // which is tolerated by the J6 teardown handlers in the manager.
    if (cleanup) await cleanup();
  });

  it("countAgents throws DB_COUNT_FAILED instead of returning 0", async () => {
    await breakConnection(adapter);
    await expectElizaError(() => adapter.countAgents(), "DB_COUNT_FAILED");
  });

  it("getCache throws DB_QUERY_FAILED instead of returning undefined (miss)", async () => {
    await breakConnection(adapter);
    const err = await expectElizaError(() => adapter.getCache("any-key"), "DB_QUERY_FAILED");
    // The typed error carries structured context, not a swallowed message.
    expect(err.context).toMatchObject({ table: "cache" });
    expect(err.cause).toBeDefined();
  });

  it("setCache throws DB_UPSERT_FAILED instead of returning false", async () => {
    await breakConnection(adapter);
    await expectElizaError(() => adapter.setCache("k", "v"), "DB_UPSERT_FAILED");
  });

  it("deleteCache throws DB_DELETE_FAILED instead of returning false", async () => {
    await breakConnection(adapter);
    await expectElizaError(() => adapter.deleteCache("k"), "DB_DELETE_FAILED");
  });

  it("deleteAgents throws DB_DELETE_FAILED instead of returning false", async () => {
    await breakConnection(adapter);
    await expectElizaError(() => adapter.deleteAgents([v4() as UUID]), "DB_DELETE_FAILED");
  });

  it("createEntities throws DB_INSERT_FAILED instead of returning []", async () => {
    const entity = { id: v4() as UUID, agentId: v4() as UUID, names: ["x"], metadata: {} };
    await breakConnection(adapter);
    await expectElizaError(() => adapter.createEntities([entity]), "DB_INSERT_FAILED");
  });

  it("updateMemory throws DB_UPDATE_FAILED instead of returning false", async () => {
    await breakConnection(adapter);
    await expectElizaError(
      () => adapter.updateMemory({ id: v4() as UUID, content: { text: "x" } }),
      "DB_UPDATE_FAILED"
    );
  });

  it("addParticipant throws DB_INSERT_FAILED instead of returning false", async () => {
    await breakConnection(adapter);
    await expectElizaError(
      () => adapter.addParticipant(v4() as UUID, v4() as UUID),
      "DB_INSERT_FAILED"
    );
  });

  it("createRelationship throws DB_INSERT_FAILED instead of returning false", async () => {
    await breakConnection(adapter);
    await expectElizaError(
      () =>
        adapter.createRelationship({
          sourceEntityId: v4() as UUID,
          targetEntityId: v4() as UUID,
        }),
      "DB_INSERT_FAILED"
    );
  });

  it("an API-style handler over the adapter surfaces a structured 5xx, not a fabricated 200/0", async () => {
    await breakConnection(adapter);

    // Minimal J1 boundary: the shape a route handler uses — call the adapter,
    // and on a thrown ElizaError produce a structured 500 body. A fabricated
    // default (0) would instead sail through as a 200 and hide the outage.
    const handler = async (): Promise<{ status: number; body: unknown }> => {
      try {
        const count = await adapter.countAgents();
        return { status: 200, body: { count } };
      } catch (error) {
        if (isElizaError(error)) {
          return {
            status: 500,
            body: { error: error.code, message: error.message },
          };
        }
        return { status: 500, body: { error: "UNCLASSIFIED" } };
      }
    };

    const res = await handler();
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: "DB_COUNT_FAILED" });
  });
});

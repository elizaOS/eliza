/**
 * Regression tests proving plugin-sql's `stringToUuid` is byte-for-byte the
 * canonical `@elizaos/core` implementation, not a fork. plugin-sql previously
 * shipped a local FNV-1a derivation that diverged from core's SHA-1 derivation
 * for every non-UUID input, so the RLS `server_id` production computes from
 * `ELIZA_SERVER_ID` differed from the id core derives for the same key — a
 * data-isolation hazard. These tests fail against the old FNV implementation
 * and pass once the utility is consolidated onto core. They exercise the pure
 * functions and the real `createDatabaseAdapter` RLS-id derivation path; no
 * live Postgres is required (pg's Pool connects lazily).
 */
import { stringToUuid as coreStringToUuid } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabaseAdapter } from "../../index.node.ts";
import { stringToUuid as sqlStringToUuid } from "../../utils/string-to-uuid.ts";

const GLOBAL_SINGLETONS = Symbol.for("elizaos.plugin-sql.global-singletons");

interface ManagerLike {
  close: () => Promise<void>;
}

function globalManagers(): Map<string, ManagerLike> | undefined {
  const store = (
    globalThis as Record<symbol, { postgresConnectionManagers?: Map<string, ManagerLike> }>
  )[GLOBAL_SINGLETONS];
  return store?.postgresConnectionManagers;
}

describe("plugin-sql stringToUuid canonical parity", () => {
  const cases: Array<string | number> = [
    "server-123",
    "advanced-memory:world:00000000-0000-0000-0000-000000000abc",
    "advanced-memory:long-term:agent:entity",
    "12345",
    12345,
    "",
    "550e8400-e29b-41d4-a716-446655440000",
  ];

  it("agrees with @elizaos/core across a table of natural keys", () => {
    for (const input of cases) {
      expect(sqlStringToUuid(input)).toBe(coreStringToUuid(input));
    }
  });

  it("passes an already-valid UUID through unchanged, matching core", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    expect(sqlStringToUuid(uuid)).toBe(uuid);
    expect(sqlStringToUuid(uuid)).toBe(coreStringToUuid(uuid));
  });

  it("produces the documented core SHA-1 UUID for a known key (not the old FNV value)", () => {
    // core SHA-1 derivation; the retired FNV impl produced 9460a9f3-... here.
    expect(sqlStringToUuid("server-123")).toBe("f569c7d7-11c9-01e8-bdd4-c6235a8a9af7");
  });

  it("throws TypeError on non-string, non-number input, like core", () => {
    // @ts-expect-error exercising the adversarial runtime path
    expect(() => sqlStringToUuid({})).toThrow(TypeError);
  });
});

describe("createDatabaseAdapter RLS server-id derivation", () => {
  const previousEnv = {
    ENABLE_DATA_ISOLATION: process.env.ENABLE_DATA_ISOLATION,
    ELIZA_SERVER_ID: process.env.ELIZA_SERVER_ID,
  };

  afterEach(async () => {
    process.env.ENABLE_DATA_ISOLATION = previousEnv.ENABLE_DATA_ISOLATION;
    process.env.ELIZA_SERVER_ID = previousEnv.ELIZA_SERVER_ID;
    const managers = globalManagers();
    if (managers) {
      for (const manager of managers.values()) {
        await manager.close().catch(() => undefined);
      }
      managers.clear();
    }
  });

  it("keys the RLS connection pool by core.stringToUuid(ELIZA_SERVER_ID)", () => {
    process.env.ENABLE_DATA_ISOLATION = "true";
    process.env.ELIZA_SERVER_ID = "parity-regression-server";
    const agentId = "00000000-0000-0000-0000-0000000000aa" as const;

    createDatabaseAdapter(
      { postgresUrl: "postgresql://eliza:eliza@127.0.0.1:1/eliza_parity" },
      agentId
    );

    const expectedRlsId = coreStringToUuid("parity-regression-server");
    const managers = globalManagers();
    expect(managers).toBeDefined();
    expect(managers?.has(expectedRlsId)).toBe(true);
  });
});

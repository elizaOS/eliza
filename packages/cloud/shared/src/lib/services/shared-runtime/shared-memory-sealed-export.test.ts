/**
 * Contract tests for the sealed Shared memory export (#20923 rebuild) against
 * REAL in-process PGlite: the walk runs inside one snapshot seam, the seal's
 * digest/counts are the manifest of the exact rows walked, scope derivation
 * matches the Shared turn-path writer, vectors export verbatim, and an
 * anomalous stored vector fails the export with a typed error instead of a
 * dropped-but-successful result.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";

import { stringToUuid } from "@elizaos/core/edge";
import { computeSharedMemoryTransferDigest } from "@elizaos/shared/contracts/shared-memory-transfer";
import { pushSchema } from "drizzle-kit/api";
import { sql } from "drizzle-orm";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../../db/client";
import { sharedAgentMemoriesWriter } from "../../../db/repositories/shared-agent-memories";
import { organizations } from "../../../db/schemas/organizations";
import { sharedAgentMemories } from "../../../db/schemas/shared-agent-memories";
import { users } from "../../../db/schemas/users";
import {
  exportSealedSharedMemories,
  sealedExportScopeForAgent,
} from "./shared-memory-sealed-export";

const PGLITE_TIMEOUT = 60_000;
let pgliteReady = true;

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "33333333-3333-4333-8333-333333333333";
const AGENT = { id: "personal:aaa", organization_id: ORG, user_id: USER };
const scope = sealedExportScopeForAgent(AGENT);
const ROOM = "77777777-7777-4777-8777-777777777777";

// PGlite has no multi-connection MVCC; the walk still exercises the real
// paged query through this pass-through snapshot seam.
const passThroughSnapshot = async <T>(fn: (tx: never) => Promise<T>): Promise<T> => {
  const { dbRead } = await import("../../../db/client");
  return fn(dbRead as never);
};

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    return;
  }
  try {
    await dbWrite.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
    const { apply } = await pushSchema(
      { organizations, users, sharedAgentMemories } as never,
      dbWrite as never,
    );
    await apply();
    await dbWrite
      .insert(organizations)
      .values([{ id: ORG, name: "Org", slug: "org" }])
      .onConflictDoNothing();
    await dbWrite
      .insert(users)
      .values([{ id: USER, organization_id: ORG, steward_user_id: "steward-u" }])
      .onConflictDoNothing();
  } catch (error) {
    pgliteReady = false;
    console.error("[sealed-export.test] PGlite setup failed", error);
  }
}, PGLITE_TIMEOUT);

beforeEach(async () => {
  expect(pgliteReady).toBe(true);
  await dbWrite.delete(sharedAgentMemories);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

async function seedRow(index: number, embedding?: number[]) {
  await sharedAgentMemoriesWriter.insertMemory({
    id: `cccccccc-cccc-4ccc-8ccc-${String(index).padStart(12, "0")}`,
    scope,
    entityId: USER,
    roomId: ROOM,
    type: "messages",
    content: { text: `m${index}` },
    ...(embedding ? { embedding, embeddingModel: "bge-small-en-v1.5" } : {}),
  });
}

describe("sealed shared memory export (real PGlite)", () => {
  test("scope derivation matches the turn-path writer", () => {
    expect(scope.agentId).toBe(stringToUuid("shared-todos:agent:personal:aaa"));
    expect(scope.organizationId).toBe(ORG);
    expect(scope.userId).toBe(USER);
  });

  test("the seal is the manifest of the walked rows, vectors verbatim", async () => {
    const precise = Array.from({ length: 384 }, (_, i) => 0.123456789 + i * 1e-9);
    await seedRow(0, precise);
    await seedRow(1);
    await seedRow(
      2,
      Array.from({ length: 384 }, () => 0.25),
    );

    const sealed = await exportSealedSharedMemories(AGENT, {
      withSnapshot: passThroughSnapshot as never,
    });

    expect(sealed.seal.row_count).toBe(3);
    expect(sealed.seal.embedding_count).toBe(2);
    expect(sealed.seal.source_agent_id).toBe(scope.agentId);
    expect(sealed.seal.digest).toBe(computeSharedMemoryTransferDigest(sealed.rows));
    expect(sealed.rows.map((row) => row.content)).toEqual([
      { text: "m0" },
      { text: "m1" },
      { text: "m2" },
    ]);
    // Verbatim relative to storage: the column is real[] (float4), so the
    // export carries the stored single-precision value with NO further
    // rounding (the removed importer-side toFixed(6) was coarser than this).
    expect(sealed.rows[0]?.embedding?.dim_384).toHaveLength(384);
    expect(sealed.rows[0]?.embedding?.dim_384?.[0]).toBeCloseTo(0.123456789, 7);
    // Pins the removed toFixed(6) coarsening: 6dp would have stored 0.123457.
    expect(sealed.rows[0]?.embedding?.dim_384?.[0]).not.toBe(0.123457);
    expect(sealed.rows[1]?.embedding).toBeUndefined();
  });

  test("rows outside the tenant scope are invisible", async () => {
    await seedRow(0);
    await sharedAgentMemoriesWriter.insertMemory({
      scope: { organizationId: ORG, userId: USER, agentId: stringToUuid("other-agent") },
      roomId: ROOM,
      type: "messages",
      content: { text: "other tenant agent" },
    });
    const sealed = await exportSealedSharedMemories(AGENT, {
      withSnapshot: passThroughSnapshot as never,
    });
    expect(sealed.seal.row_count).toBe(1);
  });

  test("an anomalous stored vector fails the export with a typed error", async () => {
    await seedRow(
      0,
      Array.from({ length: 768 }, () => 0.1),
    );
    await expect(
      exportSealedSharedMemories(AGENT, {
        withSnapshot: passThroughSnapshot as never,
      }),
    ).rejects.toMatchObject({ code: "SHARED_MEMORY_EXPORT_ANOMALOUS_VECTOR" });
  });

  test("an empty scope seals a zero manifest", async () => {
    const sealed = await exportSealedSharedMemories(AGENT, {
      withSnapshot: passThroughSnapshot as never,
    });
    expect(sealed.seal.row_count).toBe(0);
    expect(sealed.rows).toEqual([]);
    expect(sealed.seal.digest).toBe(computeSharedMemoryTransferDigest([]));
  });
});

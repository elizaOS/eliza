/**
 * Exercises the promotion-epoch state machine, the write fence, and the
 * fenced sealed export against real PGlite: concurrent opens racing on the
 * partial unique index, invalid transitions, double-promotion, fence
 * enforcement ahead of any store write, keyset pagination across equal
 * timestamps, and seal signature verification — the exact-head concurrency
 * evidence for the round-3 transfer (#21090 review).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const TIMEOUT = 60_000;
const ORG = "51000000-0000-4000-8000-000000000001";
const USER = "52000000-0000-4000-8000-000000000001";
const AGENT = "53000000-0000-4000-8000-000000000001";
const SCOPE = { organizationId: ORG, userId: USER, agentId: AGENT };
const KEY = "pglite-test-seal-key";

let epochs: typeof import("./shared-transfer-epochs");
let sealedExport: typeof import("../../lib/services/shared-runtime/shared-memory-sealed-export");
let contract: typeof import("@elizaos/shared/contracts/shared-memory-transfer");
let dbWrite: typeof import("../client").dbWrite;
let closeForTests: typeof import("../client").closeDatabaseConnectionsForTests | undefined;

beforeAll(async () => {
  const client = await import("../client");
  dbWrite = client.dbWrite;
  closeForTests = client.closeDatabaseConnectionsForTests;
  epochs = await import("./shared-transfer-epochs");
  sealedExport = await import("../../lib/services/shared-runtime/shared-memory-sealed-export");
  contract = await import("@elizaos/shared/contracts/shared-memory-transfer");
  await client.getPgliteClientForTests().exec(`
    CREATE TABLE organizations (id uuid PRIMARY KEY);
    CREATE TABLE users (id uuid PRIMARY KEY);
    CREATE TABLE shared_transfer_epochs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      agent_id uuid NOT NULL,
      epoch integer NOT NULL,
      state text NOT NULL,
      seal_digest text,
      fenced_at timestamp,
      resolved_at timestamp,
      created_at timestamp NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX uq_shared_transfer_epochs_scope_epoch
      ON shared_transfer_epochs (organization_id, user_id, agent_id, epoch);
    CREATE UNIQUE INDEX uq_shared_transfer_epochs_scope_active
      ON shared_transfer_epochs (organization_id, user_id, agent_id)
      WHERE state IN ('open','fenced');
    CREATE TABLE shared_agent_memories (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL,
      user_id uuid NOT NULL,
      agent_id uuid NOT NULL,
      entity_id uuid,
      room_id uuid,
      world_id uuid,
      type text NOT NULL,
      content jsonb NOT NULL,
      embedding real[],
      embedding_model text,
      created_at timestamp NOT NULL DEFAULT now()
    );
    INSERT INTO organizations (id) VALUES ('${ORG}');
    INSERT INTO users (id) VALUES ('${USER}');
  `);
}, TIMEOUT);

afterAll(async () => {
  await closeForTests?.();
});

async function resetEpochs() {
  await dbWrite.execute(sql`DELETE FROM shared_transfer_epochs`);
}

async function insertMemoryRow(i: number, createdAt: string) {
  const id = `61000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
  await dbWrite.execute(sql`
    INSERT INTO shared_agent_memories
      (id, organization_id, user_id, agent_id, type, content, embedding, created_at)
    VALUES (${id}, ${ORG}, ${USER}, ${AGENT}, 'messages',
      ${JSON.stringify({ text: `m${i}` })}::jsonb,
      ${`{0.1,0.2}`}::real[], ${createdAt}::timestamp)
  `);
  return id;
}

describe("epoch state machine (pglite)", () => {
  test(
    "open → fence → promote records digest and is terminal",
    async () => {
      await resetEpochs();
      const opened = await epochs.openEpoch(SCOPE);
      expect(opened.state).toBe("open");
      const fenced = await epochs.fenceEpoch(SCOPE, opened.epoch);
      expect(fenced.state).toBe("fenced");
      const promoted = await epochs.promoteEpoch(SCOPE, opened.epoch, "a".repeat(64));
      expect(promoted.state).toBe("promoted");
      expect(promoted.seal_digest).toBe("a".repeat(64));
      await expect(epochs.promoteEpoch(SCOPE, opened.epoch, "b".repeat(64))).rejects.toMatchObject({
        code: epochs.SHARED_TRANSFER_EPOCH_INVALID_STATE,
      });
    },
    TIMEOUT,
  );

  test(
    "concurrent opens race at the partial unique index — exactly one wins",
    async () => {
      await resetEpochs();
      const results = await Promise.allSettled([
        epochs.openEpoch(SCOPE),
        epochs.openEpoch(SCOPE),
        epochs.openEpoch(SCOPE),
      ]);
      const wins = results.filter((r) => r.status === "fulfilled");
      expect(wins).toHaveLength(1);
      for (const loss of results.filter((r) => r.status === "rejected")) {
        expect((loss as PromiseRejectedResult).reason?.code).toBe(
          epochs.SHARED_TRANSFER_EPOCH_CONFLICT,
        );
      }
    },
    TIMEOUT,
  );

  test(
    "promote requires fenced; fence requires open",
    async () => {
      await resetEpochs();
      const opened = await epochs.openEpoch(SCOPE);
      await expect(epochs.promoteEpoch(SCOPE, opened.epoch, "c".repeat(64))).rejects.toMatchObject({
        code: epochs.SHARED_TRANSFER_EPOCH_INVALID_STATE,
      });
      await epochs.fenceEpoch(SCOPE, opened.epoch);
      await expect(epochs.fenceEpoch(SCOPE, opened.epoch)).rejects.toMatchObject({
        code: epochs.SHARED_TRANSFER_EPOCH_INVALID_STATE,
      });
      await epochs.abortEpoch(SCOPE, opened.epoch);
    },
    TIMEOUT,
  );

  test(
    "write fence: open does not block, fenced does, abort lifts it",
    async () => {
      await resetEpochs();
      await epochs.assertScopeWritable(SCOPE);
      const opened = await epochs.openEpoch(SCOPE);
      await epochs.assertScopeWritable(SCOPE);
      await epochs.fenceEpoch(SCOPE, opened.epoch);
      await expect(epochs.assertScopeWritable(SCOPE)).rejects.toMatchObject({
        code: epochs.SHARED_TRANSFER_SCOPE_FENCED,
      });
      await epochs.abortEpoch(SCOPE, opened.epoch);
      await epochs.assertScopeWritable(SCOPE);
    },
    TIMEOUT,
  );
});

describe("fenced sealed export (pglite)", () => {
  test(
    "export refuses an unfenced scope",
    async () => {
      await resetEpochs();
      await expect(sealedExport.exportSealedSharedMemories(SCOPE, KEY)).rejects.toMatchObject({
        code: sealedExport.SHARED_MEMORY_EXPORT_NOT_FENCED,
      });
    },
    TIMEOUT,
  );

  test(
    "export paginates across equal timestamps without loss and seals verifiably",
    async () => {
      await resetEpochs();
      await dbWrite.execute(sql`DELETE FROM shared_agent_memories`);
      // 503 rows forces two keyset pages; a shared timestamp across the
      // boundary exercises the tuple-compare cursor.
      const SHARED_TS = "2026-08-17T12:00:00.000Z";
      for (let i = 0; i < 503; i++) {
        const ts =
          i < 490 ? new Date(Date.parse(SHARED_TS) - (503 - i) * 1000).toISOString() : SHARED_TS;
        await insertMemoryRow(i, ts);
      }
      const opened = await epochs.openEpoch(SCOPE);
      await epochs.fenceEpoch(SCOPE, opened.epoch);
      const out = await sealedExport.exportSealedSharedMemories(SCOPE, KEY);
      expect(out.rows).toHaveLength(503);
      expect(new Set(out.rows.map((r) => r.id)).size).toBe(503);
      expect(out.seal.row_count).toBe(503);
      expect(out.seal.epoch).toBe(opened.epoch);
      expect(out.seal.vector_dimension).toBe(2);
      expect(await contract.verifySealSignature(out.seal, KEY)).toBe(true);
      expect(await contract.verifySealSignature(out.seal, "wrong")).toBe(false);
      expect(await contract.computeSharedMemoryTransferDigest(out.rows)).toBe(out.seal.digest);
      await epochs.promoteEpoch(SCOPE, opened.epoch, out.seal.digest);
    },
    TIMEOUT,
  );
});

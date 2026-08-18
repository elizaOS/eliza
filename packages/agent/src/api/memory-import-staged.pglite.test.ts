/**
 * Destination rollback/replay proof against real PGlite: a finalize that
 * fails mid-transaction (embeddings insert) leaves ZERO visible memories and
 * keeps the staging rows; after the destination is repaired, replaying the
 * SAME finalize succeeds and conserves the sealed row count. This is the
 * atomic-publish property of the round-3 design demonstrated end to end.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import {
  computeSharedMemoryTransferDigest,
  type SealedMemoryExportRow,
  signSeal,
} from "@elizaos/shared/contracts/shared-memory-transfer";
import { drizzle } from "drizzle-orm/pglite";
import {
  finalizeSealedImport,
  stageSealedBatch,
} from "./memory-import-staged.ts";

const KEY = "pglite-dest-key";
const AGENT = "88000000-0000-4000-8000-000000000001";
const TIMEOUT = 60_000;

let db: ReturnType<typeof drizzle>;
let pg: PGlite;
let runtime: never;

function row(i: number): SealedMemoryExportRow {
  return {
    id: `87000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    type: "messages",
    created_at: new Date(1700000000000 + i * 1000).toISOString(),
    content: { text: `dest ${i}` },
    entity_id: null,
    agent_id: AGENT,
    room_id: "86000000-0000-4000-8000-000000000001",
    world_id: "85000000-0000-4000-8000-000000000001",
    unique: false,
    metadata: {},
    embedding: Array.from({ length: 384 }, (_, k) => ((i + k) % 5) / 5),
  };
}

async function sealFor(rows: SealedMemoryExportRow[]) {
  const digest = await computeSharedMemoryTransferDigest(rows);
  const body = {
    version: 3 as const,
    epoch: 7,
    source_agent_id: AGENT,
    scope: "org:user:agent",
    row_count: rows.length,
    digest,
    vector_dimension: 384,
    exported_at: new Date(1700000000000).toISOString(),
  };
  return { ...body, signature: await signSeal(body, KEY) };
}

async function count(table: string): Promise<number> {
  const r = await pg.query(`SELECT count(*)::int AS n FROM ${table}`);
  return (r.rows[0] as { n: number }).n;
}

beforeAll(async () => {
  pg = new PGlite({ extensions: { vector } });
  await pg.exec(`
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE TABLE memories (
      id uuid PRIMARY KEY,
      type text NOT NULL,
      created_at timestamptz NOT NULL,
      content jsonb NOT NULL,
      entity_id uuid,
      agent_id uuid NOT NULL,
      room_id uuid,
      world_id uuid,
      "unique" boolean NOT NULL,
      metadata jsonb NOT NULL
    );
    -- Deliberately BROKEN destination: no dim_384 column yet.
    CREATE TABLE embeddings (
      id uuid PRIMARY KEY,
      memory_id uuid NOT NULL REFERENCES memories(id),
      created_at timestamptz NOT NULL
    );
    CREATE TABLE worlds (id uuid PRIMARY KEY, agent_id uuid, name text, server_id text);
    CREATE TABLE rooms (id uuid PRIMARY KEY, agent_id uuid, world_id uuid, source text, type text);
    CREATE TABLE entities (id uuid PRIMARY KEY, agent_id uuid, names text[]);
    CREATE TABLE memory_import_staging (
      seal_digest text NOT NULL,
      row_id uuid NOT NULL,
      row_index integer NOT NULL,
      payload jsonb NOT NULL,
      staged_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (seal_digest, row_id)
    );
  `);
  db = drizzle(pg);
  runtime = {
    agentId: AGENT,
    db,
    getSetting: (name: string) =>
      name === "ELIZA_MEMORY_TRANSFER_SEAL_KEY" ? KEY : undefined,
  } as never;
}, TIMEOUT);

describe("destination rollback and replay (pglite)", () => {
  test(
    "failed finalize leaves zero visible rows; repaired replay conserves the seal",
    async () => {
      const rows = [row(1), row(2), row(3)];
      const seal = await sealFor(rows);
      const staged = await stageSealedBatch(runtime, {
        seal,
        batch_index: 0,
        batch_count: 1,
        rows,
      });
      expect(staged.total_staged).toBe(3);

      // Broken embeddings column → the publish transaction must roll back.
      await expect(
        finalizeSealedImport(runtime, { seal }),
      ).rejects.toBeDefined();
      expect(await count("memories")).toBe(0);
      expect(await count("worlds")).toBe(0);
      expect(await count("rooms")).toBe(0);
      expect(await count("memory_import_staging")).toBe(3);

      // Repair the destination, replay the SAME finalize.
      await pg.exec(`ALTER TABLE embeddings ADD COLUMN dim_384 vector(384)`);
      const replay = await finalizeSealedImport(runtime, { seal });
      expect(replay).toEqual({ published: 3, skipped_existing: 0 });
      expect(await count("memories")).toBe(3);
      expect(await count("embeddings")).toBe(3);
      expect(await count("memory_import_staging")).toBe(0);

      // A second replay after success is conserving, not duplicating: rows
      // are hash-identical so the (now unstaged) finalize fails on coverage.
      await expect(
        finalizeSealedImport(runtime, { seal }),
      ).rejects.toMatchObject({
        code: "MEMORY_IMPORT_STAGING_INCOMPLETE",
      });
      expect(await count("memories")).toBe(3);
    },
    TIMEOUT,
  );
});

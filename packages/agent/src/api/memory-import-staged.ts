/**
 * Staged Shared→Dedicated memory import with one atomic finalization
 * (round 3, #21090 review).
 *
 * Batches land in a dedicated staging table keyed by the seal digest; nothing
 * is visible to the runtime until `finalizeSealedImport` republishes the whole
 * set in ONE transaction that (1) re-verifies the ORIGINAL seal — signature
 * and order-sensitive digest recomputed from the staged rows themselves,
 * (2) negotiates the vector dimension against the core embeddings columns,
 * (3) creates missing room/world/entity scaffolding, inserts memories and
 * embeddings, and (4) drains the staging rows — so a failed finalize leaves
 * zero visible rows and a repeated finalize is a typed conflict, not a
 * duplicate publish.
 */
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import {
  computeSharedMemoryTransferDigest,
  type SealedExportSeal,
  type SealedMemoryExportRow,
  SealedMemoryFinalizeRequestSchema,
  type SealedMemoryStageRequest,
  SealedMemoryStageRequestSchema,
  verifySealSignature,
} from "@elizaos/shared/contracts/shared-memory-transfer";
import { sql } from "drizzle-orm";

export const MEMORY_IMPORT_SEAL_INVALID = "MEMORY_IMPORT_SEAL_INVALID";
export const MEMORY_IMPORT_BATCH_INVALID = "MEMORY_IMPORT_BATCH_INVALID";
export const MEMORY_IMPORT_STAGING_INCOMPLETE =
  "MEMORY_IMPORT_STAGING_INCOMPLETE";
export const MEMORY_IMPORT_DIGEST_MISMATCH = "MEMORY_IMPORT_DIGEST_MISMATCH";
export const MEMORY_IMPORT_DIMENSION_UNSUPPORTED =
  "MEMORY_IMPORT_DIMENSION_UNSUPPORTED";
export const MEMORY_IMPORT_ID_CONFLICT = "MEMORY_IMPORT_ID_CONFLICT";
export const MEMORY_IMPORT_DB_UNAVAILABLE = "MEMORY_IMPORT_DB_UNAVAILABLE";

/** Core embeddings columns by dimension (schemas/embedding.ts). */
const SUPPORTED_DIMENSION_COLUMNS: Record<number, string> = {
  384: "dim_384",
  512: "dim_512",
  768: "dim_768",
  1024: "dim_1024",
  1536: "dim_1536",
  3072: "dim_3072",
};

type Db = {
  transaction: <T>(fn: (tx: DbTx) => Promise<T>) => Promise<T>;
} & DbTx;
type DbTx = {
  execute: (q: unknown) => Promise<{ rows?: unknown[] } | unknown[]>;
};

function requireDb(runtime: IAgentRuntime): Db {
  const db = (runtime as { db?: unknown }).db;
  if (!db || typeof (db as Db).transaction !== "function") {
    throw new ElizaError("Runtime database is unavailable for memory import", {
      code: MEMORY_IMPORT_DB_UNAVAILABLE,
    });
  }
  return db as Db;
}

function rowsOf(result: { rows?: unknown[] } | unknown[]): unknown[] {
  return Array.isArray(result) ? result : (result.rows ?? []);
}

async function ensureStagingTable(db: DbTx): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS memory_import_staging (
      seal_digest text NOT NULL,
      row_id uuid NOT NULL,
      row_index integer NOT NULL,
      payload jsonb NOT NULL,
      staged_at timestamp NOT NULL DEFAULT now(),
      PRIMARY KEY (seal_digest, row_id)
    )
  `);
}

function sealKeyFromEnv(runtime: IAgentRuntime): string {
  const key = runtime.getSetting("ELIZA_MEMORY_TRANSFER_SEAL_KEY");
  if (typeof key !== "string" || key.length === 0) {
    throw new ElizaError("Memory transfer seal key is not configured", {
      code: MEMORY_IMPORT_SEAL_INVALID,
    });
  }
  return key;
}

async function assertSealTrusted(
  runtime: IAgentRuntime,
  seal: SealedExportSeal,
): Promise<void> {
  const ok = await verifySealSignature(seal, sealKeyFromEnv(runtime));
  if (!ok) {
    throw new ElizaError("Whole-export seal signature is invalid", {
      code: MEMORY_IMPORT_SEAL_INVALID,
    });
  }
}

/** Stage one batch. Rows become visible to nothing; replays are idempotent. */
export async function stageSealedBatch(
  runtime: IAgentRuntime,
  request: unknown,
): Promise<{ staged: number; total_staged: number }> {
  const parsed: SealedMemoryStageRequest =
    SealedMemoryStageRequestSchema.parse(request);
  await assertSealTrusted(runtime, parsed.seal);
  const expectedBatches = Math.max(1, Math.ceil(parsed.seal.row_count / 500));
  if (
    parsed.batch_count !== expectedBatches ||
    parsed.batch_index >= parsed.batch_count
  ) {
    throw new ElizaError(
      "Stage request batch geometry does not match the seal",
      {
        code: MEMORY_IMPORT_BATCH_INVALID,
        context: {
          batch_index: parsed.batch_index,
          batch_count: parsed.batch_count,
          expectedBatches,
        },
      },
    );
  }
  const db = requireDb(runtime);
  await ensureStagingTable(db);
  const base = parsed.batch_index * 500;
  for (const [i, row] of parsed.rows.entries()) {
    await db.execute(sql`
      INSERT INTO memory_import_staging (seal_digest, row_id, row_index, payload)
      VALUES (${parsed.seal.digest}, ${row.id}, ${base + i}, ${JSON.stringify(row)}::jsonb)
      ON CONFLICT (seal_digest, row_id) DO NOTHING
    `);
  }
  const counted = rowsOf(
    await db.execute(
      sql`SELECT count(*)::int AS n FROM memory_import_staging WHERE seal_digest = ${parsed.seal.digest}`,
    ),
  ) as Array<{ n: number }>;
  return { staged: parsed.rows.length, total_staged: counted[0]?.n ?? 0 };
}

/**
 * The ONE atomic publish/finalization step. Everything happens inside a
 * single transaction against the runtime database: seal re-verification from
 * the staged rows, dimension negotiation, scaffolding, row+vector publish,
 * and staging drain. Any thrown error rolls the whole step back.
 */
export async function finalizeSealedImport(
  runtime: IAgentRuntime,
  request: unknown,
): Promise<{ published: number; skipped_existing: number }> {
  const { seal } = SealedMemoryFinalizeRequestSchema.parse(request);
  await assertSealTrusted(runtime, seal);

  const dimensionColumn =
    seal.vector_dimension === null
      ? null
      : (SUPPORTED_DIMENSION_COLUMNS[seal.vector_dimension] ?? undefined);
  if (dimensionColumn === undefined) {
    throw new ElizaError("Export vector dimension has no destination column", {
      code: MEMORY_IMPORT_DIMENSION_UNSUPPORTED,
      context: { dimension: seal.vector_dimension },
    });
  }

  const db = requireDb(runtime);
  await ensureStagingTable(db);

  return db.transaction(async (tx) => {
    const staged = rowsOf(
      await tx.execute(sql`
        SELECT payload FROM memory_import_staging
        WHERE seal_digest = ${seal.digest}
        ORDER BY row_index ASC
        FOR UPDATE
      `),
    ) as Array<{ payload: SealedMemoryExportRow | string }>;
    const rows: SealedMemoryExportRow[] = staged.map((r) =>
      typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload,
    );

    if (rows.length !== seal.row_count) {
      throw new ElizaError("Staged rows do not cover the sealed export", {
        code: MEMORY_IMPORT_STAGING_INCOMPLETE,
        context: { staged: rows.length, sealed: seal.row_count },
      });
    }
    const digest = await computeSharedMemoryTransferDigest(rows);
    if (digest !== seal.digest) {
      throw new ElizaError(
        "Recomputed digest does not match the original seal",
        {
          code: MEMORY_IMPORT_DIGEST_MISMATCH,
        },
      );
    }

    // Conflict pre-check inside the same transaction: identical ids are
    // skipped, any differing row fails the WHOLE finalize.
    const ids = rows.map((r) => r.id);
    const existing =
      ids.length === 0
        ? []
        : (rowsOf(
            await tx.execute(sql`
              SELECT id::text AS id, content FROM memories
              WHERE id IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid)
            `),
          ) as Array<{ id: string; content: unknown }>);
    const existingById = new Map(existing.map((r) => [r.id, r]));
    let skipped = 0;
    const toPublish: SealedMemoryExportRow[] = [];
    for (const row of rows) {
      const found = existingById.get(row.id);
      if (!found) {
        toPublish.push(row);
        continue;
      }
      const same =
        JSON.stringify(found.content) === JSON.stringify(row.content);
      if (!same) {
        throw new ElizaError("A staged row conflicts with an existing memory", {
          code: MEMORY_IMPORT_ID_CONFLICT,
          context: { id: row.id },
        });
      }
      skipped += 1;
    }

    // Scaffolding: create-if-absent only, never overwrite target-native rows.
    const agentId = runtime.agentId;
    const worldIds = [
      ...new Set(toPublish.map((r) => r.world_id).filter(Boolean)),
    ] as string[];
    for (const worldId of worldIds) {
      await tx.execute(sql`
        INSERT INTO worlds (id, agent_id, name, server_id)
        VALUES (${worldId}, ${agentId}, 'Shared transfer', 'shared-transfer')
        ON CONFLICT (id) DO NOTHING
      `);
    }
    const roomPairs = [
      ...new Map(
        toPublish
          .filter((r) => r.room_id)
          .map((r) => [r.room_id as string, r.world_id]),
      ).entries(),
    ];
    for (const [roomId, worldId] of roomPairs) {
      await tx.execute(sql`
        INSERT INTO rooms (id, agent_id, world_id, source, type)
        VALUES (${roomId}, ${agentId}, ${worldId}, 'shared-transfer', 'DM')
        ON CONFLICT (id) DO NOTHING
      `);
    }
    const entityIds = [
      ...new Set(toPublish.map((r) => r.entity_id).filter(Boolean)),
    ] as string[];
    for (const entityId of entityIds) {
      await tx.execute(sql`
        INSERT INTO entities (id, agent_id, names)
        VALUES (${entityId}, ${agentId}, ARRAY['shared-transfer'])
        ON CONFLICT (id) DO NOTHING
      `);
    }

    for (const row of toPublish) {
      await tx.execute(sql`
        INSERT INTO memories (id, type, created_at, content, entity_id, agent_id, room_id, world_id, "unique", metadata)
        VALUES (
          ${row.id}, ${row.type}, ${row.created_at}::timestamptz,
          ${JSON.stringify(row.content)}::jsonb, ${row.entity_id},
          ${agentId}, ${row.room_id}, ${row.world_id}, ${row.unique},
          ${JSON.stringify({ ...row.metadata, source: "shared-runtime-transfer", transfer_epoch: seal.epoch })}::jsonb
        )
      `);
      if (row.embedding && dimensionColumn) {
        // pgvector literal: '[x,y,...]'::vector(D) (embeddings columns are
        // typed vector(D), not real[] — plugin-sql schema/embedding.ts).
        const vectorLiteral = `[${row.embedding.join(",")}]`;
        await tx.execute(sql`
          INSERT INTO embeddings (id, memory_id, created_at, ${sql.raw(`"${dimensionColumn}"`)})
          VALUES (gen_random_uuid(), ${row.id}, now(), ${vectorLiteral}::vector)
        `);
      }
    }

    await tx.execute(
      sql`DELETE FROM memory_import_staging WHERE seal_digest = ${seal.digest}`,
    );
    return { published: toPublish.length, skipped_existing: skipped };
  });
}

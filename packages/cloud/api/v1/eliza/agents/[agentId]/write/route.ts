/**
 * POST /api/v1/eliza/agents/[agentId]/write
 *
 * Service-to-service receiver for PGlite write-back batches. Local PGlite
 * applies writes first, then WriteBackService posts the same mutations here so
 * the cloud Postgres copy can converge and Electric can sync the confirmed
 * state back to clients.
 *
 * Auth: X-Service-Key header.
 */

import { and, eq, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { writeTransaction } from "@/db/helpers";
import {
  agentTable,
  entityTable,
  memoryTable,
  participantTable,
  relationshipTable,
  roomTable,
  taskTable,
  worldTable,
} from "@/db/schemas/eliza";
import {
  failureResponse,
  ValidationError,
} from "@/lib/api/cloud-worker-errors";
import { requireServiceKey } from "@/lib/auth/service-key-hono-worker";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const MAX_WRITES = 100;

const writeTableSchema = z.enum([
  "agents",
  "entities",
  "worlds",
  "rooms",
  "participants",
  "memories",
  "relationships",
  "tasks",
]);

const writeSchema = z.object({
  table: writeTableSchema,
  operation: z.enum(["insert", "upsert", "delete"]),
  row: z.record(z.string(), z.unknown()),
  writeId: z.string().min(1).max(256),
  retries: z.number().int().nonnegative().optional(),
});

const writeBackRequestSchema = z.object({
  writes: z.array(writeSchema).min(1).max(MAX_WRITES),
});

type WriteTable = z.infer<typeof writeTableSchema>;
type PendingWrite = z.infer<typeof writeSchema>;
type NormalizedWrite = Omit<PendingWrite, "row"> & {
  row: Record<string, unknown>;
};

type MutationChain = {
  returning: (columns?: unknown) => Promise<unknown[]>;
};

type WriteBackTransaction = {
  insert: (table: unknown) => {
    values: (row: Record<string, unknown>) => {
      onConflictDoNothing: () => Promise<unknown>;
    };
  };
  update: (table: unknown) => {
    set: (row: Record<string, unknown>) => {
      where: (condition: SQL) => MutationChain;
    };
  };
  delete: (table: unknown) => {
    where: (condition: SQL) => MutationChain;
  };
};

type TableConfig = {
  dbName: WriteTable;
  table: unknown;
  idColumn: unknown;
  agentColumn?: unknown;
  columns: ReadonlySet<string>;
};

const TABLES: Record<WriteTable, TableConfig> = {
  agents: {
    dbName: "agents",
    table: agentTable,
    idColumn: agentTable.id,
    columns: new Set([
      "id",
      "enabled",
      "server_id",
      "createdAt",
      "updatedAt",
      "name",
      "username",
      "system",
      "bio",
      "messageExamples",
      "postExamples",
      "topics",
      "adjectives",
      "knowledge",
      "plugins",
      "settings",
      "style",
    ]),
  },
  entities: {
    dbName: "entities",
    table: entityTable,
    idColumn: entityTable.id,
    agentColumn: entityTable.agentId,
    columns: new Set(["id", "agentId", "createdAt", "names", "metadata"]),
  },
  worlds: {
    dbName: "worlds",
    table: worldTable,
    idColumn: worldTable.id,
    agentColumn: worldTable.agentId,
    columns: new Set([
      "id",
      "agentId",
      "name",
      "metadata",
      "messageServerId",
      "createdAt",
    ]),
  },
  rooms: {
    dbName: "rooms",
    table: roomTable,
    idColumn: roomTable.id,
    agentColumn: roomTable.agentId,
    columns: new Set([
      "id",
      "agentId",
      "source",
      "type",
      "messageServerId",
      "worldId",
      "name",
      "metadata",
      "channelId",
      "createdAt",
    ]),
  },
  participants: {
    dbName: "participants",
    table: participantTable,
    idColumn: participantTable.id,
    agentColumn: participantTable.agentId,
    columns: new Set([
      "id",
      "createdAt",
      "entityId",
      "roomId",
      "agentId",
      "roomState",
    ]),
  },
  memories: {
    dbName: "memories",
    table: memoryTable,
    idColumn: memoryTable.id,
    agentColumn: memoryTable.agentId,
    columns: new Set([
      "id",
      "type",
      "createdAt",
      "content",
      "entityId",
      "agentId",
      "roomId",
      "worldId",
      "unique",
      "metadata",
    ]),
  },
  relationships: {
    dbName: "relationships",
    table: relationshipTable,
    idColumn: relationshipTable.id,
    agentColumn: relationshipTable.agentId,
    columns: new Set([
      "id",
      "createdAt",
      "sourceEntityId",
      "targetEntityId",
      "agentId",
      "tags",
      "metadata",
    ]),
  },
  tasks: {
    dbName: "tasks",
    table: taskTable,
    idColumn: taskTable.id,
    agentColumn: taskTable.agentId,
    columns: new Set([
      "id",
      "name",
      "description",
      "roomId",
      "worldId",
      "entityId",
      "agentId",
      "tags",
      "metadata",
      "createdAt",
      "updatedAt",
    ]),
  },
};

const FIELD_ALIASES: Record<string, string> = {
  agent_id: "agentId",
  channel_id: "channelId",
  created_at: "createdAt",
  entity_id: "entityId",
  message_examples: "messageExamples",
  message_server_id: "messageServerId",
  post_examples: "postExamples",
  room_id: "roomId",
  room_state: "roomState",
  serverId: "messageServerId",
  server_id: "server_id",
  source_entity_id: "sourceEntityId",
  target_entity_id: "targetEntityId",
  updated_at: "updatedAt",
  world_id: "worldId",
};

const DATE_FIELDS = new Set(["createdAt", "updatedAt"]);

function normalizeFieldKey(key: string, def: TableConfig): string {
  if (key === "server_id" && def.columns.has("messageServerId")) {
    return "messageServerId";
  }
  return FIELD_ALIASES[key] ?? key;
}

function eqColumn(column: unknown, value: unknown): SQL {
  return eq(column as never, value as never);
}

function agentScopedCondition(
  def: TableConfig,
  row: Record<string, unknown>,
  agentId: string,
): SQL {
  if (def.dbName === "participants" && !row.id && row.entityId && row.roomId) {
    return and(
      eqColumn(participantTable.entityId, row.entityId),
      eqColumn(participantTable.roomId, row.roomId),
      eqColumn(participantTable.agentId, agentId),
    ) as SQL;
  }

  if (typeof row.id !== "string" || !row.id) {
    throw ValidationError(`${def.dbName} write is missing row.id`);
  }

  const byId = eqColumn(def.idColumn, row.id);
  if (!def.agentColumn) return byId;
  return and(byId, eqColumn(def.agentColumn, agentId)) as SQL;
}

function normalizeDateField(value: unknown): unknown {
  if (value instanceof Date) return value;
  if (typeof value === "number" || typeof value === "bigint") {
    return new Date(Number(value));
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed;
  }
  return value;
}

function normalizeWriteRow(
  write: PendingWrite,
  agentId: string,
): NormalizedWrite {
  const def = TABLES[write.table];
  const row: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(write.row)) {
    const normalizedKey = normalizeFieldKey(key, def);
    if (!def.columns.has(normalizedKey)) continue;
    row[normalizedKey] = DATE_FIELDS.has(normalizedKey)
      ? normalizeDateField(value)
      : value;
  }

  if (def.dbName === "agents") {
    if (row.id !== agentId) {
      throw ValidationError(
        "Write-back agent id does not match route agent id",
      );
    }
  } else if (row.agentId === undefined || row.agentId === null) {
    row.agentId = agentId;
  } else if (row.agentId !== agentId) {
    throw ValidationError(
      "Write-back row agent id does not match route agent id",
    );
  }

  if (Object.keys(row).length === 0) {
    throw ValidationError(`${def.dbName} write has no recognized row fields`);
  }

  return { ...write, row };
}

function updateSet(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).filter(
      ([key, value]) => key !== "id" && value !== undefined,
    ),
  );
}

async function insertWrite(
  tx: WriteBackTransaction,
  def: TableConfig,
  row: Record<string, unknown>,
): Promise<void> {
  await tx.insert(def.table).values(row).onConflictDoNothing();
}

async function upsertWrite(
  tx: WriteBackTransaction,
  def: TableConfig,
  row: Record<string, unknown>,
  agentId: string,
): Promise<void> {
  const set = updateSet(row);
  if (Object.keys(set).length > 0) {
    const updated = await tx
      .update(def.table)
      .set(set)
      .where(agentScopedCondition(def, row, agentId))
      .returning({ id: def.idColumn });
    if (updated.length > 0) return;
  }

  await insertWrite(tx, def, row);
}

async function deleteWrite(
  tx: WriteBackTransaction,
  def: TableConfig,
  row: Record<string, unknown>,
  agentId: string,
): Promise<void> {
  await tx
    .delete(def.table)
    .where(agentScopedCondition(def, row, agentId))
    .returning({ id: def.idColumn });
}

async function applyWriteBackBatch(
  writes: NormalizedWrite[],
  agentId: string,
): Promise<void> {
  await writeTransaction(async (rawTx) => {
    const tx = rawTx as unknown as WriteBackTransaction;
    for (const write of writes) {
      const def = TABLES[write.table];
      if (write.operation === "insert") {
        await insertWrite(tx, def, write.row);
      } else if (write.operation === "upsert") {
        await upsertWrite(tx, def, write.row, agentId);
      } else {
        await deleteWrite(tx, def, write.row, agentId);
      }
    }
  });
}

async function __hono_POST(c: AppContext) {
  try {
    await requireServiceKey(c);
    const agentId = c.req.param("agentId") ?? "";
    const body = await c.req.json().catch(() => null);
    const parsed = writeBackRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: "Invalid write-back request",
          details: parsed.error.issues,
        },
        400,
      );
    }

    const writes = parsed.data.writes.map((write) =>
      normalizeWriteRow(write, agentId),
    );

    await applyWriteBackBatch(writes, agentId);

    logger.info("[pglite-write-back] Applied write batch", {
      agentId,
      writes: writes.length,
    });

    return c.json({
      success: true,
      applied: writes.length,
      results: writes.map((write) => ({
        writeId: write.writeId,
        table: write.table,
        operation: write.operation,
        success: true,
      })),
    });
  } catch (error) {
    return failureResponse(c, error);
  }
}

const app = new Hono<AppEnv>();
app.post("/", (c) => __hono_POST(c));

export default app;

export const __pgliteWriteBackTestHooks = {
  applyWriteBackBatch,
  normalizeWriteRow,
};

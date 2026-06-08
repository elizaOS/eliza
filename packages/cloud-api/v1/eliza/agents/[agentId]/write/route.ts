/**
 * POST /api/v1/eliza/agents/[agentId]/write
 *
 * Receives batched writes from agent write-back clients and inserts
 * them into the central Postgres. Each write targets a sync table
 * (agents, entities, worlds, rooms, participants, memories,
 * relationships, tasks) and is executed via drizzle-orm with
 * identifier-safe SQL.
 *
 * Auth: X-Service-Key. The service org must own the agent.
 */

import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { withWriteDb } from "@/db/client";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireServiceKey } from "@/lib/auth/service-key-hono-worker";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

// user_sessions is intentionally excluded — it is managed by the auth system
// (not the agent runtime) and is synced via `ended_at IS NULL` rather than
// `agent_id`, so agents never write to it.
const VALID_TABLES = new Set([
  "agents",
  "entities",
  "worlds",
  "rooms",
  "participants",
  "memories",
  "relationships",
  "tasks",
]);

const writeEntrySchema = z.object({
  table: z.string().refine((t) => VALID_TABLES.has(t), {
    message: "Invalid table — must be one of the synced tables",
  }),
  operation: z.enum(["insert", "upsert", "delete"]),
  row: z.record(z.string(), z.unknown()),
  writeId: z.string().min(1),
});

const writeRequestBodySchema = z.object({
  writes: z.array(writeEntrySchema).min(1).max(100),
});

/**
 * Build a parameterized SQL query using drizzle-orm's sql template tag.
 * Table and column names are wrapped in sql.identifier() for safety.
 */
function buildSQL(
  table: string,
  operation: "insert" | "upsert" | "delete",
  row: Record<string, unknown>,
): ReturnType<typeof sql> {
  const columns = Object.keys(row);
  if (columns.length === 0) throw new Error("Cannot write with zero columns");

  // Wrap identifiers so they're safe even if column names contain special chars.
  const idCols = columns.map((c) => sql.identifier(c));
  const idTable = sql.identifier(table);

  if (operation === "delete") {
    const idValue = row.id;
    if (idValue === undefined) throw new Error("DELETE requires an id column");
    return sql`DELETE FROM ${idTable} WHERE id = ${idValue}`;
  }

  const values = columns.map((c) => row[c]);
  const valueParams = values.map((v) => sql.param(v));

  if (operation === "upsert") {
    // For upsert, we need all columns except the ON CONFLICT clause.
    // We conflict on id, then update non-id columns.
    const setClauses: ReturnType<typeof sql>[] = [];
    for (let i = 0; i < columns.length; i++) {
      if (columns[i] !== "id") {
        setClauses.push(
          sql`${sql.identifier(columns[i])} = EXCLUDED.${sql.identifier(columns[i])}`,
        );
      }
    }
    if (setClauses.length === 0) {
      throw new Error("Upsert requires at least one non-id column to update");
    }
    return sql`INSERT INTO ${idTable} (${sql.join(idCols, sql`, `)}) VALUES (${sql.join(valueParams, sql`, `)}) ON CONFLICT (id) DO UPDATE SET ${sql.join(setClauses, sql`, `)}`;
  }

  // Plain insert
  return sql`INSERT INTO ${idTable} (${sql.join(idCols, sql`, `)}) VALUES (${sql.join(valueParams, sql`, `)}) ON CONFLICT DO NOTHING`;
}

async function __hono_POST(c: AppContext) {
  try {
    const identity = await requireServiceKey(c);
    const agentId = c.req.param("agentId") ?? "";
    const body = await c.req.json().catch(() => null);

    const parsed = writeRequestBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: "Invalid write request",
          details: parsed.error.issues,
        },
        400,
      );
    }

    const { writes } = parsed.data;

    // Agent must exist under the service org.
    const agent = await elizaSandboxService.getAgent(
      agentId,
      identity.organizationId,
    );
    if (!agent) {
      return c.json({ success: false, error: "Agent not found" }, 404);
    }

    const results: Array<{
      writeId: string;
      status: "ok" | "conflict" | "error";
      error?: string;
    }> = [];

    await withWriteDb(async (db) => {
      for (const write of writes) {
        try {
          const query = buildSQL(write.table, write.operation, write.row);
          await db.execute(query);
          results.push({ writeId: write.writeId, status: "ok" });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn("[agents/write] Write failed", {
            agentId,
            table: write.table,
            operation: write.operation,
            writeId: write.writeId,
            error: msg,
          });
          const isConflict =
            msg.includes("violates") ||
            msg.includes("duplicate") ||
            msg.includes("conflict");
          results.push({
            writeId: write.writeId,
            status: isConflict ? "conflict" : "error",
            error: isConflict ? undefined : msg,
          });
        }
      }
    });

    logger.info("[agents/write] Processed writes", {
      agentId,
      total: writes.length,
      ok: results.filter((r) => r.status === "ok").length,
      failed: results.filter((r) => r.status !== "ok").length,
    });

    return c.json({ success: true, results });
  } catch (error) {
    return failureResponse(c, error);
  }
}

const app = new Hono<AppEnv>();
app.post("/", (c) => __hono_POST(c));
export default app;

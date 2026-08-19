/** Adapts Drizzle schema statements to the locked raw migration session. */

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { AgentSandboxSchemaExecutor } from "./ensure-agent-sandbox-schema";

/** Executes one rendered, parameterized statement on the migration session. */
export type RawSqlQuery = (text: string, params: unknown[]) => Promise<unknown>;

/**
 * Keeps PostgreSQL rendering in the workspace that owns Drizzle while leaving
 * the Worker-facing schema guard free of the migration-only dialect.
 */
export function createMigrationClientSandboxExecutor(
  query: RawSqlQuery,
): AgentSandboxSchemaExecutor {
  const dialect = new PgDialect();
  return {
    execute: (statement: SQL) => {
      const rendered = dialect.sqlToQuery(statement);
      return query(rendered.sql, rendered.params);
    },
  };
}

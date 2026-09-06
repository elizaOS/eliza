/** Initializes new databases or verifies operator-managed identity schemas before the listener opens. */
import { ElizaError } from "@elizaos/core/errors";
import { createPostgresClient } from "./client";
import { runMigrations } from "./migrate";
import {
  assessMigrationLedger,
  getMigrationLedgerExpectation,
} from "./migration-status";

/** Preserves existing deployment mode names and their immutable migration ledgers. */
export async function initializeLoginSchema(): Promise<void> {
  const skip = process.env.SKIP_MIGRATIONS;
  if (skip !== undefined && !["0", "1", "false", "true"].includes(skip)) {
    throw new ElizaError("SKIP_MIGRATIONS must be 0, 1, false or true", {
      code: "LOGIN_MIGRATION_CONFIG_INVALID",
    });
  }
  const skipsMigrations = skip === "1" || skip === "true";
  const mode =
    process.env.STEWARD_MIGRATION_READINESS_MODE?.trim() || "drizzle";
  if (mode !== "drizzle" && mode !== "steward-owned") {
    throw new ElizaError(
      "STEWARD_MIGRATION_READINESS_MODE must be drizzle or steward-owned",
      {
        code: "LOGIN_MIGRATION_CONFIG_INVALID",
      },
    );
  }
  let ownedSchema: "public" | "steward" | undefined;
  if (mode === "steward-owned") {
    const schema = process.env.STEWARD_CORE_REPAIR_EXPECTED_SCHEMA;
    if (!skipsMigrations || (schema !== "public" && schema !== "steward")) {
      throw new ElizaError(
        "Operator-managed schemas require SKIP_MIGRATIONS=1 and STEWARD_CORE_REPAIR_EXPECTED_SCHEMA=public or steward",
        {
          code: "LOGIN_MIGRATION_CONFIG_INVALID",
        },
      );
    }
    ownedSchema = schema;
  }
  if (mode === "drizzle" && !skipsMigrations) await runMigrations();
  try {
    if (ownedSchema !== undefined) {
      const { inspectStewardReleaseReadiness } = await import(
        "./release-readiness"
      );
      await inspectStewardReleaseReadiness({ expectedSchema: ownedSchema });
      return;
    }
    const client = createPostgresClient();
    try {
      const rows = await client<{ hash: string; createdAt: string }[]>`
        SELECT hash, created_at AS "createdAt"
        FROM drizzle.__drizzle_migrations
        ORDER BY id ASC
      `;
      const readiness = assessMigrationLedger(
        rows,
        getMigrationLedgerExpectation().entries,
      );
      if (!readiness.ok) {
        throw new ElizaError(
          "Apply the owned login migrations before starting this service",
          {
            code: "LOGIN_SCHEMA_NOT_READY",
            context: readiness,
          },
        );
      }
    } finally {
      await client.end({ timeout: 5 });
    }
  } catch (cause) {
    // error-policy:J2 preserve the failed schema or ledger check for the startup boundary.
    throw new ElizaError(
      "The login database does not satisfy this release's schema contract",
      {
        code: "LOGIN_SCHEMA_NOT_READY",
        cause,
      },
    );
  }
}

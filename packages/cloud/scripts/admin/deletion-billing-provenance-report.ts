/** Read-only diagnostics for the historical authority guards in migration 0398. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { testOutputPath } from "../../../scripts/lib/test-output";
import {
  createRuntimePgClient,
  type IdentityQueryClient,
  readDatabaseIdentityReceipt,
} from "./preflight-database-identity";

export class DeletionBillingProvenanceReportError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "DeletionBillingProvenanceReportError";
  }
}

export function deletionBillingGuardQueries(migration: string): string[] {
  const body = migration.split("END $$;", 1)[0];
  const guards = [
    ...body.matchAll(
      /(?:WITH history AS|SELECT string_agg)[\s\S]*?;\n {2}IF unresolved/g,
    ),
  ].map(([query]) =>
    query
      .replace(/;\n {2}IF unresolved$/, ";")
      .replace(
        /string_agg\(id::text, ',' ORDER BY id\) INTO unresolved/g,
        "count(*)::integer AS unresolved_count",
      ),
  );
  if (
    guards.length !== 2 ||
    guards.some(
      (query) =>
        !query.includes("AS unresolved_count") ||
        query.includes("INTO unresolved"),
    )
  ) {
    throw new DeletionBillingProvenanceReportError(
      "migration_guard_contract_changed",
    );
  }
  return guards;
}

export async function readDeletionBillingProvenance(
  client: IdentityQueryClient,
  migration: string,
) {
  const queries = deletionBillingGuardQueries(migration);
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const identity = await readDatabaseIdentityReceipt(client, "staging");
    const counts: number[] = [];
    for (const query of queries) {
      const { rows } = await client.query(query);
      const row = rows[0];
      const count =
        row && typeof row === "object" && "unresolved_count" in row
          ? row.unresolved_count
          : undefined;
      if (
        rows.length !== 1 ||
        typeof count !== "number" ||
        !Number.isSafeInteger(count) ||
        count < 0
      ) {
        throw new DeletionBillingProvenanceReportError("invalid_guard_count");
      }
      counts.push(count);
    }
    return {
      schemaVersion: 1,
      kind: "deletion-billing-provenance",
      migrationSha256: createHash("sha256").update(migration).digest("hex"),
      databaseIdentity: identity,
      unresolvedContainerHistoryCount: counts[0],
      unresolvedAgentProvenanceCount: counts[1],
    };
  } finally {
    await client.query("ROLLBACK");
  }
}

if (import.meta.main) {
  let client: Awaited<ReturnType<typeof createRuntimePgClient>> | undefined;
  try {
    if (
      process.env.GITHUB_REF !== "refs/heads/staging" ||
      process.env.ELIZA_DELETION_BILLING_PROVENANCE_REPORT !== "1" ||
      !process.env.DATABASE_URL
    ) {
      throw new DeletionBillingProvenanceReportError(
        "protected_staging_report_required",
      );
    }
    const migration = await readFile(
      new URL(
        "../../shared/src/db/migrations/0398_provider_unconfirmed_deletion_billing.sql",
        import.meta.url,
      ),
      "utf8",
    );
    client = await createRuntimePgClient(process.env.DATABASE_URL);
    await client.connect();
    const receipt = await readDeletionBillingProvenance(client, migration);
    const json = `${JSON.stringify({ ...receipt, sourceSha: process.env.GITHUB_SHA })}\n`;
    const output = testOutputPath(
      "issue-review-cloud",
      "deletion-billing-provenance.json",
    );
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, json);
    process.stdout.write(json);
  } catch (error) {
    const code =
      error instanceof DeletionBillingProvenanceReportError
        ? error.code
        : "deletion_billing_provenance_report_failed";
    const { logger } = await import("@elizaos/cloud-shared/lib/utils/logger");
    logger.error("[deletion-billing-provenance] Report failed", { code });
    process.exitCode = 1;
  } finally {
    await client?.end();
  }
}

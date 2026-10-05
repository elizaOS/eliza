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
  constructor(
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(code, options);
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

interface DeletionBillingReportClient extends IdentityQueryClient {
  query(text: string, parameters?: unknown[]): Promise<{ rows: unknown[] }>;
}

const agentAuthorityFacts = {
  targetCount: "true",
  credentialOrganizationMatchCount:
    "EXISTS (SELECT 1 FROM fixture WHERE fixture.organization_id = a.organization_id)",
  credentialUserMatchCount:
    "EXISTS (SELECT 1 FROM fixture WHERE fixture.organization_id = a.organization_id AND fixture.user_id = a.user_id)",
  missingPreviousStatusCount: "a.deletion_previous_status IS NULL",
  missingPreviousBillingStatusCount:
    "a.deletion_previous_billing_status IS NULL",
  hasDeletionAttemptCount: "a.deletion_attempt_id IS NOT NULL",
  hasActiveDeleteJobCount:
    "EXISTS (SELECT 1 FROM jobs j WHERE j.organization_id = a.organization_id AND j.agent_id = a.id::text AND j.type = 'agent_delete' AND j.status IN ('pending', 'in_progress'))",
  hasCompletedDeleteJobCount:
    "EXISTS (SELECT 1 FROM jobs j WHERE j.organization_id = a.organization_id AND j.agent_id = a.id::text AND j.type = 'agent_delete' AND j.status = 'completed')",
  hasFailedDeleteJobCount:
    "EXISTS (SELECT 1 FROM jobs j WHERE j.organization_id = a.organization_id AND j.agent_id = a.id::text AND j.type = 'agent_delete' AND j.status = 'failed')",
  hasFundingCount:
    "EXISTS (SELECT 1 FROM agent_compute_funding f WHERE f.organization_id = a.organization_id AND f.agent_id = a.id)",
  hasProviderStoppedFundingReceiptCount:
    "EXISTS (SELECT 1 FROM agent_compute_funding f WHERE f.organization_id = a.organization_id AND f.agent_id = a.id AND f.provider_stopped_at IS NOT NULL AND f.provider_stop_receipt IS NOT NULL)",
  hasProviderConfirmedStopIntentCount:
    "EXISTS (SELECT 1 FROM agent_compute_stop_intents i WHERE i.organization_id = a.organization_id AND i.agent_id = a.id AND i.status = 'provider_confirmed' AND i.provider_confirmed_at IS NOT NULL)",
  hasDockerLocatorCount:
    "NULLIF(btrim(a.node_id), '') IS NOT NULL AND NULLIF(btrim(a.container_name), '') IS NOT NULL",
} as const;

function unresolvedAgentSelector(migration: string): string {
  const guard = deletionBillingGuardQueries(migration)[1];
  const prefix = "SELECT count(*)::integer AS unresolved_count";
  if (!guard.startsWith(prefix)) {
    throw new DeletionBillingProvenanceReportError(
      "migration_guard_contract_changed",
    );
  }
  return guard.replace(prefix, "SELECT a.*").replace(/;\s*$/, "");
}

/** Classify exact guarded subjects without IDs. Record presence does not authorize repair. */
async function readAgentAuthorityFacts(
  client: DeletionBillingReportClient,
  migration: string,
  fixtureApiKey: string,
) {
  const selector = unresolvedAgentSelector(migration);
  const hash = createHash("sha256").update(fixtureApiKey).digest("hex");
  const { rows } = await client.query(
    `
    WITH unresolved_agents AS (${selector}), fixture AS (
      SELECT k.organization_id, k.user_id FROM api_keys k
      JOIN users u ON u.id = k.user_id AND u.organization_id = k.organization_id
      WHERE k.key_hash = $1 AND k.is_active = true AND k.deleted_at IS NULL
        AND (k.expires_at IS NULL OR k.expires_at > CURRENT_TIMESTAMP)
        AND u.is_active = true AND u.deleted_at IS NULL
    )
    SELECT (SELECT count(*)::integer FROM fixture) AS fixture_count,
      ${Object.entries(agentAuthorityFacts)
        .map(
          ([key, predicate]) =>
            `count(*) FILTER (WHERE ${predicate})::integer AS "${key}"`,
        )
        .join(",\n      ")}
    FROM unresolved_agents a
  `,
    [hash],
  );
  const row = rows[0];
  if (
    rows.length !== 1 ||
    !row ||
    typeof row !== "object" ||
    !("fixture_count" in row) ||
    row.fixture_count !== 1
  ) {
    throw new DeletionBillingProvenanceReportError(
      "fixture_identity_unavailable",
    );
  }
  const facts = {} as Record<keyof typeof agentAuthorityFacts, number>;
  for (const key of Object.keys(agentAuthorityFacts) as Array<
    keyof typeof agentAuthorityFacts
  >) {
    const count = Reflect.get(row, key);
    if (
      typeof count !== "number" ||
      !Number.isSafeInteger(count) ||
      count < 0
    ) {
      throw new DeletionBillingProvenanceReportError(
        "invalid_guard_authority_count",
      );
    }
    facts[key] = count;
  }
  return facts;
}

/** Complete failed-job records stay private; observations never authorize a retry. */
export async function readGuardedFailedDeleteJobFacts(
  client: DeletionBillingReportClient,
  migration: string,
) {
  const [{ hydrateJob }, { isAgentDeleteJobData }] = await Promise.all([
    import("../../shared/src/db/repositories/jobs"),
    import("../../shared/src/lib/services/provisioning-job-policy"),
  ]);
  const selector = unresolvedAgentSelector(migration);
  let rows: Awaited<ReturnType<DeletionBillingReportClient["query"]>>["rows"];
  try {
    ({ rows } = await client.query(`
    WITH unresolved_agents AS (${selector})
    SELECT j.* FROM jobs j JOIN unresolved_agents a
      ON j.organization_id = a.organization_id AND j.agent_id = a.id::text
    WHERE j.type = 'agent_delete' AND j.status = 'failed'
    ORDER BY j.created_at, j.id
    `));
  } catch (cause) {
    throw new DeletionBillingProvenanceReportError("failed_job_query_failed", {
      cause,
    });
  }
  const facts = {
    scope: "migration_0398_unresolved_agents_failed_delete_jobs",
    status: "failed" as const,
    failedJobCount: rows.length,
    validDeleteJobDataCount: 0,
    tenantMetadataMatchCount: 0,
    completeStateLossAcknowledgementCount: 0,
    containerStoppedResultCount: 0,
    rowDeletedResultCount: 0,
    offloadedPayloadJobCount: 0,
    recordedErrorCount: 0,
    legacyDateFailureCount: 0,
  };
  for (const row of rows) {
    let job: import("../../shared/src/db/schemas/jobs").Job;
    try {
      job = await hydrateJob(
        row as import("../../shared/src/db/schemas/jobs").Job,
        { strict: true },
      );
    } catch (cause) {
      // error-policy:J2 missing offloaded authority cannot become an inline preview.
      throw new DeletionBillingProvenanceReportError(
        "failed_job_payload_unavailable",
        { cause },
      );
    }
    if (
      [job.data_storage, job.result_storage, job.error_storage].includes("r2")
    ) {
      facts.offloadedPayloadJobCount++;
    }
    if (isAgentDeleteJobData(job.data)) {
      facts.validDeleteJobDataCount++;
      // The provisioning worker binds a delete job to its agent, organization
      // and user; a payload naming another user is not this row's tenant.
      if (
        job.data.agentId === job.agent_id &&
        job.data.organizationId === job.organization_id &&
        job.data.userId === job.user_id
      ) {
        facts.tenantMetadataMatchCount++;
        // The canonical validator already checks complete actor/time provenance.
        // Legacy acknowledgement without provenance remains explicitly incomplete.
        if (
          job.data.stateLossAcknowledged === true &&
          typeof job.data.stateLossAcknowledgedByUserId === "string" &&
          typeof job.data.stateLossAcknowledgedAt === "string"
        ) {
          facts.completeStateLossAcknowledgementCount++;
        }
      }
    }
    if (
      job.result &&
      typeof job.result === "object" &&
      !Array.isArray(job.result) &&
      job.result.cloudAgentId === job.agent_id
    ) {
      if (job.result.containerStopped === true)
        facts.containerStoppedResultCount++;
      if (job.result.rowDeleted === true) facts.rowDeletedResultCount++;
    }
    if (typeof job.error === "string" && job.error.length > 0) {
      facts.recordedErrorCount++;
      // Classify the known historical failure over the complete private diagnostic.
      // This observed message alone is not a provider receipt or repair authority.
      if (
        /(?:^|\n)(?:TypeError: )?value\.toISOString is not a function(?:\n|$)/.test(
          job.error,
        )
      ) {
        facts.legacyDateFailureCount++;
      }
    }
  }
  return facts;
}

export async function readDeletionBillingProvenance(
  client: DeletionBillingReportClient,
  migration: string,
  options?: { fixtureApiKey: string; includeFailedJobs?: boolean },
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
      ...(options
        ? {
            agentAuthorityFacts: await readAgentAuthorityFacts(
              client,
              migration,
              options.fixtureApiKey,
            ),
          }
        : {}),
      ...(options?.includeFailedJobs
        ? {
            failedDeleteJobFacts: await readGuardedFailedDeleteJobFacts(
              client,
              migration,
            ),
          }
        : {}),
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
    const includeFailedJobs =
      process.env.ELIZA_DELETION_FAILED_JOB_REPORT === "1";
    const includeAuthority =
      process.env.ELIZA_DELETION_BILLING_AUTHORITY_REPORT === "1" ||
      includeFailedJobs;
    const fixtureApiKey = process.env.ELIZAOS_CLOUD_API_KEY;
    if (includeAuthority && !fixtureApiKey) {
      throw new DeletionBillingProvenanceReportError(
        "fixture_identity_required",
      );
    }
    const receipt = await readDeletionBillingProvenance(
      client,
      migration,
      includeAuthority && fixtureApiKey
        ? { fixtureApiKey, includeFailedJobs }
        : undefined,
    );
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

/** Production grant admission and explicit unused-code repair. Raw database errors stay private. */
import {
  type IdentityQueryClient,
  readDatabaseIdentityReceipt,
} from "./database-identity-receipt";

export async function admitProductionTestGrant(client: IdentityQueryClient) {
  const env = process.env;
  const cluster = env.DATABASE_IDENTITY_EXPECTED_CLUSTER_SHA256;
  const authority = env.DATABASE_IDENTITY_EXPECTED_AUTHORITY_SHA256;
  if (
    env.ELIZA_OPERATOR_ENVIRONMENT !== "production" ||
    env.GITHUB_REF !== "refs/heads/main" ||
    !/^[a-f0-9]{64}$/.test(cluster ?? "") ||
    !/^[a-f0-9]{64}$/.test(authority ?? "")
  ) {
    throw new Error("production_grant_authority_required");
  }
  const receipt = await readDatabaseIdentityReceipt(client, "production");
  if (
    receipt.clusterSha256 !== cluster ||
    receipt.authoritySha256 !== authority
  ) {
    throw new Error("production_grant_identity_mismatch");
  }
  const result =
    await client.query(`SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'subscription_grant_codes'
    AND column_name IN ('duration_months', 'requires_no_paid_plan')`);
  const columns = new Map(
    result.rows.map((row) => {
      const value = row as { column_name: string; data_type: string };
      return [value.column_name, value.data_type];
    }),
  );
  if (
    columns.get("duration_months") !== "integer" ||
    columns.get("requires_no_paid_plan") !== "boolean"
  ) {
    throw new Error("production_grant_schema_0547_required");
  }
  return { identityMatched: true, calendarGrantColumnsPresent: true };
}

/** Give one unused operator-issued code its own campaign without minting another code. */
export async function repairUnusedProductionTestGrant(
  client: IdentityQueryClient,
  issuedRunId: string,
) {
  if (!/^[1-9][0-9]{5,19}$/.test(issuedRunId)) {
    throw new Error("production_grant_run_id_required");
  }
  const label = `production-test-${issuedRunId}`;
  const family = `production_qa_${issuedRunId}`;
  await client.query("BEGIN");
  try {
    await admitProductionTestGrant(client);
    const result = await client.query(`SELECT code.id, code.family,
      (code.plan_key = 'plus_monthly' AND code.catalog_version = 'v1'
       AND code.duration_days = 1 AND code.duration_months IS NULL
       AND code.requires_no_paid_plan AND code.max_redemptions = 1
       AND code.redeemed_count = 0 AND code.disabled_at IS NULL
       AND code.expires_at > clock_timestamp()
       AND NOT EXISTS (SELECT 1 FROM subscription_grants AS grant_row
                       WHERE grant_row.code_id = code.id)) AS eligible
      FROM subscription_grant_codes AS code
      WHERE code.label = '${label}' FOR UPDATE`);
    const row = result.rows[0] as
      | { id?: unknown; family?: unknown; eligible?: unknown }
      | undefined;
    if (
      result.rows.length !== 1 ||
      !row ||
      typeof row.id !== "string" ||
      !/^[0-9a-f-]{36}$/.test(row.id) ||
      row.eligible !== true ||
      (row.family !== "production_qa" && row.family !== family)
    ) {
      throw new Error("production_grant_unused_code_required");
    }
    const replayed = row.family === family;
    if (!replayed) {
      const updated = await client.query(
        `UPDATE subscription_grant_codes SET family = '${family}'
         WHERE id = '${row.id}' AND family = 'production_qa' RETURNING id`,
      );
      if (updated.rows.length !== 1) {
        throw new Error("production_grant_update_conflict");
      }
    }
    await client.query("COMMIT");
    return { codeId: row.id, family, replayed, minted: 0 };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

if (import.meta.main) {
  let client:
    | import("./preflight-database-identity").RuntimePgClient
    | undefined;
  try {
    const { createRuntimePgClient } = await import(
      "./preflight-database-identity"
    );
    if (!process.env.DATABASE_URL)
      throw new Error("production_grant_database_required");
    client = await createRuntimePgClient(process.env.DATABASE_URL);
    client.on("error", () => {
      process.exitCode = 1;
    });
    await client.connect();
    const issuedRunId = process.env.ELIZA_PRODUCTION_TEST_GRANT_REPAIR_RUN;
    console.log(
      JSON.stringify(
        issuedRunId
          ? await repairUnusedProductionTestGrant(client, issuedRunId)
          : await admitProductionTestGrant(client),
      ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    console.error(
      /^production_grant_[a-z0-9_]+$/.test(message)
        ? message
        : "production_grant_diagnostic_failed",
    );
    process.exitCode = 1;
  } finally {
    try {
      await client?.end();
    } catch {
      console.error("production_grant_connection_close_failed");
      process.exitCode = 1;
    }
  }
}

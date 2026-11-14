/** Read-only production grant admission. Raw database errors never leave this CLI. */
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
    console.log(JSON.stringify(await admitProductionTestGrant(client)));
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

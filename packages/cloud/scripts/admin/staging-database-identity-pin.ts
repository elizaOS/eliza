/**
 * Pinned identity of the staging Cloud database, for one-off staging-only
 * operator scripts that write rows (the 0398 row repair and grant-code minting).
 *
 * The values are the redacted receipts that the protected database identity
 * staging report emitted for the database behind the GitHub `staging`
 * Environment's DATABASE_URL (run 38207303894). They hash the cluster system
 * identifier, role and database name, so they reveal no host or credential, and
 * any other database (production included) yields different receipts. If the
 * staging database is ever replaced, re-run that report and update both values
 * in a reviewed change.
 */
import {
  type IdentityQueryClient,
  readDatabaseIdentityReceipt,
} from "./database-identity-receipt";

export const STAGING_DATABASE_IDENTITY = {
  clusterSha256:
    "c8774ebdc92fd398b70f362a063ebef7195375718460a9caebf6b7d199b599ca",
  authoritySha256:
    "f75f562e0a09d4b60f454c24ce34162e5399974d50215b89d1de681d36749c93",
} as const;

export class StagingDatabaseIdentityError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "StagingDatabaseIdentityError";
  }
}

/**
 * Throws unless the session behind `client` is the pinned staging database.
 * Call it on the same client (and inside the same transaction) that writes.
 */
export async function assertStagingDatabaseIdentity(
  client: IdentityQueryClient,
  expected: {
    clusterSha256: string;
    authoritySha256: string;
  } = STAGING_DATABASE_IDENTITY,
): Promise<void> {
  const receipt = await readDatabaseIdentityReceipt(client, "staging");
  if (
    receipt.clusterSha256 !== expected.clusterSha256 ||
    receipt.authoritySha256 !== expected.authoritySha256
  ) {
    throw new StagingDatabaseIdentityError(
      "staging_database_identity_mismatch",
    );
  }
}

/**
 * Environment admission shared by the staging-only scripts: the GitHub
 * Environment must be staging and the workflow must run from the staging ref.
 */
export function assertStagingOperatorEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (
    environment.ELIZA_OPERATOR_ENVIRONMENT !== "staging" ||
    environment.GITHUB_REF !== "refs/heads/staging"
  ) {
    throw new StagingDatabaseIdentityError(
      "staging_operator_environment_required",
    );
  }
}

/** CLI: admit the staging operator environment and check the pinned identity. */
if (import.meta.main) {
  let client:
    | Awaited<
        ReturnType<
          typeof import("./preflight-database-identity").createRuntimePgClient
        >
      >
    | undefined;
  try {
    assertStagingOperatorEnvironment();
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new StagingDatabaseIdentityError("database_url_required");
    }
    const { createRuntimePgClient } = await import(
      "./preflight-database-identity"
    );
    client = await createRuntimePgClient(databaseUrl);
    client.on("error", () => {
      process.exitCode = 1;
    });
    await client.connect();
    await assertStagingDatabaseIdentity(client);
    process.stdout.write("[staging-database-identity] pinned identity match\n");
  } catch (error) {
    process.stderr.write(
      `[staging-database-identity] refused: ${
        error instanceof StagingDatabaseIdentityError
          ? error.code
          : "identity_check_failed"
      }\n`,
    );
    process.exitCode = 1;
  } finally {
    await client?.end();
  }
}

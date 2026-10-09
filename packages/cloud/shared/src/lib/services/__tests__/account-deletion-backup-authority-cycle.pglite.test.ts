/** Runs the always-on account-deletion backup authority cycle against real PGlite: a missing schema yields a value-free stage diagnostic, and the migrated schema completes the cycle. Object stores are configured but never reached because no deletion request is runnable. */

import { afterAll, beforeAll, expect, test } from "bun:test";

const ambientDatabaseUrl = process.env.DATABASE_URL ?? "";
if (ambientDatabaseUrl && !ambientDatabaseUrl.startsWith("pglite")) {
  throw new Error(
    "account-deletion-backup-authority-cycle.pglite.test requires an isolated PGlite DATABASE_URL",
  );
}
process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { accountDeletionPhaseReceipts } from "../../../db/schemas/account-deletion-phase-receipts";
import { accountDeletionRequests } from "../../../db/schemas/account-deletion-requests";
import {
  AgentBackupCatalogCycleStageError,
  agentBackupCatalogCycleFailureDiagnostic,
  createAgentBackupCatalogWorkerComposition,
} from "../agent-backup-catalog-worker-composition";

// Sentinels stand in for the protected staging values. The composition only
// validates this env; the shared DB client connects to the PGlite URL above.
const SECRET_SENTINELS = {
  databasePassword: "db-password-sentinel",
  databaseHost: "db-host-sentinel.example.test",
  masterKey: "b".repeat(64),
  r2Bucket: "r2-bucket-sentinel",
  r2Endpoint: "https://r2-endpoint-sentinel.example.test",
  r2AccessKey: "r2-access-sentinel",
  r2Secret: "r2-secret-sentinel",
  hetznerBucket: "hetzner-bucket-sentinel",
  hetznerEndpoint: "https://hetzner-endpoint-sentinel.example.test",
  hetznerAccessKey: "hetzner-access-sentinel",
  hetznerSecret: "hetzner-secret-sentinel",
} as const;

let spoolRoot = "";
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests;
let pushSchemaToTestDb: typeof import("../../../db/push-schema-for-tests").pushSchemaToTestDb;

function deletionAuthorityEnv(): NodeJS.ProcessEnv {
  return {
    ACCOUNT_DELETION_BACKUP_AUTHORITY_ENABLED: "1",
    AGENT_BACKUP_CATALOG_RUNTIME_ENABLED: "0",
    AGENT_BACKUP_RPO_SCHEDULER_ENABLED: "0",
    DATABASE_URL: `postgresql://backup:${SECRET_SENTINELS.databasePassword}@${SECRET_SENTINELS.databaseHost}/eliza`,
    SECRETS_MASTER_KEY: SECRET_SENTINELS.masterKey,
    AGENT_BACKUP_R2_ENDPOINT_ALIAS: "r2-primary",
    AGENT_BACKUP_R2_ACCOUNT_ID: "r2-account",
    AGENT_BACKUP_R2_ENDPOINT: SECRET_SENTINELS.r2Endpoint,
    AGENT_BACKUP_R2_BUCKET: SECRET_SENTINELS.r2Bucket,
    AGENT_BACKUP_R2_REGION: "auto",
    AGENT_BACKUP_R2_ACCESS_KEY_ID: SECRET_SENTINELS.r2AccessKey,
    AGENT_BACKUP_R2_SECRET_ACCESS_KEY: SECRET_SENTINELS.r2Secret,
    AGENT_BACKUP_HETZNER_ENDPOINT_ALIAS: "hetzner-secondary",
    AGENT_BACKUP_HETZNER_ACCOUNT_ID: "hetzner-account",
    AGENT_BACKUP_HETZNER_ENDPOINT: SECRET_SENTINELS.hetznerEndpoint,
    AGENT_BACKUP_HETZNER_BUCKET: SECRET_SENTINELS.hetznerBucket,
    AGENT_BACKUP_HETZNER_REGION: "fsn1",
    AGENT_BACKUP_HETZNER_ACCESS_KEY_ID: SECRET_SENTINELS.hetznerAccessKey,
    AGENT_BACKUP_HETZNER_SECRET_ACCESS_KEY: SECRET_SENTINELS.hetznerSecret,
    AGENT_BACKUP_SPOOL_STATE_DIRECTORY: path.join(spoolRoot, "spool"),
    AGENT_BACKUP_SPOOL_MAX_BYTES: String(8 * 1024 ** 3),
    AGENT_BACKUP_SPOOL_MIN_FREE_BYTES: String(1024 ** 3),
  };
}

beforeAll(async () => {
  spoolRoot = await mkdtemp(path.join(tmpdir(), "deletion-authority-cycle-"));
  ({ closeDatabaseConnectionsForTests: closeDb } = await import("../../../db/client"));
  ({ pushSchemaToTestDb } = await import("../../../db/push-schema-for-tests"));
});

afterAll(async () => {
  await closeDb();
  await rm(spoolRoot, { recursive: true, force: true });
});

test("first deletion-authority cycle reports a value-free stage diagnostic, then completes on the real schema", async () => {
  const composition = await createAgentBackupCatalogWorkerComposition({
    env: deletionAuthorityEnv(),
  });
  expect(composition.enabled).toBe(true);
  expect(composition.accountDeletionAuthorities).toBeDefined();

  // No deletion schema: the authority's first real query must fail closed.
  let failure: unknown;
  try {
    await composition.runCycle();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(AgentBackupCatalogCycleStageError);
  const diagnostic = agentBackupCatalogCycleFailureDiagnostic(failure);
  expect(diagnostic.stage).toBe("account-deletion-authority");
  expect(diagnostic.errorClasses[0]).toBe("AgentBackupCatalogCycleStageError");
  expect(diagnostic.errorClasses).toContain("DrizzleQueryError");
  // PostgreSQL undefined_table.
  expect(diagnostic.codes).toContain("42P01");
  expect(diagnostic.httpStatus).toBeNull();

  const serialized = JSON.stringify(diagnostic);
  for (const sentinel of Object.values(SECRET_SENTINELS)) {
    expect(serialized).not.toContain(sentinel);
  }
  // The wrapped DrizzleQueryError message carries SQL text; none may leak.
  expect(serialized).not.toContain("account_deletion");
  expect(serialized.toLowerCase()).not.toContain("select");
  expect(serialized).not.toContain("pglite");

  // Once the migrated deletion schema exists, the same composition completes.
  await pushSchemaToTestDb({ accountDeletionRequests, accountDeletionPhaseReceipts });
  const summary = await composition.runCycle();
  expect(summary.enabled).toBe(true);
  expect(summary.alertCodes).toEqual([]);
}, 120_000);

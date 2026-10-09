/** Runs the real backup-catalog daemon once over the real deletion-authority composition and PGlite, proving a failed first cycle stays fail-closed and logs only a value-free stage diagnostic. */

import { afterAll, beforeAll, expect, test } from "bun:test";

const ambientDatabaseUrl = process.env.DATABASE_URL ?? "";
if (ambientDatabaseUrl && !ambientDatabaseUrl.startsWith("pglite")) {
  throw new Error(
    "backup-catalog-worker.pglite.test requires an isolated PGlite DATABASE_URL",
  );
}
process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgentBackupCatalogWorkerComposition } from "@elizaos/cloud-shared/lib/services/agent-backup-catalog-worker-composition";
import {
  type BackupCatalogWorkerHealth,
  runBackupCatalogWorker,
} from "./backup-catalog-worker";

const SECRET_SENTINELS = [
  "db-password-sentinel",
  "db-host-sentinel.example.test",
  "c".repeat(64),
  "r2-bucket-sentinel",
  "r2-endpoint-sentinel.example.test",
  "r2-access-sentinel",
  "r2-secret-sentinel",
  "hetzner-bucket-sentinel",
  "hetzner-endpoint-sentinel.example.test",
  "hetzner-access-sentinel",
  "hetzner-secret-sentinel",
] as const;

let root = "";
let closeDb: typeof import("@elizaos/cloud-shared/db/client").closeDatabaseConnectionsForTests;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "backup-catalog-daemon-"));
  ({ closeDatabaseConnectionsForTests: closeDb } = await import(
    "@elizaos/cloud-shared/db/client"
  ));
});

afterAll(async () => {
  await closeDb();
  await rm(root, { recursive: true, force: true });
});

test("a failed first deletion-authority cycle retries with a closed stage diagnostic and no secrets", async () => {
  // Composition env carries the protected settings; the shared DB client uses
  // the isolated PGlite URL above, whose empty schema fails the first query.
  const env: NodeJS.ProcessEnv = {
    ACCOUNT_DELETION_BACKUP_AUTHORITY_ENABLED: "1",
    AGENT_BACKUP_CATALOG_RUNTIME_ENABLED: "0",
    AGENT_BACKUP_RPO_SCHEDULER_ENABLED: "0",
    AGENT_BACKUP_CATALOG_WORKER_HEALTH_FILE: path.join(root, "health.json"),
    DATABASE_URL:
      "postgresql://backup:db-password-sentinel@db-host-sentinel.example.test/eliza",
    SECRETS_MASTER_KEY: "c".repeat(64),
    AGENT_BACKUP_R2_ENDPOINT_ALIAS: "r2-primary",
    AGENT_BACKUP_R2_ACCOUNT_ID: "r2-account",
    AGENT_BACKUP_R2_ENDPOINT: "https://r2-endpoint-sentinel.example.test",
    AGENT_BACKUP_R2_BUCKET: "r2-bucket-sentinel",
    AGENT_BACKUP_R2_REGION: "auto",
    AGENT_BACKUP_R2_ACCESS_KEY_ID: "r2-access-sentinel",
    AGENT_BACKUP_R2_SECRET_ACCESS_KEY: "r2-secret-sentinel",
    AGENT_BACKUP_HETZNER_ENDPOINT_ALIAS: "hetzner-secondary",
    AGENT_BACKUP_HETZNER_ACCOUNT_ID: "hetzner-account",
    AGENT_BACKUP_HETZNER_ENDPOINT:
      "https://hetzner-endpoint-sentinel.example.test",
    AGENT_BACKUP_HETZNER_BUCKET: "hetzner-bucket-sentinel",
    AGENT_BACKUP_HETZNER_REGION: "fsn1",
    AGENT_BACKUP_HETZNER_ACCESS_KEY_ID: "hetzner-access-sentinel",
    AGENT_BACKUP_HETZNER_SECRET_ACCESS_KEY: "hetzner-secret-sentinel",
    AGENT_BACKUP_SPOOL_STATE_DIRECTORY: path.join(root, "spool"),
    AGENT_BACKUP_SPOOL_MAX_BYTES: String(8 * 1024 ** 3),
    AGENT_BACKUP_SPOOL_MIN_FREE_BYTES: String(1024 ** 3),
  };
  const logs: { level: string; message: string; context: unknown }[] = [];
  const record =
    (level: string) =>
    (message: string, context?: unknown): void => {
      logs.push({ level, message, context });
    };
  const healthSnapshots: BackupCatalogWorkerHealth[] = [];

  const result = await runBackupCatalogWorker({
    env,
    argv: ["--once"],
    signal: new AbortController().signal,
    dependencies: {
      createComposition: ({ env: compositionEnv }) =>
        createAgentBackupCatalogWorkerComposition({ env: compositionEnv }),
      async writeHealth(_filePath, health) {
        healthSnapshots.push(structuredClone(health));
      },
      async sleep() {},
      now: Date.now,
      logger: {
        info: record("info"),
        warn: record("warn"),
        error: record("error"),
      } as never,
    },
  });

  expect(result).toMatchObject({
    state: "retryable-failure",
    exitCode: 1,
    cycles: 0,
    failures: 1,
  });
  const retry = logs.find(
    (entry) => entry.message === "[backup-catalog-worker] cycle will retry",
  );
  if (!retry) throw new Error("daemon did not log the cycle retry");
  expect(retry.level).toBe("warn");
  expect(retry.context).toMatchObject({
    code: "AGENT_BACKUP_CATALOG_CYCLE_FAILED",
    failures: 1,
    diagnostic: {
      stage: "account-deletion-authority",
      httpStatus: null,
    },
  });
  const diagnostic = (
    retry.context as {
      diagnostic: { errorClasses: string[]; codes: string[] };
    }
  ).diagnostic;
  expect(diagnostic.errorClasses).toContain("DrizzleQueryError");
  expect(diagnostic.codes).toContain("42P01");
  expect(healthSnapshots.at(-1)?.state).toBe("retryable-failure");
  expect(healthSnapshots.at(-1)?.lastAlertCodes).toEqual([
    "AGENT_BACKUP_CATALOG_CYCLE_FAILED",
  ]);

  const emitted = JSON.stringify({ logs, healthSnapshots });
  for (const sentinel of SECRET_SENTINELS) {
    expect(emitted).not.toContain(sentinel);
  }
  expect(emitted).not.toContain("account_deletion_requests");
  expect(emitted).not.toContain("pglite");
}, 120_000);

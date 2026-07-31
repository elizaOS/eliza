/**
 * Verifies the schema preflight's fail-closed contract and its position before
 * provisioning-worker activation. PostgreSQL behavior is covered separately
 * by the real migration suite.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { verifyJobExecutionInterruptionsCatalog } from "./preflight-job-execution-interruptions";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const MIGRATIONS = [
  {
    createdAt: 1_785_384_000_000,
    path: path.join(
      ROOT,
      "packages/cloud/shared/src/db/migrations/0185_job_execution_interruptions.sql",
    ),
  },
  {
    createdAt: 1_785_528_000_001,
    path: path.join(
      ROOT,
      "packages/cloud/shared/src/db/migrations/0187_job_execution_interruptions_catalog_guard.sql",
    ),
  },
] as const;

async function migrationHash(migrationPath: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(migrationPath, "utf8"))
    .digest("hex");
}

async function journalRows(): Promise<
  Array<{ created_at: number; hash: string }>
> {
  return Promise.all(
    MIGRATIONS.map(async (migration) => ({
      created_at: migration.createdAt,
      hash: await migrationHash(migration.path),
    })),
  );
}

describe("job interruption catalog preflight", () => {
  test("accepts only the exact catalog row and both immutable journal hashes", async () => {
    let query = 0;
    await expect(
      verifyJobExecutionInterruptionsCatalog({
        query: async <T extends Record<string, unknown>>() => {
          query++;
          const rows =
            query === 1
              ? [
                  {
                    data_type: "integer",
                    attnotnull: true,
                    default_expression: "0",
                    attgenerated: "",
                  },
                ]
              : await journalRows();
          return { rows: rows as T[] };
        },
      }),
    ).resolves.toBeUndefined();
    expect(query).toBe(2);
  });

  test("rejects incompatible shape and duplicate journal rows", async () => {
    await expect(
      verifyJobExecutionInterruptionsCatalog({
        query: async <T extends Record<string, unknown>>() => ({
          rows: [
            {
              data_type: "text",
              attnotnull: false,
              default_expression: "'wrong'::text",
              attgenerated: "",
            },
          ] as T[],
        }),
      }),
    ).rejects.toThrow("catalog mismatch");

    await expect(
      verifyJobExecutionInterruptionsCatalog({
        query: async <T extends Record<string, unknown>>() => ({
          rows: [
            {
              data_type: "integer",
              attnotnull: true,
              default_expression: "0",
              attgenerated: "s",
            },
          ] as T[],
        }),
      }),
    ).rejects.toThrow("expected writable integer");

    let query = 0;
    const rows = await journalRows();
    await expect(
      verifyJobExecutionInterruptionsCatalog({
        query: async <T extends Record<string, unknown>>() => {
          query++;
          return {
            rows: (query === 1
              ? [
                  {
                    data_type: "integer",
                    attnotnull: true,
                    default_expression: "0",
                    attgenerated: "",
                  },
                ]
              : [rows[0], rows[0]]) as T[],
          };
        },
      }),
    ).rejects.toThrow("found 2 rows");
  });

  test("runs before either provisioning daemon restarts", async () => {
    const workflow = await readFile(
      path.join(ROOT, ".github/workflows/deploy-eliza-provisioning-worker.yml"),
      "utf8",
    );
    const preflight = workflow.indexOf(
      "preflight-job-execution-interruptions.ts",
    );
    const workerRestart = workflow.indexOf(
      'sudo systemctl restart "$SYSTEMD_UNIT"',
    );
    const routerRestart = workflow.indexOf(
      "sudo systemctl restart eliza-agent-router.service",
    );

    expect(preflight).toBeGreaterThan(-1);
    expect(workerRestart).toBeGreaterThan(preflight);
    expect(routerRestart).toBeGreaterThan(preflight);
  });
});

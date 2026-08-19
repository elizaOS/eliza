/**
 * Verifies the schema preflight's fail-closed contract and its position before
 * provisioning-worker activation. PostgreSQL behavior is covered separately
 * by the real migration suite.
 */

import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  createPreflightClientConfig,
  MAX_PREFLIGHT_OPERATION_MS,
  preflightOperationBudgetMs,
  readPreflightOptions,
  runJobExecutionInterruptionsPreflight,
  verifyJobExecutionInterruptionsCatalog,
} from "./preflight-job-execution-interruptions";

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
    createdAt: 1_786_478_400_000,
    path: path.join(
      ROOT,
      "packages/cloud/shared/src/db/migrations/0194_job_execution_interruptions_catalog_guard.sql",
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
        query: async () => {
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
          return { rows };
        },
      }),
    ).resolves.toBeUndefined();
    expect(query).toBe(2);
  });

  test("rejects incompatible shape and duplicate journal rows", async () => {
    await expect(
      verifyJobExecutionInterruptionsCatalog({
        query: async () => ({
          rows: [
            {
              data_type: "text",
              attnotnull: false,
              default_expression: "'wrong'::text",
              attgenerated: "",
            },
          ],
        }),
      }),
    ).rejects.toThrow("catalog mismatch");

    await expect(
      verifyJobExecutionInterruptionsCatalog({
        query: async () => ({
          rows: [
            {
              data_type: "integer",
              attnotnull: true,
              default_expression: "0",
              attgenerated: "s",
            },
          ],
        }),
      }),
    ).rejects.toThrow("expected writable integer");

    let query = 0;
    const rows = await journalRows();
    await expect(
      verifyJobExecutionInterruptionsCatalog({
        query: async () => {
          query++;
          return {
            rows:
              query === 1
                ? [
                    {
                      data_type: "integer",
                      attnotnull: true,
                      default_expression: "0",
                      attgenerated: "",
                    },
                  ]
                : [rows[0], rows[0]],
          };
        },
      }),
    ).rejects.toThrow("found 2 rows");
  });

  test("preserves a catalog failure when closing the client also fails", async () => {
    const closeFailure = new Error("close failed");
    const logs: string[] = [];
    const errorLog = spyOn(console, "error").mockImplementation(
      (...args: unknown[]) => logs.push(args.map(String).join(" ")),
    );

    try {
      await expect(
        runJobExecutionInterruptionsPreflight(
          {
            query: async () => ({
              rows: [
                {
                  data_type: "text",
                  attnotnull: false,
                  default_expression: "'wrong'::text",
                  attgenerated: "",
                },
              ],
            }),
            end: async () => {
              throw closeFailure;
            },
          },
          { maxAttempts: 1, delayMs: 1, attemptTimeoutMs: 100 },
        ),
      ).rejects.toThrow("catalog mismatch");
    } finally {
      errorLog.mockRestore();
    }

    expect(
      logs.some((line) => line.includes("database client close failed")),
    ).toBe(true);
    expect(
      logs.some((line) =>
        line.includes("preserving the primary preflight failure"),
      ),
    ).toBe(true);
  });

  test("rejects invalid or unbounded timeout configuration", () => {
    for (const name of [
      "JOB_INTERRUPTION_PREFLIGHT_MAX_ATTEMPTS",
      "JOB_INTERRUPTION_PREFLIGHT_DELAY_MS",
      "JOB_INTERRUPTION_PREFLIGHT_CONNECT_TIMEOUT_MS",
      "JOB_INTERRUPTION_PREFLIGHT_QUERY_TIMEOUT_MS",
      "JOB_INTERRUPTION_PREFLIGHT_ATTEMPT_TIMEOUT_MS",
    ]) {
      for (const value of [
        "0",
        "-1",
        "1.5",
        "not-a-number",
        "9007199254740992",
      ]) {
        expect(() => readPreflightOptions({ [name]: value })).toThrow(
          `${name} must be a positive integer`,
        );
      }
    }

    expect(() =>
      readPreflightOptions({
        JOB_INTERRUPTION_PREFLIGHT_QUERY_TIMEOUT_MS: "10",
        JOB_INTERRUPTION_PREFLIGHT_ATTEMPT_TIMEOUT_MS: "20",
      }),
    ).toThrow("must exceed twice");
    expect(() =>
      readPreflightOptions({
        JOB_INTERRUPTION_PREFLIGHT_MAX_ATTEMPTS: "1000",
      }),
    ).toThrow("worst-case budget");
  });

  test("configures timeouts and never retries a hung query on the same client", async () => {
    const options = readPreflightOptions({
      JOB_INTERRUPTION_PREFLIGHT_MAX_ATTEMPTS: "1",
      JOB_INTERRUPTION_PREFLIGHT_DELAY_MS: "1",
      JOB_INTERRUPTION_PREFLIGHT_CONNECT_TIMEOUT_MS: "123",
      JOB_INTERRUPTION_PREFLIGHT_QUERY_TIMEOUT_MS: "456",
      JOB_INTERRUPTION_PREFLIGHT_ATTEMPT_TIMEOUT_MS: "1000",
    });
    const config = createPreflightClientConfig(
      "postgresql://localhost/preflight?sslmode=disable&statement_timeout=0&query_timeout=0",
      options,
    );
    expect(config.connectionTimeoutMillis).toBe(123);
    expect(config.statement_timeout).toBe(456);
    expect(config.query_timeout).toBe(456);
    expect(config.connectionString).not.toContain("statement_timeout");
    expect(config.connectionString).not.toContain("query_timeout");

    let ended = false;
    let queries = 0;
    const errorLog = spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        runJobExecutionInterruptionsPreflight(
          {
            query: () => {
              queries++;
              return new Promise(() => {});
            },
            end: async () => {
              ended = true;
            },
          },
          { maxAttempts: 3, delayMs: 1, attemptTimeoutMs: 5 },
        ),
      ).rejects.toMatchObject({
        code: "JOB_INTERRUPTION_PREFLIGHT_ATTEMPT_TIMEOUT",
      });
    } finally {
      errorLog.mockRestore();
    }
    expect(queries).toBe(1);
    expect(ended).toBe(true);
  });

  // 30s budget: reads two repo files under the CI sweep's heavy parallel load,
  // where host starvation alone has pushed this past bun's default 5s timeout.
  test("guards both deploy restart and every systemd worker activation", async () => {
    const workflow = await readFile(
      path.join(ROOT, ".github/workflows/deploy-eliza-provisioning-worker.yml"),
      "utf8",
    );
    const deployStepStart = workflow.indexOf(
      "- name: Deploy and restart worker",
    );
    const healthCheckStart = workflow.indexOf(
      "- name: Health check",
      deployStepStart,
    );
    expect(deployStepStart).toBeGreaterThan(-1);
    expect(healthCheckStart).toBeGreaterThan(deployStepStart);
    const deployStep = workflow.slice(deployStepStart, healthCheckStart);
    const preflight = deployStep.indexOf(
      "packages/cloud/scripts/admin/preflight-job-execution-interruptions.ts",
    );
    const workerRestart = deployStep.indexOf(
      'sudo systemctl restart "$SYSTEMD_UNIT"',
    );
    const routerRestart = deployStep.indexOf(
      "sudo systemctl restart eliza-agent-router.service",
    );

    expect(preflight).toBeGreaterThan(-1);
    expect(workerRestart).toBeGreaterThan(preflight);
    expect(routerRestart).toBeGreaterThan(preflight);
    expect(deployStep).toContain(
      "timeout --foreground --signal=TERM --kill-after=5s 8m",
    );
    expect(deployStep).toContain("command_timeout: 40m");
    expect(workflow).toContain(
      "- 'packages/cloud/scripts/admin/preflight-job-execution-interruptions.ts'",
    );
    expect(workflow).toContain(
      "- 'packages/cloud/scripts/admin/error-preserving-cleanup.ts'",
    );

    const service = await readFile(
      path.join(
        ROOT,
        "packages/cloud/scripts/admin/eliza-provisioning-worker.service",
      ),
      "utf8",
    );
    const environmentFile = service.indexOf(
      "EnvironmentFile=/opt/eliza/cloud/.env.local",
    );
    const generatedPreflight = service.indexOf(
      "ExecStartPre=/opt/eliza/packages/cloud/scripts/admin/ensure-generated-keywords.sh",
    );
    const schemaPreflight = service.indexOf(
      "ExecStartPre=/usr/bin/env bun --conditions=eliza-source /opt/eliza/packages/cloud/scripts/admin/preflight-job-execution-interruptions.ts",
    );
    const workerStart = service.indexOf("\nExecStart=/opt/eliza/node_modules");

    expect(service).toContain("/home/deploy/.bun/bin");
    expect(environmentFile).toBeGreaterThan(-1);
    expect(generatedPreflight).toBeGreaterThan(environmentFile);
    expect(schemaPreflight).toBeGreaterThan(generatedPreflight);
    expect(workerStart).toBeGreaterThan(schemaPreflight);
    expect(service).toContain("TimeoutStartSec=8min");
    expect(service).toContain("Restart=always");

    const defaults = readPreflightOptions({});
    expect(preflightOperationBudgetMs(defaults)).toBeLessThanOrEqual(
      MAX_PREFLIGHT_OPERATION_MS,
    );
    expect(MAX_PREFLIGHT_OPERATION_MS).toBeLessThan(8 * 60_000);
  }, 30_000);
});

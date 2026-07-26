/**
 * Proves the staging canary diagnostic remains read-only, exact-targeted, and
 * incapable of publishing identifiers or unclassified operator error text.
 */

import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalizeManagedDedicatedCanaryDiagnostic,
  sanitizeManagedDedicatedCanaryDiagnostic,
  writeManagedDedicatedCanaryDiagnostic,
} from "./managed-dedicated-canary-diagnostic";
import { toLibpqConnectionUrl } from "./libpq-connection-url";

const SUFFIX = "r30081355987a1";

describe("libpq connection URL", () => {
  test("removes only the provider client compatibility hint", () => {
    expect(
      toLibpqConnectionUrl(
        "postgresql://operator:p%40ss@db.example.test:5432/eliza?sslmode=require&uselibpqcompat=true&channel_binding=require",
      ),
    ).toBe(
      "postgresql://operator:p%40ss@db.example.test:5432/eliza?sslmode=require&channel_binding=require",
    );
  });

  test("preserves a URL that already contains only libpq options", () => {
    const value =
      "postgres://operator:secret@db.example.test/eliza?sslmode=verify-full";
    expect(toLibpqConnectionUrl(value)).toBe(value);
  });

  test.each(["", "https://db.example.test/eliza"])(
    "rejects a non-PostgreSQL connection URL",
    (value) => {
      expect(() => toLibpqConnectionUrl(value)).toThrow();
    },
  );
});

function failedDeleteInput(): Record<string, unknown> {
  return {
    targetCount: 1,
    agent: {
      status: "deletion_failed",
      errorMessage:
        "Deletion permanently failed after 3 attempts: Failed to delete sandbox",
      errorCount: 1,
      deletionOwned: true,
      deletionStartedAt: "2026-07-26T23:08:09.000Z",
      updatedAt: "2026-07-26T23:11:30.000Z",
      locator: {
        sandboxIdPresent: true,
        nodeIdPresent: true,
        containerNamePresent: true,
      },
    },
    jobs: [
      {
        status: "failed",
        error: "Failed to delete sandbox",
        result: {
          containerStopped: false,
          rowDeleted: false,
          error: "Failed to delete sandbox",
        },
        attempts: 3,
        maxAttempts: 3,
        resultStorage: "inline",
        errorStorage: "inline",
        scheduledFor: "2026-07-26T23:10:30.000Z",
        startedAt: "2026-07-26T23:10:31.000Z",
        completedAt: "2026-07-26T23:11:30.000Z",
        createdAt: "2026-07-26T23:08:09.000Z",
        updatedAt: "2026-07-26T23:11:30.000Z",
      },
    ],
  };
}

describe("managed dedicated canary diagnostic", () => {
  test("emits only the classified lifecycle facts needed for retry decisions", () => {
    const evidence = sanitizeManagedDedicatedCanaryDiagnostic(
      failedDeleteInput(),
      SUFFIX,
    );

    expect(evidence).toEqual({
      schemaVersion: 1,
      targetCount: 1,
      sandbox: {
        status: "deletion_failed",
        errorCode: "sandbox_stop_failed",
        errorCount: 1,
        deletionStartedAt: "2026-07-26T23:08:09.000Z",
        updatedAt: "2026-07-26T23:11:30.000Z",
      },
      jobs: [
        {
          status: "failed",
          attempts: 3,
          maxAttempts: 3,
          containerStopped: false,
          rowDeleted: false,
          errorCode: "sandbox_stop_failed",
          resultErrorCode: "sandbox_stop_failed",
          scheduledFor: "2026-07-26T23:10:30.000Z",
          startedAt: "2026-07-26T23:10:31.000Z",
          completedAt: "2026-07-26T23:11:30.000Z",
          createdAt: "2026-07-26T23:08:09.000Z",
          updatedAt: "2026-07-26T23:11:30.000Z",
          durationMs: 59_000,
          queueDurationMs: 142_000,
        },
      ],
    });

    const canonical = canonicalizeManagedDedicatedCanaryDiagnostic(
      JSON.stringify(failedDeleteInput()),
      SUFFIX,
    );
    expect(canonical).not.toContain(SUFFIX);
    expect(canonical).not.toContain("Failed to delete sandbox");
    expect(canonical).not.toContain("managed-dedicated-canary-");
  });

  test("writes the canonical artifact with owner-only permissions", () => {
    const directory = mkdtempSync(join(tmpdir(), "managed-canary-diagnostic-"));
    const rawPath = join(directory, "raw.json");
    const evidencePath = join(directory, "evidence.json");
    writeFileSync(rawPath, JSON.stringify(failedDeleteInput()), {
      mode: 0o600,
    });
    chmodSync(rawPath, 0o600);

    writeManagedDedicatedCanaryDiagnostic(rawPath, evidencePath, SUFFIX);

    expect(statSync(evidencePath).mode & 0o777).toBe(0o600);
    expect(
      JSON.parse(readFileSync(evidencePath, "utf8")).jobs[0].errorCode,
    ).toBe("sandbox_stop_failed");
  });

  test.each([
    ["invalid suffix", failedDeleteInput(), "r1a1", "suffix"],
    [
      "zero targets",
      { ...failedDeleteInput(), targetCount: 0, agent: null, jobs: [] },
      SUFFIX,
      "exactly one",
    ],
    [
      "unexpected root key",
      {
        ...failedDeleteInput(),
        agentId: "55f332f8-da54-4c53-952c-a38f5f01287b",
      },
      SUFFIX,
      "unexpected shape",
    ],
    [
      "non-inline payload",
      {
        ...failedDeleteInput(),
        jobs: [
          {
            ...(failedDeleteInput().jobs as Record<string, unknown>[])[0],
            errorStorage: "r2",
          },
        ],
      },
      SUFFIX,
      "non-inline",
    ],
    [
      "unclassified operator text",
      {
        ...failedDeleteInput(),
        jobs: [
          {
            ...(failedDeleteInput().jobs as Record<string, unknown>[])[0],
            error: "remote execution returned an unexpected opaque failure",
            result: null,
          },
        ],
      },
      SUFFIX,
      "privacy-safe classifier",
    ],
    [
      "raw result identifier",
      {
        ...failedDeleteInput(),
        jobs: [
          {
            ...(failedDeleteInput().jobs as Record<string, unknown>[])[0],
            result: {
              containerStopped: false,
              rowDeleted: false,
              error: "Failed to delete sandbox",
              cloudAgentId: "55f332f8-da54-4c53-952c-a38f5f01287b",
            },
          },
        ],
      },
      SUFFIX,
      "unexpected shape",
    ],
  ])("fails closed for %s", (_name, input, suffix, message) => {
    expect(() =>
      sanitizeManagedDedicatedCanaryDiagnostic(input, suffix),
    ).toThrow(message);
  });

  test("preserves distinct terminal and prior-attempt result classifications", () => {
    const input = failedDeleteInput();
    const [job] = input.jobs as Record<string, unknown>[];
    job.result = {
      containerStopped: false,
      rowDeleted: false,
      error: "credential revoke failed",
    };
    const evidence = sanitizeManagedDedicatedCanaryDiagnostic(input, SUFFIX);
    expect(evidence.jobs[0]).toMatchObject({
      errorCode: "sandbox_stop_failed",
      resultErrorCode: "credential_revoke_failed",
    });
  });

  test("classifies row-delete failures without publishing the SQL text", () => {
    const input = failedDeleteInput();
    const agent = input.agent as Record<string, unknown>;
    const [job] = input.jobs as Record<string, unknown>[];
    const error =
      'Failed query: DELETE FROM "agent_sandboxes" WHERE "agent_sandboxes"."id" = $1';
    agent.errorMessage = `Deletion permanently failed after 3 attempts: ${error}`;
    job.error = error;
    job.result = {
      containerStopped: true,
      rowDeleted: false,
      error: "Failed to delete sandbox",
    };

    const canonical = canonicalizeManagedDedicatedCanaryDiagnostic(
      JSON.stringify(input),
      SUFFIX,
    );
    const evidence = JSON.parse(canonical);
    expect(evidence.sandbox.errorCode).toBe("row_delete_failed");
    expect(evidence.jobs[0]).toMatchObject({
      errorCode: "row_delete_failed",
      resultErrorCode: "sandbox_stop_failed",
    });
    expect(canonical).not.toContain("DELETE FROM");
    expect(canonical).not.toContain("agent_sandboxes");
  });

  test("uses terminal updatedAt when failed jobs have no completedAt", () => {
    const input = failedDeleteInput();
    const [job] = input.jobs as Record<string, unknown>[];
    job.completedAt = null;

    expect(
      sanitizeManagedDedicatedCanaryDiagnostic(input, SUFFIX).jobs[0]
        ?.durationMs,
    ).toBe(59_000);
  });

  test.each([
    [
      "attempts above maxAttempts",
      (job: Record<string, unknown>) => {
        job.attempts = 4;
      },
      "attempts exceed",
    ],
    [
      "row deletion without a stopped container",
      (job: Record<string, unknown>) => {
        job.result = {
          containerStopped: false,
          rowDeleted: true,
          error: null,
        };
        job.error = null;
        job.status = "completed";
      },
      "deleted a row without",
    ],
    [
      "failed status without attempts",
      (job: Record<string, unknown>) => {
        job.attempts = 0;
      },
      "invalid failed",
    ],
  ])("rejects semantic contradiction: %s", (_name, mutate, message) => {
    const input = failedDeleteInput();
    mutate((input.jobs as Record<string, unknown>[])[0]);
    expect(() =>
      sanitizeManagedDedicatedCanaryDiagnostic(input, SUFFIX),
    ).toThrow(message);
  });

  test("requires newest-first job ordering", () => {
    const input = failedDeleteInput();
    const [newest] = input.jobs as Record<string, unknown>[];
    input.jobs = [
      newest,
      {
        ...newest,
        createdAt: "2026-07-26T23:09:09.000Z",
        startedAt: "2026-07-26T23:09:10.000Z",
        completedAt: "2026-07-26T23:09:11.000Z",
      },
    ];
    expect(() =>
      sanitizeManagedDedicatedCanaryDiagnostic(input, SUFFIX),
    ).toThrow("newest-first");
  });

  test("keeps diagnostic SQL read-only and the normal canary path intact", () => {
    const workflow = readFileSync(
      join(
        import.meta.dir,
        "../../../../.github/workflows/managed-dedicated-canary.yml",
      ),
      "utf8",
    );
    expect(workflow).toContain("BEGIN READ ONLY;");
    expect(workflow).toContain("SET LOCAL statement_timeout = '20s';");
    expect(workflow).toContain(
      "bun packages/scripts/cloud/admin/libpq-connection-url.ts",
    );
    expect(workflow).toContain('echo "::add-mask::$PSQL_DATABASE_URL"');
    expect(workflow).toContain('psql "$PSQL_DATABASE_URL"');
    expect(workflow).not.toContain('psql "$DATABASE_URL"');
    expect(workflow).toContain(
      "WHERE agent_name = 'managed-dedicated-canary-' || :'suffix'",
    );
    expect(workflow).toContain("inputs.diagnose_stale_canary_suffix == ''");
    expect(workflow).toContain(
      "bun run packages/scripts/cloud/admin/managed-dedicated-canary.ts",
    );
    expect(workflow).toMatch(
      /managed-dedicated-canary-diagnostic\.ts \\\n\s+"\$CANARY_DIAGNOSTIC_SUFFIX" \\\n\s+"\$CANARY_DIAGNOSTIC_RAW_PATH" \\\n\s+"\$CANARY_DIAGNOSTIC_EVIDENCE_PATH"/,
    );

    const sql = workflow.match(/<<'SQL'\n([\s\S]*?)\n\s+SQL/)?.[1];
    expect(sql).toBeTruthy();
    expect(sql).not.toMatch(
      /\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE|CREATE)\b/i,
    );
  });
});

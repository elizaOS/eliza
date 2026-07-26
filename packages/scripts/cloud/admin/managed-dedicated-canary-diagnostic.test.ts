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

const SUFFIX = "r30081355987a1";

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
        deletionOwned: true,
        locator: {
          sandboxIdPresent: true,
          nodeIdPresent: true,
          containerNamePresent: true,
        },
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

  test("rejects disagreement between stored error sources", () => {
    const input = failedDeleteInput();
    const [job] = input.jobs as Record<string, unknown>[];
    job.result = {
      containerStopped: false,
      rowDeleted: false,
      error: "credential revoke failed",
    };
    expect(() =>
      sanitizeManagedDedicatedCanaryDiagnostic(input, SUFFIX),
    ).toThrow("error sources disagree");
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
      "WHERE agent_name = 'managed-dedicated-canary-' || :'suffix'",
    );
    expect(workflow).toContain("inputs.diagnose_stale_canary_suffix == ''");
    expect(workflow).toContain(
      "bun run packages/scripts/cloud/admin/managed-dedicated-canary.ts",
    );

    const sql = workflow.match(/<<'SQL'\n([\s\S]*?)\n\s+SQL/)?.[1];
    expect(sql).toBeTruthy();
    expect(sql).not.toMatch(
      /\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE|CREATE)\b/i,
    );
  });
});

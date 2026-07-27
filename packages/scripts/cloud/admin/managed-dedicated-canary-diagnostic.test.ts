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

  test.each([
    "?uselibpqcompat=false",
    "?uselibpqcompat=",
    "?uselibpqcompat=true&uselibpqcompat=true",
    "?UseLibpqCompat=true",
  ])("rejects an ambiguous compatibility hint: %s", (query) => {
    expect(() =>
      toLibpqConnectionUrl(
        `postgresql://operator:secret@db.example.test/eliza${query}`,
      ),
    ).toThrow("invalid libpq compatibility hint");
  });
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
      schemaVersion: 2,
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
          recoveryCode: "none",
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

  test.each([
    [
      "Agent replacement cleanup is still pending",
      "replacement_cleanup_pending",
    ],
    ["Agent provisioning is in progress", "provisioning_in_progress"],
  ])(
    "classifies the canonical delete lifecycle boundary: %s",
    (message, expectedCode) => {
      const input = failedDeleteInput();
      const agent = input.agent as Record<string, unknown>;
      const [job] = input.jobs as Record<string, unknown>[];
      agent.errorMessage = `Deletion permanently failed after 3 attempts: ${message}`;
      job.error = message;
      job.result = {
        containerStopped: false,
        rowDeleted: false,
        error: message,
      };

      const canonical = canonicalizeManagedDedicatedCanaryDiagnostic(
        JSON.stringify(input),
        SUFFIX,
      );
      const evidence = JSON.parse(canonical);
      expect(evidence.sandbox.errorCode).toBe(expectedCode);
      expect(evidence.jobs[0]).toMatchObject({
        errorCode: expectedCode,
        resultErrorCode: expectedCode,
      });
      expect(canonical).not.toContain(message);
    },
  );

  test.each([
    "agent_provision",
    "agent_delete",
    "agent_suspend",
    "agent_resume",
    "agent_restart",
    "agent_downgrade",
    "agent_sleep",
    "agent_wake",
    "agent_upgrade",
    "agent_admin_canary_image",
  ])(
    "classifies the exclusive-job conflict without publishing identifiers: %s",
    (jobType) => {
      const input = failedDeleteInput();
      const agent = input.agent as Record<string, unknown>;
      const [job] = input.jobs as Record<string, unknown>[];
      const error =
        `Agent 55f332f8-da54-4c53-952c-a38f5f01287b has conflicting ${jobType} ` +
        "job 398b3cae-4aa0-4f63-8736-ac3c7ca9ab96";
      agent.errorMessage = `Deletion permanently failed after 3 attempts: ${error}`;
      job.error = error;
      job.result = null;

      const canonical = canonicalizeManagedDedicatedCanaryDiagnostic(
        JSON.stringify(input),
        SUFFIX,
      );
      const evidence = JSON.parse(canonical);
      expect(evidence.sandbox.errorCode).toBe("lifecycle_conflict");
      expect(evidence.jobs[0]).toMatchObject({
        errorCode: "lifecycle_conflict",
        resultErrorCode: "none",
        containerStopped: null,
        rowDeleted: null,
      });
      expect(canonical).not.toContain("55f332f8");
      expect(canonical).not.toContain("398b3cae");
      expect(canonical).not.toContain("has conflicting");
    },
  );

  test.each([
    "Agent 55f332f8-da54-4c53-952c-a38f5f01287b has conflicting agent_message job 398b3cae-4aa0-4f63-8736-ac3c7ca9ab96",
    "Agent 55f332f8-da54-4c53-952c-a38f5f01287b has conflicting agent_logs job 398b3cae-4aa0-4f63-8736-ac3c7ca9ab96",
    "Agent 55f332f8-da54-4c53-952c-a38f5f01287b has conflicting container_delete job 398b3cae-4aa0-4f63-8736-ac3c7ca9ab96",
    "Agent not-a-uuid has conflicting agent_delete job 398b3cae-4aa0-4f63-8736-ac3c7ca9ab96",
    "Agent 55f332f8-da54-4c53-952c-a38f5f01287b has conflicting agent_delete job 398b3cae-4aa0-4f63-8736-ac3c7ca9ab96 trailing",
  ])("rejects a noncanonical lifecycle-conflict message", (error) => {
    const input = failedDeleteInput();
    const agent = input.agent as Record<string, unknown>;
    const [job] = input.jobs as Record<string, unknown>[];
    agent.errorMessage = `Deletion permanently failed after 3 attempts: ${error}`;
    job.error = error;
    job.result = null;

    expect(() =>
      canonicalizeManagedDedicatedCanaryDiagnostic(
        JSON.stringify(input),
        SUFFIX,
      ),
    ).toThrow("privacy-safe classifier");
  });

  test("classifies a terminal worker-restart interruption without publishing raw text", () => {
    const input = failedDeleteInput();
    const agent = input.agent as Record<string, unknown>;
    const [job] = input.jobs as Record<string, unknown>[];
    const error =
      "Job interrupted by worker restart 3 times - max attempts reached";
    agent.status = "deletion_pending";
    agent.errorMessage = null;
    agent.errorCount = 0;
    job.error = error;
    job.result = null;

    const canonical = canonicalizeManagedDedicatedCanaryDiagnostic(
      JSON.stringify(input),
      SUFFIX,
    );
    const evidence = JSON.parse(canonical);
    expect(evidence.sandbox).toMatchObject({
      status: "deletion_pending",
      errorCode: "none",
      errorCount: 0,
    });
    expect(evidence.jobs[0]).toMatchObject({
      status: "failed",
      attempts: 3,
      maxAttempts: 3,
      errorCode: "worker_restart_interrupted",
      resultErrorCode: "none",
      containerStopped: null,
      rowDeleted: null,
    });
    expect(canonical).not.toContain("worker restart");
    expect(canonical).not.toContain("max attempts");
  });

  test("classifies a terminal timeout without publishing raw text", () => {
    const input = failedDeleteInput();
    const agent = input.agent as Record<string, unknown>;
    const [job] = input.jobs as Record<string, unknown>[];
    const error = "Job timed out 3 times - max attempts reached";
    agent.status = "deletion_pending";
    agent.errorMessage = null;
    agent.errorCount = 0;
    job.error = error;
    job.result = null;

    const canonical = canonicalizeManagedDedicatedCanaryDiagnostic(
      JSON.stringify(input),
      SUFFIX,
    );
    const evidence = JSON.parse(canonical);
    expect(evidence.sandbox).toMatchObject({
      status: "deletion_pending",
      errorCode: "none",
      errorCount: 0,
    });
    expect(evidence.jobs[0]).toMatchObject({
      status: "failed",
      attempts: 3,
      maxAttempts: 3,
      errorCode: "timeout",
      recoveryCode: "none",
      resultErrorCode: "none",
    });
    expect(canonical).not.toContain("timed out");
    expect(canonical).not.toContain("max attempts");
  });

  test.each([
    "Job interrupted by worker restart 0 times - max attempts reached",
    "Job interrupted by worker restart 1000 times - max attempts reached",
    "Job interrupted by worker restart 3 times - max attempts reached trailing",
  ])("rejects a noncanonical worker-restart message", (error) => {
    const input = failedDeleteInput();
    const agent = input.agent as Record<string, unknown>;
    const [job] = input.jobs as Record<string, unknown>[];
    agent.errorMessage = `Deletion permanently failed after 3 attempts: ${error}`;
    job.error = error;
    job.result = null;
    expect(() =>
      sanitizeManagedDedicatedCanaryDiagnostic(input, SUFFIX),
    ).toThrow("malformed recovery provenance");
  });

  test.each([
    [
      "Job interrupted by worker restart 1 times - max attempts reached",
      3,
      3,
      "failed",
    ],
    ["Job timed out 2 times - max attempts reached", 3, 3, "failed"],
    ["Job timed out 3 times - max attempts reached", 3, 4, "failed"],
    ["Job timed out 3 times - max attempts reached", 3, 3, "in_progress"],
  ])(
    "rejects terminal lifecycle counters that disagree with the persisted job",
    (error, attempts, maxAttempts, status) => {
      const input = failedDeleteInput();
      const agent = input.agent as Record<string, unknown>;
      const [job] = input.jobs as Record<string, unknown>[];
      agent.status = "deletion_pending";
      agent.errorMessage = null;
      agent.errorCount = 0;
      job.error = error;
      job.result = null;
      job.attempts = attempts;
      job.maxAttempts = maxAttempts;
      job.status = status;

      expect(() =>
        sanitizeManagedDedicatedCanaryDiagnostic(input, SUFFIX),
      ).toThrow("terminal counters disagree");
    },
  );

  test.each([
    [
      "worker_restart_recovered",
      "Job interrupted by worker restart - recovered for retry (attempt 1/3)",
    ],
    [
      "timeout_recovered",
      "Job timed out - recovered for retry (attempt 1/3)",
    ],
  ])(
    "keeps %s separate from terminal errors for pending and running jobs",
    (expectedCode, message) => {
      for (const status of ["pending", "in_progress"]) {
        const input = failedDeleteInput();
        const agent = input.agent as Record<string, unknown>;
        const [job] = input.jobs as Record<string, unknown>[];
        agent.status = "deletion_pending";
        agent.errorMessage = null;
        agent.errorCount = 0;
        job.status = status;
        job.error = message;
        job.attempts = 1;
        job.maxAttempts = 3;
        job.startedAt = "2026-07-26T23:10:31.000Z";
        job.completedAt = null;
        job.result = null;

        const canonical = canonicalizeManagedDedicatedCanaryDiagnostic(
          JSON.stringify(input),
          SUFFIX,
        );
        expect(JSON.parse(canonical).jobs[0]).toMatchObject({
          status,
          attempts: 1,
          maxAttempts: 3,
          errorCode: "none",
          recoveryCode: expectedCode,
          resultErrorCode: "none",
        });
        expect(canonical).not.toContain(message);
        expect(canonical).not.toContain("recovered for retry");
      }
    },
  );

  test("preserves a prior partial result beside recovery provenance", () => {
    const input = failedDeleteInput();
    const agent = input.agent as Record<string, unknown>;
    const [job] = input.jobs as Record<string, unknown>[];
    agent.status = "deletion_pending";
    agent.errorMessage = null;
    agent.errorCount = 0;
    job.status = "pending";
    job.error =
      "Job interrupted by worker restart - recovered for retry (attempt 1/3)";
    job.attempts = 1;
    job.completedAt = null;

    expect(
      sanitizeManagedDedicatedCanaryDiagnostic(input, SUFFIX).jobs[0],
    ).toMatchObject({
      status: "pending",
      errorCode: "none",
      recoveryCode: "worker_restart_recovered",
      resultErrorCode: "sandbox_stop_failed",
      containerStopped: false,
      rowDeleted: false,
    });
  });

  test.each([
    [
      "mismatched attempt",
      "Job interrupted by worker restart - recovered for retry (attempt 2/3)",
      1,
      3,
      "recovery counters disagree",
    ],
    [
      "mismatched maximum",
      "Job interrupted by worker restart - recovered for retry (attempt 1/4)",
      1,
      3,
      "recovery counters disagree",
    ],
    [
      "maxed retry",
      "Job interrupted by worker restart - recovered for retry (attempt 3/3)",
      3,
      3,
      "recovery counters disagree",
    ],
    [
      "failed status",
      "Job interrupted by worker restart - recovered for retry (attempt 1/3)",
      1,
      3,
      "recovery status is invalid",
    ],
    [
      "timeout mismatched attempt",
      "Job timed out - recovered for retry (attempt 2/3)",
      1,
      3,
      "recovery counters disagree",
    ],
    [
      "timeout maxed retry",
      "Job timed out - recovered for retry (attempt 3/3)",
      3,
      3,
      "recovery counters disagree",
    ],
    [
      "timeout failed status",
      "Job timed out - recovered for retry (attempt 1/3)",
      1,
      3,
      "recovery status is invalid",
    ],
  ])(
    "rejects %s for a nonterminal recovery breadcrumb",
    (_name, message, attempts, maxAttempts, expectedError) => {
      const input = failedDeleteInput();
      const agent = input.agent as Record<string, unknown>;
      const [job] = input.jobs as Record<string, unknown>[];
      agent.status = "deletion_pending";
      agent.errorMessage = null;
      agent.errorCount = 0;
      job.error = message;
      job.result = null;
      job.attempts = attempts;
      job.maxAttempts = maxAttempts;
      if (_name !== "failed status" && _name !== "timeout failed status") {
        job.status = "pending";
      }

      expect(() =>
        sanitizeManagedDedicatedCanaryDiagnostic(input, SUFFIX),
      ).toThrow(expectedError);
    },
  );

  test.each([
    [
      "pending without its preserved claim timestamp",
      "pending",
      null,
      null,
      "recovery timestamps disagree",
    ],
    [
      "pending with a terminal timestamp",
      "pending",
      "2026-07-26T23:10:31.000Z",
      "2026-07-26T23:11:30.000Z",
      "recovery timestamps disagree",
    ],
    [
      "running with a terminal timestamp",
      "in_progress",
      "2026-07-26T23:10:31.000Z",
      "2026-07-26T23:11:30.000Z",
      "recovery timestamps disagree",
    ],
    [
      "completed while the diagnostic target still exists",
      "completed",
      "2026-07-26T23:10:31.000Z",
      "2026-07-26T23:11:30.000Z",
      "recovery status is invalid",
    ],
  ])(
    "rejects %s",
    (_name, status, startedAt, completedAt, expectedError) => {
      const input = failedDeleteInput();
      const agent = input.agent as Record<string, unknown>;
      const [job] = input.jobs as Record<string, unknown>[];
      agent.status = "deletion_pending";
      agent.errorMessage = null;
      agent.errorCount = 0;
      job.status = status;
      job.error =
        "Job interrupted by worker restart - recovered for retry (attempt 1/3)";
      job.result =
        status === "completed"
          ? {
              containerStopped: true,
              rowDeleted: true,
              error: null,
            }
          : null;
      job.attempts = 1;
      job.startedAt = startedAt;
      job.completedAt = completedAt;

      expect(() =>
        sanitizeManagedDedicatedCanaryDiagnostic(input, SUFFIX),
      ).toThrow(expectedError);
    },
  );

  test.each([
    "Job interrupted by worker restart - recovered for retry (attempt 0/3)",
    "Job interrupted by worker restart - recovered for retry (attempt 1/1000)",
    "Job interrupted by worker restart - recovered for retry (attempt 1/3) trailing",
    "Job timed out - recovered for retry (attempt 0/3)",
    "Job timed out - recovered for retry (attempt 1/1000)",
    "Job timed out - recovered for retry (attempt 1/3) trailing",
    "Job timed out - Recovered for Retry (attempt 1/3)",
    "Job timed out - recovered  for retry (attempt 1/3)",
    " Job timed out - recovered for retry (attempt 1/3)",
    "Job timed out: recovered for retry (attempt 1/3)",
    "Job  timed out - recovered for retry (attempt 1/3)",
    "Job timeouted - recovered for retry (attempt 1/3)",
    "Job timeouts - recovered for retry (attempt 1/3)",
    "Job timeout_foo - recovered for retry (attempt 1/3)",
    "Job timed\tout - recovered for retry (attempt 1/3)",
    "Job timed out - recov ered for retry (attempt 1/3)",
    "Job timed out - recovеred for retry (attempt 1/3)",
    "Job timed out - retrying (attempt 1/3)",
    "job  timed out - retrying (attempt 1/3)",
    "Job timed\u200b-out - retrying (attempt 1/3)",
    "Job timed.out - retrying (attempt 1/3)",
    "Job interrupted by worker restart: retrying (attempt 1/3)",
    "Job interrupted by worker restart - recovered for retry (attempt 1/3)\n",
  ])("rejects malformed recovery provenance", (message) => {
    const input = failedDeleteInput();
    const agent = input.agent as Record<string, unknown>;
    const [job] = input.jobs as Record<string, unknown>[];
    agent.status = "deletion_pending";
    agent.errorMessage = null;
    agent.errorCount = 0;
    job.status = "pending";
    job.error = message;
    job.result = null;
    job.attempts = 1;

    expect(() =>
      sanitizeManagedDedicatedCanaryDiagnostic(input, SUFFIX),
    ).toThrow("malformed recovery provenance");
  });

  test.each(["agent", "result"])(
    "rejects recovery-looking text outside jobs.error at the %s boundary",
    (boundary) => {
      const input = failedDeleteInput();
      const agent = input.agent as Record<string, unknown>;
      const [job] = input.jobs as Record<string, unknown>[];
      const malformed =
        "Job timed out - recovered  for retry (attempt 1/3)";
      if (boundary === "agent") {
        agent.errorMessage = `Deletion permanently failed after 3 attempts: ${malformed}`;
      } else {
        job.result = {
          containerStopped: false,
          rowDeleted: false,
          error: malformed,
        };
      }

      expect(() =>
        sanitizeManagedDedicatedCanaryDiagnostic(input, SUFFIX),
      ).toThrow("malformed recovery provenance");
    },
  );

  test.each([
    [
      "successful deletion",
      { containerStopped: true, rowDeleted: true, error: null },
    ],
    [
      "stopped container without a classified failure",
      { containerStopped: true, rowDeleted: false, error: null },
    ],
    [
      "deleted row without a stopped container",
      {
        containerStopped: false,
        rowDeleted: true,
        error: "Failed to delete sandbox",
      },
    ],
    [
      "partial outcome without an error",
      { containerStopped: false, rowDeleted: false, error: null },
    ],
    [
      "agent-not-found error",
      {
        containerStopped: false,
        rowDeleted: false,
        error: "Agent not found",
      },
    ],
    [
      "database error",
      {
        containerStopped: false,
        rowDeleted: false,
        error: "database connection failed",
      },
    ],
    [
      "credential error",
      {
        containerStopped: false,
        rowDeleted: false,
        error: "credential revoke failed",
      },
    ],
    [
      "timeout error",
      {
        containerStopped: false,
        rowDeleted: false,
        error: "provider timed out",
      },
    ],
    [
      "dynamic lifecycle-conflict error",
      {
        containerStopped: false,
        rowDeleted: false,
        error:
          "Agent 55f332f8-da54-4c53-952c-a38f5f01287b has conflicting agent_delete job 398b3cae-4aa0-4f63-8736-ac3c7ca9ab96",
      },
    ],
    [
      "organization-mismatch lifecycle error",
      {
        containerStopped: false,
        rowDeleted: false,
        error: "Organization ID mismatch",
      },
    ],
  ])("rejects recovery with %s result", (_name, result) => {
    const input = failedDeleteInput();
    const agent = input.agent as Record<string, unknown>;
    const [job] = input.jobs as Record<string, unknown>[];
    agent.status = "deletion_pending";
    agent.errorMessage = null;
    agent.errorCount = 0;
    job.status = "pending";
    job.error =
      "Job interrupted by worker restart - recovered for retry (attempt 1/3)";
    job.result = result;
    job.attempts = 1;
    job.completedAt = null;

    expect(() =>
      sanitizeManagedDedicatedCanaryDiagnostic(input, SUFFIX),
    ).toThrow("recovery result is not a partial failure");
  });

  test.each([
    ["Failed to delete sandbox", "sandbox_stop_failed"],
    [
      "Agent replacement cleanup is still pending",
      "replacement_cleanup_pending",
    ],
    ["Agent provisioning is in progress", "provisioning_in_progress"],
    ["Agent deletion ownership changed", "lifecycle_conflict"],
  ])(
    "accepts the source-owned partial recovery result: %s",
    (message, expectedCode) => {
      const input = failedDeleteInput();
      const agent = input.agent as Record<string, unknown>;
      const [job] = input.jobs as Record<string, unknown>[];
      agent.status = "deletion_pending";
      agent.errorMessage = null;
      agent.errorCount = 0;
      job.status = "pending";
      job.error =
        "Job interrupted by worker restart - recovered for retry (attempt 1/3)";
      job.result = {
        containerStopped: false,
        rowDeleted: false,
        error: message,
      };
      job.attempts = 1;
      job.completedAt = null;

      expect(
        sanitizeManagedDedicatedCanaryDiagnostic(input, SUFFIX).jobs[0],
      ).toMatchObject({
        recoveryCode: "worker_restart_recovered",
        resultErrorCode: expectedCode,
        containerStopped: false,
        rowDeleted: false,
      });
    },
  );

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
    expect(workflow).toContain("latestJob.recoveryCode");
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

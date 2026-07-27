/**
 * Proves the staging canary diagnostic remains read-only, exact-targeted, and
 * incapable of publishing identifiers or unclassified operator error text.
 */

import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toLibpqConnectionUrl } from "./libpq-connection-url";
import {
  canonicalizeManagedDedicatedCanaryDiagnostic,
  sanitizeManagedDedicatedCanaryDiagnostic,
  writeManagedDedicatedCanaryDiagnostic,
} from "./managed-dedicated-canary-diagnostic";

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

function unclassifiedLatestJobInput(error: unknown): Record<string, unknown> {
  const input = failedDeleteInput();
  const agent = input.agent as Record<string, unknown>;
  const [job] = input.jobs as Record<string, unknown>[];
  agent.status = "deletion_pending";
  agent.errorMessage = null;
  agent.errorCount = 0;
  job.error = error;
  job.result = null;
  job.completedAt = null;
  return input;
}

function boundedHistoryInput(errors: unknown[]): Record<string, unknown> {
  if (errors.length === 0) {
    return { ...failedDeleteInput(), jobs: [] };
  }
  const input = unclassifiedLatestJobInput(errors[0]);
  const [template] = input.jobs as Record<string, unknown>[];
  input.jobs = errors.map((error, index) => {
    const offset = index * 60_000;
    const shift = (value: string) =>
      new Date(Date.parse(value) - offset).toISOString();
    return {
      ...template,
      error,
      scheduledFor: shift(template.scheduledFor as string),
      startedAt: shift(template.startedAt as string),
      createdAt: shift(template.createdAt as string),
      updatedAt: shift(template.updatedAt as string),
    };
  });
  return input;
}

function correlatedPermanentDeleteInput(
  cause = "opaque delete provider failure",
): Record<string, unknown> {
  const input = failedDeleteInput();
  const agent = input.agent as Record<string, unknown>;
  const [job] = input.jobs as Record<string, unknown>[];
  agent.errorMessage = `Deletion permanently failed after 3 attempts: ${cause}`;
  job.error = cause;
  job.result = null;
  job.completedAt = null;
  return input;
}

describe("managed dedicated canary diagnostic", () => {
  test("emits only the classified lifecycle facts needed for retry decisions", () => {
    const evidence = sanitizeManagedDedicatedCanaryDiagnostic(
      failedDeleteInput(),
      SUFFIX,
    );

    expect(evidence).toEqual({
      schemaVersion: 3,
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
          unclassifiedProfile: null,
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

  test.each([
    [1, "1_64"],
    [64, "1_64"],
    [65, "65_128"],
    [128, "65_128"],
    [129, "129_256"],
    [256, "129_256"],
    [257, "257_512"],
    [512, "257_512"],
    [513, "513_2000"],
    [2_000, "513_2000"],
  ])(
    "profiles an unclassified latest job in the fixed %s-code-unit bucket",
    (length, expectedBucket) => {
      const evidence = sanitizeManagedDedicatedCanaryDiagnostic(
        unclassifiedLatestJobInput("x".repeat(length)),
        SUFFIX,
      );

      expect(evidence).toMatchObject({
        schemaVersion: 3,
        sandbox: {
          errorCode: "none",
        },
        jobs: [
          {
            errorCode: "unclassified",
            unclassifiedProfile: {
              lengthBucket: expectedBucket,
              writerHints: {
                jobRunnerLike: false,
                deleteLifecycleLike: false,
                persistenceLike: false,
                containerRuntimeLike: false,
                transportLike: false,
              },
            },
          },
        ],
      });
    },
  );

  test.each([
    ["empty", ""],
    ["over-limit", "x".repeat(2_001)],
    ["non-string", 17],
  ])("rejects an invalid unclassified %s value", (_name, error) => {
    expect(() =>
      sanitizeManagedDedicatedCanaryDiagnostic(
        unclassifiedLatestJobInput(error),
        SUFFIX,
      ),
    ).toThrow("bounded string");
  });

  test.each([
    ["32 surrogate pairs", "😀".repeat(32), "1_64"],
    ["33 surrogate pairs", "😀".repeat(33), "65_128"],
    ["unpaired surrogate", "\ud800", "1_64"],
  ])("uses JavaScript UTF-16 units for %s", (_name, error, lengthBucket) => {
    const profile = sanitizeManagedDedicatedCanaryDiagnostic(
      unclassifiedLatestJobInput(error),
      SUFFIX,
    ).jobs[0]?.unclassifiedProfile;
    expect(profile?.lengthBucket).toBe(lengthBucket);
  });

  test.each([
    ["job agent_delete returned an opaque failure", "jobRunnerLike"],
    ["Agent deletion intent was not persisted", "deleteLifecycleLike"],
    ["PGlite driver returned an opaque failure", "persistenceLike"],
    ["SSH executor returned an opaque failure", "containerRuntimeLike"],
    ["getaddrinfo returned an opaque failure", "transportLike"],
  ])("emits one anchored %s hint", (error, expectedHint) => {
    const hints = sanitizeManagedDedicatedCanaryDiagnostic(
      unclassifiedLatestJobInput(error),
      SUFFIX,
    ).jobs[0]?.unclassifiedProfile?.writerHints;
    expect(hints).toEqual({
      jobRunnerLike: expectedHint === "jobRunnerLike",
      deleteLifecycleLike: expectedHint === "deleteLifecycleLike",
      persistenceLike: expectedHint === "persistenceLike",
      containerRuntimeLike: expectedHint === "containerRuntimeLike",
      transportLike: expectedHint === "transportLike",
    });
  });

  test("uses fixed precedence when one value carries every family marker", () => {
    const error =
      "job agent_delete Agent deletion intent PGlite SSH getaddrinfo";
    const hints = sanitizeManagedDedicatedCanaryDiagnostic(
      unclassifiedLatestJobInput(error),
      SUFFIX,
    ).jobs[0]?.unclassifiedProfile?.writerHints;
    expect(hints).toEqual({
      jobRunnerLike: true,
      deleteLifecycleLike: false,
      persistenceLike: false,
      containerRuntimeLike: false,
      transportLike: false,
    });
  });

  test("equal-length same-family secrets produce byte-identical profiles", () => {
    const left = sanitizeManagedDedicatedCanaryDiagnostic(
      unclassifiedLatestJobInput("job agent_delete secret-AAAA"),
      SUFFIX,
    ).jobs[0]?.unclassifiedProfile;
    const right = sanitizeManagedDedicatedCanaryDiagnostic(
      unclassifiedLatestJobInput("job agent_delete secret-BBBB"),
      SUFFIX,
    ).jobs[0]?.unclassifiedProfile;
    expect(JSON.stringify(left)).toBe(JSON.stringify(right));
  });

  test("canonical output never includes malicious unclassified input", () => {
    const error =
      "opaque https://u:p@example.test/a?q=secret#frag 192.0.2.44 user@example.test " +
      "Bearer eyJhbGciOiJIUzI1NiJ9.abc.sig ghp_1234567890 AWS_SECRET_ACCESS_KEY " +
      "api_key=password -----BEGIN PRIVATE KEY----- sha256:deadbeef " +
      '{"x":"::error::$' +
      '{{secrets.X}}"}\r\n\t\u0000\u001b[31m\u202e\u200b\u0301\u0430\ud800';
    const canonical = canonicalizeManagedDedicatedCanaryDiagnostic(
      JSON.stringify(unclassifiedLatestJobInput(error)),
      SUFFIX,
    );
    const evidence = JSON.parse(canonical);
    expect(evidence.jobs[0]).toMatchObject({
      errorCode: "unclassified",
      unclassifiedProfile: {
        writerHints: {
          jobRunnerLike: false,
          deleteLifecycleLike: false,
          persistenceLike: false,
          containerRuntimeLike: false,
          transportLike: false,
        },
      },
    });
    for (const forbidden of [
      "example.test",
      "192.0.2.44",
      "Bearer",
      "ghp_",
      "AWS_",
      "api_key",
      "PRIVATE KEY",
      "sha256",
      "deadbeef",
      "::error::",
      "secrets.X",
      "opaque",
    ]) {
      expect(canonical).not.toContain(forbidden);
    }
  });

  test("never publishes malicious input from any bounded history position", () => {
    const malicious = [
      "opaque https://u:p@example.test/a?q=secret#frag 192.0.2.44 ",
      "55f332f8-da54-4c53-952c-a38f5f01287b Bearer eyJ.abc.sig ",
      `${SUFFIX} sha256:deadbeef api_key=password ::error::`,
      "$" + "{{secrets.X}}\r\n\t\u0000\u001b[31m\u202e\u200b\u0301\u0430\ud800",
    ].join("");
    const canonical = canonicalizeManagedDedicatedCanaryDiagnostic(
      JSON.stringify(boundedHistoryInput([malicious, malicious, malicious])),
      SUFFIX,
    );
    const evidence = JSON.parse(canonical);

    expect(evidence.jobs).toHaveLength(3);
    expect(
      evidence.jobs.every(
        (job: Record<string, unknown>) =>
          job.errorCode === "unclassified" && job.unclassifiedProfile !== null,
      ),
    ).toBe(true);
    for (const forbidden of [
      "example.test",
      "192.0.2.44",
      "55f332f8",
      "Bearer",
      SUFFIX,
      "sha256",
      "deadbeef",
      "api_key",
      "::error::",
      "secrets.X",
      "opaque",
    ]) {
      expect(canonical).not.toContain(forbidden);
    }
  });

  test.each([0, 1, 2])(
    "keeps equal-shape secrets indistinguishable at history index %i",
    (index) => {
      const leftErrors = ["opaque neutral", "opaque neutral", "opaque neutral"];
      const rightErrors = [...leftErrors];
      leftErrors[index] = "job agent_delete secret-AAAA";
      rightErrors[index] = "job agent_delete secret-BBBB";
      const left = sanitizeManagedDedicatedCanaryDiagnostic(
        boundedHistoryInput(leftErrors),
        SUFFIX,
      ).jobs[index]?.unclassifiedProfile;
      const right = sanitizeManagedDedicatedCanaryDiagnostic(
        boundedHistoryInput(rightErrors),
        SUFFIX,
      ).jobs[index]?.unclassifiedProfile;

      expect(JSON.stringify(left)).toBe(JSON.stringify(right));
    },
  );

  test("uses fixed UTF-16 buckets at nonzero history positions", () => {
    const evidence = sanitizeManagedDedicatedCanaryDiagnostic(
      boundedHistoryInput(["x".repeat(64), "x".repeat(65), "😀".repeat(257)]),
      SUFFIX,
    );
    expect(
      evidence.jobs.map((job) => job.unclassifiedProfile?.lengthBucket ?? null),
    ).toEqual(["1_64", "65_128", "513_2000"]);
  });

  test.each([
    [
      "completed status",
      (job: Record<string, unknown>) => {
        job.status = "completed";
        job.result = {
          containerStopped: true,
          rowDeleted: true,
          error: null,
        };
      },
    ],
    [
      "cancelled status",
      (job: Record<string, unknown>) => {
        job.status = "cancelled";
      },
    ],
    [
      "missing claim timestamp",
      (job: Record<string, unknown>) => {
        job.startedAt = null;
      },
    ],
    [
      "terminal timestamp",
      (job: Record<string, unknown>) => {
        job.completedAt = "2026-07-26T23:11:30.000Z";
      },
    ],
    [
      "zero attempts",
      (job: Record<string, unknown>) => {
        job.attempts = 0;
      },
    ],
    [
      "failed below max attempts",
      (job: Record<string, unknown>) => {
        job.attempts = 2;
      },
    ],
    [
      "pending at max attempts",
      (job: Record<string, unknown>) => {
        job.status = "pending";
      },
    ],
  ])("rejects an unclassified job with %s", (_name, mutate) => {
    const input = unclassifiedLatestJobInput("opaque failure");
    mutate((input.jobs as Record<string, unknown>[])[0]);
    expect(() =>
      sanitizeManagedDedicatedCanaryDiagnostic(input, SUFFIX),
    ).toThrow("unclassified lifecycle is inconsistent");
  });

  test.each(["pending", "in_progress"])(
    "accepts a claimed nonterminal unclassified %s job below max attempts",
    (status) => {
      const input = unclassifiedLatestJobInput("opaque failure");
      const [job] = input.jobs as Record<string, unknown>[];
      job.status = status;
      job.attempts = 1;
      expect(
        sanitizeManagedDedicatedCanaryDiagnostic(input, SUFFIX).jobs[0],
      ).toMatchObject({
        status,
        attempts: 1,
        maxAttempts: 3,
        errorCode: "unclassified",
      });
    },
  );

  test.each([
    "Failed to delete sandbox",
    "Agent replacement cleanup is still pending",
    "Agent provisioning is in progress",
    "Agent deletion ownership changed",
  ])("accepts an exact partial result for unclassified text: %s", (error) => {
    const input = unclassifiedLatestJobInput("opaque failure");
    const [job] = input.jobs as Record<string, unknown>[];
    job.result = {
      containerStopped: false,
      rowDeleted: false,
      error,
    };
    expect(
      sanitizeManagedDedicatedCanaryDiagnostic(input, SUFFIX).jobs[0],
    ).toMatchObject({
      errorCode: "unclassified",
      containerStopped: false,
      rowDeleted: false,
    });
  });

  test.each([
    [
      "successful-looking",
      { containerStopped: true, rowDeleted: true, error: null },
    ],
    [
      "null flags",
      {
        containerStopped: null,
        rowDeleted: null,
        error: "Failed to delete sandbox",
      },
    ],
    [
      "unknown result",
      {
        containerStopped: false,
        rowDeleted: false,
        error: "opaque result",
      },
    ],
  ])("rejects an unclassified job with %s result", (_name, result) => {
    const input = unclassifiedLatestJobInput("opaque failure");
    (input.jobs as Record<string, unknown>[])[0].result = result;
    expect(() =>
      sanitizeManagedDedicatedCanaryDiagnostic(input, SUFFIX),
    ).toThrow();
  });

  test.each([0, 1, 2])(
    "keeps an unknown result error fail-closed at history index %i",
    (index) => {
      const input = boundedHistoryInput([
        "opaque failure",
        "opaque failure",
        "opaque failure",
      ]);
      (input.jobs as Record<string, unknown>[])[index].result = {
        containerStopped: false,
        rowDeleted: false,
        error: "opaque result",
      };
      expect(() =>
        sanitizeManagedDedicatedCanaryDiagnostic(input, SUFFIX),
      ).toThrow("privacy-safe classifier");
    },
  );

  test.each([1, 2])(
    "rejects malformed recovery provenance at history index %i",
    (index) => {
      const errors = [
        "opaque latest failure",
        "opaque historical failure",
        "opaque oldest failure",
      ];
      errors[index] = "Job timed out - recovered  for retry (attempt 1/3)";
      const input = boundedHistoryInput(errors);
      const job = (input.jobs as Record<string, unknown>[])[index];
      job.status = "pending";
      job.attempts = 1;

      expect(() =>
        sanitizeManagedDedicatedCanaryDiagnostic(input, SUFFIX),
      ).toThrow("malformed recovery provenance");
    },
  );

  test.each([
    [["opaque 0", "Failed to delete sandbox", "Failed to delete sandbox"], [0]],
    [["Failed to delete sandbox", "opaque 1", "Failed to delete sandbox"], [1]],
    [["Failed to delete sandbox", "Failed to delete sandbox", "opaque 2"], [2]],
    [
      ["opaque 0", "opaque 1", "Failed to delete sandbox"],
      [0, 1],
    ],
    [
      ["opaque 0", "Failed to delete sandbox", "opaque 2"],
      [0, 2],
    ],
    [
      ["Failed to delete sandbox", "opaque 1", "opaque 2"],
      [1, 2],
    ],
    [
      ["opaque 0", "opaque 1", "opaque 2"],
      [0, 1, 2],
    ],
  ])(
    "profiles only the unknown errors in a bounded history: %j",
    (errors, expectedIndexes) => {
      const evidence = sanitizeManagedDedicatedCanaryDiagnostic(
        boundedHistoryInput(errors),
        SUFFIX,
      );
      expect(evidence.jobs).toHaveLength(3);
      for (const [index, job] of evidence.jobs.entries()) {
        const isUnclassified = expectedIndexes.includes(index);
        expect(job.errorCode).toBe(
          isUnclassified ? "unclassified" : "sandbox_stop_failed",
        );
        expect(job.unclassifiedProfile === null).toBe(!isUnclassified);
      }
    },
  );

  test("keeps all known historical errors classified without profiles", () => {
    const evidence = sanitizeManagedDedicatedCanaryDiagnostic(
      boundedHistoryInput([
        "Failed to delete sandbox",
        "Agent provisioning is in progress",
        "database connection failed",
      ]),
      SUFFIX,
    );
    expect(
      evidence.jobs.map(({ errorCode, unclassifiedProfile }) => ({
        errorCode,
        unclassifiedProfile,
      })),
    ).toEqual([
      { errorCode: "sandbox_stop_failed", unclassifiedProfile: null },
      { errorCode: "provisioning_in_progress", unclassifiedProfile: null },
      { errorCode: "database_failed", unclassifiedProfile: null },
    ]);
  });

  test.each([0, 4])("rejects a %i-job history", (count) => {
    expect(() =>
      sanitizeManagedDedicatedCanaryDiagnostic(
        boundedHistoryInput(Array.from({ length: count }, () => "opaque")),
        SUFFIX,
      ),
    ).toThrow("one to three");
  });

  test("keeps an unknown sandbox error fail-closed", () => {
    const input = failedDeleteInput();
    (input.agent as Record<string, unknown>).errorMessage =
      "opaque sandbox failure";
    expect(() =>
      sanitizeManagedDedicatedCanaryDiagnostic(input, SUFFIX),
    ).toThrow("privacy-safe classifier");
  });

  test("correlates an unknown permanent-delete cause without publishing a second profile", () => {
    const cause = "opaque delete provider failure secret-AAAA";
    const canonical = canonicalizeManagedDedicatedCanaryDiagnostic(
      JSON.stringify(correlatedPermanentDeleteInput(cause)),
      SUFFIX,
    );
    const evidence = JSON.parse(canonical);

    expect(evidence).toMatchObject({
      schemaVersion: 3,
      sandbox: {
        status: "deletion_failed",
        errorCode: "unclassified",
        errorCount: 1,
      },
      jobs: [
        {
          status: "failed",
          attempts: 3,
          maxAttempts: 3,
          errorCode: "unclassified",
          unclassifiedProfile: {
            lengthBucket: "1_64",
            writerHints: {
              deleteLifecycleLike: false,
            },
          },
        },
      ],
    });
    expect(Object.keys(evidence.sandbox).sort()).toEqual(
      [
        "status",
        "errorCode",
        "errorCount",
        "deletionStartedAt",
        "updatedAt",
      ].sort(),
    );
    expect(canonical).not.toContain(cause);
    expect(canonical).not.toContain("secret-AAAA");
  });

  test("correlates a retained failure behind a newer active recovery job", () => {
    const cause = "opaque retained delete failure";
    const input = boundedHistoryInput(["opaque active retry", cause]);
    const agent = input.agent as Record<string, unknown>;
    const [active] = input.jobs as Record<string, unknown>[];
    agent.errorMessage = `Deletion permanently failed after 3 attempts: ${cause}`;
    agent.errorCount = 1;
    active.status = "pending";
    active.attempts = 1;

    const evidence = sanitizeManagedDedicatedCanaryDiagnostic(input, SUFFIX);
    expect(evidence.sandbox).toMatchObject({
      status: "deletion_pending",
      errorCode: "unclassified",
      errorCount: 1,
    });
    expect(evidence.jobs).toMatchObject([
      {
        status: "pending",
        attempts: 1,
        errorCode: "unclassified",
      },
      {
        status: "failed",
        attempts: 3,
        maxAttempts: 3,
        errorCode: "unclassified",
      },
    ]);
  });

  test("correlates a retained failure behind later failed and active recovery jobs", () => {
    const cause = "opaque retained source failure";
    const input = boundedHistoryInput([
      "opaque active retry",
      "Job timed out 3 times - max attempts reached",
      cause,
    ]);
    const agent = input.agent as Record<string, unknown>;
    const [active] = input.jobs as Record<string, unknown>[];
    agent.errorMessage = `Deletion permanently failed after 3 attempts: ${cause}`;
    agent.errorCount = 2;
    active.status = "in_progress";
    active.attempts = 1;

    const evidence = sanitizeManagedDedicatedCanaryDiagnostic(input, SUFFIX);
    expect(evidence.sandbox.errorCode).toBe("unclassified");
    expect(evidence.jobs.map(({ status }) => status)).toEqual([
      "in_progress",
      "failed",
      "failed",
    ]);
    expect(evidence.jobs[1]?.errorCode).toBe("timeout");
    expect(evidence.jobs[2]?.unclassifiedProfile).not.toBeNull();
  });

  test("correlates a retained failure behind a strict terminal recovery without an active job", () => {
    const cause = "opaque retained source failure";
    const input = boundedHistoryInput([
      "Job interrupted by worker restart 3 times - max attempts reached",
      cause,
    ]);
    const agent = input.agent as Record<string, unknown>;
    agent.errorMessage = `Deletion permanently failed after 3 attempts: ${cause}`;
    agent.errorCount = 2;

    const evidence = sanitizeManagedDedicatedCanaryDiagnostic(input, SUFFIX);
    expect(evidence.sandbox.errorCode).toBe("unclassified");
    expect(evidence.jobs[0]).toMatchObject({
      status: "failed",
      errorCode: "worker_restart_interrupted",
    });
  });

  test("rejects a retained wrapper across an unrelated newer failed job", () => {
    const cause = "opaque retained source failure";
    const input = boundedHistoryInput(["opaque ordinary failure", cause]);
    const agent = input.agent as Record<string, unknown>;
    agent.errorMessage = `Deletion permanently failed after 3 attempts: ${cause}`;
    agent.errorCount = 2;

    expect(() =>
      sanitizeManagedDedicatedCanaryDiagnostic(input, SUFFIX),
    ).toThrow("unrelated newer job");
  });

  test.each([
    "Job timed out 3 times - max attempts reached",
    "Job interrupted by worker restart 3 times - max attempts reached",
  ])("rejects a recovery-generated terminal job as wrapper source", (cause) => {
    expect(() =>
      sanitizeManagedDedicatedCanaryDiagnostic(
        correlatedPermanentDeleteInput(cause),
        SUFFIX,
      ),
    ).toThrow("does not correlate");
  });

  test("rejects coarse-code and equal-profile matches with different raw causes", () => {
    const known = correlatedPermanentDeleteInput(
      "database connection failed cause-A",
    );
    (
      (known.jobs as Record<string, unknown>[])[0] as Record<string, unknown>
    ).error = "database connection failed cause-B";
    expect(() =>
      sanitizeManagedDedicatedCanaryDiagnostic(known, SUFFIX),
    ).toThrow("does not correlate");

    const opaque = correlatedPermanentDeleteInput("SSH executor secret-AAAA");
    (
      (opaque.jobs as Record<string, unknown>[])[0] as Record<string, unknown>
    ).error = "SSH executor secret-BBBB";
    expect(() =>
      sanitizeManagedDedicatedCanaryDiagnostic(opaque, SUFFIX),
    ).toThrow("does not correlate");

    const unicode = correlatedPermanentDeleteInput("Unicode e\u0301 secret-A");
    (
      (unicode.jobs as Record<string, unknown>[])[0] as Record<string, unknown>
    ).error = "Unicode é secret-A";
    expect(() =>
      sanitizeManagedDedicatedCanaryDiagnostic(unicode, SUFFIX),
    ).toThrow("does not correlate");
  });

  test.each([
    [
      "wrapper counter mismatch",
      (input: Record<string, unknown>) => {
        (input.agent as Record<string, unknown>).errorMessage =
          "Deletion permanently failed after 2 attempts: opaque delete provider failure";
      },
    ],
    [
      "failed source below max",
      (input: Record<string, unknown>) => {
        (
          (input.jobs as Record<string, unknown>[])[0] as Record<
            string,
            unknown
          >
        ).attempts = 2;
      },
    ],
    [
      "nonfailed source",
      (input: Record<string, unknown>) => {
        const source = (input.jobs as Record<string, unknown>[])[0] as Record<
          string,
          unknown
        >;
        source.status = "in_progress";
        source.attempts = 2;
      },
    ],
    [
      "missing deletion ownership",
      (input: Record<string, unknown>) => {
        const agent = input.agent as Record<string, unknown>;
        agent.status = "deletion_pending";
        agent.deletionOwned = false;
        agent.deletionStartedAt = null;
      },
    ],
    [
      "zero persisted failure count",
      (input: Record<string, unknown>) => {
        (input.agent as Record<string, unknown>).errorCount = 0;
      },
    ],
    [
      "nondeletion sandbox status",
      (input: Record<string, unknown>) => {
        (input.agent as Record<string, unknown>).status = "running";
      },
    ],
  ])("rejects permanent-delete correlation with %s", (_name, mutate) => {
    const input = correlatedPermanentDeleteInput();
    mutate(input);
    expect(() =>
      sanitizeManagedDedicatedCanaryDiagnostic(input, SUFFIX),
    ).toThrow();
  });

  test("requires the latest job to source a deletion_failed wrapper", () => {
    const cause = "opaque older permanent failure";
    const input = boundedHistoryInput(["opaque newer failure", cause]);
    const agent = input.agent as Record<string, unknown>;
    agent.status = "deletion_failed";
    agent.errorMessage = `Deletion permanently failed after 3 attempts: ${cause}`;
    agent.errorCount = 2;

    expect(() =>
      sanitizeManagedDedicatedCanaryDiagnostic(input, SUFFIX),
    ).toThrow("latest failed deletion job");
  });

  test.each([
    "Deletion permanently failed after 0 attempts: opaque delete provider failure",
    "Deletion permanently failed after 03 attempts: opaque delete provider failure",
    "Deletion permanently failed after 101 attempts: opaque delete provider failure",
    "Deletion permanently failed after 1000 attempts: opaque delete provider failure",
    "Deletion permanently failed after 3 attempts:",
    "Deletion permanently failed after 3 attempts: Deletion permanently failed after 3 attempts: opaque",
    "deletion permanently FAILED after 3 attempts: opaque delete provider failure",
    "Deletion-permanently-failed after 3 attempts: opaque delete provider failure",
  ])("rejects a malformed or nested permanent-delete envelope", (message) => {
    const input = correlatedPermanentDeleteInput();
    (input.agent as Record<string, unknown>).errorMessage = message;
    expect(() =>
      sanitizeManagedDedicatedCanaryDiagnostic(input, SUFFIX),
    ).toThrow();
  });

  test("correlates a multiline producer error without publishing its text", () => {
    const cause =
      'Failed query: DELETE FROM "agent_sandboxes"\nparams: secret-AAAA';
    const canonical = canonicalizeManagedDedicatedCanaryDiagnostic(
      JSON.stringify(correlatedPermanentDeleteInput(cause)),
      SUFFIX,
    );
    expect(JSON.parse(canonical)).toMatchObject({
      sandbox: { errorCode: "row_delete_failed" },
      jobs: [{ errorCode: "row_delete_failed" }],
    });
    expect(canonical).not.toContain("Failed query");
    expect(canonical).not.toContain("params:");
    expect(canonical).not.toContain("secret-AAAA");
  });

  test("keeps correlated hostile causes out of canonical output", () => {
    const values = [
      "https://10.0.0.1 token secret api_key sha256:AAAA",
      "Bearer secret-AAAA ::set-output name=x::y",
      "55f332f8-da54-4c53-952c-a38f5f01287b secret-A",
      "SSH executor \u0001\u0002 secret-A",
      "Unicode e\u0301 secret-A",
    ];
    for (const cause of values) {
      const canonical = canonicalizeManagedDedicatedCanaryDiagnostic(
        JSON.stringify(correlatedPermanentDeleteInput(cause)),
        SUFFIX,
      );
      expect(canonical).not.toContain(cause);
      expect(canonical).not.toContain("secret-A");
      expect(canonical).not.toContain("55f332f8");
      expect(canonical).not.toContain("sha256:");
    }
  });

  test("keeps equal-shape correlated causes byte-identical", () => {
    const first = canonicalizeManagedDedicatedCanaryDiagnostic(
      JSON.stringify(
        correlatedPermanentDeleteInput("SSH executor secret-AAAA"),
      ),
      SUFFIX,
    );
    const second = canonicalizeManagedDedicatedCanaryDiagnostic(
      JSON.stringify(
        correlatedPermanentDeleteInput("SSH executor secret-BBBB"),
      ),
      SUFFIX,
    );
    expect(first).toBe(second);
  });

  test("does not expose which duplicate exact source was selected", () => {
    const cause = "opaque duplicate failure";
    const input = boundedHistoryInput(["opaque active retry", cause, cause]);
    const agent = input.agent as Record<string, unknown>;
    const [active] = input.jobs as Record<string, unknown>[];
    agent.errorMessage = `Deletion permanently failed after 3 attempts: ${cause}`;
    agent.errorCount = 2;
    active.status = "pending";
    active.attempts = 1;

    const canonical = canonicalizeManagedDedicatedCanaryDiagnostic(
      JSON.stringify(input),
      SUFFIX,
    );
    expect(JSON.parse(canonical).sandbox.errorCode).toBe("unclassified");
    expect(canonical).not.toContain("sourceIndex");
    expect(canonical).not.toContain(cause);
  });

  test("rejects a retained wrapper without a newer recovery lifecycle", () => {
    const input = correlatedPermanentDeleteInput();
    (input.agent as Record<string, unknown>).status = "deletion_pending";
    expect(() =>
      sanitizeManagedDedicatedCanaryDiagnostic(input, SUFFIX),
    ).toThrow("no newer recovery lifecycle");
  });

  test.each([
    [
      "has exhausted its attempt budget",
      (active: Record<string, unknown>) => {
        active.attempts = 3;
      },
    ],
    [
      "is already completed",
      (active: Record<string, unknown>) => {
        active.completedAt = "2026-07-26T23:11:30.000Z";
      },
    ],
    [
      "is in progress without a start time",
      (active: Record<string, unknown>) => {
        active.status = "in_progress";
        active.startedAt = null;
      },
    ],
  ])("rejects an active recovery that %s", (_name, mutate) => {
    const cause = "opaque retained source failure";
    const input = boundedHistoryInput([
      "Agent provisioning is in progress",
      cause,
    ]);
    const agent = input.agent as Record<string, unknown>;
    const [active] = input.jobs as Record<string, unknown>[];
    agent.errorMessage = `Deletion permanently failed after 3 attempts: ${cause}`;
    agent.errorCount = 2;
    active.status = "pending";
    active.attempts = 1;
    mutate(active);

    expect(() =>
      sanitizeManagedDedicatedCanaryDiagnostic(input, SUFFIX),
    ).toThrow("invalid active recovery ordering");
  });

  test("rejects an active recovery below a newer terminal record", () => {
    const cause = "opaque retained source failure";
    const input = boundedHistoryInput([
      "Job timed out 3 times - max attempts reached",
      "opaque misplaced active retry",
      cause,
    ]);
    const agent = input.agent as Record<string, unknown>;
    const misplacedActive = (
      input.jobs as Record<string, unknown>[]
    )[1] as Record<string, unknown>;
    agent.errorMessage = `Deletion permanently failed after 3 attempts: ${cause}`;
    agent.errorCount = 2;
    misplacedActive.status = "pending";
    misplacedActive.attempts = 1;

    expect(() =>
      sanitizeManagedDedicatedCanaryDiagnostic(input, SUFFIX),
    ).toThrow("invalid active recovery ordering");
  });

  test("enforces the full wrapped-message bound before correlation", () => {
    const prefix = "Deletion permanently failed after 3 attempts: ";
    const accepted = "x".repeat(2_000 - prefix.length);
    expect(() =>
      sanitizeManagedDedicatedCanaryDiagnostic(
        correlatedPermanentDeleteInput(accepted),
        SUFFIX,
      ),
    ).not.toThrow();

    const rejected = "x".repeat(2_001 - prefix.length);
    expect(() =>
      sanitizeManagedDedicatedCanaryDiagnostic(
        correlatedPermanentDeleteInput(rejected),
        SUFFIX,
      ),
    ).toThrow("bounded string");
  });

  test("does not create an artifact when permanent-delete correlation fails", () => {
    const directory = mkdtempSync(join(tmpdir(), "managed-canary-diagnostic-"));
    const rawPath = join(directory, "raw.json");
    const evidencePath = join(directory, "evidence.json");
    const input = correlatedPermanentDeleteInput();
    (input.agent as Record<string, unknown>).errorMessage =
      "Deletion permanently failed after 3 attempts: mismatched cause";
    writeFileSync(rawPath, JSON.stringify(input), { mode: 0o600 });

    expect(() =>
      writeManagedDedicatedCanaryDiagnostic(rawPath, evidencePath, SUFFIX),
    ).toThrow("does not correlate");
    expect(existsSync(evidencePath)).toBe(false);
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
    job.completedAt = null;

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
    job.completedAt = null;

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
    job.completedAt = null;

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
    ["missing startedAt", null, null],
    [
      "unexpected completedAt",
      "2026-07-26T23:10:31.000Z",
      "2026-07-26T23:11:31.000Z",
    ],
  ])("rejects terminal recovery with %s", (_name, startedAt, completedAt) => {
    const input = failedDeleteInput();
    const agent = input.agent as Record<string, unknown>;
    const [job] = input.jobs as Record<string, unknown>[];
    agent.status = "deletion_pending";
    agent.errorMessage = null;
    agent.errorCount = 0;
    job.error = "Job timed out 3 times - max attempts reached";
    job.result = null;
    job.startedAt = startedAt;
    job.completedAt = completedAt;

    expect(() =>
      sanitizeManagedDedicatedCanaryDiagnostic(input, SUFFIX),
    ).toThrow("recovery timestamps disagree");
  });

  test.each([
    [
      "successful result",
      { containerStopped: true, rowDeleted: true, error: null },
    ],
    [
      "database failure",
      {
        containerStopped: false,
        rowDeleted: false,
        error: "database connection failed",
      },
    ],
  ])("rejects terminal recovery with %s", (_name, result) => {
    const input = failedDeleteInput();
    const agent = input.agent as Record<string, unknown>;
    const [job] = input.jobs as Record<string, unknown>[];
    agent.status = "deletion_pending";
    agent.errorMessage = null;
    agent.errorCount = 0;
    job.error =
      "Job interrupted by worker restart 3 times - max attempts reached";
    job.result = result;
    job.completedAt = null;

    expect(() =>
      sanitizeManagedDedicatedCanaryDiagnostic(input, SUFFIX),
    ).toThrow("recovery result is not a partial failure");
  });

  test.each([
    [
      "worker_restart_recovered",
      "Job interrupted by worker restart - recovered for retry (attempt 1/3)",
    ],
    ["timeout_recovered", "Job timed out - recovered for retry (attempt 1/3)"],
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
  ])("rejects %s", (_name, status, startedAt, completedAt, expectedError) => {
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
  });

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
      const malformed = "Job timed out - recovered  for retry (attempt 1/3)";
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
      ).toThrow(
        boundary === "agent"
          ? "does not correlate"
          : "malformed recovery provenance",
      );
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

  test.each([
    ["Failed to delete sandbox", "sandbox_stop_failed"],
    [
      "Agent replacement cleanup is still pending",
      "replacement_cleanup_pending",
    ],
    ["Agent provisioning is in progress", "provisioning_in_progress"],
    ["Agent deletion ownership changed", "lifecycle_conflict"],
  ])(
    "accepts the source-owned partial terminal result: %s",
    (message, expectedCode) => {
      const input = failedDeleteInput();
      const agent = input.agent as Record<string, unknown>;
      const [job] = input.jobs as Record<string, unknown>[];
      agent.status = "deletion_pending";
      agent.errorMessage = null;
      agent.errorCount = 0;
      job.error = "Job timed out 3 times - max attempts reached";
      job.result = {
        containerStopped: false,
        rowDeleted: false,
        error: message,
      };
      job.completedAt = null;

      expect(
        sanitizeManagedDedicatedCanaryDiagnostic(input, SUFFIX).jobs[0],
      ).toMatchObject({
        errorCode: "timeout",
        recoveryCode: "none",
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
    expect(workflow).toContain("ORDER BY jobs.created_at DESC, jobs.id DESC");
    expect(workflow).toContain("LIMIT 3");
    expect(workflow).toContain("trap cleanup_incomplete_raw EXIT");
    expect(workflow).toContain(
      "trap 'rm -f -- \"$CANARY_DIAGNOSTIC_RAW_PATH\"' EXIT",
    );
    const queryCleanupFunction = workflow.indexOf("cleanup_incomplete_raw() {");
    const queryCleanupTrap = workflow.indexOf(
      "trap cleanup_incomplete_raw EXIT",
    );
    const queryExecution = workflow.indexOf('psql "$PSQL_DATABASE_URL"');
    const queryCompletion = workflow.indexOf("raw_ready=true");
    const classifyStep = workflow.indexOf(
      "- name: Classify privacy-safe diagnostic",
    );
    const classifyCleanupTrap = workflow.indexOf(
      "trap 'rm -f -- \"$CANARY_DIAGNOSTIC_RAW_PATH\"' EXIT",
    );
    const classifierExecution = workflow.indexOf(
      "bun run packages/scripts/cloud/admin/managed-dedicated-canary-diagnostic.ts",
    );
    const uploadStep = workflow.indexOf(
      "- name: Upload privacy-safe diagnostic",
    );
    expect(queryCleanupFunction).toBeGreaterThanOrEqual(0);
    expect(queryCleanupFunction).toBeLessThan(queryCleanupTrap);
    expect(queryCleanupTrap).toBeLessThan(queryExecution);
    expect(queryExecution).toBeLessThan(queryCompletion);
    expect(queryCompletion).toBeLessThan(classifyStep);
    expect(classifyStep).toBeLessThan(classifyCleanupTrap);
    expect(classifyCleanupTrap).toBeLessThan(classifierExecution);
    expect(classifierExecution).toBeLessThan(uploadStep);
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

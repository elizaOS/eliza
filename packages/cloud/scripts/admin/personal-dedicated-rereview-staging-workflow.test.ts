/** Verifies the manual workflow that owns the protected staging re-review boundary. */

import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";

type Step = {
  name?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};
const repoRoot = resolve(import.meta.dirname, "../../../..");
const workflow = parse(
  readFileSync(
    resolve(
      repoRoot,
      ".github/workflows/personal-dedicated-rereview-staging.yml",
    ),
    "utf8",
  ),
) as {
  on: { workflow_dispatch: { inputs: Record<string, { required: boolean }> } };
  permissions: Record<string, string>;
  jobs: {
    rereview: {
      environment: string;
      concurrency: Record<string, unknown>;
      env: Record<string, string>;
      steps: Step[];
    };
  };
};
const job = workflow.jobs.rereview;
const step = (name: string) => {
  const found = job.steps.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing workflow step: ${name}`);
  return found;
};

describe("personal Dedicated staging re-review workflow", () => {
  test.each([0, 7])(
    "replays complete contract output and preserves runner exit %i",
    (exitCode) => {
      const directory = mkdtempSync(join(tmpdir(), "preview-contract-output-"));
      const runner = join(directory, "bun");
      const output = "contract output\n".repeat(20000);
      const command = step("Validate operator contracts").run;
      if (!command) throw new Error("Contract validation command is missing");
      try {
        writeFileSync(
          runner,
          `#!${process.execPath}\nimport { writeFileSync } from "node:fs";\nwriteFileSync(1, "contract start\\n");\nwriteFileSync(2, ${JSON.stringify(output)});\nprocess.exit(${exitCode});\n`,
        );
        chmodSync(runner, 0o755);
        const result = Bun.spawnSync(["bash", "-e", "-c", command], {
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH}`,
            TMPDIR: directory,
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(result.exitCode).toBe(exitCode);
        expect(result.stdout.toString()).toBe(`contract start\n${output}`);
        expect(result.stderr.toString()).toBe("");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  test("is manual, staging protected, serialized, and GitHub read-only", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(job.environment).toBe("staging");
    expect(job.concurrency).toEqual({
      group: "personal-dedicated-rereview-staging",
      "cancel-in-progress": false,
    });
  });

  test.each([
    [
      "preview of the currently served older commit",
      { MODE: "preview", EXPECTED_COMMIT: "b".repeat(40) },
      0,
    ],
    [
      "execution against an older commit",
      { EXPECTED_COMMIT: "b".repeat(40) },
      1,
    ],
    ["preview from main", { MODE: "preview", REF_NAME: "refs/heads/main" }, 1],
    [
      "malformed preview commit",
      { MODE: "preview", EXPECTED_COMMIT: "invalid" },
      1,
    ],
    ["unknown operation", { MODE: "unknown" }, 1],
    ["execution without a prior digest", { APPROVAL_DIGEST: "" }, 1],
    ["execution without confirmation", { CONFIRMATION: "" }, 1],
    ["execution without a reviewed reason", { REVIEWED_REASON: "" }, 1],
    ["approved exact-head re-review", {}, 0],
    [
      "approved exact-head backup selection",
      {
        REVIEWED_REASON:
          "select_unique_verified_backup_after_duplicate_inventory_review",
        CONFIRMATION: "SELECT_UNIQUE_VERIFIED_BACKUP_WITHOUT_COMPUTE_MUTATION",
      },
      0,
    ],
  ] as const)(
    "enforces shell admission for %s",
    (_name, overrides, expectedExit) => {
      const guard = step("Require protected staging diagnostic authority");
      if (!guard.run)
        throw new Error("Deployment admission command is missing");
      const result = Bun.spawnSync({
        cmd: ["bash", "-c", guard.run],
        env: {
          ...process.env,
          REF_NAME: "refs/heads/staging",
          EXPECTED_COMMIT: "a".repeat(40),
          CHECKED_OUT_COMMIT: "a".repeat(40),
          MODE: "execute",
          APPROVAL_DIGEST: "c".repeat(64),
          REVIEWED_REASON:
            "retain_current_receipt_target_after_duplicate_inventory_review",
          CONFIRMATION: "REREVIEW_STALE_SELECTION_WITHOUT_COMPUTE_MUTATION",
          ...overrides,
        },
      });
      expect(result.exitCode).toBe(expectedExit);
    },
  );

  test("binds protected identity and smoke account authorities without artifacts", () => {
    expect(job.env.DATABASE_IDENTITY_GATE_MODE).toBe("enforce");
    expect(job.env.DATABASE_IDENTITY_ENVIRONMENT).toBe("staging");
    expect(job.env.DATABASE_URL).toContain("secrets.DATABASE_URL");
    expect(job.env.ELIZAOS_CLOUD_API_KEY).toContain(
      "secrets.ELIZAOS_CLOUD_API_KEY",
    );
    expect(step("Verify protected staging database identity").run).toContain(
      "preflight-database-identity.ts",
    );
    expect(
      job.steps.some((candidate) => candidate.run?.includes("upload-artifact")),
    ).toBe(false);
  });

  test("materializes the linked runtime required by fresh-checkout imports", () => {
    const setup = step("Setup Bun workspace");
    expect(setup.uses).toBe("./.github/actions/setup-bun-workspace");
    expect(setup.with).toMatchObject({
      "bun-version": "1.3.14",
      "setup-python": "false",
      "install-protoc": "false",
      "install-native-deps": "false",
      "run-postinstall": "false",
    });
    const linkedBuild = step("Build required linked runtime").run;
    expect(linkedBuild).toContain(
      "bun run --cwd packages/prompts build:package",
    );
    expect(linkedBuild).toContain("bun run --cwd packages/shared build");
    expect(linkedBuild).toContain("bun run --cwd packages/core build");
    expect(step("Probe fixed runtime dependencies").run).toBe(
      "bun run packages/cloud/scripts/admin/preflight-database-identity.ts --probe-dependencies",
    );
  });

  test("uses primary database authority for identity and mutation observations", () => {
    const command = readFileSync(
      resolve(
        repoRoot,
        "packages/cloud/scripts/admin/personal-dedicated-rereview-staging.ts",
      ),
      "utf8",
    );
    expect(command).not.toContain("dbRead");
    expect(command.match(/dbWrite/g)?.length).toBeGreaterThanOrEqual(7);
  });
});

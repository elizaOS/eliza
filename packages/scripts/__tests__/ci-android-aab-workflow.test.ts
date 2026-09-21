/**
 * Verifies canonical CI owns a hosted Android release AAB build and rejects
 * incomplete release evidence.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

interface WorkflowStep {
  id?: string;
  name?: string;
  if?: string;
  env?: Record<string, string>;
  run?: string;
  uses?: string;
  with?: Record<string, string | number | boolean>;
}

interface WorkflowJob {
  if?: string;
  name?: string;
  needs?: string | string[];
  outputs?: Record<string, string>;
  "runs-on"?: string;
  steps?: WorkflowStep[];
  uses?: string;
  with?: Record<string, string | number | boolean>;
}

interface Workflow {
  jobs?: Record<string, WorkflowJob>;
}

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const workflowSource = readFileSync(
  join(repoRoot, ".github/workflows/ci.yml"),
  "utf8",
);
const workflow = Bun.YAML.parse(workflowSource) as Workflow;

function requireJob(id: string): WorkflowJob {
  const job = workflow.jobs?.[id];
  if (!job) throw new Error(`Missing workflow job: ${id}`);
  return job;
}

function requireStep(job: WorkflowJob, name: string): WorkflowStep {
  const step = job.steps?.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`Missing workflow step: ${name}`);
  return step;
}

function executeShell(
  source: string,
  env: Record<string, string>,
  cwd = repoRoot,
) {
  return spawnSync("bash", ["-c", source], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

describe("consolidated Android release AAB authority", () => {
  test("keeps fork-controlled execution hosted and in the single required DAG", () => {
    const preflight = requireJob("preflight");
    const android = requireJob("android_aab");
    const required = requireJob("required");

    expect(preflight["runs-on"]).toBe("ubuntu-24.04");
    expect(android.name).toBe("Android release AAB");
    expect(android.needs).toBe("preflight");
    expect(android.if).toBeUndefined();
    expect(android["runs-on"]).toBe("ubuntu-24.04");
    expect(android["runs-on"]).not.toContain("self-hosted");
    expect(required.needs).toContain("android_aab");
    expect(required.if).toContain("always()");
    expect(required.if).toContain("!cancelled()");
    expect(
      requireStep(required, "Require every CI job to succeed").env?.RESULTS,
    ).toContain("needs.android_aab.result");
  });

  test("builds the linked runtime before the clean-checkout mobile app bundle", () => {
    const android = requireJob("android_aab");
    const dependencies = requireStep(
      android,
      "Build mobile package dependencies",
    );
    const build = requireStep(
      android,
      "Build and audit canonical Android Cloud release AAB",
    );
    const steps = android.steps ?? [];

    expect(dependencies.run).toContain("bun run build:core");
    expect(steps.indexOf(dependencies)).toBeLessThan(steps.indexOf(build));
  });

  test("verifies all four evidence files and retains separate failure diagnostics", () => {
    const android = requireJob("android_aab");
    const verify = requireStep(android, "Verify release AAB audit evidence");
    const upload = requireStep(android, "Upload verified release AAB evidence");
    const diagnostics = requireStep(
      android,
      "Upload Android failure diagnostics",
    );

    expect(verify.id).toBe("release-aab-evidence");
    expect(verify.if).toContain("always()");
    expect(verify.if).toContain("!cancelled()");
    expect(upload.if).toContain("release-aab-evidence.outcome == 'success'");
    expect(upload.if).toContain("!cancelled()");
    expect(upload.with?.["if-no-files-found"]).toBe("error");
    expect(String(upload.with?.path).trim().split(/\r?\n/)).toHaveLength(4);
    expect(diagnostics.if).toContain(
      "release-aab-evidence.outcome != 'success'",
    );
    expect(diagnostics.if).toContain("!cancelled()");
    expect(diagnostics.with?.["if-no-files-found"]).toBe("warn");

    if (!verify.run) throw new Error("AAB verifier has no executable body");
    const execute = (missing: "aab" | "audit" | null) => {
      const sandbox = mkdtempSync(join(tmpdir(), "eliza-ci-aab-evidence-"));
      const releaseDirectory = join(
        sandbox,
        "packages/app-core/platforms/android/app/build/outputs/bundle/release",
      );
      const aabPath = join(releaseDirectory, "app-release.aab");
      const auditPath = join(sandbox, "android-cloud-release-aab-audit.log");
      const attestationPath = join(
        sandbox,
        "android-cloud-release-attestation.json",
      );
      const digestPath = join(sandbox, "android-cloud-release-aab.sha256");
      const bytes = Buffer.from("consolidated-ci-aab");
      const attestation = {
        bundletool: { version: "1.18.3" },
        artifact: {
          sha256: createHash("sha256").update(bytes).digest("hex"),
          sizeBytes: bytes.byteLength,
        },
      };
      mkdirSync(releaseDirectory, { recursive: true });
      if (missing !== "aab") writeFileSync(aabPath, bytes);
      if (missing !== "audit") {
        writeFileSync(
          auditPath,
          `[mobile-build] android-cloud AAB attestation ${JSON.stringify(attestation)}\n`,
        );
      }
      try {
        const result = executeShell(
          verify.run as string,
          {
            RUNNER_TEMP: sandbox,
          },
          sandbox,
        );
        return {
          result,
          attestationExists: existsSync(attestationPath),
          digestExists: existsSync(digestPath),
        };
      } finally {
        rmSync(sandbox, { recursive: true, force: true });
      }
    };

    expect(execute(null)).toMatchObject({
      result: { status: 0 },
      attestationExists: true,
      digestExists: true,
    });
    expect(execute("aab").result.status).toBe(1);
    expect(execute("audit").result.status).toBe(1);
  });
});

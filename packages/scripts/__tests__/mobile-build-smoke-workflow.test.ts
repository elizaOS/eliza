/**
 * Binds the canonical Android release AAB build to the always-emitted develop
 * pull-request authority and its fail-closed four-file evidence contract.
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
import { REQUIRED_CHECKS } from "../develop-pr-aggregate.mjs";

const repoRoot = new URL("../../../", import.meta.url);
const mobileWorkflowSource = readFileSync(
  new URL(".github/workflows/mobile-build-smoke.yml", repoRoot),
  "utf8",
);
const aggregateWorkflowSource = readFileSync(
  new URL(".github/workflows/develop-pr-gate.yml", repoRoot),
  "utf8",
);
const developWorkflowSource = readFileSync(
  new URL(".github/workflows/develop-pr.yml", repoRoot),
  "utf8",
);

interface WorkflowStep {
  id?: string;
  name?: string;
  if?: string;
  env?: Record<string, string>;
  run?: string;
  with?: Record<string, string | number | boolean>;
  "continue-on-error"?: boolean | string;
}

interface WorkflowJob {
  name?: string;
  needs?: string | string[];
  if?: string;
  env?: Record<string, string>;
  steps?: WorkflowStep[];
  "continue-on-error"?: boolean | string;
  "timeout-minutes"?: number;
}

interface Workflow {
  on?: {
    pull_request?: {
      branches?: string[];
      types?: string[];
      paths?: string[];
      "paths-ignore"?: string[];
    };
  };
  jobs?: Record<string, WorkflowJob>;
}

const mobileWorkflow = Bun.YAML.parse(mobileWorkflowSource) as Workflow;
const aggregateWorkflow = Bun.YAML.parse(aggregateWorkflowSource) as Workflow;

function requireJob(workflow: Workflow, id: string): WorkflowJob {
  const job = workflow.jobs?.[id];
  if (!job) throw new Error(`Missing workflow job: ${id}`);
  return job;
}

function requireStep(job: WorkflowJob, name: string): WorkflowStep {
  const step = job.steps?.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`Missing workflow step: ${name}`);
  return step;
}

describe("mobile build smoke required AAB authority", () => {
  test("owns one always-emitted develop PR context required by the aggregate", () => {
    expect(mobileWorkflow.on?.pull_request?.branches).toEqual([
      "develop",
      "main",
    ]);
    expect(mobileWorkflow.on?.pull_request?.paths).toBeUndefined();
    expect(mobileWorkflow.on?.pull_request?.["paths-ignore"]).toBeUndefined();

    const gate = requireJob(mobileWorkflow, "android-release-aab-required");
    expect(gate.name).toBe("Android release AAB gate");
    expect(gate.needs).toEqual(["changes", "build-android"]);
    expect(gate.if).toBe("always()");
    expect(gate["continue-on-error"]).toBeUndefined();

    expect(
      REQUIRED_CHECKS.find(
        ({ context }) => context === "Android release AAB gate",
      ),
    ).toEqual({
      context: "Android release AAB gate",
      workflowPath: ".github/workflows/mobile-build-smoke.yml",
      triggerActions: [
        "opened",
        "synchronize",
        "reopened",
        "ready_for_review",
        "labeled",
      ],
    });
  });

  test("executes the required gate across selected and failure states", () => {
    const gate = requireJob(mobileWorkflow, "android-release-aab-required");
    const step = requireStep(
      gate,
      "Enforce the selected Android release AAB result",
    );
    expect(step.env).toEqual({
      CLASSIFIER_RESULT: "$" + "{{ needs.changes.result }}",
      ANDROID_SELECTED: "$" + "{{ needs.changes.outputs.android }}",
      ANDROID_BUILD_RESULT: "$" + "{{ needs.build-android.result }}",
    });
    if (!step.run) throw new Error("Required gate step has no executable body");

    const run = (env: Record<string, string>) =>
      spawnSync("bash", ["-c", step.run as string], {
        encoding: "utf8",
        env: { ...process.env, ...env },
      });
    const classifierFailure = run({
      CLASSIFIER_RESULT: "failure",
      ANDROID_SELECTED: "",
      ANDROID_BUILD_RESULT: "skipped",
    });
    expect(classifierFailure.status).toBe(1);
    expect(classifierFailure.stdout).toContain(
      "Mobile path classification concluded failure",
    );

    const unselected = run({
      CLASSIFIER_RESULT: "success",
      ANDROID_SELECTED: "false",
      ANDROID_BUILD_RESULT: "skipped",
    });
    expect(unselected.status).toBe(0);
    expect(unselected.stdout).toContain("not selected");

    const buildFailure = run({
      CLASSIFIER_RESULT: "success",
      ANDROID_SELECTED: "true",
      ANDROID_BUILD_RESULT: "failure",
    });
    expect(buildFailure.status).toBe(1);
    expect(buildFailure.stdout).toContain(
      "Selected Android release AAB build concluded failure",
    );

    const success = run({
      CLASSIFIER_RESULT: "success",
      ANDROID_SELECTED: "true",
      ANDROID_BUILD_RESULT: "success",
    });
    expect(success.status).toBe(0);
    expect(success.stdout).toContain("build and evidence contract passed");
  });

  test("fails closed unless every release evidence file exists", () => {
    const build = requireJob(mobileWorkflow, "build-android");
    const verify = requireStep(build, "Verify release AAB audit evidence");
    const upload = requireStep(build, "Upload release AAB audit evidence");
    const stepNames = build.steps?.map(({ name }) => name) ?? [];

    expect(stepNames.indexOf(verify.name)).toBeLessThan(
      stepNames.indexOf(upload.name),
    );
    expect(verify.id).toBe("release-aab-evidence");
    expect(verify.if).toBe("always()");
    expect(verify["continue-on-error"]).toBeUndefined();
    expect(upload.if).toBe(
      "$" + "{{ always() && steps.release-aab-evidence.outcome == 'success' }}",
    );
    expect(upload["continue-on-error"]).toBeUndefined();
    expect(upload.with?.["if-no-files-found"]).toBe("error");
    expect(String(upload.with?.path).trim().split(/\r?\n/)).toEqual([
      "packages/app-core/platforms/android/app/build/outputs/bundle/release/app-release.aab",
      "$" + "{{ runner.temp }}/android-cloud-release-aab-audit.log",
      "$" + "{{ runner.temp }}/android-cloud-release-aab.sha256",
      "$" + "{{ runner.temp }}/android-cloud-release-attestation.json",
    ]);
  });

  test("executes the evidence verifier and rejects a missing input artifact", () => {
    const build = requireJob(mobileWorkflow, "build-android");
    const verify = requireStep(build, "Verify release AAB audit evidence");
    if (!verify.run)
      throw new Error("Evidence verifier has no executable body");

    const execute = (missing: "aab" | "audit" | null) => {
      const sandbox = mkdtempSync(join(tmpdir(), "eliza-aab-evidence-"));
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
      const aabBytes = Buffer.from("workflow-contract-aab");
      const attestation = {
        bundletool: { version: "1.18.3" },
        artifact: {
          sha256: createHash("sha256").update(aabBytes).digest("hex"),
          sizeBytes: aabBytes.byteLength,
        },
      };

      mkdirSync(releaseDirectory, { recursive: true });
      if (missing !== "aab") writeFileSync(aabPath, aabBytes);
      if (missing !== "audit") {
        writeFileSync(
          auditPath,
          `[mobile-build] android-cloud AAB attestation ${JSON.stringify(attestation)}\n`,
        );
      }

      try {
        const result = spawnSync("bash", ["-c", verify.run as string], {
          cwd: sandbox,
          encoding: "utf8",
          env: { ...process.env, RUNNER_TEMP: sandbox },
        });
        return {
          result,
          attestationExists: existsSync(attestationPath),
          digestExists: existsSync(digestPath),
        };
      } finally {
        rmSync(sandbox, { recursive: true, force: true });
      }
    };

    const complete = execute(null);
    expect(complete.result.status).toBe(0);
    expect(complete.attestationExists).toBe(true);
    expect(complete.digestExists).toBe(true);

    expect(execute("aab").result.status).toBe(1);
    expect(execute("audit").result.status).toBe(1);
  });

  test("keeps the aggregate alive beyond the selected Android build budget", () => {
    const build = requireJob(mobileWorkflow, "build-android");
    const aggregate = requireJob(aggregateWorkflow, "gate");
    expect(aggregate["timeout-minutes"]).toBeGreaterThan(
      build["timeout-minutes"] ?? 0,
    );
    expect(Number(aggregate.env?.POLL_TIMEOUT_SECONDS)).toBeGreaterThan(
      (build["timeout-minutes"] ?? 0) * 60,
    );
  });

  test("actionlint covers the newly required owner workflow", () => {
    expect(developWorkflowSource).toContain(
      ".github/workflows/mobile-build-smoke.yml",
    );
  });
});

/**
 * Contract for the label-gated device-bundle workflow (#19640, #14336).
 *
 * The CI consolidation removed every live route to the exact-head Android and
 * iOS device-bundle proof. device-e2e.yml restores one: this suite pins that
 * the `ci:device` label actually reaches BOTH bundle-owning runners
 * (android-e2e.mjs / ios-e2e.mjs) with `--output` inside the uploaded artifact
 * root, that the uploads run `if: always()` so an induced failure still ships
 * a bundle, that the bundle producers emit the required inline/, logs/,
 * summary.json, and junit.xml members, and that the workflow stays
 * credential-free for fork PRs with pinned toolchains and SHA-pinned actions.
 * Parses the real workflow YAML; deterministic, no network or devices.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const repoRoot = new URL("../../../", import.meta.url);

function read(path: string): string {
  return readFileSync(new URL(path, repoRoot), "utf8");
}

interface WorkflowStep {
  if?: string;
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string>;
}

interface WorkflowJob {
  env?: Record<string, string>;
  if?: string;
  "runs-on"?: string;
  steps?: WorkflowStep[];
  "timeout-minutes"?: number;
}

interface CallerJob {
  if?: string;
  needs?: string[];
  uses?: string;
}

interface Workflow {
  concurrency?: { group?: string; "cancel-in-progress"?: boolean | string };
  env?: Record<string, string>;
  jobs?: Record<string, WorkflowJob>;
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
}

const workflowSource = read(".github/workflows/device-e2e.yml");
const workflow = Bun.YAML.parse(workflowSource) as Workflow;
const ci = Bun.YAML.parse(read(".github/workflows/ci.yml")) as {
  jobs?: Record<string, CallerJob>;
};

const androidJob = workflow.jobs?.["android-device-bundle"];
const iosJob = workflow.jobs?.["ios-simulator-bundle"];

function requireJob(job: WorkflowJob | undefined, name: string): WorkflowJob {
  if (!job) throw new Error(`Missing device-e2e job: ${name}`);
  return job;
}

function findStep(
  job: WorkflowJob,
  predicate: (step: WorkflowStep) => boolean,
  label: string,
): WorkflowStep {
  const step = job.steps?.find(predicate);
  if (!step) throw new Error(`Missing device-e2e step: ${label}`);
  return step;
}

describe("device-e2e workflow trigger reaches both bundle producers (#19640)", () => {
  test("canonical ci.yml calls the producer workflow behind the ci:device label gate", () => {
    const caller = ci.jobs?.device;
    if (!caller) throw new Error("ci.yml is missing the device caller job");
    expect(caller.uses).toBe("./.github/workflows/device-e2e.yml");
    expect(caller.if).toContain(
      "contains(github.event.pull_request.labels.*.name, 'ci:device')",
    );
    expect(caller.if).toContain("github.event_name == 'pull_request'");
  });

  test("an unlabeled PR's skipped device job cannot fail the merge gate", () => {
    const required = ci.jobs?.required;
    if (!required) throw new Error("ci.yml is missing the required job");
    expect(required.needs).not.toContain("device");
  });

  test("the producer stays callable and dispatchable but never directly PR/push triggered", () => {
    expect(workflow.on && "workflow_call" in workflow.on).toBe(true);
    expect(workflow.on && "workflow_dispatch" in workflow.on).toBe(true);
    expect(workflow.on && "pull_request" in (workflow.on ?? {})).toBe(false);
    expect(workflow.on && "push" in (workflow.on ?? {})).toBe(false);
  });

  test("the Android job invokes the bundle-owning runner with --output inside the artifact root", () => {
    const job = requireJob(androidJob, "android-device-bundle");
    const runner = findStep(
      job,
      (step) =>
        step.uses?.startsWith("reactivecircus/android-emulator-runner@") ===
        true,
      "Android emulator runner",
    );
    const script = runner.with?.script ?? "";
    expect(script).toContain("packages/app/scripts/android-e2e.mjs");
    expect(script).toContain('--output "$ELIZA_DEVICE_BUNDLE_ROOT/android"');
    expect(job.env?.ELIZA_DEVICE_BUNDLE_ROOT).toBe(
      "${{ github.workspace }}/device-e2e-artifacts",
    );
  });

  test("the iOS job invokes ios-e2e.mjs with --output inside the artifact root", () => {
    const job = requireJob(iosJob, "ios-simulator-bundle");
    expect(job["runs-on"]).toMatch(/^macos-/);
    const runner = findStep(
      job,
      (step) => step.run?.includes("packages/app/scripts/ios-e2e.mjs") === true,
      "iOS bundle runner",
    );
    expect(runner.run).toContain('--output "$ELIZA_DEVICE_BUNDLE_ROOT/ios"');
    expect(job.env?.ELIZA_DEVICE_BUNDLE_ROOT).toBe(
      "${{ github.workspace }}/device-e2e-artifacts",
    );
  });

  test("both uploads run if: always() and cover the exact --output roots", () => {
    const android = findStep(
      requireJob(androidJob, "android-device-bundle"),
      (step) => step.uses?.startsWith("actions/upload-artifact@") === true,
      "Android upload",
    );
    expect(android.if).toBe("always()");
    expect(android.with?.path).toContain("device-e2e-artifacts/android/**");

    const ios = findStep(
      requireJob(iosJob, "ios-simulator-bundle"),
      (step) => step.uses?.startsWith("actions/upload-artifact@") === true,
      "iOS upload",
    );
    expect(ios.if).toBe("always()");
    expect(ios.with?.path).toContain("device-e2e-artifacts/ios/**");
  });
});

describe("device-e2e bundle producers emit the required bundle members", () => {
  const bundleLib = read("packages/app/scripts/lib/device-e2e-bundle.mjs");

  test("createDeviceE2eBundle materializes inline/, logs/, and summary.json at the root", () => {
    expect(bundleLib).toContain('path.join(root, "inline")');
    expect(bundleLib).toContain('path.join(root, "logs")');
    expect(bundleLib).toContain('path.join(root, "summary.json")');
  });

  test("finalize writes junit.xml at the bundle root", () => {
    expect(bundleLib).toContain('path.join(bundle.root, "junit.xml")');
  });

  test("both runners create and honor the --output bundle root", () => {
    for (const runnerPath of [
      "packages/app/scripts/android-e2e.mjs",
      "packages/app/scripts/ios-e2e.mjs",
    ]) {
      const source = read(runnerPath);
      expect(source).toContain("createDeviceE2eBundle");
      expect(source).toContain("finalizeDeviceE2eBundle");
      expect(source).toMatch(/parseOutputDirArg|flags\.output/);
    }
  });
});

describe("device-e2e workflow hygiene", () => {
  test("toolchains are pinned to the repository versions", () => {
    expect(workflow.env?.BUN_VERSION).toBe("1.3.14");
    expect(workflow.env?.NODE_VERSION).toBe("24.15.0");
  });

  test("every third-party action is pinned by full commit SHA", () => {
    const uses = [...workflowSource.matchAll(/uses:\s*([^\s]+)/g)]
      .map((match) => match[1])
      .filter((ref) => !ref.startsWith("./"));
    expect(uses.length).toBeGreaterThan(0);
    for (const ref of uses) {
      expect(ref).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  test("permissions are read-only and no repository secrets are referenced (fork-safe)", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflowSource).not.toContain("secrets.");
  });

  test("jobs carry bounded timeouts and the workflow cancels superseded runs", () => {
    expect(requireJob(androidJob, "android")["timeout-minutes"]).toBe(90);
    expect(requireJob(iosJob, "ios")["timeout-minutes"]).toBe(90);
    expect(workflow.concurrency?.["cancel-in-progress"]).toBe(true);
  });
});

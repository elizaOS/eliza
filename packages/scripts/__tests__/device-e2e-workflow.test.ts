/**
 * Contract for hosted and ARM64 Android device-bundle workflows
 * (#19640, #14336, #13580).
 *
 * The CI consolidation removed every live route to the exact-head Android and
 * iOS device-bundle proof. device-e2e.yml restores one: this suite pins that
 * the `ci:device` label actually reaches BOTH bundle-owning runners
 * (android-e2e.mjs / ios-e2e.mjs) with `--output` inside the uploaded artifact
 * root, that the uploads run `if: always()` so an induced failure still ships
 * a bundle, that the bundle producers emit the required inline/, logs/,
 * summary.json, and junit.xml members, and that the Android-only cadence has a
 * least-privilege stable-issue failure signal without scheduling iOS. The
 * workflow stays credential-free for fork PRs with pinned toolchains and
 * SHA-pinned actions.
 * Parses the real workflow YAML; deterministic, no network or devices.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = new URL("../../../", import.meta.url);

function read(path: string): string {
  return readFileSync(new URL(path, repoRoot), "utf8");
}

const workflowExpression = (body: string): string => `\${{ ${body} }}`;

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
  needs?: string | string[];
  permissions?: Record<string, string>;
  "runs-on"?: string | string[];
  steps?: WorkflowStep[];
  "timeout-minutes"?: number;
}

interface CallerJob {
  if?: string;
  needs?: string[];
  permissions?: Record<string, string>;
  uses?: string;
}

interface Workflow {
  concurrency?: {
    group?: string;
    "cancel-in-progress"?: boolean | string;
    queue?: string;
  };
  env?: Record<string, string>;
  jobs?: Record<string, WorkflowJob>;
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
}

const workflowSource = read(".github/workflows/device-e2e.yml");
const workflow = Bun.YAML.parse(workflowSource) as Workflow;
const arm64WorkflowSource = read(
  ".github/workflows/android-arm64-local-e2e.yml",
);
const arm64Workflow = Bun.YAML.parse(arm64WorkflowSource) as Workflow;
const androidRunnerSource = read("packages/app/scripts/android-e2e.mjs");
const androidRouteCoverageSource = read(
  "packages/app/test/android/route-coverage.android.spec.ts",
);
const arm64PreflightSource = read(
  ".github/scripts/device-e2e/arm64-local-preflight.sh",
);
const workflowReadme = read(".github/workflows/README.md");
const ci = Bun.YAML.parse(read(".github/workflows/ci.yml")) as {
  jobs?: Record<string, CallerJob>;
};

const androidJob = workflow.jobs?.["android-device-bundle"];
const iosJob = workflow.jobs?.["ios-simulator-bundle"];
const notifierJob = workflow.jobs?.["reconcile-scheduled-android-status"];

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

  test("the caller grants every permission a nested producer job requests", () => {
    // GitHub validates the compiled workflow_call graph before evaluating any
    // job `if`, so a nested job requesting more than the caller allows fails
    // the whole CI run at startup — this regressed on develop when the
    // schedule-only notifier gained actions:read/issues:write (#22527).
    const caller = ci.jobs?.device;
    if (!caller) throw new Error("ci.yml is missing the device caller job");
    const granted = caller.permissions ?? {};
    const rank = (level: string | undefined): number =>
      level === "write" ? 2 : level === "read" ? 1 : 0;
    for (const [name, job] of Object.entries(workflow.jobs ?? {})) {
      const requested = job.permissions ?? workflow.permissions ?? {};
      for (const [scope, level] of Object.entries(requested)) {
        if (rank(granted[scope]) < rank(level)) {
          throw new Error(
            `ci.yml device caller grants '${scope}: ${granted[scope] ?? "none"}' ` +
              `but device-e2e job '${name}' requests '${scope}: ${level}'`,
          );
        }
      }
    }
  });

  test("an unlabeled PR's skipped device job cannot fail the merge gate", () => {
    const required = ci.jobs?.required;
    if (!required) throw new Error("ci.yml is missing the required job");
    expect(required.needs).not.toContain("device");
  });

  test("the producer stays callable and dispatchable but never directly PR/push triggered", () => {
    expect(workflow.on && "schedule" in workflow.on).toBe(true);
    expect(workflow.on && "workflow_call" in workflow.on).toBe(true);
    expect(workflow.on && "workflow_dispatch" in workflow.on).toBe(true);
    expect(workflow.on && "pull_request" in (workflow.on ?? {})).toBe(false);
    expect(workflow.on && "push" in (workflow.on ?? {})).toBe(false);
  });

  test("scheduled failures have a visible event-filtered workflow badge", () => {
    expect(workflowReadme).toContain(
      "actions/workflows/device-e2e.yml/badge.svg?branch=develop&event=schedule",
    );
    expect(workflowReadme).toContain(
      "actions/workflows/device-e2e.yml?query=event%3Aschedule",
    );
  });

  test("the weekly schedule spends only Android while calls and dispatches retain iOS", () => {
    expect(androidJob?.if).toBeUndefined();
    expect(iosJob?.if).toContain("github.event_name != 'schedule'");
    expect(workflowReadme).toContain(
      "scheduled runs do not allocate the macOS/iOS job",
    );
  });

  test("scheduled Android results reconcile one actionable issue with least privilege", () => {
    const notifier = requireJob(
      notifierJob,
      "reconcile-scheduled-android-status",
    );
    expect(notifier.needs).toBe("android-device-bundle");
    expect(notifier.if).toContain("always()");
    expect(notifier.if).toContain("github.event_name == 'schedule'");
    expect(notifier.permissions).toEqual({
      actions: "read",
      contents: "read",
      issues: "write",
    });
    const notification = findStep(
      notifier,
      (step) => step.uses?.startsWith("actions/github-script@") === true,
      "scheduled Android status reconciliation",
    );
    expect(notification.uses).toBe(
      "actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3",
    );
    const script = notification.with?.script ?? "";
    expect(script).toContain("listWorkflowRunArtifacts");
    expect(script).toContain("artifact.id");
    expect(script).toContain("context.runAttempt");
    expect(script).toContain(
      "android-device-e2e-bundle-${context.runId}-${context.runAttempt}",
    );
    expect(script).toContain("github.rest.search.issuesAndPullRequests");
    expect(script).toContain("github.rest.issues.update");
    expect(script).toContain("github.rest.issues.create");
    expect(script).toContain('if (result === "success")');
    expect(script).toContain('state: "closed"');
    expect(script).toContain('state_reason: "completed"');
    expect(script).not.toContain("createComment");
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
    expect(script).toContain("--start-host-agent");
    expect(script).toContain("--host-emulator-probes");
    expect(script).toContain("--skip-local-chat");
    expect(job.env?.ELIZA_DEVICE_BUNDLE_ROOT).toBe(
      "${{ github.workspace }}/device-e2e-artifacts",
    );
  });

  test("the iOS job invokes ios-e2e.mjs with --output inside the artifact root", () => {
    const job = requireJob(iosJob, "ios-simulator-bundle");
    expect(job.if).toBe("github.event_name != 'schedule'");
    expect(String(job["runs-on"])).toMatch(/^macos-/);
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
    const androidBootstrap = findStep(
      requireJob(androidJob, "android-device-bundle"),
      (step) => step.name === "Initialize Android artifact root",
      "Android artifact bootstrap",
    );
    expect(androidBootstrap.run).toContain("workflow-bootstrap.txt");
    expect(androidBootstrap.run).toContain('"$GITHUB_SHA"');
    const android = findStep(
      requireJob(androidJob, "android-device-bundle"),
      (step) => step.uses?.startsWith("actions/upload-artifact@") === true,
      "Android upload",
    );
    expect(android.if).toBe("always()");
    expect(android.with?.name).toBe(
      `android-device-e2e-bundle-${workflowExpression("github.run_id")}-${workflowExpression("github.run_attempt")}`,
    );
    expect(android.with?.path).toContain("device-e2e-artifacts/android/**");
    expect(android.with?.["if-no-files-found"]).toBe("error");

    const iosBootstrap = findStep(
      requireJob(iosJob, "ios-simulator-bundle"),
      (step) => step.name === "Initialize iOS artifact root",
      "iOS artifact bootstrap",
    );
    expect(iosBootstrap.run).toContain("workflow-bootstrap.txt");
    expect(iosBootstrap.run).toContain('"$GITHUB_SHA"');
    const ios = findStep(
      requireJob(iosJob, "ios-simulator-bundle"),
      (step) => step.uses?.startsWith("actions/upload-artifact@") === true,
      "iOS upload",
    );
    expect(ios.if).toBe("always()");
    expect(ios.with?.name).toBe(
      `ios-simulator-e2e-bundle-${workflowExpression("github.run_id")}-${workflowExpression("github.run_attempt")}`,
    );
    expect(ios.with?.path).toContain("device-e2e-artifacts/ios/**");
    expect(ios.with?.["if-no-files-found"]).toBe("error");
  });
});

describe("Android probe partitioning (#13580)", () => {
  test("hosted x86 hard-gates only the explicit host-safe probe set", () => {
    for (const path of [
      "test/android/onboarding-to-home.android.spec.ts",
      "test/android/route-coverage.android.spec.ts",
      "test/android/native-plugin-view-smoke.android.spec.ts",
    ]) {
      expect(androidRunnerSource).toContain(path);
    }
    const hostSet = androidRunnerSource.match(
      /const HOST_EMULATOR_PROBES = \[([\s\S]*?)\];/,
    )?.[1];
    expect(hostSet).toBeTruthy();
    expect(hostSet).not.toContain("local-runtime.android.spec.ts");
    expect(hostSet).not.toContain("voice-selftest.android.spec.ts");
    expect(hostSet).not.toContain("lifecycle.android.spec.ts");
    expect(hostSet).not.toContain("launcher-gesture-loop.android.spec.ts");
    expect(androidRunnerSource).toContain("startDeviceE2eHostAgent");
    expect(androidRunnerSource).toContain("await hostAgent.stop()");
  });

  test("route coverage proves the requested path and canonical page marker", () => {
    expect(androidRouteCoverageSource).toContain("window.location.pathname");
    expect(androidRouteCoverageSource).toContain("route.readyChecks");
    expect(androidRouteCoverageSource).toContain("expectRouteReady(");
  });

  test("ARM64 local set includes chat-backed WebView proof but excludes voice", () => {
    const localSet = androidRunnerSource.match(
      /const ARM64_LOCAL_PROBES = \[([\s\S]*?)\];/,
    )?.[1];
    expect(localSet).toContain("local-runtime.android.spec.ts");
    expect(localSet).toContain("route-coverage.android.spec.ts");
    expect(localSet).not.toContain("voice-selftest.android.spec.ts");
    expect(androidRunnerSource).toContain(
      "--arm64-local-probes must run the local chat smoke",
    );
  });

  test("invalid host/local selection exits nonzero with a finalized failed bundle", () => {
    const output = mkdtempSync(path.join(os.tmpdir(), "eliza-android-lane-"));
    try {
      const result = spawnSync(
        process.execPath,
        [
          path.join(
            fileURLToPath(repoRoot),
            "packages/app/scripts/android-e2e.mjs",
          ),
          "--host-emulator-probes",
          "--skip-local-chat",
          "--output",
          output,
        ],
        {
          cwd: fileURLToPath(repoRoot),
          encoding: "utf8",
          env: { ...process.env, ELIZA_ANDROID_BACKEND: "local" },
        },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "--host-emulator-probes requires ELIZA_ANDROID_BACKEND=host",
      );
      expect(existsSync(path.join(output, "summary.json"))).toBe(true);
      expect(existsSync(path.join(output, "junit.xml"))).toBe(true);
      const summary = JSON.parse(
        readFileSync(path.join(output, "summary.json"), "utf8"),
      ) as { result: string; steps: Array<{ name: string; status: string }> };
      expect(summary.result).toBe("failed");
      expect(summary.steps).toContainEqual(
        expect.objectContaining({
          name: "validate Android lane selection",
          status: "failed",
        }),
      );
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});

describe("ARM64 local-runtime workflow (#13580)", () => {
  const armJob = arm64Workflow.jobs?.["android-arm64-local-runtime"];

  test("is schedule-only and cannot execute an arbitrary dispatched ref", () => {
    expect(arm64Workflow.on && "schedule" in arm64Workflow.on).toBe(true);
    expect(arm64Workflow.on && "workflow_dispatch" in arm64Workflow.on).toBe(
      false,
    );
    expect(arm64Workflow.on && "pull_request" in arm64Workflow.on).toBe(false);
    expect(arm64Workflow.on && "push" in arm64Workflow.on).toBe(false);
  });

  test("serializes physical-device mutation without cancelling an active run", () => {
    expect(arm64Workflow.concurrency?.group).toBe("android-arm64-local-e2e");
    expect(arm64Workflow.concurrency?.["cancel-in-progress"]).toBe(false);
    expect(arm64Workflow.concurrency?.queue).toBe("max");
  });

  test("requires the exact self-hosted device labels", () => {
    expect(
      requireJob(armJob, "android-arm64-local-runtime")["runs-on"],
    ).toEqual(["self-hosted", "Linux", "ARM64", "android-device"]);
  });

  test("fails closed on pinned ARM64 host/device prerequisites", () => {
    expect(arm64PreflightSource).toContain('"v24.15.0"');
    expect(arm64PreflightSource).toContain('"1.3.14"');
    expect(arm64PreflightSource).toContain("process.arch");
    expect(arm64PreflightSource).toContain("uname -m");
    expect(arm64PreflightSource).toContain("java.specification.version");
    expect(arm64PreflightSource).toContain('"21"');
    expect(arm64PreflightSource).toContain('"arm64-v8a"');
    expect(arm64PreflightSource).toContain("sys.boot_completed");
    expect(arm64PreflightSource).toContain("GITHUB_ENV");
  });

  test("runs the explicit local probe set and uploads exact artifacts honestly", () => {
    const job = requireJob(armJob, "android-arm64-local-runtime");
    const preflight = findStep(
      job,
      (step) => step.name === "Fail-closed ARM64 device preflight",
      "ARM64 preflight",
    );
    expect(preflight.run).toContain("arm64-local-preflight.sh 2>&1");
    expect(preflight.run).toContain("arm64-preflight.log");
    const runner = findStep(
      job,
      (step) => step.run?.includes("--arm64-local-probes") === true,
      "ARM64 local runner",
    );
    expect(runner.run).toContain("packages/app/scripts/android-e2e.mjs");
    expect(runner.run).toContain("--no-emulator-boot");
    expect(runner.run).toContain(
      '--output "$ELIZA_DEVICE_BUNDLE_ROOT/android-arm64-local"',
    );
    const upload = findStep(
      job,
      (step) => step.uses?.startsWith("actions/upload-artifact@") === true,
      "ARM64 upload",
    );
    expect(upload.if).toBe("always()");
    expect(upload.with?.name).toBe(
      `android-arm64-local-runtime-bundle-${workflowExpression("github.run_id")}-${workflowExpression("github.run_attempt")}`,
    );
    expect(upload.with?.path).toContain(
      "device-e2e-artifacts/android-arm64-local/**",
    );
    expect(upload.with?.["if-no-files-found"]).toBe("error");
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
    const uses = [
      ...workflowSource.matchAll(/uses:\s*([^\s]+)/g),
      ...arm64WorkflowSource.matchAll(/uses:\s*([^\s]+)/g),
    ]
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

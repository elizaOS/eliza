/**
 * Verifies the consolidated CI workflow owns a hosted, path-selected Android
 * release AAB build with exact selector semantics and fail-closed evidence.
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
const classifier = join(repoRoot, "packages/scripts/ci-path-gate.mjs");

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

function classify(paths: string[]) {
  const sandbox = mkdtempSync(join(tmpdir(), "eliza-ci-android-paths-"));
  const changedFiles = join(sandbox, "changed-files.txt");
  const output = join(sandbox, "output.txt");
  const summary = join(sandbox, "summary.md");
  writeFileSync(changedFiles, `${paths.join("\n")}\n`);
  try {
    const result = spawnSync(
      process.execPath,
      [
        classifier,
        "--config",
        "test",
        "--event",
        "pull_request",
        "--changed-files",
        changedFiles,
        "--output",
        output,
        "--summary",
        summary,
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    return Object.fromEntries(
      readFileSync(output, "utf8")
        .trim()
        .split(/\r?\n/)
        .map((line) => line.split("=")),
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

describe("consolidated Android release AAB authority", () => {
  test("classifies every canonical AAB input family without charging docs", () => {
    for (const path of [
      ".github/workflows/ci.yml",
      ".github/actions/setup-bun-workspace/action.yml",
      "package.json",
      "bun.lock",
      "packages/agent/src/index.ts",
      "packages/app/src/main.tsx",
      "packages/app-core/scripts/run-mobile-build.mjs",
      "packages/app-core/platforms/android/app/build.gradle",
      "packages/app-core/src/runtime/app-runtime-host.ts",
      "packages/auth/src/index.ts",
      "packages/core/src/index.ts",
      "packages/native/plugins/llama/index.ts",
      "packages/shared/src/index.ts",
      "packages/ui/src/index.ts",
      "packages/vault/src/index.ts",
      "plugins/plugin-local-inference/src/index.ts",
      "plugins/plugin-sql/src/index.ts",
      "plugins/plugin-wallet/src/index.ts",
    ]) {
      expect(classify([path]).android_aab, path).toBe("true");
    }
    expect(classify(["packages/docs/pages/ci.md"]).android_aab).toBe("false");
  }, 30_000);

  test("keeps fork-controlled execution hosted and in the single required DAG", () => {
    const changes = requireJob("changes");
    const android = requireJob("android_aab");
    const required = requireJob("required");

    expect(changes.outputs?.android_aab).toBe(
      "$" + "{{ steps.filter.outputs.android_aab }}",
    );
    expect(android.name).toBe("Android release AAB");
    expect(android.needs).toBe("changes");
    expect(android.if).toBe("always()");
    expect(android["runs-on"]).toBe("ubuntu-24.04");
    expect(android["runs-on"]).not.toContain("self-hosted");
    expect(required.needs).toContain("android_aab");
    expect(
      requireStep(required, "Require every CI job to succeed").env?.RESULTS,
    ).toContain("needs.android_aab.result");
  });

  test("accepts exact booleans and rejects failed, missing, or malformed selectors", () => {
    const source = requireStep(
      requireJob("android_aab"),
      "Validate Android selection",
    ).run;
    if (!source) throw new Error("Android selector has no executable body");

    const run = (classifierResult: string, selected: string) => {
      const sandbox = mkdtempSync(join(tmpdir(), "eliza-ci-android-select-"));
      const output = join(sandbox, "output.txt");
      try {
        const result = executeShell(source, {
          CLASSIFIER_RESULT: classifierResult,
          ANDROID_SELECTED: selected,
          GITHUB_OUTPUT: output,
        });
        return {
          result,
          output: existsSync(output) ? readFileSync(output, "utf8") : "",
        };
      } finally {
        rmSync(sandbox, { recursive: true, force: true });
      }
    };

    expect(run("success", "true")).toMatchObject({
      result: { status: 0 },
      output: "selected=true\n",
    });
    expect(run("success", "false")).toMatchObject({
      result: { status: 0 },
      output: "selected=false\n",
    });
    for (const [classifierResult, selected] of [
      ["failure", "false"],
      ["cancelled", ""],
      ["success", ""],
      ["success", "falsee"],
    ]) {
      expect(run(classifierResult, selected).result.status).toBe(1);
    }
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
    expect(upload.if).toContain("release-aab-evidence.outcome == 'success'");
    expect(upload.with?.["if-no-files-found"]).toBe("error");
    expect(String(upload.with?.path).trim().split(/\r?\n/)).toHaveLength(4);
    expect(diagnostics.if).toContain(
      "release-aab-evidence.outcome != 'success'",
    );
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

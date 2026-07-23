/**
 * Static contract for the real three-platform evidence-tool installer smoke.
 * The workflow itself exercises hosted package managers and browser launches.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const repoRoot = new URL("../../../", import.meta.url);

interface WorkflowStep {
  env?: Record<string, string>;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string | number | boolean>;
  "continue-on-error"?: boolean | string;
}

interface WorkflowJob {
  permissions?: Record<string, string>;
  steps?: WorkflowStep[];
  "continue-on-error"?: boolean | string;
  strategy?: {
    "fail-fast"?: boolean;
    matrix?: {
      os?: string[];
    };
  };
}

interface Workflow {
  permissions?: Record<string, string>;
  jobs?: Record<string, WorkflowJob>;
  on?: {
    pull_request?: {
      branches?: string[];
      paths?: string[];
    };
  };
}

function loadWorkflow(): Workflow {
  return Bun.YAML.parse(
    readFileSync(
      new URL(".github/workflows/evidence-tools-platform-smoke.yml", repoRoot),
      "utf8",
    ),
  ) as Workflow;
}

function namedStep(job: WorkflowJob, name: string): WorkflowStep {
  const step = job.steps?.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`Missing workflow step: ${name}`);
  return step;
}

describe("evidence tools platform smoke workflow", () => {
  test("runs a real repeatable installer and strict doctor on every supported OS", () => {
    const workflow = loadWorkflow();
    expect(workflow.on?.pull_request?.branches).toEqual(["develop", "main"]);
    expect(workflow.permissions).toEqual({ contents: "read" });

    const job = workflow.jobs?.["install-and-probe"];
    if (!job) throw new Error("Missing install-and-probe job");
    expect(job.permissions).toEqual({ contents: "read" });
    expect(
      Object.values(workflow.jobs ?? {}).every(
        (candidate) => candidate.permissions?.contents === "read",
      ),
    ).toBe(true);
    expect(job["continue-on-error"]).toBeUndefined();
    expect(job.strategy?.["fail-fast"]).toBe(false);
    expect(job.strategy?.matrix?.os).toEqual([
      "ubuntu-latest",
      "macos-latest",
      "windows-latest",
    ]);
    expect(
      job.steps?.every((step) => step["continue-on-error"] === undefined),
    ).toBe(true);

    expect(namedStep(job, "Setup Node.js").with?.["node-version"]).toBe(
      "24.15.0",
    );
    expect(namedStep(job, "Checkout").with?.["persist-credentials"]).toBe(
      false,
    );
    expect(namedStep(job, "Setup Bun").with?.["bun-version"]).toBe("1.3.14");
    expect(namedStep(job, "Validate platform install plan").run).toBe(
      "node scripts/evidence-install-tools.mjs --dry-run --github",
    );
    expect(namedStep(job, "Record pre-install capability report").run).toBe(
      "node scripts/evidence-doctor.mjs --json > evidence-tools-before.json",
    );
    expect(namedStep(job, "Install repository tool packages").run).toBe(
      "bun install --frozen-lockfile --ignore-scripts",
    );
    const stepNames = job.steps?.map(({ name }) => name) ?? [];
    expect(
      stepNames.indexOf("Record pre-install capability report"),
    ).toBeLessThan(stepNames.indexOf("Install repository tool packages"));

    const installCommand =
      "node scripts/evidence-install-tools.mjs --skip-deps --github";
    expect(namedStep(job, "Exercise real platform installer").run).toBe(
      installCommand,
    );
    expect(namedStep(job, "Prove installer idempotence").run).toBe(
      installCommand,
    );
    expect(namedStep(job, "Require baseline capture capabilities").run).toBe(
      "node scripts/evidence-doctor.mjs --strict --json > evidence-tools-after.json",
    );
    expect(
      job.steps?.some(
        (step) =>
          step.env?.GH_TOKEN !== undefined ||
          step.run?.includes("github.token") === true,
      ),
    ).toBe(false);

    const upload = namedStep(job, "Upload normalized capability reports");
    expect(upload.if).toBe(`\${{ always() }}`);
    expect(upload.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/u);
    expect(upload.with?.["if-no-files-found"]).toBe("error");
    expect(upload.with?.path).toContain("evidence-tools-*.json");
  });

  test("tracks every implementation and lockfile input that can change the smoke", () => {
    const paths = loadWorkflow().on?.pull_request?.paths;
    for (const required of [
      ".github/workflows/evidence-tools-platform-smoke.yml",
      "scripts/evidence-doctor.mjs",
      "scripts/evidence-doctor.test.mjs",
      "scripts/evidence-install-tools.mjs",
      "scripts/evidence-install-tools.test.mjs",
      "packages/evidence/src/ffmpeg-binaries.ts",
      "CONTRIBUTING.md",
      "package.json",
      "bun.lock",
    ]) {
      expect(paths).toContain(required);
    }

    const packageJson = JSON.parse(
      readFileSync(new URL("package.json", repoRoot), "utf8"),
    ) as { scripts?: Record<string, string> };
    expect(packageJson.scripts?.["evidence:install-tools"]).toBe(
      "node scripts/evidence-install-tools.mjs",
    );
    expect(packageJson.scripts?.["evidence:doctor"]).toBe(
      "node scripts/evidence-doctor.mjs",
    );
  });
});

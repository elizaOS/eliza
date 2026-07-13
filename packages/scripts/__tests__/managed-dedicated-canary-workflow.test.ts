import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const workflowPath = new URL(
  "../../../.github/workflows/managed-dedicated-canary.yml",
  import.meta.url,
);
const workflowSource = readFileSync(workflowPath, "utf8");

interface WorkflowStep {
  id?: string;
  if?: string;
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  if?: string;
  environment?: string;
  "timeout-minutes"?: number;
  env?: Record<string, string>;
  steps?: WorkflowStep[];
}

interface Workflow {
  on?: Record<string, unknown>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  jobs?: Record<string, WorkflowJob>;
}

const workflow = Bun.YAML.parse(workflowSource) as Workflow;
const job = workflow.jobs?.canary;

function step(name: string): WorkflowStep {
  const found = job?.steps?.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing workflow step: ${name}`);
  return found;
}

describe("managed dedicated staging canary workflow (#16194)", () => {
  test("is maintainer-triggered or scheduled, staging-only, serialized, and never uses Hetzner credentials", () => {
    expect(workflow.on?.schedule).toBeDefined();
    expect(workflow.on?.workflow_dispatch).toBeDefined();
    expect(workflow.on?.pull_request).toEqual({ types: ["labeled"] });
    expect(workflow.on?.push).toBeUndefined();
    expect(job?.if).toContain("run-managed-dedicated-canary");
    expect(job?.environment).toBe("staging");
    expect(job?.["timeout-minutes"]).toBe(45);
    expect(job?.env?.CLOUD_DEDICATED_CANARY_BASE_URL).toBe(
      "https://api-staging.elizacloud.ai",
    );
    expect(workflow.concurrency).toEqual({
      group: "managed-dedicated-staging-canary",
      "cancel-in-progress": false,
    });
    expect(workflowSource).not.toContain("HCLOUD_TOKEN");
    expect(workflowSource).not.toContain("HCLOUD_APPS_TOKEN");
    expect(workflowSource).not.toContain("HETZNER_API_TOKEN");
  });

  test("uses the exact App Live Cloud-secret fallback and fails on blank input", () => {
    expect(job?.env?.ELIZAOS_CLOUD_API_KEY).toBe(
      "$" + "{{ secrets.ELIZAOS_CLOUD_API_KEY || secrets.ELIZACLOUD_API_KEY }}",
    );
    const run = step("Require real Cloud credential").run ?? "";
    const missing = spawnSync("bash", ["-c", run], {
      encoding: "utf8",
      env: { ...process.env, ELIZAOS_CLOUD_API_KEY: "" },
    });
    expect(missing.status).toBe(1);
    expect(missing.stdout).toContain("refusing green-by-skip");

    const whitespace = spawnSync("bash", ["-c", run], {
      encoding: "utf8",
      env: { ...process.env, ELIZAOS_CLOUD_API_KEY: " \t\n" },
    });
    expect(whitespace.status).toBe(1);

    const configured = spawnSync("bash", ["-c", run], {
      encoding: "utf8",
      env: { ...process.env, ELIZAOS_CLOUD_API_KEY: "fixture-key" },
    });
    expect(configured.status).toBe(0);
  });

  test("preflights the exact staging URL and rejects userinfo", () => {
    const run = step("Require exact staging target").run ?? "";
    const exact = spawnSync("bash", ["-c", run], {
      encoding: "utf8",
      env: {
        ...process.env,
        CLOUD_DEDICATED_CANARY_BASE_URL: "https://api-staging.elizacloud.ai",
      },
    });
    expect(exact.status, exact.stderr).toBe(0);

    const userinfo = spawnSync("bash", ["-c", run], {
      encoding: "utf8",
      env: {
        ...process.env,
        CLOUD_DEDICATED_CANARY_BASE_URL:
          "https://user:password@api-staging.elizacloud.ai",
      },
    });
    expect(userinfo.status).toBe(1);
    expect(userinfo.stderr).toContain("without userinfo");
  });

  test("runs deterministic contracts before live provisioning", () => {
    const steps = job?.steps ?? [];
    const contractIndex = steps.findIndex(
      (candidate) => candidate.name === "Validate canary and failure contracts",
    );
    const liveIndex = steps.findIndex(
      (candidate) => candidate.name === "Run bounded managed dedicated canary",
    );
    expect(contractIndex).toBeGreaterThanOrEqual(0);
    expect(liveIndex).toBeGreaterThan(contractIndex);
    expect(step("Validate canary and failure contracts").run).toContain(
      "managed-dedicated-canary.test.ts",
    );
    expect(step("Run bounded managed dedicated canary").run).toContain(
      "managed-dedicated-canary.ts",
    );
  });

  test("makes missing evidence, zero paths, cleanup failure, and stale deploy ancestry red", () => {
    const enforce =
      step("Enforce live proof, deployed SHA, and cleanup").run ?? "";
    expect(enforce).toContain('[[ ! -s "$evidence_path" ]]');
    expect(enforce).toContain("validateManagedDedicatedCanaryEvidence");
    expect(enforce).toContain("zero-executed/skip outcomes are failures");
    expect(enforce).toContain("git merge-base --is-ancestor");
    expect(enforce).toContain("LIVE_PROCESS_STATUS:-missing");
    expect(enforce).toContain("PRIVACY_VALIDATED:-missing");
    expect(enforce).toContain("evidence.cleanup.status");
  });

  test("strictly validates both red and green evidence before any artifact upload", () => {
    const steps = job?.steps ?? [];
    const privacyIndex = steps.findIndex(
      (candidate) =>
        candidate.name === "Validate privacy-safe evidence artifact",
    );
    const uploadIndex = steps.findIndex(
      (candidate) =>
        candidate.name === "Upload privacy-safe timing and path evidence",
    );
    const privacy = step("Validate privacy-safe evidence artifact");
    const upload = step("Upload privacy-safe timing and path evidence");
    const privacyRun = privacy.run;
    if (!privacyRun) throw new Error("privacy validation step has no script");
    expect(privacyIndex).toBeGreaterThanOrEqual(0);
    expect(uploadIndex).toBeGreaterThan(privacyIndex);
    expect(privacy.id).toBe("privacy");
    expect(privacy.if).toContain("always()");
    expect(privacyRun).toContain("canonicalizeManagedDedicatedCanaryArtifact");
    expect(privacyRun).toContain("writeFileSync(canonicalPath, canonical");
    expect(privacyRun).toContain("renameSync(canonicalPath, evidencePath)");
    expect(privacyRun.indexOf("renameSync")).toBeLessThan(
      privacyRun.indexOf('echo "validated=true"'),
    );
    expect(privacyRun).toContain('echo "validated=true"');
    expect(upload.if).toContain("steps.privacy.outputs.validated == 'true'");
    expect(upload.with?.path).toBe("reports/managed-dedicated-canary.json");
    expect(upload.with?.["retention-days"]).toBe(14);
  });

  test("keeps every workflow shell contract valid", () => {
    for (const name of [
      "Require real Cloud credential",
      "Require exact staging target",
      "Validate canary and failure contracts",
      "Run bounded managed dedicated canary",
      "Validate privacy-safe evidence artifact",
      "Enforce live proof, deployed SHA, and cleanup",
    ]) {
      const result = spawnSync("bash", ["-n"], {
        input: step(name).run ?? "",
        encoding: "utf8",
      });
      expect(result.status, `${name}: ${result.stderr}`).toBe(0);
    }
  });
});

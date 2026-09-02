/**
 * Fail-closed workflow contract for manual staging-only placement comparison;
 * the workflow reads two existing Workers and cannot deploy either arm.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const repoRoot = new URL("../../../", import.meta.url);
const source = readFileSync(
  new URL(".github/workflows/cloud-placement-ab.yml", repoRoot),
  "utf8",
);

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string | boolean | number>;
}

interface Workflow {
  on?: Record<
    string,
    { inputs?: Record<string, { required?: boolean; type?: string }> }
  >;
  permissions?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  jobs?: Record<
    string,
    { environment?: string; env?: Record<string, string>; steps?: Step[] }
  >;
}

const workflow = Bun.YAML.parse(source) as Workflow;
const job = workflow.jobs?.["certify-placement"];

function step(name: string): Step {
  const found = job?.steps?.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing workflow step: ${name}`);
  return found;
}

describe("Cloud placement A/B workflow", () => {
  test("is manual, staging-only, read-only, serialized, and non-deploying", () => {
    expect(Object.keys(workflow.on ?? {})).toEqual(["workflow_dispatch"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toEqual({
      group: "cloud-placement-ab-staging",
      "cancel-in-progress": false,
    });
    expect(job?.environment).toBe("staging");
    expect(source).not.toContain("environment: production");
    expect(source).not.toMatch(/wrangler\s+(?:deploy|delete|versions deploy)/);
  });

  test("requires exact-SHA arm coordinates and protected read credentials", () => {
    const inputs = workflow.on?.workflow_dispatch?.inputs ?? {};
    for (const name of [
      "expected_deploy_sha",
      "smart_base_url",
      "control_base_url",
      "smart_worker",
      "control_worker",
    ]) {
      expect(inputs[name]).toMatchObject({ required: true, type: "string" });
    }
    const preflight = step("Validate trusted exact-SHA staging dispatch").run;
    expect(preflight).toContain('"$GITHUB_REF" != "refs/heads/develop"');
    expect(preflight).toContain('"$GITHUB_SHA" != "$EXPECTED_DEPLOY_SHA"');
    expect(preflight).toContain("^[a-f0-9]{40}$");
    for (const name of [
      "ELIZAOS_CLOUD_API_KEY",
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_ACCOUNT_ID",
    ]) {
      expect(job?.env?.[name]).toContain(`secrets.${name}`);
      expect(preflight).toContain(name);
    }
  });

  test("runs thirty successful paired probes and uploads only bounded outputs", () => {
    const run = step("Run exact-SHA privacy-safe placement A/B").run;
    expect(run).toContain("packages/cloud/scripts/cloud-placement-ab.mjs");
    expect(run).toContain('--deploy-sha "$EXPECTED_DEPLOY_SHA"');
    expect(run).toContain("--success-pairs 30");
    expect(run).toContain("--max-attempts 45");
    const upload = step("Upload sanitized placement evidence");
    expect(upload.uses).toBe(
      "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    );
    const paths = String(upload.with?.path ?? "");
    expect(paths).toContain("placement-ab.jsonl");
    expect(paths).toContain("summary.json");
    expect(paths).not.toContain("stderr");
    expect(paths).not.toContain("secret");
  });
});

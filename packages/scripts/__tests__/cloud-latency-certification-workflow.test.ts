/**
 * Fail-closed workflow contract for exact-SHA staging latency certification
 * and sanitized-only Worker Tail evidence retention.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const repoRoot = new URL("../../../", import.meta.url);
const source = readFileSync(
  new URL(".github/workflows/cloud-latency-certification.yml", repoRoot),
  "utf8",
);
const orchestratorSource = readFileSync(
  new URL("packages/cloud/scripts/cloud-latency-certification.mjs", repoRoot),
  "utf8",
);

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string | boolean | number>;
}

interface Job {
  environment?: string;
  env?: Record<string, string>;
  steps?: Step[];
}

interface Workflow {
  on?: Record<
    string,
    {
      inputs?: Record<
        string,
        { required?: boolean; type?: string; default?: boolean }
      >;
    }
  >;
  permissions?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  jobs?: Record<string, Job>;
}

const workflow = Bun.YAML.parse(source) as Workflow;
const job = workflow.jobs?.["certify-staging"];

function step(name: string): Step {
  const found = job?.steps?.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing workflow step: ${name}`);
  return found;
}

describe("Cloud latency certification workflow", () => {
  test("is manual-only, staging-scoped, read-only, and serialized", () => {
    expect(Object.keys(workflow.on ?? {})).toEqual(["workflow_dispatch"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toEqual({
      group: "cloud-latency-certification-staging",
      "cancel-in-progress": false,
    });
    expect(job?.environment).toBe("staging");
    expect(source).not.toContain("environment: production");
  });

  test("requires an exact SHA and keeps the auth lane explicitly optional", () => {
    const inputs = workflow.on?.workflow_dispatch?.inputs;
    expect(inputs?.expected_deploy_sha).toMatchObject({
      required: true,
      type: "string",
    });
    expect(inputs?.run_auth).toEqual({
      description:
        "Also run protected inference-auth hit, miss, non-standing guards, and sanitized Worker Tail proof.",
      required: true,
      default: false,
      type: "boolean",
    });
    expect(inputs?.run_suspended).toEqual({
      description:
        "Also prove the optional suspended-standing 403 guard (requires run_auth).",
      required: true,
      default: false,
      type: "boolean",
    });
    const preflight = step(
      "Validate trusted exact-SHA dispatch and protected credentials",
    ).run;
    expect(preflight).toContain('"$EXPECTED_DEPLOY_SHA" != "$GITHUB_SHA"');
    expect(preflight).toContain('"$GITHUB_REF" != "refs/heads/develop"');
    expect(preflight).toContain("^[a-f0-9]{40}$");
    expect(preflight).toContain('if [[ "$RUN_AUTH" == "true" ]]');
    expect(preflight).toContain(
      'if [[ "$RUN_SUSPENDED" == "true" && "$RUN_AUTH" != "true" ]]',
    );
  });

  test("fails closed on paired and optional auth credentials before checkout", () => {
    const preflight = step(
      "Validate trusted exact-SHA dispatch and protected credentials",
    );
    const preflightIndex = job?.steps?.indexOf(preflight) ?? -1;
    const checkoutIndex =
      job?.steps?.findIndex((candidate) =>
        candidate.uses?.startsWith("actions/checkout@"),
      ) ?? -1;
    expect(preflightIndex).toBe(0);
    expect(checkoutIndex).toBeGreaterThan(preflightIndex);
    for (const name of [
      "CEREBRAS_API_KEY",
      "ELIZAOS_CLOUD_API_KEY",
      "ELIZA_STAGING_SUSPENDED_API_KEY",
      "INFERENCE_AUTH_PROBE_TOKEN",
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_ACCOUNT_ID",
    ]) {
      expect(preflight.run).toContain(name);
      expect(job?.env?.[name]).toContain(`secrets.${name}`);
    }
    expect(preflight.run).toContain('if [[ "$RUN_SUSPENDED" == "true" ]]');
    expect(preflight.run).toContain(
      "required+=(ELIZA_STAGING_SUSPENDED_API_KEY)",
    );
  });

  test("runs the bounded orchestrator and never selects arbitrary checkout bytes", () => {
    const checkout = job?.steps?.find((candidate) =>
      candidate.uses?.startsWith("actions/checkout@"),
    );
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
    expect(checkout?.with?.ref).toBeUndefined();
    const run = step("Run exact-SHA privacy-safe latency certification").run;
    expect(run).toContain(
      "node packages/cloud/scripts/cloud-latency-certification.mjs",
    );
    expect(run).toContain('--deploy-sha "$EXPECTED_DEPLOY_SHA"');
    expect(run).toContain("args+=(--auth)");
    expect(run).toContain("args+=(--suspended)");
    expect(run).not.toContain("wrangler tail");
  });

  test("installs only pinned Bun for the pinned Wrangler Tail client", () => {
    expect(job?.env?.BUN_VERSION).toBe("1.3.14");
    const setupBun = step("Setup Bun for pinned Wrangler");
    expect(setupBun.uses).toBe(
      "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
    );
    expect(setupBun.with).toEqual({
      "bun-version": `\${{ env.BUN_VERSION }}`,
    });
    expect(source).not.toContain("setup-bun-workspace");
    expect(source).not.toContain("bun install");
    expect(orchestratorSource).toContain('"wrangler@4.116.0"');

    const importSpecifiers = [
      ...orchestratorSource.matchAll(/from\s+["']([^"']+)["']/g),
    ].map((match) => match[1]);
    expect(importSpecifiers.length).toBeGreaterThan(0);
    expect(
      importSpecifiers.every(
        (specifier) =>
          specifier?.startsWith("node:") || specifier?.startsWith("./"),
      ),
    ).toBe(true);
  });

  test("uploads only explicitly sanitized evidence and never raw Tail material", () => {
    const cleanup = step("Remove private Worker Tail material");
    expect(cleanup.run).toContain(
      'private_tail_directories=("$RUNNER_TEMP"/eliza-inference-auth-tail-*)',
    );
    expect(cleanup.run).toContain('rm -rf -- "$directory"');
    expect(job?.steps?.indexOf(cleanup)).toBeLessThan(
      job?.steps?.indexOf(step("Upload sanitized certification evidence")) ??
        -1,
    );
    const upload = step("Upload sanitized certification evidence");
    expect(upload.uses).toBe(
      "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    );
    const paths = String(upload.with?.path ?? "");
    expect(paths).toContain("paired.jsonl");
    expect(paths).toContain("inference-auth.jsonl");
    expect(paths).toContain("inference-auth-worker.jsonl");
    expect(paths).toContain("summary.json");
    expect(paths).not.toContain("raw");
    expect(paths).not.toContain("stderr");
    expect(paths).not.toContain("RUNNER_TEMP");
    expect(source).not.toContain("tee ");
  });
});

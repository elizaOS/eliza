/**
 * Executes the staging workflow's shell preflight and private-file cleanup,
 * while checking its protected dispatch and sanitized artifact boundaries.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

function executeStep(name: string, env: Record<string, string>) {
  const script = step(name).run;
  if (!script) throw new Error(`Workflow step has no shell body: ${name}`);
  return spawnSync("bash", ["-c", script], {
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
    timeout: 10_000,
  });
}

const preflightEnvironment = {
  EXPECTED_DEPLOY_SHA: "a".repeat(40),
  GITHUB_SHA: "b".repeat(40),
  GITHUB_REF: "refs/heads/develop",
  RUN_AUTH: "false",
  RUN_SUSPENDED: "false",
  CEREBRAS_API_KEY: "private-fixture-cerebras",
  ELIZAOS_CLOUD_API_KEY: "private-fixture-cloud",
  CLOUDFLARE_API_TOKEN: "private-fixture-cloudflare",
  CLOUDFLARE_ACCOUNT_ID: "private-fixture-account",
};

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

  test("trusted preflight permits a distinct served revision for the ancestry verifier", () => {
    const result = executeStep(
      "Validate trusted exact-SHA dispatch and protected credentials",
      preflightEnvironment,
    );
    expect(result.status).toBe(0);
    expect(result.error).toBeUndefined();
    expect(result.stdout + result.stderr).not.toContain("private-fixture");
  });

  test.each([
    { GITHUB_REF: "refs/heads/untrusted" },
    { EXPECTED_DEPLOY_SHA: "not-a-commit" },
    { RUN_SUSPENDED: "true" },
    { CEREBRAS_API_KEY: " " },
    { RUN_AUTH: "true" },
    {
      RUN_AUTH: "true",
      RUN_SUSPENDED: "true",
      INFERENCE_AUTH_PROBE_TOKEN: "private-fixture-probe",
    },
  ])(
    "preflight rejects unsafe dispatch or missing selected credentials",
    (overrides) => {
      const result = executeStep(
        "Validate trusted exact-SHA dispatch and protected credentials",
        { ...preflightEnvironment, ...overrides },
      );
      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr).not.toContain("private-fixture");
    },
  );

  test("selected auth and suspended lanes accept configured private credentials without printing them", () => {
    const result = executeStep(
      "Validate trusted exact-SHA dispatch and protected credentials",
      {
        ...preflightEnvironment,
        RUN_AUTH: "true",
        RUN_SUSPENDED: "true",
        INFERENCE_AUTH_PROBE_TOKEN: "private-fixture-probe",
        ELIZA_STAGING_SUSPENDED_API_KEY: "private-fixture-suspended",
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).not.toContain("private-fixture");
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
    const cleanup = step("Remove private Worker telemetry material");
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
    expect(paths).toContain("source.json");
    expect(paths).toContain("inference-traces.json");
    expect(paths).toContain("summary.json");
    expect(paths).not.toContain("raw");
    expect(paths).not.toContain("stderr");
    expect(paths).not.toContain("RUNNER_TEMP");
    expect(source).not.toContain("tee ");
  });

  test("actual cleanup removes both private capture families and preserves unrelated files", () => {
    const root = mkdtempSync(join(tmpdir(), "latency-workflow-test-"));
    try {
      for (const name of [
        "eliza-inference-auth-tail-test",
        "eliza-inference-trace-test",
      ]) {
        mkdirSync(join(root, name));
        writeFileSync(join(root, name, "raw.json"), "private-fixture");
      }
      writeFileSync(join(root, "unrelated.txt"), "keep");
      const result = executeStep("Remove private Worker telemetry material", {
        RUNNER_TEMP: root,
      });
      expect(result.status).toBe(0);
      expect(existsSync(join(root, "eliza-inference-auth-tail-test"))).toBe(
        false,
      );
      expect(existsSync(join(root, "eliza-inference-trace-test"))).toBe(false);
      expect(readFileSync(join(root, "unrelated.txt"), "utf8")).toBe("keep");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("actual cleanup refuses symlink targets without deleting their contents", () => {
    const root = mkdtempSync(join(tmpdir(), "latency-workflow-test-"));
    try {
      const target = join(root, "unrelated");
      mkdirSync(target);
      writeFileSync(join(target, "keep.txt"), "keep");
      symlinkSync(target, join(root, "eliza-inference-trace-link"), "dir");
      const result = executeStep("Remove private Worker telemetry material", {
        RUNNER_TEMP: root,
      });
      expect(result.status).toBe(1);
      expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe("keep");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

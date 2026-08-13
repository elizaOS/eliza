/**
 * Contract test: path classification is centralized in one reusable workflow
 * (#14051 Tier B). Consumer workflows call `.github/workflows/classify-paths.yml`
 * via `uses:` instead of each inlining its own checkout + setup-node +
 * ci-path-gate.mjs steps. test.yml is exempt because its `changes` job also
 * runs fleet-aware contracts (turbo cache, i18n, alias-read guard) that are
 * specific to its post-merge role.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const workflowsDir = join(repoRoot, ".github", "workflows");

/**
 * Workflows that consolidate their classifier into the reusable
 * classify-paths.yml. Each entry maps the workflow file to the job id that
 * must use the reusable workflow.
 */
const EXPECTED_REUSABLE: Record<string, string> = {
  "ci.yml": "changes",
  "dev-smoke.yml": "changes",
  "scenario-pr.yml": "changes",
  "docker-ci-smoke.yml": "changes",
};

describe("path-classifier dedup contract", () => {
  test("consumer workflows call the reusable classify-paths workflow", () => {
    const violations: string[] = [];

    for (const [file, jobId] of Object.entries(EXPECTED_REUSABLE)) {
      const source = readFileSync(join(workflowsDir, file), "utf8");
      const workflow = Bun.YAML.parse(source) as {
        jobs?: Record<string, { uses?: string }>;
      };
      const job = workflow.jobs?.[jobId];
      if (!job) {
        violations.push(`${file}: missing job '${jobId}'`);
        continue;
      }
      if (!job.uses) {
        violations.push(
          `${file}: job '${jobId}' must use the reusable classify-paths workflow instead of inlining steps`,
        );
        continue;
      }
      if (!job.uses.endsWith("classify-paths.yml")) {
        violations.push(
          `${file}: job '${jobId}' uses '${job.uses}' but must reference classify-paths.yml`,
        );
      }
    }

    expect(violations).toEqual([]);
  });

  test("no non-exempt workflow inlines its own ci-path-gate.mjs call", () => {
    const violations: string[] = [];

    for (const file of Object.keys(EXPECTED_REUSABLE)) {
      const source = readFileSync(join(workflowsDir, file), "utf8");
      if (source.includes("ci-path-gate.mjs")) {
        violations.push(
          `${file}: still inlines ci-path-gate.mjs; use the reusable classify-paths workflow instead`,
        );
      }
    }

    expect(violations).toEqual([]);
  });

  test("the reusable classify-paths workflow exists and is well-formed", () => {
    const source = readFileSync(
      join(workflowsDir, "classify-paths.yml"),
      "utf8",
    );
    const workflow = Bun.YAML.parse(source) as Record<string, unknown> & {
      name?: string;
      jobs?: Record<
        string,
        { outputs?: Record<string, string>; "runs-on"?: string }
      >;
    };

    // Bun.YAML.parse resolves the YAML `on:` key to the boolean `true` in
    // some runtime versions and to the string `"on"` in others. Check both
    // paths so the contract holds regardless of the runner's Bun version.
    const trigger = (workflow.on ?? workflow.true) as
      | {
          workflow_call?: {
            inputs?: Record<string, unknown>;
            outputs?: Record<string, unknown>;
          };
        }
      | undefined;

    expect(workflow.name).toBe("Classify Paths");
    expect(trigger?.workflow_call).toBeDefined();

    // The force_hosted input must be declared so callers can opt into
    // unconditional GitHub-hosted runners (SPOF guard #13617).
    expect(trigger?.workflow_call?.inputs?.force_hosted).toBeDefined();

    const classifyJob = workflow.jobs?.classify;
    expect(classifyJob).toBeDefined();
    // The runs-on expression must reference force_hosted so the input
    // actually controls runner routing — not just be declared and unused.
    expect(classifyJob?.["runs-on"]).toContain("force_hosted");
    // The hosted fallback must be present in the expression.
    expect(classifyJob?.["runs-on"]).toContain("ubuntu-24.04");

    // Must export all lanes that any consumer might need — at BOTH the
    // workflow_call level (so callers can read them) and the job level
    // (so the step outputs propagate).
    const callOutputs = trigger?.workflow_call?.outputs ?? {};
    const jobOutputs = classifyJob?.outputs ?? {};
    for (const lane of [
      "server",
      "client",
      "plugins",
      "desktop",
      "zero_key",
      "cloud",
      "android_aab",
      "dev_smoke",
      "docker",
      "run_scenario_pr",
    ]) {
      expect(callOutputs[lane]).toBeDefined();
      expect(jobOutputs[lane]).toBeDefined();
    }
  });

  test("unconditionally-hosted callers pass force_hosted: true (SPOF guard)", () => {
    // ci.yml and docker-ci-smoke.yml were unconditionally ubuntu-24.04 before
    // consolidation. They must pass force_hosted: true so the reusable
    // workflow's fleet-aware conditional does not route their classifier to
    // self-hosted runners on non-PR events (#13617 SPOF regression).
    const FORCE_HOSTED_CALLERS = ["ci.yml", "docker-ci-smoke.yml"];
    const violations: string[] = [];

    for (const file of FORCE_HOSTED_CALLERS) {
      const source = readFileSync(join(workflowsDir, file), "utf8");
      const workflow = Bun.YAML.parse(source) as {
        jobs?: Record<
          string,
          { uses?: string; with?: Record<string, unknown> }
        >;
      };
      const changesJob = workflow.jobs?.changes;
      if (!changesJob?.uses?.endsWith("classify-paths.yml")) {
        violations.push(`${file}: changes job must use classify-paths.yml`);
        continue;
      }
      if (changesJob.with?.force_hosted !== true) {
        violations.push(
          `${file}: changes job must pass force_hosted: true to preserve the pre-consolidation unconditional-hosted invariant (#13617)`,
        );
      }
    }

    expect(violations).toEqual([]);
  });
});

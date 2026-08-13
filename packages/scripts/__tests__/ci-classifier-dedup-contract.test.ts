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
    const workflow = Bun.YAML.parse(source) as {
      name?: string;
      // YAML parses the `on:` key as boolean `true`, matching GitHub's own
      // workflow parser convention.
      true?: {
        workflow_call?: {
          outputs?: Record<string, unknown>;
        };
      };
      jobs?: Record<string, { outputs?: Record<string, string>; "runs-on"?: string }>;
    };

    expect(workflow.name).toBe("Classify Paths");
    expect(workflow.true?.workflow_call).toBeDefined();

    const classifyJob = workflow.jobs?.classify;
    expect(classifyJob).toBeDefined();
    // PR events must stay on GitHub-hosted runners (SPOF guard). Non-PR events
    // use the fleet-aware conditional. Verify the PR-hosted fallback is present.
    expect(classifyJob?.["runs-on"]).toContain("ubuntu-24.04");

    // Must export all lanes that any consumer might need — at BOTH the
    // workflow_call level (so callers can read them) and the job level
    // (so the step outputs propagate).
    const callOutputs = workflow.true?.workflow_call?.outputs ?? {};
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
});

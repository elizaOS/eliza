/**
 * Proves fork pull requests create only the canonical hosted CI workflow while
 * retaining develop compatibility, actionlint, and secret-scan coverage.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const workflowRoot = join(repoRoot, ".github", "workflows");

type Workflow = {
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs?: Record<
    string,
    {
      name?: string;
      if?: string;
      uses?: string;
      "runs-on"?: string;
      steps?: Array<{ name?: string; run?: string }>;
    }
  >;
};

function workflow(name: string, source?: string): Workflow {
  return Bun.YAML.parse(
    source ?? readFileSync(join(workflowRoot, name), "utf8"),
  ) as Workflow;
}

function assertForkPrDispatchContract(
  ciSource: string,
  developSource: string,
  gitleaksSource: string,
): void {
  const ci = workflow("ci.yml", ciSource);
  const develop = workflow("develop-pr.yml", developSource);
  const gitleaks = workflow("gitleaks.yml", gitleaksSource);

  expect(ci.on?.pull_request).toBeDefined();
  expect(ci.permissions).toEqual({ contents: "read" });
  expect(ci.jobs?.develop_pr).toMatchObject({
    if: "github.event_name == 'pull_request' && github.base_ref == 'develop'",
    uses: "./.github/workflows/develop-pr.yml",
  });

  expect(develop.on?.pull_request).toBeUndefined();
  expect(develop.on?.workflow_call).toBeDefined();
  expect(develop.permissions).toEqual({ contents: "read" });
  expect(
    Object.values(develop.jobs ?? {}).every(
      (job) =>
        typeof job["runs-on"] === "string" &&
        job["runs-on"].startsWith("ubuntu-"),
    ),
  ).toBe(true);
  expect(developSource).not.toContain("secrets.");
  expect(developSource).not.toContain("self-hosted");
  expect(developSource).toContain("install-workflow-linters.sh");
  expect(developSource).toContain("actionlint");

  expect(gitleaks.on?.pull_request).toBeUndefined();
  expect(gitleaks.on?.push).toBeDefined();

  const secretScan = ci.jobs?.secrets;
  expect(secretScan?.name).toBe("gitleaks");
  expect(secretScan?.["runs-on"]).toBe("ubuntu-24.04");
  expect(JSON.stringify(secretScan)).toContain("gitleaks detect");
  // Canonical CI owns the only pull-request secret scan now, so it must keep
  // the three-dot merge-base range from #17984; a two-dot range re-flags
  // fixtures the branch merely inherited by merging develop.
  expect(JSON.stringify(secretScan)).toContain(
    "$" + "{BASE_SHA}..." + "$" + "{HEAD_SHA}",
  );
  const required = JSON.stringify(ci.jobs?.required);
  expect(required).toContain("develop_pr");
  expect(required).toContain("needs.develop_pr.result");
  expect(required).toContain("secrets");
}

describe("fork pull-request workflow dispatch (#18443)", () => {
  const ciSource = readFileSync(join(workflowRoot, "ci.yml"), "utf8");
  const developSource = readFileSync(
    join(workflowRoot, "develop-pr.yml"),
    "utf8",
  );
  const gitleaksSource = readFileSync(
    join(workflowRoot, "gitleaks.yml"),
    "utf8",
  );

  test("keeps PR validation inside the canonical hosted workflow", () => {
    expect(() =>
      assertForkPrDispatchContract(ciSource, developSource, gitleaksSource),
    ).not.toThrow();
  });

  test("fails if either specialized workflow restores a PR trigger", () => {
    const directDevelop = developSource.replace(
      "  workflow_call:",
      "  pull_request:\n    branches: [develop]",
    );
    expect(() =>
      assertForkPrDispatchContract(ciSource, directDevelop, gitleaksSource),
    ).toThrow();

    const directGitleaks = gitleaksSource.replace(
      "on:\n  push:",
      'on:\n  pull_request:\n    branches: ["main", "develop"]\n  push:',
    );
    expect(() =>
      assertForkPrDispatchContract(ciSource, developSource, directGitleaks),
    ).toThrow();
  });
});

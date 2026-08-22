/** Exercises the policy that permits only PR Static Smoke for PR/merge events and restricts branch pushes to develop. */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateWorkflowTriggerPolicy } from "../workflow-trigger-policy.mjs";

const REAL_REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function buildRepo(workflows: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "workflow-trigger-policy-"));
  const directory = join(root, ".github", "workflows");
  mkdirSync(directory, { recursive: true });
  for (const [name, source] of Object.entries(workflows))
    writeFileSync(join(directory, name), source);
  return root;
}

function validateFixture(
  workflow: string,
): ReturnType<typeof validateWorkflowTriggerPolicy> {
  const root = buildRepo({ "test.yml": workflow });
  try {
    return validateWorkflowTriggerPolicy(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const canonicalAdmission = `name: PR Static Smoke
on:
  pull_request:
    branches: [develop, main]
    types: [opened, synchronize, reopened, ready_for_review]
  merge_group:
    types: [checks_requested]
jobs: {}
`;

const developPush = `name: Develop Full
on:
  push:
    branches: [develop]
jobs: {}
`;

describe("workflow trigger policy", () => {
  test("accepts develop pushes alongside manual and scheduled operations", () => {
    expect(
      validateFixture(`name: Test
on:
  push:
    branches: [develop]
  workflow_dispatch:
  schedule:
    - cron: "0 7 * * *"
jobs: {}
`),
    ).toEqual({ developPushWorkflows: 1, files: 1 });
  });

  test("accepts tag-only release pushes", () => {
    const root = buildRepo({
      "develop.yml": `on:\n  push:\n    branches: [develop]\njobs: {}\n`,
      "release.yml": `on:\n  push:\n    tags: ["v*"]\njobs: {}\n`,
    });
    try {
      expect(validateWorkflowTriggerPolicy(root)).toEqual({
        developPushWorkflows: 1,
        files: 2,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each([
    "pull_request_target",
    "issue_comment",
    "pull_request_review",
    "pull_request_review_comment",
  ])("rejects the PR-adjacent %s trigger", (eventName) => {
    expect(() =>
      validateFixture(
        `on:\n  push:\n    branches: [develop]\n  ${eventName}:\njobs: {}\n`,
      ),
    ).toThrow(/forbidden pull-request event trigger/);
  });

  test("reserves pull_request for PR Static Smoke", () => {
    expect(() =>
      validateFixture(
        "on:\n  push:\n    branches: [develop]\n  pull_request:\n    branches: [develop, main]\n    types: [opened, synchronize, reopened, ready_for_review, labeled, unlabeled]\njobs: {}\n",
      ),
    ).toThrow(/pull_request is reserved for pr-static-smoke\.yml/);
  });

  test("accepts the exact PR Static Smoke and develop authorities", () => {
    const root = buildRepo({
      "pr-static-smoke.yml": canonicalAdmission,
      "develop-full.yml": developPush,
    });
    try {
      expect(validateWorkflowTriggerPolicy(root)).toEqual({
        developPushWorkflows: 1,
        files: 2,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails closed when PR Static Smoke loses either admission trigger", () => {
    const variants = [
      canonicalAdmission.replace(
        / {2}pull_request:\n {4}branches: \[develop, main\]\n {4}types: \[opened, synchronize, reopened, ready_for_review\]\n/,
        "",
      ),
      canonicalAdmission.replace(
        / {2}merge_group:\n {4}types: \[checks_requested\]\n/,
        "",
      ),
    ];
    for (const workflow of variants) {
      const root = buildRepo({
        "pr-static-smoke.yml": workflow,
        "develop-full.yml": developPush,
      });
      try {
        expect(() => validateWorkflowTriggerPolicy(root)).toThrow(
          /canonical (pull_request|merge_group) trigger is absent or invalid/,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("reserves merge_group for PR Static Smoke", () => {
    expect(() =>
      validateFixture(
        `on:\n  push:\n    branches: [develop]\n  merge_group:\n    types: [checks_requested]\njobs: {}\n`,
      ),
    ).toThrow(/merge_group is reserved/);
  });

  test("rejects an unrestricted push", () => {
    expect(() => validateFixture("on: [push]\njobs: {}\n")).toThrow(
      /push must be branch-filtered to develop/,
    );
  });

  test("rejects main and mixed branch pushes", () => {
    for (const branches of ["[main]", "[develop, main]"]) {
      expect(() =>
        validateFixture(`on:\n  push:\n    branches: ${branches}\njobs: {}\n`),
      ).toThrow(/push branches must be exactly \[develop\]/);
    }
  });

  test("the checked-in workflows expose only PR Static Smoke and develop pushes", () => {
    const result = validateWorkflowTriggerPolicy(REAL_REPO_ROOT);
    expect(result.files).toBeGreaterThan(40);
    expect(result.developPushWorkflows).toBeGreaterThan(15);
  });
});

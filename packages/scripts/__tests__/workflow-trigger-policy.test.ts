/** Exercises the repository policy that excludes pull-request workflow runs, reserves merge-queue admission, and restricts branch pushes to develop. */

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
  for (const [name, source] of Object.entries(workflows)) {
    writeFileSync(join(directory, name), source);
  }
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
    "pull_request",
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

  test("reserves merge_group for the candidate Biome workflow", () => {
    expect(() =>
      validateFixture(
        `on:\n  push:\n    branches: [develop]\n  merge_group:\njobs: {}\n`,
      ),
    ).toThrow(/merge_group is reserved for merge-candidate-biome\.yml/);

    const root = buildRepo({
      "develop.yml": `on:\n  push:\n    branches: [develop]\njobs: {}\n`,
      "merge-candidate-biome.yml": `on:\n  merge_group:\n    types: [checks_requested]\njobs: {}\n`,
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

  test("the checked-in workflow set has no PR triggers or non-develop branch pushes", () => {
    const result = validateWorkflowTriggerPolicy(REAL_REPO_ROOT);
    expect(result.files).toBeGreaterThan(40);
    expect(result.developPushWorkflows).toBeGreaterThan(15);
  });
});

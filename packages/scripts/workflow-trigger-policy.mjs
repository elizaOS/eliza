#!/usr/bin/env node
/**
 * Enforces develop-only automated pushes and one canonical pull-request and
 * merge-group aggregate. Other PR-adjacent triggers remain forbidden; the
 * merge-candidate Biome workflow may retain its defense-in-depth queue check.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

const FORBIDDEN_EVENTS = new Set([
  "issue_comment",
  "pull_request_review",
  "pull_request_review_comment",
  "pull_request_target",
]);
const CANONICAL_ADMISSION_WORKFLOW = "ci.yml";
const CANONICAL_DEVELOP_PUSH_WORKFLOW = "ci-develop-push.yml";
const MERGE_GROUP_WORKFLOWS = new Set([
  CANONICAL_ADMISSION_WORKFLOW,
  "merge-candidate-biome.yml",
]);
const REQUIRED_PR_BRANCHES = ["develop", "main"];
const REQUIRED_PR_TYPES = [
  "labeled",
  "opened",
  "ready_for_review",
  "reopened",
  "synchronize",
  "unlabeled",
];

function triggerEntries(value) {
  if (typeof value === "string") return [[value, null]];
  if (Array.isArray(value)) return value.map((name) => [String(name), null]);
  if (value && typeof value === "object") return Object.entries(value);
  return [];
}

function stringList(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.map(String);
  return [];
}

function sameStrings(actual, expected) {
  return (
    JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort())
  );
}

export function validateWorkflowTriggerPolicy(repoRoot) {
  const workflowsDir = path.join(repoRoot, ".github", "workflows");
  const failures = [];
  let files = 0;
  let developPushWorkflows = 0;
  let sawCanonicalWorkflow = false;
  let sawCanonicalDevelopPush = false;
  let sawCanonicalPullRequest = false;
  let sawCanonicalMergeGroup = false;

  for (const name of readdirSync(workflowsDir).sort()) {
    if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
    files += 1;
    const source = readFileSync(path.join(workflowsDir, name), "utf8");
    const document = parseDocument(source, { uniqueKeys: true });
    if (document.errors.length > 0) {
      failures.push(
        `${name}: invalid workflow YAML: ${document.errors.map((error) => error.message).join("; ")}`,
      );
      continue;
    }

    const workflow = document.toJS();
    const entries = triggerEntries(workflow?.on);
    if (name === CANONICAL_ADMISSION_WORKFLOW) sawCanonicalWorkflow = true;

    for (const [eventName, config] of entries) {
      if (FORBIDDEN_EVENTS.has(eventName)) {
        failures.push(
          `${name}: forbidden pull-request event trigger: ${eventName}`,
        );
      }

      if (eventName === "pull_request") {
        if (name !== CANONICAL_ADMISSION_WORKFLOW) {
          failures.push(
            `${name}: pull_request is reserved for ${CANONICAL_ADMISSION_WORKFLOW}`,
          );
          continue;
        }
        const branches = stringList(config?.branches);
        const types = stringList(config?.types);
        if (
          !sameStrings(branches, REQUIRED_PR_BRANCHES) ||
          !sameStrings(types, REQUIRED_PR_TYPES)
        ) {
          failures.push(
            `${name}: pull_request must target ${JSON.stringify(REQUIRED_PR_BRANCHES)} with types ${JSON.stringify(REQUIRED_PR_TYPES)}`,
          );
          continue;
        }
        sawCanonicalPullRequest = true;
      }

      if (eventName === "merge_group") {
        if (!MERGE_GROUP_WORKFLOWS.has(name)) {
          failures.push(
            `${name}: merge_group is reserved for ${[...MERGE_GROUP_WORKFLOWS].join(" and ")}`,
          );
          continue;
        }
        if (!sameStrings(stringList(config?.types), ["checks_requested"])) {
          failures.push(
            `${name}: merge_group types must be exactly [\"checks_requested\"]`,
          );
          continue;
        }
        if (name === CANONICAL_ADMISSION_WORKFLOW)
          sawCanonicalMergeGroup = true;
      }

      if (eventName !== "push") continue;
      if (name === CANONICAL_ADMISSION_WORKFLOW) {
        failures.push(
          `${CANONICAL_ADMISSION_WORKFLOW}: direct develop pushes must enter through ${CANONICAL_DEVELOP_PUSH_WORKFLOW}`,
        );
        continue;
      }
      if (!config || typeof config !== "object") {
        failures.push(
          `${name}: push must be branch-filtered to develop (tag-only release pushes are allowed)`,
        );
        continue;
      }
      const branches = stringList(config.branches);
      const tags = stringList(config.tags);
      const hasBranchIgnore = stringList(config["branches-ignore"]).length > 0;
      if (branches.length === 0 && tags.length > 0 && !hasBranchIgnore)
        continue;
      if (
        branches.length !== 1 ||
        branches[0] !== "develop" ||
        hasBranchIgnore
      ) {
        failures.push(
          `${name}: push branches must be exactly [develop], received ${JSON.stringify(branches)}`,
        );
        continue;
      }
      developPushWorkflows += 1;
      if (name === CANONICAL_DEVELOP_PUSH_WORKFLOW)
        sawCanonicalDevelopPush = true;
    }
  }

  if (files === 0) failures.push("No workflow files were found.");
  if (developPushWorkflows === 0)
    failures.push("No develop push workflows were found.");
  if (sawCanonicalWorkflow && !sawCanonicalPullRequest) {
    failures.push(
      `${CANONICAL_ADMISSION_WORKFLOW}: canonical pull_request trigger is absent or invalid`,
    );
  }
  if (sawCanonicalWorkflow && !sawCanonicalMergeGroup) {
    failures.push(
      `${CANONICAL_ADMISSION_WORKFLOW}: canonical merge_group trigger is absent or invalid`,
    );
  }
  if (sawCanonicalWorkflow && !sawCanonicalDevelopPush) {
    failures.push(
      `${CANONICAL_DEVELOP_PUSH_WORKFLOW}: canonical develop push trigger is absent or invalid`,
    );
  }
  if (failures.length > 0) {
    throw new Error(
      [
        "GitHub workflow triggers must expose only the canonical PR/merge aggregate, reserve other PR-adjacent events, and target automated branch pushes to develop:",
        ...failures,
      ].join("\n"),
    );
  }
  return { developPushWorkflows, files };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repoRoot = path.resolve(import.meta.dirname, "../..");
  const result = validateWorkflowTriggerPolicy(repoRoot);
  console.log(
    `[workflow-trigger-policy] verified ${result.files} workflows; ${result.developPushWorkflows} develop push surfaces`,
  );
}

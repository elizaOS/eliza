#!/usr/bin/env node
/**
 * Enforces develop-only automated branch workflows and rejects pull-request
 * event triggers. The credential-free merge-candidate Biome gate is the sole
 * exception because it checks GitHub's synthesized queue tree before landing.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

const FORBIDDEN_EVENTS = new Set([
  "issue_comment",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "pull_request_target",
]);

const MERGE_GROUP_WORKFLOW = "merge-candidate-biome.yml";

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

export function validateWorkflowTriggerPolicy(repoRoot) {
  const workflowsDir = path.join(repoRoot, ".github", "workflows");
  const failures = [];
  let files = 0;
  let developPushWorkflows = 0;

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
    for (const [eventName, config] of entries) {
      if (eventName === "merge_group" && name !== MERGE_GROUP_WORKFLOW) {
        failures.push(
          `${name}: merge_group is reserved for ${MERGE_GROUP_WORKFLOW}`,
        );
      }
      if (FORBIDDEN_EVENTS.has(eventName)) {
        failures.push(
          `${name}: forbidden pull-request event trigger: ${eventName}`,
        );
      }
      if (eventName !== "push") continue;

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
    }
  }

  if (files === 0) failures.push("No workflow files were found.");
  if (developPushWorkflows === 0) {
    failures.push("No develop push workflows were found.");
  }
  if (failures.length > 0) {
    throw new Error(
      [
        "GitHub workflow triggers must not run for pull requests, merge_group is reserved for the candidate Biome gate, and automated branch pushes must target develop only:",
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

#!/usr/bin/env node
/**
 * Enforces physical workload separation between GitHub Actions and production
 * agent-placement nodes. Checked-in workflows must use hosted runners and may
 * not carry an override that can silently route work back to the old Hetzner
 * runner farm (#17881).
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";

const FORBIDDEN_ROUTE_TOKENS = [
  "self-hosted",
  "hetzner-robot",
  "HETZNER_FLEET_ONLINE",
  "CLOUD_CF_MIGRATE_RUNNER_JSON",
  "CLOUD_CF_DEPLOY_RUNNER_JSON",
  "ACTIONS_JANITOR_ROBOT_RUNNER_JSON",
  "vars.",
  "inputs.",
  "fromJSON(",
];

function lineAt(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

function collectWorkflowScalars(node, source, pathParts = [], scalars = []) {
  if (isScalar(node)) {
    if (typeof node.value === "string") {
      scalars.push({
        line: lineAt(source, node.range?.[0] ?? 0),
        path: pathParts.join("."),
        value: node.value.replace(/\s+/g, " ").trim(),
      });
    }
    return scalars;
  }

  if (isMap(node)) {
    for (const pair of node.items) {
      const key = isScalar(pair.key) ? String(pair.key.value) : "<key>";
      collectWorkflowScalars(pair.value, source, [...pathParts, key], scalars);
    }
    return scalars;
  }

  if (isSeq(node)) {
    node.items.forEach((item, index) => {
      collectWorkflowScalars(
        item,
        source,
        [...pathParts, String(index)],
        scalars,
      );
    });
  }

  return scalars;
}

export function validateHetznerFleetRouting(repoRoot) {
  const workflowsDir = path.join(repoRoot, ".github", "workflows");
  const failures = [];
  let selectors = 0;
  let files = 0;

  for (const name of readdirSync(workflowsDir).sort()) {
    if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
    files += 1;
    const source = readFileSync(path.join(workflowsDir, name), "utf8");
    const document = parseDocument(source, { uniqueKeys: true });
    if (document.errors.length > 0) {
      throw new Error(
        `${name}: invalid workflow YAML: ${document.errors.map((error) => error.message).join("; ")}`,
      );
    }

    const scalars = collectWorkflowScalars(document.contents, source);
    const isRunnerRouteScalar = (entry) =>
      /^jobs\.[^.]+\.runs-on(?:\.|$)/.test(entry.path) ||
      /^jobs\.[^.]+\.strategy\.matrix\./.test(entry.path);
    selectors += scalars.filter((entry) =>
      /^jobs\.[^.]+\.runs-on(?:\.|$)/.test(entry.path),
    ).length;

    for (const scalar of scalars) {
      if (!isRunnerRouteScalar(scalar)) continue;
      const token = FORBIDDEN_ROUTE_TOKENS.find((candidate) =>
        scalar.value.includes(candidate),
      );
      if (!token) continue;
      failures.push(
        `${name}:${scalar.line} (${scalar.path}): contains ${token}`,
      );
    }
  }

  if (selectors === 0) {
    throw new Error(
      "No GitHub Actions jobs with runs-on selectors were found.",
    );
  }
  if (failures.length > 0) {
    throw new Error(
      [
        "GitHub Actions must remain separated from production placement nodes; self-hosted fleet routes and runner override variables are forbidden:",
        ...failures,
      ].join("\n"),
    );
  }

  return { files, selectors };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repoRoot = path.resolve(import.meta.dirname, "../..");
  const result = validateHetznerFleetRouting(repoRoot);
  console.log(
    `[hetzner-fleet-routing] verified ${result.selectors} hosted job selectors across ${result.files} workflows`,
  );
}

#!/usr/bin/env node
/**
 * Verifies that GitHub Actions uses the Hetzner fleet only when the repository
 * variable is explicitly `true`. Fork pull requests do not receive repository
 * variables, so an empty value must fail safely to GitHub-hosted runners.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOSTED_LABELS = ["ubuntu-24.04"];
const FLEET_LABELS = ["self-hosted", "hetzner-robot"];
const CANONICAL_SELECTOR =
  "fromJSON(vars.HETZNER_FLEET_ONLINE != 'true' && " +
  '\'["ubuntu-24.04"]\' || \'["self-hosted","hetzner-robot"]\')';
const PULL_REQUEST_HOSTED_SELECTOR =
  "fromJSON(github.event_name == 'pull_request' && '[\"ubuntu-24.04\"]' || " +
  "vars.HETZNER_FLEET_ONLINE != 'true' && '[\"ubuntu-24.04\"]' || " +
  '\'["self-hosted","hetzner-robot"]\')';
const ALLOWED_SELECTORS = new Set([
  CANONICAL_SELECTOR,
  PULL_REQUEST_HOSTED_SELECTOR,
]);
const SELECTOR_PATTERN = /fromJSON\([^\n]*vars\.HETZNER_FLEET_ONLINE[^\n]*?\)/g;

export function selectHetznerRunnerLabels(variableValue) {
  return variableValue === "true" ? FLEET_LABELS : HOSTED_LABELS;
}

export function validateHetznerFleetRouting(repoRoot) {
  const workflowsDir = path.join(repoRoot, ".github", "workflows");
  const failures = [];
  let selectors = 0;
  let files = 0;

  for (const name of readdirSync(workflowsDir).sort()) {
    if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
    const source = readFileSync(path.join(workflowsDir, name), "utf8");
    const matches = [...source.matchAll(SELECTOR_PATTERN)];
    if (matches.length === 0) continue;
    files += 1;
    selectors += matches.length;

    for (const match of matches) {
      if (ALLOWED_SELECTORS.has(match[0])) continue;
      const line = source.slice(0, match.index).split("\n").length;
      failures.push(`${name}:${line}: ${match[0]}`);
    }
  }

  if (selectors === 0) {
    throw new Error("No HETZNER_FLEET_ONLINE runner selectors were found.");
  }
  if (failures.length > 0) {
    throw new Error(
      [
        "Hetzner runner routing must require HETZNER_FLEET_ONLINE == true; missing, empty, and false values must use ubuntu-24.04:",
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
    `[hetzner-fleet-routing] verified ${result.selectors} selectors across ${result.files} workflows`,
  );
}

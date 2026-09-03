#!/usr/bin/env node
/**
 * Verifies that GitHub Actions uses the Hetzner fleet only when the repository
 * variable is explicitly `true`. Fork pull requests do not receive repository
 * variables, so an empty value must fail safely to GitHub-hosted runners.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";

const HOSTED_LABELS = ["ubuntu-24.04"];
const FLEET_LABELS = ["self-hosted", "hetzner-robot"];
const EXPRESSION_OPEN = "$" + "{{";
const CANONICAL_SELECTOR =
  EXPRESSION_OPEN +
  " fromJSON(vars.HETZNER_FLEET_ONLINE != 'true' && '[\"ubuntu-24.04\"]' || '[\"self-hosted\",\"hetzner-robot\"]') }}";
const PULL_REQUEST_HOSTED_SELECTOR =
  EXPRESSION_OPEN +
  " fromJSON(github.event_name == 'pull_request' && '[\"ubuntu-24.04\"]' || vars.HETZNER_FLEET_ONLINE != 'true' && '[\"ubuntu-24.04\"]' || '[\"self-hosted\",\"hetzner-robot\"]') }}";
const FORCE_HOSTED_SELECTOR =
  EXPRESSION_OPEN +
  " fromJSON((inputs.force_hosted || github.event_name == 'pull_request' || vars.HETZNER_FLEET_ONLINE != 'true') && '[\"ubuntu-24.04\"]' || '[\"self-hosted\",\"hetzner-robot\"]') }}";
const JANITOR_ROBOT_SELECTOR =
  EXPRESSION_OPEN +
  ' vars.HETZNER_FLEET_ONLINE != \'true\' && \'["ubuntu-latest"]\' || vars.ACTIONS_JANITOR_ROBOT_LANE_DISABLED == \'true\' && \'["ubuntu-latest"]\' || vars.ACTIONS_JANITOR_ROBOT_RUNNER_JSON || \'["self-hosted","Linux","X64","hetzner-robot"]\' }}';
// certification-hosted.yml only: a workflow_dispatch-only surface where the
// operator may explicitly request the robot pool. The input NEVER overrides
// the fleet gate — `robot` degrades to hosted whenever HETZNER_FLEET_ONLINE
// is not exactly 'true', so an offline fleet can strand nothing (#17813).
const CERTIFICATION_DISPATCH_SELECTOR =
  EXPRESSION_OPEN +
  " fromJSON(inputs.runner != 'robot' && '[\"ubuntu-24.04\"]' || vars.HETZNER_FLEET_ONLINE != 'true' && '[\"ubuntu-24.04\"]' || '[\"self-hosted\",\"hetzner-robot\"]') }}";
const DIRECT_RUNNER_SELECTORS = new Set([
  CANONICAL_SELECTOR,
  PULL_REQUEST_HOSTED_SELECTOR,
  FORCE_HOSTED_SELECTOR,
  CERTIFICATION_DISPATCH_SELECTOR,
]);
const JANITOR_WORKFLOW = "actions-zombie-janitor.yml";
// A literal self-hosted pin is allowed only for hardware that has no hosted
// substitute. `android-device` is the physical ARM64 handset lane: there is no
// GitHub-hosted runner with a device attached, so failing it closed to
// `ubuntu-24.04` would not degrade, it would just break. Every other literal
// self-hosted pin must carry the HETZNER_FLEET_ONLINE opt-in.
const PHYSICAL_DEVICE_LABELS = new Set(["android-device"]);
const DIRECT_RUNNER_PATH = /^jobs\.[^.]+\.runs-on$/;
const MATRIX_RUNNER_PATH =
  /^jobs\.[^.]+\.strategy\.matrix\.include\.\d+\.runner$/;
const JANITOR_ROUTE_PATH =
  /^jobs\.reap\.strategy\.matrix\.include\.\d+\.runner$/;

function lineAt(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

/**
 * Collect `jobs.<id>.runs-on` values that pin a literal self-hosted label list.
 * `collectFleetRoutes` only sees nodes that already mention the fleet variable
 * or the robot label, so a job hard-routed to a generic pool is invisible to
 * it — the routing contract can check the shape of an opt-in but not the
 * absence of one. These are the jobs that never opted in at all.
 */
function collectUnguardedSelfHostedRoutes(
  node,
  source,
  pathParts = [],
  routes = [],
) {
  if (isMap(node)) {
    for (const pair of node.items) {
      const key = isScalar(pair.key) ? String(pair.key.value) : "<key>";
      collectUnguardedSelfHostedRoutes(
        pair.value,
        source,
        [...pathParts, key],
        routes,
      );
    }
    return routes;
  }

  if (isSeq(node)) {
    const routePath = pathParts.join(".");
    const labels = node.items
      .filter((item) => isScalar(item) && typeof item.value === "string")
      .map((item) => String(item.value));
    if (
      DIRECT_RUNNER_PATH.test(routePath) &&
      labels.length === node.items.length &&
      labels.some((label) => label.toLowerCase() === "self-hosted") &&
      !labels.some((label) => PHYSICAL_DEVICE_LABELS.has(label.toLowerCase()))
    ) {
      routes.push({
        line: lineAt(source, node.range?.[0] ?? 0),
        path: routePath,
        value: `[${labels.join(", ")}]`,
      });
      return routes;
    }
    node.items.forEach((item, index) => {
      collectUnguardedSelfHostedRoutes(
        item,
        source,
        [...pathParts, String(index)],
        routes,
      );
    });
  }

  return routes;
}

function collectFleetRoutes(node, source, pathParts = [], routes = []) {
  if (isScalar(node)) {
    if (
      typeof node.value === "string" &&
      (node.value.includes("HETZNER_FLEET_ONLINE") ||
        node.value.includes("hetzner-robot"))
    ) {
      routes.push({
        line: lineAt(source, node.range?.[0] ?? 0),
        path: pathParts.join("."),
        value: node.value.replace(/\s+/g, " ").trim(),
      });
    }
    return routes;
  }

  if (isMap(node)) {
    for (const pair of node.items) {
      const key = isScalar(pair.key) ? String(pair.key.value) : "<key>";
      collectFleetRoutes(pair.value, source, [...pathParts, key], routes);
    }
    return routes;
  }

  if (isSeq(node)) {
    node.items.forEach((item, index) => {
      collectFleetRoutes(item, source, [...pathParts, String(index)], routes);
    });
  }

  return routes;
}

export function selectHetznerRunnerLabels(variableValue) {
  return variableValue === "true" ? FLEET_LABELS : HOSTED_LABELS;
}

export function validateHetznerFleetRouting(repoRoot) {
  const workflowsDir = path.join(repoRoot, ".github", "workflows");
  const failures = [];
  let selectors = 0;
  let files = 0;
  let janitorRouteFound = false;
  let hasJanitorWorkflow = false;

  for (const name of readdirSync(workflowsDir).sort()) {
    if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
    if (name === JANITOR_WORKFLOW) hasJanitorWorkflow = true;
    const source = readFileSync(path.join(workflowsDir, name), "utf8");
    const document = parseDocument(source, { uniqueKeys: true });
    if (document.errors.length > 0) {
      throw new Error(
        `${name}: invalid workflow YAML: ${document.errors.map((error) => error.message).join("; ")}`,
      );
    }

    for (const unguarded of collectUnguardedSelfHostedRoutes(
      document.contents,
      source,
    )) {
      failures.push(
        `${name}:${unguarded.line} (${unguarded.path}): ${unguarded.value} pins a self-hosted pool without the HETZNER_FLEET_ONLINE opt-in`,
      );
    }

    const routes = collectFleetRoutes(document.contents, source);
    if (routes.length === 0) continue;
    files += 1;
    selectors += routes.length;

    for (const route of routes) {
      const directRoute =
        DIRECT_RUNNER_PATH.test(route.path) &&
        DIRECT_RUNNER_SELECTORS.has(route.value);
      const indirectRoute =
        MATRIX_RUNNER_PATH.test(route.path) &&
        route.value === JANITOR_ROBOT_SELECTOR;
      const janitorRoute =
        name === JANITOR_WORKFLOW &&
        JANITOR_ROUTE_PATH.test(route.path) &&
        indirectRoute;
      if (janitorRoute) janitorRouteFound = true;
      if (directRoute || indirectRoute) continue;
      failures.push(`${name}:${route.line} (${route.path}): ${route.value}`);
    }
  }

  if (hasJanitorWorkflow && !janitorRouteFound) {
    failures.push(
      `${JANITOR_WORKFLOW}: jobs.reap robot-fleet matrix route must retain its explicit fleet opt-in and hosted fallback`,
    );
  }

  if (selectors === 0) {
    throw new Error("No HETZNER_FLEET_ONLINE runner selectors were found.");
  }
  if (failures.length > 0) {
    throw new Error(
      [
        "Hetzner runner routing must require explicit HETZNER_FLEET_ONLINE opt-in; missing, empty, false, and noncanonical values must use a hosted runner:",
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

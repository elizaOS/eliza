/**
 * CI-coverage ratchet for the packages/ui fixture e2e runners (#9310 §3.16).
 *
 * Every `run-*.mjs` runner under a packages/ui/src `__e2e__` dir drives REAL
 * shipped components in headless Chromium — coverage that exists only if something
 * actually invokes it. Historically most runners were CI-orphaned: they had a
 * package.json script but no workflow leg, so regressions they guard could
 * only be caught by hand. This test enforces, for every runner on disk:
 *
 *   1. a packages/ui package.json script references it, and
 *   2. at least one .github/workflows/*.yml invokes that script (or the
 *      runner path directly).
 *
 * Adding a new runner therefore requires wiring it into a workflow leg (see
 * ui-fixture-e2e.yml / ui-e2e-gate.yml / chat-shell-gestures.yml) in the same
 * change — or consciously deleting it.
 *
 * packages/scripts/__tests__ is outside workspace test discovery — this file
 * runs via an explicit `bun test` leg in .github/workflows/scenario-pr.yml.
 */

import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const uiRoot = path.join(repoRoot, "packages", "ui", "src");
const workflowsDir = path.join(repoRoot, ".github", "workflows");

function discoverRunners(): string[] {
  const found: string[] = [];
  const stack = [uiRoot];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        stack.push(path.join(dir, entry.name));
        continue;
      }
      if (
        entry.isFile() &&
        /^run-.*\.mjs$/.test(entry.name) &&
        path.basename(dir) === "__e2e__"
      ) {
        found.push(
          path
            .relative(repoRoot, path.join(dir, entry.name))
            .split(path.sep)
            .join("/"),
        );
      }
    }
  }
  return found.sort();
}

test("every packages/ui __e2e__ runner has a package script and a CI workflow leg", () => {
  const runners = discoverRunners();
  expect(runners.length).toBeGreaterThan(0);

  const pkg = JSON.parse(
    fs.readFileSync(
      path.join(repoRoot, "packages", "ui", "package.json"),
      "utf8",
    ),
  ) as { scripts?: Record<string, string> };
  const scripts = pkg.scripts ?? {};

  const workflows = fs
    .readdirSync(workflowsDir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => fs.readFileSync(path.join(workflowsDir, name), "utf8"))
    .join("\n");

  const problems: string[] = [];
  for (const runner of runners) {
    const basename = path.basename(runner);
    const scriptName = Object.keys(scripts).find((name) =>
      scripts[name].includes(basename),
    );
    if (!scriptName) {
      problems.push(
        `${runner}: no packages/ui package.json script references it — add one (or delete the runner)`,
      );
      continue;
    }
    const inWorkflow =
      workflows.includes(scriptName) || workflows.includes(basename);
    if (!inWorkflow) {
      problems.push(
        `${runner}: script "${scriptName}" is not invoked by any .github/workflows/*.yml — wire a leg (ui-fixture-e2e.yml) or delete the runner with justification`,
      );
    }
  }
  expect(problems).toEqual([]);
});

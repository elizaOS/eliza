#!/usr/bin/env node
// Directory-driven ui-smoke spec discovery for the keyless PR lane (issue #9943).
//
// The PR lane used to hand-name most ui-smoke specs across several jobs, which
// left the rest silently off the PR path. This script makes the run
// directory-driven instead: it walks every test/ui-smoke/**/*.spec.ts, subtracts
// the explicit, checked-in deny-list (.pr-deny-list.json), and emits the set of
// specs that should run keyless. Any NEW spec is on the PR path by default; the
// only way to exclude one is to record it in the deny-list with a category and a
// reason. The companion gate test/ui-smoke-coverage.test.ts enforces that.
//
// Modes:
//   --list        (default) print every runnable spec (all specs - deny-list),
//                 one relative path per line.
//   --list-auto   print the runnable specs that are NOT already hand-named in
//                 scenario-pr.yml — i.e. the catch-all set the auto-discovered
//                 workflow job runs — space-separated on one line. New specs land
//                 here automatically, so they always run on PR.
//   --json        print a machine-readable breakdown.
//   --check       validate the deny-list (entries reference real specs, have a
//                 valid category + non-empty reason, no duplicates) and exit
//                 non-zero on any problem.
//
// Paths are printed relative to packages/app (e.g. test/ui-smoke/foo.spec.ts),
// which is the cwd Playwright runs in via `bun run --cwd packages/app test:e2e`.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(SCRIPT_DIR, "..");
const REPO_ROOT = path.resolve(APP_DIR, "../..");
const UI_SMOKE_DIR = path.join(APP_DIR, "test", "ui-smoke");
const DENY_LIST_PATH = path.join(UI_SMOKE_DIR, ".pr-deny-list.json");
const WORKFLOW_PATH = path.join(
  REPO_ROOT,
  ".github",
  "workflows",
  "scenario-pr.yml",
);

const VALID_CATEGORIES = new Set([
  "live-only",
  "dedicated-tool",
  "keyless-debt",
]);

/** All spec file paths under test/ui-smoke, relative to that directory, sorted. */
function allSpecs() {
  const specs = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".spec.ts")) {
        specs.push(
          path.relative(UI_SMOKE_DIR, fullPath).split(path.sep).join("/"),
        );
      }
    }
  };
  walk(UI_SMOKE_DIR);
  return specs.sort();
}

/** Parsed deny-list manifest. */
function loadDenyList() {
  const raw = JSON.parse(readFileSync(DENY_LIST_PATH, "utf8"));
  if (!Array.isArray(raw.specs)) {
    throw new Error(`${DENY_LIST_PATH}: expected a "specs" array`);
  }
  return raw.specs;
}

/** Set of deny-listed spec paths relative to test/ui-smoke. */
function deniedSpecNames() {
  return new Set(loadDenyList().map((entry) => entry.spec));
}

/** Spec paths hand-named in scenario-pr.yml (test/ui-smoke/<path>.spec.ts). */
function namedInWorkflow() {
  const workflow = readFileSync(WORKFLOW_PATH, "utf8");
  return new Set(
    [...workflow.matchAll(/test\/ui-smoke\/([A-Za-z0-9_./-]+\.spec\.ts)/g)].map(
      (m) => m[1],
    ),
  );
}

/** Runnable specs = every spec that is not deny-listed. */
function runnableSpecs() {
  const denied = deniedSpecNames();
  return allSpecs().filter((name) => !denied.has(name));
}

/** Auto-discovered specs = runnable specs not already hand-named in the workflow. */
function autoDiscoveredSpecs() {
  const named = namedInWorkflow();
  return runnableSpecs().filter((name) => !named.has(name));
}

function toRelative(name) {
  return `test/ui-smoke/${name}`;
}

function runCheck() {
  const specs = new Set(allSpecs());
  const entries = loadDenyList();
  const problems = [];
  const seen = new Set();
  for (const entry of entries) {
    if (typeof entry.spec !== "string" || entry.spec.length === 0) {
      problems.push(`entry missing "spec": ${JSON.stringify(entry)}`);
      continue;
    }
    if (seen.has(entry.spec)) {
      problems.push(`duplicate deny-list entry: ${entry.spec}`);
    }
    seen.add(entry.spec);
    if (!specs.has(entry.spec)) {
      problems.push(
        `deny-list references a spec that does not exist: ${entry.spec}`,
      );
    }
    if (!VALID_CATEGORIES.has(entry.category)) {
      problems.push(
        `${entry.spec}: invalid category "${entry.category}" (expected one of ${[...VALID_CATEGORIES].join(", ")})`,
      );
    }
    if (typeof entry.reason !== "string" || entry.reason.trim().length === 0) {
      problems.push(`${entry.spec}: missing or empty reason`);
    }
  }
  if (problems.length > 0) {
    console.error("ui-smoke deny-list check FAILED:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  const runnable = runnableSpecs();
  const auto = autoDiscoveredSpecs();
  console.log(
    `ui-smoke deny-list OK: ${specs.size} specs total, ${entries.length} denied, ` +
      `${runnable.length} runnable on PR (${auto.length} via auto-discovery).`,
  );
}

const mode = process.argv[2] ?? "--list";

switch (mode) {
  case "--check":
    runCheck();
    break;
  case "--list-auto":
    process.stdout.write(autoDiscoveredSpecs().map(toRelative).join(" "));
    process.stdout.write("\n");
    break;
  case "--json":
    console.log(
      JSON.stringify(
        {
          total: allSpecs().length,
          denied: [...deniedSpecNames()].sort(),
          runnable: runnableSpecs(),
          namedInWorkflow: [...namedInWorkflow()].sort(),
          autoDiscovered: autoDiscoveredSpecs(),
        },
        null,
        2,
      ),
    );
    break;
  case "--list":
    for (const name of runnableSpecs()) console.log(toRelative(name));
    break;
  default:
    console.error(`Unknown mode: ${mode}`);
    console.error(
      "Usage: ui-smoke-pr-specs.mjs [--list|--list-auto|--json|--check]",
    );
    process.exit(2);
}

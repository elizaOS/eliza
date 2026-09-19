#!/usr/bin/env node
/**
 * Lists keyless browser specs for manual diagnosis using the maintained deny list.
 * The default develop suite is independently selected by Playwright; --list-auto
 * omits specs explicitly named by a dedicated canonical CI harness.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(SCRIPT_DIR, "..");
const REPO_ROOT = path.resolve(APP_DIR, "../..");
const UI_SMOKE_DIR = path.join(APP_DIR, "test", "ui-smoke");
const DENY_LIST_PATH = path.join(UI_SMOKE_DIR, ".pr-deny-list.json");
const WORKFLOW_PATH = path.join(REPO_ROOT, ".github", "workflows", "ci.yml");

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

/** Spec paths hand-named in ci.yml (test/ui-smoke/<path>.spec.ts). */
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
      `${runnable.length} runnable for keyless diagnosis (${auto.length} via auto-discovery).`,
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

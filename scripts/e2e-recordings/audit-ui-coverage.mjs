#!/usr/bin/env node
/**
 * Audits the unified UI E2E recording manifest.
 *
 * This does not run the browser suites. It verifies that every manifest entry
 * points at a real package script and that known standalone UI Playwright
 * packages are either runnable in the manifest or explicitly accounted for.
 */

import fs from "node:fs";
import path from "node:path";
import {
  REPO_ROOT,
  SKIPPED_EXTERNAL_UI_E2E_SUITES,
  UI_E2E_COVERED_BY_APP,
  UI_E2E_SUITES,
} from "./suites.mjs";

const REQUIRED_STANDALONE_UI_DIRS = [
  "packages/app",
  "packages/cloud-frontend",
  "packages/test/cloud-e2e",
  "packages/homepage",
  "packages/os-homepage",
  "packages/os/usb-installer",
  "packages/ui",
  "plugins/plugin-facewear/app-xr",
  "packages/feed/tools/dag-visualizer",
];

const coveredDirs = new Set([
  ...UI_E2E_SUITES.map((suite) => suite.configDir),
  ...UI_E2E_COVERED_BY_APP.map((suite) => suite.configDir),
  ...SKIPPED_EXTERNAL_UI_E2E_SUITES.map((suite) => suite.configDir),
]);

function readPackageJson(configDir) {
  const packageJsonPath = path.join(REPO_ROOT, configDir, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`${configDir}: missing package.json`);
  }
  return JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
}

function fail(message) {
  console.error(`[ui-e2e-audit] ERROR ${message}`);
  process.exitCode = 1;
}

for (const suite of UI_E2E_SUITES) {
  try {
    const packageJson = readPackageJson(suite.configDir);
    if (!packageJson.scripts?.[suite.script]) {
      fail(`${suite.name}: ${suite.configDir} has no "${suite.script}" script`);
    }
    if (!suite.coverage || suite.coverage.length < 40) {
      fail(`${suite.name}: coverage description is missing or too terse`);
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

for (const configDir of REQUIRED_STANDALONE_UI_DIRS) {
  if (!coveredDirs.has(configDir)) {
    fail(`${configDir}: standalone UI package is not in the E2E manifest`);
  }
}

const duplicateNames = UI_E2E_SUITES.map((suite) => suite.name).filter(
  (name, index, all) => all.indexOf(name) !== index,
);
if (duplicateNames.length > 0) {
  fail(`duplicate suite names: ${[...new Set(duplicateNames)].join(", ")}`);
}

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log(
  `[ui-e2e-audit] ${UI_E2E_SUITES.length} runnable UI E2E suites audited; ${UI_E2E_COVERED_BY_APP.length} covered-through-app entries; ${SKIPPED_EXTERNAL_UI_E2E_SUITES.length} external suites documented.`,
);

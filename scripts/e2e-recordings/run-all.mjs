#!/usr/bin/env node

/**
 * run-all.mjs
 *
 * Orchestrates running all E2E suites with recording enabled, then generates
 * contact sheets and the viewer index.
 *
 * Usage:
 *   node scripts/e2e-recordings/run-all.mjs
 *
 * Options:
 *   --packages=<comma-list>   Run only the named packages (e.g. --packages=homepage,app-core)
 *   --skip-tests              Skip running tests; only regenerate sheets + viewer
 *   --skip-sheets             Skip generating contact sheets
 *   --skip-viewer             Skip generating the viewer index
 *   --capture                 Also run the per-platform native capture suites
 *                             (android-emu / ios-sim / desktop) — issue #9944.
 *                             Each self-skips when its platform/tooling/device
 *                             is unavailable. Also enabled by E2E_CAPTURE=1.
 *   --capture-only            Run ONLY the capture suites (no UI suites/sheets).
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CAPTURE_SUITES,
  RECORDINGS_DIR,
  REPO_ROOT,
  UI_E2E_SUITES,
} from "./suites.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCRIPTS_DIR = __dirname;
const PACKAGES = UI_E2E_SUITES;

// ─── CLI argument parsing ────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flagMap = new Map();
for (const arg of args) {
  const [key, val] = arg.replace(/^--/, "").split("=");
  flagMap.set(key, val ?? true);
}

const onlyPackages = flagMap.has("packages")
  ? String(flagMap.get("packages"))
      .split(",")
      .map((s) => s.trim())
  : null;

const captureOnly =
  flagMap.get("capture-only") === true ||
  flagMap.get("capture-only") === "true";
const runCapture =
  captureOnly ||
  flagMap.get("capture") === true ||
  flagMap.get("capture") === "true" ||
  process.env.E2E_CAPTURE === "1";

const skipTests =
  flagMap.get("skip-tests") === true || flagMap.get("skip-tests") === "true";
const skipSheets =
  flagMap.get("skip-sheets") === true || flagMap.get("skip-sheets") === "true";
const skipViewer =
  flagMap.get("skip-viewer") === true || flagMap.get("skip-viewer") === "true";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function banner(text) {
  const line = "─".repeat(60);
  console.log(`\n${line}`);
  console.log(`  ${text}`);
  console.log(`${line}`);
}

function runScript(scriptFile) {
  const result = spawnSync(
    process.execPath, // node
    [scriptFile],
    {
      cwd: REPO_ROOT,
      stdio: "inherit",
      env: { ...process.env },
    },
  );
  return result.status ?? 1;
}

/**
 * Run a single package's E2E test suite with recording enabled.
 * Returns { name, passed: boolean, skipped: boolean, exitCode: number }.
 */
function runPackageTests(pkg) {
  const configDirAbs = path.join(REPO_ROOT, pkg.configDir);

  // Skip if the package directory doesn't exist
  if (!fs.existsSync(configDirAbs)) {
    console.warn(
      `  [skip] ${pkg.name}: directory not found (${pkg.configDir})`,
    );
    return { name: pkg.name, passed: false, skipped: true, exitCode: -1 };
  }

  // Check the script exists in package.json
  let pkgJson;
  try {
    pkgJson = JSON.parse(
      fs.readFileSync(path.join(configDirAbs, "package.json"), "utf8"),
    );
  } catch {
    console.warn(`  [skip] ${pkg.name}: could not read package.json`);
    return { name: pkg.name, passed: false, skipped: true, exitCode: -1 };
  }

  if (!pkgJson.scripts?.[pkg.script]) {
    console.warn(
      `  [skip] ${pkg.name}: script "${pkg.script}" not defined in package.json`,
    );
    return { name: pkg.name, passed: false, skipped: true, exitCode: -1 };
  }

  // Ensure the recording output directory exists so Playwright has somewhere to write
  const recordingOut = path.join(RECORDINGS_DIR, pkg.name, "test-results");
  fs.mkdirSync(recordingOut, { recursive: true });

  console.log(`  Running: bun run --cwd ${pkg.configDir} ${pkg.script}`);
  console.log(`  Output:  e2e-recordings/${pkg.name}/test-results/`);

  const result = spawnSync("bun", ["run", "--cwd", pkg.configDir, pkg.script], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      // Signal to Playwright config that we want full recording.
      // The config itself computes outputDir from import.meta.dirname + E2E_RECORD.
      E2E_RECORD: "1",
      // Per-package extra env (e.g. ELIZA_UI_SMOKE_FORCE_STUB for the app package).
      ...(pkg.recordEnv ?? {}),
    },
  });

  const exitCode = result.status ?? 1;
  const passed = exitCode === 0;

  if (passed) {
    console.log(`  ✓ ${pkg.name} passed`);
  } else {
    console.warn(`  ✗ ${pkg.name} failed (exit ${exitCode})`);
  }

  return { name: pkg.name, passed, skipped: false, exitCode };
}

/**
 * Run a single per-platform capture suite (issue #9944) by importing its helper
 * and calling its exported capture function. The helper self-skips with a reason
 * (no throw) when its platform/tooling/device is unavailable.
 * Returns { name, passed, skipped, exitCode }.
 */
async function runCaptureSuite(suite, options = {}) {
  const moduleUrl = pathToFileURL(path.join(REPO_ROOT, suite.module)).href;
  let result;
  try {
    const mod = await import(moduleUrl);
    const fn = mod[suite.exportName];
    if (typeof fn !== "function") {
      console.warn(
        `  [skip] ${suite.name}: ${suite.exportName} not exported from ${suite.module}`,
      );
      return { name: suite.name, passed: false, skipped: true, exitCode: -1 };
    }
    result = await fn(options);
  } catch (err) {
    console.warn(`  ✗ ${suite.name} failed: ${err.message}`);
    return { name: suite.name, passed: false, skipped: false, exitCode: 1 };
  }

  if (result.skipped) {
    console.warn(`  [skip] ${suite.name}: ${result.reason}`);
    return { name: suite.name, passed: false, skipped: true, exitCode: -1 };
  }
  if (result.error) {
    console.warn(`  ✗ ${suite.name} failed: ${result.error}`);
    return { name: suite.name, passed: false, skipped: false, exitCode: 1 };
  }
  for (const [kind, file] of Object.entries(result.artifacts ?? {})) {
    if (file) console.log(`  • ${kind}: ${file}`);
  }
  console.log(`  ✓ ${suite.name} captured`);
  return { name: suite.name, passed: true, skipped: false, exitCode: 0 };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();

  // Filter packages if --packages flag was supplied
  const packagesToRun = onlyPackages
    ? PACKAGES.filter((p) => onlyPackages.includes(p.name))
    : PACKAGES;

  if (onlyPackages && packagesToRun.length === 0) {
    console.error(`No packages matched: ${onlyPackages.join(", ")}`);
    console.error(
      `Available packages: ${PACKAGES.map((p) => p.name).join(", ")}`,
    );
    process.exit(1);
  }

  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

  // ─── Step 1: Run tests ─────────────────────────────────────
  const results = [];

  if (captureOnly) {
    console.log("Capture-only run: skipping UI E2E suites.");
  } else if (skipTests) {
    console.log("Skipping test runs (--skip-tests).");
    for (const pkg of packagesToRun) {
      results.push({
        name: pkg.name,
        passed: true,
        skipped: true,
        exitCode: 0,
      });
    }
  } else {
    banner("Running E2E test suites");
    for (const pkg of packagesToRun) {
      console.log(`\n▶ ${pkg.name}`);
      const r = runPackageTests(pkg);
      results.push(r);
    }
  }

  // ─── Step 1b: Per-platform native capture suites (opt-in) ──
  if (runCapture) {
    banner("Running per-platform capture suites (#9944)");
    // Forward shared capture flags so `capture:all --serial X --seconds 3` etc. work.
    const captureOptions = {};
    for (const key of ["issue", "slug", "seconds", "serial", "out"]) {
      const value = flagMap.get(key);
      if (value !== undefined && value !== true) captureOptions[key] = value;
    }
    for (const suite of CAPTURE_SUITES) {
      console.log(`\n▶ ${suite.name}`);
      results.push(await runCaptureSuite(suite, captureOptions));
    }
  }

  // ─── Step 2: Generate contact sheets ──────────────────────
  if (!skipSheets && !captureOnly) {
    banner("Generating contact sheets");
    const sheetsScript = path.join(SCRIPTS_DIR, "generate-contact-sheets.mjs");
    if (fs.existsSync(sheetsScript)) {
      const code = runScript(sheetsScript);
      if (code !== 0) {
        console.warn(
          `[warn] generate-contact-sheets.mjs exited with code ${code}`,
        );
      }
    } else {
      console.warn("[warn] generate-contact-sheets.mjs not found — skipping");
    }
  } else {
    console.log("Skipping contact sheet generation (--skip-sheets).");
  }

  // ─── Step 3: Generate viewer ───────────────────────────────
  if (!skipViewer && !captureOnly) {
    banner("Generating viewer index");
    const viewerScript = path.join(SCRIPTS_DIR, "generate-viewer.mjs");
    if (fs.existsSync(viewerScript)) {
      const code = runScript(viewerScript);
      if (code !== 0) {
        console.warn(`[warn] generate-viewer.mjs exited with code ${code}`);
      }
    } else {
      console.warn("[warn] generate-viewer.mjs not found — skipping");
    }
  } else {
    console.log("Skipping viewer generation (--skip-viewer).");
  }

  // ─── Summary ───────────────────────────────────────────────
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  banner("Summary");

  const passed = results.filter((r) => r.passed && !r.skipped);
  const failed = results.filter((r) => !r.passed && !r.skipped);
  const skipped = results.filter((r) => r.skipped);

  if (passed.length > 0) {
    console.log(`\nPassed (${passed.length}):`);
    for (const r of passed) console.log(`  ✓ ${r.name}`);
  }
  if (failed.length > 0) {
    console.log(`\nFailed (${failed.length}):`);
    for (const r of failed) console.log(`  ✗ ${r.name}  (exit ${r.exitCode})`);
  }
  if (skipped.length > 0) {
    console.log(`\nSkipped (${skipped.length}):`);
    for (const r of skipped) console.log(`  - ${r.name}`);
  }

  const indexPath = path.join(RECORDINGS_DIR, "index.html");
  if (fs.existsSync(indexPath)) {
    console.log(`\nViewer: ${indexPath}`);
    console.log(`        file://${indexPath}`);
  }

  console.log(`\nTotal time: ${elapsed}s`);

  // Exit non-zero if any suite failed
  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

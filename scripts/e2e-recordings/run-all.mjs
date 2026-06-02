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
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RECORDINGS_DIR, REPO_ROOT, UI_E2E_SUITES } from "./suites.mjs";

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

  if (skipTests) {
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

  // ─── Step 2: Generate contact sheets ──────────────────────
  if (!skipSheets) {
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
  if (!skipViewer) {
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

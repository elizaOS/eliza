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
import { resolveRequireEvidence } from "../../packages/app/scripts/lib/issue-evidence.mjs";
import { RECORDINGS_DIR, REPO_ROOT, UI_E2E_SUITES } from "./suites.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SKIP_EXIT_CODE = 77;

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

// When evidence is required (explicit --require-evidence, or auto-on under CI),
// a suite that soft-skips (SKIP_EXIT_CODE=77, missing dir/script/package.json,
// or an unavailable availability-check) produced ZERO artifacts and must count
// as a FAILURE, not a benign skip. Otherwise the recordings sweep goes green on
// a headless runner with nothing captured (#13624 "green-with-nothing"). We
// hand argv explicitly (stripping the `=value` join key parsing above only
// affects flagMap; resolveRequireEvidence re-scans raw argv).
const requireEvidence = resolveRequireEvidence(args);

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

function formatCommand(command) {
  return command.join(" ");
}

function resolveCommand(command) {
  const [bin, ...args] = command;
  return [bin === "node" ? process.execPath : bin, args];
}

function runCommandSuite(pkg) {
  if (pkg.checkCommand) {
    const [checkBin, checkArgs] = resolveCommand(pkg.checkCommand);
    const check = spawnSync(checkBin, checkArgs, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env },
    });
    const checkOutput = [check.stdout, check.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    if (check.status === SKIP_EXIT_CODE) {
      const reason = checkOutput || "platform/tooling unavailable";
      console.warn(`  [skip] ${pkg.name}: ${reason}`);
      return {
        name: pkg.name,
        passed: false,
        skipped: true,
        exitCode: SKIP_EXIT_CODE,
        reason,
      };
    }
    if (check.status !== 0) {
      if (checkOutput) console.warn(checkOutput);
      console.warn(
        `  ✗ ${pkg.name} availability check failed (exit ${check.status})`,
      );
      return {
        name: pkg.name,
        passed: false,
        skipped: false,
        exitCode: check.status ?? 1,
      };
    }
  }

  const outputDir = path.join(RECORDINGS_DIR, pkg.name, "test-results");
  fs.mkdirSync(outputDir, { recursive: true });
  console.log(`  Running: ${formatCommand(pkg.command)}`);
  console.log(`  Output:  e2e-recordings/${pkg.name}/test-results/`);

  const [bin, args] = resolveCommand(pkg.command);
  const result = spawnSync(bin, args, {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      E2E_RECORD: "1",
      ...(pkg.recordEnv ?? {}),
    },
  });

  const exitCode = result.status ?? 1;
  const passed = exitCode === 0;
  if (passed) {
    console.log(`  ✓ ${pkg.name} passed`);
  } else if (exitCode === SKIP_EXIT_CODE) {
    console.warn(`  [skip] ${pkg.name}: platform/tooling unavailable`);
    return {
      name: pkg.name,
      passed: false,
      skipped: true,
      exitCode,
      reason: "platform/tooling unavailable",
    };
  } else {
    console.warn(`  ✗ ${pkg.name} failed (exit ${exitCode})`);
  }

  return { name: pkg.name, passed, skipped: false, exitCode };
}

/**
 * Run a single package's E2E test suite with recording enabled.
 * Returns { name, passed: boolean, skipped: boolean, exitCode: number }.
 */
function runPackageTests(pkg) {
  if (pkg.command) return runCommandSuite(pkg);

  const configDirAbs = path.join(REPO_ROOT, pkg.configDir);

  // Skip if the package directory doesn't exist
  if (!fs.existsSync(configDirAbs)) {
    console.warn(
      `  [skip] ${pkg.name}: directory not found (${pkg.configDir})`,
    );
    return {
      name: pkg.name,
      passed: false,
      skipped: true,
      exitCode: -1,
      reason: `directory not found (${pkg.configDir})`,
    };
  }

  // Check the script exists in package.json
  let pkgJson;
  try {
    pkgJson = JSON.parse(
      fs.readFileSync(path.join(configDirAbs, "package.json"), "utf8"),
    );
  } catch {
    console.warn(`  [skip] ${pkg.name}: could not read package.json`);
    return {
      name: pkg.name,
      passed: false,
      skipped: true,
      exitCode: -1,
      reason: "could not read package.json",
    };
  }

  if (!pkgJson.scripts?.[pkg.script]) {
    console.warn(
      `  [skip] ${pkg.name}: script "${pkg.script}" not defined in package.json`,
    );
    return {
      name: pkg.name,
      passed: false,
      skipped: true,
      exitCode: -1,
      reason: `script "${pkg.script}" not defined in package.json`,
    };
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

  if (skipTests && requireEvidence) {
    console.error(
      "[require-evidence] --skip-tests cannot be combined with --require-evidence: " +
        "a run that skips every suite captures no evidence.",
    );
    process.exit(1);
  }

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

  const { passed, failed, softSkipped, skippedButRequired } =
    classifyRunResults(results, requireEvidence);

  if (passed.length > 0) {
    console.log(`\nPassed (${passed.length}):`);
    for (const r of passed) console.log(`  ✓ ${r.name}`);
  }
  if (failed.length > 0) {
    console.log(`\nFailed (${failed.length}):`);
    for (const r of failed) {
      const why = r.skipped
        ? `skipped but evidence required${r.reason ? `: ${r.reason}` : ""}`
        : `exit ${r.exitCode}`;
      console.log(`  ✗ ${r.name}  (${why})`);
    }
  }
  if (softSkipped.length > 0) {
    console.log(`\nSkipped (${softSkipped.length}):`);
    for (const r of softSkipped) {
      console.log(`  - ${r.name}${r.reason ? `: ${r.reason}` : ""}`);
    }
  }
  if (requireEvidence && skippedButRequired.length > 0) {
    console.warn(
      `\n[require-evidence] ${skippedButRequired.length} suite(s) skipped with no artifacts — failing the run.`,
    );
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

// Exported so the require-evidence exit contract is unit-testable without
// spawning the full sweep. Under --require-evidence a `skipped` suite captured
// ZERO artifacts, so it must count as a FAILURE (not a benign skip) — otherwise
// the recordings sweep goes green on a headless runner having recorded nothing
// (#13624 "green-with-nothing"). Without the flag, behavior is preserved: a
// skip stays a soft skip and only real non-zero exits fail the run.
export function classifyRunResults(results, requireEvidence) {
  const passed = results.filter((r) => r.passed && !r.skipped);
  const skipped = results.filter((r) => r.skipped);
  const failedRuns = results.filter((r) => !r.passed && !r.skipped);
  const skippedButRequired = requireEvidence ? skipped : [];
  const softSkipped = requireEvidence ? [] : skipped;
  const failed = [...failedRuns, ...skippedButRequired];
  return {
    passed,
    failed,
    softSkipped,
    skippedButRequired,
    shouldFail: failed.length > 0,
  };
}

// The orchestrator self-executes only when run as a script, so the pure helper
// above can be imported by tests without kicking off the whole sweep.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}

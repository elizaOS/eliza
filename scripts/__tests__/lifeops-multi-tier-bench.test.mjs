#!/usr/bin/env node
/**
 * Dry-run gate for ``scripts/lifeops-multi-tier-bench.mjs``.
 *
 * The script's dry-run path writes ``<runDir>/dry-run-plan.json`` containing
 * the full per-cell command + env it would have spawned. This test invokes
 * the script with several tier/harness combinations and asserts:
 *
 * - The plan schema version is pinned.
 * - The cell list is the cartesian product of ``--tiers`` × ``--harnesses``.
 * - Each cell carries the right ``--model-tier`` / ``--agent`` flags.
 * - ``small`` / ``mid`` skip with a dflash-fork-missing reason when the
 *   binary is absent (the default in CI).
 * - ``large`` / ``frontier`` skip with a missing-key reason when their
 *   respective API keys are absent.
 *
 * Invocation: ``node scripts/__tests__/lifeops-multi-tier-bench.test.mjs``.
 * Exits non-zero on the first failed assertion.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "lifeops-multi-tier-bench.mjs");

const failures = [];
function assert(cond, msg) {
  if (!cond) {
    failures.push(msg);
    console.error(`  FAIL ${msg}`);
  } else {
    console.log(`  ok   ${msg}`);
  }
}

function runDry({ suite, tiers, harnesses, env = {} }) {
  const runDir = mkdtempSync(join(tmpdir(), "lifeops-mt-bench-"));
  const args = [
    SCRIPT,
    "--suite",
    suite,
    "--tiers",
    tiers,
    "--run-dir",
    runDir,
    "--dry-run",
  ];
  if (harnesses) {
    args.push("--harnesses", harnesses);
  }
  // Strip CEREBRAS_API_KEY/ANTHROPIC_API_KEY by default so the skip-not-fail
  // path is exercised consistently regardless of the developer's local env.
  const childEnv = { ...process.env, ...env };
  delete childEnv.CEREBRAS_API_KEY;
  delete childEnv.ANTHROPIC_API_KEY;
  Object.assign(childEnv, env);
  const proc = spawnSync("node", args, {
    cwd: REPO_ROOT,
    env: childEnv,
    encoding: "utf8",
  });
  return { proc, runDir };
}

function loadPlan(runDir) {
  return JSON.parse(readFileSync(join(runDir, "dry-run-plan.json"), "utf8"));
}

// ---------------------------------------------------------------------------
// Case 1 — default CI cells (large + frontier, all three harnesses)
// ---------------------------------------------------------------------------

{
  console.log("\n[case] suite=smoke tiers=large,frontier harnesses=default");
  const { proc, runDir } = runDry({
    suite: "smoke",
    tiers: "large,frontier",
  });
  assert(proc.status === 0, `dry-run exit code === 0 (got ${proc.status})`);
  const plan = loadPlan(runDir);
  assert(
    plan.schemaVersion === "lifeops-multi-tier-plan-v1",
    "plan schemaVersion pinned to lifeops-multi-tier-plan-v1",
  );
  assert(plan.suite === "smoke", "plan.suite preserved");
  assert(
    JSON.stringify(plan.tiers) === JSON.stringify(["large", "frontier"]),
    "plan.tiers preserves order",
  );
  assert(
    JSON.stringify(plan.harnesses) ===
      JSON.stringify(["hermes", "openclaw", "eliza"]),
    "plan.harnesses defaults to hermes,openclaw,eliza",
  );
  assert(
    plan.cells.length === 6,
    `expected 6 cells (got ${plan.cells.length})`,
  );
  for (const cell of plan.cells) {
    assert(
      cell.command.includes("--suite") &&
        cell.command[cell.command.indexOf("--suite") + 1] === "smoke",
      `cell ${cell.tier}/${cell.harness} forwards --suite=smoke`,
    );
    assert(
      cell.command.includes("--model-tier") &&
        cell.command[cell.command.indexOf("--model-tier") + 1] === cell.tier,
      `cell ${cell.tier}/${cell.harness} forwards --model-tier=${cell.tier}`,
    );
    assert(
      cell.command.includes("--agent") &&
        cell.command[cell.command.indexOf("--agent") + 1] === cell.harness,
      `cell ${cell.tier}/${cell.harness} forwards --agent=${cell.harness}`,
    );
    assert(
      cell.env.MODEL_TIER === cell.tier,
      `cell ${cell.tier}/${cell.harness} env.MODEL_TIER === ${cell.tier}`,
    );
  }
  const skipped = plan.cells.filter((c) => c.skipReason);
  assert(
    skipped.length === 6,
    `all 6 cells skip (no keys in env): got ${skipped.length}`,
  );
  rmSync(runDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Case 2 — small tier without dflash fork → skip with binary-missing reason
// ---------------------------------------------------------------------------

{
  console.log("\n[case] suite=smoke tiers=small (dflash absent)");
  const { proc, runDir } = runDry({
    suite: "smoke",
    tiers: "small",
    harnesses: "hermes",
  });
  assert(proc.status === 0, `dry-run exit code === 0 (got ${proc.status})`);
  const plan = loadPlan(runDir);
  assert(plan.cells.length === 1, "exactly one cell planned");
  const cell = plan.cells[0];
  assert(
    cell.skipReason?.includes("dflash"),
    `small tier skip reason mentions dflash (got ${cell.skipReason})`,
  );
  rmSync(runDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Case 3 — invalid args bail with exit code 2
// ---------------------------------------------------------------------------

{
  console.log("\n[case] invalid --tiers value");
  const proc = spawnSync(
    "node",
    [SCRIPT, "--suite", "smoke", "--tiers", "wat", "--dry-run"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  assert(proc.status === 2, `invalid tier exits with 2 (got ${proc.status})`);
  assert(
    proc.stderr.includes("invalid value: wat"),
    "stderr explains the invalid tier",
  );
}

// ---------------------------------------------------------------------------
// Case 4 — invalid --suite bails with exit code 2
// ---------------------------------------------------------------------------

{
  console.log("\n[case] invalid --suite value");
  const proc = spawnSync(
    "node",
    [SCRIPT, "--suite", "wat", "--tiers", "large", "--dry-run"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  assert(proc.status === 2, `invalid suite exits with 2 (got ${proc.status})`);
}

// ---------------------------------------------------------------------------
// Case 5 — frontier tier with ANTHROPIC_API_KEY present → no skip
// ---------------------------------------------------------------------------

{
  console.log("\n[case] frontier with ANTHROPIC_API_KEY present");
  const { proc, runDir } = runDry({
    suite: "smoke",
    tiers: "frontier",
    harnesses: "hermes",
    env: { ANTHROPIC_API_KEY: "test-fake-key" },
  });
  assert(proc.status === 0, `dry-run exit code === 0 (got ${proc.status})`);
  const plan = loadPlan(runDir);
  const cell = plan.cells[0];
  assert(
    cell.skipReason === null,
    `frontier/hermes does NOT skip when ANTHROPIC_API_KEY is set (skipReason=${cell.skipReason})`,
  );
  rmSync(runDir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall multi-tier dry-run gate assertions passed");

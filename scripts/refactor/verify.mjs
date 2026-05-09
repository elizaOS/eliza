#!/usr/bin/env bun
// P7 — Verify the refactor end-to-end.
//
// Runs the canonical health checks after applying P0–P6. Each check prints
// its own output; this script summarizes pass/fail at the end. By default,
// it stops at the first failing check (--keep-going to continue past failures).
//
// Usage:
//   bun scripts/refactor/verify.mjs               # run all checks, stop on first fail
//   bun scripts/refactor/verify.mjs --keep-going  # run all even if some fail
//   bun scripts/refactor/verify.mjs --skip-test   # skip vitest (for quick iterations)
//   bun scripts/refactor/verify.mjs --only build  # only the named check

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..");
})();

const ALL_CHECKS = [
  {
    id: "install",
    title: "bun install (workspace symlinks)",
    cmd: ["bun", ["install"]],
  },
  {
    id: "build",
    title: "bun run build (turbo)",
    cmd: ["bun", ["run", "build"]],
    requires: ["install"],
  },
  {
    id: "typecheck",
    title: "bun run typecheck (against src)",
    cmd: ["bun", ["run", "typecheck"]],
    requires: ["build"],
  },
  {
    id: "typecheck:dist",
    title: "bun run typecheck:dist (against built shape)",
    cmd: ["bun", ["run", "typecheck:dist"]],
    requires: ["build"],
    optional: true, // exists only after P5
  },
  {
    id: "test",
    title: "bun run test",
    cmd: ["bun", ["run", "test"]],
    requires: ["build"],
    skippable: "--skip-test",
  },
  {
    id: "publish-dry-run",
    title: "bun scripts/publish-from-dist.mjs (dry-run)",
    cmd: ["bun", ["scripts/publish-from-dist.mjs"]],
    requires: ["build"],
    optional: true, // exists only after P4
  },
  {
    id: "circular-deps",
    title: "Circular dependency check",
    cmd: ["bun", ["x", "turbo", "run", "build", "--dry-run=json"]],
    parser: (out) => {
      if (out.includes("Circular package dependency")) return "FAIL: cycle present";
      return null;
    },
  },
];

function parseArgs() {
  const argv = process.argv.slice(2);
  return {
    keepGoing: argv.includes("--keep-going"),
    skipTest: argv.includes("--skip-test"),
    only: argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : null,
  };
}

function main() {
  const flags = parseArgs();
  const checks = flags.only
    ? ALL_CHECKS.filter((c) => c.id === flags.only)
    : ALL_CHECKS;

  console.log(`\n── Verify (${checks.length} checks) ${"─".repeat(50)}\n`);

  const results = [];
  for (const check of checks) {
    if (check.skippable && flags[check.skippable.replace(/^--/, "").replace(/-/g, "")]) {
      results.push({ id: check.id, status: "skip", reason: "by flag" });
      console.log(`⏭  ${check.title} (skipped)`);
      continue;
    }
    if (check.optional) {
      // Optional checks: skip if their script/task doesn't exist
      const ok = checkExists(check);
      if (!ok) {
        results.push({ id: check.id, status: "skip", reason: "task missing" });
        console.log(`⏭  ${check.title} (task not present yet)`);
        continue;
      }
    }
    console.log(`▶  ${check.title}`);
    const start = Date.now();
    try {
      const out = execFileSync(check.cmd[0], check.cmd[1], {
        cwd: REPO_ROOT,
        stdio: check.parser ? "pipe" : "inherit",
        encoding: "utf8",
      });
      if (check.parser) {
        const failure = check.parser(out);
        if (failure) {
          results.push({ id: check.id, status: "fail", reason: failure, elapsed: Date.now() - start });
          console.log(`✗  ${check.title} — ${failure}`);
          if (!flags.keepGoing) break;
          continue;
        }
      }
      results.push({ id: check.id, status: "pass", elapsed: Date.now() - start });
      console.log(`✓  ${check.title} (${(Date.now() - start) / 1000}s)`);
    } catch (err) {
      results.push({ id: check.id, status: "fail", reason: err.message, elapsed: Date.now() - start });
      console.log(`✗  ${check.title} (failed)`);
      if (!flags.keepGoing) break;
    }
  }

  console.log(`\n── Summary ${"─".repeat(60)}`);
  let pass = 0, fail = 0, skip = 0;
  for (const r of results) {
    const icon = r.status === "pass" ? "✓" : r.status === "fail" ? "✗" : "⏭";
    const ms = r.elapsed != null ? ` (${(r.elapsed / 1000).toFixed(1)}s)` : "";
    console.log(`  ${icon} ${r.id}${ms}${r.reason ? ` — ${r.reason}` : ""}`);
    if (r.status === "pass") pass++;
    else if (r.status === "fail") fail++;
    else skip++;
  }
  console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
  process.exit(fail > 0 ? 1 : 0);
}

function checkExists(check) {
  // For optional checks, sniff out whether the underlying script exists.
  if (check.id === "typecheck:dist") {
    const pkg = JSON.parse(
      require("node:fs").readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
    );
    return Boolean(pkg.scripts?.["typecheck:dist"]);
  }
  if (check.id === "publish-dry-run") {
    return existsSync(join(REPO_ROOT, "scripts/publish-from-dist.mjs"));
  }
  return true;
}

main();

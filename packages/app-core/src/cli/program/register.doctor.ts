import { spawnSync } from "node:child_process";
import type { Command } from "commander";
import { theme } from "../../terminal/theme";
import { runCommandWithRuntime } from "../cli-utils";
import type { CheckCategory, CheckResult, CheckStatus } from "../doctor/checks";

const defaultRuntime = { error: console.error, exit: process.exit };

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const CATEGORY_LABELS: Record<CheckCategory, string> = {
  system: "System",
  config: "Configuration",
  storage: "Storage",
  network: "Network",
};

function statusIcon(status: CheckStatus): string {
  switch (status) {
    case "pass":
      return theme.success("✓");
    case "fail":
      return theme.error("✗");
    case "warn":
      return theme.warn("⚠");
    case "skip":
      return theme.muted("–");
  }
}

function printResult(result: CheckResult): void {
  const icon = statusIcon(result.status);
  const label = result.label.padEnd(20);
  const detail = result.detail ? theme.muted(result.detail) : "";
  console.log(`  ${icon} ${label} ${detail}`);
  if (result.fix && result.status !== "pass") {
    console.log(`      ${theme.muted("fix:")} ${theme.command(result.fix)}`);
  }
}

function printGrouped(results: CheckResult[]): void {
  const byCategory = new Map<CheckCategory, CheckResult[]>();
  const order: CheckCategory[] = ["system", "config", "storage", "network"];

  for (const cat of order) {
    byCategory.set(cat, []);
  }
  for (const r of results) {
    byCategory.get(r.category)?.push(r);
  }

  let first = true;
  for (const cat of order) {
    const group = byCategory.get(cat);
    if (!group?.length) continue;

    if (!first) console.log();
    first = false;

    console.log(`  ${theme.muted(CATEGORY_LABELS[cat])}`);
    for (const result of group) {
      printResult(result);
    }
  }
}

// ---------------------------------------------------------------------------
// --fix: auto-remediate autoFixable results
// ---------------------------------------------------------------------------

function attemptFix(result: CheckResult): boolean {
  if (!result.fix || !result.autoFixable) return false;

  // Only auto-run eliza sub-commands — don't blindly shell out to arbitrary
  // fix strings (e.g. chmod commands require explicit user confirmation).
  if (!result.fix.startsWith("eliza ")) return false;

  const args = result.fix.split(/\s+/).slice(1); // strip "eliza"
  console.log(
    `\n  ${theme.muted("→ auto-fix:")} ${theme.command(result.fix)}\n`,
  );

  // Resolve the eliza binary: prefer the one already running, fall back to
  // looking it up in PATH.
  const bin =
    process.env.ELIZA_BIN ??
    (process.execArgv.length === 0 ? process.argv[1] : null) ??
    "eliza";

  const result2 = spawnSync(bin, args, { stdio: "inherit" });
  return result2.status === 0;
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerDoctorCommand(program: Command) {
  program
    .command("doctor:dflash")
    .description("Check DFlash llama-server acceleration readiness")
    .option("--json", "Output results as JSON")
    .action(async (opts: { json: boolean }) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { runDflashDoctor } = await import(
          "../../services/local-inference/dflash-doctor"
        );
        const report = await runDflashDoctor();
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
          if (!report.ok) process.exit(1);
          return;
        }
        console.log(`\n${theme.heading("DFlash Health Check")}\n`);
        for (const check of report.checks) {
          const icon =
            check.status === "pass"
              ? theme.success("✓")
              : check.status === "warn"
                ? theme.warn("⚠")
                : theme.error("✗");
          console.log(
            `  ${icon} ${check.label.padEnd(28)} ${theme.muted(check.detail)}`,
          );
          if (check.fix && check.status !== "pass") {
            console.log(`      ${theme.muted("fix:")} ${theme.command(check.fix)}`);
          }
        }
        console.log();
        if (!report.ok) process.exit(1);
      });
    });

  program
    .command("doctor")
    .description("Check environment health and diagnose common issues")
    .option("--no-ports", "Skip port availability checks")
    .option("--fix", "Automatically fix issues where possible")
    .option("--json", "Output results as JSON (CI-friendly)")
    .action(async (opts: { ports: boolean; fix: boolean; json: boolean }) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { runAllChecks } = await import("../doctor/checks");

        const results = await runAllChecks({ checkPorts: opts.ports });

        // ── JSON output ──────────────────────────────────────────────────
        if (opts.json) {
          const summary = {
            pass: results.filter((r) => r.status === "pass").length,
            warn: results.filter((r) => r.status === "warn").length,
            fail: results.filter((r) => r.status === "fail").length,
            skip: results.filter((r) => r.status === "skip").length,
          };
          process.stdout.write(
            `${JSON.stringify({ summary, checks: results }, null, 2)}\n`,
          );
          if (summary.fail > 0) process.exit(1);
          return;
        }

        // ── Human output ─────────────────────────────────────────────────
        console.log(`\n${theme.heading("Eliza Health Check")}\n`);
        printGrouped(results);

        const failures = results.filter((r) => r.status === "fail");
        const warnings = results.filter((r) => r.status === "warn");

        console.log();
        if (failures.length === 0 && warnings.length === 0) {
          console.log(
            `  ${theme.success("Everything looks good.")} Ready to run ${theme.command("eliza start")}.`,
          );
        } else if (failures.length > 0) {
          const plural = failures.length === 1 ? "issue" : "issues";
          console.log(
            `  ${theme.error(`${failures.length} ${plural} found.`)}${opts.fix ? "" : ` Run ${theme.command("eliza doctor --fix")} to auto-remediate.`}`,
          );
        } else {
          console.log(
            `  ${theme.warn(`${warnings.length} warning${warnings.length === 1 ? "" : "s"}. Things should still work.`)}`,
          );
        }

        // ── --fix pass ────────────────────────────────────────────────────
        if (opts.fix) {
          const fixable = results.filter(
            (r) => r.status !== "pass" && r.autoFixable,
          );
          if (fixable.length === 0) {
            console.log(
              `\n  ${theme.muted("No auto-fixable issues. Manual steps shown above.")}`,
            );
          } else {
            for (const r of fixable) {
              attemptFix(r);
            }
          }
        }

        console.log();

        if (failures.length > 0) {
          process.exit(1);
        }
      });
    });
}

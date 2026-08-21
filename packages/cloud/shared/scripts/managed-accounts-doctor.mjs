#!/usr/bin/env bun

/**
 * Operator/CI doctor for the managed Cloud provider accounts tracked by
 * issue #19910. Reports configured/partial/missing/deferred status per
 * account from the current environment — secret reference names only, never
 * values. `--strict` fails closed when any required account is not fully
 * configured; `--json` emits the machine-readable report for evidence
 * capture. Requires bun (imports the TypeScript manifest directly).
 */

import { MANAGED_ACCOUNTS, verifyManagedAccounts } from "../src/lib/config/managed-accounts.ts";

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const asJson = args.includes("--json");
const categoryArg = args.find((arg) => arg.startsWith("--category="));
const categories = categoryArg
  ? new Set(
      categoryArg
        .split("=")[1]
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    )
  : null;

const accounts = categories
  ? MANAGED_ACCOUNTS.filter((spec) => categories.has(spec.category))
  : MANAGED_ACCOUNTS;

if (accounts.length === 0) {
  console.error(
    `managed-accounts-doctor: no accounts match --category=${[...(categories ?? [])].join(",")}`,
  );
  process.exit(2);
}

const { reports, requiredMissing } = verifyManagedAccounts(process.env, accounts);

if (asJson) {
  console.log(
    JSON.stringify({ reports, requiredMissingIds: requiredMissing.map((r) => r.id) }, null, 2),
  );
} else {
  console.log("Managed Cloud provider accounts (issue #19910)");
  for (const report of reports) {
    const requirement =
      report.requirement.kind === "deferred"
        ? `deferred (owner: ${report.requirement.owner})`
        : report.requirement.kind;
    console.log(`- [${report.state}] ${report.name} (${report.category}, ${requirement})`);
    if (report.missingEnvVars.length > 0) {
      console.log(`  missing: ${report.missingEnvVars.join(", ")}`);
    }
    if (report.requirement.kind === "deferred") {
      console.log(`  reason: ${report.requirement.reason}`);
    }
  }
  const configured = reports.filter((r) => r.state === "configured").length;
  console.log(`\n${configured}/${reports.length} accounts configured.`);
}

if (requiredMissing.length > 0) {
  const summary = `${requiredMissing.length} required managed account(s) not configured: ${requiredMissing
    .map((r) => r.id)
    .join(", ")}`;
  if (strict) {
    console.error(`\n${summary}`);
    process.exit(1);
  }
  if (!asJson) {
    console.log(`\n${summary}. Re-run with --strict in CI to fail closed.`);
  }
}

/**
 * Operator CLI for account deletions parked with EXPORT_REQUIRED_BEFORE_ERASURE
 * before the export became optional at expiry. Prints the parked requests as
 * JSON and, only with `--apply`, returns each to expiry activation so the next
 * deletion cron run can schedule it. Dry-run is the default.
 *
 * Usage:
 *   DATABASE_URL=postgres://... bun packages/cloud/scripts/shared/requeue-export-parked-account-deletions.ts [--apply] [--limit=N]
 */

import process from "node:process";

async function main(): Promise<void> {
  let apply = false;
  let limit = 100;
  const unknown: string[] = [];
  for (const arg of process.argv.slice(2)) {
    if (arg === "--apply") apply = true;
    else if (/^--limit=\d+$/.test(arg))
      limit = Number(arg.slice("--limit=".length));
    else unknown.push(arg);
  }
  if (unknown.length > 0 || limit < 1) {
    process.stderr.write(
      `Unknown arguments: ${unknown.join(" ")}\nUsage: [--apply] [--limit=N]\n`,
    );
    process.exit(2);
  }
  const { closeDatabaseConnectionsForTests } = await import(
    "../../shared/src/db/client"
  );
  const { requeueExportParkedAccountDeletions } = await import(
    "../../shared/src/lib/services/account-deletion"
  );
  const report = await requeueExportParkedAccountDeletions({ apply, limit });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  await closeDatabaseConnectionsForTests();
}

await main();

/**
 * Operator CLI for the legacy CONTAINER_DELETE queue reconciliation (#15821).
 * Connects through the package's normal database resolution (point
 * `DATABASE_URL` at staging or production), prints a sanitized JSON inventory
 * of every CONTAINER_DELETE job row, and applies the safe status-guarded
 * transitions only when `--apply` is passed. Dry-run is the default; run it
 * first and attach the report to the issue before applying.
 *
 * Usage:
 *   DATABASE_URL=postgres://... bun scripts/reconcile-container-delete-jobs.ts [--apply]
 */

import process from "node:process";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const unknown = process.argv.slice(2).filter((arg) => arg !== "--apply");
  if (unknown.length > 0) {
    process.stderr.write(`Unknown arguments: ${unknown.join(" ")}\nUsage: [--apply]\n`);
    process.exit(2);
  }
  const { dbWrite, closeDatabaseConnectionsForTests } = await import("../src/db/client");
  const { reconcileContainerDeleteJobs } = await import(
    "../src/lib/services/container-delete-job-reconciler"
  );
  const report = await reconcileContainerDeleteJobs(dbWrite, { apply });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  await closeDatabaseConnectionsForTests();
}

await main();

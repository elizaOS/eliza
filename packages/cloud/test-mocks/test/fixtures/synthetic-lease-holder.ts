/** Holds a real SQLite lease until its OS process is killed by the test. */

import { writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { SqliteSyntheticEnvironmentLeaseStore } from "../../src/synthetic-environment/sqlite-lease-store";

const [databasePath, namespace, acquiredPath, durationText] =
  process.argv.slice(2);
if (!databasePath || !namespace || !acquiredPath || !durationText) {
  throw new Error("missing lease-holder arguments");
}

const store = new SqliteSyntheticEnvironmentLeaseStore(databasePath);
const receipt = await store.acquire({
  namespace,
  owner: { ownerId: "killed-owner", processId: process.pid, host: hostname() },
  leaseDurationMs: Number(durationText),
});
writeFileSync(acquiredPath, JSON.stringify(receipt.authority), { mode: 0o600 });

await new Promise<never>(() => {
  // The parent deliberately uses SIGKILL, so no cleanup handler can release the lease.
});

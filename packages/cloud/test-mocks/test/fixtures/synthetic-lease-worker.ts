/** Drives the real SQLite lease adapter from an independent OS process. */

import { existsSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { SqliteSyntheticEnvironmentLeaseStore } from "../../src/synthetic-environment/sqlite-lease-store";

const [databasePath, namespace, ownerId, readyPath, goPath, durationText] =
  process.argv.slice(2);
if (
  !databasePath ||
  !namespace ||
  !ownerId ||
  !readyPath ||
  !goPath ||
  !durationText
) {
  throw new Error("missing worker arguments");
}

const store = new SqliteSyntheticEnvironmentLeaseStore(databasePath);
writeFileSync(readyPath, `${process.pid}\n`, { mode: 0o600 });
while (!existsSync(goPath)) await Bun.sleep(5);

try {
  const receipt = await store.acquire({
    namespace,
    owner: { ownerId, processId: process.pid, host: hostname() },
    leaseDurationMs: Number(durationText),
  });
  process.stdout.write(
    `${JSON.stringify({ ok: true, operation: receipt.operation, authority: receipt.authority })}\n`,
  );
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      ok: false,
      code:
        typeof error === "object" && error !== null && "code" in error
          ? error.code
          : "UNKNOWN",
    })}\n`,
  );
} finally {
  store.close();
}

/** Races a generation rollover from an independent OS process. */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { SyntheticEnvironmentLeaseAuthority } from "@elizaos/shared/contracts/synthetic-environment-lease";
import { SqliteSyntheticEnvironmentLeaseStore } from "../../src/synthetic-environment/sqlite-lease-store";

const [databasePath, authorityPath, readyPath, goPath] = process.argv.slice(2);
if (!databasePath || !authorityPath || !readyPath || !goPath) {
  throw new Error("missing rollover worker arguments");
}
const authority = JSON.parse(
  readFileSync(authorityPath, "utf8"),
) as SyntheticEnvironmentLeaseAuthority;
const store = new SqliteSyntheticEnvironmentLeaseStore(databasePath);
writeFileSync(readyPath, `${process.pid}\n`, { mode: 0o600 });
while (!existsSync(goPath)) await Bun.sleep(5);

try {
  const receipt = await store.rollover({ authority, leaseDurationMs: 5_000 });
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

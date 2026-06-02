/**
 * CLI: validate every source entry against the schema. Exits non-zero on the
 * first invalid file. Wired as `bun run validate` and run in CI.
 */

import { loadThirdPartyEntries } from "./loader.ts";

try {
  const entries = loadThirdPartyEntries();
  console.log(`[registry] ${entries.length} third-party entries validated`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

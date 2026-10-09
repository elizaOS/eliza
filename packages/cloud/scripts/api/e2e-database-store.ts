/** Owns transient E2E stores without deleting explicitly configured databases. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export function createE2eDatabaseStore(options: {
  root: string;
  directory?: string;
  persistent?: boolean;
}): { directory: string; cleanup(): void } {
  if (options.directory || options.persistent) {
    return {
      directory: resolve(
        options.root,
        options.directory || ".eliza/.pgdata-cloud-api-e2e",
      ),
      cleanup() {},
    };
  }
  const directory = mkdtempSync(join(tmpdir(), "cloud-api-e2e-"));
  return {
    directory,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

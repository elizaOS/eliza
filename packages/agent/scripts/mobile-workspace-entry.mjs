/** Checks the actual Bun package entry before mobile bundling trusts partial workspace output. */
import { realpathSync, statSync } from "node:fs";
import path from "node:path";

export function hasResolvableWorkspaceEntry(specifier, packageDir) {
  let resolved;
  try {
    resolved = Bun.resolveSync(specifier, packageDir);
  } catch (error) {
    // error-policy:J3 an unbuilt export selects the existing source fallback.
    if (error.code === "ERR_MODULE_NOT_FOUND") return false;
    throw error;
  }
  const root = realpathSync(packageDir);
  const entry = realpathSync(resolved);
  return entry.startsWith(`${root}${path.sep}`) && statSync(entry).isFile();
}

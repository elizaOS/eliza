/**
 * Robust "am I the CLI entry point?" check.
 *
 * The two idioms previously copy-pasted across scripts are both unreliable:
 *   - `path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)`
 *     is false whenever the invocation path crosses a symlink (macOS
 *     /var -> /private/var, a symlinked checkout on a builder), because Node
 *     realpath-resolves the main module for import.meta.url but leaves
 *     process.argv[1] untouched. The script then exits 0 having done nothing.
 *   - `import.meta.main` is undefined (falsy) on Node < 24.2, which turns the
 *     script into a silent no-op on older Node installs.
 *
 * This helper prefers import.meta.main where the runtime provides it (Bun,
 * Node >= 24.2) and otherwise compares realpaths, so a symlinked invocation
 * still runs and an import never does.
 */
import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

export function isMainModule(importMeta) {
  if (importMeta.main !== undefined) return importMeta.main;
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fileURLToPath(importMeta.url);
  } catch {
    return false;
  }
}

/** Workspace discovery must not borrow source from sibling checkouts. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function findWorkspaceBoundary(start: string): string | undefined {
  let directory = path.resolve(start);
  for (;;) {
    try {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(directory, "package.json"), "utf8"),
      );
      if (
        Array.isArray(manifest.workspaces) ||
        Array.isArray(manifest.workspaces?.packages)
      )
        return directory;
    } catch (error) {
      // Missing ancestors are normal; malformed/unreadable metadata must not
      // cause a wider filesystem search to select another implementation.
      if (
        !(
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          ["ENOENT", "ENOTDIR"].includes(String(error.code))
        )
      )
        throw error;
    }
    if (fs.existsSync(path.join(directory, ".git"))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

export function resolveWorkspaceRootsForDiscovery(
  options: {
    readonly moduleDir: string;
    readonly cwd: string;
    readonly envRoot?: string;
  } = {
    moduleDir: path.dirname(fileURLToPath(import.meta.url)),
    cwd: process.cwd(),
    envRoot: process.env.ELIZA_WORKSPACE_ROOT,
  },
): string[] {
  if (options.envRoot?.trim()) return [path.resolve(options.envRoot.trim())];
  return [
    findWorkspaceBoundary(options.moduleDir) ??
      findWorkspaceBoundary(options.cwd) ??
      path.resolve(options.cwd),
  ];
}

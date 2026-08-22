import fs from "node:fs";
import path from "node:path";

/** Remove group/other write bits from a packaged Linux application tree. */
export function hardenLinuxArtifactPermissions(root, fileSystem = fs) {
  if (!fileSystem.existsSync(root)) {
    throw new Error(
      `[linux-artifact-permissions] artifact is missing: ${root}`,
    );
  }

  const stack = [root];
  let changed = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    const stat = fileSystem.lstatSync(current);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      for (const entry of fileSystem.readdirSync(current)) {
        stack.push(path.join(current, entry));
      }
    }
    const mode = stat.mode & 0o777;
    const hardened = mode & ~0o022;
    if (hardened !== mode) {
      fileSystem.chmodSync(current, hardened);
      changed++;
    }
  }
  return changed;
}

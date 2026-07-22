import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

function expandSegments(repoRoot, segments) {
  let dirs = [repoRoot];
  for (const segment of segments) {
    const next = [];
    for (const dir of dirs) {
      if (segment === "*") {
        let entries = [];
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {}
        for (const entry of entries) {
          if (entry.isDirectory()) next.push(path.join(dir, entry.name));
        }
      } else {
        const candidate = path.join(dir, segment);
        if (existsSync(candidate)) next.push(candidate);
      }
    }
    dirs = next;
  }
  return dirs;
}

/** Resolve the package directories declared by package.json workspace globs. */
export function resolveWorkspacePackageDirs(repoRoot, workspaceGlobs) {
  const selected = new Set();
  for (const rawGlob of workspaceGlobs) {
    const exclude = rawGlob.startsWith("!");
    const glob = exclude ? rawGlob.slice(1) : rawGlob;
    const matches = expandSegments(repoRoot, glob.split("/").filter(Boolean));
    for (const dir of matches) {
      const normalized = path.resolve(dir);
      if (exclude) selected.delete(normalized);
      else if (existsSync(path.join(normalized, "package.json"))) {
        selected.add(normalized);
      }
    }
  }
  return [...selected].sort();
}

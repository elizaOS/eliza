/**
 * Shared discovery and mutation policy for Git administration paths.
 *
 * Reads remain available for status/diff/context. Model-authored writes must
 * never reach repositories that existed at the ACP/session boundary: shell
 * enforces this with read-only mounts and FILE write/edit use the same paths.
 */
import {
  type Dirent,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import * as path from "node:path";

const MAX_SCAN_DIRECTORIES = 100_000;
const MAX_SCAN_ENTRIES = 1_000_000;
const MAX_SCAN_DEPTH = 64;

export interface GitRepositoryMetadata {
  marker: string;
  worktree: string;
  gitDirectory: string;
  commonDirectory: string;
  objectDirectory: string;
}

export interface GitAdminMetadata {
  adminPaths: string[];
  repositories: GitRepositoryMetadata[];
}

function isWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function resolveGitDirectoryFromMarker(marker: string): string {
  const markerStat = lstatSync(marker);
  if (markerStat.isSymbolicLink()) {
    throw new Error(
      `local-safe refuses a symbolic-link Git metadata marker: ${marker}`,
    );
  }
  if (markerStat.isDirectory()) return realpathSync(marker);
  if (!markerStat.isFile()) {
    throw new Error(`local-safe found an unsupported Git marker: ${marker}`);
  }

  const match = /^gitdir:\s*(.+?)\s*$/iu.exec(readFileSync(marker, "utf8"));
  if (!match?.[1]) {
    throw new Error(`local-safe found a malformed Git marker: ${marker}`);
  }
  const target = path.resolve(path.dirname(marker), match[1]);
  const resolved = realpathSync(target);
  if (!statSync(resolved).isDirectory()) {
    throw new Error(`local-safe Git metadata target is unavailable: ${target}`);
  }
  return resolved;
}

function resolveGitCommonDirectory(gitDirectory: string): string {
  const marker = path.join(gitDirectory, "commondir");
  if (!existsSync(marker)) return gitDirectory;
  const value = readFileSync(marker, "utf8").trim();
  if (!value) throw new Error(`local-safe found an empty commondir: ${marker}`);
  const common = realpathSync(path.resolve(gitDirectory, value));
  if (!statSync(common).isDirectory()) {
    throw new Error(
      `local-safe Git common directory is unavailable: ${common}`,
    );
  }
  return common;
}

export function discoverGitAdminMetadata(roots: string[]): GitAdminMetadata {
  const adminPaths = new Set<string>();
  const repositories: GitRepositoryMetadata[] = [];
  let scannedDirectories = 0;
  let scannedEntries = 0;
  const pending = roots.map((root) => ({
    depth: 0,
    directory: realpathSync(root),
  }));

  while (pending.length > 0) {
    const item = pending.pop();
    if (!item) continue;
    scannedDirectories += 1;
    if (scannedDirectories > MAX_SCAN_DIRECTORIES) {
      throw new Error(
        `local-safe Git metadata scan exceeded ${MAX_SCAN_DIRECTORIES} directories; refusing an incompletely protected workspace`,
      );
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(item.directory, { withFileTypes: true });
    } catch (error) {
      throw new Error(
        `local-safe cannot verify Git metadata below: ${item.directory}`,
        { cause: error },
      );
    }
    scannedEntries += entries.length;
    if (scannedEntries > MAX_SCAN_ENTRIES) {
      throw new Error(
        `local-safe Git metadata scan exceeded ${MAX_SCAN_ENTRIES} entries; refusing an incompletely protected workspace`,
      );
    }

    for (const entry of entries) {
      const entryPath = path.join(item.directory, entry.name);
      if (entry.name === ".git") {
        const gitDirectory = resolveGitDirectoryFromMarker(entryPath);
        const commonDirectory = resolveGitCommonDirectory(gitDirectory);
        const objectDirectory = realpathSync(
          path.join(commonDirectory, "objects"),
        );
        if (!statSync(objectDirectory).isDirectory()) {
          throw new Error(
            `local-safe Git object database is unavailable: ${objectDirectory}`,
          );
        }
        if (objectDirectory.includes(path.delimiter)) {
          throw new Error(
            `local-safe cannot encode a Git object path containing ${path.delimiter}`,
          );
        }
        adminPaths.add(entryPath);
        adminPaths.add(gitDirectory);
        adminPaths.add(commonDirectory);
        repositories.push({
          marker: entryPath,
          worktree: item.directory,
          gitDirectory,
          commonDirectory,
          objectDirectory,
        });
        continue;
      }
      if (!entry.isDirectory()) continue;
      const depth = item.depth + 1;
      if (depth > MAX_SCAN_DEPTH) {
        throw new Error(
          `local-safe Git metadata scan exceeded maximum depth ${MAX_SCAN_DEPTH} at ${entryPath}; refusing an incompletely protected workspace`,
        );
      }
      pending.push({ depth, directory: entryPath });
    }
  }

  return {
    adminPaths: Array.from(adminPaths).sort(),
    repositories: repositories.sort((a, b) =>
      a.worktree.localeCompare(b.worktree),
    ),
  };
}

function canonicalizePotentialPath(candidate: string): string {
  let current = path.resolve(candidate);
  const suffix: string[] = [];
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(candidate);
    suffix.unshift(path.basename(current));
    current = parent;
  }
  try {
    return path.join(realpathSync(current), ...suffix);
  } catch {
    return path.resolve(candidate);
  }
}

export function isGitAdminMutationPath(
  candidate: string,
  metadata: GitAdminMetadata,
): boolean {
  const lexicalParts = path.resolve(candidate).split(path.sep);
  if (
    lexicalParts.some((part) =>
      process.platform === "win32"
        ? part.toLowerCase() === ".git"
        : part === ".git",
    )
  ) {
    return true;
  }
  const canonical = canonicalizePotentialPath(candidate);
  return metadata.adminPaths.some((adminPath) =>
    isWithin(canonical, adminPath),
  );
}

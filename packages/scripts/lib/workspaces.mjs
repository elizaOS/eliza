/**
 * Shared, zero-dependency discovery seam for the repo's Bun/Node workspaces and
 * git submodules. This is the single source of truth the script layer reads to
 * answer "which directories are workspaces?", "what package lives where?", and
 * "which submodules does .gitmodules declare?" — replacing the ad-hoc glob
 * walkers each script used to carry (the migration of those callers is #12333).
 *
 * The glob expander implements the npm/Bun `workspaces` semantics used by the
 * root package.json: `*` matches a single path segment, `**` matches any number
 * of segments, and a leading `!` pattern subtracts from earlier matches
 * (exclude-wins, last-match-wins ordering). It is deliberately dependency-free —
 * only node builtins plus reading package.json / .gitmodules — so any script or
 * test can import it without pulling in the build graph.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

function normalizePath(value) {
  return value.split(path.sep).join("/");
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function readJson(filePath) {
  const source = readFileSync(filePath, "utf8");
  try {
    return JSON.parse(source);
  } catch (error) {
    // error-policy:J2 identify the intended manifest that made discovery invalid
    throw new Error(`Invalid JSON in ${filePath}`, { cause: error });
  }
}

function resolveRepoRoot(opts) {
  return opts?.repoRoot ? path.resolve(opts.repoRoot) : DEFAULT_REPO_ROOT;
}

function isMissingPathError(error) {
  return error?.code === "ENOENT" || error?.code === "ENOTDIR";
}

// Compile one workspace glob segment-pattern to a RegExp over the "/"-joined
// relative path. `**` spans segments (including zero), `*` stays within one.
function workspaceGlobToRegExp(glob) {
  let pattern = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    // A `/**` suffix (or `/**/`) must match zero-or-more trailing segments,
    // including none — so `packages/**` matches `packages` itself. Consume the
    // preceding `/` with the `**` so the separator is optional too.
    if (char === "/" && glob[i + 1] === "*" && glob[i + 2] === "*") {
      if (glob[i + 3] === "/") {
        pattern += "(?:/.*)?/";
        i += 3;
      } else {
        pattern += "(?:/.*)?";
        i += 2;
      }
    } else if (char === "*") {
      if (glob[i + 1] === "*") {
        pattern += ".*";
        i += 1;
      } else {
        pattern += "[^/]*";
      }
    } else if (/[.+^${}()|[\]\\]/.test(char)) {
      pattern += `\\${char}`;
    } else {
      pattern += char;
    }
  }
  return new RegExp(`^${pattern}$`);
}

// Hidden and heavy build/vendor dir names that are never workspace members and
// never worth descending into. Bun/npm workspace resolution likewise ignores
// dotfile dirs, and these build outputs (e.g. a Next.js `.next/package.json`
// marker) are not real packages — so a `*` segment must skip them just as a
// `**` walk does, or a stray `.next` gets matched as a workspace.
const WALK_SKIP_DIRS = new Set([
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "storybook-static",
]);

// A directory child is traversable/matchable as a workspace only if it is not
// hidden and not a build/vendor dir. Applied uniformly to `*` and `**` so both
// segment kinds agree on membership.
function isTraversableChild(name) {
  return !name.startsWith(".") && !WALK_SKIP_DIRS.has(name);
}

// Walk the tree expanding one positive glob into concrete directories. A `*`
// segment enumerates children; a `**` segment matches this directory and every
// descendant directory; a literal segment descends by name.
function expandPositiveGlob(repoRoot, pattern) {
  let dirs = [repoRoot];
  const parts = pattern.split("/");
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    const next = [];
    for (const dir of dirs) {
      if (part === "**") {
        // Match zero-or-more segments: keep this dir and add all descendants.
        for (const descendant of walkDirs(dir)) next.push(descendant);
        continue;
      }
      if (part === "*") {
        for (const entry of readDirEntries(dir)) {
          if (entry.isDirectory() && isTraversableChild(entry.name)) {
            next.push(path.join(dir, entry.name));
          }
        }
        continue;
      }
      const candidate = path.join(dir, part);
      try {
        if (statSync(candidate).isDirectory()) next.push(candidate);
      } catch (error) {
        // error-policy:J3 an unmatched literal branch is valid glob input
        if (!isMissingPathError(error)) throw error;
      }
    }
    dirs = next;
  }
  return dirs;
}

function readDirEntries(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    // error-policy:J3 an absent optional glob base has no members
    if (isMissingPathError(error)) return [];
    throw error;
  }
}

// Depth-first directory list rooted at `start` (inclusive), skipping hidden and
// heavy build/vendor dirs so `**` expansion stays bounded and deterministic.
function walkDirs(start) {
  const out = [start];
  for (const entry of readDirEntries(start)) {
    if (!entry.isDirectory()) continue;
    if (!isTraversableChild(entry.name)) continue;
    out.push(...walkDirs(path.join(start, entry.name)));
  }
  return out;
}

/**
 * Expand a list of workspace glob patterns (npm/Bun `workspaces` semantics)
 * into a deduped, sorted list of relative directory paths. Positive patterns
 * add matches; a leading `!` pattern removes earlier matches (exclude-wins).
 */
export function expandWorkspaceGlobs(patterns, opts) {
  const repoRoot = resolveRepoRoot(opts);
  const matchers = patterns.map((glob) => {
    const negated = glob.startsWith("!");
    return {
      negated,
      regExp: workspaceGlobToRegExp(negated ? glob.slice(1) : glob),
    };
  });

  function isMember(relativeDir) {
    let member = false;
    for (const { negated, regExp } of matchers) {
      if (regExp.test(relativeDir)) member = !negated;
    }
    return member;
  }

  const dirs = new Set();
  for (const glob of patterns) {
    if (glob.startsWith("!")) continue;
    for (const dir of expandPositiveGlob(repoRoot, glob)) {
      const relativeDir = normalizePath(path.relative(repoRoot, dir));
      if (!relativeDir || !isMember(relativeDir)) continue;
      dirs.add(relativeDir);
    }
  }
  return [...dirs].sort(compareText);
}

/**
 * List every workspace directory declared in the root package.json — expanded
 * from the `workspaces` globs, negations applied, keeping only directories that
 * actually contain a package.json.
 */
export function listWorkspaceDirs(opts) {
  const repoRoot = resolveRepoRoot(opts);
  const patterns =
    opts?.patterns ??
    (() => {
      const rootPackage = readJson(path.join(repoRoot, "package.json"));
      if (!Array.isArray(rootPackage.workspaces)) {
        throw new Error(
          `${path.join(repoRoot, "package.json")} must declare a workspaces array`,
        );
      }
      return rootPackage.workspaces;
    })();
  if (
    !Array.isArray(patterns) ||
    patterns.some((pattern) => typeof pattern !== "string")
  ) {
    throw new TypeError("Workspace patterns must be an array of strings");
  }
  return expandWorkspaceGlobs(patterns, { repoRoot }).filter((relativeDir) => {
    const manifestPath = path.join(repoRoot, relativeDir, "package.json");
    try {
      const manifest = statSync(manifestPath);
      if (!manifest.isFile()) {
        throw new Error(`Workspace manifest is not a file: ${manifestPath}`);
      }
      return true;
    } catch (error) {
      // error-policy:J3 a matched directory without a manifest is not a package
      if (isMissingPathError(error)) return false;
      throw error;
    }
  });
}

/**
 * List every workspace as `{ name, dir, packageJson }`, where `name` is the
 * package.json `name` field (may be undefined for a private, unnamed package)
 * and `dir` is the workspace-relative directory.
 */
export function listPackages(opts) {
  const repoRoot = resolveRepoRoot(opts);
  const packages = listWorkspaceDirs({
    repoRoot,
    patterns: opts?.patterns,
  }).map((dir) => {
    const packageJson = readJson(path.join(repoRoot, dir, "package.json"));
    return { name: packageJson.name, dir, packageJson };
  });
  const names = new Map();
  for (const workspacePackage of packages) {
    if (
      typeof workspacePackage.name !== "string" ||
      workspacePackage.name.length === 0
    )
      continue;
    const previousDir = names.get(workspacePackage.name);
    if (previousDir) {
      throw new Error(
        `Duplicate workspace package name ${workspacePackage.name}: ${previousDir} and ${workspacePackage.dir}`,
      );
    }
    names.set(workspacePackage.name, workspacePackage.dir);
  }
  return packages;
}

/**
 * Resolve workspace directories and name maps from an explicit pattern set.
 * Absolute paths preserve the historical app-core script contract while all
 * discovery and manifest parsing stays centralized in this module.
 */
export function collectWorkspaceMaps(repoRoot, patterns) {
  const root = path.resolve(repoRoot);
  const workspacePackages = listPackages({ repoRoot: root, patterns });
  const workspaceDirs = workspacePackages.map(({ dir }) =>
    path.join(root, dir),
  );
  const rootManifestPath = path.join(root, "package.json");
  const rootManifest = readJson(rootManifestPath);
  workspaceDirs.push(root);
  workspaceDirs.sort(compareText);

  const nameToDir = new Map();
  const nameToVersion = new Map();
  for (const { name, dir, packageJson } of [
    ...workspacePackages,
    { name: rootManifest.name, dir: "", packageJson: rootManifest },
  ]) {
    if (typeof name !== "string" || name.length === 0) continue;
    const absoluteDir = path.join(root, dir);
    const previousDir = nameToDir.get(name);
    if (previousDir && previousDir !== absoluteDir) {
      throw new Error(
        `Duplicate workspace package name ${name}: ${previousDir} and ${absoluteDir}`,
      );
    }
    nameToDir.set(name, absoluteDir);
    if (typeof packageJson.version === "string")
      nameToVersion.set(name, packageJson.version);
  }

  return { workspaceDirs, nameToDir, nameToVersion };
}

// Minimal INI parser for .gitmodules: sections keyed by `[submodule "name"]`,
// with `path` / `url` / `branch` values. Indentation and comment lines (`#`,
// `;`) are ignored; unknown keys are dropped.
function parseGitmodules(text) {
  const sections = [];
  let current = null;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const sectionMatch = line.match(/^\[submodule\s+"(.+)"\]$/);
    if (sectionMatch) {
      current = { section: sectionMatch[1] };
      sections.push(current);
      continue;
    }
    if (!current) continue;
    const kvMatch = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(.*)$/);
    if (!kvMatch) continue;
    current[kvMatch[1]] = kvMatch[2].trim();
  }
  return sections;
}

/**
 * Parse the root `.gitmodules` into `{ path, url, branch, initialized }` per
 * submodule. `initialized` is true when the submodule's working tree is present
 * on disk (a `.git` gitfile or non-empty checkout), false when only the gitlink
 * placeholder exists. Returns an empty list when `.gitmodules` is absent.
 */
export function listSubmodules(opts) {
  const repoRoot = resolveRepoRoot(opts);
  const gitmodulesPath = path.join(repoRoot, ".gitmodules");
  let source;
  try {
    source = readFileSync(gitmodulesPath, "utf8");
  } catch (error) {
    // error-policy:J3 repositories are not required to declare submodules
    if (isMissingPathError(error)) return [];
    throw error;
  }
  const sections = parseGitmodules(source);
  return sections
    .filter((section) => typeof section.path === "string")
    .map((section) => ({
      path: section.path,
      url: section.url,
      branch: section.branch,
      initialized: isSubmoduleInitialized(path.join(repoRoot, section.path)),
    }));
}

function isSubmoduleInitialized(absPath) {
  if (existsSync(path.join(absPath, ".git"))) return true;
  const entries = readDirEntries(absPath);
  return entries.length > 0;
}

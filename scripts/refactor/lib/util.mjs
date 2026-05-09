// Shared helpers for the src-to-dist refactor scripts.
// All scripts default to dry-run; pass --apply to actually mutate.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

// ── Flag parsing ────────────────────────────────────────────────────────────

export function parseFlags(argv = process.argv.slice(2)) {
  const flags = {
    apply: argv.includes("--apply"),
    quiet: argv.includes("--quiet"),
    verbose: argv.includes("--verbose"),
    color: !argv.includes("--no-color") && process.stdout.isTTY,
    commitPerPhase: argv.includes("--commit-per-phase"),
    force: argv.includes("--force"),
  };
  return flags;
}

// ── Logging ─────────────────────────────────────────────────────────────────

const COLORS = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  bold: "\x1b[1m",
};

export function makeLogger(flags) {
  const c = (color, s) => (flags.color ? `${COLORS[color]}${s}${COLORS.reset}` : s);
  const prefix = flags.apply ? c("green", "[APPLY]") : c("yellow", "[DRY] ");

  return {
    c,
    info: (...args) => !flags.quiet && console.log(prefix, ...args),
    verbose: (...args) => flags.verbose && console.log(c("gray", "       "), ...args),
    warn: (...args) => console.warn(c("yellow", "[WARN] "), ...args),
    error: (...args) => console.error(c("red", "[ERROR]"), ...args),
    note: (...args) => !flags.quiet && console.log(c("cyan", "[NOTE] "), ...args),
    manual: (...args) =>
      console.log(c("magenta", "[MANUAL]"), ...args),
    section: (title) =>
      !flags.quiet && console.log(`\n${c("bold", `── ${title} `.padEnd(72, "─"))}`),
    summary: (label, count, total) => {
      const fmt = total != null ? `${count}/${total}` : `${count}`;
      console.log(c("bold", `${label}: ${fmt}`));
    },
  };
}

// ── File operations (dry-run aware) ─────────────────────────────────────────

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function writeJson(path, data, flags, log) {
  const out = `${JSON.stringify(data, null, 2)}\n`;
  return writeFileIfChanged(path, out, flags, log);
}

export function writeFileIfChanged(path, content, flags, log) {
  const rel = relative(REPO_ROOT, path);
  let existing = null;
  try {
    existing = readFileSync(path, "utf8");
  } catch {
    // file doesn't exist yet
  }
  if (existing === content) {
    log.verbose(`unchanged: ${rel}`);
    return false;
  }
  log.info(`write: ${rel}${existing == null ? " (new file)" : ""}`);
  if (flags.verbose && existing != null) {
    printDiff(existing, content, log);
  }
  if (flags.apply) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return true;
}

export function moveFile(from, to, flags, log, { useGit = true } = {}) {
  const fromRel = relative(REPO_ROOT, from);
  const toRel = relative(REPO_ROOT, to);
  if (!existsSync(from)) {
    log.warn(`skip move (source missing): ${fromRel}`);
    return false;
  }
  if (existsSync(to)) {
    log.warn(`skip move (target exists): ${toRel}`);
    return false;
  }
  log.info(`move: ${fromRel} → ${toRel}`);
  if (flags.apply) {
    mkdirSync(dirname(to), { recursive: true });
    if (useGit) {
      try {
        execFileSync("git", ["mv", from, to], {
          cwd: REPO_ROOT,
          stdio: "pipe",
        });
        return true;
      } catch (err) {
        // Fall back to plain rename if git mv fails (e.g. file untracked)
        log.verbose(`git mv failed (${err.message}); using fs.rename`);
      }
    }
    renameSync(from, to);
  }
  return true;
}

export function removeFile(path, flags, log) {
  const rel = relative(REPO_ROOT, path);
  if (!existsSync(path)) {
    log.verbose(`skip remove (not present): ${rel}`);
    return false;
  }
  log.info(`remove: ${rel}`);
  if (flags.apply) {
    rmSync(path, { force: true });
  }
  return true;
}

export function ensureDir(path, flags) {
  if (flags.apply) mkdirSync(path, { recursive: true });
}

function printDiff(before, after, log) {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const max = Math.max(beforeLines.length, afterLines.length);
  for (let i = 0; i < max; i++) {
    if (beforeLines[i] !== afterLines[i]) {
      if (beforeLines[i] != null) log.verbose(`-  ${beforeLines[i]}`);
      if (afterLines[i] != null) log.verbose(`+  ${afterLines[i]}`);
    }
  }
}

// ── Workspace package walking ───────────────────────────────────────────────

const WORKSPACE_GLOBS = [
  "packages",
  "packages/native-plugins",
  "packages/app-core/platforms",
  "packages/app-core/deploy",
  "packages/examples",
  "plugins",
  "cloud/packages",
];

export function walkWorkspacePackages() {
  const packages = [];
  const seen = new Set();
  for (const glob of WORKSPACE_GLOBS) {
    const root = join(REPO_ROOT, glob);
    if (!existsSync(root)) continue;
    walkPackages(root, 4, packages);
  }
  // Dedupe by absolute dir (some packages are reachable from multiple globs).
  return packages.filter((p) => {
    if (seen.has(p.dir)) return false;
    seen.add(p.dir);
    return true;
  });
}

function walkPackages(dir, depth, out) {
  if (depth < 0) return;
  if (!existsSync(dir)) return;
  const stat = statSync(dir);
  if (!stat.isDirectory()) return;
  const pkgPath = join(dir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = readJson(pkgPath);
      if (pkg.name) {
        out.push({ name: pkg.name, dir, packageJsonPath: pkgPath, pkg });
      }
    } catch {
      // ignore parse errors
    }
    // Continue descending — packages can be nested inside other packages
    // (e.g. packages/examples/moltbook contains bags-claimer).
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "node_modules") continue;
    if (entry.name === "dist") continue;
    if (entry.name.startsWith(".")) continue;
    walkPackages(join(dir, entry.name), depth - 1, out);
  }
}

// ── Source-file walking (for codemod) ───────────────────────────────────────

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs"]);
const SKIP_DIRS = new Set(["node_modules", "dist", ".turbo", ".next", "build", ".vite"]);

export function walkSourceFiles(root, predicate) {
  const out = [];
  walkSrc(root, predicate, out);
  return out;
}

function walkSrc(dir, predicate, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith(".")) continue;
      walkSrc(full, predicate, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const dot = entry.name.lastIndexOf(".");
    if (dot < 0) continue;
    const ext = entry.name.slice(dot);
    if (!SOURCE_EXTENSIONS.has(ext)) continue;
    if (predicate && !predicate(full)) continue;
    out.push(full);
  }
}

// ── Pre-flight ──────────────────────────────────────────────────────────────

export function preflight(scriptName, flags, log) {
  log.section(`${scriptName}${flags.apply ? " (APPLY)" : " (DRY-RUN)"}`);
  if (!flags.apply) {
    log.note("Pass --apply to actually mutate the worktree.");
  }
  const dirty = isWorktreeDirty();
  if (dirty && flags.apply && !flags.force) {
    log.error(
      "Worktree has uncommitted changes. Commit or stash first, or pass --force.",
    );
    process.exit(1);
  }
}

export function isWorktreeDirty() {
  try {
    const out = execFileSync("git", ["status", "--porcelain"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

export function gitCommit(message, flags, log) {
  if (!flags.apply) {
    log.note(`would commit: ${message.split("\n")[0]}`);
    return;
  }
  try {
    execFileSync("git", ["add", "-A"], { cwd: REPO_ROOT, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", message], {
      cwd: REPO_ROOT,
      stdio: "pipe",
    });
    log.info(`committed: ${message.split("\n")[0]}`);
  } catch (err) {
    log.warn(`commit failed: ${err.message}`);
  }
}

// ── Codemod helpers ─────────────────────────────────────────────────────────

/**
 * Match `from "..."` and `from '...'` and dynamic `import("...")` patterns.
 * Returns array of { match: full string, quote, specifier, start, end }.
 */
export function findImportSpecifiers(source) {
  const results = [];
  // Static: import ... from "spec" / export ... from "spec"
  const staticRe = /(?:^|[\s;{},])(?:import|export)(?:\s+(?:[\w*{},\s]+))?\s+from\s+(['"])((?:(?!\1).)*)\1/g;
  // Side-effect: import "spec"
  const sideRe = /(?:^|[\s;])import\s+(['"])((?:(?!\1).)*)\1/g;
  // Dynamic: import("spec")
  const dynRe = /\bimport\s*\(\s*(['"])((?:(?!\1).)*)\1\s*\)/g;
  // require: require("spec")
  const reqRe = /\brequire\s*\(\s*(['"])((?:(?!\1).)*)\1\s*\)/g;

  for (const re of [staticRe, sideRe, dynRe, reqRe]) {
    let m;
    while ((m = re.exec(source)) !== null) {
      results.push({
        match: m[0],
        quote: m[1],
        specifier: m[2],
        // start of specifier inside the match
        specStart: m.index + m[0].lastIndexOf(m[2]),
        specEnd: m.index + m[0].lastIndexOf(m[2]) + m[2].length,
      });
    }
  }
  return results;
}

/**
 * Apply specifier rewrites to a source string.
 * `mapper(specifier)` returns the new specifier or null/undefined to leave it alone.
 * Returns { source, changes } where changes is the count of rewrites.
 */
export function rewriteImports(source, mapper) {
  const specs = findImportSpecifiers(source).sort((a, b) => b.specStart - a.specStart);
  let out = source;
  let changes = 0;
  for (const spec of specs) {
    const next = mapper(spec.specifier);
    if (next == null || next === spec.specifier) continue;
    out = out.slice(0, spec.specStart) + next + out.slice(spec.specEnd);
    changes++;
  }
  return { source: out, changes };
}

// ── Stats ───────────────────────────────────────────────────────────────────

export class Stats {
  constructor() {
    this.counters = new Map();
  }
  incr(key, by = 1) {
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }
  get(key) {
    return this.counters.get(key) ?? 0;
  }
  print(log) {
    log.section("Summary");
    for (const [key, val] of this.counters) {
      log.summary(key, val);
    }
  }
}

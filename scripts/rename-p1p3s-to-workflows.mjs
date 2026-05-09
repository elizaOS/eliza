#!/usr/bin/env node
/**
 * Rename `p1p3s` → `workflows` (and case variants) across the entire repo,
 * including the p1p3s submodule. Renames file/dir paths AND in-file content.
 *
 * Replacement rules (longest-first to avoid shadowing):
 *   P1P3S    → WORKFLOWS
 *   P1p3s    → Workflows
 *   p1p3s    → workflows
 *
 * Usage:
 *   node scripts/rename-p1p3s-to-workflows.mjs           # dry-run (default)
 *   node scripts/rename-p1p3s-to-workflows.mjs --apply   # actually do it
 *   node scripts/rename-p1p3s-to-workflows.mjs --apply --no-content   # rename paths only
 *   node scripts/rename-p1p3s-to-workflows.mjs --apply --no-paths     # edit content only
 *
 * Excludes:
 *   - .git/, node_modules/, dist/, .turbo/, build/, coverage/
 *   - tmp/, .claude/worktrees/, .changeset/
 *   - lockfiles (bun.lock, pnpm-lock.yaml, package-lock.json, yarn.lock)
 *   - Binary files (detected by checking for null bytes in first 8KB)
 *   - Files larger than 5MB (skipped, reported)
 *
 * The submodule at packages/p1p3s/ IS processed (its dirname will be
 * renamed to packages/workflows/ at the very end if --apply is set).
 *
 * Reports counts of: paths renamed, files edited, content occurrences
 * replaced, files skipped, errors.
 */
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(__filename);
const REPO_ROOT = resolve(SCRIPT_DIR, '..');

// CLI args
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const RENAME_PATHS = !args.includes('--no-paths');
const EDIT_CONTENT = !args.includes('--no-content');
const VERBOSE = args.includes('--verbose');

// Replacement rules — longest specific first.
const REPLACEMENTS = [
  ['P1P3S', 'WORKFLOWS'],
  ['P1p3s', 'Workflows'],
  ['p1p3s', 'workflows'],
];

const EXCLUDE_DIR_NAMES = new Set([
  '.git', 'node_modules', 'dist', '.turbo', 'build', 'coverage',
  'tmp', '.next', '.cache', '.vite', '.changeset',
]);
const EXCLUDE_PATH_FRAGMENTS = [
  '.claude/worktrees',
];
const EXCLUDE_FILENAMES = new Set([
  'bun.lock', 'bun.lockb', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock',
]);
const MAX_BYTES = 5 * 1024 * 1024;

function shouldExcludeDir(absPath) {
  const base = absPath.split(sep).pop();
  if (EXCLUDE_DIR_NAMES.has(base)) return true;
  const rel = relative(REPO_ROOT, absPath);
  if (EXCLUDE_PATH_FRAGMENTS.some((f) => rel.includes(f))) return true;
  return false;
}

function shouldExcludeFile(absPath) {
  const base = absPath.split(sep).pop();
  if (EXCLUDE_FILENAMES.has(base)) return true;
  if (base.endsWith('.lock')) return true;
  // Don't rename or edit this script itself.
  if (absPath === __filename) return true;
  return false;
}

function isBinary(buffer) {
  // Heuristic: null byte in first 8KB → treat as binary.
  const slice = buffer.subarray(0, Math.min(buffer.length, 8192));
  for (let i = 0; i < slice.length; i++) {
    if (slice[i] === 0) return true;
  }
  return false;
}

function applyReplacements(s) {
  let out = s;
  let total = 0;
  for (const [from, to] of REPLACEMENTS) {
    if (!out.includes(from)) continue;
    const parts = out.split(from);
    total += parts.length - 1;
    out = parts.join(to);
  }
  return { text: out, count: total };
}

// Walk depth-first, collecting files first, then directories (so we can
// rename children before parents).
function walk(start) {
  /** @type {{type:'file'|'dir', path:string}[]} */
  const out = [];
  const stack = [start];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = join(cur, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (shouldExcludeDir(abs)) continue;
        stack.push(abs);
        out.push({ type: 'dir', path: abs });
      } else if (entry.isFile()) {
        if (shouldExcludeFile(abs)) continue;
        out.push({ type: 'file', path: abs });
      }
    }
  }
  // Sort by depth descending so children rename before parents.
  out.sort((a, b) => b.path.split(sep).length - a.path.split(sep).length);
  return out;
}

const stats = {
  pathsRenamed: 0,
  pathsRenamedDryRun: 0,
  filesEdited: 0,
  filesEditedDryRun: 0,
  contentReplacements: 0,
  filesSkippedBinary: 0,
  filesSkippedTooLarge: 0,
  errors: [],
};

const samplePathsRenamed = [];
const sampleFilesEdited = [];

console.log(`\n${APPLY ? '🔧 APPLY' : '🔍 DRY-RUN'} mode`);
console.log(`  paths:   ${RENAME_PATHS ? 'YES' : 'no'}`);
console.log(`  content: ${EDIT_CONTENT ? 'YES' : 'no'}`);
console.log(`  root:    ${REPO_ROOT}\n`);

const all = walk(REPO_ROOT);
console.log(`Walked ${all.length} entries.`);

// Phase 1: edit content of files (do this BEFORE renaming so we don't lose track of paths).
if (EDIT_CONTENT) {
  console.log('\n— Phase 1: edit content —');
  for (const { type, path } of all) {
    if (type !== 'file') continue;
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (st.size > MAX_BYTES) {
      stats.filesSkippedTooLarge++;
      continue;
    }
    let buf;
    try {
      buf = readFileSync(path);
    } catch (e) {
      stats.errors.push({ path, error: String(e) });
      continue;
    }
    if (isBinary(buf)) {
      stats.filesSkippedBinary++;
      continue;
    }
    const text = buf.toString('utf8');
    const { text: updated, count } = applyReplacements(text);
    if (count === 0) continue;

    stats.contentReplacements += count;
    if (APPLY) {
      try {
        writeFileSync(path, updated);
        stats.filesEdited++;
      } catch (e) {
        stats.errors.push({ path, error: String(e) });
        continue;
      }
    } else {
      stats.filesEditedDryRun++;
    }
    if (sampleFilesEdited.length < 25) {
      sampleFilesEdited.push({ path: relative(REPO_ROOT, path), count });
    }
    if (VERBOSE) console.log(`  edit ${count}× ${relative(REPO_ROOT, path)}`);
  }
}

// Phase 2: rename paths (deepest first). Compute new path with all 3 replacements.
if (RENAME_PATHS) {
  console.log('\n— Phase 2: rename paths —');
  for (const { path } of all) {
    const base = path.split(sep).pop();
    const { text: newBase, count } = applyReplacements(base);
    if (count === 0) continue;
    const parent = dirname(path);
    const newPath = join(parent, newBase);

    if (APPLY) {
      try {
        if (existsSync(newPath)) {
          stats.errors.push({ path, error: `target exists: ${newPath}` });
          continue;
        }
        renameSync(path, newPath);
        stats.pathsRenamed++;
      } catch (e) {
        stats.errors.push({ path, error: String(e) });
        continue;
      }
    } else {
      stats.pathsRenamedDryRun++;
    }
    if (samplePathsRenamed.length < 25) {
      samplePathsRenamed.push({
        from: relative(REPO_ROOT, path),
        to: relative(REPO_ROOT, newPath),
      });
    }
    if (VERBOSE) console.log(`  mv   ${relative(REPO_ROOT, path)} → ${relative(REPO_ROOT, newPath)}`);
  }
}

console.log('\n— Summary —');
console.log(`  Content occurrences replaced: ${stats.contentReplacements}`);
console.log(`  Files edited:                 ${APPLY ? stats.filesEdited : stats.filesEditedDryRun}${APPLY ? '' : ' (would-be)'}`);
console.log(`  Paths renamed:                ${APPLY ? stats.pathsRenamed : stats.pathsRenamedDryRun}${APPLY ? '' : ' (would-be)'}`);
console.log(`  Files skipped (binary):       ${stats.filesSkippedBinary}`);
console.log(`  Files skipped (>5MB):         ${stats.filesSkippedTooLarge}`);
console.log(`  Errors:                       ${stats.errors.length}`);

if (sampleFilesEdited.length) {
  console.log('\n— Sample of files edited (first 25) —');
  for (const { path, count } of sampleFilesEdited) console.log(`  ${count.toString().padStart(4)}× ${path}`);
}
if (samplePathsRenamed.length) {
  console.log('\n— Sample of paths renamed (first 25) —');
  for (const { from, to } of samplePathsRenamed) console.log(`  ${from} → ${to}`);
}
if (stats.errors.length) {
  console.log('\n— Errors —');
  for (const { path, error } of stats.errors.slice(0, 50)) {
    console.log(`  ${path}: ${error}`);
  }
  if (stats.errors.length > 50) console.log(`  …and ${stats.errors.length - 50} more`);
}

if (!APPLY) {
  console.log('\nDry-run complete. Re-run with --apply to perform the rename.');
}

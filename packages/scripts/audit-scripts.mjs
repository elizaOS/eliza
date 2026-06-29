#!/usr/bin/env node
/**
 * Guard against the root `package.json` scripts block becoming a dumping ground
 * again (issue #9942). Scans package.json scripts and fails CI when it finds:
 *
 *   (a) ORPHAN root scripts — a root-package.json script that nothing invokes
 *       (no reference in .github/workflows/**, in any other script body, or in
 *       the docs / scripts source) AND that is not a recognised human/CI
 *       entrypoint. New scripts dumped into an ad-hoc namespace, or left behind
 *       after the tool they wrapped was deleted, get caught here.
 *
 *   (b) FAKE-SUCCESS no-ops — a `lint` / `typecheck` / `test` / `build` script
 *       whose body is just `echo "...skip..."`. Those report success while
 *       running nothing, so real lint/type/test/build failures land green.
 *
 *   (c) BROKEN references — a root script whose `--cwd <dir>` does not exist, or
 *       that points `node`/`bun` at a repo file (`*.mjs/.ts/.js/...`) that is
 *       missing. Deleting a tool without deleting its root alias is caught here.
 *
 * Scope:
 *   - (a) orphan: the root package.json scripts block (the dumping ground).
 *   - (b) no-op: first-party shipping packages — root + packages/, plugins/,
 *     apps/ — minus the vendored/demo/scaffold subtrees packages/examples/**,
 *     packages/feed/**, packages/benchmarks/** and packages/elizaos/templates/**,
 *     which legitimately ship `echo "no toolchain; skipping"` placeholders.
 *   - (c) broken refs: the root scripts block only. Sub-package script paths are
 *     out of scope — the tree holds scaffolding templates and optional nested
 *     local-mode `eliza/` clone paths that are intentionally absent here.
 *
 * Usage:
 *   node packages/scripts/audit-scripts.mjs            # audit the repo, exit 1 on failure
 *   node packages/scripts/audit-scripts.mjs --json     # machine-readable findings
 *   node packages/scripts/audit-scripts.mjs --root DIR # audit a fixture tree (self-test)
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "..", "..");

/**
 * Root-script namespaces (first `:`-segment) that are legitimate human / CI /
 * release entrypoints. Scripts in these namespaces never need an automated
 * caller. `audit` and `lint` are deliberately absent: those namespaces are the
 * historical dumping ground, so every `audit:*` / `lint:*` root script must be
 * either referenced or an explicit entrypoint below.
 */
const ALLOWED_NAMESPACES = new Set([
  "dev",
  "build",
  "test",
  "bench",
  "db",
  "cloud",
  "release",
  "version",
  "prepublish",
  "postpublish",
  "publish",
  "format",
  "clean",
  "start",
  "verify",
  "knip",
  "soc2",
  "sync",
  "cache",
  "harness",
  "migrate",
  "generate",
  "voice",
  "voice-models",
  "eliza1",
  "local-inference",
  "personality",
  "lifeops",
  "ai-qa",
  "fix-deps",
  "trajectory",
  "plugin-submodules",
  "ensure-plugin-test-conventions",
  "smartglasses",
  "capability-router",
  "browser-bridge",
]);

/**
 * Bare day-to-day entrypoints (and this audit's own scripts) that are run by
 * hand and need no caller. Keep this list small.
 */
const ALLOWED_EXACT = new Set([
  "dev",
  "build",
  "verify",
  "check",
  "test",
  "lint",
  "lint:check",
  "lint:all",
  "format",
  "typecheck",
  "start",
  "clean",
  "knip",
  "pre-commit",
  "audit:scripts",
  "audit:scripts:self-test",
]);

const NOOP_GATE_KEYS = /^(lint|typecheck|test|build)(:|$)/;
// Demo / vendored / scaffold subtrees that legitimately ship placeholder scripts
// or reference paths that only exist after scaffolding. Out of the no-op gate.
const EXCLUDED_SUBTREES = [
  "packages/examples",
  "packages/feed",
  "packages/benchmarks",
  "packages/elizaos/templates",
];
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".turbo",
  ".git",
  "coverage",
  "build",
  "out",
]);
const FILE_TOKEN = /\.(mjs|cjs|js|mts|cts|ts|tsx)$/;

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function readTextIfReadable(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function isExcluded(relPath) {
  const norm = relPath.split(path.sep).join("/");
  return EXCLUDED_SUBTREES.some(
    (sub) => norm === sub || norm.startsWith(`${sub}/`),
  );
}

function walk(dir, visit) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, visit);
    else visit(full);
  }
}

/** Every first-party package.json (root + packages/plugins/apps, minus demos). */
function collectPackageJsons(root) {
  const found = [path.join(root, "package.json")];
  for (const base of ["packages", "plugins", "apps"]) {
    walk(path.join(root, base), (file) => {
      if (path.basename(file) !== "package.json") return;
      if (isExcluded(path.relative(root, file))) return;
      found.push(file);
    });
  }
  return found.filter(existsSync);
}

/** Text corpus used to decide whether a root script name is referenced. */
function buildReferenceCorpus(root) {
  const chunks = [];
  walk(path.join(root, ".github", "workflows"), (file) => {
    if (/\.(ya?ml)$/.test(file)) chunks.push(readTextIfReadable(file));
  });
  // Every package.json's script bodies (no exclusions — broad reference coverage).
  const seenPkg = new Set([path.join(root, "package.json")]);
  for (const base of ["packages", "plugins", "apps"]) {
    walk(path.join(root, base), (file) => {
      if (path.basename(file) === "package.json") seenPkg.add(file);
    });
  }
  for (const file of seenPkg) {
    if (!existsSync(file)) continue;
    const scripts = readJson(file).scripts;
    if (scripts) chunks.push(Object.values(scripts).join("\n"));
  }
  for (const base of ["docs", "packages", "plugins", "apps", ".github"]) {
    walk(path.join(root, base), (file) => {
      if (file.endsWith(".md")) chunks.push(readTextIfReadable(file));
    });
  }
  walk(path.join(root, "scripts"), (file) => {
    if (/\.(mjs|cjs|js|ts|mts|cts)$/.test(file))
      chunks.push(readTextIfReadable(file));
  });
  walk(path.join(root, "packages", "scripts"), (file) => {
    if (/\.(mjs|cjs|js|ts|mts|cts)$/.test(file))
      chunks.push(readTextIfReadable(file));
  });
  // Root-level docs (README, AGENTS, CLAUDE, …) without recursing into packages.
  for (const entry of readdirSync(root)) {
    if (entry.endsWith(".md"))
      chunks.push(readTextIfReadable(path.join(root, entry)));
  }
  return chunks.join("\n");
}

function namespaceOf(name) {
  const idx = name.indexOf(":");
  return idx === -1 ? name : name.slice(0, idx);
}

function isNoopSkip(body) {
  if (!/skip/i.test(body) || !/\becho\b/i.test(body)) return false;
  const segments = body
    .split(/&&|\|\||;/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  // A genuine guard runs a real command alongside the echo; a no-op is echo only.
  return segments.every((segment) => /^echo\b/i.test(segment));
}

/** Candidate repo-relative file tokens referenced by a script body. */
function fileTokens(body) {
  return body
    .split(/\s+/)
    .map((token) => token.replace(/^["']|["']$/g, ""))
    .filter(
      (token) =>
        token.includes("/") && FILE_TOKEN.test(token) && !/[*${}]/.test(token),
    );
}

function existsAsFileFrom(bases, token) {
  return bases.some((base) => {
    const resolved = path.resolve(base, token);
    return existsSync(resolved) && statSync(resolved).isFile();
  });
}

function existsAsDirFrom(bases, token) {
  return bases.some((base) => {
    const resolved = path.resolve(base, token);
    return existsSync(resolved) && statSync(resolved).isDirectory();
  });
}

function auditScripts(root) {
  const failures = [];
  const corpus = buildReferenceCorpus(root);
  const rootScripts = readJson(path.join(root, "package.json")).scripts ?? {};

  // (a) Orphan root scripts.
  for (const name of Object.keys(rootScripts)) {
    if (ALLOWED_EXACT.has(name)) continue;
    if (ALLOWED_NAMESPACES.has(namespaceOf(name))) continue;
    if (corpus.includes(name)) continue;
    failures.push(
      `[orphan] root script "${name}" is never referenced (workflows, other ` +
        `script bodies, docs) and is not a recognised entrypoint. Wire it to a ` +
        `caller, add it to the audit allowlist, or delete it.`,
    );
  }

  // (b) Fake-success no-op lint/typecheck/test/build across first-party packages.
  for (const file of collectPackageJsons(root)) {
    const rel = path.relative(root, file) || "package.json";
    const scripts = readJson(file).scripts ?? {};
    for (const [name, body] of Object.entries(scripts)) {
      if (typeof body !== "string") continue;
      if (NOOP_GATE_KEYS.test(name) && isNoopSkip(body)) {
        failures.push(
          `[no-op] ${rel} script "${name}" is a fake-success echo-skip ` +
            `(${JSON.stringify(body)}). Run the real tool instead.`,
        );
      }
    }
  }

  // (c) Broken --cwd / file references in the root scripts block — the dumping
  // ground this audit guards. (Sub-package script paths are out of scope: the
  // tree legitimately holds scaffolding templates and optional nested-clone
  // `eliza/` references that are absent here.)
  for (const [name, body] of Object.entries(rootScripts)) {
    if (typeof body !== "string") continue;

    const cwdMatch = body.match(/--cwd\s+(\S+)/);
    if (cwdMatch) {
      const target = cwdMatch[1].replace(/^["']|["']$/g, "");
      if (!/[*${}]/.test(target) && !existsAsDirFrom([root], target)) {
        failures.push(
          `[broken-cwd] root script "${name}" uses --cwd "${target}" but that ` +
            `directory does not exist.`,
        );
      }
    }

    const hasCd = /\bcd\s+\S/.test(body);
    for (const token of fileTokens(body)) {
      const isRelative = token.startsWith("./") || token.startsWith("../");
      if (isRelative && hasCd) continue; // `cd X && node ../rel` shifts the cwd.
      if (token.startsWith("eliza/")) continue; // optional local-mode clone.
      if (!existsAsFileFrom([root], token)) {
        failures.push(
          `[broken-path] root script "${name}" references "${token}" but no ` +
            `such file exists.`,
        );
      }
    }
  }

  return failures;
}

function main() {
  const args = process.argv.slice(2);
  const rootArg = args.indexOf("--root");
  const root = rootArg === -1 ? DEFAULT_ROOT : path.resolve(args[rootArg + 1]);
  const json = args.includes("--json");

  const failures = auditScripts(root);

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ ok: failures.length === 0, failures }, null, 2)}\n`,
    );
  } else if (failures.length === 0) {
    process.stdout.write(
      "[audit-scripts] OK — no orphan/no-op/broken scripts.\n",
    );
  } else {
    process.stderr.write(
      `[audit-scripts] ${failures.length} finding(s):\n` +
        failures.map((f) => `  - ${f}`).join("\n") +
        "\n",
    );
  }

  process.exit(failures.length === 0 ? 0 : 1);
}

export { auditScripts };

if (import.meta.url === `file://${process.argv[1]}`) main();

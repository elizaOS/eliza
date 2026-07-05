#!/usr/bin/env node
/**
 * Diff-scoped guard against NEW raw `process.env` / `import.meta.env` reads of a
 * brand-env-alias key (#13422).
 *
 * The brand-env migration routes every read of an aliased key
 * (`ELIZA_STATE_DIR`, `ELIZA_API_TOKEN`, the ports, CORS/host allow-lists, the
 * mobile-platform flag, …) through the alias-aware reader
 * (`resolveAliasedEnvValue` / the `runtime-env` resolvers) so a white-label
 * distribution's `<PREFIX>_*` variable resolves WITHOUT materializing the
 * `ELIZA_*` mirror in `process.env`. A raw `process.env.ELIZA_STATE_DIR` read
 * bypasses that reader: it only sees the canonical key, so a `MILADY_STATE_DIR`
 * that was never mirrored silently reads as unset. The migration removes the
 * existing raw reads over time; this guard stops NEW ones from regrowing.
 *
 * The guarded key set is read from the single source of truth
 * (`packages/shared/src/config/brand-env-aliases.ts`) — every `elizaKey` /
 * `syncElizaKey` in `BRAND_ENV_ALIAS_DEFINITIONS` — so the guard tracks the
 * table automatically as aliases are added or removed.
 *
 * The repo already carries dozens of pre-existing raw reads; a repo-wide count
 * vs a static baseline cannot work (any unrelated `develop` merge that adds one
 * reds `verify` for everyone who rebases). So enforcement is scoped to the diff,
 * exactly like `error-policy-ratchet.mjs`:
 *
 *   base = git merge-base <base-ref> HEAD        (default base-ref origin/develop)
 *   for each guarded source file the branch touches (base..HEAD):
 *     fail iff its CURRENT (working-tree) raw-aliased-read count is GREATER than
 *     the same file's count at `base`.
 *
 * Immune to drift in files the PR does not touch; a no-op that passes on
 * `develop` itself and when no base ref is resolvable. The reader / alias-table
 * / sync files that legitimately name the canonical keys are allowlisted.
 *
 * Reads are classified via the TypeScript AST so a key inside a string or
 * comment is never miscounted. Three read shapes are detected, on either a
 * `process.env` or an `import.meta.env` container:
 *   - member access        `process.env.ELIZA_STATE_DIR`
 *   - element access       `process.env["ELIZA_STATE_DIR"]`
 *   - object destructuring  `const { ELIZA_STATE_DIR } = process.env`
 *
 * The repo-wide total is available via `--report` (informational only — it never
 * affects the exit code) to track the migration burn-down.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const ROOT = path.resolve(import.meta.dirname, "../..");

const ALIAS_TABLE_FILE = "packages/shared/src/config/brand-env-aliases.ts";

/**
 * Reader / alias-table / sync files that legitimately name the canonical
 * `ELIZA_*` keys: the alias table itself, the non-mutating reader, the sync
 * mirror, and the alias-aware runtime-env resolver. Raw reads here are the
 * reader implementation, not a bypass of it.
 */
const ALLOWLIST = new Set([
  "packages/shared/src/config/brand-env-aliases.ts",
  "packages/shared/src/config/boot-config.ts",
  "packages/shared/src/config/boot-config-store.ts",
  "packages/shared/src/utils/env.ts",
  "packages/shared/src/runtime-env.ts",
  "packages/core/src/boot-env.ts",
]);

const EXCLUDED_SEGMENTS = new Set([
  "__fixtures__",
  "__mocks__",
  "__tests__",
  "fixtures",
  "generated",
  "mock",
  "mocks",
  "test",
  "tests",
]);

const args = new Set(process.argv.slice(2));
const JSON_FLAG = args.has("--json");
const SELF_TEST = args.has("--self-test");
const REPORT = args.has("--report");

function usage() {
  console.log(`Usage: node packages/scripts/alias-read-guard.mjs [options]

Diff-scoped: fails only when a source file the branch touches under
packages/**/src or plugins/**/src increases its own count of raw
process.env / import.meta.env reads of a brand-env-alias key vs the
merge-base with origin/develop. Immune to unrelated develop drift.

The guarded key set is read from ${ALIAS_TABLE_FILE}.

Options:
  --json        Print machine-readable diff-scoped result JSON.
  --report      Also compute + print the repo-wide total (informational only).
  --self-test   Run the AST classifier + key-extraction + comparison self-test.

Env:
  ALIAS_READ_GUARD_BASE_REF  Override the base ref (default: origin/develop, then develop).
`);
}

if (args.has("--help") || args.has("-h")) {
  usage();
  process.exit(0);
}

/**
 * Extract the guarded canonical keys from the alias table's source. Every
 * `elizaKey` / `syncElizaKey` string-literal property value in
 * `BRAND_ENV_ALIAS_DEFINITIONS` is a canonical key a raw read must not target.
 * Parsing the AST (not a regex) keeps this exact as the table's formatting
 * changes. Exported for the self-test.
 */
export function extractGuardedKeys(aliasTableSource) {
  const sourceFile = ts.createSourceFile(
    ALIAS_TABLE_FILE,
    aliasTableSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const keys = new Set();

  function visit(node) {
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      (node.name.text === "elizaKey" || node.name.text === "syncElizaKey") &&
      ts.isStringLiteralLike(node.initializer)
    ) {
      keys.add(node.initializer.text);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  if (keys.size === 0) {
    throw new Error(
      `[alias-read-guard] no guarded keys found in ${ALIAS_TABLE_FILE}; the alias-table format changed — update the extractor.`,
    );
  }
  return keys;
}

function sourceFileKind(relPath) {
  return relPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

/**
 * True for the `process.env` / `import.meta.env` container expression, the only
 * two objects whose members this guard treats as a raw aliased-env read.
 */
function isEnvContainer(node) {
  if (!node || !ts.isPropertyAccessExpression(node)) return false;
  if (node.name.text !== "env") return false;
  const target = node.expression;
  if (ts.isIdentifier(target) && target.text === "process") return true;
  // import.meta.env — `import.meta` parses to a MetaProperty node.
  if (ts.isMetaProperty(target) && target.name.text === "meta") return true;
  return false;
}

/**
 * Collect every raw aliased-env read in one source file's text. Member access,
 * element access, and object destructuring off a `process.env`/`import.meta.env`
 * container whose key is in `guardedKeys`. Exported for the self-test.
 */
export function collectRawAliasReads(sourceText, relPath, guardedKeys) {
  const sourceFile = ts.createSourceFile(
    relPath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    sourceFileKind(relPath),
  );
  const findings = [];

  function record(key, node) {
    const pos = sourceFile.getLineAndCharacterOfPosition(
      node.getStart(sourceFile),
    );
    findings.push({ key, file: relPath, line: pos.line + 1 });
  }

  function visit(node) {
    // process.env.KEY / import.meta.env.KEY
    if (
      ts.isPropertyAccessExpression(node) &&
      isEnvContainer(node.expression) &&
      ts.isIdentifier(node.name) &&
      guardedKeys.has(node.name.text)
    ) {
      record(node.name.text, node);
    }

    // process.env["KEY"] / import.meta.env["KEY"]
    if (
      ts.isElementAccessExpression(node) &&
      isEnvContainer(node.expression) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      guardedKeys.has(node.argumentExpression.text)
    ) {
      record(node.argumentExpression.text, node);
    }

    // const { KEY } = process.env / import.meta.env
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      isEnvContainer(node.initializer) &&
      ts.isObjectBindingPattern(node.name)
    ) {
      for (const element of node.name.elements) {
        const source = element.propertyName ?? element.name;
        if (ts.isIdentifier(source) && guardedKeys.has(source.text)) {
          record(source.text, element);
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return findings;
}

function countText(sourceText, relPath, guardedKeys) {
  return collectRawAliasReads(sourceText, relPath, guardedKeys).length;
}

/**
 * A guarded source file: production `.ts`/`.tsx` under `packages/**​/src` or
 * `plugins/**​/src`, excluding declaration/test/fixture files and the allowlisted
 * reader/alias-table/sync files.
 */
export function isGuardedSourceFile(relPath) {
  if (!/\.(ts|tsx)$/.test(relPath)) return false;
  if (/\.d\.ts$/.test(relPath)) return false;
  if (ALLOWLIST.has(relPath)) return false;

  const underPackages = relPath.startsWith("packages/");
  const underPlugins = relPath.startsWith("plugins/");
  if (!underPackages && !underPlugins) return false;
  if (!relPath.includes("/src/")) return false;

  const parts = relPath.split("/");
  if (parts.some((part) => EXCLUDED_SEGMENTS.has(part))) return false;

  const base = path.basename(relPath);
  if (/\.(test|spec|e2e|stories?|fixture|mock)\.(ts|tsx)$/.test(base)) {
    return false;
  }
  return true;
}

function git(argv, { allowFailure = false } = {}) {
  try {
    return execFileSync("git", argv, {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", allowFailure ? "ignore" : "inherit"],
    });
  } catch (err) {
    if (allowFailure) return null;
    throw err;
  }
}

/** First resolvable ref among the env override, origin/develop, develop. */
function resolveBaseRef() {
  const candidates = [
    process.env.ALIAS_READ_GUARD_BASE_REF,
    "origin/develop",
    "develop",
  ].filter(Boolean);
  for (const ref of candidates) {
    if (
      git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
        allowFailure: true,
      })
    ) {
      return ref;
    }
  }
  return null;
}

/** Merge-base of the base ref and HEAD; null if it cannot be computed. */
function mergeBaseWith(ref) {
  const out = git(["merge-base", ref, "HEAD"], { allowFailure: true });
  return out ? out.trim() : null;
}

/** Guarded source files the branch touches relative to the merge-base. */
function changedGuardedFiles(base) {
  const out = git(["diff", "--name-only", "-z", `${base}`, "HEAD"], {
    allowFailure: true,
  });
  if (!out) return [];
  return [...new Set(out.split("\0").filter(Boolean))]
    .filter(isGuardedSourceFile)
    .sort();
}

/** File content at `base`, or null if the file did not exist there. */
function baseContent(base, relPath) {
  return git(["show", `${base}:${relPath}`], { allowFailure: true });
}

/** Working-tree content, or null if the file was deleted on the branch. */
function workingTreeContent(relPath) {
  try {
    return readFileSync(path.join(ROOT, relPath), "utf8");
  } catch {
    return null;
  }
}

/**
 * For each changed guarded file, compare its working-tree raw-read count to its
 * count at the merge-base. New files compare against zero.
 */
function diffScopedRegressions(base, files, guardedKeys) {
  const perFile = [];
  const regressions = [];
  for (const relPath of files) {
    const currentText = workingTreeContent(relPath);
    if (currentText === null) continue; // deleted on the branch — nothing added.
    const currentFindings = collectRawAliasReads(
      currentText,
      relPath,
      guardedKeys,
    );
    const current = currentFindings.length;

    const baseText = baseContent(base, relPath);
    const base_ = baseText === null ? 0 : countText(baseText, relPath, guardedKeys);

    perFile.push({ file: relPath, current, base: base_ });
    if (current > base_) {
      regressions.push({
        file: relPath,
        current,
        base: base_,
        findings: currentFindings,
      });
    }
  }
  return { perFile, regressions };
}

/** Repo-wide informational total (never gates). */
function repoWideTotal(guardedKeys) {
  const output = git(["ls-files"]);
  const files = [...new Set(output.split("\n").filter(Boolean))].filter(
    isGuardedSourceFile,
  );
  let total = 0;
  const byFile = [];
  for (const relPath of files) {
    const n = countText(
      readFileSync(path.join(ROOT, relPath), "utf8"),
      relPath,
      guardedKeys,
    );
    if (n > 0) byFile.push({ file: relPath, count: n });
    total += n;
  }
  return { filesScanned: files.length, filesWithReads: byFile.length, total };
}

function printHumanSummary({ baseRef, base, files, perFile, regressions }) {
  console.log(
    `[alias-read-guard] base ${baseRef} (${base.slice(0, 10)}); ${files.length} changed guarded source file(s)`,
  );
  for (const row of perFile) {
    console.log(
      `[alias-read-guard]   ${row.file}: raw-aliased-reads ${row.base}->${row.current}`,
    );
  }
  if (regressions.length === 0) {
    console.log(
      "[alias-read-guard] no new raw process.env/import.meta.env reads of aliased keys in touched files",
    );
    return;
  }
  console.error(
    "[alias-read-guard] new raw aliased-env reads added in touched files:",
  );
  for (const r of regressions) {
    console.error(`  - ${r.file}: ${r.base} -> ${r.current}`);
    for (const f of r.findings) {
      console.error(`      L${f.line}: process.env/import.meta.env.${f.key}`);
    }
  }
  console.error(
    `\nA PR may not ADD raw process.env / import.meta.env reads of a brand-env-alias key ` +
      `(defined in ${ALIAS_TABLE_FILE}). Read aliased keys through the alias-aware reader ` +
      `(resolveAliasedEnvValue / the runtime-env resolvers / readAliasedEnv) so a rebranded ` +
      `<PREFIX>_* value resolves without the ELIZA_* mirror. See issue #13422.`,
  );
}

function runSelfTest() {
  // Key extraction reads elizaKey + syncElizaKey off the real table shape.
  const sampleTable = `
    export const BRAND_ENV_ALIAS_DEFINITIONS = [
      { brandSuffix: "STATE_DIR", elizaKey: "ELIZA_STATE_DIR" },
      { brandSuffix: "SETTINGS_DEBUG", elizaKey: "VITE_ELIZA_SETTINGS_DEBUG", vite: true },
      { brandSuffix: "PORT", elizaKey: "ELIZA_PORT", syncElizaKey: "ELIZA_UI_PORT" },
    ] as const;
    // brandSuffix must NOT be extracted:
    const notAKey = { brandSuffix: "NOT_A_GUARDED_KEY" };
  `;
  const keys = extractGuardedKeys(sampleTable);
  const expectKeys = [
    "ELIZA_STATE_DIR",
    "VITE_ELIZA_SETTINGS_DEBUG",
    "ELIZA_PORT",
    "ELIZA_UI_PORT",
  ];
  for (const k of expectKeys) {
    if (!keys.has(k)) {
      console.error(`[alias-read-guard] self-test failed: missing key ${k}`);
      process.exit(1);
    }
  }
  if (keys.has("STATE_DIR") || keys.has("NOT_A_GUARDED_KEY")) {
    console.error(
      "[alias-read-guard] self-test failed: brandSuffix leaked into guarded keys",
    );
    process.exit(1);
  }

  const guardedKeys = new Set(expectKeys);
  const sample = `
    const a = process.env.ELIZA_STATE_DIR;            // read 1 (member)
    const b = process.env["ELIZA_PORT"];              // read 2 (element)
    const { ELIZA_UI_PORT } = process.env;            // read 3 (destructure)
    const c = import.meta.env.VITE_ELIZA_SETTINGS_DEBUG; // read 4 (import.meta.env)
    const d = process.env.SOME_OTHER_KEY;             // not guarded
    const e = env.ELIZA_STATE_DIR;                    // not process.env
    const f = "process.env.ELIZA_STATE_DIR";          // string, not a read
    // process.env.ELIZA_PORT in a comment is not a read
    const g = obj.process.env.ELIZA_PORT;             // not the global process
  `;
  const findings = collectRawAliasReads(sample, "packages/x/src/sample.ts", guardedKeys);
  if (findings.length !== 4) {
    console.error(
      `[alias-read-guard] self-test failed: expected 4 reads, got ${findings.length}: ${JSON.stringify(findings)}`,
    );
    process.exit(1);
  }

  // Scope: allowlisted + test + non-src + out-of-tree files are not guarded.
  const scopeCases = [
    ["packages/x/src/a.ts", true],
    // a plugins/**/src file is in scope; the literal avoids the plugins/plugin-*
    // coupling-token shape audit-scripts.mjs forbids in generic scripts.
    ["plugins/example-y/src/b.tsx", true],
    ["packages/x/src/a.test.ts", false],
    ["packages/x/src/__tests__/a.ts", false],
    ["packages/x/src/a.d.ts", false],
    ["packages/x/lib/a.ts", false],
    ["packages/shared/src/runtime-env.ts", false], // allowlisted reader
    ["packages/core/src/boot-env.ts", false], // allowlisted reader
    ["apps/app/src/a.ts", false], // outside packages/ + plugins/
    ["scripts/a.ts", false],
  ];
  for (const [file, expected] of scopeCases) {
    if (isGuardedSourceFile(file) !== expected) {
      console.error(
        `[alias-read-guard] self-test failed: scope for ${file} should be ${expected}`,
      );
      process.exit(1);
    }
  }

  console.log("[alias-read-guard] self-test passed");
}

if (SELF_TEST) {
  runSelfTest();
  process.exit(0);
}

const guardedKeys = extractGuardedKeys(
  readFileSync(path.join(ROOT, ALIAS_TABLE_FILE), "utf8"),
);

const baseRef = resolveBaseRef();
const base = baseRef ? mergeBaseWith(baseRef) : null;

if (!base) {
  const reason = baseRef
    ? `no merge-base with ${baseRef}`
    : "no base ref (origin/develop) resolvable";
  const repoWide = REPORT ? repoWideTotal(guardedKeys) : null;
  if (JSON_FLAG) {
    console.log(
      JSON.stringify(
        { ok: true, skipped: reason, baseRef, mergeBase: null, repoWide },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `[alias-read-guard] ${reason}; diff-scoped check skipped (pass)`,
    );
    if (repoWide) {
      console.log(
        `[alias-read-guard] repo-wide (informational): ${repoWide.total} raw aliased-env read(s) across ${repoWide.filesWithReads} file(s)`,
      );
    }
  }
  process.exit(0);
}

const files = changedGuardedFiles(base);
const { perFile, regressions } = diffScopedRegressions(base, files, guardedKeys);
const repoWide = REPORT ? repoWideTotal(guardedKeys) : null;

if (JSON_FLAG) {
  console.log(
    JSON.stringify(
      {
        ok: regressions.length === 0,
        baseRef,
        mergeBase: base,
        guardedKeyCount: guardedKeys.size,
        changedFiles: files,
        perFile,
        regressions,
        repoWide,
      },
      null,
      2,
    ),
  );
} else {
  printHumanSummary({ baseRef, base, files, perFile, regressions });
  if (repoWide) {
    console.log(
      `[alias-read-guard] repo-wide (informational): ${repoWide.total} raw aliased-env read(s) across ${repoWide.filesWithReads} file(s)`,
    );
  }
}

if (regressions.length > 0) process.exit(1);

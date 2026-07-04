#!/usr/bin/env node
/**
 * Machine proof that a comment-cleanup change touches comments and whitespace
 * only, never code.
 *
 * For every file changed against a base ref (default `origin/develop`), the
 * base blob and the working-tree copy are parsed with the TypeScript parser and
 * their ASTs are walked to the leaf-token level; comments (including JSDoc
 * doc-comments, which the parser keeps as nodes rather than trivia) are
 * excluded, and the two code-token streams are asserted identical. Any token, or
 * any added / deleted / renamed / non-source changed file, fails the check and
 * is reported with the first offending token. A comment edit cannot change the
 * parsed code tokens, so an identical token stream is a sound proof that only
 * comments moved.
 *
 * This script is the single non-comment change in the repo-wide comment cleanup
 * (parent elizaOS/eliza#12181, Work Item 2): it lets each batch PR prove "zero
 * functional diff" mechanically instead of by reviewer trust. Wired as the root
 * `check:comment-only` npm script; run per batch PR alongside `bun run verify`.
 *
 * Usage:
 *   node scripts/assert-comment-only-diff.mjs [base-ref]   # default origin/develop
 *   node scripts/assert-comment-only-diff.mjs --self-test  # planted-diff self-check
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import ts from "typescript";

const SOURCE_EXT = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 30 });
}

function isSource(file) {
  return SOURCE_EXT.has(extname(file));
}

function scriptKind(fileName) {
  if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (fileName.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (
    fileName.endsWith(".js") ||
    fileName.endsWith(".mjs") ||
    fileName.endsWith(".cjs")
  )
    return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * Non-trivia token stream: `<kind>:<raw source text>` per leaf token, in order.
 *
 * The file is fully parsed (`createSourceFile`) and its AST is walked to its
 * leaf tokens — the raw scanner is deliberately NOT used, because a scanner has
 * no parse context and cannot tell a regex literal (`/…/`) from division or a
 * template literal from a backtick inside a regex; a regex such as
 * `` /=`([^`]+)`/ `` would make the scanner mis-open a template literal that
 * swallows following comments, producing false divergences on comment-only
 * edits. The parser resolves all of that. Comments are trivia and are not
 * nodes, so they are excluded; string/template/regex literals and JSX text are
 * single leaf tokens whose text is compared, so any code or literal edit
 * surfaces as a divergence.
 */
function tokenStream(text, fileName) {
  const sf = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    scriptKind(fileName),
  );
  const tokens = [];
  const visit = (node) => {
    // `/** … */` doc-comments are parsed into JSDoc nodes (not trivia); they are
    // comments and are editable, so skip the whole JSDoc subtree.
    if (
      node.kind >= ts.SyntaxKind.FirstJSDocNode &&
      node.kind <= ts.SyntaxKind.LastJSDocNode
    ) {
      return;
    }
    const children = node.getChildren(sf);
    if (children.length === 0) {
      if (node.kind === ts.SyntaxKind.EndOfFileToken) return;
      tokens.push(`${node.kind}:${node.getText(sf)}`);
      return;
    }
    for (const child of children) visit(child);
  };
  visit(sf);
  return tokens;
}

/** First divergent index, or -1 if the two streams are identical. */
function firstDivergence(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return i;
  }
  return a.length === b.length ? -1 : n;
}

function selfTest() {
  const before = `const answer = 40 + 2; // old note\nexport default answer;\n`;
  const commentsOnly = `/** Header prose. */\nconst answer = 40 + 2; // new note, rewritten\nexport default answer;\n`;
  const oneToken = `const answer = 40 + 3; // old note\nexport default answer;\n`;

  const failures = [];
  if (
    firstDivergence(
      tokenStream(before, "x.ts"),
      tokenStream(commentsOnly, "x.ts"),
    ) !== -1
  ) {
    failures.push(
      "comments-only plant was flagged as a code change (false positive)",
    );
  }
  if (
    firstDivergence(
      tokenStream(before, "x.ts"),
      tokenStream(oneToken, "x.ts"),
    ) === -1
  ) {
    failures.push(
      "one-token code plant (40+2 -> 40+3) slipped through (false negative)",
    );
  }
  if (failures.length) {
    for (const f of failures)
      console.error(`[assert-comment-only-diff] self-test FAIL: ${f}`);
    process.exit(1);
  }
  console.log(
    "[assert-comment-only-diff] self-test PASS: comments-only accepted, one-token change rejected.",
  );
  process.exit(0);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) return selfTest();

  const base = argv[0] || "origin/develop";
  let mergeBase;
  try {
    mergeBase = git(["merge-base", base, "HEAD"]).trim();
  } catch {
    console.error(
      `[assert-comment-only-diff] cannot resolve merge-base of ${base} and HEAD.`,
    );
    process.exit(2);
  }

  // Diff merge-base against the working tree: catches committed and uncommitted
  // changes on this branch without flagging what develop moved on its own.
  const raw = git(["diff", "--name-status", "-z", mergeBase]);
  const parts = raw.split("\0").filter(Boolean);

  const violations = [];
  let checked = 0;

  for (let i = 0; i < parts.length; ) {
    const status = parts[i++];
    const code = status[0];
    const file = parts[i++];
    // Renames/copies carry a second path field.
    const dest = code === "R" || code === "C" ? parts[i++] : file;

    if (code !== "M") {
      violations.push(
        `${dest}: ${code} — comment cleanup must modify existing files only, not add/delete/rename`,
      );
      continue;
    }
    if (!isSource(dest)) {
      violations.push(
        `${dest}: changed non-source file — comment cleanup touches source files only`,
      );
      continue;
    }

    let baseText;
    try {
      baseText = git(["show", `${mergeBase}:${file}`]);
    } catch {
      violations.push(`${dest}: cannot read base blob at ${mergeBase}`);
      continue;
    }
    const headText = readFileSync(dest, "utf8");

    const baseTokens = tokenStream(baseText, dest);
    const headTokens = tokenStream(headText, dest);
    const idx = firstDivergence(baseTokens, headTokens);
    checked++;
    if (idx !== -1) {
      const b =
        baseTokens[idx]?.split(":").slice(1).join(":") ?? "<end of file>";
      const h =
        headTokens[idx]?.split(":").slice(1).join(":") ?? "<end of file>";
      violations.push(
        `${dest}: code token #${idx} diverges — base \`${b}\` vs head \`${h}\``,
      );
    }
  }

  if (violations.length) {
    console.error(
      `[assert-comment-only-diff] FAIL — ${violations.length} file(s) changed code, not just comments:\n`,
    );
    for (const v of violations) console.error(`  ✗ ${v}`);
    console.error(
      `\nComment cleanup requires zero functional diff. Fix the files above.`,
    );
    process.exit(1);
  }

  console.log(
    `[assert-comment-only-diff] OK — ${checked} source file(s) changed; every code token identical to ${base}. Comments only.`,
  );
}

main();

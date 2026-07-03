#!/usr/bin/env node
/**
 * Machine guard for the comment-cleanup effort (parent issue #12181): proves a
 * branch changed *only* comments and whitespace, never a single token of code.
 *
 * The cleanup rewrites file headers and in-body comments across thousands of
 * files. "Trust me, it's comments-only" is not evidence, so this script makes it
 * checkable: for every file that differs from the merge base it tokenizes both
 * revisions with the TypeScript scanner — which classifies comments and
 * whitespace as *trivia* and skips them — and asserts the two non-trivia token
 * streams are byte-identical. A one-token code change (rename, reordered
 * argument, flipped operator) shifts the stream and fails; adding, rewriting, or
 * deleting a comment does not. Any changed file with a non-source extension is
 * also a failure, because a comment-only batch must never touch build/config.
 *
 * Consumed by the root `check:comment-only` script and by each batch PR's CI.
 * Default base is `origin/develop`; pass an alternate base as the first argv.
 * `--self-test` runs an internal proof that the guard catches a planted
 * one-token change and passes a planted comments-only change (no git needed).
 */

import { execFileSync } from "node:child_process";
import process from "node:process";
import ts from "typescript";

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

/** JSX-capable scanning for .tsx/.jsx so `<Tag>` tokenizes the same on both sides. */
function languageVariantFor(path) {
  return path.endsWith(".tsx") || path.endsWith(".jsx")
    ? ts.LanguageVariant.JSX
    : ts.LanguageVariant.Standard;
}

function extensionOf(path) {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot);
}

/**
 * The ordered non-trivia tokens of a source string. Each entry is `kind:text`
 * so a rename (same kind, different text) diverges just like a structural edit.
 * Comments and whitespace never appear — the scanner skips them as trivia — so
 * two revisions that differ only in comments produce identical arrays.
 *
 * The bare scanner has no parser context, so it may mis-classify a regex vs.
 * division or a template span. That is irrelevant here: the mis-scan is a pure
 * function of the non-trivia characters, which are identical on both sides of a
 * comments-only change, so it cancels out. Streams match iff the code matches.
 */
function tokenize(source, variant) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /* skipTrivia */ true,
    variant,
    source,
  );
  const tokens = [];
  let token = scanner.scan();
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    tokens.push(`${token}:${scanner.getTokenText()}`);
    token = scanner.scan();
  }
  return tokens;
}

/**
 * Compare two token streams. Returns `null` when identical, otherwise the index
 * and both sides of the first divergence so the caller can point at it.
 */
function firstDivergence(baseTokens, headTokens) {
  const max = Math.max(baseTokens.length, headTokens.length);
  for (let i = 0; i < max; i++) {
    if (baseTokens[i] !== headTokens[i]) {
      return {
        index: i,
        base: baseTokens[i] ?? "<end of file>",
        head: headTokens[i] ?? "<end of file>",
      };
    }
  }
  return null;
}

/** `kind:text` → the readable token text, for the failure message. */
function tokenLabel(entry) {
  if (entry === "<end of file>") return entry;
  const colon = entry.indexOf(":");
  return entry.slice(colon + 1);
}

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 256,
    // Capture stderr instead of inheriting so an expected failure (e.g.
    // `git show base:<added-file>`) does not leak a `fatal:` line to output.
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Merge base of `base` and HEAD, matching `git diff base...HEAD` semantics. */
function resolveMergeBase(base) {
  try {
    return git(["merge-base", base, "HEAD"]).trim();
  } catch {
    // base may be an exact commit or unfetched ref; compare against it directly.
    return base;
  }
}

function changedFiles(mergeBase) {
  return git(["diff", "--name-only", mergeBase, "--"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Base-revision contents of `path`, or `null` when the file is newly added. */
function readBaseSource(mergeBase, path) {
  try {
    return git(["show", `${mergeBase}:${path}`]);
  } catch {
    return null;
  }
}

/** Worktree contents of `path`, or `null` when the file was deleted. */
function readHeadSource(path) {
  try {
    return execFileSync("cat", [path], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 256,
    });
  } catch {
    return null;
  }
}

function runCheck(base) {
  const mergeBase = resolveMergeBase(base);
  const files = changedFiles(mergeBase);
  const violations = [];

  for (const path of files) {
    if (!SOURCE_EXTENSIONS.has(extensionOf(path))) {
      violations.push(
        `${path}: non-source file changed (a comment-only batch must touch only ${[...SOURCE_EXTENSIONS].join(", ")})`,
      );
      continue;
    }

    const baseSource = readBaseSource(mergeBase, path);
    const headSource = readHeadSource(path);
    if (baseSource === null) {
      violations.push(`${path}: file added (not a comments-only change)`);
      continue;
    }
    if (headSource === null) {
      violations.push(`${path}: file deleted (not a comments-only change)`);
      continue;
    }

    const variant = languageVariantFor(path);
    const divergence = firstDivergence(
      tokenize(baseSource, variant),
      tokenize(headSource, variant),
    );
    if (divergence) {
      violations.push(
        `${path}: code token changed at position ${divergence.index} — base \`${tokenLabel(divergence.base)}\` vs head \`${tokenLabel(divergence.head)}\``,
      );
    }
  }

  if (violations.length > 0) {
    console.error(
      `[assert-comment-only-diff] ${violations.length} file(s) changed more than comments (base ${mergeBase}):`,
    );
    for (const violation of violations) console.error(`  - ${violation}`);
    return 1;
  }

  console.log(
    `[assert-comment-only-diff] OK — ${files.length} changed file(s), all comments-only (base ${mergeBase}).`,
  );
  return 0;
}

/**
 * Prove the guard both ways without git: a planted one-token change must be
 * caught, and a planted comments-only rewrite must pass. Exit non-zero if either
 * assertion is wrong so the guard can never silently rot.
 */
function selfTest() {
  const original = [
    "/** Original header. */",
    "export function add(a, b) {",
    "  // sum them",
    "  return a + b;",
    "}",
  ].join("\n");

  const commentsOnly = [
    "/** Rewritten header explaining what add does and who calls it. */",
    "export function add(a, b) {",
    "  return a + b; // still sums, comment moved to the line",
    "}",
  ].join("\n");

  const oneTokenChange = [
    "/** Original header. */",
    "export function add(a, b) {",
    "  // sum them",
    "  return a - b;", // + flipped to -
    "}",
  ].join("\n");

  const variant = ts.LanguageVariant.Standard;
  const baseTokens = tokenize(original, variant);

  const commentsDivergence = firstDivergence(
    baseTokens,
    tokenize(commentsOnly, variant),
  );
  const codeDivergence = firstDivergence(
    baseTokens,
    tokenize(oneTokenChange, variant),
  );

  let ok = true;
  if (commentsDivergence !== null) {
    ok = false;
    console.error(
      `[self-test] FAIL: comments-only rewrite was flagged at token ${commentsDivergence.index} (\`${tokenLabel(commentsDivergence.base)}\` vs \`${tokenLabel(commentsDivergence.head)}\`)`,
    );
  } else {
    console.log("[self-test] PASS: comments-only rewrite accepted.");
  }

  if (codeDivergence === null) {
    ok = false;
    console.error(
      "[self-test] FAIL: a one-token code change (`+` → `-`) slipped through.",
    );
  } else {
    console.log(
      `[self-test] PASS: one-token code change caught at token ${codeDivergence.index} (\`${tokenLabel(codeDivergence.base)}\` vs \`${tokenLabel(codeDivergence.head)}\`).`,
    );
  }

  return ok ? 0 : 1;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) {
    process.exit(selfTest());
  }
  const base = args.find((arg) => !arg.startsWith("--")) ?? "origin/develop";
  process.exit(runCheck(base));
}

main();

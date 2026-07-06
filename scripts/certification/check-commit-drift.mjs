#!/usr/bin/env node
/**
 * Commit-drift check for the develop→main certification gate (#14547). A
 * certification signs one exact commit, but a promotion branch may pick up
 * non-source commits after signing (README and docs touch-ups). This
 * helper decides whether the PR head is still covered by the certification:
 * pass iff head == cert.commit, or cert.commit is an ancestor of head and
 * every path in `git diff cert.commit..head` matches the docs-only allowlist.
 *
 * The allowlist is deliberately narrow: docs/**, packages/docs/**, any *.md,
 * and the certification artifacts. GitHub workflow/policy/config drift must
 * force re-certification, never ride the docs allowlist.
 *
 * Consumed by .github/workflows/certification-verify.yml; it reads the
 * certification only to extract `commit` — all cryptographic and schema
 * verification stays in `packages/evidence certify:verify`.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Paths that may change after certification without re-certifying. */
export function isAllowedDriftPath(filePath) {
  // Trust anchor and gate plumbing: never allowed as post-certification drift.
  if (filePath.startsWith(".github/certification/")) return false;
  if (filePath === ".github/workflows/certification-verify.yml") return false;
  if (filePath.startsWith("scripts/certification/")) return false;

  // The certification artifacts themselves necessarily land AFTER the
  // certified commit (the signature covers the commit sha, so the commit that
  // adds the file can never be the signed one). Their integrity is enforced
  // cryptographically — signature over the payload, bundleSha over the bundle
  // — not by the drift rule, so allowing them here weakens nothing.
  if (filePath === "certification.json") return true;
  if (filePath.startsWith("evidence/bundle/")) return true;

  if (filePath.startsWith("docs/")) return true;
  if (filePath.startsWith("packages/docs/")) return true;
  if (filePath.endsWith(".md")) return true;
  return false;
}

const SHA_RE = /^[0-9a-f]{40}$/;

function git(repoDir, args) {
  return execFileSync("git", args, {
    cwd: repoDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Read `commit` out of a certification.json without validating anything else. */
export function readCertCommit(certPath) {
  let raw;
  try {
    raw = readFileSync(certPath, "utf8");
  } catch (error) {
    return { error: `certification unreadable: ${error.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { error: `certification is not valid JSON: ${error.message}` };
  }
  const commit = parsed?.commit;
  if (typeof commit !== "string" || !SHA_RE.test(commit)) {
    return {
      error: `certification \`commit\` is not a full 40-hex sha: ${JSON.stringify(commit)}`,
    };
  }
  return { commit };
}

/**
 * Evaluate drift between the certified commit and the PR head.
 * Result shape: { result, certCommit, headCommit, driftPaths, disallowedPaths, detail }
 * where result is one of:
 *   match | allowed-drift             → covered by the certification
 *   cert-commit-unknown | not-ancestor | disallowed-drift  → not covered
 */
export function evaluateCommitDrift({ certCommit, headCommit, repoDir }) {
  const base = {
    certCommit,
    headCommit,
    driftPaths: [],
    disallowedPaths: [],
  };
  if (certCommit === headCommit) {
    return {
      ...base,
      result: "match",
      detail: "certification commit equals the PR head",
    };
  }

  try {
    git(repoDir, ["cat-file", "-e", `${certCommit}^{commit}`]);
  } catch {
    // A cert for a commit this repository has never seen (or outside the
    // fetched history window) cannot cover this head. Shallow clones can
    // produce this for very old certs — that fails safe: stale certs must
    // re-certify anyway.
    return {
      ...base,
      result: "cert-commit-unknown",
      detail: `certified commit ${certCommit} is not present in this repository's fetched history`,
    };
  }

  let isAncestor = true;
  try {
    git(repoDir, ["merge-base", "--is-ancestor", certCommit, headCommit]);
  } catch (error) {
    if (error.status === 1) {
      isAncestor = false;
    } else {
      throw error;
    }
  }
  if (!isAncestor) {
    return {
      ...base,
      result: "not-ancestor",
      detail: `certified commit ${certCommit} is not an ancestor of head ${headCommit} — the certified tree was never part of this branch`,
    };
  }

  const driftPaths = git(repoDir, [
    "diff",
    "--name-only",
    "-z",
    certCommit,
    headCommit,
  ])
    .split("\0")
    .filter((entry) => entry.length > 0);
  const disallowedPaths = driftPaths.filter(
    (entry) => !isAllowedDriftPath(entry),
  );
  if (disallowedPaths.length > 0) {
    return {
      ...base,
      driftPaths,
      disallowedPaths,
      result: "disallowed-drift",
      detail: `${disallowedPaths.length} of ${driftPaths.length} drifted path(s) fall outside the docs-only allowlist — re-certify at the current head`,
    };
  }
  return {
    ...base,
    driftPaths,
    result: "allowed-drift",
    detail: `${driftPaths.length} drifted path(s), all inside the docs-only allowlist`,
  };
}

function parseArgs(argv) {
  const args = { repoDir: process.cwd() };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined) {
        console.error(`${flag} requires a value`);
        process.exit(2);
      }
      index += 1;
      return next;
    };
    if (flag === "--cert") args.certPath = value();
    else if (flag === "--head") args.headCommit = value();
    else if (flag === "--repo") args.repoDir = value();
    else if (flag === "--json-out") args.jsonOut = value();
    else if (flag === "--github-output") args.githubOutput = value();
    else {
      console.error(`unknown argument: ${flag}`);
      process.exit(2);
    }
  }
  if (args.certPath === undefined || args.headCommit === undefined) {
    console.error(
      "Usage: check-commit-drift.mjs --cert <certification.json> --head <sha> [--repo <dir>] [--json-out <file>] [--github-output <file>]",
    );
    process.exit(2);
  }
  if (!SHA_RE.test(args.headCommit)) {
    console.error(`--head must be a full 40-hex sha, got: ${args.headCommit}`);
    process.exit(2);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const certRead = readCertCommit(args.certPath);
  const outcome =
    "error" in certRead
      ? {
          result: "cert-unreadable",
          certCommit: null,
          headCommit: args.headCommit,
          driftPaths: [],
          disallowedPaths: [],
          detail: certRead.error,
        }
      : evaluateCommitDrift({
          certCommit: certRead.commit,
          headCommit: args.headCommit,
          repoDir: args.repoDir,
        });

  if (args.jsonOut !== undefined) {
    writeFileSync(args.jsonOut, `${JSON.stringify(outcome, null, 2)}\n`);
  }
  if (args.githubOutput !== undefined) {
    appendFileSync(
      args.githubOutput,
      `cert-commit=${outcome.certCommit ?? ""}\nresult=${outcome.result}\n`,
    );
  }

  const ok = outcome.result === "match" || outcome.result === "allowed-drift";
  console.log(`[check-commit-drift] ${outcome.result}: ${outcome.detail}`);
  for (const entry of outcome.driftPaths) {
    const marker = outcome.disallowedPaths.includes(entry)
      ? "DISALLOWED"
      : "allowed   ";
    console.log(`  ${marker} ${entry}`);
  }
  process.exit(ok ? 0 : 1);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}

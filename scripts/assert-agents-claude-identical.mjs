#!/usr/bin/env node
/**
 * Verifies that every tracked agent guide is paired and byte-identical.
 *
 * The repository convention is to author `CLAUDE.md` and copy it to
 * `AGENTS.md` in the same directory. This guard walks tracked files only, so
 * generated build output and local worktree clutter cannot affect the result.
 * It fails when a directory has only one of the two files or when a pair differs
 * byte-for-byte.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 30 });
}

function guideFiles() {
  return git([
    "ls-files",
    "-z",
    "AGENTS.md",
    "CLAUDE.md",
    "**/AGENTS.md",
    "**/CLAUDE.md",
  ])
    .split("\0")
    .filter(Boolean);
}

function directoryFor(file) {
  const dir = dirname(file);
  return dir === "." ? "." : dir;
}

function main() {
  const byDirectory = new Map();

  for (const file of guideFiles()) {
    const directory = directoryFor(file);
    const entry = byDirectory.get(directory) ?? {};

    if (file.endsWith("AGENTS.md")) entry.agents = file;
    if (file.endsWith("CLAUDE.md")) entry.claude = file;

    byDirectory.set(directory, entry);
  }

  const failures = [];
  let pairs = 0;

  for (const [directory, entry] of [...byDirectory.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (!entry.agents || !entry.claude) {
      failures.push(
        `${directory}: expected both CLAUDE.md and AGENTS.md, found ${
          entry.claude ? "CLAUDE.md only" : "AGENTS.md only"
        }`,
      );
      continue;
    }

    pairs += 1;
    const agents = readFileSync(entry.agents);
    const claude = readFileSync(entry.claude);

    if (!agents.equals(claude)) {
      failures.push(
        `${directory}: CLAUDE.md and AGENTS.md differ; author CLAUDE.md, then copy it to AGENTS.md`,
      );
    }
  }

  if (failures.length > 0) {
    console.error("[assert-agents-claude-identical] FAIL");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log(
    `[assert-agents-claude-identical] PASS: ${pairs} tracked CLAUDE.md/AGENTS.md pair(s) are byte-identical.`,
  );
}

main();

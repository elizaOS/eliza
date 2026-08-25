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
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 30 });
}

function gitBuffer(args) {
  return execFileSync("git", args, { maxBuffer: 1 << 30 });
}

function guideFiles() {
  return git([
    "ls-files",
    "-t",
    "--stage",
    "-z",
    "AGENTS.md",
    "CLAUDE.md",
    "**/AGENTS.md",
    "**/CLAUDE.md",
  ])
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const match = /^([A-Z?]) \d+ ([0-9a-f]+) \d+\t([\s\S]+)$/.exec(entry);
      if (!match) throw new Error(`unexpected git ls-files entry: ${entry}`);
      return {
        file: match[3],
        objectId: match[2],
        skipWorktree: match[1] === "S",
      };
    })
    .filter(({ file }) => shouldCheckGuideFile(file));
}

export function shouldCheckGuideFile(file) {
  const parts = file.replace(/\\/g, "/").split("/");
  return !(
    parts.includes("fixtures") ||
    parts.includes("__tests__") ||
    parts.includes(".archived")
  );
}

function directoryFor(file) {
  const dir = dirname(file);
  return dir === "." ? "." : dir;
}

function readGuide(entry) {
  if (existsSync(entry.file)) return readFileSync(entry.file);
  if (entry.skipWorktree) return gitBuffer(["show", `:${entry.file}`]);
  return null;
}

function guidesEqual(left, right) {
  const leftExists = existsSync(left.file);
  const rightExists = existsSync(right.file);

  if (!leftExists && left.skipWorktree && !rightExists && right.skipWorktree) {
    return left.objectId === right.objectId;
  }

  const leftBytes = readGuide(left);
  const rightBytes = readGuide(right);
  return leftBytes && rightBytes ? leftBytes.equals(rightBytes) : null;
}

function main() {
  const byDirectory = new Map();

  for (const guideEntry of guideFiles()) {
    const { file } = guideEntry;
    const directory = directoryFor(file);
    const entry = byDirectory.get(directory) ?? {};

    if (file.endsWith("AGENTS.md")) entry.agents = guideEntry;
    if (file.endsWith("CLAUDE.md")) entry.claude = guideEntry;

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
    const equal = guidesEqual(entry.agents, entry.claude);

    if (equal === null) {
      const missing = [
        !existsSync(entry.agents.file) && !entry.agents.skipWorktree
          ? entry.agents.file
          : null,
        !existsSync(entry.claude.file) && !entry.claude.skipWorktree
          ? entry.claude.file
          : null,
      ].filter(Boolean);
      failures.push(
        `${directory}: tracked guide missing from working tree: ${missing.join(", ")}`,
      );
      continue;
    }

    if (!equal) {
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

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

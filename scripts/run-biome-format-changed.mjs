import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const FILE_PATTERN = /\.(?:[cm]?js|[cm]?ts|jsx|tsx|json|jsonc|css|md|mdx)$/i;
const CHUNK_SIZE = process.platform === "win32" ? 40 : 200;
const EXCLUDED_PREFIXES = [];

function readLines(command, args) {
  const output = execFileSync(command, args, { encoding: "utf8" });
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function getChangedFiles() {
  const unstaged = readLines("git", [
    "diff",
    "--name-only",
    "--diff-filter=ACMR",
  ]);
  const staged = readLines("git", [
    "diff",
    "--cached",
    "--name-only",
    "--diff-filter=ACMR",
  ]);
  const untracked = readLines("git", [
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);

  return [...new Set([...unstaged, ...staged, ...untracked])]
    .filter((file) => FILE_PATTERN.test(file))
    .filter(
      (file) => !EXCLUDED_PREFIXES.some((prefix) => file.startsWith(prefix)),
    )
    .filter((file) => existsSync(file));
}

function chunk(items, size) {
  const groups = [];
  for (let index = 0; index < items.length; index += size) {
    groups.push(items.slice(index, index + size));
  }
  return groups;
}

const files = getChangedFiles();
if (files.length === 0) {
  console.log("[format-changed] No changed files match Biome patterns.");
  process.exit(0);
}

const extraArgs = process.argv.slice(2);
for (const group of chunk(files, CHUNK_SIZE)) {
  const result = spawnSync(
    "bunx",
    ["@biomejs/biome", "format", ...extraArgs, ...group],
    {
      encoding: "utf8",
      shell: process.platform === "win32",
    },
  );

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

process.exit(0);

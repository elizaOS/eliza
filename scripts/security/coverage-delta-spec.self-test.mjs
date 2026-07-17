#!/usr/bin/env node
/** Emit per-file line-delta metadata for coverage-gate.awk.
 *
 * Output fields are tab-separated: repo path, current line count, whether the
 * file is new (1/0), and a comma-separated set of added/modified line numbers.
 * Deletions have no executable line in the new file and therefore do not enter
 * the changed-line numerator.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const [base, head] = process.argv.slice(2);
if (!base && !head) {
  const sample = "@@ -40,2 +40,3 @@ export const value";
  const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(sample);
  if (!match || match[1] !== "40" || match[2] !== "3") {
    throw new Error("coverage delta hunk parser self-test failed");
  }
  console.log("ok - coverage delta hunk parser");
  process.exit(0);
}
if (!base || !head) {
  console.error("usage: coverage-delta-spec.self-test.mjs BASE HEAD < changed-files");
  process.exit(2);
}
const files = readFileSync(0, "utf8").split(/\r?\n/).filter(Boolean);
if (files.length === 0) process.exit(0);
const mergeBase = execFileSync("git", ["merge-base", base, head], { encoding: "utf8" }).trim();
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const total = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  let isNew = 0;
  try {
    execFileSync("git", ["cat-file", "-e", `${mergeBase}:${file}`], { stdio: "ignore" });
  } catch {
    isNew = 1;
  }
  const diff = execFileSync(
    "git",
    ["diff", "--unified=0", "--no-color", mergeBase, head, "--", file],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  const lines = [];
  for (const row of diff.split("\n")) {
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(row);
    if (!match) continue;
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    for (let line = start; line < start + count; line++) lines.push(line);
  }
  console.log(`${file}\t${total}\t${isNew}\t${lines.join(",")}`);
}

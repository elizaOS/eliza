#!/usr/bin/env node

/**
 * Migrates legacy deep @elizaos/ui atom imports to supported public exports.
 * It is deterministic, defaults to a dry run, and only rewrites exact module
 * specifiers so import bindings and surrounding source remain unchanged.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../..");
const write = process.argv.includes("--write");
const rebuildFromHead = process.argv.includes("--rebuild-from-head");
const prefix = "@elizaos/ui/components/ui/";
const directExports = new Map([
  ["button", "@elizaos/ui/button"],
  ["card", "@elizaos/ui/card"],
  ["dropdown-menu", "@elizaos/ui/dropdown-menu"],
  ["input", "@elizaos/ui/input"],
]);

function* walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (
      [
        "node_modules",
        "dist",
        "build",
        ".git",
        "artifacts",
        "generated",
        "templates",
      ].includes(entry.name)
    )
      continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.[jt]sx?$/.test(entry.name)) yield full;
  }
}

export function destination(moduleName) {
  const leaf = moduleName.slice(prefix.length);
  return directExports.get(leaf) ?? "@elizaos/ui";
}

export function migrateImports(file, source) {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const replacements = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const moduleName = statement.moduleSpecifier.text;
    if (!moduleName.startsWith(prefix)) continue;
    replacements.push({
      end: statement.moduleSpecifier.getEnd() - 1,
      start: statement.moduleSpecifier.getStart() + 1,
      value: destination(moduleName),
    });
  }
  return replacements
    .sort((a, b) => b.start - a.start)
    .reduce(
      (text, replacement) =>
        `${text.slice(0, replacement.start)}${replacement.value}${text.slice(replacement.end)}`,
      source,
    );
}

function headSource(file) {
  const rel = path.relative(repoRoot, file).replaceAll(path.sep, "/");
  return execFileSync("git", ["show", `HEAD:${rel}`], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

function filesToProcess() {
  if (!rebuildFromHead) {
    return [
      ...walk(path.join(repoRoot, "packages")),
      ...walk(path.join(repoRoot, "plugins")),
    ];
  }
  const output = execFileSync(
    "git",
    ["grep", "-Il", prefix, "HEAD", "--", "packages", "plugins"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  return output
    .split("\n")
    .filter(Boolean)
    .map((entry) => entry.replace(/^HEAD:/, ""))
    .filter(
      (entry) =>
        /\.[jt]sx?$/.test(entry) &&
        !/(^|\/)(artifacts|generated|templates)(\/|$)/.test(entry),
    )
    .map((entry) => path.join(repoRoot, entry));
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const changed = [];
  for (const file of filesToProcess()) {
    const current = fs.readFileSync(file, "utf8");
    const source = rebuildFromHead ? headSource(file) : current;
    const next = migrateImports(file, source);
    if (next === current) continue;
    changed.push(path.relative(repoRoot, file).replaceAll(path.sep, "/"));
    if (write) fs.writeFileSync(file, next);
  }

  process.stdout.write(
    `${write ? "Migrated" : "Would migrate"} ${changed.length} files${rebuildFromHead ? " from HEAD" : ""}\n${changed.join("\n")}\n`,
  );
}

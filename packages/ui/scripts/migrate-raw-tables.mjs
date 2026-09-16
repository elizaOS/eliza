#!/usr/bin/env node

/**
 * Migrates native table markup to the canonical table family without changing
 * attributes or children. The command is deterministic and dry-run by default.
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
const tagNames = new Map([
  ["table", "Table"],
  ["thead", "TableHeader"],
  ["tbody", "TableBody"],
  ["tfoot", "TableFooter"],
  ["tr", "TableRow"],
  ["th", "TableHead"],
  ["td", "TableCell"],
  ["caption", "TableCaption"],
]);

function* walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (
      ["node_modules", "dist", "build", ".git", "generated"].includes(
        entry.name,
      )
    )
      continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (
      /\.tsx$/.test(entry.name) &&
      !/\.(?:test|spec)\.tsx$/.test(entry.name) &&
      !full.startsWith(path.join(repoRoot, "packages/ui/src/components/ui"))
    )
      yield full;
  }
}

function importOrigin(file) {
  if (file.startsWith(path.join(repoRoot, "plugins"))) return "@elizaos/ui";
  const target = path.join(repoRoot, "packages/ui/src/components/ui/table");
  const origin = path
    .relative(path.dirname(file), target)
    .replaceAll(path.sep, "/");
  return origin.startsWith(".") ? origin : `./${origin}`;
}

export function migrateTableMarkup(source, origin) {
  const sourceFile = ts.createSourceFile(
    "migration.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const used = new Set();
  const replacements = [];
  function visit(node) {
    if (
      (ts.isJsxOpeningElement(node) ||
        ts.isJsxClosingElement(node) ||
        ts.isJsxSelfClosingElement(node)) &&
      ts.isIdentifier(node.tagName)
    ) {
      const canonicalName = tagNames.get(node.tagName.text);
      if (canonicalName) {
        used.add(canonicalName);
        replacements.push({
          end: node.tagName.getEnd(),
          start: node.tagName.getStart(sourceFile),
          value: canonicalName,
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  if (used.size === 0) return source;

  const imports = sourceFile.statements.filter(ts.isImportDeclaration);
  if (imports.length === 0)
    throw new Error("Table migration requires an import declaration");
  const insertion = imports.at(-1).getEnd();
  replacements.push({
    end: insertion,
    start: insertion,
    value: `\nimport { ${[...used].sort().join(", ")} } from "${origin}";`,
  });
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
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const changed = [];
  for (const root of ["packages/ui/src", "plugins"]) {
    for (const file of walk(path.join(repoRoot, root))) {
      const source = rebuildFromHead
        ? headSource(file)
        : fs.readFileSync(file, "utf8");
      const current = fs.readFileSync(file, "utf8");
      const next = migrateTableMarkup(source, importOrigin(file));
      if (next === current) continue;
      changed.push(path.relative(repoRoot, file).replaceAll(path.sep, "/"));
      if (write) fs.writeFileSync(file, next);
    }
  }
  process.stdout.write(
    `${write ? "Migrated" : "Would migrate"} ${changed.length} files${rebuildFromHead ? " from HEAD" : ""}\n${changed.join("\n")}\n`,
  );
}

#!/usr/bin/env node

/**
 * Migrates browser controls to canonical atoms while preserving their props and
 * children. Checkbox inputs are deliberately excluded because their event
 * contract requires a reviewed adapter migration.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../..");
const write = process.argv.includes("--write");
const tagNames = new Map([
  ["button", ["Button", "button"]],
  ["input", ["Input", "input"]],
  ["textarea", ["Textarea", "textarea"]],
  ["select", ["NativeSelect", "native-select"]],
]);

function* walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (
      ["__tests__", "__e2e__", "dist", "generated", "test"].includes(entry.name)
    )
      continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (
      entry.name.endsWith(".tsx") &&
      !/\.(?:test|spec)\.tsx$/.test(entry.name)
    )
      yield full;
  }
}

function importOrigin(file, leaf) {
  const target = path.join(repoRoot, `packages/ui/src/components/ui/${leaf}`);
  const relative = path
    .relative(path.dirname(file), target)
    .replaceAll(path.sep, "/");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

export function migrateRawControls(file, source) {
  if (file.includes("/components/ui/")) return source;
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const replacements = [];
  const used = new Map();
  const bound = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    for (const element of statement.importClause?.namedBindings &&
    ts.isNamedImports(statement.importClause.namedBindings)
      ? statement.importClause.namedBindings.elements
      : [])
      bound.add(element.name.text);
  }
  function visit(node) {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      ts.isIdentifier(node.tagName)
    ) {
      const mapping = tagNames.get(node.tagName.text);
      if (mapping) {
        const [canonical, leaf] = mapping;
        const checkbox =
          node.tagName.text === "input" &&
          node.attributes.properties.some(
            (attribute) =>
              ts.isJsxAttribute(attribute) &&
              attribute.name.text === "type" &&
              attribute.initializer &&
              ts.isStringLiteral(attribute.initializer) &&
              attribute.initializer.text === "checkbox",
          );
        if (!checkbox) {
          used.set(canonical, leaf);
          replacements.push({
            start: node.tagName.getStart(sourceFile),
            end: node.tagName.getEnd(),
            value: canonical,
          });
        }
      }
    } else if (ts.isJsxClosingElement(node) && ts.isIdentifier(node.tagName)) {
      const mapping = tagNames.get(node.tagName.text);
      if (mapping)
        replacements.push({
          start: node.tagName.getStart(sourceFile),
          end: node.tagName.getEnd(),
          value: mapping[0],
        });
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  if (replacements.length === 0) return source;
  const imports = sourceFile.statements.filter(ts.isImportDeclaration);
  const insertion = imports.at(-1)?.getEnd();
  if (!insertion)
    throw new Error(`Control migration requires imports: ${file}`);
  for (const [name, leaf] of used) {
    if (!bound.has(name))
      replacements.push({
        start: insertion,
        end: insertion,
        value: `\nimport { ${name} } from "${importOrigin(file, leaf)}";`,
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

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const changed = [];
  for (const file of walk(path.join(repoRoot, "packages/ui/src"))) {
    const source = fs.readFileSync(file, "utf8");
    const next = migrateRawControls(file, source);
    if (next === source) continue;
    changed.push(path.relative(repoRoot, file).replaceAll(path.sep, "/"));
    if (write) fs.writeFileSync(file, next);
  }
  process.stdout.write(
    `${write ? "Migrated" : "Would migrate"} ${changed.length} files\n${changed.join("\n")}\n`,
  );
}

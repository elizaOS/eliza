/**
 * Alpha (eliza-research/alphaphone) pins this repository as a submodule and
 * imports, spawns, reads or copies the files listed in
 * packages/scripts/alphaphone-imports.manifest.json by path. A listed path must
 * exist, and every listed export must still be exported by that module.
 */
import { expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const repoRoot = path.resolve(import.meta.dir, "../../..");
const manifest: { modules: Record<string, string[]> } = JSON.parse(
  readFileSync(
    path.join(repoRoot, "packages/scripts/alphaphone-imports.manifest.json"),
    "utf8",
  ),
);

const MODULE_SUFFIXES = ["", ".ts", ".tsx", ".mts", ".mjs", ".js", "/index.ts"];

/** Resolves a workspace package specifier to its `eliza-source` entry. */
function resolvePackage(from: string, specifier: string): string {
  const parts = specifier.split("/");
  const name = parts.slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
  const subpath = ["."].concat(parts.slice(name.split("/").length)).join("/");
  for (let dir = path.dirname(from); ; dir = path.dirname(dir)) {
    const root = path.join(dir, "node_modules", name);
    if (existsSync(path.join(root, "package.json"))) {
      const { exports } = JSON.parse(
        readFileSync(path.join(root, "package.json"), "utf8"),
      );
      const entry = exports?.[subpath];
      const target =
        typeof entry === "string" ? entry : entry?.["eliza-source"];
      if (typeof target !== "string") break;
      return path.join(root, target);
    }
    if (dir === repoRoot || dir === path.dirname(dir)) break;
  }
  throw new Error(
    `${path.relative(repoRoot, from)}: cannot resolve ${specifier}`,
  );
}

function resolveModule(from: string, specifier: string): string {
  if (!specifier.startsWith(".")) return resolvePackage(from, specifier);
  const base = path.resolve(path.dirname(from), specifier);
  for (const suffix of MODULE_SUFFIXES) {
    const candidate = base + suffix;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  throw new Error(
    `${path.relative(repoRoot, from)}: cannot resolve ${specifier}`,
  );
}

function modifierKinds(node: ts.Node): ts.SyntaxKind[] {
  if (!ts.canHaveModifiers(node)) return [];
  return (ts.getModifiers(node) ?? []).map((modifier) => modifier.kind);
}

function bindingNames(name: ts.BindingName, names: Set<string>): void {
  if (ts.isIdentifier(name)) names.add(name.text);
  else
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) bindingNames(element.name, names);
    }
}

const exportsByFile = new Map<string, Set<string>>();

/** Names a module exports, following `export * from` into other modules. */
function moduleExports(file: string, seen = new Set<string>()): Set<string> {
  const cached = exportsByFile.get(file);
  if (cached) return cached;
  const names = new Set<string>();
  if (seen.has(file)) return names;
  seen.add(file);
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    false,
  );
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (clause && ts.isNamedExports(clause)) {
        for (const element of clause.elements) names.add(element.name.text);
      } else if (clause && ts.isNamespaceExport(clause)) {
        names.add(clause.name.text);
      } else if (
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        const target = resolveModule(file, statement.moduleSpecifier.text);
        for (const name of moduleExports(target, seen)) {
          if (name !== "default") names.add(name);
        }
      }
    } else if (ts.isExportAssignment(statement)) {
      names.add("default");
    } else if (modifierKinds(statement).includes(ts.SyntaxKind.ExportKeyword)) {
      if (modifierKinds(statement).includes(ts.SyntaxKind.DefaultKeyword)) {
        names.add("default");
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          bindingNames(declaration.name, names);
        }
      } else if (
        (ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement) ||
          ts.isInterfaceDeclaration(statement) ||
          ts.isTypeAliasDeclaration(statement) ||
          ts.isEnumDeclaration(statement) ||
          ts.isModuleDeclaration(statement)) &&
        statement.name &&
        ts.isIdentifier(statement.name)
      ) {
        names.add(statement.name.text);
      }
    }
  }
  exportsByFile.set(file, names);
  return names;
}

test("manifest lists repository paths in sorted order", () => {
  const paths = Object.keys(manifest.modules);
  expect(paths.length).toBeGreaterThan(0);
  expect(paths).toEqual([...paths].sort());
  for (const relative of paths) {
    expect(
      path.isAbsolute(relative) || relative.split("/").includes(".."),
    ).toBe(false);
  }
});

test("every path Alpha uses exists", () => {
  const missing = Object.keys(manifest.modules).filter(
    (relative) => !existsSync(path.join(repoRoot, relative)),
  );
  expect(missing).toEqual([]);
});

test("every export Alpha imports is still exported", () => {
  const missing: string[] = [];
  for (const [relative, used] of Object.entries(manifest.modules)) {
    if (used.length === 0) continue;
    const file = path.join(repoRoot, relative);
    if (!existsSync(file)) continue;
    const exported = moduleExports(file);
    for (const name of used) {
      if (!exported.has(name)) missing.push(`${relative}: ${name}`);
    }
  }
  expect(missing).toEqual([]);
}, 60_000);

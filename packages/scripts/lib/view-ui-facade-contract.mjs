/**
 * Validates UI named imports reachable from authoritative plugin-view entries.
 *
 * View bundles consume the dynamic host facades while the app's source build
 * aliases the root package to browser.ts. Auditing both surfaces prevents a
 * view from building successfully and then failing when one host omits a named
 * runtime export.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { assertContainedRegularFile } from "./repository-file-integrity.mjs";
import { discoverViewBundleInventory } from "./view-bundle-inventory.mjs";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const UI_ROOT_SPECIFIER = "@elizaos/ui";
const UI_COMPONENTS_SPECIFIER = "@elizaos/ui/components";
const UI_VIEW_HEADER_SPECIFIER = "@elizaos/ui/components/shared/ViewHeader";
const UI_SPECIFIERS = new Set([
  UI_ROOT_SPECIFIER,
  UI_COMPONENTS_SPECIFIER,
  UI_VIEW_HEADER_SPECIFIER,
]);
const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../../..");
const CODE_SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/i;
const DECLARATION_EXTENSION = /\.d\.[cm]?ts$/i;
const NON_CODE_MODULE_EXTENSION =
  /\.(?:css|scss|sass|less|json|svg|png|jpe?g|gif|webp|woff2?|mp3|mp4|wasm)$/i;
const RESOLUTION_OPTIONS = {
  allowImportingTsExtensions: true,
  allowJs: true,
  jsx: ts.JsxEmit.ReactJSX,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  target: ts.ScriptTarget.ESNext,
};

function sourceScriptKind(file) {
  if (/\.tsx$/i.test(file)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(file)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/i.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function parseSource(source, file) {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    sourceScriptKind(file),
  );
  if (sourceFile.parseDiagnostics?.length > 0) {
    const diagnostic = sourceFile.parseDiagnostics[0];
    throw new Error(
      `[view-ui-facade] ${file} is not parseable TypeScript: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`,
    );
  }
  return sourceFile;
}

function staticPropertyName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  return undefined;
}

function sourceLine(sourceFile, node) {
  return (
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
  );
}

/** Collect exact root/components named imports with their emitted import kind. */
export function collectNamedUiFacadeImports(
  source,
  { file = "<view-source>", owner = "<view>" } = {},
) {
  const sourceFile = parseSource(source, file);
  const imports = [];
  const add = (node, specifier, imported, importKind) => {
    imports.push({
      owner,
      source: file,
      line: sourceLine(sourceFile, node),
      specifier,
      imported,
      importKind,
    });
  };

  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteralLike(statement.moduleSpecifier) &&
      UI_SPECIFIERS.has(statement.moduleSpecifier.text)
    ) {
      const specifier = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      if (!clause) continue;
      if (clause.name) {
        add(
          clause.name,
          specifier,
          "default",
          clause.isTypeOnly ? "type" : "runtime",
        );
      }
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        throw new Error(
          `[view-ui-facade] ${file}:${sourceLine(sourceFile, bindings)} uses a namespace import from ${specifier}; use named imports so the host facade can be audited`,
        );
      }
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          add(
            element,
            specifier,
            (element.propertyName ?? element.name).text,
            clause.isTypeOnly || element.isTypeOnly ? "type" : "runtime",
          );
        }
      }
      continue;
    }

    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteralLike(statement.moduleSpecifier) &&
      UI_SPECIFIERS.has(statement.moduleSpecifier.text)
    ) {
      const specifier = statement.moduleSpecifier.text;
      const clause = statement.exportClause;
      if (!clause || ts.isNamespaceExport(clause)) {
        throw new Error(
          `[view-ui-facade] ${file}:${sourceLine(sourceFile, statement)} re-exports a namespace from ${specifier}; use named exports so the host facade can be audited`,
        );
      }
      for (const element of clause.elements) {
        add(
          element,
          specifier,
          (element.propertyName ?? element.name).text,
          statement.isTypeOnly || element.isTypeOnly ? "type" : "runtime",
        );
      }
    }
  }

  return imports;
}

function viewEntryFromConfig(target, repoRoot) {
  const source = readFileSync(target.configAbsolute, "utf8");
  const sourceFile = parseSource(source, target.configAbsolute);
  const factoryNames = new Set();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      continue;
    }
    for (const element of statement.importClause.namedBindings.elements) {
      if (
        (element.propertyName ?? element.name).text === "createViewBundleConfig"
      ) {
        factoryNames.add(element.name.text);
      }
    }
  }
  if (factoryNames.size !== 1) {
    throw new Error(
      `[view-ui-facade] ${target.config} must import createViewBundleConfig exactly once`,
    );
  }

  const entries = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      factoryNames.has(node.expression.text) &&
      node.arguments[0] &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      for (const property of node.arguments[0].properties) {
        if (
          ts.isPropertyAssignment(property) &&
          staticPropertyName(property.name) === "entry" &&
          ts.isStringLiteralLike(property.initializer)
        ) {
          entries.push(property.initializer.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (entries.length !== 1) {
    throw new Error(
      `[view-ui-facade] ${target.config} must declare one literal view entry`,
    );
  }

  const workspaceRoot = path.resolve(repoRoot, target.workspaceDir);
  const entryAbsolute = path.resolve(workspaceRoot, entries[0]);
  const entryRelativeToWorkspace = path.relative(workspaceRoot, entryAbsolute);
  if (
    entryRelativeToWorkspace === "" ||
    entryRelativeToWorkspace.startsWith("..") ||
    path.isAbsolute(entryRelativeToWorkspace)
  ) {
    throw new Error(
      `[view-ui-facade] ${target.config} view entry must stay inside ${target.workspaceDir}`,
    );
  }
  const entryRelative = path
    .relative(repoRoot, entryAbsolute)
    .split(path.sep)
    .join("/");
  return assertContainedRegularFile(
    repoRoot,
    entryRelative,
    `[view-ui-facade] ${target.name} view entry`,
  ).absolute;
}

function moduleSpecifiers(sourceFile) {
  const specifiers = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function resolveRelativeSource(specifier, containingFile, repoRoot) {
  const resolution = ts.resolveModuleName(
    specifier,
    containingFile,
    RESOLUTION_OPTIONS,
    ts.sys,
  ).resolvedModule;
  if (!resolution) {
    if (NON_CODE_MODULE_EXTENSION.test(specifier)) return undefined;
    throw new Error(
      `[view-ui-facade] ${containingFile} has an unresolved relative module ${specifier}`,
    );
  }
  const absolute = path.resolve(resolution.resolvedFileName);
  if (DECLARATION_EXTENSION.test(absolute)) return undefined;
  if (!CODE_SOURCE_EXTENSION.test(absolute)) return undefined;
  const relative = path.relative(repoRoot, absolute);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    relative.split(path.sep).includes("node_modules")
  ) {
    throw new Error(
      `[view-ui-facade] ${containingFile} resolves ${specifier} outside repository source`,
    );
  }
  return assertContainedRegularFile(
    repoRoot,
    relative.split(path.sep).join("/"),
    `[view-ui-facade] source imported by ${containingFile}`,
  ).absolute;
}

function productionViewSources(target, repoRoot) {
  const pending = [viewEntryFromConfig(target, repoRoot)];
  const sources = new Map();
  while (pending.length > 0) {
    const file = pending.pop();
    if (sources.has(file)) continue;
    const source = readFileSync(file, "utf8");
    const sourceFile = parseSource(source, file);
    sources.set(file, source);
    for (const specifier of moduleSpecifiers(sourceFile)) {
      if (!specifier.startsWith(".")) continue;
      const resolved = resolveRelativeSource(specifier, file, repoRoot);
      if (resolved && !sources.has(resolved)) pending.push(resolved);
    }
  }
  return sources;
}

function uiCompilerOptions(repoRoot) {
  const configPath = path.join(repoRoot, "packages/ui/tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) {
    throw new Error(
      `[view-ui-facade] cannot read ${configPath}: ${ts.flattenDiagnosticMessageText(config.error.messageText, "\n")}`,
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    path.dirname(configPath),
    undefined,
    configPath,
  );
  if (parsed.errors.length > 0) {
    throw new Error(
      `[view-ui-facade] invalid ${configPath}: ${ts.flattenDiagnosticMessageText(parsed.errors[0].messageText, "\n")}`,
    );
  }
  return parsed.options;
}

function resolveAliasSymbol(checker, symbol) {
  let current = symbol;
  const seen = new Set();
  while ((current.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(current)) {
    seen.add(current);
    current = checker.getAliasedSymbol(current);
  }
  return current;
}

function facadeExportMaps(repoRoot) {
  const definitions = [
    {
      id: "browser-root",
      specifier: UI_ROOT_SPECIFIER,
      file: "packages/ui/src/browser.ts",
    },
    {
      id: "dynamic-root",
      specifier: UI_ROOT_SPECIFIER,
      file: "packages/ui/src/index.ts",
    },
    {
      id: "components",
      specifier: UI_COMPONENTS_SPECIFIER,
      file: "packages/ui/src/components/index.ts",
    },
    {
      id: "view-header",
      specifier: UI_VIEW_HEADER_SPECIFIER,
      file: "packages/ui/src/components/shared/ViewHeader.tsx",
    },
  ].map((definition) => ({
    ...definition,
    absolute: assertContainedRegularFile(
      repoRoot,
      definition.file,
      `[view-ui-facade] ${definition.id}`,
    ).absolute,
  }));
  const program = ts.createProgram({
    rootNames: definitions.map(({ absolute }) => absolute),
    options: uiCompilerOptions(repoRoot),
  });
  const checker = program.getTypeChecker();

  return definitions.map((definition) => {
    const sourceFile = program.getSourceFile(definition.absolute);
    const moduleSymbol = sourceFile && checker.getSymbolAtLocation(sourceFile);
    if (!sourceFile || !moduleSymbol) {
      throw new Error(
        `[view-ui-facade] TypeScript did not load ${definition.file} as a module`,
      );
    }
    const exports = new Map();
    for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
      const resolved = resolveAliasSymbol(checker, symbol);
      exports.set(symbol.name, {
        runtime: (resolved.flags & ts.SymbolFlags.Value) !== 0,
      });
    }
    return { ...definition, exports };
  });
}

/** Compare imports with one or more concrete facade export maps. */
export function findUiFacadeImportViolations(imports, facades) {
  const violations = [];
  for (const entry of imports) {
    const matchingFacades = facades.filter(
      (facade) => facade.specifier === entry.specifier,
    );
    if (matchingFacades.length === 0) {
      throw new Error(
        `[view-ui-facade] no facade is registered for ${entry.specifier}`,
      );
    }
    for (const facade of matchingFacades) {
      const exported = facade.exports.get(entry.imported);
      if (!exported) {
        violations.push({
          ...entry,
          facade: facade.id,
          reason: "missing-export",
        });
      } else if (entry.importKind === "runtime" && !exported.runtime) {
        violations.push({
          ...entry,
          facade: facade.id,
          reason: "runtime-export-required",
        });
      }
    }
  }
  return violations.sort((left, right) =>
    [
      left.owner,
      left.source,
      left.line,
      left.specifier,
      left.imported,
      left.facade,
    ]
      .join("\0")
      .localeCompare(
        [
          right.owner,
          right.source,
          right.line,
          right.specifier,
          right.imported,
          right.facade,
        ].join("\0"),
        "en-US",
      ),
  );
}

/** Audit every source module bundled from every authoritative plugin view. */
export function auditViewUiFacadeImports(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? REPOSITORY_ROOT);
  const inventory = discoverViewBundleInventory({
    ...options,
    repoRoot,
  });
  const imports = [];
  const sourceIdentities = new Set();
  for (const target of inventory.targets) {
    for (const [file, source] of productionViewSources(target, repoRoot)) {
      const relative = path.relative(repoRoot, file).split(path.sep).join("/");
      sourceIdentities.add(`${target.name}\0${relative}`);
      imports.push(
        ...collectNamedUiFacadeImports(source, {
          file: relative,
          owner: target.name,
        }),
      );
    }
  }
  if (imports.length === 0) {
    throw new Error(
      "[view-ui-facade] authoritative view entries expose no auditable UI named imports",
    );
  }
  const facades = facadeExportMaps(repoRoot);
  return {
    targetCount: inventory.targets.length,
    sourceCount: sourceIdentities.size,
    importCount: imports.length,
    runtimeImportCount: imports.filter(
      ({ importKind }) => importKind === "runtime",
    ).length,
    typeImportCount: imports.filter(({ importKind }) => importKind === "type")
      .length,
    violations: findUiFacadeImportViolations(imports, facades),
  };
}

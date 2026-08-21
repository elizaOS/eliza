/**
 * Generates the authoritative first-party view declaration inventory.
 *
 * Runtime declarations are parsed from the built-in registry and plugin
 * manifests with the TypeScript AST. The same inventory feeds CI collision
 * checks and the review artifact, so adding a declaration cannot bypass either
 * by forgetting to update a hand-maintained list.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { execFileSync } from "./spawn-sync-captured.mjs";

const BUILTIN_SOURCE = "packages/agent/src/api/builtin-views.ts";
const PLUGIN_SOURCE = /^plugins\/[^/]+\/src\/.*\.(?:ts|tsx)$/;

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function listRepositoryFiles(repoRoot) {
  return execFileSync(
    "git",
    [
      "-C",
      repoRoot,
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      BUILTIN_SOURCE,
      "plugins",
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  )
    .split("\0")
    .filter(Boolean)
    .filter(
      (file) =>
        file === BUILTIN_SOURCE ||
        (PLUGIN_SOURCE.test(file) &&
          !file.includes("/__tests__/") &&
          !file.includes("/test/") &&
          !/\.(?:test|spec)\.[^.]+$/.test(file)),
    )
    .sort(compareText);
}

function unwrap(expression) {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function propertyName(property) {
  const name = property.name;
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

function objectProperty(object, name) {
  return object.properties.find(
    (property) =>
      ts.isPropertyAssignment(property) && propertyName(property) === name,
  );
}

function stringValue(object, name) {
  const property = objectProperty(object, name);
  if (!property || !ts.isPropertyAssignment(property)) return null;
  const value = unwrap(property.initializer);
  return ts.isStringLiteralLike(value) ? value.text : null;
}

function booleanValue(object, name) {
  const property = objectProperty(object, name);
  if (!property || !ts.isPropertyAssignment(property)) return null;
  const value = unwrap(property.initializer);
  if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
  return null;
}

function stringArrayValue(object, name) {
  const property = objectProperty(object, name);
  if (!property || !ts.isPropertyAssignment(property)) return [];
  const value = unwrap(property.initializer);
  if (!ts.isArrayLiteralExpression(value)) return [];
  return value.elements.flatMap((element) => {
    const literal = unwrap(element);
    return ts.isStringLiteralLike(literal) ? [literal.text] : [];
  });
}

function nestedObject(object, name) {
  const property = objectProperty(object, name);
  if (!property || !ts.isPropertyAssignment(property)) return null;
  const value = unwrap(property.initializer);
  return ts.isObjectLiteralExpression(value) ? value : null;
}

function capabilityIds(object) {
  const property = objectProperty(object, "capabilities");
  if (!property || !ts.isPropertyAssignment(property)) return [];
  const value = unwrap(property.initializer);
  if (!ts.isArrayLiteralExpression(value)) return [];
  return value.elements.flatMap((element) => {
    const item = unwrap(element);
    if (!ts.isObjectLiteralExpression(item)) return [];
    const id = stringValue(item, "id");
    return id ? [id] : [];
  });
}

function isPluginDeclarationObject(object) {
  if (objectProperty(object, "name") && objectProperty(object, "description")) {
    return true;
  }
  const declaration = object.parent;
  return (
    ts.isVariableDeclaration(declaration) &&
    ts.isIdentifier(declaration.name) &&
    declaration.name.text.toLocaleLowerCase("en-US").endsWith("plugin")
  );
}

function declarationArrays(sourceFile, builtin) {
  const arrays = [];
  const visit = (node) => {
    if (
      builtin &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "BUILTIN_VIEWS" &&
      node.initializer
    ) {
      const initializer = unwrap(node.initializer);
      if (ts.isArrayLiteralExpression(initializer)) arrays.push(initializer);
    }
    if (
      !builtin &&
      ts.isPropertyAssignment(node) &&
      propertyName(node) === "views" &&
      ts.isObjectLiteralExpression(node.parent) &&
      isPluginDeclarationObject(node.parent)
    ) {
      const initializer = unwrap(node.initializer);
      if (!ts.isArrayLiteralExpression(initializer)) {
        throw new Error(
          `[plugin-view-inventory] ${sourceFile.fileName} plugin views must be a literal array`,
        );
      }
      arrays.push(initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return arrays;
}

function findPluginOwner(repoRoot, source) {
  let directory = path.dirname(path.resolve(repoRoot, source));
  const pluginRoot = path.resolve(repoRoot, "plugins");
  while (directory.startsWith(`${pluginRoot}${path.sep}`)) {
    const manifest = path.join(directory, "package.json");
    try {
      const parsed = JSON.parse(readFileSync(manifest, "utf8"));
      if (typeof parsed.name === "string" && parsed.name.trim()) {
        return parsed.name;
      }
      throw new Error(
        `${path.relative(repoRoot, manifest)} has no package name`,
      );
    } catch (error) {
      if (error && typeof error === "object" && "code" in error) {
        if (error.code === "ENOENT") {
          directory = path.dirname(directory);
          continue;
        }
      }
      throw error;
    }
  }
  throw new Error(`[plugin-view-inventory] no package owner for ${source}`);
}

function parseDeclarations(repoRoot, source) {
  const absolute = path.resolve(repoRoot, source);
  const text = readFileSync(absolute, "utf8");
  const sourceFile = ts.createSourceFile(
    source,
    text,
    ts.ScriptTarget.Latest,
    true,
    source.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const builtin = source === BUILTIN_SOURCE;
  const owner = builtin
    ? "@elizaos/builtin"
    : findPluginOwner(repoRoot, source);
  const entries = [];
  for (const array of declarationArrays(sourceFile, builtin)) {
    for (const element of array.elements) {
      const object = unwrap(element);
      if (!ts.isObjectLiteralExpression(object)) {
        throw new Error(
          `[plugin-view-inventory] ${source} view entries must be object literals`,
        );
      }
      const componentExport = stringValue(object, "componentExport");
      const bundlePath = stringValue(object, "bundlePath");
      const framePath = stringValue(object, "framePath");
      const id = stringValue(object, "id");
      const label = stringValue(object, "label");
      const route = stringValue(object, "path");
      if (!id || !label) {
        const line =
          sourceFile.getLineAndCharacterOfPosition(object.getStart()).line + 1;
        throw new Error(
          `[plugin-view-inventory] ${source}:${line} view declarations require literal id and label`,
        );
      }
      if (!builtin && (!route || !componentExport || !bundlePath)) {
        throw new Error(
          `[plugin-view-inventory] ${source}:${id} requires literal path, componentExport, and bundlePath`,
        );
      }
      const roleGate = nestedObject(object, "roleGate");
      const surface = nestedObject(object, "surface");
      const modalities = stringArrayValue(object, "modalities");
      entries.push({
        id,
        label,
        owner,
        source,
        route,
        modalities:
          modalities.length > 0
            ? modalities
            : [stringValue(object, "viewType") ?? "gui"],
        viewKind: stringValue(object, "viewKind"),
        componentExport,
        bundlePath,
        framePath,
        relatedActions: stringArrayValue(object, "relatedActions"),
        operationIds: capabilityIds(object),
        minRole: roleGate ? stringValue(roleGate, "minRole") : null,
        surfaceCapabilities: surface
          ? stringArrayValue(surface, "capabilities")
          : [],
        developerOnly: booleanValue(object, "developerOnly") ?? false,
        builtin,
      });
    }
  }
  return entries;
}

function assertNoCollisions(entries) {
  for (const [field, selectValue] of [
    ["id", (entry) => entry.id],
    ["route", (entry) => entry.route],
  ]) {
    const seen = new Map();
    for (const entry of entries) {
      const value = selectValue(entry);
      if (!value) continue;
      for (const modality of entry.modalities) {
        const key = `${modality}:${value.toLocaleLowerCase("en-US")}`;
        const previous = seen.get(key);
        if (previous) {
          throw new Error(
            `[plugin-view-inventory] duplicate ${field} "${value}" (${modality}): ${previous.owner} ${previous.source} and ${entry.owner} ${entry.source}`,
          );
        }
        seen.set(key, entry);
      }
    }
  }
}

export function discoverPluginViewInventory({
  repoRoot,
  repositoryFiles = listRepositoryFiles(repoRoot),
}) {
  const entries = repositoryFiles
    .filter((file) => file === BUILTIN_SOURCE || PLUGIN_SOURCE.test(file))
    .flatMap((source) => parseDeclarations(repoRoot, source))
    .sort(
      (left, right) =>
        compareText(left.owner, right.owner) ||
        compareText(left.id, right.id) ||
        compareText(left.source, right.source),
    );
  if (entries.length === 0) {
    throw new Error(
      "[plugin-view-inventory] discovered zero view declarations",
    );
  }
  assertNoCollisions(entries);
  return entries;
}

export function serializePluginViewInventory(entries) {
  return {
    schemaVersion: 1,
    source: "runtime-view-declarations",
    discoveredCount: entries.length,
    builtinCount: entries.filter((entry) => entry.builtin).length,
    pluginCount: entries.filter((entry) => !entry.builtin).length,
    views: entries,
  };
}

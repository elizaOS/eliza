/**
 * Derives the authoritative first-party runtime-view inventory from source.
 *
 * The built-in registry and typed Plugin manifests are parsed with the
 * TypeScript AST. The resulting provenance-backed inventory is shared by the
 * collision gate and its JSON/Markdown review artifacts, so a newly declared
 * view cannot be omitted by forgetting to update a second roster.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { execFileSync } from "./spawn-sync-captured.mjs";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const BUILTIN_SOURCE = "packages/agent/src/api/builtin-views.ts";
const PLUGIN_SOURCE = /^plugins\/[^/]+\/src\/.*\.(?:ts|tsx)$/;
const VIEW_MODALITIES = new Set(["gui", "tui", "xr"]);

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function repositoryFiles(repoRoot) {
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
    .filter((file) => existsSync(path.resolve(repoRoot, file)))
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
  if (!("name" in property) || !property.name) return null;
  const name = property.name;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  if (
    ts.isComputedPropertyName(name) &&
    ts.isStringLiteralLike(name.expression)
  ) {
    return name.expression.text;
  }
  return null;
}

function objectProperty(object, name) {
  return object.properties.find(
    (property) =>
      ts.isPropertyAssignment(property) && propertyName(property) === name,
  );
}

function sourceLine(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
}

function parseSourceContext(repoRoot, source, cache) {
  const normalized = source.split(path.sep).join("/");
  const cached = cache.get(normalized);
  if (cached) return cached;
  const absolute = path.resolve(repoRoot, normalized);
  const text = readFileSync(absolute, "utf8");
  const sourceFile = ts.createSourceFile(
    normalized,
    text,
    ts.ScriptTarget.Latest,
    true,
    normalized.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  if (sourceFile.parseDiagnostics.length > 0) {
    const diagnostic = sourceFile.parseDiagnostics[0];
    throw new Error(
      `[plugin-view-inventory] ${normalized} is not parseable TypeScript: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`,
    );
  }
  const context = {
    repoRoot,
    source: normalized,
    sourceFile,
    constants: new Map(),
    functions: new Map(),
    imports: new Map(),
    cache,
  };
  cache.set(normalized, context);
  for (const statement of sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name &&
      statement.body
    ) {
      context.functions.set(statement.name.text, statement);
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          context.constants.set(declaration.name.text, declaration.initializer);
        }
      }
      continue;
    }
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      for (const element of bindings.elements) {
        context.imports.set(element.name.text, {
          importedName: element.propertyName?.text ?? element.name.text,
          specifier: statement.moduleSpecifier.text,
        });
      }
    }
  }
  return context;
}

function resolveRelativeImport(context, specifier) {
  if (!specifier.startsWith(".")) return null;
  const sourceDirectory = path.posix.dirname(context.source);
  const unresolved = path.posix.normalize(
    path.posix.join(sourceDirectory, specifier),
  );
  const withoutRuntimeExtension = unresolved.replace(/\.(?:js|mjs|cjs)$/, "");
  const candidates = [
    unresolved,
    `${withoutRuntimeExtension}.ts`,
    `${withoutRuntimeExtension}.tsx`,
    `${withoutRuntimeExtension}.mts`,
    `${withoutRuntimeExtension}.cts`,
    `${withoutRuntimeExtension}/index.ts`,
    `${withoutRuntimeExtension}/index.tsx`,
  ];
  return (
    candidates.find((candidate) =>
      existsSync(path.resolve(context.repoRoot, candidate)),
    ) ?? null
  );
}

function resolveStaticExpression(expression, context, resolving = new Set()) {
  const value = unwrap(expression);
  if (
    ts.isCallExpression(value) &&
    value.arguments.length === 0 &&
    ts.isIdentifier(value.expression)
  ) {
    const declaration = context.functions.get(value.expression.text);
    const statements = declaration?.body?.statements;
    const returns = statements?.filter((statement) =>
      ts.isReturnStatement(statement),
    );
    const returned =
      returns?.length === 1 && returns[0].expression
        ? unwrap(returns[0].expression)
        : null;
    const returnsViewComposition =
      returned &&
      ts.isObjectLiteralExpression(returned) &&
      returned.properties.some(
        (property) =>
          ts.isSpreadAssignment(property) || propertyName(property) === "views",
      );
    const hasExecutableStatement = statements?.some(
      (statement) =>
        statement !== returns?.[0] &&
        (returnsViewComposition || !ts.isVariableStatement(statement)),
    );
    if (
      returned &&
      ts.isObjectLiteralExpression(returned) &&
      !hasExecutableStatement
    ) {
      const key = `${context.source}:function:${value.expression.text}`;
      if (resolving.has(key)) {
        throw new Error(`[plugin-view-inventory] cyclic static value ${key}`);
      }
      return { value: returned, context };
    }
  }
  if (!ts.isIdentifier(value)) return { value, context };
  const key = `${context.source}:${value.text}`;
  if (resolving.has(key)) {
    throw new Error(`[plugin-view-inventory] cyclic static value ${key}`);
  }
  const nextResolving = new Set(resolving).add(key);
  const local = context.constants.get(value.text);
  if (local) return resolveStaticExpression(local, context, nextResolving);
  const imported = context.imports.get(value.text);
  const importedSource = imported
    ? resolveRelativeImport(context, imported.specifier)
    : null;
  if (imported && importedSource) {
    const importedContext = parseSourceContext(
      context.repoRoot,
      importedSource,
      context.cache,
    );
    const importedValue = importedContext.constants.get(imported.importedName);
    if (importedValue) {
      return resolveStaticExpression(
        importedValue,
        importedContext,
        nextResolving,
      );
    }
  }
  return { value, context };
}

function literalString(object, name, context, { required = false } = {}) {
  const property = objectProperty(object, name);
  if (!property) {
    if (required) {
      throw new Error(
        `[plugin-view-inventory] ${context.source}:${sourceLine(context.sourceFile, object)} requires literal ${name}`,
      );
    }
    return null;
  }
  const resolved = resolveStaticExpression(property.initializer, context);
  if (!ts.isStringLiteralLike(resolved.value)) {
    throw new Error(
      `[plugin-view-inventory] ${context.source}:${sourceLine(context.sourceFile, property)} ${name} must resolve to a string literal`,
    );
  }
  return resolved.value.text;
}

function literalBoolean(object, name, context) {
  const property = objectProperty(object, name);
  if (!property) return null;
  const resolved = resolveStaticExpression(property.initializer, context).value;
  if (resolved.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (resolved.kind === ts.SyntaxKind.FalseKeyword) return false;
  throw new Error(
    `[plugin-view-inventory] ${context.source}:${sourceLine(context.sourceFile, property)} ${name} must resolve to a boolean literal`,
  );
}

function resolvedArray(expression, context, label) {
  const resolved = resolveStaticExpression(expression, context);
  if (!ts.isArrayLiteralExpression(resolved.value)) {
    throw new Error(
      `[plugin-view-inventory] ${context.source}:${sourceLine(context.sourceFile, expression)} ${label} must resolve to an array literal`,
    );
  }
  return resolved;
}

function literalStringArray(object, name, context) {
  const property = objectProperty(object, name);
  if (!property) return null;
  const resolved = resolvedArray(property.initializer, context, name);
  const values = [];
  for (const element of resolved.value.elements) {
    if (ts.isSpreadElement(element)) {
      const spread = resolvedArray(element.expression, resolved.context, name);
      for (const spreadElement of spread.value.elements) {
        const spreadValue = resolveStaticExpression(
          spreadElement,
          spread.context,
        ).value;
        if (!ts.isStringLiteralLike(spreadValue)) {
          throw new Error(
            `[plugin-view-inventory] ${resolved.context.source}:${sourceLine(resolved.context.sourceFile, spreadElement)} ${name} contains a non-string value`,
          );
        }
        values.push(spreadValue.text);
      }
      continue;
    }
    const item = resolveStaticExpression(element, resolved.context).value;
    if (!ts.isStringLiteralLike(item)) {
      throw new Error(
        `[plugin-view-inventory] ${resolved.context.source}:${sourceLine(resolved.context.sourceFile, element)} ${name} contains a non-string value`,
      );
    }
    values.push(item.text);
  }
  return values;
}

function literalObject(object, name, context) {
  const property = objectProperty(object, name);
  if (!property) return null;
  const resolved = resolveStaticExpression(property.initializer, context);
  if (!ts.isObjectLiteralExpression(resolved.value)) {
    throw new Error(
      `[plugin-view-inventory] ${context.source}:${sourceLine(context.sourceFile, property)} ${name} must resolve to an object literal`,
    );
  }
  return { object: resolved.value, context: resolved.context };
}

function capabilityIds(object, context) {
  const property = objectProperty(object, "capabilities");
  if (!property) return [];
  const resolved = resolvedArray(property.initializer, context, "capabilities");
  const ids = [];
  for (const element of resolved.value.elements) {
    if (ts.isSpreadElement(element)) {
      throw new Error(
        `[plugin-view-inventory] ${resolved.context.source}:${sourceLine(resolved.context.sourceFile, element)} capabilities may not use a spread`,
      );
    }
    const item = resolveStaticExpression(element, resolved.context);
    if (!ts.isObjectLiteralExpression(item.value)) {
      throw new Error(
        `[plugin-view-inventory] ${item.context.source}:${sourceLine(item.context.sourceFile, item.value)} capability must resolve to an object literal`,
      );
    }
    ids.push(literalString(item.value, "id", item.context, { required: true }));
  }
  return ids;
}

function isPluginType(type) {
  return /(?:^|\W)Plugin(?:<.*>)?(?:$|\W)/.test(type?.getText() ?? "");
}

function hasPluginAssertion(expression) {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    if (
      (ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) &&
      isPluginType(current.type)
    ) {
      return true;
    }
    current = current.expression;
  }
  return false;
}

function effectiveObjectPropertyNames(object, context, resolving = new Set()) {
  const key = `${context.source}:${object.pos}`;
  if (resolving.has(key)) return null;
  const nextResolving = new Set(resolving).add(key);
  const names = new Set();
  for (const member of object.properties) {
    if (ts.isSpreadAssignment(member)) {
      const spread = resolveStaticExpression(member.expression, context);
      if (!ts.isObjectLiteralExpression(spread.value)) return null;
      const spreadNames = effectiveObjectPropertyNames(
        spread.value,
        spread.context,
        nextResolving,
      );
      if (!spreadNames) return null;
      for (const name of spreadNames) names.add(name);
      continue;
    }
    const name = propertyName(member);
    if (name) names.add(name);
  }
  return names;
}

function hasPluginShape(object, context) {
  const names = effectiveObjectPropertyNames(object, context);
  return (
    names?.has("name") === true &&
    names.has("description") &&
    names.has("views")
  );
}

function hasExportModifier(statement) {
  return (
    statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    ) ?? false
  );
}

function enumeratePluginRoots(context) {
  const bindings = new Map();
  const exportedBindings = new Set();
  const assertedExports = new Set();
  const inlineExports = [];

  for (const statement of context.sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
          continue;
        }
        bindings.set(declaration.name.text, declaration);
        if (hasExportModifier(statement)) {
          exportedBindings.add(declaration.name.text);
        }
      }
      continue;
    }
    if (
      ts.isExportDeclaration(statement) &&
      !statement.moduleSpecifier &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        exportedBindings.add(element.propertyName?.text ?? element.name.text);
      }
      continue;
    }
    if (!ts.isExportAssignment(statement) || statement.isExportEquals) {
      continue;
    }
    const expression = unwrap(statement.expression);
    if (ts.isIdentifier(expression)) {
      exportedBindings.add(expression.text);
      if (hasPluginAssertion(statement.expression)) {
        assertedExports.add(expression.text);
      }
    } else {
      inlineExports.push({
        expression: statement.expression,
        node: statement,
        label: "default export",
        explicit: hasPluginAssertion(statement.expression),
      });
    }
  }

  const roots = [];
  const seen = new Set();
  for (const name of exportedBindings) {
    const declaration = bindings.get(name);
    if (!declaration) continue;
    const explicit =
      isPluginType(declaration.type) ||
      hasPluginAssertion(declaration.initializer) ||
      assertedExports.has(name) ||
      /plugin$/i.test(name);
    const resolved = resolveStaticExpression(declaration.initializer, context);
    if (!ts.isObjectLiteralExpression(resolved.value)) {
      if (explicit) {
        throw new Error(
          `[plugin-view-inventory] ${context.source}:${sourceLine(context.sourceFile, declaration)} exported Plugin ${name} must resolve statically to an object literal`,
        );
      }
      continue;
    }
    if (!explicit && !hasPluginShape(resolved.value, resolved.context)) {
      continue;
    }
    const key = `${resolved.context.source}:${resolved.value.pos}`;
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push({
      object: resolved.value,
      context: resolved.context,
      node: declaration,
      label: name,
    });
  }

  for (const entry of inlineExports) {
    const resolved = resolveStaticExpression(entry.expression, context);
    if (!ts.isObjectLiteralExpression(resolved.value)) {
      if (entry.explicit) {
        throw new Error(
          `[plugin-view-inventory] ${context.source}:${sourceLine(context.sourceFile, entry.node)} exported Plugin ${entry.label} must resolve statically to an object literal`,
        );
      }
      continue;
    }
    if (!entry.explicit && !hasPluginShape(resolved.value, resolved.context)) {
      continue;
    }
    roots.push({
      object: resolved.value,
      context: resolved.context,
      node: entry.node,
      label: entry.label,
    });
  }
  return roots;
}

function resolvePluginViews(object, context, resolving = new Set()) {
  const key = `${context.source}:${object.pos}`;
  if (resolving.has(key)) {
    throw new Error(`[plugin-view-inventory] cyclic plugin composition ${key}`);
  }
  const nextResolving = new Set(resolving).add(key);
  let result = { kind: "absent" };

  for (const member of object.properties) {
    const name = propertyName(member);
    if (name === "views") {
      if (ts.isPropertyAssignment(member)) {
        result = {
          kind: "resolved",
          expression: member.initializer,
          context,
          node: member,
        };
        continue;
      }
      if (ts.isShorthandPropertyAssignment(member)) {
        result = {
          kind: "resolved",
          expression: member.name,
          context,
          node: member,
        };
        continue;
      }
      throw new Error(
        `[plugin-view-inventory] ${context.source}:${sourceLine(context.sourceFile, member)} Plugin.views must be a static property or shorthand declaration`,
      );
    }

    if (!ts.isSpreadAssignment(member)) continue;
    const spread = resolveStaticExpression(member.expression, context);
    if (!ts.isObjectLiteralExpression(spread.value)) {
      result = {
        kind: "unsupported",
        context,
        node: member,
      };
      continue;
    }
    const spreadViews = resolvePluginViews(
      spread.value,
      spread.context,
      nextResolving,
    );
    if (spreadViews.kind !== "absent") result = spreadViews;
  }

  return result;
}

function pluginOwner(repoRoot, source) {
  let directory = path.dirname(path.resolve(repoRoot, source));
  const pluginRoot = path.resolve(repoRoot, "plugins");
  while (directory.startsWith(`${pluginRoot}${path.sep}`)) {
    const manifest = path.join(directory, "package.json");
    if (existsSync(manifest)) {
      const parsed = JSON.parse(readFileSync(manifest, "utf8"));
      if (typeof parsed.name !== "string" || parsed.name.trim() === "") {
        throw new Error(
          `[plugin-view-inventory] ${path.relative(repoRoot, manifest)} has no package name`,
        );
      }
      return parsed.name;
    }
    directory = path.dirname(directory);
  }
  throw new Error(`[plugin-view-inventory] no package owner for ${source}`);
}

function parseView(object, context, owner, builtin) {
  const id = literalString(object, "id", context, { required: true });
  const label = literalString(object, "label", context, { required: true });
  const route = literalString(object, "path", context);
  const declaredModalities = literalStringArray(object, "modalities", context);
  const viewType = literalString(object, "viewType", context);
  const modalities = declaredModalities ?? [viewType ?? "gui"];
  if (modalities.length === 0) {
    throw new Error(
      `[plugin-view-inventory] ${context.source}:${sourceLine(context.sourceFile, object)} ${id} declares no modalities`,
    );
  }
  const duplicateModalities = modalities.filter(
    (modality, index) => modalities.indexOf(modality) !== index,
  );
  if (duplicateModalities.length > 0) {
    throw new Error(
      `[plugin-view-inventory] ${context.source}:${sourceLine(context.sourceFile, object)} ${id} repeats modality ${duplicateModalities[0]}`,
    );
  }
  for (const modality of modalities) {
    if (!VIEW_MODALITIES.has(modality)) {
      throw new Error(
        `[plugin-view-inventory] ${context.source}:${sourceLine(context.sourceFile, object)} ${id} has unsupported modality ${modality}`,
      );
    }
  }
  const componentExport = literalString(object, "componentExport", context);
  const bundlePath = literalString(object, "bundlePath", context);
  const framePath = literalString(object, "framePath", context);
  if (!builtin) {
    if (!route) {
      throw new Error(
        `[plugin-view-inventory] ${context.source}:${sourceLine(context.sourceFile, object)} ${id} requires a literal path`,
      );
    }
    if (!(framePath || (bundlePath && componentExport))) {
      throw new Error(
        `[plugin-view-inventory] ${context.source}:${sourceLine(context.sourceFile, object)} ${id} requires framePath or both bundlePath and componentExport`,
      );
    }
  }
  if (
    route &&
    (!route.startsWith("/") || route.includes("?") || route.includes("#"))
  ) {
    throw new Error(
      `[plugin-view-inventory] ${context.source}:${sourceLine(context.sourceFile, object)} ${id} has invalid route ${route}`,
    );
  }
  const roleGate = literalObject(object, "roleGate", context);
  const surface = literalObject(object, "surface", context);
  return {
    id,
    label,
    owner,
    source: context.source,
    line: sourceLine(context.sourceFile, object),
    route,
    modalities,
    viewKind: literalString(object, "viewKind", context),
    componentExport,
    bundlePath,
    framePath,
    relatedActions: literalStringArray(object, "relatedActions", context) ?? [],
    operationIds: capabilityIds(object, context),
    minRole: roleGate
      ? literalString(roleGate.object, "minRole", roleGate.context)
      : null,
    surfaceCapabilities: surface
      ? (literalStringArray(surface.object, "capabilities", surface.context) ??
        [])
      : [],
    developerOnly: literalBoolean(object, "developerOnly", context) ?? false,
    visibleInManager:
      literalBoolean(object, "visibleInManager", context) ?? false,
    builtin,
  };
}

function parseBuiltin(context) {
  let declaration = null;
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "BUILTIN_VIEWS" &&
      node.initializer
    ) {
      declaration = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(context.sourceFile);
  if (!declaration) {
    throw new Error(
      `[plugin-view-inventory] ${BUILTIN_SOURCE} does not declare BUILTIN_VIEWS`,
    );
  }
  const resolved = resolvedArray(
    declaration.initializer,
    context,
    "BUILTIN_VIEWS",
  );
  const views = resolved.value.elements.map((element) => {
    const item = resolveStaticExpression(element, resolved.context);
    if (!ts.isObjectLiteralExpression(item.value)) {
      throw new Error(
        `[plugin-view-inventory] ${context.source}:${sourceLine(context.sourceFile, element)} built-in view must resolve to an object literal`,
      );
    }
    return parseView(item.value, item.context, "@elizaos/builtin", true);
  });
  return {
    views,
    sources: [
      {
        owner: "@elizaos/builtin",
        source: context.source,
        line: sourceLine(context.sourceFile, declaration),
        kind: "builtin-registry",
        viewCount: views.length,
      },
    ],
  };
}

function parsePlugin(context, owner) {
  const views = [];
  const sources = [];
  for (const root of enumeratePluginRoots(context)) {
    const declaration = resolvePluginViews(root.object, root.context);
    if (declaration.kind === "unsupported") {
      throw new Error(
        `[plugin-view-inventory] ${declaration.context.source}:${sourceLine(declaration.context.sourceFile, declaration.node)} Plugin composition must resolve statically so views cannot evade inventory`,
      );
    }
    if (declaration.kind === "absent") continue;
    const resolved = resolvedArray(
      declaration.expression,
      declaration.context,
      "Plugin.views",
    );
    const sourceViews = resolved.value.elements.map((element) => {
      const item = resolveStaticExpression(element, resolved.context);
      if (!ts.isObjectLiteralExpression(item.value)) {
        throw new Error(
          `[plugin-view-inventory] ${item.context.source}:${sourceLine(item.context.sourceFile, item.value)} Plugin.views entry must resolve to an object literal`,
        );
      }
      return parseView(item.value, item.context, owner, false);
    });
    views.push(...sourceViews);
    sources.push({
      owner,
      source: declaration.context.source,
      line: sourceLine(declaration.context.sourceFile, declaration.node),
      kind: "plugin-manifest",
      viewCount: sourceViews.length,
    });
  }
  return { views, sources };
}

function collisionIdentity(value) {
  return value.trim().toLocaleLowerCase("en-US");
}

function routeIdentity(route) {
  const withoutTrailingSlash =
    route.length > 1 ? route.replace(/\/+$/, "") : route;
  return collisionIdentity(withoutTrailingSlash.replace(/\/{2,}/g, "/"));
}

function assertNoCollisions(views) {
  for (const [field, selectValue, normalize] of [
    ["id", (view) => view.id, collisionIdentity],
    ["path", (view) => view.route, routeIdentity],
  ]) {
    const seen = new Map();
    for (const view of views) {
      const value = selectValue(view);
      if (!value) continue;
      for (const modality of view.modalities) {
        const key = `${modality}:${normalize(value)}`;
        const previous = seen.get(key);
        if (previous) {
          throw new Error(
            `[plugin-view-inventory] duplicate ${field} "${value}" for ${modality}: ${previous.owner} ${previous.source}:${previous.line} and ${view.owner} ${view.source}:${view.line}`,
          );
        }
        seen.set(key, view);
      }
    }
  }
}

/** Discover and validate every built-in and first-party Plugin view declaration. */
export function discoverPluginViewInventory({
  repoRoot,
  files = repositoryFiles(repoRoot),
}) {
  const cache = new Map();
  const inventory = { views: [], sources: [] };
  for (const source of files) {
    if (source !== BUILTIN_SOURCE && !PLUGIN_SOURCE.test(source)) continue;
    const context = parseSourceContext(repoRoot, source, cache);
    const parsed =
      source === BUILTIN_SOURCE
        ? parseBuiltin(context)
        : parsePlugin(context, pluginOwner(repoRoot, source));
    inventory.views.push(...parsed.views);
    inventory.sources.push(...parsed.sources);
  }
  if (!inventory.sources.some((source) => source.kind === "builtin-registry")) {
    throw new Error("[plugin-view-inventory] BUILTIN_VIEWS was not discovered");
  }
  if (!inventory.sources.some((source) => source.kind === "plugin-manifest")) {
    throw new Error(
      "[plugin-view-inventory] discovered zero Plugin.views sources",
    );
  }
  assertNoCollisions(inventory.views);
  inventory.views.sort(
    (left, right) =>
      compareText(left.owner, right.owner) ||
      compareText(left.id, right.id) ||
      compareText(left.source, right.source) ||
      left.line - right.line,
  );
  inventory.sources.sort(
    (left, right) =>
      compareText(left.owner, right.owner) ||
      compareText(left.source, right.source) ||
      left.line - right.line,
  );
  return inventory;
}

/** Strip parser state and add stable counts for the machine-readable artifact. */
export function serializePluginViewInventory(inventory) {
  return {
    schemaVersion: 1,
    source: "runtime-view-declarations",
    discoveredCount: inventory.views.length,
    builtinCount: inventory.views.filter((view) => view.builtin).length,
    pluginCount: inventory.views.filter((view) => !view.builtin).length,
    declarationSourceCount: inventory.sources.length,
    declarationSources: inventory.sources,
    views: inventory.views,
  };
}

function markdownCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

/** Render the same inventory as a deterministic reviewer-facing Markdown table. */
export function renderPluginViewInventoryMarkdown(serialized) {
  const lines = [
    "# First-party runtime view inventory",
    "",
    "Generated from `BUILTIN_VIEWS` and typed first-party `Plugin.views` declarations.",
    "",
    `- Total views: ${serialized.discoveredCount}`,
    `- Built-in views: ${serialized.builtinCount}`,
    `- Plugin views: ${serialized.pluginCount}`,
    `- Declaration sources: ${serialized.declarationSourceCount}`,
    "",
    "| Owner | ID | Modalities | Path | Kind | Related actions | Operations | Source |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const view of serialized.views) {
    lines.push(
      `| ${markdownCell(view.owner)} | ${markdownCell(view.id)} | ${markdownCell(view.modalities.join(", "))} | ${markdownCell(view.route ?? "—")} | ${markdownCell(view.viewKind ?? "—")} | ${markdownCell(view.relatedActions.join(", ") || "—")} | ${markdownCell(view.operationIds.join(", ") || "—")} | ${markdownCell(`${view.source}:${view.line}`)} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

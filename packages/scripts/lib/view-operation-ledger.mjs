/**
 * Derives the first-party view-operation ledger from production registrations.
 *
 * Runtime view declarations provide the surface and domain-operation authority;
 * reachable TSX supplies concrete controls. The result is intentionally source-
 * backed: tests may prove an operation, but a test roster can never create one.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { discoverPluginViewInventory } from "./plugin-view-inventory.mjs";
import { execFileSync } from "./spawn-sync-captured.mjs";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const SOURCE_EXTENSION = /\.(?:ts|tsx)$/;
const PRODUCTION_SOURCE =
  /^(?:packages\/(?:app|ui)\/src|plugins\/[^/]+\/src)\/.*\.(?:ts|tsx)$/;
const EXCLUDED_SOURCE =
  /(?:^|\/)(?:__tests__|test|tests|__e2e__)(?:\/|$)|\.(?:test|spec|stories)\.(?:ts|tsx)$/;
const INTERACTION_ATTRIBUTES = new Set([
  "onClick",
  "onPress",
  "onChange",
  "onValueChange",
  "onCheckedChange",
  "onSelect",
  "onOpenChange",
  "onSubmit",
  "onInput",
  "onDrop",
  "onDragEnd",
  "onKeyDown",
  "onKeyUp",
  "onPointerDown",
  "onPointerUp",
  "onMouseDown",
  "onDoubleClick",
]);
const INTERACTIVE_TAGS = new Set([
  "button",
  "input",
  "textarea",
  "select",
  "a",
]);
const CLICKABLE_ROLES = new Set([
  "button",
  "link",
  "toggle",
  "tab",
  "menu-item",
  "list-item",
  "card",
]);
const FILLABLE_ROLES = new Set([
  "text-input",
  "number-input",
  "textarea",
  "select",
  "slider",
]);
const CONFIRMATION_PATTERN =
  /\b(delete|remove|clear|erase|send|transfer|purchase|pay|archive|stop|disconnect|revoke)\b/i;
const SENSITIVE_PATTERN =
  /\b(password|passcode|passphrase|secret|token|api[\s_-]*key|private[\s_-]*key|seed[\s_-]*phrase|mnemonic|credential|one[\s_-]*time|otp)\b/i;
const BUSINESS_MUTATION_PATTERN =
  /\b(approve|archive|block|capture|connect|create|delete|deny|disable|disconnect|enable|execute|grant|install|purchase|remove|reopen|restart|revoke|run|save|send|start|stop|submit|transfer|unblock|uninstall|update|upload)\b/i;
const VIEW_ONLY_JUSTIFICATIONS = Object.freeze({
  "ast-proven-local":
    "The local handler call graph resolves without a known business mutation primitive.",
  "data-refresh":
    "Refreshes or retries read-only backing data without changing domain state.",
  "dense-manipulation":
    "Pointer, keyboard, drag, or gesture state is meaningful only in the dense visual surface.",
  "local-disclosure":
    "Opens, closes, or expands local presentation state without changing domain data.",
  "local-draft":
    "Edits uncommitted local form state; submission is classified separately.",
  "local-selection":
    "Changes a local filter, sort, tab, focus, or selection without changing domain data.",
  "media-control": "Controls local media playback or inspection state.",
  "native-control":
    "Uses native read-only or draft interaction semantics without an executable handler.",
  "readonly-display":
    "The registered surface has no enabled control and only presents state.",
});

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function normalizePath(value) {
  return value.split(path.sep).join("/");
}

function sourceDomain(source) {
  const parts = source.split("/");
  if (parts[0] === "plugins") return parts[1] ?? "plugins";
  if (parts[0] === "packages" && parts[1] === "ui") {
    const componentIndex = parts.indexOf("components");
    if (componentIndex >= 0)
      return `ui/${parts[componentIndex + 1] ?? "components"}`;
    return "ui";
  }
  return parts.slice(0, 2).join("/");
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
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  )
    .split("\0")
    .filter(Boolean)
    .map(normalizePath)
    .filter(
      (source) =>
        PRODUCTION_SOURCE.test(source) && !EXCLUDED_SOURCE.test(source),
    )
    .filter((source) => existsSync(path.resolve(repoRoot, source)))
    .sort(compareText);
}

function parseSource(repoRoot, source, cache) {
  const normalized = normalizePath(source);
  const cached = cache.get(normalized);
  if (cached) return cached;
  const text = readFileSync(path.resolve(repoRoot, normalized), "utf8");
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
      `[view-operation-ledger] ${normalized} is not parseable TypeScript: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`,
    );
  }
  const constants = new Map();
  const callables = new Map();
  const collectBindings = (node) => {
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          if (node.parent === sourceFile) {
            constants.set(declaration.name.text, declaration.initializer);
          }
          const entries = callables.get(declaration.name.text) ?? [];
          entries.push({
            expression: declaration.initializer,
            scope: scopeName(node),
          });
          callables.set(declaration.name.text, entries);
        }
      }
    } else if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      const entries = callables.get(node.name.text) ?? [];
      entries.push({ expression: node, scope: scopeName(node.parent) });
      callables.set(node.name.text, entries);
    }
    ts.forEachChild(node, collectBindings);
  };
  collectBindings(sourceFile);
  const context = {
    repoRoot,
    source: normalized,
    sourceFile,
    text,
    constants,
    callables,
  };
  cache.set(normalized, context);
  return context;
}

function lineOf(context, node) {
  return (
    context.sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1
  );
}

function scopeName(node) {
  let current = node;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name)
      return current.name.text;
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      current.parent &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      return current.parent.name.text;
    }
    if (ts.isMethodDeclaration(current) && current.name)
      return current.name.getText();
    current = current.parent;
  }
  return "module";
}

function unwrap(expression) {
  let value = expression;
  while (
    ts.isParenthesizedExpression(value) ||
    ts.isAsExpression(value) ||
    ts.isSatisfiesExpression(value) ||
    ts.isNonNullExpression(value)
  ) {
    value = value.expression;
  }
  return value;
}

function resolveLocal(expression, context, resolving = new Set()) {
  const value = unwrap(expression);
  if (!ts.isIdentifier(value)) return value;
  if (resolving.has(value.text)) return value;
  const declaration = context.constants.get(value.text);
  return declaration
    ? resolveLocal(declaration, context, new Set(resolving).add(value.text))
    : value;
}

function propertyName(name) {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  return null;
}

function objectProperty(object, key) {
  return object.properties.find(
    (property) =>
      (ts.isPropertyAssignment(property) ||
        ts.isShorthandPropertyAssignment(property)) &&
      propertyName(property.name) === key,
  );
}

function objectPropertyExpression(property) {
  if (!property) return null;
  if (ts.isPropertyAssignment(property)) return property.initializer;
  if (ts.isShorthandPropertyAssignment(property)) return property.name;
  return null;
}

function literalValue(expression, context) {
  if (!expression) return null;
  const value = resolveLocal(expression, context);
  if (ts.isStringLiteralLike(value)) return value.text;
  if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isNumericLiteral(value)) return Number(value.text);
  return null;
}

function literalObject(expression, context) {
  const value = expression ? resolveLocal(expression, context) : null;
  return value && ts.isObjectLiteralExpression(value) ? value : null;
}

function objectLiteralValue(object, key, context) {
  const property = objectProperty(object, key);
  return literalValue(objectPropertyExpression(property), context);
}

function expressionIdentity(expression, context) {
  const resolved = resolveLocal(expression, context);
  const literal = literalValue(resolved, context);
  if (typeof literal === "string") return { value: literal, dynamic: false };
  if (ts.isTemplateExpression(resolved)) {
    const value = `${resolved.head.text}${resolved.templateSpans
      .map((span) => `*${span.literal.text}`)
      .join("")}`;
    return { value, dynamic: true };
  }
  const source = resolved
    .getText(context.sourceFile)
    .replace(/\s+/g, " ")
    .trim();
  return {
    value: `<dynamic:${sha(`${context.source}:${source}`)}>`,
    dynamic: true,
  };
}

function resolveRelativeImport(repoRoot, source, specifier) {
  if (!specifier.startsWith(".")) return null;
  const unresolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(source), specifier),
  );
  const base = unresolved.replace(/\.(?:js|mjs|cjs)$/, "");
  const candidates = [
    unresolved,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ];
  return (
    candidates.find((candidate) =>
      existsSync(path.resolve(repoRoot, candidate)),
    ) ?? null
  );
}

function runtimeDependencies(context) {
  const dependencies = [];
  const append = (specifier) => {
    const resolved = resolveRelativeImport(
      context.repoRoot,
      context.source,
      specifier,
    );
    if (
      resolved &&
      SOURCE_EXTENSION.test(resolved) &&
      !EXCLUDED_SOURCE.test(resolved)
    ) {
      dependencies.push(resolved);
    }
  };
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      const typeOnly = ts.isImportDeclaration(node)
        ? node.importClause?.isTypeOnly
        : node.isTypeOnly;
      if (!typeOnly) append(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      append(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(context.sourceFile);
  return [...new Set(dependencies)]
    .filter((source) => {
      const basename = path.posix.basename(source);
      // A package/directory barrel describes an export universe, not a runtime
      // render edge. Following every member defeats bundler tree-shaking and
      // falsely assigns unrelated controls to whichever view imported one
      // symbol from the barrel. View bundle entry barrels are resolved to the
      // concrete component before traversal and therefore do not need this.
      return basename !== "index.ts" && basename !== "index.tsx";
    })
    .sort(compareText);
}

function reachableFiles(roots, repoRoot, cache) {
  const found = new Set();
  const pending = [...roots];
  while (pending.length > 0) {
    const source = pending.pop();
    if (
      !source ||
      found.has(source) ||
      !existsSync(path.resolve(repoRoot, source))
    )
      continue;
    found.add(source);
    pending.push(...runtimeDependencies(parseSource(repoRoot, source, cache)));
  }
  return found;
}

function packageDirectoryForOwner(repoRoot, owner) {
  const manifests = execFileSync(
    "git",
    ["-C", repoRoot, "ls-files", "-z", "plugins/*/package.json"],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  for (const manifest of manifests) {
    const parsed = JSON.parse(
      readFileSync(path.resolve(repoRoot, manifest), "utf8"),
    );
    if (parsed.name === owner) return path.posix.dirname(manifest);
  }
  return null;
}

function viewBundleEntry(repoRoot, packageDirectory) {
  const config = [
    "vite.config.views.ts",
    "vite.config.views.mts",
    "vite.config.views.js",
  ]
    .map((name) => `${packageDirectory}/${name}`)
    .find((candidate) => existsSync(path.resolve(repoRoot, candidate)));
  if (!config) return null;
  const text = readFileSync(path.resolve(repoRoot, config), "utf8");
  const match = /\bentry\s*:\s*["']([^"']+)["']/.exec(text);
  if (!match) {
    throw new Error(
      `[view-operation-ledger] ${config} does not declare a literal view entry`,
    );
  }
  return path.posix.normalize(
    path.posix.join(packageDirectory, match[1].replace(/^\.\//, "")),
  );
}

function exportedComponentRoot(entry, exportName, repoRoot, cache) {
  const context = parseSource(repoRoot, entry, cache);
  for (const statement of context.sourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier)
      continue;
    if (!ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    const clause = statement.exportClause;
    if (!clause || !ts.isNamedExports(clause)) continue;
    const match = clause.elements.find(
      (element) => element.name.text === exportName,
    );
    if (!match) continue;
    return resolveRelativeImport(
      repoRoot,
      entry,
      statement.moduleSpecifier.text,
    );
  }
  return null;
}

function builtinRouteRoots(repoRoot, cache) {
  const loaderSource = "packages/ui/src/app-route-loaders.tsx";
  const context = parseSource(repoRoot, loaderSource, cache);
  const roots = new Map();
  for (const statement of context.sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        !declaration.name.text.startsWith("Lazy")
      )
        continue;
      const call = declaration.initializer
        ? unwrap(declaration.initializer)
        : null;
      if (!call || !ts.isCallExpression(call) || call.arguments.length < 2)
        continue;
      const load = call.arguments[0];
      const exportName = literalValue(call.arguments[1], context);
      if (!(ts.isArrowFunction(load) || ts.isFunctionExpression(load)))
        continue;
      let specifier = null;
      const visit = (node) => {
        if (
          ts.isCallExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ImportKeyword &&
          node.arguments.length === 1 &&
          ts.isStringLiteralLike(node.arguments[0])
        ) {
          specifier = node.arguments[0].text;
        }
        ts.forEachChild(node, visit);
      };
      visit(load);
      if (specifier && typeof exportName === "string") {
        const root = resolveRelativeImport(repoRoot, loaderSource, specifier);
        if (root) roots.set(exportName, root);
      }
    }
  }
  return roots;
}

function tokens(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(
      (token) =>
        !["lazy", "view", "page", "shell", "inventory"].includes(token),
    );
}

function chooseBuiltinRoot(view, roots) {
  const desired = new Set([
    ...tokens(view.id),
    ...tokens(view.route ?? ""),
    ...tokens(view.label),
  ]);
  let best = null;
  for (const [exportName, source] of roots) {
    const score = tokens(exportName).filter((token) =>
      desired.has(token),
    ).length;
    if (score > 0 && (!best || score > best.score)) best = { score, source };
  }
  return best?.source ?? null;
}

function appRegisterRoots(repoRoot) {
  const roots = ["packages/app/src/cloud-apps-view.ts"];
  const manifests = execFileSync(
    "git",
    ["-C", repoRoot, "ls-files", "-z", "plugins/*/package.json"],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  for (const manifest of manifests) {
    const parsed = JSON.parse(
      readFileSync(path.resolve(repoRoot, manifest), "utf8"),
    );
    const register = parsed.elizaos?.appRegister;
    if (typeof register !== "string") continue;
    const directory = path.posix.dirname(manifest);
    for (const candidate of [
      `${directory}/${register.replace(/^\.\//, "")}`,
      `${directory}/src/${register.replace(/^\.\//, "")}`,
    ]) {
      for (const source of [candidate, `${candidate}.ts`, `${candidate}.tsx`]) {
        if (existsSync(path.resolve(repoRoot, source))) {
          roots.push(source);
          break;
        }
      }
    }
  }
  return [...new Set(roots)].sort(compareText);
}

function callName(call) {
  const expression = call.expression;
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

function discoverRegisteredSurfaces(repoRoot, cache) {
  const roots = appRegisterRoots(repoRoot);
  const files = reachableFiles(roots, repoRoot, cache);
  const surfaces = [];
  for (const source of [...files].sort(compareText)) {
    const context = parseSource(repoRoot, source, cache);
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ["registerAppShellPage", "registerOverlayApp"].includes(callName(node))
      ) {
        const object = node.arguments[0]
          ? literalObject(node.arguments[0], context)
          : null;
        if (!object) {
          throw new Error(
            `[view-operation-ledger] ${source}:${lineOf(context, node)} registration must resolve to a local object literal`,
          );
        }
        const overlay = callName(node) === "registerOverlayApp";
        const owner = objectLiteralValue(
          object,
          overlay ? "name" : "pluginId",
          context,
        );
        const rawId = objectLiteralValue(
          object,
          overlay ? "name" : "id",
          context,
        );
        const route = objectLiteralValue(object, "path", context);
        if (typeof owner !== "string" || typeof rawId !== "string") {
          throw new Error(
            `[view-operation-ledger] ${source}:${lineOf(context, node)} registration needs literal owner and id`,
          );
        }
        const id = overlay
          ? rawId
              .replace(/^@[^/]+\//, "")
              .replace(/^(app|plugin)-/, "")
              .replace(/[^a-z0-9-]/gi, "-")
              .replace(/-+/g, "-")
              .replace(/^-|-$/g, "")
              .toLowerCase()
          : rawId.trim();
        surfaces.push({
          kind: overlay ? "overlay" : "app-shell",
          id,
          owner,
          route: typeof route === "string" ? route : `/apps/${id}`,
          source,
          line: lineOf(context, node),
          root: source,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(context.sourceFile);
  }
  const unique = new Map();
  for (const surface of surfaces) {
    const existing = unique.get(surface.id);
    if (
      existing &&
      (existing.owner !== surface.owner || existing.kind !== surface.kind)
    ) {
      throw new Error(
        `[view-operation-ledger] duplicate registered surface ${surface.id}: ${existing.source}:${existing.line} and ${surface.source}:${surface.line}`,
      );
    }
    unique.set(surface.id, surface);
  }
  return [...unique.values()].sort((a, b) => compareText(a.id, b.id));
}

/** Discovers app-shell and overlay registrations independently of the ledger. */
export function discoverRegisteredSurfaceInventory({ repoRoot }) {
  return discoverRegisteredSurfaces(repoRoot, new Map()).map(
    ({ root, ...surface }) => surface,
  );
}

function jsxAttribute(opening, name) {
  return opening.attributes.properties.find(
    (property) => ts.isJsxAttribute(property) && property.name.text === name,
  );
}

function jsxAttributeExpression(attribute) {
  if (!attribute?.initializer) return null;
  if (ts.isStringLiteralLike(attribute.initializer))
    return attribute.initializer;
  return ts.isJsxExpression(attribute.initializer)
    ? (attribute.initializer.expression ?? null)
    : null;
}

function jsxName(opening) {
  return opening.tagName.getText();
}

function jsxStableName(opening, context) {
  for (const key of [
    "data-testid",
    "id",
    "aria-label",
    "name",
    "title",
    "href",
    "to",
  ]) {
    const expression = jsxAttributeExpression(jsxAttribute(opening, key));
    if (!expression) continue;
    const identity = expressionIdentity(expression, context);
    if (identity.value) return identity;
  }
  return {
    value: `<source:${sha(`${context.source}:${opening.getText(context.sourceFile).replace(/\s+/g, " ")}`)}>`,
    dynamic: true,
  };
}

function siteDiscriminator(node, context) {
  const parentText =
    node.parent?.getText(context.sourceFile) ??
    node.getText(context.sourceFile);
  return sha(`${context.source}:${scopeName(node)}:${parentText}`);
}

function viewOnlyJustificationCode({
  eventName,
  handler,
  identity,
  tag,
  hasHandler,
}) {
  const text = `${identity} ${handler}`;
  if (/drag|drop|pointer|mouse|key/i.test(eventName))
    return "dense-manipulation";
  if (/\b(refresh|retry|reload|poll)\b/i.test(text)) return "data-refresh";
  if (/\b(play|pause|seek|mute|volume)\b/i.test(text)) return "media-control";
  if (/\b(open|close|toggle|expand|collapse|disclosure)\b/i.test(text)) {
    return "local-disclosure";
  }
  if (
    /change|input/i.test(eventName) ||
    /\b(draft|query|search|filter|sort|select|selected|active|tab|focus)\b/i.test(
      text,
    )
  ) {
    return tag === "input" || tag === "textarea" || tag === "select"
      ? "local-draft"
      : "local-selection";
  }
  return hasHandler ? "ast-proven-local" : "native-control";
}

function callableForIdentifier(identifier, context) {
  const entries = context.callables.get(identifier.text) ?? [];
  const scope = scopeName(identifier);
  return (
    entries.find((entry) => entry.scope === scope)?.expression ??
    entries.find((entry) => entry.scope === "module")?.expression ??
    null
  );
}

function fetchWrites(call, context) {
  if (callName(call) !== "fetch") return false;
  const options = call.arguments[1]
    ? literalObject(call.arguments[1], context)
    : null;
  if (!options) return false;
  const method = objectLiteralValue(options, "method", context);
  return typeof method === "string" && method.toUpperCase() !== "GET";
}

function analyzeHandlerExpression(expression, context, seen = new Set()) {
  const result = { mutation: false, unresolved: false };
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      if (fetchWrites(node, context)) result.mutation = true;
      const callee = unwrap(node.expression);
      if (ts.isIdentifier(callee)) {
        if (/^set[A-Z0-9_]/.test(callee.text)) {
          ts.forEachChild(node, visit);
          return;
        }
        const local = callableForIdentifier(callee, context);
        if (local && !seen.has(local)) {
          seen.add(local);
          const nested = analyzeHandlerExpression(local, context, seen);
          result.mutation ||= nested.mutation;
          result.unresolved ||= nested.unresolved;
        } else {
          const name = callee.text.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
          if (BUSINESS_MUTATION_PATTERN.test(name)) result.mutation = true;
          if (/\b(?:handle|perform|request) action\b|\bmutate\b/i.test(name)) {
            result.unresolved = true;
          }
        }
      } else if (ts.isPropertyAccessExpression(callee)) {
        const receiver = callee.expression.getText(context.sourceFile);
        const method = callee.name.text.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
        const knownMutationReceiver =
          /(?:^|\.)(?:api|client|service|mutation|mutations)$/i.test(receiver);
        if (
          knownMutationReceiver &&
          !/\b(?:get|list|read|search|status|fetch|query|preview)\b/i.test(
            method,
          )
        ) {
          result.mutation = true;
        }
        if (
          /(?:^|\.)props$/i.test(receiver) &&
          BUSINESS_MUTATION_PATTERN.test(method)
        ) {
          result.unresolved = true;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(expression);
  return result;
}

function businessMutationRisk(identity, handlerExpression, context) {
  const handler = handlerExpression?.getText(context.sourceFile) ?? "";
  const executableHandler = handler
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n\r]*/g, " ");
  const semanticText = `${identity} ${executableHandler}`;
  const analysis = handlerExpression
    ? analyzeHandlerExpression(handlerExpression, context)
    : { mutation: false, unresolved: false };
  return {
    mutation:
      analysis.mutation ||
      (!/\binspect(?:ion)?[-_ ]block\b/i.test(semanticText) &&
        BUSINESS_MUTATION_PATTERN.test(semanticText)),
    unresolved: analysis.unresolved,
  };
}

function elementContract({
  surface,
  identity,
  role,
  label,
  sensitive,
  source,
  line,
  kind,
  scope,
}) {
  const fillable = FILLABLE_ROLES.has(role);
  const clickable = CLICKABLE_ROLES.has(role);
  const destructive = CONFIRMATION_PATTERN.test(`${identity.value} ${label}`);
  const classification = sensitive
    ? "secure-sensitive"
    : fillable || clickable
      ? "agent-operation"
      : "agent-observable";
  const channels = {
    view: true,
    widget:
      classification === "agent-operation" ||
      classification === "agent-observable",
    chat:
      classification === "agent-operation" ||
      classification === "agent-observable",
    voice:
      classification === "agent-operation" ||
      classification === "agent-observable",
  };
  return {
    operationId: `${surface.id}.control.${scope}.${identity.value}`,
    surfaceId: surface.id,
    owner: surface.owner,
    useCase:
      classification === "agent-operation"
        ? `Interact with ${label}`
        : `Present ${label}`,
    classification,
    control: {
      id: identity.value,
      dynamic: identity.dynamic,
      role,
      label,
      kind,
      scope,
    },
    input: fillable
      ? { type: "AgentFillInput", fields: { value: "string" } }
      : { type: "AgentActivateInput", fields: {} },
    output: {
      type: "AgentActionResult",
      fields: { ok: "boolean", reason: "string?", value: "unknown?" },
    },
    errors: [
      "VIEW_NOT_ACTIVE",
      "ELEMENT_MISSING",
      "ELEMENT_DISABLED",
      "ELEMENT_SENSITIVE",
      "INTERACTION_REJECTED",
    ],
    authorization: sensitive
      ? "native-sensitive-boundary"
      : "authenticated-owner+agent-surface-capability",
    idempotency: fillable
      ? "idempotent-set"
      : role === "tab" || role === "link"
        ? "idempotent-navigation"
        : "non-idempotent",
    confirmation: destructive ? "required" : "none",
    channels,
    sensitive,
    semanticMutation: BUSINESS_MUTATION_PATTERN.test(
      `${identity.value} ${label}`,
    ),
    source: { file: source, line },
  };
}

function scanControlsForSurface(surface, files, repoRoot, cache) {
  const operations = [];
  const rawControls = [];
  for (const source of [...files].sort(compareText)) {
    const context = parseSource(repoRoot, source, cache);
    const visit = (node) => {
      if (ts.isCallExpression(node) && callName(node) === "useAgentElement") {
        const object = node.arguments[0]
          ? literalObject(node.arguments[0], context)
          : null;
        if (!object) {
          throw new Error(
            `[view-operation-ledger] ${source}:${lineOf(context, node)} useAgentElement needs a local object literal`,
          );
        }
        const idProperty = objectProperty(object, "id");
        if (!idProperty) {
          throw new Error(
            `[view-operation-ledger] ${source}:${lineOf(context, node)} useAgentElement is missing id`,
          );
        }
        const identity = expressionIdentity(
          objectPropertyExpression(idProperty),
          context,
        );
        const role = objectLiteralValue(object, "role", context) ?? "region";
        const labelValue = objectProperty(object, "label");
        const label = labelValue
          ? expressionIdentity(objectPropertyExpression(labelValue), context)
              .value
          : identity.value;
        const sensitiveValue = objectLiteralValue(object, "sensitive", context);
        const sensitive =
          sensitiveValue === true ||
          SENSITIVE_PATTERN.test(`${identity.value} ${label}`);
        operations.push(
          elementContract({
            surface,
            identity,
            role,
            label,
            sensitive,
            source,
            line: lineOf(context, node),
            kind: "useAgentElement",
            scope: scopeName(node),
          }),
        );
      }
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const dataAgent = jsxAttributeExpression(
          jsxAttribute(node, "data-agent-id"),
        );
        const directAgentId =
          jsxAttributeExpression(jsxAttribute(node, "agentId")) ??
          (jsxName(node) === "AgentButton"
            ? jsxAttributeExpression(jsxAttribute(node, "id"))
            : null);
        const agentExpression = jsxAttributeExpression(
          jsxAttribute(node, "agent"),
        );
        const agentDescriptor = literalObject(agentExpression, context);
        if (dataAgent) {
          const identity = expressionIdentity(dataAgent, context);
          const roleExpression = jsxAttributeExpression(
            jsxAttribute(node, "data-agent-role"),
          );
          const labelExpression = jsxAttributeExpression(
            jsxAttribute(node, "data-agent-label"),
          );
          const role = roleExpression
            ? expressionIdentity(roleExpression, context).value
            : jsxName(node) === "Button" ||
                jsxName(node) === "button" ||
                jsxName(node) === "form"
              ? "button"
              : /Input|Field|Select|Slider/.test(jsxName(node)) ||
                  ["input", "textarea", "select"].includes(jsxName(node))
                ? "text-input"
                : "custom";
          const label = labelExpression
            ? expressionIdentity(labelExpression, context).value
            : identity.value;
          const sensitive = SENSITIVE_PATTERN.test(
            `${identity.value} ${label}`,
          );
          operations.push(
            elementContract({
              surface,
              identity,
              role,
              label,
              sensitive,
              source,
              line: lineOf(context, node),
              kind: "data-agent-id",
              scope: scopeName(node),
            }),
          );
        }
        if (directAgentId) {
          const identity = expressionIdentity(directAgentId, context);
          const roleExpression = jsxAttributeExpression(
            jsxAttribute(node, "agentRole"),
          );
          const tagName = jsxName(node);
          const role = roleExpression
            ? expressionIdentity(roleExpression, context).value
            : tagName === "AgentInput"
              ? "text-input"
              : "button";
          const labelExpression = jsxAttributeExpression(
            jsxAttribute(node, "agentLabel"),
          );
          const label = labelExpression
            ? expressionIdentity(labelExpression, context).value
            : identity.value;
          const sensitive = SENSITIVE_PATTERN.test(
            `${identity.value} ${label}`,
          );
          operations.push(
            elementContract({
              surface,
              identity,
              role,
              label,
              sensitive,
              source,
              line: lineOf(context, node),
              kind: "agent-component",
              scope: scopeName(node),
            }),
          );
        }

        if (agentDescriptor) {
          const idProperty = objectProperty(agentDescriptor, "id");
          if (!idProperty) {
            throw new Error(
              `[view-operation-ledger] ${source}:${lineOf(context, node)} JSX agent descriptor is missing id`,
            );
          }
          const identity = expressionIdentity(
            objectPropertyExpression(idProperty),
            context,
          );
          const role =
            objectLiteralValue(agentDescriptor, "role", context) ??
            (jsxName(node) === "Button" ? "button" : "custom");
          const labelProperty = objectProperty(agentDescriptor, "label");
          const label = labelProperty
            ? expressionIdentity(
                objectPropertyExpression(labelProperty),
                context,
              ).value
            : identity.value;
          const sensitive =
            objectLiteralValue(agentDescriptor, "sensitive", context) ===
              true || SENSITIVE_PATTERN.test(`${identity.value} ${label}`);
          operations.push(
            elementContract({
              surface,
              identity,
              role,
              label,
              sensitive,
              source,
              line: lineOf(context, node),
              kind: "agent-prop",
              scope: scopeName(node),
            }),
          );
        }
        if (agentExpression && !agentDescriptor) {
          const identity = expressionIdentity(agentExpression, context);
          const tagName = jsxName(node);
          const role =
            tagName === "Button"
              ? "button"
              : /Input|Field|Select|Slider/.test(tagName)
                ? "text-input"
                : /Tab/.test(tagName)
                  ? "tab"
                  : "region";
          const sensitive = SENSITIVE_PATTERN.test(identity.value);
          operations.push(
            elementContract({
              surface,
              identity,
              role,
              label: identity.value,
              sensitive,
              source,
              line: lineOf(context, node),
              kind: "agent-prop",
              scope: scopeName(node),
            }),
          );
        }

        const tag = jsxName(node);
        const hasAgentSpread = node.attributes.properties.some(
          (property) =>
            ts.isJsxSpreadAttribute(property) &&
            /agentProps$/i.test(
              property.expression.getText(context.sourceFile),
            ),
        );
        if (dataAgent || directAgentId || agentExpression || hasAgentSpread) {
          ts.forEachChild(node, visit);
          return;
        }
        const roleExpression = jsxAttributeExpression(
          jsxAttribute(node, "role"),
        );
        const role = roleExpression
          ? expressionIdentity(roleExpression, context).value
          : null;
        const events = node.attributes.properties.filter(
          (property) =>
            ts.isJsxAttribute(property) &&
            INTERACTION_ATTRIBUTES.has(property.name.text),
        );
        const isLink = tag === "a" && Boolean(jsxAttribute(node, "href"));
        if (
          events.length > 0 ||
          isLink ||
          INTERACTIVE_TAGS.has(tag) ||
          role === "button" ||
          role === "menuitem"
        ) {
          const identity = jsxStableName(node, context);
          const sensitive =
            SENSITIVE_PATTERN.test(identity.value) ||
            ["file", "password"].includes(
              literalValue(
                jsxAttributeExpression(jsxAttribute(node, "type")),
                context,
              ),
            );
          for (const event of events.length > 0
            ? events
            : [
                {
                  name: { text: isLink ? "navigate" : "native-control" },
                  initializer: null,
                },
              ]) {
            const handlerExpression = ts.isJsxAttribute(event)
              ? jsxAttributeExpression(event)
              : null;
            const handler =
              handlerExpression?.getText(context.sourceFile) ?? "";
            const eventName = event.name.text;
            const justificationCode = viewOnlyJustificationCode({
              eventName,
              handler,
              identity: identity.value,
              tag,
              hasHandler: Boolean(handlerExpression),
            });
            const semanticAnalysis = businessMutationRisk(
              identity.value,
              handlerExpression,
              context,
            );
            const mutationRisk = semanticAnalysis.mutation;
            rawControls.push({
              operationId: `${surface.id}.view-only.${scopeName(node)}.${identity.value}.${eventName}.${siteDiscriminator(node, context)}-L${lineOf(context, ts.isJsxAttribute(event) ? event : node)}`,
              surfaceId: surface.id,
              owner: surface.owner,
              useCase: isLink
                ? `Navigate through ${identity.value}`
                : `Local ${eventName} affordance`,
              classification: sensitive
                ? "secure-sensitive"
                : isLink
                  ? "secure-linkout"
                  : "view-only",
              control: {
                id: identity.value,
                dynamic: identity.dynamic,
                role: role ?? tag,
                label: identity.value,
                kind: eventName,
                scope: scopeName(node),
              },
              input: { type: `${eventName}Event`, fields: {} },
              output: { type: "void", fields: {} },
              errors: ["CONTROL_DISABLED"],
              authorization: sensitive
                ? "native-sensitive-boundary"
                : "view-session",
              idempotency: isLink
                ? "idempotent-navigation"
                : "presentation-local",
              confirmation: CONFIRMATION_PATTERN.test(
                `${identity.value} ${handler}`,
              )
                ? "required"
                : "none",
              channels: {
                view: true,
                widget: false,
                chat: false,
                voice: false,
              },
              sensitive,
              justificationCode: isLink ? undefined : justificationCode,
              viewOnlyReason: isLink
                ? undefined
                : VIEW_ONLY_JUSTIFICATIONS[justificationCode],
              semanticMutation: mutationRisk,
              mutationRisk,
              unresolvedMutation: semanticAnalysis.unresolved,
              source: {
                file: source,
                line: lineOf(context, ts.isJsxAttribute(event) ? event : node),
              },
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(context.sourceFile);
  }
  return { operations, rawControls };
}

function declarationOperations(view) {
  const shared = {
    surfaceId: view.id,
    owner: view.owner,
    output: {
      type: "OperationReceipt",
      fields: { ok: "boolean", reason: "string", receiptId: "string?" },
    },
    errors: [
      "UNAUTHORIZED",
      "CAPABILITY_UNAVAILABLE",
      "INVALID_INPUT",
      "OPERATION_FAILED",
    ],
    authorization: view.minRole
      ? `role>=${view.minRole}`
      : "authenticated-owner",
    idempotency: "operation-defined",
    confirmation: "operation-defined",
    channels: { view: true, widget: true, chat: true, voice: true },
    sensitive: false,
    semanticMutation: true,
    source: { file: view.source, line: view.line },
  };
  return [
    ...view.relatedActions.map((name) => ({
      ...shared,
      operationId: `${view.id}.action.${name.toLowerCase()}`,
      useCase: `Invoke ${name}`,
      classification: "agent-action",
      control: null,
      input: { type: `${name}Input`, fields: "action-schema" },
    })),
    ...view.operationIds.map((id) => ({
      ...shared,
      operationId: `${view.id}.capability.${id}`,
      useCase: `Invoke ${id}`,
      classification: "view-capability",
      control: null,
      input: { type: "ViewCapabilityInput", fields: "declaration-params" },
    })),
  ];
}

function assertLedger(ledger) {
  const findings = [];
  if (
    ledger.viewInventoryCount +
      ledger.registeredSurfaceCount -
      ledger.registrationOverlapCount !==
    ledger.surfaceCount
  ) {
    findings.push({
      code: "surface-inventory-drift",
      surfaceId: "inventory",
      message: `${ledger.viewInventoryCount} views + ${ledger.registeredSurfaceCount} registrations - ${ledger.registrationOverlapCount} overlaps != ${ledger.surfaceCount} surfaces`,
    });
  }
  const seen = new Map();
  for (const operation of ledger.operations) {
    const existing = seen.get(operation.operationId);
    if (existing) {
      findings.push({
        code: "duplicate-operation-id",
        operationId: operation.operationId,
        message: `${existing.source.file}:${existing.source.line} and ${operation.source.file}:${operation.source.line}`,
      });
    } else {
      seen.set(operation.operationId, operation);
    }
    for (const field of [
      "owner",
      "useCase",
      "input",
      "output",
      "errors",
      "authorization",
      "capability",
      "gate",
      "idempotency",
      "confirmation",
      "channels",
      "delivery",
      "evidence",
    ]) {
      if (operation[field] === null || operation[field] === undefined) {
        findings.push({
          code: "missing-operation-contract",
          operationId: operation.operationId,
          message: `missing ${field}`,
        });
      }
    }
    if (
      operation.sensitive &&
      (operation.channels.chat || operation.channels.voice)
    ) {
      findings.push({
        code: "sensitive-channel-leak",
        operationId: operation.operationId,
        message: "sensitive controls cannot be projected through chat or voice",
      });
    }
    if (operation.classification === "view-only" && operation.mutationRisk) {
      findings.push({
        code: "direct-view-only-business-mutation",
        operationId: operation.operationId,
        message: `${operation.source.file}:${operation.source.line} appears to mutate business state without an agent operation`,
      });
    }
    if (
      operation.classification === "view-only" &&
      operation.unresolvedMutation
    ) {
      findings.push({
        code: "unresolved-semantic-mutation",
        operationId: operation.operationId,
        message: `${operation.source.file}:${operation.source.line} delegates to a generic mutation callback without a canonical operation link`,
      });
    }
    if (
      operation.semanticMutation &&
      !operation.sensitive &&
      (!operation.channels.widget ||
        !operation.channels.chat ||
        !operation.channels.voice)
    ) {
      findings.push({
        code: "semantic-mutation-parity-gap",
        operationId: operation.operationId,
        message:
          "semantic mutations require widget, chat, and voice parity or a sensitive-boundary exception",
      });
    }
    if (operation.classification === "view-only") {
      const expected = VIEW_ONLY_JUSTIFICATIONS[operation.justificationCode];
      if (!expected || operation.viewOnlyReason !== expected) {
        findings.push({
          code: "invalid-view-only-justification",
          operationId: operation.operationId,
          message:
            "view-only entries require one bounded justification code and its canonical reason",
        });
      }
    }
  }
  const covered = new Set(
    ledger.operations.map((operation) => operation.surfaceId),
  );
  for (const surface of ledger.surfaces) {
    if (!covered.has(surface.id)) {
      findings.push({
        code: "surface-without-operation",
        surfaceId: surface.id,
        message: `${surface.kind} surface has no declared or discovered operation`,
      });
    }
  }
  if (findings.length > 0) {
    const detail = findings
      .slice(0, 40)
      .map(
        (finding) =>
          `- ${finding.code}: ${finding.operationId ?? finding.surfaceId}: ${finding.message}`,
      )
      .join("\n");
    const remaining =
      findings.length > 40
        ? `\n- … ${findings.length - 40} more finding(s)`
        : "";
    throw new Error(
      `[view-operation-ledger] ${findings.length} finding(s)\n${detail}${remaining}`,
    );
  }
}

/** Applies fail-closed operation and inventory validation to a derived ledger. */
export function validateViewOperationLedger(ledger) {
  assertLedger(ledger);
}

/** Discover and fail-closed validate the runtime-derived view operation ledger. */
export function discoverViewOperationLedger({ repoRoot, validate = true }) {
  const cache = new Map();
  const inventory = discoverPluginViewInventory({ repoRoot });
  const registered = discoverRegisteredSurfaces(repoRoot, cache);
  const builtinRoots = builtinRouteRoots(repoRoot, cache);
  const surfaces = inventory.views.map((view) => ({
    kind: view.builtin ? "builtin" : "plugin",
    id: view.id,
    owner: view.owner,
    route: view.route,
    source: view.source,
    line: view.line,
    view,
    roots: [],
    registrations: [],
  }));
  let registrationOverlapCount = 0;
  for (const surface of registered) {
    const existing = surfaces.find((candidate) => candidate.id === surface.id);
    if (existing) {
      registrationOverlapCount += 1;
      existing.roots.push(surface.root);
      existing.registrations.push({
        kind: surface.kind,
        owner: surface.owner,
        route: surface.route,
        source: surface.source,
        line: surface.line,
      });
    } else {
      surfaces.push({
        ...surface,
        roots: [surface.root],
        registrations: [
          {
            kind: surface.kind,
            owner: surface.owner,
            route: surface.route,
            source: surface.source,
            line: surface.line,
          },
        ],
      });
    }
  }
  surfaces.sort((a, b) => compareText(a.id, b.id));

  const operations = [];
  const allProductionFiles = repositoryFiles(repoRoot);
  for (const surface of surfaces) {
    if (surface.view) operations.push(...declarationOperations(surface.view));
    let roots = [];
    if (surface.kind === "builtin") {
      const root = chooseBuiltinRoot(surface.view, builtinRoots);
      if (root) roots = [root];
      if (surface.id === "chat")
        roots.push("packages/ui/src/components/shell/ChatOverlay.tsx");
    } else if (surface.kind === "plugin") {
      const directory = packageDirectoryForOwner(repoRoot, surface.owner);
      const entry = directory ? viewBundleEntry(repoRoot, directory) : null;
      if (entry)
        roots = [
          exportedComponentRoot(
            entry,
            surface.view.componentExport,
            repoRoot,
            cache,
          ) ?? entry,
        ];
    } else {
      roots = [surface.root];
    }
    roots.push(...(surface.roots ?? []));
    const reachable = reachableFiles(roots.filter(Boolean), repoRoot, cache);
    const allowedPrefix =
      surface.kind === "builtin" ? "packages/ui/src/" : null;
    const sourceFiles = new Set(
      [...reachable].filter(
        (source) =>
          allProductionFiles.includes(source) &&
          (!allowedPrefix || source.startsWith(allowedPrefix)),
      ),
    );
    const scanned = scanControlsForSurface(
      surface,
      sourceFiles,
      repoRoot,
      cache,
    );
    operations.push(...scanned.operations, ...scanned.rawControls);
    if (!operations.some((operation) => operation.surfaceId === surface.id)) {
      operations.push({
        operationId: `${surface.id}.view-only.display`,
        surfaceId: surface.id,
        owner: surface.owner,
        useCase: `Display ${surface.view?.label ?? surface.id}`,
        classification: "view-only",
        control: null,
        input: { type: "ViewDisplayInput", fields: {} },
        output: {
          type: "ViewDisplayReceipt",
          fields: { ok: "boolean", reason: "string" },
        },
        errors: ["VIEW_UNAVAILABLE", "UNAUTHORIZED"],
        authorization: surface.view?.minRole
          ? `role>=${surface.view.minRole}`
          : "authenticated-owner",
        idempotency: "idempotent-render",
        confirmation: "none",
        channels: { view: true, widget: false, chat: false, voice: false },
        sensitive: false,
        semanticMutation: false,
        viewOnlyReason: VIEW_ONLY_JUSTIFICATIONS["readonly-display"],
        justificationCode: "readonly-display",
        source: { file: surface.source, line: surface.line },
      });
    }
  }

  for (const operation of operations) {
    operation.capability ??=
      operation.classification === "agent-action"
        ? operation.operationId.split(".action.")[1]
        : operation.classification === "view-capability"
          ? operation.operationId.split(".capability.")[1]
          : operation.classification === "agent-operation"
            ? "agent-surface"
            : operation.classification;
    operation.gate = {
      authorization: operation.authorization,
      confirmation: operation.confirmation,
      sensitiveBoundary: operation.sensitive,
    };
    operation.delivery = Object.fromEntries(
      Object.entries(operation.channels)
        .filter(([, enabled]) => enabled)
        .map(([channel]) => [
          channel,
          {
            output: operation.output.type,
            reason: "canonical-operation-reason",
            receipt: operation.output.type,
          },
        ]),
    );
    const siblingTest = operation.source.file.replace(
      /\.(tsx|ts)$/,
      ".test.$1",
    );
    operation.evidence = {
      implementation: `${operation.source.file}:${operation.source.line}`,
      tests: [
        "packages/scripts/__tests__/view-operation-ledger.test.ts",
        ...(existsSync(path.resolve(repoRoot, siblingTest))
          ? [siblingTest]
          : []),
      ],
    };
  }

  const coalesced = [];
  const coalescedById = new Map();
  for (const operation of operations) {
    const existing = coalescedById.get(operation.operationId);
    const sameConditionalOperation =
      existing &&
      existing.surfaceId === operation.surfaceId &&
      existing.owner === operation.owner &&
      existing.classification === operation.classification &&
      existing.source.file === operation.source.file &&
      existing.control?.scope === operation.control?.scope &&
      existing.control?.id === operation.control?.id &&
      existing.control?.role === operation.control?.role;
    if (sameConditionalOperation) {
      existing.sourceLocations ??= [existing.source];
      existing.sourceLocations.push(operation.source);
      continue;
    }
    coalesced.push(operation);
    if (!existing) coalescedById.set(operation.operationId, operation);
  }
  operations.splice(0, operations.length, ...coalesced);

  operations.sort(
    (a, b) =>
      compareText(a.operationId, b.operationId) ||
      compareText(a.source.file, b.source.file) ||
      a.source.line - b.source.line,
  );
  const ledger = {
    schemaVersion: 1,
    source: "production-view-registrations-and-reachable-controls",
    generatedAt: null,
    viewInventoryCount: inventory.views.length,
    registeredSurfaceCount: registered.length,
    registrationOverlapCount,
    surfaceCount: surfaces.length,
    operationCount: operations.length,
    channelCounts: Object.fromEntries(
      ["view", "widget", "chat", "voice"].map((channel) => [
        channel,
        operations.filter((operation) => operation.channels[channel]).length,
      ]),
    ),
    classificationCounts: Object.fromEntries(
      [...new Set(operations.map((operation) => operation.classification))]
        .sort(compareText)
        .map((classification) => [
          classification,
          operations.filter(
            (operation) => operation.classification === classification,
          ).length,
        ]),
    ),
    viewOnlyJustificationCounts: Object.fromEntries(
      Object.keys(VIEW_ONLY_JUSTIFICATIONS).map((code) => [
        code,
        operations.filter(
          (operation) =>
            operation.classification === "view-only" &&
            operation.justificationCode === code,
        ).length,
      ]),
    ),
    semanticMutationCounts: {
      total: operations.filter((operation) => operation.semanticMutation)
        .length,
      agentDelivered: operations.filter(
        (operation) =>
          operation.semanticMutation &&
          !operation.sensitive &&
          operation.channels.widget &&
          operation.channels.chat &&
          operation.channels.voice,
      ).length,
      secureExceptions: operations.filter(
        (operation) => operation.semanticMutation && operation.sensitive,
      ).length,
      viewOnlyViolations: operations.filter(
        (operation) =>
          operation.semanticMutation &&
          operation.classification === "view-only",
      ).length,
    },
    controlRiskCounts: {
      businessMutation: operations.filter(
        (operation) =>
          operation.classification === "view-only" && operation.mutationRisk,
      ).length,
      genericIndirection: operations.filter(
        (operation) =>
          operation.classification === "view-only" &&
          operation.unresolvedMutation &&
          !operation.mutationRisk,
      ).length,
      sensitiveBoundary: operations.filter(
        (operation) => operation.classification === "secure-sensitive",
      ).length,
      localPresentation: operations.filter(
        (operation) =>
          operation.classification === "view-only" &&
          !operation.mutationRisk &&
          !operation.unresolvedMutation,
      ).length,
    },
    unresolvedControls: operations
      .filter(
        (operation) =>
          operation.classification === "view-only" &&
          (operation.mutationRisk || operation.unresolvedMutation),
      )
      .map((operation) => ({
        operationId: operation.operationId,
        surfaceId: operation.surfaceId,
        owner: operation.owner,
        domain: sourceDomain(operation.source.file),
        risk: operation.sensitive
          ? "sensitive"
          : operation.mutationRisk
            ? "business-mutation"
            : "generic-indirection",
        source: operation.source,
      })),
    registeredSurfaces: registered.map(({ root, ...surface }) => surface),
    surfaces: surfaces.map(({ view, root, roots, ...surface }) => ({
      ...surface,
      relatedActions: view?.relatedActions ?? [],
      capabilityIds: view?.operationIds ?? [],
    })),
    operations,
  };
  if (validate) assertLedger(ledger);
  return ledger;
}

export function renderViewOperationLedgerMarkdown(ledger) {
  const lines = [
    "# Runtime view operation ledger",
    "",
    "Generated from production view/app-shell/overlay registrations and their reachable TSX controls. Test rosters are evidence only and never create ledger entries.",
    "",
    `- Surfaces: ${ledger.surfaceCount} (${ledger.viewInventoryCount} runtime views + ${ledger.registeredSurfaceCount} app-shell/overlay registrations - ${ledger.registrationOverlapCount} overlaps)`,
    `- Operations and controls: ${ledger.operationCount}`,
    `- Channel coverage: view ${ledger.channelCounts.view}; widget ${ledger.channelCounts.widget}; chat ${ledger.channelCounts.chat}; voice ${ledger.channelCounts.voice}`,
    `- Semantic mutations: ${ledger.semanticMutationCounts.total}; agent-delivered ${ledger.semanticMutationCounts.agentDelivered}; secure exceptions ${ledger.semanticMutationCounts.secureExceptions}; view-only violations ${ledger.semanticMutationCounts.viewOnlyViolations}`,
    `- Control risks: business mutation ${ledger.controlRiskCounts.businessMutation}; generic indirection ${ledger.controlRiskCounts.genericIndirection}; sensitive boundary ${ledger.controlRiskCounts.sensitiveBoundary}; local presentation ${ledger.controlRiskCounts.localPresentation}`,
    "",
    "## Bounded view-only justifications",
    "",
    ...Object.entries(ledger.viewOnlyJustificationCounts).map(
      ([code, count]) => `- ${code}: ${count}`,
    ),
    "",
    "## Unresolved production controls",
    "",
    ...(ledger.unresolvedControls.length === 0
      ? ["None."]
      : ledger.unresolvedControls.map(
          (gap) =>
            `- ${gap.domain} / ${gap.owner} / ${gap.surfaceId} / ${gap.risk}: ${gap.operationId} (${gap.source.file}:${gap.source.line})`,
        )),
    "",
    "| Operation | Surface | Classification | Owner / use case | Auth | Idempotency / confirmation | Channels | Source |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  const cell = (value) =>
    String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
  for (const operation of ledger.operations) {
    const channels = Object.entries(operation.channels)
      .filter(([, enabled]) => enabled)
      .map(([channel]) => channel)
      .join(", ");
    lines.push(
      `| ${cell(operation.operationId)} | ${cell(operation.surfaceId)} | ${cell(operation.classification)} | ${cell(`${operation.owner}: ${operation.useCase}`)} | ${cell(operation.authorization)} | ${cell(`${operation.idempotency}; ${operation.confirmation}`)} | ${cell(channels)} | ${cell(`${operation.source.file}:${operation.source.line}`)} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export const __test = {
  assertLedger,
  VIEW_ONLY_JUSTIFICATIONS,
};

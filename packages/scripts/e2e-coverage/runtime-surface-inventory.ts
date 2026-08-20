/**
 * Builds the canonical synthetic-world inventory from production registration
 * objects and host manifests. The extractor follows typed `Plugin` objects,
 * their spreads, imported arrays, promoted subactions, Cloud route modules,
 * Worker bindings, native bridge registration calls, and maintained service
 * package entry points without importing application code or running provider
 * side effects.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

export const RUNTIME_SURFACE_REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

export const RUNTIME_SURFACE_SCHEMA = "eliza.synthetic-world-surfaces/v1";

export const RUNTIME_SURFACE_STATUSES = [
  "covered",
  "exempt",
  "platform-deferred",
  "provider-qualified-only",
  "unsupported-product",
] as const;

export type RuntimeSurfaceStatus = (typeof RUNTIME_SURFACE_STATUSES)[number];

export const RUNTIME_SURFACE_KINDS = [
  "action",
  "subaction",
  "provider",
  "service",
  "evaluator",
  "response-handler-evaluator",
  "response-handler-field-evaluator",
  "event-handler",
  "route",
  "view",
  "model-handler",
  "connector-ingress",
  "connector-egress",
  "scheduled-worker",
  "queue",
  "native-bridge",
  "cloud-service",
] as const;

export type RuntimeSurfaceKind = (typeof RUNTIME_SURFACE_KINDS)[number];

export type MockAvailability = "available" | "partial" | "missing";
export type ResetSupport = "supported" | "partial" | "missing";

export interface RuntimeSurfaceClassification {
  status: Exclude<RuntimeSurfaceStatus, "covered">;
  reason: string;
}

export interface RuntimeSurfaceBaseline {
  schema: typeof RUNTIME_SURFACE_SCHEMA;
  generatedFrom: string;
  classifications: Record<string, RuntimeSurfaceClassification>;
}

export interface RuntimeSurfaceRow {
  id: string;
  kind: RuntimeSurfaceKind;
  surfaceName: string;
  owner: string;
  packageName: string;
  packageDir: string;
  sourcePath: string;
  registrationField: string;
  runtimeRequirements: string[];
  platformRequirements: string[];
  externalDependencies: string[];
  mockAvailability: MockAvailability;
  mockFidelity: string;
  resetSupport: ResetSupport;
  deterministicScenarioIds: string[];
  liveModelScenarioIds: string[];
  cloudE2eCells: string[];
  evidenceClass: "synthetic" | "provider-qualified" | "none";
  boundaryArtifacts: string[];
  boundarySignals: string[];
  workstream: "#22898" | "#22899" | "#22901" | "#22902" | "#22904";
  status: RuntimeSurfaceStatus;
  reason: string;
}

export interface RuntimeSurfaceInventory {
  schema: typeof RUNTIME_SURFACE_SCHEMA;
  generatedAt: string;
  sourceRevision: string;
  packages: RuntimePackageRecord[];
  rows: RuntimeSurfaceRow[];
  summary: {
    total: number;
    byKind: Record<string, number>;
    byStatus: Record<string, number>;
  };
  gaps: {
    byOwner: Record<string, string[]>;
    byExternalDependency: Record<string, string[]>;
    byScenarioLane: Record<string, string[]>;
    byWorkstream: Record<string, string[]>;
  };
}

export interface RuntimePackageRecord {
  owner: string;
  packageName: string;
  packageDir: string;
  runtimeRequirements: string[];
  platformRequirements: string[];
  externalDependencies: string[];
  registeredSurfaceIds: string[];
  registrationState: "registered-surfaces" | "no-runtime-registration";
  reason: string;
}

interface PackageContext {
  dir: string;
  packageName: string;
  owner: string;
  runtimeRequirements: string[];
  platformRequirements: string[];
  externalDependencies: string[];
}

interface RawSurface {
  kind: RuntimeSurfaceKind;
  name: string;
  sourcePath: string;
  registrationField: string;
  package: PackageContext;
}

interface ScenarioRecord {
  id: string;
  file: string;
  source: string;
  plugins: string[];
  lane: "deterministic" | "live";
}

interface SourceUnit {
  file: string;
  source: string;
  ast: ts.SourceFile;
  declarations: Map<string, ts.Node>;
  imports: Map<string, { imported: string; file: string }>;
}

interface ExtractionContext {
  units: Map<string, SourceUnit>;
  seen: Set<string>;
}

const PLUGIN_FIELDS = new Map<string, RuntimeSurfaceKind>([
  ["actions", "action"],
  ["providers", "provider"],
  ["services", "service"],
  ["evaluators", "evaluator"],
  ["responseHandlerEvaluators", "response-handler-evaluator"],
  ["responseHandlerFieldEvaluators", "response-handler-field-evaluator"],
  ["events", "event-handler"],
  ["routes", "route"],
  ["views", "view"],
  ["models", "model-handler"],
  ["connectorSources", "connector-ingress"],
]);

const NAME_KEYS: Record<RuntimeSurfaceKind, readonly string[]> = {
  action: ["name"],
  subaction: ["name"],
  provider: ["name"],
  service: ["serviceType", "name"],
  evaluator: ["name"],
  "response-handler-evaluator": ["name"],
  "response-handler-field-evaluator": ["name"],
  "event-handler": ["eventName", "name"],
  route: ["path", "name"],
  view: ["id", "path", "label"],
  "model-handler": ["modelType", "name"],
  "connector-ingress": ["source", "name"],
  "connector-egress": ["source", "name"],
  "scheduled-worker": ["name", "id"],
  queue: ["queue", "name", "binding"],
  "native-bridge": ["name", "id"],
  "cloud-service": ["name"],
};

const EXECUTABLE_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs"];

function walkFiles(
  root: string,
  predicate: (file: string) => boolean,
): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      if (
        entry === "node_modules" ||
        entry === "dist" ||
        entry === "build" ||
        entry === ".turbo" ||
        entry === "coverage"
      ) {
        continue;
      }
      const full = path.join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) visit(full);
      else if (predicate(full)) files.push(full);
    }
  };
  visit(root);
  return files;
}

function isProductionTypeScript(file: string): boolean {
  if (
    !/\.(?:ts|tsx)$/.test(file) ||
    /\.(?:test|spec)\.(?:ts|tsx)$/.test(file)
  ) {
    return false;
  }
  const segments = file.split(path.sep);
  return !segments.some((segment) =>
    ["__tests__", "test", "tests", "fixtures"].includes(segment),
  );
}

function toRepoPath(file: string): string {
  return path
    .relative(RUNTIME_SURFACE_REPO_ROOT, file)
    .split(path.sep)
    .join("/");
}

function normalizeName(value: string): string {
  const normalized = value
    .replace(/^['"`]|['"`]$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || "anonymous";
}

function stableToken(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9._:/-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 180);
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function collectExportConditions(value: unknown, out: Set<string>): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (["node", "bun", "browser", "worker", "react-native"].includes(key)) {
      out.add(key);
    }
    collectExportConditions(nested, out);
  }
}

function packageContext(packageDir: string): PackageContext | null {
  const file = path.join(packageDir, "package.json");
  if (!existsSync(file)) return null;
  const manifest = readJson(file);
  if (typeof manifest.name !== "string") return null;
  const runtime = new Set<string>();
  collectExportConditions(manifest.exports, runtime);
  const engines = manifest.engines;
  if (engines && typeof engines === "object" && !Array.isArray(engines)) {
    for (const [name, version] of Object.entries(engines)) {
      if (typeof version === "string") runtime.add(`${name}${version}`);
    }
  }
  const platforms = new Set<string>([
    ...strings(manifest.os),
    ...strings(manifest.cpu).map((cpu) => `cpu:${cpu}`),
  ]);
  const rel = toRepoPath(packageDir);
  if (rel.includes("plugin-native-") || rel.startsWith("packages/native/")) {
    platforms.add("native-host");
  }
  const dependencyObjects = [
    manifest.dependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
  ];
  const dependencies = new Set<string>();
  for (const object of dependencyObjects) {
    if (!object || typeof object !== "object" || Array.isArray(object))
      continue;
    for (const name of Object.keys(object)) {
      if (!name.startsWith("@elizaos/") && name !== "elizaos") {
        dependencies.add(name);
      }
    }
  }
  return {
    dir: rel,
    packageName: manifest.name,
    owner: manifest.name,
    runtimeRequirements: [...runtime].sort(),
    platformRequirements: [...platforms].sort(),
    externalDependencies: [...dependencies].sort(),
  };
}

function resolveModule(from: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(from), specifier);
  const withoutJs = base.replace(/\.(?:m?js|cjs)$/, "");
  const candidates = [
    base,
    ...EXECUTABLE_EXTENSIONS.map((ext) => `${withoutJs}${ext}`),
    ...EXECUTABLE_EXTENSIONS.map((ext) => path.join(base, `index${ext}`)),
  ];
  return (
    candidates.find(
      (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
    ) ?? null
  );
}

function unitFor(file: string, units: Map<string, SourceUnit>): SourceUnit {
  const absolute = path.resolve(file);
  const cached = units.get(absolute);
  if (cached) return cached;
  const source = readFileSync(absolute, "utf8");
  const ast = ts.createSourceFile(
    absolute,
    source,
    ts.ScriptTarget.Latest,
    true,
    absolute.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const declarations = new Map<string, ts.Node>();
  const imports = new Map<string, { imported: string; file: string }>();
  for (const statement of ast.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name))
          declarations.set(declaration.name.text, declaration);
      }
    } else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement)) &&
      statement.name
    ) {
      declarations.set(statement.name.text, statement);
    } else if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const target = resolveModule(absolute, statement.moduleSpecifier.text);
      if (!target || !statement.importClause) continue;
      if (statement.importClause.name) {
        imports.set(statement.importClause.name.text, {
          imported: "default",
          file: target,
        });
      }
      const bindings = statement.importClause.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          imports.set(element.name.text, {
            imported: element.propertyName?.text ?? element.name.text,
            file: target,
          });
        }
      }
    }
  }
  const unit = { file: absolute, source, ast, declarations, imports };
  units.set(absolute, unit);
  return unit;
}

function propertyName(node: ts.PropertyName | undefined): string | null {
  if (!node) return null;
  if (
    ts.isIdentifier(node) ||
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node)
  ) {
    return node.text;
  }
  if (ts.isComputedPropertyName(node)) {
    const expression = unwrap(node.expression);
    if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
    if (ts.isIdentifier(expression)) return expression.text;
    return literalText(expression);
  }
  return null;
}

function literalText(node: ts.Node): string | null {
  if (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isNumericLiteral(node)
  ) {
    return node.text;
  }
  return null;
}

function pluginTyped(node: ts.Node): boolean {
  if (ts.isVariableDeclaration(node)) {
    const type = node.type?.getText() ?? "";
    if (/(?:^|\W)Plugin(?:\W|$)/.test(type)) return true;
    if (node.initializer && ts.isSatisfiesExpression(node.initializer)) {
      return /(?:^|\W)Plugin(?:\W|$)/.test(node.initializer.type.getText());
    }
  }
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  ) {
    return /(?:^|\W)Plugin(?:\W|$)/.test(node.type?.getText() ?? "");
  }
  return false;
}

function unwrap(node: ts.Node): ts.Node {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function resolveIdentifier(
  name: string,
  unit: SourceUnit,
  context: ExtractionContext,
): { node: ts.Node; unit: SourceUnit } | null {
  const local = unit.declarations.get(name);
  if (local) return { node: local, unit };
  const imported = unit.imports.get(name);
  if (!imported) return null;
  const target = unitFor(imported.file, context.units);
  if (imported.imported === "default") {
    for (const statement of target.ast.statements) {
      if (ts.isExportAssignment(statement))
        return { node: statement.expression, unit: target };
      if (
        ts.isExportDeclaration(statement) &&
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause)
      ) {
        const element = statement.exportClause.elements.find(
          (entry) => entry.name.text === "default",
        );
        if (element) {
          const declaration = target.declarations.get(
            element.propertyName?.text ?? element.name.text,
          );
          if (declaration) return { node: declaration, unit: target };
        }
      }
    }
  }
  const declaration = target.declarations.get(imported.imported);
  return declaration ? { node: declaration, unit: target } : null;
}

function nearestLocalDeclaration(
  name: string,
  before: ts.Node,
  unit: SourceUnit,
): ts.Node | null {
  let nearest: ts.Node | null = null;
  const visit = (candidate: ts.Node): void => {
    if (candidate.pos >= before.pos) return;
    if (
      ((ts.isVariableDeclaration(candidate) ||
        ts.isParameter(candidate) ||
        ts.isFunctionDeclaration(candidate)) &&
        candidate.name &&
        ts.isIdentifier(candidate.name) &&
        candidate.name.text === name) ||
      (ts.isClassDeclaration(candidate) && candidate.name?.text === name)
    ) {
      if (!nearest || candidate.pos > nearest.pos) nearest = candidate;
    }
    ts.forEachChild(candidate, visit);
  };
  visit(unit.ast);
  return nearest;
}

function nodeInitializer(node: ts.Node): ts.Node | null {
  if (ts.isVariableDeclaration(node)) return node.initializer ?? null;
  if (ts.isPropertyAssignment(node)) return node.initializer;
  if (ts.isExportAssignment(node)) return node.expression;
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  ) {
    if (!node.body) return null;
    if (ts.isBlock(node.body)) {
      const returned = node.body.statements.find(ts.isReturnStatement);
      return returned?.expression ?? null;
    }
    return node.body;
  }
  return node;
}

function resolvedScalar(
  node: ts.Node,
  unit: SourceUnit,
  context: ExtractionContext,
): string | null {
  const current = unwrap(nodeInitializer(node) ?? node);
  const literal = literalText(current);
  if (literal !== null) return literal;
  if (ts.isIdentifier(current)) {
    const resolved = resolveIdentifier(current.text, unit, context);
    return resolved
      ? resolvedScalar(resolved.node, resolved.unit, context)
      : null;
  }
  if (ts.isPropertyAccessExpression(current)) return current.name.text;
  return null;
}

function nameFromObject(
  object: ts.ObjectLiteralExpression,
  kind: RuntimeSurfaceKind,
  unit: SourceUnit,
  context: ExtractionContext,
): string | null {
  for (const key of NAME_KEYS[kind]) {
    const property = object.properties.find(
      (candidate): candidate is ts.PropertyAssignment =>
        ts.isPropertyAssignment(candidate) &&
        propertyName(candidate.name) === key,
    );
    if (!property) continue;
    const value = resolvedScalar(property.initializer, unit, context);
    if (value) return value;
  }
  return null;
}

function staticClassServiceType(node: ts.ClassDeclaration): string | null {
  for (const member of node.members) {
    if (
      !ts.isPropertyDeclaration(member) ||
      propertyName(member.name) !== "serviceType"
    )
      continue;
    if (
      !member.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword,
      )
    )
      continue;
    if (member.initializer) return literalText(unwrap(member.initializer));
  }
  return null;
}

function expressionIdentity(node: ts.Node, unit: SourceUnit): string {
  const text = node.getText(unit.ast).replace(/\s+/g, " ").trim();
  return normalizeName(text.slice(0, 180));
}

function extractExplicitSubactions(
  object: ts.ObjectLiteralExpression,
  unit: SourceUnit,
  context: ExtractionContext,
): string[] {
  const names = new Set<string>();
  const property = object.properties.find(
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate) &&
      propertyName(candidate.name) === "subActions",
  );
  if (!property) return [];
  const current = unwrap(property.initializer);
  if (ts.isArrayLiteralExpression(current)) {
    for (const element of current.elements) {
      const scalar = resolvedScalar(element, unit, context);
      if (scalar) names.add(scalar);
      else {
        const resolved = resolveObject(element, unit, context);
        const name = resolved
          ? nameFromObject(resolved.object, "action", resolved.unit, context)
          : null;
        if (name) names.add(name);
      }
    }
  }
  return [...names].sort();
}

function extractPromotedSubactions(
  object: ts.ObjectLiteralExpression,
  unit: SourceUnit,
  context: ExtractionContext,
): string[] {
  const parametersProperty = object.properties.find(
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate) &&
      propertyName(candidate.name) === "parameters",
  );
  if (!parametersProperty) return [];
  const parameterEntries = extractEntries(
    parametersProperty.initializer,
    unit,
    "subaction",
    context,
  );
  const names = new Set<string>();
  for (const entry of parameterEntries) {
    if (!entry.object) continue;
    const parameterName = nameFromObject(
      entry.object,
      "subaction",
      unit,
      context,
    );
    if (
      !parameterName ||
      !["action", "subaction", "op", "operation", "verb"].includes(
        parameterName,
      )
    ) {
      continue;
    }
    const schema = entry.object.properties.find(
      (candidate): candidate is ts.PropertyAssignment =>
        ts.isPropertyAssignment(candidate) &&
        propertyName(candidate.name) === "schema",
    );
    if (!schema) continue;
    const schemaObject = resolveObject(schema.initializer, unit, context);
    if (!schemaObject) continue;
    const enumProperty = schemaObject.object.properties.find(
      (candidate): candidate is ts.PropertyAssignment =>
        ts.isPropertyAssignment(candidate) &&
        propertyName(candidate.name) === "enum",
    );
    if (!enumProperty) continue;
    const enumEntries = extractEntries(
      enumProperty.initializer,
      schemaObject.unit,
      "subaction",
      context,
    );
    for (const enumEntry of enumEntries) names.add(enumEntry.name);
  }
  return [...names].sort();
}

function promotedSubactionsIn(
  node: ts.Node,
  unit: SourceUnit,
  context: ExtractionContext,
): Array<{ name: string; sourceFile: string }> {
  const rows: Array<{ name: string; sourceFile: string }> = [];
  const visit = (candidate: ts.Node): void => {
    if (
      ts.isCallExpression(candidate) &&
      expressionIdentity(candidate.expression, unit).endsWith(
        "promoteSubactionsToActions",
      ) &&
      candidate.arguments[0]
    ) {
      const resolved = resolveObject(candidate.arguments[0], unit, context);
      const parent = resolved
        ? (nameFromObject(resolved.object, "action", resolved.unit, context) ??
          expressionIdentity(candidate.arguments[0], unit))
        : expressionIdentity(candidate.arguments[0], unit);
      if (resolved) {
        for (const subaction of extractPromotedSubactions(
          resolved.object,
          resolved.unit,
          context,
        )) {
          rows.push({
            name: `${parent}_${subaction}`,
            sourceFile: resolved.unit.file,
          });
        }
      }
    }
    ts.forEachChild(candidate, visit);
  };
  visit(node);
  return rows;
}

function resolveObject(
  node: ts.Node,
  unit: SourceUnit,
  context: ExtractionContext,
): { object: ts.ObjectLiteralExpression; unit: SourceUnit } | null {
  const current = unwrap(nodeInitializer(node) ?? node);
  if (ts.isObjectLiteralExpression(current)) return { object: current, unit };
  if (ts.isIdentifier(current)) {
    const resolved = resolveIdentifier(current.text, unit, context);
    return resolved
      ? resolveObject(resolved.node, resolved.unit, context)
      : null;
  }
  if (ts.isCallExpression(current) && ts.isIdentifier(current.expression)) {
    const resolved = resolveIdentifier(current.expression.text, unit, context);
    return resolved
      ? resolveObject(resolved.node, resolved.unit, context)
      : null;
  }
  return null;
}

function extractEntries(
  node: ts.Node,
  unit: SourceUnit,
  kind: RuntimeSurfaceKind,
  context: ExtractionContext,
): Array<{
  name: string;
  sourceFile: string;
  object?: ts.ObjectLiteralExpression;
}> {
  const key = `${unit.file}:${node.pos}:${node.end}:${kind}`;
  if (context.seen.has(key)) return [];
  context.seen.add(key);
  const current = unwrap(nodeInitializer(node) ?? node);
  if (ts.isArrayLiteralExpression(current)) {
    return current.elements.flatMap((element) => {
      if (ts.isSpreadElement(element))
        return extractEntries(element.expression, unit, kind, context);
      return extractEntries(element, unit, kind, context);
    });
  }
  if (ts.isObjectLiteralExpression(current)) {
    if (kind === "event-handler" || kind === "model-handler") {
      const directName = nameFromObject(current, kind, unit, context);
      if (!directName) {
        return current.properties.flatMap((property) => {
          if (ts.isSpreadAssignment(property))
            return extractEntries(property.expression, unit, kind, context);
          const name = propertyName(property.name);
          return name ? [{ name, sourceFile: unit.file, object: current }] : [];
        });
      }
    }
    return [
      {
        name:
          nameFromObject(current, kind, unit, context) ??
          expressionIdentity(current, unit),
        sourceFile: unit.file,
        object: current,
      },
    ];
  }
  if (ts.isIdentifier(current)) {
    const resolved = resolveIdentifier(current.text, unit, context);
    if (resolved) {
      const resolvedNode = nodeInitializer(resolved.node) ?? resolved.node;
      if (ts.isClassDeclaration(resolved.node) && kind === "service") {
        return [
          {
            name: staticClassServiceType(resolved.node) ?? current.text,
            sourceFile: resolved.unit.file,
          },
        ];
      }
      const nested = extractEntries(resolvedNode, resolved.unit, kind, context);
      if (nested.length > 0) return nested;
    }
    return [{ name: current.text, sourceFile: unit.file }];
  }
  if (ts.isCallExpression(current)) {
    const callee = expressionIdentity(current.expression, unit);
    if (
      ts.isPropertyAccessExpression(current.expression) &&
      current.expression.name.text === "map"
    ) {
      const mappedExpression = current.expression.expression;
      const sourceEntries = extractEntries(
        mappedExpression,
        unit,
        kind,
        context,
      );
      if (
        sourceEntries.length > 0 &&
        !sourceEntries.every(
          (entry) => entry.name === expressionIdentity(mappedExpression, unit),
        )
      ) {
        return sourceEntries;
      }
      return [
        {
          name: `dynamic:${expressionIdentity(mappedExpression, unit)}`,
          sourceFile: unit.file,
        },
      ];
    }
    if (callee.endsWith("promoteSubactionsToActions") && current.arguments[0]) {
      const parentEntries = extractEntries(
        current.arguments[0],
        unit,
        "action",
        context,
      );
      return parentEntries;
    }
    const resolved = ts.isIdentifier(current.expression)
      ? resolveIdentifier(current.expression.text, unit, context)
      : null;
    if (resolved) {
      const nested = extractEntries(
        resolved.node,
        resolved.unit,
        kind,
        context,
      );
      if (nested.length > 0) return nested;
    }
    return [{ name: expressionIdentity(current, unit), sourceFile: unit.file }];
  }
  if (ts.isPropertyAccessExpression(current)) {
    return [{ name: current.name.text, sourceFile: unit.file }];
  }
  return [{ name: expressionIdentity(current, unit), sourceFile: unit.file }];
}

function pluginObjects(
  unit: SourceUnit,
): Array<{ object: ts.ObjectLiteralExpression; unit: SourceUnit }> {
  const roots: Array<{ object: ts.ObjectLiteralExpression; unit: SourceUnit }> =
    [];
  const visit = (node: ts.Node): void => {
    if (pluginTyped(node)) {
      const resolved = resolveObject(node, unit, {
        units: new Map([[unit.file, unit]]),
        seen: new Set(),
      });
      if (resolved) roots.push(resolved);
    }
    ts.forEachChild(node, visit);
  };
  visit(unit.ast);
  return roots;
}

function extractPluginSurfaces(
  packageDir: string,
  packageInfo: PackageContext,
): RawSurface[] {
  const files = walkFiles(packageDir, isProductionTypeScript);
  const units = new Map<string, SourceUnit>();
  for (const file of files) {
    // Only files that can contain a typed Plugin root enter the first pass;
    // imports and spreads are resolved lazily from that authoritative root.
    if (/\bPlugin\b/.test(readFileSync(file, "utf8"))) unitFor(file, units);
  }
  const context: ExtractionContext = { units, seen: new Set() };
  const raw: RawSurface[] = [];
  const rootKeys = new Set<string>();
  for (const unit of units.values()) {
    for (const root of pluginObjects(unit)) {
      const rootKey = `${root.unit.file}:${root.object.pos}:${root.object.end}`;
      if (rootKeys.has(rootKey)) continue;
      rootKeys.add(rootKey);
      for (const property of root.object.properties) {
        if (ts.isSpreadAssignment(property)) {
          const resolved = resolveObject(
            property.expression,
            root.unit,
            context,
          );
          if (resolved) {
            for (const nested of resolved.object.properties) {
              if (!ts.isPropertyAssignment(nested)) continue;
              const field = propertyName(nested.name);
              const kind = field ? PLUGIN_FIELDS.get(field) : undefined;
              if (!field || !kind) continue;
              for (const entry of extractEntries(
                nested.initializer,
                resolved.unit,
                kind,
                context,
              )) {
                raw.push({
                  kind,
                  name: entry.name,
                  sourcePath: toRepoPath(entry.sourceFile),
                  registrationField: field,
                  package: packageInfo,
                });
              }
            }
          }
          continue;
        }
        if (!ts.isPropertyAssignment(property)) continue;
        const field = propertyName(property.name);
        const kind = field ? PLUGIN_FIELDS.get(field) : undefined;
        if (!field || !kind) continue;
        for (const entry of extractEntries(
          property.initializer,
          root.unit,
          kind,
          context,
        )) {
          raw.push({
            kind,
            name: entry.name,
            sourcePath: toRepoPath(entry.sourceFile),
            registrationField: field,
            package: packageInfo,
          });
          if (kind === "action" && entry.object) {
            for (const subaction of extractExplicitSubactions(
              entry.object,
              root.unit,
              context,
            )) {
              raw.push({
                kind: "subaction",
                name: subaction,
                sourcePath: toRepoPath(entry.sourceFile),
                registrationField: "actions[].parameters[].schema.enum",
                package: packageInfo,
              });
            }
          }
        }
        if (kind === "action") {
          for (const entry of promotedSubactionsIn(
            property.initializer,
            root.unit,
            context,
          )) {
            raw.push({
              kind: "subaction",
              name: entry.name,
              sourcePath: toRepoPath(entry.sourceFile),
              registrationField: "promoteSubactionsToActions",
              package: packageInfo,
            });
          }
        }
      }
    }
  }
  return raw;
}

function collectCallRegisteredSurfaces(
  packageDir: string,
  packageInfo: PackageContext,
): RawSurface[] {
  const result: RawSurface[] = [];
  const files = walkFiles(packageDir, isProductionTypeScript);
  for (const file of files) {
    const units = new Map<string, SourceUnit>();
    const unit = unitFor(file, units);
    const { source, ast } = unit;
    const context: ExtractionContext = { units, seen: new Set() };
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(ast);
        const calleeName = ts.isIdentifier(node.expression)
          ? node.expression.text
          : ts.isPropertyAccessExpression(node.expression)
            ? node.expression.name.text
            : null;
        let kind: RuntimeSurfaceKind | null = null;
        const isMethodCall = ts.isPropertyAccessExpression(node.expression);
        const receiver = isMethodCall
          ? node.expression.expression.getText(ast)
          : "";
        const isRuntimeCall =
          isMethodCall && /(?:runtime|withRegistry)/i.test(receiver);
        if (
          isRuntimeCall &&
          calleeName !== null &&
          /^(?:registerConnector|registerMessageConnector|registerIngress|registerWebhook)$/.test(
            calleeName,
          )
        ) {
          kind = "connector-ingress";
        } else if (
          isRuntimeCall &&
          calleeName !== null &&
          /^(?:registerSendHandler|registerDelivery|registerEgress)$/.test(
            calleeName,
          )
        ) {
          kind = "connector-egress";
        } else if (isRuntimeCall && calleeName === "registerPostConnector") {
          kind = "connector-ingress";
        } else if (isRuntimeCall && calleeName === "registerAction") {
          kind = "action";
        } else if (isRuntimeCall && calleeName === "registerProvider") {
          kind = "provider";
        } else if (isRuntimeCall && calleeName === "registerService") {
          kind = "service";
        } else if (isRuntimeCall && calleeName === "registerEvaluator") {
          kind = "evaluator";
        } else if (
          isRuntimeCall &&
          calleeName === "registerResponseHandlerEvaluator"
        ) {
          kind = "response-handler-evaluator";
        } else if (
          isRuntimeCall &&
          calleeName === "registerResponseHandlerFieldEvaluator"
        ) {
          kind = "response-handler-field-evaluator";
        } else if (isRuntimeCall && calleeName === "registerModel") {
          kind = "model-handler";
        } else if (isRuntimeCall && calleeName === "registerEvent") {
          kind = "event-handler";
        } else if (
          calleeName !== null &&
          (/^registerNativePlugin$/i.test(calleeName) ||
            (/^registerPlugin$/i.test(calleeName) &&
              /from\s+["']@capacitor\/core["']/.test(source)))
        ) {
          kind = "native-bridge";
        } else if (
          isRuntimeCall &&
          calleeName !== null &&
          /^(?:register(?:Scheduled|Task|Cron).*Worker|registerWorker)$/i.test(
            calleeName,
          )
        ) {
          kind = "scheduled-worker";
        } else if (
          calleeName !== null &&
          /^(?:registerQueue|consumer|producer)$/i.test(calleeName) &&
          (/queue/i.test(calleeName) ||
            (isMethodCall && /queue/i.test(receiver)))
        ) {
          kind = "queue";
        }
        if (kind) {
          const firstArgument = node.arguments[0];
          const localArgument =
            firstArgument && ts.isIdentifier(unwrap(firstArgument))
              ? (nearestLocalDeclaration(
                  (unwrap(firstArgument) as ts.Identifier).text,
                  node,
                  unit,
                ) ?? firstArgument)
              : firstArgument;
          const registeredObject = localArgument
            ? resolveObject(localArgument, unit, context)
            : null;
          const registeredName = registeredObject
            ? nameFromObject(
                registeredObject.object,
                kind,
                registeredObject.unit,
                context,
              )
            : localArgument
              ? resolvedScalar(localArgument, unit, context)
              : null;
          result.push({
            kind,
            name:
              registeredName ??
              `dynamic:${expressionIdentity(firstArgument ?? node.expression, unit)}`,
            sourcePath: toRepoPath(file),
            registrationField: callee,
            package: packageInfo,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  return result;
}

function workspacePackageDirs(): string[] {
  const pluginRoot = path.join(RUNTIME_SURFACE_REPO_ROOT, "plugins");
  const dirs: string[] = [];
  for (const entry of readdirSync(pluginRoot).sort()) {
    const dir = path.join(pluginRoot, entry);
    if (
      entry.startsWith("plugin-") &&
      existsSync(path.join(dir, "package.json"))
    ) {
      dirs.push(dir);
    }
  }
  // These hosts contribute Plugin registrations directly. Cloud routes,
  // services and Worker bindings have their own production-config extractors
  // below so the inventory never parses the entire Cloud implementation tree.
  dirs.push(
    path.join(RUNTIME_SURFACE_REPO_ROOT, "packages/core"),
    path.join(RUNTIME_SURFACE_REPO_ROOT, "packages/agent"),
    path.join(RUNTIME_SURFACE_REPO_ROOT, "packages/app-core"),
  );
  return [...new Set(dirs)].sort();
}

function cloudRouteSurfaces(): RawSurface[] {
  const apiDir = path.join(RUNTIME_SURFACE_REPO_ROOT, "packages/cloud/api");
  const info = packageContext(apiDir);
  if (!info) return [];
  const files = walkFiles(
    apiDir,
    (file) =>
      path.basename(file) === "route.ts" &&
      !file.includes(`${path.sep}test${path.sep}`),
  );
  const rows: RawSurface[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const registrations = [
      ...source.matchAll(
        /\b(?:app|router|routes)\s*\.\s*(get|post|put|patch|delete|all)\s*\(\s*["'`]([^"'`]+)["'`]/gi,
      ),
    ].map((match) => ({ method: match[1].toUpperCase(), localPath: match[2] }));
    for (const match of source.matchAll(
      /export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b/g,
    )) {
      registrations.push({ method: match[1], localPath: "/" });
    }
    const routePath = `/${toRepoPath(path.dirname(file)).replace(/^packages\/cloud\/api\/?/, "")}`;
    if (registrations.length === 0 && /export\s+default\s+\w+/.test(source)) {
      registrations.push({ method: "ANY", localPath: "/" });
    }
    for (const registration of registrations) {
      const localPath =
        registration.localPath === "/" ? "" : registration.localPath;
      rows.push({
        kind: routePath.includes("/cron/") ? "scheduled-worker" : "route",
        name: `${registration.method} ${routePath}${localPath}`,
        sourcePath: toRepoPath(file),
        registrationField:
          registration.method === "ANY"
            ? "default Hono router export"
            : `Hono.${registration.method.toLowerCase()}`,
        package: info,
      });
    }
  }
  return rows;
}

function cloudServiceSurfaces(): RawSurface[] {
  const root = path.join(RUNTIME_SURFACE_REPO_ROOT, "packages/cloud/services");
  const rows: RawSurface[] = [];
  for (const entry of readdirSync(root).sort()) {
    if (entry.startsWith("_")) continue;
    const dir = path.join(root, entry);
    if (!statSync(dir).isDirectory()) continue;
    const info = packageContext(dir);
    if (!info) continue;
    const manifest = readJson(path.join(dir, "package.json"));
    const candidates = [
      typeof manifest.main === "string" ? manifest.main : null,
      typeof manifest.main === "string"
        ? manifest.main.replace(/^dist\//, "src/").replace(/\.js$/, ".ts")
        : null,
      "src/index.ts",
      "index.ts",
      "pepr.ts",
    ].filter((candidate): candidate is string => Boolean(candidate));
    const entrypoint =
      candidates.find((candidate) => existsSync(path.join(dir, candidate))) ??
      walkFiles(
        dir,
        (file) => file.endsWith(".ts") && !file.endsWith(".test.ts"),
      )[0]?.slice(dir.length + 1);
    if (!entrypoint) continue;
    rows.push({
      kind: "cloud-service",
      name: info.packageName,
      sourcePath: toRepoPath(path.join(dir, entrypoint)),
      registrationField: "package.json#main",
      package: info,
    });
  }
  return rows;
}

function workerBindingSurfaces(): RawSurface[] {
  const files = walkFiles(
    path.join(RUNTIME_SURFACE_REPO_ROOT, "packages/cloud"),
    (file) => /^wrangler\.(?:toml|jsonc?|yaml|yml)$/.test(path.basename(file)),
  );
  const rows: RawSurface[] = [];
  for (const file of files) {
    const info = packageContext(path.dirname(file));
    if (!info) continue;
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(
      /(?:queue|binding|name)\s*=\s*["']([^"']+)["']/g,
    )) {
      if (
        !/queue|producer|consumer/i.test(
          source.slice(Math.max(0, match.index - 200), match.index + 200),
        )
      )
        continue;
      rows.push({
        kind: "queue",
        name: match[1],
        sourcePath: toRepoPath(file),
        registrationField: "wrangler queue binding",
        package: info,
      });
    }
    for (const match of source.matchAll(/crons?\s*=\s*\[([^\]]+)\]/g)) {
      for (const cron of match[1].matchAll(/["']([^"']+)["']/g)) {
        rows.push({
          kind: "scheduled-worker",
          name: cron[1],
          sourcePath: toRepoPath(file),
          registrationField: "wrangler triggers.crons",
          package: info,
        });
      }
    }
  }
  return rows;
}

function scenarioRecords(): ScenarioRecord[] {
  const roots = [
    path.join(
      RUNTIME_SURFACE_REPO_ROOT,
      "packages/scenario-runner/test/scenarios",
    ),
    path.join(RUNTIME_SURFACE_REPO_ROOT, "packages/test/scenarios"),
    path.join(RUNTIME_SURFACE_REPO_ROOT, "plugins"),
  ];
  const records: ScenarioRecord[] = [];
  for (const root of roots) {
    for (const file of walkFiles(root, (candidate) =>
      candidate.endsWith(".scenario.ts"),
    )) {
      const source = readFileSync(file, "utf8");
      const id = source.match(/\bid\s*:\s*["'`]([^"'`]+)["'`]/)?.[1];
      if (!id) continue;
      const laneText =
        source.match(/\blane\s*:\s*["'`]([^"'`]+)["'`]/)?.[1] ?? "";
      const deterministicCorpus = file.includes(
        `${path.sep}scenario-runner${path.sep}test${path.sep}scenarios`,
      );
      const lane =
        deterministicCorpus || laneText === "pr-deterministic"
          ? "deterministic"
          : "live";
      const pluginsBlock =
        source.match(
          /requires\s*:\s*{[\s\S]*?plugins\s*:\s*\[([\s\S]*?)\]/,
        )?.[1] ?? "";
      const plugins = [...pluginsBlock.matchAll(/["'`]([^"'`]+)["'`]/g)].map(
        (match) => match[1],
      );
      records.push({ id, file: toRepoPath(file), source, plugins, lane });
    }
  }
  return records;
}

function cloudE2eFiles(): Array<{ file: string; source: string }> {
  const roots = [
    path.join(RUNTIME_SURFACE_REPO_ROOT, "packages/cloud/e2e"),
    path.join(RUNTIME_SURFACE_REPO_ROOT, "packages/cloud/api/test/e2e"),
  ];
  return roots.flatMap((root) =>
    walkFiles(root, (file) => /\.(?:test|spec)\.(?:ts|tsx)$/.test(file)).map(
      (file) => ({
        file: toRepoPath(file),
        source: readFileSync(file, "utf8"),
      }),
    ),
  );
}

function pluginAliases(row: RawSurface): string[] {
  const base = path.basename(row.package.dir);
  return [row.package.packageName, base, base.replace(/^plugin-/, "")];
}

function containsBoundarySignal(source: string, surfaceName: string): boolean {
  const candidates = [
    surfaceName,
    surfaceName.split(/\s+/).slice(-1)[0],
  ].filter((value) => value.length >= 3);
  return candidates.some((candidate) => source.includes(candidate));
}

function defaultWorkstream(
  kind: RuntimeSurfaceKind,
): RuntimeSurfaceRow["workstream"] {
  if (kind === "model-handler") return "#22901";
  if (["service", "event-handler", "scheduled-worker", "queue"].includes(kind))
    return "#22902";
  if (["provider", "connector-ingress", "connector-egress"].includes(kind))
    return "#22899";
  if (kind === "route" || kind === "cloud-service") return "#22904";
  return "#22898";
}

function uniqueRawSurfaces(rows: RawSurface[]): RawSurface[] {
  const byId = new Map<string, RawSurface>();
  for (const row of rows) {
    const id = [
      row.package.packageName,
      row.kind,
      stableToken(row.name),
      row.sourcePath,
    ].join(":");
    byId.set(id, row);
  }
  return [...byId.values()].sort((a, b) => {
    const left = `${a.package.packageName}:${a.kind}:${a.name}:${a.sourcePath}`;
    const right = `${b.package.packageName}:${b.kind}:${b.name}:${b.sourcePath}`;
    return left.localeCompare(right);
  });
}

export function discoverRuntimeSurfaces(): RawSurface[] {
  const rows: RawSurface[] = [];
  for (const dir of workspacePackageDirs()) {
    const info = packageContext(dir);
    if (!info) continue;
    rows.push(...extractPluginSurfaces(dir, info));
    rows.push(...collectCallRegisteredSurfaces(dir, info));
  }
  rows.push(
    ...cloudRouteSurfaces(),
    ...cloudServiceSurfaces(),
    ...workerBindingSurfaces(),
  );
  return uniqueRawSurfaces(rows);
}

export function loadRuntimeSurfaceBaseline(
  file = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "runtime-surface-baseline.json",
  ),
): RuntimeSurfaceBaseline {
  const parsed = readJson(file) as unknown as RuntimeSurfaceBaseline;
  if (
    parsed.schema !== RUNTIME_SURFACE_SCHEMA ||
    typeof parsed.classifications !== "object"
  ) {
    throw new Error(`Invalid runtime-surface baseline schema in ${file}`);
  }
  return parsed;
}

export function buildRuntimeSurfaceInventory(
  options: {
    baseline?: RuntimeSurfaceBaseline;
    generatedAt?: string;
    sourceRevision?: string;
  } = {},
): RuntimeSurfaceInventory {
  const baseline = options.baseline ?? loadRuntimeSurfaceBaseline();
  const scenarios = scenarioRecords();
  const cloudCells = cloudE2eFiles();
  const raw = discoverRuntimeSurfaces();
  const rows = raw.map((surface): RuntimeSurfaceRow => {
    const id = [
      surface.package.packageName,
      surface.kind,
      stableToken(surface.name),
      stableToken(surface.sourcePath),
    ].join(":");
    const aliases = pluginAliases(surface);
    const matchingScenarios = scenarios.filter(
      (scenario) =>
        scenario.plugins.some((plugin) => aliases.includes(plugin)) &&
        containsBoundarySignal(scenario.source, surface.name),
    );
    const matchingCells = cloudCells.filter((cell) =>
      containsBoundarySignal(cell.source, surface.name),
    );
    const deterministic = matchingScenarios.filter(
      (scenario) => scenario.lane === "deterministic",
    );
    const live = matchingScenarios.filter(
      (scenario) => scenario.lane === "live",
    );
    const boundaryArtifacts = [
      ...new Set([
        ...deterministic.map((scenario) => scenario.file),
        ...matchingCells.map((cell) => cell.file),
      ]),
    ].sort();
    const covered = boundaryArtifacts.length > 0;
    const classification = baseline.classifications[id];
    const status: RuntimeSurfaceStatus = covered
      ? "covered"
      : (classification?.status ?? "exempt");
    const reason = covered
      ? "Executable keyless scenario or Cloud E2E cell contains the exact registered boundary signal."
      : (classification?.reason ??
        "UNCLASSIFIED: new production surface requires an explicit disposition.");
    const providerQualified = status === "provider-qualified-only";
    const mockAvailable = deterministic.length > 0;
    const partialMock = !mockAvailable && matchingCells.length > 0;
    return {
      id,
      kind: surface.kind,
      surfaceName: normalizeName(surface.name),
      owner: surface.package.owner,
      packageName: surface.package.packageName,
      packageDir: surface.package.dir,
      sourcePath: surface.sourcePath,
      registrationField: surface.registrationField,
      runtimeRequirements: surface.package.runtimeRequirements,
      platformRequirements: surface.package.platformRequirements,
      externalDependencies: surface.package.externalDependencies,
      mockAvailability: mockAvailable
        ? "available"
        : partialMock
          ? "partial"
          : "missing",
      mockFidelity: mockAvailable
        ? "Production runtime registration is exercised and the exact surface signal is asserted; protocol fidelity remains owned by the referenced scenario."
        : partialMock
          ? "A Cloud E2E cell names this boundary, but no deterministic scenario owns it."
          : "No executable deterministic artifact names this registered boundary.",
      resetSupport: mockAvailable ? "partial" : "missing",
      deterministicScenarioIds: deterministic
        .map((scenario) => scenario.id)
        .sort(),
      liveModelScenarioIds: live.map((scenario) => scenario.id).sort(),
      cloudE2eCells: matchingCells.map((cell) => cell.file).sort(),
      evidenceClass: covered
        ? "synthetic"
        : providerQualified
          ? "provider-qualified"
          : "none",
      boundaryArtifacts,
      boundarySignals: covered ? [normalizeName(surface.name)] : [],
      workstream: defaultWorkstream(surface.kind),
      status,
      reason,
    };
  });
  const byKind: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const gaps = {
    byOwner: {} as Record<string, string[]>,
    byExternalDependency: {} as Record<string, string[]>,
    byScenarioLane: {} as Record<string, string[]>,
    byWorkstream: {} as Record<string, string[]>,
  };
  const appendGap = (
    group: Record<string, string[]>,
    key: string,
    id: string,
  ): void => {
    const ids = group[key] ?? [];
    ids.push(id);
    group[key] = ids;
  };
  for (const row of rows) {
    byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    if (row.status === "covered") continue;
    appendGap(gaps.byOwner, row.owner, row.id);
    const dependencies =
      row.externalDependencies.length > 0 ? row.externalDependencies : ["none"];
    for (const dependency of dependencies) {
      appendGap(gaps.byExternalDependency, dependency, row.id);
    }
    appendGap(gaps.byScenarioLane, "missing-deterministic", row.id);
    appendGap(gaps.byWorkstream, row.workstream, row.id);
  }
  for (const group of [
    gaps.byOwner,
    gaps.byExternalDependency,
    gaps.byScenarioLane,
    gaps.byWorkstream,
  ]) {
    for (const ids of Object.values(group)) ids.sort();
  }
  const packages = workspacePackageDirs()
    .map(packageContext)
    .filter((entry): entry is PackageContext => entry !== null)
    .map((entry): RuntimePackageRecord => {
      const registeredSurfaceIds = rows
        .filter((row) => row.packageDir === entry.dir)
        .map((row) => row.id)
        .sort();
      const hasSurfaces = registeredSurfaceIds.length > 0;
      return {
        owner: entry.owner,
        packageName: entry.packageName,
        packageDir: entry.dir,
        runtimeRequirements: entry.runtimeRequirements,
        platformRequirements: entry.platformRequirements,
        externalDependencies: entry.externalDependencies,
        registeredSurfaceIds,
        registrationState: hasSurfaces
          ? "registered-surfaces"
          : "no-runtime-registration",
        reason: hasSurfaces
          ? "Production registration or export analysis found the listed canonical runtime surfaces."
          : "The maintained package exports no Plugin field, runtime registration call, host route, queue, worker, or native bridge registration.",
      };
    });
  return {
    schema: RUNTIME_SURFACE_SCHEMA,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    sourceRevision: options.sourceRevision ?? baseline.generatedFrom,
    packages,
    rows,
    summary: { total: rows.length, byKind, byStatus },
    gaps,
  };
}

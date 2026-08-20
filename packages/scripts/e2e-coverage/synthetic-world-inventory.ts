/**
 * Builds the canonical synthetic-world inventory from production plugin and host registrations.
 * The scanner follows TypeScript declarations, imports, spreads, factories, and array composition
 * without importing plugins, so native-only and credentialed packages remain safe to audit in CI.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { PLUGIN_ROUTE_COVERAGE } from "./manifest.ts";

export const SYNTHETIC_WORLD_SCHEMA = "eliza_synthetic_world_inventory_v1";

export const SURFACE_KINDS = [
  "action",
  "subaction",
  "provider",
  "service",
  "evaluator",
  "event",
  "route",
  "view",
  "model",
  "connector-ingress",
  "connector-egress",
  "worker",
  "queue",
  "native-bridge",
  "cloud-service",
] as const;

export type RuntimeSurfaceKind = (typeof SURFACE_KINDS)[number];
export type SyntheticWorldStatus =
  | "covered"
  | "exempt"
  | "platform-deferred"
  | "provider-qualified-only"
  | "unsupported-product";

export interface SurfaceRegistration {
  id: string;
  kind: RuntimeSurfaceKind;
  name: string;
  owner: string;
  packageName: string;
  source: string;
  platformRequirements: string[];
  externalDependencies: string[];
}

export interface SurfaceDisposition {
  status: SyntheticWorldStatus;
  reason: string;
  artifacts?: string[];
  /** Source strings proving the executable artifact crossed this surface's boundary. */
  boundarySignals?: string[];
  mockFidelity?: "none" | "shape" | "protocol" | "stateful";
  resetSupport?: "none" | "process" | "namespace" | "world-reset";
  deterministicScenarioIds?: string[];
  liveModelScenarioIds?: string[];
  cloudE2eCells?: string[];
  evidenceClass?: "simulated" | "live-model-over-mocks" | "provider-qualified";
  workstream?: string;
}

export interface SyntheticWorldRow
  extends SurfaceRegistration,
    SurfaceDisposition {}

export interface SyntheticWorldManifest {
  schema: typeof SYNTHETIC_WORLD_SCHEMA;
  dispositions: Record<string, SurfaceDisposition>;
}

export interface SyntheticWorldInventory {
  schema: typeof SYNTHETIC_WORLD_SCHEMA;
  generatedAt: string;
  rows: SyntheticWorldRow[];
  gaps: SyntheticWorldRow[];
  summary: {
    total: number;
    byKind: Record<string, number>;
    byStatus: Record<string, number>;
    byOwner: Record<string, number>;
    byDependency: Record<string, number>;
    byScenarioLane: Record<string, number>;
    byWorkstream: Record<string, number>;
    pluginPackages: {
      manifests: number;
      scanned: number;
      withoutRegisteredSurfaces: string[];
    };
  };
}

const PLUGIN_PROPERTIES: Partial<Record<string, RuntimeSurfaceKind>> = {
  actions: "action",
  providers: "provider",
  services: "service",
  evaluators: "evaluator",
  events: "event",
  routes: "route",
  views: "view",
  models: "model",
  connectorSources: "connector-ingress",
};

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const TEST_SEGMENTS = new Set([
  "test",
  "tests",
  "__tests__",
  "fixtures",
  "__mocks__",
]);

function walk(root: string, accept: (file: string) => boolean): string[] {
  if (!existsSync(root)) return [];
  const output: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", "dist", ".turbo", ".git"].includes(entry.name))
        continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && accept(full)) output.push(full);
    }
  };
  visit(root);
  return output.sort();
}

function productionTsFiles(root: string): string[] {
  return walk(root, (file) => {
    if (!SOURCE_EXTENSIONS.has(path.extname(file))) return false;
    if (/\.(test|spec|scenario)\.[cm]?tsx?$/.test(file)) return false;
    return !file.split(path.sep).some((segment) => TEST_SEGMENTS.has(segment));
  });
}

function packageName(packageDir: string): string {
  const manifest = path.join(packageDir, "package.json");
  if (!existsSync(manifest)) return path.basename(packageDir);
  const value = JSON.parse(readFileSync(manifest, "utf8")) as {
    name?: unknown;
  };
  return typeof value.name === "string"
    ? value.name
    : path.basename(packageDir);
}

function pluginPackageDirs(repoRoot: string): string[] {
  const root = path.join(repoRoot, "plugins");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        (entry.name.startsWith("plugin-") || entry.name.startsWith("app-")) &&
        existsSync(path.join(root, entry.name, "package.json")),
    )
    .map((entry) => path.join(root, entry.name))
    .sort();
}

function packageEntryPoints(packageDir: string): string[] {
  const candidates = new Set<string>();
  for (const base of [packageDir, path.join(packageDir, "src")]) {
    for (const entry of [
      "index.ts",
      "index.browser.ts",
      "index.node.ts",
      "plugin.ts",
      "edge.ts",
    ]) {
      const file = path.join(base, entry);
      if (existsSync(file)) candidates.add(file);
    }
  }
  const manifest = JSON.parse(
    readFileSync(path.join(packageDir, "package.json"), "utf8"),
  ) as {
    exports?: unknown;
  };
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      const normalized = value.replace(/^\.\//, "");
      if (/\.[cm]?tsx?$/.test(normalized)) {
        const file = path.join(packageDir, normalized);
        if (existsSync(file)) candidates.add(file);
      }
      return;
    }
    if (value && typeof value === "object") {
      for (const child of Object.values(value as Record<string, unknown>))
        visit(child);
    }
  };
  visit(manifest.exports);
  return [...candidates].sort();
}

export function auditPluginPackageCoverage(repoRoot: string): {
  manifests: string[];
  scanned: string[];
  omitted: string[];
} {
  const manifests = pluginPackageDirs(repoRoot).map((dir) =>
    path.basename(dir),
  );
  const scanned = pluginPackageDirs(repoRoot)
    .filter((dir) => packageEntryPoints(dir).length > 0)
    .map((dir) => path.basename(dir));
  const scannedSet = new Set(scanned);
  return {
    manifests,
    scanned,
    omitted: manifests.filter((entry) => !scannedSet.has(entry)),
  };
}

function propertyName(node: ts.PropertyName | undefined): string | null {
  if (!node) return null;
  if (
    ts.isIdentifier(node) ||
    ts.isStringLiteralLike(node) ||
    ts.isNumericLiteral(node)
  ) {
    return node.text;
  }
  if (
    ts.isComputedPropertyName(node) &&
    ts.isStringLiteralLike(node.expression)
  ) {
    return node.expression.text;
  }
  if (ts.isComputedPropertyName(node)) return node.expression.getText();
  return null;
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function declarationExpression(
  declaration: ts.Declaration,
): ts.Expression | null {
  if (
    ts.isVariableDeclaration(declaration) ||
    ts.isPropertyDeclaration(declaration)
  ) {
    return declaration.initializer ?? null;
  }
  if (ts.isExportAssignment(declaration)) return declaration.expression;
  return null;
}

const syntacticDeclarationCache = new Map<string, ts.Declaration[]>();
const parsedSourceCache = new Map<string, ts.SourceFile>();

function declarationsNamed(
  source: ts.SourceFile,
  name: string,
): ts.Declaration[] {
  const cacheKey = `${source.fileName}:${name}`;
  const cached = syntacticDeclarationCache.get(cacheKey);
  if (cached) return cached;
  const found: ts.Declaration[] = [];
  source.forEachChild(function visit(node) {
    if (
      (ts.isVariableDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isFunctionDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      found.push(node);
    }
    node.forEachChild(visit);
  });
  syntacticDeclarationCache.set(cacheKey, found);
  return found;
}

function parsedSource(file: string): ts.SourceFile {
  const cached = parsedSourceCache.get(file);
  if (cached) return cached;
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  parsedSourceCache.set(file, source);
  return source;
}

function resolveRelativeImport(
  source: ts.SourceFile,
  localName: string,
): ts.Declaration[] {
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    )
      continue;
    const clause = statement.importClause;
    const bindings = clause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const specifier = bindings.elements.find(
      (element) => element.name.text === localName,
    );
    if (!specifier || !statement.moduleSpecifier.text.startsWith(".")) continue;
    const importedName = specifier.propertyName?.text ?? specifier.name.text;
    const unresolved = path.resolve(
      path.dirname(source.fileName),
      statement.moduleSpecifier.text,
    );
    const candidates = [
      unresolved,
      unresolved.replace(/\.[cm]?js$/, ".ts"),
      unresolved.replace(/\.[cm]?js$/, ".tsx"),
      `${unresolved}.ts`,
      `${unresolved}.tsx`,
      path.join(unresolved, "index.ts"),
    ];
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      const found = declarationsNamed(parsedSource(candidate), importedName);
      if (found.length > 0) return found;
    }
  }
  return [];
}

function resolvedDeclarations(
  checker: ts.TypeChecker,
  expression: ts.Expression,
): ts.Declaration[] {
  const target = unwrap(expression);
  if (!ts.isIdentifier(target) && !ts.isPropertyAccessExpression(target))
    return [];
  const originalSymbol = checker.getSymbolAtLocation(
    ts.isPropertyAccessExpression(target) ? target.name : target,
  );
  let symbol = originalSymbol;
  if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    try {
      symbol = checker.getAliasedSymbol(symbol);
    } catch {
      return [];
    }
  }
  const declarations = symbol?.declarations ?? [];
  if (
    declarations.length > 0 &&
    declarations.some(
      (declaration) =>
        !ts.isImportSpecifier(declaration) &&
        !ts.isShorthandPropertyAssignment(declaration),
    )
  ) {
    return declarations;
  }
  const fallback = originalSymbol?.declarations ?? [];
  for (const declaration of fallback) {
    if (!ts.isImportSpecifier(declaration)) continue;
    const importDeclaration = declaration.parent.parent.parent;
    if (
      !ts.isImportDeclaration(importDeclaration) ||
      !ts.isStringLiteral(importDeclaration.moduleSpecifier)
    )
      continue;
    const specifier = importDeclaration.moduleSpecifier.text;
    if (!specifier.startsWith(".")) continue;
    const sourcePath = importDeclaration.getSourceFile().fileName;
    const unresolved = path.resolve(path.dirname(sourcePath), specifier);
    const candidates = [
      unresolved,
      unresolved.replace(/\.[cm]?js$/, ".ts"),
      unresolved.replace(/\.[cm]?js$/, ".tsx"),
      `${unresolved}.ts`,
      `${unresolved}.tsx`,
      path.join(unresolved, "index.ts"),
    ];
    const importedName = propertyName(
      declaration.propertyName ?? declaration.name,
    );
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      const found = declarationsNamed(
        parsedSource(candidate),
        importedName ?? "",
      );
      if (found.length > 0) return found;
    }
  }
  if (ts.isIdentifier(target)) {
    const source = target.getSourceFile();
    const local = declarationsNamed(source, target.text);
    if (local.length > 0) return local;
    const imported = resolveRelativeImport(source, target.text);
    if (imported.length > 0) return imported;
  }
  return declarations;
}

function expressionLabel(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  kind: RuntimeSurfaceKind,
): string {
  const node = unwrap(expression);
  if (ts.isObjectLiteralExpression(node)) {
    const preferred =
      kind === "route"
        ? ["path", "name"]
        : kind === "view"
          ? ["id", "path", "name"]
          : ["name", "id", "type", "source"];
    for (const key of preferred) {
      for (const member of node.properties) {
        if (
          !ts.isPropertyAssignment(member) ||
          propertyName(member.name) !== key
        )
          continue;
        const value = unwrap(member.initializer);
        if (ts.isStringLiteralLike(value) || ts.isNumericLiteral(value))
          return value.text;
        if (ts.isIdentifier(value)) return value.text;
      }
    }
  }
  if (ts.isNewExpression(node)) return node.expression.getText();
  if (ts.isCallExpression(node)) return node.expression.getText();
  if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
    for (const declaration of resolvedDeclarations(checker, node)) {
      if (ts.isClassDeclaration(declaration) && declaration.name)
        return declaration.name.text;
      const initializer = declarationExpression(declaration);
      if (initializer && initializer !== node) {
        const label = expressionLabel(checker, initializer, kind);
        if (label) return label;
      }
    }
    return node.getText();
  }
  return node.getText().replace(/\s+/g, " ").slice(0, 100);
}

function collectElements(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  seen = new Set<ts.Node>(),
): ts.Expression[] {
  const node = unwrap(expression);
  if (seen.has(node)) return [];
  seen.add(node);
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.flatMap((element) =>
      ts.isSpreadElement(element)
        ? collectElements(checker, element.expression, seen)
        : [element as ts.Expression],
    );
  }
  if (ts.isConditionalExpression(node)) {
    return [
      ...collectElements(checker, node.whenTrue, seen),
      ...collectElements(checker, node.whenFalse, seen),
    ];
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    if (ts.isBlock(node.body)) {
      const returned: ts.Expression[] = [];
      node.body.forEachChild(function visit(child) {
        if (ts.isReturnStatement(child) && child.expression)
          returned.push(child.expression);
        else child.forEachChild(visit);
      });
      return returned.flatMap((value) => collectElements(checker, value, seen));
    }
    return collectElements(checker, node.body, seen);
  }
  if (ts.isCallExpression(node)) {
    if (
      node.expression.getText().endsWith("promoteSubactionsToActions") &&
      node.arguments[0]
    ) {
      return collectElements(checker, node.arguments[0], seen);
    }
    const fromFactory = collectElements(checker, node.expression, seen);
    if (
      fromFactory.length > 0 &&
      !(fromFactory.length === 1 && fromFactory[0] === node.expression)
    ) {
      return fromFactory;
    }
  }
  const declarations = resolvedDeclarations(checker, node);
  const resolved = declarations.flatMap((declaration) => {
    const initializer = declarationExpression(declaration);
    if (initializer) return collectElements(checker, initializer, seen);
    if (
      (ts.isFunctionDeclaration(declaration) ||
        ts.isFunctionExpression(declaration) ||
        ts.isArrowFunction(declaration) ||
        ts.isMethodDeclaration(declaration)) &&
      declaration.body &&
      ts.isBlock(declaration.body)
    ) {
      const returns: ts.Expression[] = [];
      declaration.body.forEachChild(function visit(child) {
        if (ts.isReturnStatement(child) && child.expression)
          returns.push(child.expression);
        else child.forEachChild(visit);
      });
      return returns.flatMap((value) => collectElements(checker, value, seen));
    }
    return [];
  });
  return resolved.length > 0 ? resolved : [node];
}

function collectLiteralStrings(
  checker: ts.TypeChecker,
  expression: ts.Expression,
): string[] {
  return collectElements(checker, expression).flatMap((element) => {
    const node = unwrap(element);
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (ts.isObjectLiteralExpression(node)) return [];
    return [expressionLabel(checker, node, "subaction")];
  });
}

function objectProperties(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  seen = new Set<ts.Node>(),
): Map<string, ts.Expression[]> {
  const node = unwrap(expression);
  if (seen.has(node)) return new Map();
  seen.add(node);
  const output = new Map<string, ts.Expression[]>();
  const merge = (other: Map<string, ts.Expression[]>): void => {
    for (const [key, values] of other)
      output.set(key, [...(output.get(key) ?? []), ...values]);
  };
  if (ts.isObjectLiteralExpression(node)) {
    for (const member of node.properties) {
      if (ts.isSpreadAssignment(member))
        merge(objectProperties(checker, member.expression, seen));
      else if (ts.isPropertyAssignment(member)) {
        const name = propertyName(member.name);
        if (name) output.set(name, [member.initializer]);
      } else if (ts.isShorthandPropertyAssignment(member)) {
        output.set(member.name.text, [member.name]);
      }
    }
    return output;
  }
  for (const declaration of resolvedDeclarations(checker, node)) {
    const initializer = declarationExpression(declaration);
    if (initializer) merge(objectProperties(checker, initializer, seen));
  }
  return output;
}

function pluginObjects(
  program: ts.Program,
  packageDir: string,
): ts.Expression[] {
  const objects: ts.Expression[] = [];
  for (const source of program.getSourceFiles()) {
    if (!source.fileName.startsWith(`${packageDir}${path.sep}`)) continue;
    source.forEachChild(function visit(node) {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const typeText = node.type?.getText() ?? "";
        const initText = node.initializer.getText();
        if (
          /\bPlugin\b/.test(typeText) ||
          /\bsatisfies\s+Plugin\b|\bas\s+Plugin\b/.test(initText)
        ) {
          objects.push(node.initializer);
        }
      }
      if (ts.isExportAssignment(node)) {
        const expression = unwrap(node.expression);
        if (
          ts.isObjectLiteralExpression(expression) ||
          /\bsatisfies\s+Plugin\b|\bas\s+Plugin\b/.test(
            node.expression.getText(),
          )
        ) {
          objects.push(node.expression);
        }
      }
      node.forEachChild(visit);
    });
  }
  return objects;
}

function normalizeName(value: string): string {
  return value
    .trim()
    .replace(/^['"`]|['"`]$/g, "")
    .replace(/\s+/g, " ");
}

function ownerFor(packageDir: string): string {
  const manifest = path.join(packageDir, "package.json");
  if (existsSync(manifest)) {
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
      elizaos?: { owner?: unknown };
      owner?: unknown;
    };
    const owner = parsed.elizaos?.owner ?? parsed.owner;
    if (typeof owner === "string" && owner.trim()) return owner;
  }
  return path.basename(packageDir);
}

const requirementsCache = new Map<
  string,
  Pick<SurfaceRegistration, "platformRequirements" | "externalDependencies">
>();

function requirementsFor(
  packageDir: string,
  kind: RuntimeSurfaceKind,
  sourceFile?: string,
): Pick<SurfaceRegistration, "platformRequirements" | "externalDependencies"> {
  const cacheKey = `${sourceFile ?? packageDir}:${kind}`;
  const cached = requirementsCache.get(cacheKey);
  if (cached) return cached;
  const files = sourceFile
    ? [sourceFile]
    : productionTsFiles(path.join(packageDir, "src"));
  const text = files.map((file) => readFileSync(file, "utf8")).join("\n");
  const platforms = new Set<string>();
  if (/darwin|macos|MacOS|NSWorkspace|AppleScript/.test(text))
    platforms.add("macOS");
  if (/android|capacitor/i.test(text)) platforms.add("Android");
  if (/\bios\b|iPhone|AVFoundation/.test(text)) platforms.add("iOS");
  if (/linux/i.test(text)) platforms.add("Linux");
  if (/windows|win32/i.test(text)) platforms.add("Windows");
  if (kind === "native-bridge") platforms.add("native-runtime");
  const dependencies = new Set<string>();
  for (const match of text.matchAll(
    /(?:API_KEY|ACCESS_TOKEN|CLIENT_SECRET|WEBHOOK_SECRET|DATABASE_URL|REDIS_URL)/g,
  )) {
    dependencies.add(match[0]);
  }
  const requirements = {
    platformRequirements: [...platforms].sort(),
    externalDependencies: [...dependencies].sort(),
  };
  requirementsCache.set(cacheKey, requirements);
  return requirements;
}

function registrationId(
  owner: string,
  kind: RuntimeSurfaceKind,
  name: string,
): string {
  const safe = normalizeName(name)
    .replace(/[^A-Za-z0-9._:/-]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${owner}:${kind}:${safe || "anonymous"}`;
}

function pluginRegistrations(repoRoot: string): SurfaceRegistration[] {
  const pluginRoot = path.join(repoRoot, "plugins");
  if (!existsSync(pluginRoot)) return [];
  const packageDirs = pluginPackageDirs(repoRoot);
  // Production package entry points are the registration authority. Starting
  // the Program from them lets TypeScript follow only reachable imports while
  // avoiding a full-program parse of unrelated implementation modules.
  const files = packageDirs.flatMap(packageEntryPoints);
  const program = ts.createProgram(files, {
    allowJs: false,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
  });
  const checker = program.getTypeChecker();
  const rows: SurfaceRegistration[] = [];
  for (const packageDir of packageDirs) {
    const owner = ownerFor(packageDir);
    const pkg = packageName(packageDir);
    for (const pluginObject of pluginObjects(program, packageDir)) {
      const properties = objectProperties(checker, pluginObject);
      for (const [property, kind] of Object.entries(PLUGIN_PROPERTIES)) {
        if (!kind) continue;
        for (const initializer of properties.get(property) ?? []) {
          const elements =
            kind === "event" || kind === "model"
              ? [...objectProperties(checker, initializer).keys()].map(
                  (key) => ({ key }),
                )
              : collectElements(checker, initializer).map((expression) => ({
                  expression,
                }));
          for (const element of elements) {
            const name =
              "key" in element
                ? element.key
                : expressionLabel(checker, element.expression, kind);
            const normalized = normalizeName(name);
            if (!normalized || normalized === "[]" || normalized === "{}")
              continue;
            rows.push({
              id: registrationId(owner, kind, normalized),
              kind,
              name: normalized,
              owner,
              packageName: pkg,
              source: path.relative(
                repoRoot,
                pluginObject.getSourceFile().fileName,
              ),
              ...requirementsFor(
                packageDir,
                kind,
                "expression" in element
                  ? element.expression.getSourceFile().fileName
                  : pluginObject.getSourceFile().fileName,
              ),
            });
            if (kind === "action" && "expression" in element) {
              const actionProperties = objectProperties(
                checker,
                element.expression,
              );
              const subactionNames = new Set<string>();
              for (const initializer of actionProperties.get("subActions") ??
                []) {
                for (const subaction of collectElements(checker, initializer)) {
                  subactionNames.add(
                    expressionLabel(checker, subaction, "subaction"),
                  );
                }
              }
              for (const parametersInitializer of actionProperties.get(
                "parameters",
              ) ?? []) {
                for (const parameter of collectElements(
                  checker,
                  parametersInitializer,
                )) {
                  for (const subactionsInitializer of objectProperties(
                    checker,
                    parameter,
                  ).get("subactions") ?? []) {
                    for (const subaction of collectLiteralStrings(
                      checker,
                      subactionsInitializer,
                    ))
                      subactionNames.add(subaction);
                  }
                }
              }
              for (const subaction of subactionNames) {
                const subactionName = normalizeName(subaction);
                if (!subactionName) continue;
                rows.push({
                  id: registrationId(
                    owner,
                    "subaction",
                    `${normalized}/${subactionName}`,
                  ),
                  kind: "subaction",
                  name: `${normalized}/${subactionName}`,
                  owner,
                  packageName: pkg,
                  source: path.relative(
                    repoRoot,
                    element.expression.getSourceFile().fileName,
                  ),
                  ...requirementsFor(
                    packageDir,
                    "subaction",
                    element.expression.getSourceFile().fileName,
                  ),
                });
              }
            }
          }
        }
      }
      if (
        (properties.get("connectorSources")?.length ?? 0) > 0 ||
        ((properties.get("services")?.length ?? 0) > 0 &&
          /discord|telegram|slack|signal|whatsapp|matrix|wechat|imessage|bluebubbles|instagram|\bx\b/i.test(
            owner,
          ))
      ) {
        rows.push({
          id: registrationId(owner, "connector-egress", "message-dispatch"),
          kind: "connector-egress",
          name: "message-dispatch",
          owner,
          packageName: pkg,
          source: path.relative(
            repoRoot,
            pluginObject.getSourceFile().fileName,
          ),
          ...requirementsFor(
            packageDir,
            "connector-egress",
            pluginObject.getSourceFile().fileName,
          ),
        });
      }
    }
  }
  return rows;
}

function hostRegistrations(repoRoot: string): SurfaceRegistration[] {
  const rows: SurfaceRegistration[] = [];
  const add = (
    packageDir: string,
    kind: RuntimeSurfaceKind,
    name: string,
    source: string,
  ): void => {
    const owner = path.relative(repoRoot, packageDir).replaceAll(path.sep, "/");
    rows.push({
      id: registrationId(owner, kind, name),
      kind,
      name,
      owner,
      packageName: packageName(packageDir),
      source: path.relative(repoRoot, source),
      ...requirementsFor(packageDir, kind, source),
    });
  };

  const cloudServices = path.join(repoRoot, "packages", "cloud", "services");
  if (existsSync(cloudServices)) {
    for (const entry of readdirSync(cloudServices, { withFileTypes: true })) {
      const dir = path.join(cloudServices, entry.name);
      if (entry.isDirectory() && existsSync(path.join(dir, "package.json"))) {
        add(dir, "cloud-service", entry.name, path.join(dir, "package.json"));
      }
    }
  }
  const cloudApi = path.join(repoRoot, "packages", "cloud", "api");
  const generatedRouter = path.join(cloudApi, "src", "_router.generated.ts");
  const mountedRouteFiles = existsSync(generatedRouter)
    ? [
        ...readFileSync(generatedRouter, "utf8").matchAll(
          /from\s+["']\.\.\/(.+?\/route)["']/g,
        ),
      ]
        .map((match) => {
          for (const extension of [".ts", ".tsx", ".mts", ".cts"]) {
            const candidate = path.join(cloudApi, `${match[1]}${extension}`);
            if (existsSync(candidate)) return candidate;
          }
          return null;
        })
        .filter((file): file is string => file !== null)
    : [];
  for (const file of mountedRouteFiles) {
    const relative = path
      .relative(cloudApi, file)
      .replace(/\/route\.[cm]?tsx?$/, "")
      .replaceAll(path.sep, "/");
    add(
      cloudApi,
      relative.startsWith("cron/") ? "worker" : "route",
      `/${relative}`,
      file,
    );
    if (
      relative.startsWith("cron/") &&
      /\bqueue\b/i.test(readFileSync(file, "utf8"))
    ) {
      add(cloudApi, "queue", `/${relative}`, file);
    }
  }
  for (const file of [
    path.join(cloudApi, "src", "bootstrap-app.ts"),
    path.join(cloudApi, "src", "index.ts"),
  ]) {
    if (!existsSync(file)) continue;
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(
      /\bapp\.(?:get|post|put|patch|delete|all|route)\(\s*["'`]([^"'`]+)["'`]/g,
    )) {
      add(cloudApi, "route", match[1], file);
    }
  }

  const taskWorkerRoots = [
    path.join(repoRoot, "packages", "core", "src"),
    path.join(repoRoot, "packages", "agent", "src"),
    path.join(repoRoot, "packages", "app-core", "src"),
    path.join(repoRoot, "plugins"),
  ];
  for (const root of taskWorkerRoots) {
    for (const file of productionTsFiles(root)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(
        /\bregister(?:Task)?Worker\s*\(\s*(?:{[\s\S]{0,400}?\bname\s*:\s*)?["'`]([^"'`]+)["'`]/g,
      )) {
        let packageDir = path.dirname(file);
        while (
          packageDir !== repoRoot &&
          !existsSync(path.join(packageDir, "package.json"))
        )
          packageDir = path.dirname(packageDir);
        if (packageDir !== repoRoot) add(packageDir, "worker", match[1], file);
      }
    }
  }

  for (const root of [
    path.join(repoRoot, "packages", "native"),
    path.join(repoRoot, "plugins"),
  ]) {
    for (const manifest of walk(
      root,
      (file) => path.basename(file) === "package.json",
    )) {
      const dir = path.dirname(manifest);
      if (dir.includes(`${path.sep}node_modules${path.sep}`)) continue;
      const base = path.basename(dir);
      if (root.endsWith("plugins") && !base.startsWith("plugin-native-"))
        continue;
      if (root.endsWith("native") && !existsSync(path.join(dir, "src")))
        continue;
      add(dir, "native-bridge", base, manifest);
    }
  }
  return rows;
}

export function discoverRuntimeSurfaces(
  repoRoot: string,
): SurfaceRegistration[] {
  const byId = new Map<string, SurfaceRegistration>();
  for (const row of [
    ...pluginRegistrations(repoRoot),
    ...hostRegistrations(repoRoot),
  ]) {
    if (!byId.has(row.id)) byId.set(row.id, row);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function loadSyntheticWorldManifest(
  manifestPath: string,
): SyntheticWorldManifest {
  const parsed = JSON.parse(
    readFileSync(manifestPath, "utf8"),
  ) as SyntheticWorldManifest;
  if (parsed.schema !== SYNTHETIC_WORLD_SCHEMA || !parsed.dispositions) {
    throw new Error(`Invalid synthetic-world manifest: ${manifestPath}`);
  }
  return parsed;
}

export interface SyntheticWorldDrift {
  newlyUncovered: string[];
  stale: string[];
  invalid: string[];
  omittedPackages: string[];
  ok: boolean;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Rejects name-only mentions: evidence must contain a structured invocation or
 * assertion that crosses the registered boundary. Comments, fixture data, and
 * plugin setup strings therefore cannot qualify a row as covered.
 */
export function isExecutableBoundaryEvidence(
  registration: SurfaceRegistration,
  source: string,
): boolean {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    source,
  );
  let code = "";
  for (
    let token = scanner.scan();
    token !== ts.SyntaxKind.EndOfFileToken;
    token = scanner.scan()
  ) {
    if (
      token !== ts.SyntaxKind.SingleLineCommentTrivia &&
      token !== ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      code += scanner.getTokenText();
    }
  }
  const name =
    registration.kind === "subaction"
      ? (registration.name.split("/").at(-1) ?? registration.name)
      : registration.name;
  const quoted = `["'\`]${escapeRegExp(name)}["'\`]`;
  if (registration.kind === "action") {
    return new RegExp(
      `(?:type\\s*:\\s*["'\`](?:actionCalled|selectedAction|selectedActionArguments)["'\`][\\s\\S]{0,600}?actionName\\s*:\\s*${quoted}|kind\\s*:\\s*["'\`]action["'\`][\\s\\S]{0,400}?(?:actionName|action)\\s*:\\s*${quoted})`,
    ).test(code);
  }
  if (registration.kind === "subaction") {
    return new RegExp(
      `(?:selectedActionArguments|assertTurn|finalChecks)[\\s\\S]{0,800}?${quoted}`,
    ).test(code);
  }
  if (registration.kind === "route" || registration.kind === "worker") {
    const request = new RegExp(
      `(?:request|fetch|page\\.request|client)\\s*\\.?\\s*(?:get|post|put|patch|delete)?\\s*\\([^)]{0,500}${escapeRegExp(name)}`,
      "i",
    );
    const pluginDispatch =
      code.includes("tryHandleRuntimePluginRoute") &&
      code.includes(name) &&
      /expect\s*\(|assertResponse|assertTurn/.test(code);
    return (
      (request.test(code) &&
        /expect\s*\(|assertResponse|assertTurn/.test(code)) ||
      pluginDispatch
    );
  }
  if (registration.kind === "connector-egress") {
    return /type\s*:\s*["'`](?:connectorDispatchOccurred|messageDelivered)["'`]/.test(
      code,
    );
  }
  if (registration.kind === "connector-ingress") {
    return (
      /(?:handleMessage|inbound|webhook)[\s\S]{0,800}?(?:expect\s*\(|assertTurn)/i.test(
        code,
      ) && code.includes(name)
    );
  }
  if (registration.kind === "cloud-service" || registration.kind === "queue") {
    return new RegExp(
      `(?:import|await|request|fetch)[\\s\\S]{0,500}?${escapeRegExp(name)}[\\s\\S]{0,1000}?expect\\s*\\(`,
      "i",
    ).test(code);
  }
  return false;
}

export function evaluateSyntheticWorldDrift(
  registrations: SurfaceRegistration[],
  manifest: SyntheticWorldManifest,
  repoRoot = process.cwd(),
): SyntheticWorldDrift {
  const discovered = new Set(registrations.map((row) => row.id));
  const newlyUncovered = registrations
    .filter((row) => !manifest.dispositions[row.id])
    .map((row) => row.id)
    .sort();
  const stale = Object.keys(manifest.dispositions)
    .filter((id) => !discovered.has(id))
    .sort();
  const invalid = Object.entries(manifest.dispositions)
    .filter(([id, disposition]) => {
      const registration = registrations.find((row) => row.id === id);
      return (
        ![
          "covered",
          "exempt",
          "platform-deferred",
          "provider-qualified-only",
          "unsupported-product",
        ].includes(disposition.status) ||
        disposition.reason.trim().length < 20 ||
        (disposition.status === "covered" &&
          (!disposition.artifacts ||
            disposition.artifacts.length === 0 ||
            !disposition.boundarySignals ||
            disposition.boundarySignals.length === 0 ||
            disposition.artifacts.some(
              (artifact) => !existsSync(path.join(repoRoot, artifact)),
            ) ||
            disposition.boundarySignals.some(
              (signal) =>
                !disposition.artifacts?.some((artifact) => {
                  const file = path.join(repoRoot, artifact);
                  return (
                    existsSync(file) &&
                    readFileSync(file, "utf8")
                      .toLocaleLowerCase()
                      .includes(signal.toLocaleLowerCase())
                  );
                }),
            ) ||
            !registration ||
            !disposition.artifacts.some((artifact) => {
              const file = path.join(repoRoot, artifact);
              return (
                existsSync(file) &&
                isExecutableBoundaryEvidence(
                  registration,
                  readFileSync(file, "utf8"),
                )
              );
            }))) ||
        !id
      );
    })
    .map(([id]) => id)
    .sort();
  const omittedPackages = auditPluginPackageCoverage(repoRoot).omitted;
  return {
    newlyUncovered,
    stale,
    invalid,
    omittedPackages,
    ok:
      newlyUncovered.length === 0 &&
      stale.length === 0 &&
      invalid.length === 0 &&
      omittedPackages.length === 0,
  };
}

export function buildSyntheticWorldInventory(
  repoRoot: string,
  manifest: SyntheticWorldManifest,
  generatedAt = "1970-01-01T00:00:00.000Z",
): SyntheticWorldInventory {
  const rows = discoverRuntimeSurfaces(repoRoot).map((row) => ({
    ...row,
    ...manifest.dispositions[row.id],
  }));
  const packageAudit = auditPluginPackageCoverage(repoRoot);
  const count = (values: string[]): Record<string, number> =>
    Object.fromEntries(
      [...new Set(values)]
        .sort()
        .map((value) => [
          value,
          values.filter((candidate) => candidate === value).length,
        ]),
    );
  return {
    schema: SYNTHETIC_WORLD_SCHEMA,
    generatedAt,
    rows,
    gaps: rows.filter((row) => row.status !== "covered"),
    summary: {
      total: rows.length,
      byKind: count(rows.map((row) => row.kind)),
      byStatus: count(rows.map((row) => row.status)),
      byOwner: count(rows.map((row) => row.owner)),
      byDependency: count(
        rows.flatMap((row) =>
          row.externalDependencies.length ? row.externalDependencies : ["none"],
        ),
      ),
      byScenarioLane: count(
        rows.flatMap((row) => [
          ...(row.deterministicScenarioIds?.length ? ["pr-deterministic"] : []),
          ...(row.liveModelScenarioIds?.length ? ["live-model"] : []),
          ...(!row.deterministicScenarioIds?.length &&
          !row.liveModelScenarioIds?.length
            ? ["none"]
            : []),
        ]),
      ),
      byWorkstream: count(rows.map((row) => row.workstream ?? "unassigned")),
      pluginPackages: {
        manifests: packageAudit.manifests.length,
        scanned: packageAudit.scanned.length,
        withoutRegisteredSurfaces: packageAudit.scanned.filter(
          (plugin) =>
            !rows.some((row) => row.source.startsWith(`plugins/${plugin}/`)),
        ),
      },
    },
  };
}

/** Compatibility projection consumed by the legacy #8801 plugin ratchet. */
export function projectLegacyPluginSurfaces(
  rows: SurfaceRegistration[],
): Array<{
  dir: string;
  packageName: string;
  hasActions: boolean;
  hasConnector: boolean;
}> {
  const plugins = new Map<
    string,
    {
      dir: string;
      packageName: string;
      hasActions: boolean;
      hasConnector: boolean;
    }
  >();
  for (const row of rows.filter((candidate) =>
    candidate.source.startsWith("plugins/"),
  )) {
    const dir = row.source.split("/")[1];
    const current = plugins.get(dir) ?? {
      dir,
      packageName: row.packageName,
      hasActions: false,
      hasConnector: false,
    };
    if (row.kind === "action" || row.kind === "subaction")
      current.hasActions = true;
    if (row.kind === "connector-ingress" || row.kind === "connector-egress")
      current.hasConnector = true;
    plugins.set(dir, current);
  }
  return [...plugins.values()].sort((a, b) => a.dir.localeCompare(b.dir));
}

/** Route compatibility helper for #8802; manifests remain authoritative evidence. */
export function routeCompatibilityStatus(
  owner: string,
): "covered" | "exempt" | "missing" {
  const entry = PLUGIN_ROUTE_COVERAGE[owner];
  return entry?.status ?? "missing";
}

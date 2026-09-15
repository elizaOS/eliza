/**
 * Builds one deterministic AST inventory for token, atomic, and molecular
 * design owners while recording raw paint and interaction evidence for later
 * enforcement waves.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  BUILTIN_ROUTE_IDS,
  resolveBuiltinRouteDescriptor,
} from "../src/navigation/builtin-route-descriptors.ts";
import {
  type DiscoveredComponent,
  discoverComponentGraph,
} from "./design-component-graph.ts";
import {
  type AtomDesignNode,
  DESIGN_LAYER_RANK,
  type DesignGraphFinding,
  type DesignNode,
  type DesignNodeId,
  designOwnerKey,
  type MoleculeDesignNode,
  parseHigherOrderDesignRegistry,
  requireStringListForBoundary,
  type TokenDesignNode,
  validateDesignNodes,
} from "./design-contract-schema.ts";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../..");
const canonicalRoot = "packages/ui/src/components/ui";
const moleculeContractsPath = path.join(scriptDir, "molecule-contracts.json");
const higherOrderRegistryPath = path.join(
  scriptDir,
  "design-contract-registry.json",
);
const semanticTokenPath = "packages/ui/src/styles/base.css";

const PAINTED_RAW_HOST =
  /(?:^|\s)(?:[a-z-]+:)*(?:bg-(?:card|surface|background|bg(?:-elevated)?)|border(?:-|$)|rounded-|shadow-)/;
const INTERACTION_ATTRIBUTE =
  /^(?:onClick|onKeyDown|onKeyUp|onPointerDown|onPointerUp|onMouseDown|onTouchStart|tabIndex)$/;

interface AtomDefinition {
  names: readonly string[];
  hosts: readonly string[];
}

interface AtomicInventoryBoundary {
  ATOMS: Record<string, unknown>;
  listMaintainedSourceFiles: () => unknown;
}

interface ImportBinding {
  imported: string;
  origin: string;
}

export interface MoleculeContract {
  id: string;
  owner: string;
  symbol: string;
  responsibility: string;
  requiredAtomicDependencies: readonly string[];
  requiredRenderedTags: readonly string[];
  requiredConsumerFiles: readonly string[];
  minimumMaintainedReferences: number;
  renderedStory: string;
  behavioralTest: string;
}

interface ExportedDeclaration {
  renderedTags: readonly string[];
  atomicDependencies: readonly string[];
}

interface SourceRecord {
  file: string;
  exports: ReadonlyMap<string, ExportedDeclaration>;
}

export interface SourceOccurrence {
  file: string;
  line: number;
  tag: string;
}

export interface DesignTokenRecord {
  name: string;
  family: string;
  values: readonly string[];
  aliases: readonly string[];
}

export interface DesignTokenInventory {
  records: readonly DesignTokenRecord[];
  missingAliases: readonly { token: string; alias: string }[];
  cycles: readonly string[];
  sourceDigest: string;
}

export interface DesignContractGraph {
  schemaVersion: 1;
  scope: {
    roots: readonly ["packages", "plugins"];
    extensions: readonly [".ts", ".tsx", ".js", ".jsx"];
    excludesTestsFixturesAndGeneratedOutput: true;
  };
  scannedFiles: number;
  sourceFiles: readonly string[];
  nodes: readonly DesignNode[];
  edges: readonly { from: DesignNodeId; to: DesignNodeId }[];
  findings: readonly DesignGraphFinding[];
  observations: {
    tokens: readonly DesignTokenRecord[];
    paintedRawHosts: readonly SourceOccurrence[];
    interactiveRawHosts: readonly SourceOccurrence[];
    classifiedBuiltinRoutes: readonly string[];
    discoveredComponents: readonly DiscoveredComponent[];
  };
}

function tokenFamily(name: string): string {
  if (
    /^(?:bg|background|card|surface|scrim|header-bar-bg|section-bar-bg)$/.test(
      name,
    )
  ) {
    return "surface";
  }
  if (/^(?:text|txt|foreground|muted|.*-foreground|.*-fg)$/.test(name)) {
    return "foreground";
  }
  if (/^(?:border|input|ring|focus|divider)/.test(name)) return "structure";
  if (/^(?:status-|ok|warn|danger|destructive|info|success)/.test(name)) {
    return "status";
  }
  if (/^(?:accent|primary|brand-orange|eliza-orange)/.test(name))
    return "action";
  if (/^radius/.test(name)) return "radius";
  if (/^shadow/.test(name)) return "elevation";
  if (/^(?:font|mono|text-)/.test(name)) return "typography";
  if (
    /^(?:view-pad|plugin-.*(?:gap|padding)|spacing|min-touch|eliza-mobile)/.test(
      name,
    )
  ) {
    return "spacing";
  }
  if (/^(?:duration|motion)/.test(name)) return "motion";
  return "other";
}

export function inventoryDesignTokens(source: string): DesignTokenInventory {
  const definitions = new Map<string, Set<string>>();
  const declaration = /--([a-zA-Z0-9-]+)\s*:\s*([^;{}]+);/g;
  for (const match of source.matchAll(declaration)) {
    const values = definitions.get(match[1]) ?? new Set<string>();
    values.add(match[2].replace(/\s+/g, " ").trim());
    definitions.set(match[1], values);
  }
  const records = [...definitions]
    .map(([name, values]): DesignTokenRecord => {
      const aliases = new Set<string>();
      for (const value of values) {
        for (const alias of value.matchAll(/var\(--([a-zA-Z0-9-]+)\)/g)) {
          aliases.add(alias[1]);
        }
      }
      return {
        name,
        family: tokenFamily(name),
        values: [...values].sort(),
        aliases: [...aliases].sort(),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  const names = new Set(records.map((record) => record.name));
  const missingAliases = records
    .flatMap((record) =>
      record.aliases
        .filter((alias) => !names.has(alias))
        .map((alias) => ({ token: record.name, alias })),
    )
    .sort(
      (left, right) =>
        left.token.localeCompare(right.token) ||
        left.alias.localeCompare(right.alias),
    );
  const aliasesByName = new Map(
    records.map((record) => [record.name, record.aliases]),
  );
  const cycles = new Set<string>();
  const visit = (name: string, path: readonly string[]): void => {
    const cycleStart = path.indexOf(name);
    if (cycleStart >= 0) {
      cycles.add([...path.slice(cycleStart), name].join(" -> "));
      return;
    }
    for (const alias of aliasesByName.get(name) ?? []) {
      if (names.has(alias)) visit(alias, [...path, name]);
    }
  };
  for (const name of names) visit(name, []);
  return {
    records,
    missingAliases,
    cycles: [...cycles].sort(),
    sourceDigest: createHash("sha256").update(source).digest("hex"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function relative(file: string): string {
  return path.relative(repoRoot, file).replaceAll(path.sep, "/");
}

function topLevelName(node: ts.Node): string | null {
  if (
    (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
    node.name
  ) {
    return node.name.text;
  }
  if (ts.isVariableStatement(node)) {
    const declaration = node.declarationList.declarations[0];
    if (declaration && ts.isIdentifier(declaration.name))
      return declaration.name.text;
  }
  return null;
}

function localExportNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      !statement.moduleSpecifier &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        names.add(element.propertyName?.text ?? element.name.text);
      }
    }
    if (
      ts.isExportAssignment(statement) &&
      ts.isIdentifier(statement.expression)
    ) {
      names.add(statement.expression.text);
    }
  }
  return names;
}

function hasExportModifier(node: ts.Node): boolean {
  return Boolean(
    ts.canHaveModifiers(node) &&
      ts
        .getModifiers(node)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
  );
}

function importsByLocalName(
  sourceFile: ts.SourceFile,
): Map<string, ImportBinding> {
  const imports = new Map<string, ImportBinding>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const origin = statement.moduleSpecifier.text;
    const bindings = statement.importClause.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      imports.set(element.name.text, {
        imported: element.propertyName?.text ?? element.name.text,
        origin,
      });
    }
  }
  return imports;
}

function resolveRelativeModule(
  importingFile: string,
  origin: string,
): string | null {
  if (!origin.startsWith(".")) return null;
  const base = path.resolve(path.dirname(importingFile), origin);
  for (const candidate of [
    base,
    `${base}.tsx`,
    `${base}.ts`,
    path.join(base, "index.tsx"),
    path.join(base, "index.ts"),
  ]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return relative(candidate);
    }
  }
  return null;
}

export function resolveCanonicalAtomImport(input: {
  binding: ImportBinding | undefined;
  importingFile: string;
  atomOwnersByExport: ReadonlyMap<string, { kind: string; file: string }>;
}): string | null {
  if (!input.binding) return null;
  const owner = input.atomOwnersByExport.get(input.binding.imported);
  if (!owner) return null;
  if (input.binding.origin === "@elizaos/ui") return owner.kind;
  if (input.binding.origin === `@elizaos/ui/${owner.kind}`) return owner.kind;
  return resolveRelativeModule(input.importingFile, input.binding.origin) ===
    owner.file
    ? owner.kind
    : null;
}

function staticClassName(node: ts.JsxOpeningLikeElement): string | null {
  const attribute = node.attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && property.name.getText() === "className",
  );
  const initializer = attribute?.initializer;
  return initializer &&
    (ts.isStringLiteral(initializer) ||
      ts.isNoSubstitutionTemplateLiteral(initializer))
    ? initializer.text
    : null;
}

function inventorySource(
  absoluteFile: string,
  atomOwnersByExport: ReadonlyMap<string, { kind: string; file: string }>,
  paintedRawHosts: SourceOccurrence[],
  interactiveRawHosts: SourceOccurrence[],
): SourceRecord {
  const file = relative(absoluteFile);
  const source = fs.readFileSync(absoluteFile, "utf8");
  const sourceFile = ts.createSourceFile(
    absoluteFile,
    source,
    ts.ScriptTarget.Latest,
    true,
    absoluteFile.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const imports = importsByLocalName(sourceFile);
  const separatelyExported = localExportNames(sourceFile);
  const exports = new Map<string, ExportedDeclaration>();

  for (const statement of sourceFile.statements) {
    const name = topLevelName(statement);
    if (
      !name ||
      (!hasExportModifier(statement) && !separatelyExported.has(name))
    )
      continue;
    const renderedTags = new Set<string>();
    const atomicDependencies = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText();
        renderedTags.add(tag);
        const atomicKind = resolveCanonicalAtomImport({
          binding: imports.get(tag),
          importingFile: absoluteFile,
          atomOwnersByExport,
        });
        if (atomicKind) atomicDependencies.add(atomicKind);
      }
      ts.forEachChild(node, visit);
    };
    visit(statement);
    exports.set(name, {
      renderedTags: [...renderedTags].sort(),
      atomicDependencies: [...atomicDependencies].sort(),
    });
  }

  const visitHosts = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText();
      if (/^[a-z]/.test(tag)) {
        const line =
          sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        const occurrence = { file, line, tag };
        const className = staticClassName(node);
        if (className && PAINTED_RAW_HOST.test(className)) {
          paintedRawHosts.push(occurrence);
        }
        if (
          !["a", "button", "input", "select", "summary", "textarea"].includes(
            tag,
          ) &&
          node.attributes.properties.some(
            (property) =>
              ts.isJsxAttribute(property) &&
              INTERACTION_ATTRIBUTE.test(property.name.getText()),
          )
        ) {
          interactiveRawHosts.push(occurrence);
        }
      }
    }
    ts.forEachChild(node, visitHosts);
  };
  visitHosts(sourceFile);

  return { file, exports };
}

async function loadAtomicInventory(): Promise<{
  definitions: Map<string, AtomDefinition>;
  files: string[];
}> {
  const atomicInventoryUrl = new URL(
    "./find-duplicate-components.mjs",
    import.meta.url,
  );
  const imported: unknown = await import(atomicInventoryUrl.href);
  if (
    !isRecord(imported) ||
    !isRecord(imported.ATOMS) ||
    typeof imported.listMaintainedSourceFiles !== "function"
  ) {
    throw new Error(
      "Atomic inventory module must export ATOMS and listMaintainedSourceFiles",
    );
  }
  const boundary = imported as unknown as AtomicInventoryBoundary;
  const definitions = new Map<string, AtomDefinition>();
  for (const [kind, value] of Object.entries(boundary.ATOMS)) {
    if (!isRecord(value))
      throw new Error(`Atomic definition ${kind} must be an object`);
    definitions.set(kind, {
      names: requireStringListForBoundary(value.names, `${kind}.names`),
      hosts: requireStringListForBoundary(value.hosts, `${kind}.hosts`),
    });
  }
  const rawFiles: unknown = boundary.listMaintainedSourceFiles();
  if (!Array.isArray(rawFiles)) {
    throw new Error("Atomic inventory source scope must be an array");
  }
  const files = rawFiles.map((file, index) => {
    if (typeof file !== "string" || !path.isAbsolute(file)) {
      throw new Error(
        `Atomic inventory source ${index} must be an absolute path`,
      );
    }
    return file;
  });
  return { definitions, files: [...new Set(files)].sort() };
}

function isSafePackagesRelativePath(value: string): boolean {
  return (
    value.startsWith("packages/") &&
    !path.isAbsolute(value) &&
    !value.split("/").includes("..")
  );
}

export function parseMoleculeContracts(raw: unknown): MoleculeContract[] {
  if (
    !isRecord(raw) ||
    raw.schemaVersion !== 2 ||
    !Array.isArray(raw.contracts)
  ) {
    throw new Error("Molecule contracts require schemaVersion 2 and contracts");
  }
  return raw.contracts.map((value, index) => {
    if (!isRecord(value))
      throw new Error(`Molecule contract ${index} must be an object`);
    const allowedFields: Record<string, true> = {
      behavioralTest: true,
      id: true,
      minimumMaintainedReferences: true,
      owner: true,
      renderedStory: true,
      requiredAtomicDependencies: true,
      requiredConsumerFiles: true,
      requiredRenderedTags: true,
      responsibility: true,
      symbol: true,
    };
    const unknownField = Object.keys(value).find(
      (field) => !Object.hasOwn(allowedFields, field),
    );
    if (unknownField) {
      throw new Error(
        `Molecule contract ${index} has unknown field ${unknownField}`,
      );
    }
    const required = (field: string): string => {
      const entry = value[field];
      if (typeof entry !== "string" || entry.trim() === "") {
        throw new Error(`Molecule contract ${index}.${field} must be a string`);
      }
      return entry;
    };
    const owner = required("owner");
    const renderedStory = required("renderedStory");
    const behavioralTest = required("behavioralTest");
    if (!isSafePackagesRelativePath(owner)) {
      throw new Error(`Molecule contract ${index}.owner must be a safe path`);
    }
    if (
      !isSafePackagesRelativePath(renderedStory) ||
      !/\.stories\.[jt]sx?$/.test(renderedStory)
    ) {
      throw new Error(
        `Molecule contract ${index}.renderedStory must name a packages-relative Storybook story`,
      );
    }
    if (
      !isSafePackagesRelativePath(behavioralTest) ||
      !/\.(?:test|spec)\.[jt]sx?$/.test(behavioralTest)
    ) {
      throw new Error(
        `Molecule contract ${index}.behavioralTest must name a packages-relative test`,
      );
    }
    const requiredConsumerFiles = requireStringListForBoundary(
      value.requiredConsumerFiles,
      `Molecule contract ${index}.requiredConsumerFiles`,
    );
    if (
      requiredConsumerFiles.length < 2 ||
      new Set(requiredConsumerFiles).size !== requiredConsumerFiles.length ||
      requiredConsumerFiles.some(
        (consumer) =>
          !isSafePackagesRelativePath(consumer) || consumer === owner,
      )
    ) {
      throw new Error(
        `Molecule contract ${index} requires at least two distinct maintained consumer files`,
      );
    }
    const minimumMaintainedReferences = value.minimumMaintainedReferences;
    if (
      typeof minimumMaintainedReferences !== "number" ||
      !Number.isInteger(minimumMaintainedReferences) ||
      minimumMaintainedReferences < 2
    ) {
      throw new Error(
        `Molecule contract ${index}.minimumMaintainedReferences must be an integer of at least 2`,
      );
    }
    return {
      id: required("id"),
      owner,
      symbol: required("symbol"),
      responsibility: required("responsibility"),
      requiredAtomicDependencies: requireStringListForBoundary(
        value.requiredAtomicDependencies,
        `Molecule contract ${index}.requiredAtomicDependencies`,
      ),
      requiredRenderedTags: requireStringListForBoundary(
        value.requiredRenderedTags,
        `Molecule contract ${index}.requiredRenderedTags`,
      ),
      requiredConsumerFiles,
      minimumMaintainedReferences,
      renderedStory,
      behavioralTest,
    };
  });
}

function loadMoleculeContracts(): MoleculeContract[] {
  return parseMoleculeContracts(
    JSON.parse(fs.readFileSync(moleculeContractsPath, "utf8")),
  );
}

function fingerprint(
  rule: string,
  nodeId: DesignNodeId | null,
  owner: string,
  evidence: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ rule, nodeId, owner, evidence }))
    .digest("hex");
}

function makeFinding(input: {
  rule: string;
  nodeId: DesignNodeId | null;
  owner: string;
  evidence: string;
  detail: string;
}): DesignGraphFinding {
  return {
    rule: input.rule,
    nodeId: input.nodeId,
    owner: input.owner,
    detail: input.detail,
    fingerprint: fingerprint(
      input.rule,
      input.nodeId,
      input.owner,
      input.evidence,
    ),
  };
}

/** Compares a declared composition with its discovered live atom closure. */
export function validateDeclaredAtomicDependencies(input: {
  nodeId: DesignNodeId;
  owner: string;
  declaredAtomicDependencies: readonly string[];
  sourceAtomicDependencies: readonly string[];
}): DesignGraphFinding[] {
  const declared = new Set(input.declaredAtomicDependencies);
  const source = new Set(input.sourceAtomicDependencies);
  const missingFromSource = [...declared]
    .filter((atom) => !source.has(atom))
    .sort();
  const missingFromDeclaration = [...source]
    .filter((atom) => !declared.has(atom))
    .sort();
  const findings: DesignGraphFinding[] = [];

  if (missingFromSource.length > 0) {
    findings.push(
      makeFinding({
        rule: "composition/missing-atomic-dependency",
        nodeId: input.nodeId,
        owner: input.owner,
        evidence: missingFromSource.join(","),
        detail: `${input.owner} is missing atomic dependencies ${missingFromSource.join(", ")}`,
      }),
    );
  }
  if (missingFromDeclaration.length > 0) {
    findings.push(
      makeFinding({
        rule: "composition/undeclared-atomic-dependency",
        nodeId: input.nodeId,
        owner: input.owner,
        evidence: missingFromDeclaration.join(","),
        detail: `${input.owner} reaches undeclared atomic dependencies ${missingFromDeclaration.join(", ")}`,
      }),
    );
  }

  return findings;
}

/** Validates the maintained consumer floor for one declared molecule. */
export function validateDeclaredMoleculeConsumers(input: {
  nodeId: `molecule:${string}`;
  owner: string;
  requiredConsumerFiles: readonly string[];
  minimumMaintainedReferences: number;
  sourceConsumerFiles: readonly string[];
}): DesignGraphFinding[] {
  const maintained = new Set(input.sourceConsumerFiles);
  const findings: DesignGraphFinding[] = [];
  if (maintained.size < input.minimumMaintainedReferences) {
    findings.push(
      makeFinding({
        rule: "composition/insufficient-maintained-references",
        nodeId: input.nodeId,
        owner: input.owner,
        evidence: `${maintained.size}/${input.minimumMaintainedReferences}`,
        detail: `${input.owner} has ${maintained.size} maintained consumer files; expected at least ${input.minimumMaintainedReferences}`,
      }),
    );
  }
  const missing = input.requiredConsumerFiles.filter(
    (consumerFile) => !maintained.has(consumerFile),
  );
  if (missing.length > 0) {
    findings.push(
      makeFinding({
        rule: "composition/missing-required-consumer",
        nodeId: input.nodeId,
        owner: input.owner,
        evidence: missing.join(","),
        detail: `${input.owner} is missing required consumers ${missing.join(", ")}`,
      }),
    );
  }
  return findings;
}

export function validateDesignDependencyGraph(
  nodes: readonly DesignNode[],
): DesignGraphFinding[] {
  const findings: DesignGraphFinding[] = [];
  const nodesById = new Map(nodes.map((node) => [node.id, node]));

  for (const node of nodes) {
    for (const dependencyId of node.dependsOn) {
      const dependency = nodesById.get(dependencyId);
      if (!dependency) {
        findings.push(
          makeFinding({
            rule: "dependency/missing-node",
            nodeId: node.id,
            owner: designOwnerKey(node.owner),
            evidence: dependencyId,
            detail: `${node.id} depends on missing ${dependencyId}`,
          }),
        );
        continue;
      }
      if (
        DESIGN_LAYER_RANK[dependency.layer] >= DESIGN_LAYER_RANK[node.layer]
      ) {
        findings.push(
          makeFinding({
            rule: "dependency/not-downward",
            nodeId: node.id,
            owner: designOwnerKey(node.owner),
            evidence: dependencyId,
            detail: `${node.id} may not depend on ${dependencyId}`,
          }),
        );
      }
    }
  }

  const visiting = new Set<DesignNodeId>();
  const visited = new Set<DesignNodeId>();
  const visit = (node: DesignNode): void => {
    if (visited.has(node.id)) return;
    visiting.add(node.id);
    for (const dependencyId of node.dependsOn) {
      const dependency = nodesById.get(dependencyId);
      if (!dependency) continue;
      if (visiting.has(dependency.id)) {
        findings.push(
          makeFinding({
            rule: "dependency/cycle",
            nodeId: node.id,
            owner: designOwnerKey(node.owner),
            evidence: dependency.id,
            detail: `${node.id} closes a cycle through ${dependency.id}`,
          }),
        );
      } else {
        visit(dependency);
      }
    }
    visiting.delete(node.id);
    visited.add(node.id);
  };
  for (const node of nodes) visit(node);

  return findings.sort(
    (left, right) =>
      left.rule.localeCompare(right.rule) ||
      left.owner.localeCompare(right.owner) ||
      left.fingerprint.localeCompare(right.fingerprint),
  );
}

export function validateHigherOrderOwners(
  nodes: readonly DesignNode[],
  availableOwners: ReadonlySet<string>,
): DesignGraphFinding[] {
  return nodes
    .filter(
      (node) =>
        (node.layer === "organism" || node.layer === "page-shell") &&
        !availableOwners.has(designOwnerKey(node.owner)),
    )
    .map((node) =>
      makeFinding({
        rule: "registry/higher-order-owner",
        nodeId: node.id,
        owner: designOwnerKey(node.owner),
        evidence: "missing-export",
        detail: `${designOwnerKey(node.owner)} is not a maintained exported owner`,
      }),
    );
}

export async function buildDesignContractGraph(): Promise<DesignContractGraph> {
  const atomicInventory = await loadAtomicInventory();
  const atomDefinitions = atomicInventory.definitions;
  const sourceFiles = atomicInventory.files.map(relative);

  const atomOwnersByExport = new Map<string, { kind: string; file: string }>();
  for (const [kind, definition] of atomDefinitions) {
    for (const name of definition.names) {
      const expectedFile = path.join(canonicalRoot, `${kind}.tsx`);
      atomOwnersByExport.set(name, { kind, file: expectedFile });
    }
  }

  const paintedRawHosts: SourceOccurrence[] = [];
  const interactiveRawHosts: SourceOccurrence[] = [];
  const sources = atomicInventory.files.map((file) =>
    inventorySource(
      file,
      atomOwnersByExport,
      paintedRawHosts,
      interactiveRawHosts,
    ),
  );
  const sourceByFile = new Map(sources.map((source) => [source.file, source]));
  const nodes: DesignNode[] = [];
  const findings: DesignGraphFinding[] = [];

  const tokenSource = fs.readFileSync(
    path.join(repoRoot, semanticTokenPath),
    "utf8",
  );
  const tokenInventory = inventoryDesignTokens(tokenSource);

  const tokenNode: TokenDesignNode = {
    id: "token:semantic-theme",
    layer: "token",
    owner: { kind: "stylesheet", file: semanticTokenPath },
    responsibility:
      "Semantic color, typography, spacing, radius, elevation, motion, focus, divider, and touch-target values.",
    dependsOn: [],
    grants: [
      "paint.foreground",
      "paint.surface",
      "paint.status",
      "paint.action",
      "paint.background",
      "layout.local",
      "layout.container",
    ],
    provenance: "declared",
    tokenFamilies: [
      "color",
      "typography",
      "spacing",
      "radius",
      "elevation",
      "motion",
      "focus",
      "divider",
      "touch-target",
    ],
    sourceDigest: tokenInventory.sourceDigest,
    declaredTokenCount: tokenInventory.records.length,
  };
  nodes.push(tokenNode);
  for (const missing of tokenInventory.missingAliases) {
    findings.push(
      makeFinding({
        rule: "token/missing-alias",
        nodeId: tokenNode.id,
        owner: designOwnerKey(tokenNode.owner),
        evidence: `${missing.token}:${missing.alias}`,
        detail: `--${missing.token} references missing --${missing.alias}`,
      }),
    );
  }
  for (const cycle of tokenInventory.cycles) {
    findings.push(
      makeFinding({
        rule: "token/alias-cycle",
        nodeId: tokenNode.id,
        owner: designOwnerKey(tokenNode.owner),
        evidence: cycle,
        detail: `Token alias cycle: ${cycle}`,
      }),
    );
  }

  for (const [atomicKind, definition] of [...atomDefinitions].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const primaryName = definition.names[0];
    const candidates = sources.filter(
      (source) =>
        source.file.startsWith(`${canonicalRoot}/`) &&
        source.exports.has(primaryName),
    );
    if (candidates.length !== 1) {
      findings.push(
        makeFinding({
          rule: "registry/atomic-owner",
          nodeId: `atom:${atomicKind}`,
          owner: `${canonicalRoot}:${primaryName}`,
          evidence: candidates.map((candidate) => candidate.file).join(","),
          detail: `Atomic kind ${atomicKind} expected one canonical ${primaryName} owner; found ${candidates.length}`,
        }),
      );
      continue;
    }
    const node: AtomDesignNode = {
      id: `atom:${atomicKind}`,
      layer: "atom",
      owner: { kind: "export", file: candidates[0].file, symbol: primaryName },
      responsibility: `Canonical ${atomicKind} visual and interaction ownership.`,
      dependsOn: [tokenNode.id],
      grants: ["layout.local", "semantics.content"],
      provenance: "derived-atomic-inventory",
      atomicKind,
      semanticHosts: definition.hosts,
    };
    nodes.push(node);
  }

  const atomOwnerByKey = new Map<string, string>();
  for (const node of nodes) {
    if (node.layer !== "atom") continue;
    const absoluteOwnerFile = path
      .resolve(repoRoot, node.owner.file)
      .split(path.sep)
      .join("/");
    const ownerSource = sourceByFile.get(node.owner.file);
    for (const symbol of ownerSource?.exports.keys() ?? [node.owner.symbol]) {
      atomOwnerByKey.set(`${absoluteOwnerFile}#${symbol}`, node.atomicKind);
    }
  }
  const higherOrderRaw: unknown = JSON.parse(
    fs.readFileSync(higherOrderRegistryPath, "utf8"),
  );
  const higherOrder = parseHigherOrderDesignRegistry(higherOrderRaw);
  const higherOrderNodes = [
    ...higherOrder.organisms,
    ...higherOrder.pageShells,
  ];
  const higherOrderOwnerKeys = new Set(
    higherOrderNodes.map((node) => designOwnerKey(node.owner)),
  );
  const componentGraph = discoverComponentGraph({
    absoluteFiles: atomicInventory.files,
    atomOwnerByKey,
    higherOrderOwnerKeys,
    sourceRoot: repoRoot,
  });
  const discoveredComponentById = new Map(
    componentGraph.components.map((component) => [component.id, component]),
  );
  const discoveredComponentByOwner = new Map(
    componentGraph.components.map((component) => [
      `${component.file}:${component.symbol}`,
      component,
    ]),
  );
  for (const node of higherOrderNodes) {
    const ownerKey = designOwnerKey(node.owner);
    const discoveredComponent = discoveredComponentByOwner.get(ownerKey);
    if (!discoveredComponent) continue;
    findings.push(
      ...validateDeclaredAtomicDependencies({
        nodeId: node.id,
        owner: ownerKey,
        declaredAtomicDependencies: node.dependsOn
          .filter((dependency) => dependency.startsWith("atom:"))
          .map((dependency) => dependency.slice("atom:".length)),
        sourceAtomicDependencies: discoveredComponent.transitiveAtoms,
      }),
    );
  }
  const rawCapabilityClosure = (rootId: string) => {
    const occurrences: Array<{
      component: (typeof componentGraph.components)[number];
      occurrence: (typeof componentGraph.components)[number]["rawCapabilities"][number];
    }> = [];
    const visited = new Set<string>();
    const visit = (componentId: string): void => {
      if (visited.has(componentId)) return;
      visited.add(componentId);
      const component = discoveredComponentById.get(componentId);
      if (!component || component.inferredLayer === "atom") return;
      for (const occurrence of component.rawCapabilities) {
        occurrences.push({ component, occurrence });
      }
      for (const dependency of component.dependencies) visit(dependency);
    };
    visit(rootId);
    return occurrences;
  };
  for (const component of componentGraph.components) {
    if (component.inferredLayer !== "molecule") continue;
    const owner = `${component.file}:${component.symbol}`;
    for (const {
      component: capabilityOwner,
      occurrence,
    } of rawCapabilityClosure(component.id)) {
      for (const capability of occurrence.capabilities) {
        const capabilityOwnerKey = `${capabilityOwner.file}:${capabilityOwner.symbol}`;
        findings.push(
          makeFinding({
            rule: "composition/raw-capability-owner",
            nodeId: null,
            owner,
            evidence: `${capabilityOwnerKey}:${occurrence.line}:${capability}`,
            detail:
              capabilityOwnerKey === owner
                ? `${owner} claims ${capability} on raw <${occurrence.host}> at line ${occurrence.line}`
                : `${owner} reaches helper ${capabilityOwnerKey}, which claims ${capability} on raw <${occurrence.host}> at line ${occurrence.line}`,
          }),
        );
      }
    }
  }
  const moleculeContracts = loadMoleculeContracts();
  const contractedOwners = new Set(
    moleculeContracts.map((contract) => `${contract.owner}:${contract.symbol}`),
  );
  for (const component of componentGraph.components) {
    if (!component.exported || component.inferredLayer !== "molecule") continue;
    const ownerFile = component.file;
    const ownerKey = `${ownerFile}:${component.symbol}`;
    if (contractedOwners.has(ownerKey)) continue;
    const suffix = createHash("sha256")
      .update(ownerKey)
      .digest("hex")
      .slice(0, 8);
    nodes.push({
      id: `molecule:${component.symbol}-${suffix}`,
      layer: "molecule",
      owner: { kind: "export", file: ownerFile, symbol: component.symbol },
      responsibility: `Discovered reusable composition owned by ${component.symbol}.`,
      dependsOn: component.transitiveAtoms.map(
        (atom): `atom:${string}` => `atom:${atom}`,
      ),
      grants: ["layout.container", "semantics.content"],
      provenance: "derived-component-discovery",
      requiredRenderedTags: [],
    });
  }

  for (const contract of moleculeContracts) {
    const nodeId: `molecule:${string}` = `molecule:${contract.id}`;
    const owner = sourceByFile.get(contract.owner);
    const declaration = owner?.exports.get(contract.symbol);
    const ownerKey = `${contract.owner}:${contract.symbol}`;
    const discoveredComponent = discoveredComponentByOwner.get(ownerKey);
    const liveAtomicDependencies = discoveredComponent?.transitiveAtoms ?? [];
    if (!declaration) {
      findings.push(
        makeFinding({
          rule: "registry/molecule-owner",
          nodeId,
          owner: ownerKey,
          evidence: "missing-export",
          detail: `${ownerKey} is not a maintained exported owner`,
        }),
      );
    } else {
      const missingTags = contract.requiredRenderedTags.filter(
        (tag) => !declaration.renderedTags.includes(tag),
      );
      if (missingTags.length > 0) {
        findings.push(
          makeFinding({
            rule: "composition/missing-rendered-tag",
            nodeId,
            owner: ownerKey,
            evidence: missingTags.join(","),
            detail: `${ownerKey} is missing rendered tags ${missingTags.join(", ")}`,
          }),
        );
      }
      findings.push(
        ...validateDeclaredAtomicDependencies({
          nodeId,
          owner: ownerKey,
          declaredAtomicDependencies: contract.requiredAtomicDependencies,
          sourceAtomicDependencies: liveAtomicDependencies,
        }),
      );
      const maintainedConsumerFiles = new Set(
        discoveredComponent?.consumers.map((consumer) =>
          consumer.replace(/#[^#]+$/, ""),
        ) ?? [],
      );
      findings.push(
        ...validateDeclaredMoleculeConsumers({
          nodeId,
          owner: ownerKey,
          requiredConsumerFiles: contract.requiredConsumerFiles,
          minimumMaintainedReferences: contract.minimumMaintainedReferences,
          sourceConsumerFiles: [...maintainedConsumerFiles],
        }),
      );
    }
    const node: MoleculeDesignNode = {
      id: nodeId,
      layer: "molecule",
      owner: { kind: "export", file: contract.owner, symbol: contract.symbol },
      responsibility: contract.responsibility,
      dependsOn: liveAtomicDependencies.map(
        (atom): `atom:${string}` => `atom:${atom}`,
      ),
      grants: ["layout.container", "semantics.content"],
      provenance: "derived-molecule-contract",
      requiredRenderedTags: contract.requiredRenderedTags,
    };
    nodes.push(node);
  }

  const availableOwners = new Set(
    sources.flatMap((source) =>
      [...source.exports.keys()].map((symbol) => `${source.file}:${symbol}`),
    ),
  );
  findings.push(
    ...validateHigherOrderOwners(higherOrderNodes, availableOwners),
  );
  const pageShell = higherOrder.pageShells[0];
  const classifiedBuiltinRoutes: string[] = [];
  for (const routeId of BUILTIN_ROUTE_IDS) {
    const descriptor = resolveBuiltinRouteDescriptor(routeId);
    if (!descriptor) continue;
    classifiedBuiltinRoutes.push(routeId);
    const topology = descriptor.layout.topology ?? "framed";
    if (topology === "ambient") continue;
    if (!pageShell) {
      findings.push(
        makeFinding({
          rule: "route/missing-page-shell",
          nodeId: null,
          owner: routeId,
          evidence: descriptor.layout.kind,
          detail: `Framed route ${routeId} has no declared page-shell owner`,
        }),
      );
      continue;
    }
    if (!pageShell.supportedLayoutKinds.includes(descriptor.layout.kind)) {
      findings.push(
        makeFinding({
          rule: "route/unsupported-layout-kind",
          nodeId: pageShell.id,
          owner: routeId,
          evidence: descriptor.layout.kind,
          detail: `Route ${routeId} uses unsupported layout kind ${descriptor.layout.kind}`,
        }),
      );
    }
    if (!pageShell.supportedTopologies.includes("framed")) {
      findings.push(
        makeFinding({
          rule: "route/unsupported-topology",
          nodeId: pageShell.id,
          owner: routeId,
          evidence: topology,
          detail: `Route ${routeId} uses unsupported topology ${topology}`,
        }),
      );
    }
  }
  nodes.push(...higherOrderNodes);

  nodes.sort((left, right) => left.id.localeCompare(right.id));
  validateDesignNodes(nodes);
  findings.push(...validateDesignDependencyGraph(nodes));
  findings.sort(
    (left, right) =>
      left.rule.localeCompare(right.rule) ||
      left.owner.localeCompare(right.owner) ||
      left.fingerprint.localeCompare(right.fingerprint),
  );
  const occurrences = (entries: SourceOccurrence[]): SourceOccurrence[] =>
    entries.sort(
      (left, right) =>
        left.file.localeCompare(right.file) ||
        left.line - right.line ||
        left.tag.localeCompare(right.tag),
    );

  return {
    schemaVersion: 1,
    scope: {
      roots: ["packages", "plugins"],
      extensions: [".ts", ".tsx", ".js", ".jsx"],
      excludesTestsFixturesAndGeneratedOutput: true,
    },
    scannedFiles: sources.length,
    sourceFiles,
    nodes,
    edges: nodes
      .flatMap((node) => node.dependsOn.map((to) => ({ from: node.id, to })))
      .sort(
        (left, right) =>
          left.from.localeCompare(right.from) ||
          left.to.localeCompare(right.to),
      ),
    findings,
    observations: {
      tokens: tokenInventory.records,
      paintedRawHosts: occurrences(paintedRawHosts),
      interactiveRawHosts: occurrences(interactiveRawHosts),
      classifiedBuiltinRoutes,
      discoveredComponents: componentGraph.components,
    },
  };
}

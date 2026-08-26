#!/usr/bin/env node
/**
 * Groups exported React compositions by product role and canonical atomic
 * dependencies. Detection creates a review queue for repeated molecular UI;
 * the committed report requires a final disposition for every cluster.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  buildInventory,
  listMaintainedSourceFiles,
} from "./find-duplicate-components.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const reportJson = path.join(
  scriptDir,
  "duplicate-molecular-components-report.json",
);
const reportMarkdown = path.join(
  scriptDir,
  "duplicate-molecular-components-report.md",
);
const decisionsPath = path.join(
  scriptDir,
  "molecular-inventory-decisions.json",
);
const contractsPath = path.join(scriptDir, "molecule-contracts.json");
const repoRoot = path.resolve(scriptDir, "../../..");
const sourceFileCache = new Map();
const compositionCache = new Map();
const moduleExportCache = new Map();

const FINAL_DISPOSITIONS = new Set([
  "distinct-domain-compositions",
  "shared-lifecycle-owner",
]);

const ARCHETYPES = [
  ["empty-state", /(EmptyState|Empty|Unavailable|NoResults)$/],
  ["dialog", /(Dialog|Modal|Sheet|Drawer)$/],
  ["form", /(Form|Editor|Composer)$/],
  ["picker", /(Picker|Selector|Chooser|Switcher)$/],
  ["table", /(Table|Grid)$/],
  ["list", /(List|Feed)$/],
  ["card", /(Card|Tile|Widget)$/],
  ["row", /(Row|Item|Cell)$/],
  ["panel", /(Panel|Section|Pane)$/],
  ["header", /(Header|Toolbar|Bar)$/],
  ["navigation", /(Sidebar|Navigation|Nav|Tabs)$/],
];

function archetypeFor(name) {
  return ARCHETYPES.find(([, pattern]) => pattern.test(name))?.[0] ?? null;
}

export function validateMolecularDecisions(clusters, decisions) {
  const clusterSignatures = new Set(
    clusters.map((cluster) => cluster.signature),
  );
  const missingDecisions = clusters
    .filter((cluster) => {
      const decision = decisions[cluster.signature];
      return (
        !decision ||
        typeof decision.disposition !== "string" ||
        typeof decision.rationale !== "string" ||
        decision.rationale.trim().length === 0
      );
    })
    .map((cluster) => cluster.signature);
  const nonFinalDecisions = clusters
    .filter((cluster) => {
      const disposition = decisions[cluster.signature]?.disposition;
      return (
        typeof disposition === "string" && !FINAL_DISPOSITIONS.has(disposition)
      );
    })
    .map(
      (cluster) =>
        `${cluster.signature} (${decisions[cluster.signature].disposition})`,
    );
  const staleDecisions = Object.keys(decisions).filter(
    (signature) => !clusterSignatures.has(signature),
  );

  if (
    missingDecisions.length > 0 ||
    nonFinalDecisions.length > 0 ||
    staleDecisions.length > 0
  ) {
    throw new Error(
      `Molecular decisions must be complete and final. Missing: ${missingDecisions.join(", ") || "none"}; non-final: ${nonFinalDecisions.join(", ") || "none"}; stale: ${staleDecisions.join(", ") || "none"}. Allowed final dispositions: ${[...FINAL_DISPOSITIONS].join(", ")}`,
    );
  }
}

function transitiveAtomicDependencies(owner, components, atoms) {
  const dependencies = new Set(owner.atomicDependencies);
  const visited = new Set();
  const visit = (component) => {
    const key = `${component.file}:${component.name}`;
    if (visited.has(key)) return;
    visited.add(key);
    for (const dependency of component.atomicDependencies) {
      dependencies.add(dependency);
    }
    for (const tag of component.renderedTags) {
      for (const child of components.filter((entry) => entry.name === tag)) {
        visit(child);
      }
    }
  };
  visit(owner);

  if (atoms) {
    const source = fs.readFileSync(path.join(repoRoot, owner.file), "utf8");
    for (const [kind, inventory] of Object.entries(atoms)) {
      const symbols = inventory.canonical
        .map((entry) => entry.name)
        .filter((name) => typeof name === "string");
      if (
        symbols.some(
          (symbol) =>
            source.includes(`<${symbol}`) ||
            source.includes(`createElement(${symbol}`),
        )
      ) {
        dependencies.add(kind);
      }
    }
  }
  return dependencies;
}

export function validateMoleculeContracts(
  components,
  contracts,
  references,
  atoms,
) {
  const errors = [];
  const ids = new Set();
  const owners = new Set();

  for (const contract of contracts) {
    const ownerKey = `${contract.owner}:${contract.symbol}`;
    if (ids.has(contract.id)) errors.push(`duplicate id ${contract.id}`);
    if (owners.has(ownerKey)) errors.push(`duplicate owner ${ownerKey}`);
    ids.add(contract.id);
    owners.add(ownerKey);

    const owner = components.find(
      (component) =>
        component.file === contract.owner && component.name === contract.symbol,
    );
    if (!owner) {
      errors.push(`missing owner ${ownerKey}`);
      continue;
    }

    const liveDependencies = transitiveAtomicDependencies(
      owner,
      components,
      atoms,
    );
    const missingDependencies = contract.requiredAtomicDependencies.filter(
      (dependency) => !liveDependencies.has(dependency),
    );
    if (missingDependencies.length > 0) {
      errors.push(
        `${ownerKey} is missing atomic dependencies ${missingDependencies.join(", ")}`,
      );
    }

    const missingTags = (contract.requiredRenderedTags ?? []).filter(
      (tag) => !owner.renderedTags.includes(tag),
    );
    if (missingTags.length > 0) {
      errors.push(
        `${ownerKey} is missing rendered tags ${missingTags.join(", ")}`,
      );
    }

    const referenceCount = references[ownerKey] ?? 0;
    if (referenceCount < contract.minimumMaintainedReferences) {
      errors.push(
        `${ownerKey} has ${referenceCount} maintained references; expected at least ${contract.minimumMaintainedReferences}`,
      );
    }

    for (const consumerFile of contract.requiredConsumerFiles ?? []) {
      const absoluteConsumer = path.join(repoRoot, consumerFile);
      if (
        !fs.existsSync(absoluteConsumer) ||
        !fileComposesContract(absoluteConsumer, contract)
      ) {
        errors.push(
          `${consumerFile} no longer consumes canonical ${contract.symbol}`,
        );
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Canonical molecule contracts failed: ${errors.join("; ")}`,
    );
  }
}

function maintainedReferenceCounts(contracts) {
  const references = Object.fromEntries(
    contracts.map((contract) => [`${contract.owner}:${contract.symbol}`, 0]),
  );
  const symbols = new Map(
    contracts.map((contract) => [contract.symbol, contract]),
  );

  for (const absoluteFile of listMaintainedSourceFiles()) {
    const file = path
      .relative(repoRoot, absoluteFile)
      .replaceAll(path.sep, "/");
    for (const [symbol, contract] of symbols) {
      if (file === contract.owner) continue;
      if (fileComposesContract(absoluteFile, contract)) {
        references[`${contract.owner}:${symbol}`] += 1;
      }
    }
  }
  return references;
}

export function fileComposesContract(absoluteFile, contract) {
  const cacheKey = `${absoluteFile}:${contract.owner}:${contract.symbol}`;
  if (compositionCache.has(cacheKey)) return compositionCache.get(cacheKey);
  const source = fs.readFileSync(absoluteFile, "utf8");
  const sourceFile = parsedSourceFile(absoluteFile, source);
  const bindings = new Set();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const modulePath = resolveSourceModule(
      absoluteFile,
      statement.moduleSpecifier.text,
    );
    if (!modulePath) continue;
    for (const element of statement.importClause.namedBindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text;
      if (
        moduleExportsContract(modulePath, importedName, contract, new Set())
      ) {
        bindings.add(element.name.text);
      }
    }
  }
  let composed = false;
  const visit = (node) => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      ts.isIdentifier(node.tagName) &&
      bindings.has(node.tagName.text)
    ) {
      composed = true;
      return;
    }
    if (!composed) ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  compositionCache.set(cacheKey, composed);
  return composed;
}

function moduleExportsContract(modulePath, exportedName, contract, visited) {
  const visitKey = `${modulePath}:${exportedName}`;
  if (visited.has(visitKey)) return false;
  visited.add(visitKey);
  const cacheKey = `${visitKey}:${contract.owner}:${contract.symbol}`;
  if (moduleExportCache.has(cacheKey)) return moduleExportCache.get(cacheKey);
  const relativeModule = path
    .relative(repoRoot, modulePath)
    .replaceAll(path.sep, "/");
  if (relativeModule === contract.owner && exportedName === contract.symbol) {
    moduleExportCache.set(cacheKey, true);
    return true;
  }

  const source = fs.readFileSync(modulePath, "utf8");
  const sourceFile = parsedSourceFile(modulePath, source);
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier)
      continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const nextModule = resolveSourceModule(
      modulePath,
      statement.moduleSpecifier.text,
    );
    if (!nextModule) continue;
    if (!statement.exportClause) {
      if (moduleExportsContract(nextModule, exportedName, contract, visited)) {
        moduleExportCache.set(cacheKey, true);
        return true;
      }
      continue;
    }
    if (!ts.isNamedExports(statement.exportClause)) continue;
    for (const element of statement.exportClause.elements) {
      if (element.name.text !== exportedName) continue;
      const importedName = element.propertyName?.text ?? element.name.text;
      if (moduleExportsContract(nextModule, importedName, contract, visited)) {
        moduleExportCache.set(cacheKey, true);
        return true;
      }
    }
  }
  moduleExportCache.set(cacheKey, false);
  return false;
}

function parsedSourceFile(absoluteFile, source) {
  if (sourceFileCache.has(absoluteFile))
    return sourceFileCache.get(absoluteFile);
  const sourceFile = ts.createSourceFile(
    absoluteFile,
    source,
    ts.ScriptTarget.Latest,
    true,
    absoluteFile.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  sourceFileCache.set(absoluteFile, sourceFile);
  return sourceFile;
}

function resolveSourceModule(importingFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(importingFile), specifier);
  for (const candidate of [
    base,
    `${base}.tsx`,
    `${base}.ts`,
    path.join(base, "index.tsx"),
    path.join(base, "index.ts"),
  ]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

export function buildMolecularInventory() {
  const atomicReport = buildInventory();
  const decisions = JSON.parse(fs.readFileSync(decisionsPath, "utf8"));
  const contractRegistry = parseMoleculeContractRegistry(
    JSON.parse(fs.readFileSync(contractsPath, "utf8")),
  );
  const references = maintainedReferenceCounts(contractRegistry.contracts);
  validateMoleculeContracts(
    atomicReport.components,
    contractRegistry.contracts,
    references,
    atomicReport.atoms,
  );
  const components = atomicReport.components
    .map((component) => ({
      ...component,
      archetype: archetypeFor(component.name),
    }))
    .filter(
      (component) =>
        component.archetype && component.atomicDependencies.length >= 2,
    );
  const bySignature = new Map();
  for (const component of components) {
    const signature = `${component.archetype}:${component.atomicDependencies.join("+")}`;
    if (!bySignature.has(signature)) bySignature.set(signature, []);
    bySignature.get(signature).push(component);
  }

  const detectedClusters = [...bySignature]
    .map(([signature, entries]) => ({
      archetype: entries[0].archetype,
      atomicDependencies: entries[0].atomicDependencies,
      entries: entries.sort(
        (a, b) =>
          a.file.localeCompare(b.file) ||
          a.line - b.line ||
          a.name.localeCompare(b.name),
      ),
      signature,
    }))
    .filter((cluster) => cluster.entries.length >= 2)
    .sort(
      (a, b) =>
        b.entries.length - a.entries.length ||
        a.signature.localeCompare(b.signature),
    );

  validateMolecularDecisions(detectedClusters, decisions);
  const clusters = detectedClusters.map((cluster) => ({
    ...cluster,
    ...decisions[cluster.signature],
  }));

  return {
    schemaVersion: 2,
    sourceAtomicSchemaVersion: atomicReport.schemaVersion,
    scannedFiles: atomicReport.scannedFiles,
    canonicalContracts: contractRegistry.contracts.map((contract) => ({
      ...contract,
      maintainedReferences: references[`${contract.owner}:${contract.symbol}`],
    })),
    eligibleComponents: components.length,
    clusters,
    summary: {
      clusterCount: clusters.length,
      clusteredComponents: clusters.reduce(
        (total, cluster) => total + cluster.entries.length,
        0,
      ),
      largestCluster: clusters[0]?.entries.length ?? 0,
    },
  };
}

export function parseMoleculeContractRegistry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Molecule contract registry must be an object");
  }
  if (value.schemaVersion !== 1 || !Array.isArray(value.contracts)) {
    throw new Error(
      "Molecule contract registry requires schemaVersion 1 and contracts",
    );
  }

  for (const [index, contract] of value.contracts.entries()) {
    const context = `Molecule contract at index ${index}`;
    if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
      throw new Error(`${context} must be an object`);
    }
    const allowedFields = new Set([
      "id",
      "minimumMaintainedReferences",
      "owner",
      "requiredAtomicDependencies",
      "requiredConsumerFiles",
      "requiredRenderedTags",
      "responsibility",
      "symbol",
    ]);
    const unknownField = Object.keys(contract).find(
      (field) => !allowedFields.has(field),
    );
    if (unknownField)
      throw new Error(`${context} has unknown field ${unknownField}`);
    for (const field of ["id", "owner", "symbol", "responsibility"]) {
      if (
        typeof contract[field] !== "string" ||
        contract[field].trim() === ""
      ) {
        throw new Error(`${context} requires non-empty ${field}`);
      }
    }
    if (
      path.isAbsolute(contract.owner) ||
      contract.owner.split("/").includes("..") ||
      !contract.owner.startsWith("packages/")
    ) {
      throw new Error(`${context} owner must be a safe packages-relative path`);
    }
    for (const field of [
      "requiredAtomicDependencies",
      "requiredRenderedTags",
      "requiredConsumerFiles",
    ]) {
      if (
        !Array.isArray(contract[field]) ||
        contract[field].some(
          (entry) => typeof entry !== "string" || entry.trim() === "",
        )
      ) {
        throw new Error(`${context} requires a string array for ${field}`);
      }
    }
    if (
      contract.requiredConsumerFiles.some(
        (consumer) =>
          path.isAbsolute(consumer) ||
          consumer.split("/").includes("..") ||
          !consumer.startsWith("packages/"),
      )
    ) {
      throw new Error(
        `${context} consumers must be safe packages-relative paths`,
      );
    }
    if (
      !Number.isInteger(contract.minimumMaintainedReferences) ||
      contract.minimumMaintainedReferences < 0
    ) {
      throw new Error(`${context} requires a non-negative reference floor`);
    }
  }
  return value;
}

export function renderMolecularMarkdown(report) {
  const lines = [
    "# Molecular component duplicate inventory",
    "",
    `Scanned ${report.scannedFiles} maintained React files. ${report.eligibleComponents} exported compositions have a recognized molecular role and at least two atomic dependencies.`,
    "",
    "Clusters share both a role and an atomic dependency signature. Detection creates a review queue; this committed report contains only final dispositions based on product behavior, state ownership, and responsive layout.",
    "",
    "## Canonical molecule contracts",
    "",
    "These owners are fail-closed contracts. The audit fails if an owner disappears, drops a required canonical atom, or loses its maintained consumers.",
    "",
    "| Contract | Canonical owner | Maintained references | Responsibility |",
    "| --- | --- | ---: | --- |",
    ...report.canonicalContracts.map(
      (contract) =>
        `| ${contract.id} | \`${contract.symbol}\` in \`${contract.owner}\` | ${contract.maintainedReferences} | ${contract.responsibility} |`,
    ),
    "",
    "## Duplicate review queue",
    "",
    "| Role | Atomic dependencies | Components | Decision |",
    "| --- | --- | ---: | --- |",
  ];

  for (const cluster of report.clusters) {
    lines.push(
      `| ${cluster.archetype} | ${cluster.atomicDependencies.join(", ")} | ${cluster.entries.length} | ${cluster.disposition} |`,
    );
  }

  lines.push("", "## Reviewed clusters", "");
  for (const cluster of report.clusters) {
    lines.push(
      `### ${cluster.archetype}: ${cluster.atomicDependencies.join(" + ")}`,
      "",
    );
    for (const entry of cluster.entries) {
      lines.push(`- \`${entry.name}\` in \`${entry.file}:${entry.line}\``);
    }
    lines.push(`- Decision: **${cluster.disposition}** — ${cluster.rationale}`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const report = buildMolecularInventory();
  const markdown = renderMolecularMarkdown(report);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (process.argv.includes("--check")) {
    if (
      !fs.existsSync(reportMarkdown) ||
      fs.readFileSync(reportMarkdown, "utf8") !== markdown
    ) {
      throw new Error(
        `${path.basename(reportMarkdown)} is stale. Run bun run --cwd packages/ui audit:molecular-inventory.`,
      );
    }
    process.stdout.write(
      `Molecular inventory is current with ${report.clusters.length} final dispositions.\n`,
    );
  } else {
    fs.writeFileSync(reportJson, json);
    fs.writeFileSync(reportMarkdown, markdown);
    process.stdout.write(markdown);
  }
}

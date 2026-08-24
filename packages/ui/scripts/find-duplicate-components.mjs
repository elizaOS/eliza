#!/usr/bin/env node
/**
 * Inventories atomic React component definitions across maintained packages and
 * plugins. The TypeScript AST keeps definitions, wrappers, and adapters apart.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../..");
const canonicalRoot = "packages/ui/src/components/ui";
const reportJson = path.join(scriptDir, "duplicate-components-report.json");
const reportMarkdown = path.join(scriptDir, "duplicate-components-report.md");
const decisions = JSON.parse(
  fs.readFileSync(
    path.join(scriptDir, "component-inventory-decisions.json"),
    "utf8",
  ),
);

export const ATOMS = {
  alert: { names: ["Alert"], hosts: ["div"], rawHosts: [] },
  avatar: { names: ["Avatar"], hosts: ["div", "img"], rawHosts: [] },
  badge: {
    names: ["Badge", "StatusBadge"],
    hosts: ["span", "div"],
    rawHosts: [],
  },
  button: { names: ["Button"], hosts: ["button"], rawHosts: ["button"] },
  card: { names: ["Card"], hosts: ["div", "section", "article"], rawHosts: [] },
  checkbox: {
    names: ["Checkbox"],
    hosts: ["button", "input"],
    rawHosts: ["input"],
  },
  dialog: { names: ["Dialog"], hosts: ["dialog", "div"], rawHosts: ["dialog"] },
  input: { names: ["Input"], hosts: ["input"], rawHosts: ["input"] },
  popover: { names: ["Popover"], hosts: ["div"], rawHosts: [] },
  progress: {
    names: ["Progress"],
    hosts: ["div", "progress"],
    rawHosts: ["progress"],
  },
  select: {
    names: ["Select"],
    hosts: ["select", "button"],
    rawHosts: ["select"],
  },
  separator: { names: ["Separator"], hosts: ["div", "hr"], rawHosts: ["hr"] },
  skeleton: { names: ["Skeleton"], hosts: ["div"], rawHosts: [] },
  spinner: { names: ["Spinner"], hosts: ["svg", "div"], rawHosts: [] },
  switch: {
    names: ["Switch"],
    hosts: ["button", "input"],
    rawHosts: ["input"],
  },
  table: { names: ["Table"], hosts: ["table"], rawHosts: ["table"] },
  tabs: { names: ["Tabs"], hosts: ["div"], rawHosts: [] },
  textarea: {
    names: ["Textarea"],
    hosts: ["textarea"],
    rawHosts: ["textarea"],
  },
  tooltip: { names: ["Tooltip"], hosts: ["div"], rawHosts: [] },
};

const ATOM_BY_NAME = new Map(
  Object.entries(ATOMS).flatMap(([atom, definition]) =>
    definition.names.map((name) => [name.toLowerCase(), atom]),
  ),
);

const relative = (file) =>
  path.relative(repoRoot, file).replaceAll(path.sep, "/");

function isMaintainedSource(file) {
  const rel = relative(file);
  return (
    /^(packages|plugins)\//.test(rel) &&
    /\.[jt]sx$/.test(rel) &&
    !/(^|\/)(node_modules|dist|build|coverage|generated)(\/|$)/.test(rel) &&
    !/\.(stories|test|spec)\.[jt]sx$/.test(rel) &&
    !/(^|\/)(__tests__|__fixtures__|fixtures)(\/|$)/.test(rel)
  );
}

function* walk(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", "dist", "build", ".git"].includes(entry.name))
      continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (isMaintainedSource(full)) yield full;
  }
}

function componentName(node) {
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  if (ts.isClassDeclaration(node) && node.name) return node.name.text;
  if (ts.isVariableStatement(node)) {
    const declaration = node.declarationList.declarations[0];
    if (declaration && ts.isIdentifier(declaration.name))
      return declaration.name.text;
  }
  return null;
}

const isExported = (node, exportedNames) =>
  Boolean(
    node.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    ) || exportedNames.has(componentName(node)),
  );

function localExportNames(sourceFile) {
  const names = new Set();
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

function jsxTags(node) {
  const tags = new Set();
  function visit(current) {
    if (
      ts.isJsxOpeningElement(current) ||
      ts.isJsxSelfClosingElement(current)
    ) {
      tags.add(current.tagName.getText());
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return [...tags].sort();
}

function importsByLocalName(sourceFile) {
  const imports = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    const origin = statement.moduleSpecifier.text;
    const bindings = statement.importClause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        imports.set(element.name.text, {
          imported: element.propertyName?.text ?? element.name.text,
          origin,
        });
      }
    }
    if (statement.importClause.name) {
      imports.set(statement.importClause.name.text, {
        imported: "default",
        origin,
      });
    }
  }
  return imports;
}

function isCanonicalImport(record, file) {
  if (!record) return false;
  const resolvedRelative = record.origin.startsWith(".")
    ? relative(path.resolve(path.dirname(file), record.origin))
    : "";
  return Boolean(
    record.origin === "@elizaos/ui" ||
      record.origin.startsWith("@elizaos/ui/") ||
      resolvedRelative.startsWith(`${canonicalRoot}/`) ||
      /components\/(ui|primitives)\//.test(record.origin),
  );
}

function classify({ atom, file, name, tags, imports }) {
  const rel = relative(file);
  if (rel.startsWith(`${canonicalRoot}/`)) return "canonical";
  if (rel.includes("/templates/")) return "template-adapter";
  if (/(^|\/)(test|tests|stubs|__mocks__)(\/|$)/.test(rel)) {
    return "test-double";
  }
  if (rel.startsWith("packages/ui/src/spatial/")) return "renderer-adapter";
  if (tags.some((tag) => isCanonicalImport(imports.get(tag), file))) {
    return "canonical-wrapper";
  }
  if (ATOM_BY_NAME.get(name.toLowerCase()) === atom) {
    return "same-name-definition";
  }
  if (atom === "card" && !/^(Brand|Mini|Surface)/.test(name)) {
    return "molecular-candidate";
  }
  return "parallel-primitive";
}

function matchingAtoms(name, tags) {
  const matches = new Set();
  const normalized = name.toLowerCase();
  const direct = ATOM_BY_NAME.get(normalized);
  if (direct) matches.add(direct);
  for (const [atom, definition] of Object.entries(ATOMS)) {
    if (
      definition.names.some((candidate) =>
        normalized.endsWith(candidate.toLowerCase()),
      ) ||
      (normalized.includes(atom) &&
        tags.some((tag) => definition.hosts.includes(tag)))
    ) {
      matches.add(atom);
    }
  }
  return [...matches];
}

export function buildInventory() {
  const files = [
    ...walk(path.join(repoRoot, "packages")),
    ...walk(path.join(repoRoot, "plugins")),
  ].sort();
  const candidates = [];
  const rawHostUsage = Object.fromEntries(
    Object.keys(ATOMS).map((atom) => [atom, []]),
  );

  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const imports = importsByLocalName(sourceFile);
    const exportedNames = localExportNames(sourceFile);
    const fileHostLines = new Map();

    function visit(node) {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText();
        if (/^[a-z]/.test(tag)) {
          const line =
            sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          if (!fileHostLines.has(tag)) fileHostLines.set(tag, []);
          fileHostLines.get(tag).push(line);
        }
      }

      const name = componentName(node);
      if (name && /^[A-Z]/.test(name) && isExported(node, exportedNames)) {
        const tags = jsxTags(node);
        for (const atom of matchingAtoms(name, tags)) {
          candidates.push({
            atom,
            classification: classify({ atom, file, name, tags, imports }),
            file: relative(file),
            line:
              sourceFile.getLineAndCharacterOfPosition(node.getStart()).line +
              1,
            name,
            renderedTags: tags,
          });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);

    for (const [atom, definition] of Object.entries(ATOMS)) {
      const lines = definition.rawHosts.flatMap(
        (host) => fileHostLines.get(host) ?? [],
      );
      if (lines.length > 0) {
        rawHostUsage[atom].push({
          file: relative(file),
          lines: [...new Set(lines)].sort((a, b) => a - b),
        });
      }
    }
  }

  candidates.sort(
    (a, b) =>
      a.atom.localeCompare(b.atom) ||
      a.classification.localeCompare(b.classification) ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  );
  for (const candidate of candidates) {
    const decision = decisions[`${candidate.file}:${candidate.name}`];
    if (decision) candidate.decision = decision;
  }
  const atoms = {};
  for (const atom of Object.keys(ATOMS)) {
    const entries = candidates.filter((candidate) => candidate.atom === atom);
    atoms[atom] = {
      canonical: entries.filter(
        (entry) => entry.classification === "canonical",
      ),
      candidates: entries.filter(
        (entry) => entry.classification !== "canonical",
      ),
      rawHostUsage: rawHostUsage[atom],
    };
  }

  return {
    schemaVersion: 1,
    scope: ["packages/**/*.tsx", "plugins/**/*.tsx"],
    scannedFiles: files.length,
    atoms,
    summary: {
      atomicKinds: Object.keys(ATOMS).length,
      componentCandidates: candidates.length,
      sameNameDefinitions: candidates.filter(
        (candidate) => candidate.classification === "same-name-definition",
      ).length,
      canonicalWrappers: candidates.filter(
        (candidate) => candidate.classification === "canonical-wrapper",
      ).length,
      parallelPrimitives: candidates.filter(
        (candidate) => candidate.classification === "parallel-primitive",
      ).length,
      molecularCandidates: candidates.filter(
        (candidate) => candidate.classification === "molecular-candidate",
      ).length,
      reviewedParallelPrimitives: candidates.filter(
        (candidate) =>
          candidate.classification === "parallel-primitive" &&
          candidate.decision,
      ).length,
    },
  };
}

export function renderMarkdown(report) {
  const lines = [
    "# Atomic component duplicate inventory",
    "",
    `Scanned ${report.scannedFiles} maintained React source files across packages and plugins.`,
    "",
    "This is a candidate inventory, not an instruction to merge every entry. Canonical wrappers, renderer adapters, and test doubles remain separate because they often have legitimate ownership.",
    "",
    "| Atom | Canonical | Same-name | Wrappers | Parallel primitives | Raw host files |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const [atom, group] of Object.entries(report.atoms)) {
    const count = (classification) =>
      group.candidates.filter(
        (entry) => entry.classification === classification,
      ).length;
    lines.push(
      `| ${atom} | ${group.canonical.length} | ${count("same-name-definition")} | ${count("canonical-wrapper")} | ${count("parallel-primitive")} | ${group.rawHostUsage.length} |`,
    );
  }

  lines.push("", "## Named candidates by atom", "");
  for (const [atom, group] of Object.entries(report.atoms)) {
    lines.push(`### ${atom}`, "");
    if (group.candidates.length === 0) {
      lines.push("No named candidates.", "");
      continue;
    }
    lines.push(
      "| Classification | Decision | Definition | Canonical owner | Rendered tags |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const entry of group.candidates) {
      const tags = entry.renderedTags.map((tag) => `\`${tag}\``).join(", ");
      const decision = entry.decision?.disposition ?? "not-reviewed";
      const owner = entry.decision?.canonicalOwner
        ? `\`${entry.decision.canonicalOwner}\``
        : "-";
      lines.push(
        `| ${entry.classification} | ${decision} | \`${entry.name}\` in \`${entry.file}:${entry.line}\` | ${owner} | ${tags} |`,
      );
      if (entry.decision?.note)
        lines.push(`|  |  | ${entry.decision.note} |  |  |`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const report = buildInventory();
  const markdown = renderMarkdown(report);
  fs.writeFileSync(reportJson, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(reportMarkdown, markdown);
  process.stdout.write(markdown);
}

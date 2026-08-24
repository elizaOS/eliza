#!/usr/bin/env node
/**
 * Enforces canonical UI ownership across maintained React sources. It reports
 * migration debt by stable rule, applies centrally reviewed exceptions, and
 * only permits ratchet baselines to stay level or move toward zero.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { ATOMS, buildInventory } from "./find-duplicate-components.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../..");
const canonicalRoot = "packages/ui/src/components/ui";
const baselinePath = path.join(scriptDir, "design-system-baseline.json");
const exceptionsPath = path.join(scriptDir, "design-system-exceptions.json");
const reportPath = path.join(scriptDir, "design-system-compliance-report.md");

export const RULES = [
  "atomic-duplicate",
  "raw-control",
  "direct-primitive-import",
  "deep-canonical-import",
  "variant-helper-bypass",
  "unstyled-canonical",
  "visual-override",
  "off-token-color",
];

const CANONICAL_NAMES = new Set(
  Object.values(ATOMS).flatMap((definition) => definition.names),
);
const VISUAL_UTILITY =
  /(?:^|\s)(?:[a-z-]+:)*(?:bg|text|border|rounded|shadow|ring|outline|fill|stroke|p[trblxy]?|h|min-h|max-h|gap|space-[xy])-(?:\[[^\]]+\]|[^\s]+)/;
// Skeleton width, height, spacing, and radius describe the geometry of the
// content being previewed. Its paint and effects remain primitive-owned.
const SKELETON_PAINT_UTILITY =
  /(?:^|\s)(?:[a-z-]+:)*(?:bg|text|border|shadow|ring|outline|fill|stroke)-(?:\[[^\]]+\]|[^\s]+)/;
const OFF_TOKEN_COLOR =
  /(?:^|\s)(?:[a-z-]+:)*(?:bg|text|border|ring|fill|stroke|from|to|via)-(?:red|rose|pink|green|emerald|teal|lime|yellow|amber|blue|indigo|sky|violet|purple|fuchsia|cyan)-\d+/;

const relative = (file) =>
  path.relative(repoRoot, file).replaceAll(path.sep, "/");

function isGovernedSource(file) {
  const rel = relative(file);
  return (
    /^(packages|plugins)\//.test(rel) &&
    /\.[jt]sx$/.test(rel) &&
    !/(^|\/)(node_modules|dist|build|coverage|generated)(\/|$)/.test(rel) &&
    !/\.(test|spec)\.[jt]sx$/.test(rel) &&
    !/(^|\/)(test|__tests__|__e2e__|__fixtures__|fixtures|stubs|templates)(\/|$)/.test(
      rel,
    )
  );
}

function* walk(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", "dist", "build", ".git"].includes(entry.name))
      continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (isGovernedSource(full)) yield full;
  }
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
    if (bindings && ts.isNamespaceImport(bindings)) {
      imports.set(bindings.name.text, { imported: "*", origin });
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

export function resolvesToCanonical(record, file) {
  if (!record) return false;
  if (
    record.origin === "@elizaos/ui" ||
    record.origin === "@elizaos/ui/components" ||
    record.origin === "@elizaos/ui/cloud-ui"
  )
    return true;
  if (/^@elizaos\/ui\/components\/ui\/[a-z0-9-]+$/.test(record.origin)) {
    return true;
  }
  if (/^@elizaos\/ui\/(button|card|input|dropdown-menu)$/.test(record.origin))
    return true;
  if (!record.origin.startsWith(".")) return false;
  const resolved = relative(path.resolve(path.dirname(file), record.origin));
  return (
    resolved.startsWith(`${canonicalRoot}/`) ||
    resolved === "packages/ui/src/components/index" ||
    resolved === "packages/ui/src/components/primitives/index"
  );
}

function stringAttribute(node, name) {
  const attribute = node.attributes.properties.find(
    (property) =>
      ts.isJsxAttribute(property) && property.name.getText() === name,
  );
  if (!attribute || !ts.isJsxAttribute(attribute) || !attribute.initializer)
    return null;
  if (ts.isStringLiteral(attribute.initializer))
    return attribute.initializer.text;
  if (
    ts.isJsxExpression(attribute.initializer) &&
    attribute.initializer.expression &&
    (ts.isStringLiteral(attribute.initializer.expression) ||
      ts.isNoSubstitutionTemplateLiteral(attribute.initializer.expression))
  ) {
    return attribute.initializer.expression.text;
  }
  return null;
}

function hasAttribute(node, name) {
  return node.attributes.properties.some(
    (property) =>
      ts.isJsxAttribute(property) && property.name.getText() === name,
  );
}

function inputHost(node) {
  return stringAttribute(node, "type") === "checkbox" ? "checkbox" : "input";
}

function finding({ rule, file, line, symbol, detail }) {
  return { detail, file, line, rule, symbol };
}

function scanFile(file) {
  const source = fs.readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const imports = importsByLocalName(sourceFile);
  const rel = relative(file);
  const findings = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const origin = statement.moduleSpecifier.text;
    const line =
      sourceFile.getLineAndCharacterOfPosition(statement.getStart()).line + 1;
    if (
      !rel.startsWith(`${canonicalRoot}/`) &&
      origin.startsWith("@radix-ui/")
    ) {
      findings.push(
        finding({
          rule: "direct-primitive-import",
          file: rel,
          line,
          symbol: origin,
          detail:
            "Third-party primitive ownership belongs in the canonical atom layer.",
        }),
      );
    }
    if (/^@elizaos\/ui\/components\/(?:ui|primitives)(?:\/|$)/.test(origin)) {
      findings.push(
        finding({
          rule: "deep-canonical-import",
          file: rel,
          line,
          symbol: origin,
          detail:
            "Use a supported @elizaos/ui root or component subpath export.",
        }),
      );
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const imported = element.propertyName?.text ?? element.name.text;
        if (
          /Variants$/.test(imported) &&
          !rel.startsWith(`${canonicalRoot}/`) &&
          resolvesToCanonical({ imported, origin }, file)
        ) {
          findings.push(
            finding({
              rule: "variant-helper-bypass",
              file: rel,
              line,
              symbol: imported,
              detail:
                "Render the canonical component instead of applying its visual helper elsewhere.",
            }),
          );
        }
      }
    }
  }

  function visit(node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText();
      const line =
        sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      if (/^[a-z]/.test(tag) && !rel.startsWith(`${canonicalRoot}/`)) {
        const rawSymbol = tag === "input" ? inputHost(node) : tag;
        const isRawControl = [
          "button",
          "input",
          "checkbox",
          "select",
          "textarea",
          "dialog",
          "table",
        ].includes(rawSymbol);
        if (isRawControl) {
          findings.push(
            finding({
              rule: "raw-control",
              file: rel,
              line,
              symbol: rawSymbol,
              detail: `Raw <${tag}> bypasses the canonical atom owner.`,
            }),
          );
        }
        const className = stringAttribute(node, "className");
        if (isRawControl && className && VISUAL_UTILITY.test(className)) {
          findings.push(
            finding({
              rule: "visual-override",
              file: rel,
              line,
              symbol: rawSymbol,
              detail:
                "Control visuals must be owned by a typed canonical variant; caller className is layout-only.",
            }),
          );
        }
      } else {
        const rootName = tag.split(".")[0];
        const record = imports.get(rootName);
        if (record && resolvesToCanonical(record, file)) {
          if (CANONICAL_NAMES.has(record.imported)) {
            if (
              record.imported === "Button" &&
              hasAttribute(node, "unstyled")
            ) {
              findings.push(
                finding({
                  rule: "unstyled-canonical",
                  file: rel,
                  line,
                  symbol: record.imported,
                  detail:
                    "Canonical controls must express visuals through typed variants; unstyled bypasses the design-system contract.",
                }),
              );
            }
            const className = stringAttribute(node, "className");
            const visualUtility =
              record.imported === "Skeleton" || record.imported === "Tabs"
                ? SKELETON_PAINT_UTILITY
                : VISUAL_UTILITY;
            if (className && visualUtility.test(className)) {
              findings.push(
                finding({
                  rule: "visual-override",
                  file: rel,
                  line,
                  symbol: record.imported,
                  detail:
                    "Canonical visual state must use a typed variant; className is reserved for caller layout.",
                }),
              );
            }
          }
        }
      }
      const className = stringAttribute(node, "className");
      if (className && OFF_TOKEN_COLOR.test(className)) {
        findings.push(
          finding({
            rule: "off-token-color",
            file: rel,
            line,
            symbol: tag,
            detail: "Use semantic design tokens instead of palette utilities.",
          }),
        );
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return findings;
}

function parseExceptions(now) {
  const document = JSON.parse(fs.readFileSync(exceptionsPath, "utf8"));
  if (document.schemaVersion !== 1 || !Array.isArray(document.exceptions)) {
    throw new Error(
      "design-system-exceptions.json must use schemaVersion 1 with an exceptions array",
    );
  }
  const ids = new Set();
  for (const exception of document.exceptions) {
    if (
      typeof exception.id !== "string" ||
      ids.has(exception.id) ||
      !RULES.includes(exception.rule) ||
      typeof exception.file !== "string" ||
      typeof exception.symbol !== "string" ||
      typeof exception.owner !== "string" ||
      typeof exception.reason !== "string" ||
      typeof exception.reviewBy !== "string"
    ) {
      throw new Error(
        `Invalid design-system exception: ${JSON.stringify(exception)}`,
      );
    }
    ids.add(exception.id);
    const reviewBy = Date.parse(`${exception.reviewBy}T23:59:59Z`);
    if (!Number.isFinite(reviewBy) || reviewBy < now.getTime()) {
      throw new Error(
        `Stale design-system exception ${exception.id}: reviewBy=${exception.reviewBy}`,
      );
    }
  }
  return document.exceptions;
}

function applyExceptions(findings, exceptions) {
  const used = new Set();
  const active = findings.filter((entry) => {
    const exception = exceptions.find(
      (candidate) =>
        candidate.rule === entry.rule &&
        candidate.file === entry.file &&
        candidate.symbol === entry.symbol,
    );
    if (!exception) return true;
    used.add(exception.id);
    return false;
  });
  const stale = exceptions.filter((exception) => !used.has(exception.id));
  if (stale.length > 0) {
    throw new Error(
      `Unused design-system exceptions must be removed: ${stale.map((entry) => entry.id).join(", ")}`,
    );
  }
  return active;
}

export function buildComplianceReport(options = {}) {
  const now = options.now ?? new Date();
  const inventory = buildInventory();
  const findings = [];
  for (const group of Object.values(inventory.atoms)) {
    for (const candidate of group.candidates) {
      if (
        candidate.classification !== "parallel-primitive" ||
        candidate.decision?.disposition !== "consolidation-candidate"
      )
        continue;
      findings.push(
        finding({
          rule: "atomic-duplicate",
          file: candidate.file,
          line: candidate.line,
          symbol: candidate.name,
          detail: `Consolidate with ${candidate.decision.canonicalOwner}.`,
        }),
      );
    }
  }
  const files = [
    ...walk(path.join(repoRoot, "packages")),
    ...walk(path.join(repoRoot, "plugins")),
  ].sort();
  for (const file of files) findings.push(...scanFile(file));
  const active = applyExceptions(findings, parseExceptions(now)).sort(
    (a, b) =>
      a.rule.localeCompare(b.rule) ||
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.symbol.localeCompare(b.symbol),
  );
  const counts = Object.fromEntries(
    RULES.map((rule) => [
      rule,
      active.filter((entry) => entry.rule === rule).length,
    ]),
  );
  return {
    counts,
    findings: active,
    scannedFiles: files.length,
    schemaVersion: 1,
  };
}

export function renderComplianceMarkdown(report) {
  const lines = [
    "# Design-system compliance report",
    "",
    `Scanned ${report.scannedFiles} governed React source files.`,
    "",
    "| Rule | Violations |",
    "| --- | ---: |",
  ];
  for (const rule of RULES) lines.push(`| ${rule} | ${report.counts[rule]} |`);
  lines.push("", "## Findings", "");
  for (const rule of RULES) {
    lines.push(`### ${rule}`, "");
    const entries = report.findings.filter((entry) => entry.rule === rule);
    if (entries.length === 0) lines.push("None.", "");
    else {
      for (const entry of entries) {
        lines.push(
          `- \`${entry.file}:${entry.line}\` \`${entry.symbol}\`: ${entry.detail}`,
        );
      }
      lines.push("");
    }
  }
  return `${lines.join("\n")}\n`;
}

function readBaseline() {
  if (!fs.existsSync(baselinePath)) return null;
  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  if (baseline.schemaVersion !== 1 || !baseline.counts) {
    throw new Error(
      "design-system-baseline.json must use schemaVersion 1 with counts",
    );
  }
  for (const rule of RULES) {
    if (!Number.isInteger(baseline.counts[rule]) || baseline.counts[rule] < 0) {
      throw new Error(`Invalid baseline count for ${rule}`);
    }
  }
  return baseline;
}

export function compareToBaseline(report, baseline) {
  return RULES.flatMap((rule) =>
    report.counts[rule] > baseline.counts[rule]
      ? [`${rule}: ${report.counts[rule]} > ${baseline.counts[rule]}`]
      : [],
  );
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const report = buildComplianceReport();
  const markdown = renderComplianceMarkdown(report);
  fs.writeFileSync(reportPath, markdown);
  const baseline = readBaseline();
  if (process.argv.includes("--write-baseline")) {
    if (baseline) {
      const regressions = compareToBaseline(report, baseline);
      if (
        regressions.length > 0 &&
        !process.argv.includes("--accept-measurement-expansion")
      ) {
        throw new Error(
          `Refusing to raise design-system baseline: ${regressions.join(", ")}`,
        );
      }
    }
    fs.writeFileSync(
      baselinePath,
      `${JSON.stringify({ schemaVersion: 1, counts: report.counts }, null, 2)}\n`,
    );
    process.stdout.write(markdown);
  } else {
    if (!baseline)
      throw new Error(
        "Missing design-system baseline; initialize it with --write-baseline",
      );
    const regressions = compareToBaseline(report, baseline);
    if (regressions.length > 0) {
      throw new Error(
        `Design-system violations exceed baseline: ${regressions.join(", ")}`,
      );
    }
    process.stdout.write(markdown);
  }
}

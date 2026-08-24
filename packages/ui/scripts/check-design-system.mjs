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
const adaptersPath = path.join(scriptDir, "design-system-adapters.json");
const reportPath = path.join(scriptDir, "design-system-compliance-report.md");
const buttonPath = path.join(
  repoRoot,
  "packages/ui/src/components/ui/button.tsx",
);
const BUTTON_AXES = ["variant", "size", "shape", "align"];
const BUTTON_MIN_MAINTAINED_CALLERS = 2;

export const RULES = [
  "atomic-duplicate",
  "raw-control",
  "direct-primitive-import",
  "deep-canonical-import",
  "variant-helper-bypass",
  "button-axis-reuse",
  "unstyled-canonical",
  "visual-override",
  "off-token-color",
];

const CANONICAL_NAMES = new Set(
  Object.values(ATOMS).flatMap((definition) => definition.names),
);

function adapterKey(entry) {
  return `${entry.file}:${entry.symbol}:${entry.primitive}`;
}

export function validateAdapterRegistry(document) {
  if (document.schemaVersion !== 1 || !Array.isArray(document.adapters)) {
    throw new Error(
      "design-system-adapters.json must use schemaVersion 1 with an adapters array",
    );
  }
  const keys = new Set();
  for (const adapter of document.adapters) {
    const key = adapterKey(adapter);
    if (
      typeof adapter.file !== "string" ||
      !/^(packages|plugins)\/.*\.[jt]sx$/.test(adapter.file) ||
      typeof adapter.symbol !== "string" ||
      adapter.symbol.trim() === "" ||
      !CANONICAL_NAMES.has(adapter.primitive) ||
      typeof adapter.owner !== "string" ||
      adapter.owner.trim() === "" ||
      typeof adapter.reason !== "string" ||
      adapter.reason.trim() === "" ||
      !Number.isInteger(adapter.matchCount) ||
      adapter.matchCount < 1 ||
      keys.has(key)
    ) {
      throw new Error(
        `Invalid design-system adapter: ${JSON.stringify(adapter)}`,
      );
    }
    keys.add(key);
  }
  return document.adapters;
}

export function assertRegisteredAdaptersUsed(adapters, matches, exports) {
  for (const adapter of adapters) {
    const key = adapterKey(adapter);
    if (!exports.has(key)) {
      throw new Error(
        `Design-system adapter ${key} must name an exported symbol in its registered file`,
      );
    }
    const actual = matches.get(key) ?? 0;
    if (actual !== adapter.matchCount) {
      throw new Error(
        `Design-system adapter ${key} expected ${adapter.matchCount} canonical composition(s), found ${actual}`,
      );
    }
  }
}
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

function exportedNames(sourceFile) {
  const names = new Set();
  for (const statement of sourceFile.statements) {
    const exported = statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (exported && ts.isFunctionDeclaration(statement) && statement.name) {
      names.add(statement.name.text);
    }
    if (exported && ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
      }
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause) {
      if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          names.add(element.name.text);
        }
      }
    }
  }
  return names;
}

function enclosingSymbol(node) {
  for (let candidate = node.parent; candidate; candidate = candidate.parent) {
    if (ts.isFunctionDeclaration(candidate) && candidate.name) {
      return candidate.name.text;
    }
    if (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate)) {
      let owner = candidate.parent;
      while (owner && ts.isCallExpression(owner)) owner = owner.parent;
      if (
        owner &&
        ts.isVariableDeclaration(owner) &&
        ts.isIdentifier(owner.name)
      ) {
        return owner.name.text;
      }
    }
  }
  return null;
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

function propertyNameText(property) {
  if (
    property.name &&
    (ts.isIdentifier(property.name) ||
      ts.isStringLiteral(property.name) ||
      ts.isNumericLiteral(property.name))
  ) {
    return property.name.text;
  }
  return null;
}

function objectProperty(object, name) {
  return object.properties.find(
    (property) =>
      (ts.isPropertyAssignment(property) ||
        ts.isShorthandPropertyAssignment(property)) &&
      propertyNameText(property) === name,
  );
}

function indexStaticDeclarations(sourceFile) {
  const declarations = new Map();
  function visit(candidate) {
    if (
      ts.isVariableDeclaration(candidate) &&
      ts.isIdentifier(candidate.name) &&
      candidate.initializer
    ) {
      const existing = declarations.get(candidate.name.text);
      declarations.set(
        candidate.name.text,
        existing === undefined ? candidate.initializer : null,
      );
    }
    ts.forEachChild(candidate, visit);
  }
  visit(sourceFile);
  return declarations;
}

function staticStringValues(expression, declarations) {
  const values = new Set();
  const resolving = new Set();
  function collect(candidate) {
    if (
      ts.isStringLiteral(candidate) ||
      ts.isNoSubstitutionTemplateLiteral(candidate)
    ) {
      values.add(candidate.text);
      return;
    }
    if (ts.isIdentifier(candidate)) {
      const initializer = declarations.get(candidate.text);
      if (initializer && !resolving.has(candidate.text)) {
        resolving.add(candidate.text);
        collect(initializer);
        resolving.delete(candidate.text);
      }
      return;
    }
    if (ts.isConditionalExpression(candidate)) {
      collect(candidate.whenTrue);
      collect(candidate.whenFalse);
      return;
    }
    if (
      ts.isBinaryExpression(candidate) &&
      [
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
      ].includes(candidate.operatorToken.kind)
    ) {
      collect(candidate.left);
      collect(candidate.right);
    }
  }
  collect(expression);
  return [...values];
}

function jsxAxisValues(node, axis, defaults, declarations) {
  const attribute = node.attributes.properties.find(
    (property) =>
      ts.isJsxAttribute(property) && property.name.getText() === axis,
  );
  if (!attribute) return defaults[axis] ? [defaults[axis]] : [];
  if (!ts.isJsxAttribute(attribute) || !attribute.initializer) return [];
  if (ts.isStringLiteral(attribute.initializer)) {
    return [attribute.initializer.text];
  }
  if (
    ts.isJsxExpression(attribute.initializer) &&
    attribute.initializer.expression
  ) {
    return staticStringValues(attribute.initializer.expression, declarations);
  }
  return [];
}

export function extractButtonAxisDefinitions({ file, source }) {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let config = null;
  function findConfig(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "buttonVariants" &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      node.initializer.arguments[1] &&
      ts.isObjectLiteralExpression(node.initializer.arguments[1])
    ) {
      config = node.initializer.arguments[1];
      return;
    }
    ts.forEachChild(node, findConfig);
  }
  findConfig(sourceFile);
  if (!config) throw new Error("buttonVariants must be a cva config object");

  const variantsProperty = objectProperty(config, "variants");
  const defaultsProperty = objectProperty(config, "defaultVariants");
  if (
    !variantsProperty ||
    !ts.isPropertyAssignment(variantsProperty) ||
    !ts.isObjectLiteralExpression(variantsProperty.initializer) ||
    !defaultsProperty ||
    !ts.isPropertyAssignment(defaultsProperty) ||
    !ts.isObjectLiteralExpression(defaultsProperty.initializer)
  ) {
    throw new Error(
      "buttonVariants must declare object-literal variants and defaultVariants",
    );
  }

  const definitions = [];
  const defaults = {};
  for (const axis of BUTTON_AXES) {
    const axisProperty = objectProperty(variantsProperty.initializer, axis);
    if (
      !axisProperty ||
      !ts.isPropertyAssignment(axisProperty) ||
      !ts.isObjectLiteralExpression(axisProperty.initializer)
    ) {
      throw new Error(`buttonVariants is missing the ${axis} axis`);
    }
    for (const valueProperty of axisProperty.initializer.properties) {
      const value = propertyNameText(valueProperty);
      if (!value) continue;
      definitions.push({
        axis,
        file: relative(file),
        line:
          sourceFile.getLineAndCharacterOfPosition(valueProperty.getStart())
            .line + 1,
        value,
      });
    }
    const defaultProperty = objectProperty(defaultsProperty.initializer, axis);
    if (
      defaultProperty &&
      ts.isPropertyAssignment(defaultProperty) &&
      (ts.isStringLiteral(defaultProperty.initializer) ||
        ts.isNoSubstitutionTemplateLiteral(defaultProperty.initializer))
    ) {
      defaults[axis] = defaultProperty.initializer.text;
    }
  }
  return { defaults, definitions };
}

export function scanButtonAxisUsages({ file, source, defaults }) {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const imports = importsByLocalName(sourceFile);
  const declarations = indexStaticDeclarations(sourceFile);
  const usages = [];
  function record(axis, value, node) {
    usages.push({
      axis,
      file: relative(file),
      line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      value,
    });
  }
  function visit(node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const rootName = node.tagName.getText().split(".")[0];
      const imported = imports.get(rootName);
      if (
        imported?.imported === "Button" &&
        resolvesToCanonical(imported, file)
      ) {
        for (const axis of BUTTON_AXES) {
          for (const value of jsxAxisValues(
            node,
            axis,
            defaults,
            declarations,
          )) {
            record(axis, value, node);
          }
        }
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const imported = imports.get(node.expression.text);
      const options = node.arguments[0];
      if (
        imported?.imported === "buttonVariants" &&
        resolvesToCanonical(imported, file) &&
        options &&
        ts.isObjectLiteralExpression(options)
      ) {
        for (const axis of BUTTON_AXES) {
          const property = objectProperty(options, axis);
          const values =
            property && ts.isPropertyAssignment(property)
              ? staticStringValues(property.initializer, declarations)
              : defaults[axis]
                ? [defaults[axis]]
                : [];
          for (const value of values) record(axis, value, node);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return usages;
}

export function findUnderusedButtonAxes({
  definitions,
  usages,
  minimumCallers = BUTTON_MIN_MAINTAINED_CALLERS,
}) {
  return definitions
    .map((definition) => {
      const callers = usages.filter(
        (usage) =>
          usage.axis === definition.axis && usage.value === definition.value,
      );
      return { ...definition, callerCount: callers.length, callers };
    })
    .filter((entry) => entry.callerCount < minimumCallers);
}

function staticAttributeText(node, name, declarations) {
  const attribute = node.attributes.properties.find(
    (property) =>
      ts.isJsxAttribute(property) && property.name.getText() === name,
  );
  if (!attribute || !ts.isJsxAttribute(attribute) || !attribute.initializer)
    return null;
  if (ts.isStringLiteral(attribute.initializer)) {
    return attribute.initializer.text;
  }
  if (!ts.isJsxExpression(attribute.initializer)) return null;

  const fragments = [];
  const resolving = new Set();
  function collect(expression) {
    if (
      ts.isStringLiteral(expression) ||
      ts.isNoSubstitutionTemplateLiteral(expression)
    ) {
      fragments.push(expression.text);
      return;
    }
    if (ts.isTemplateExpression(expression)) {
      fragments.push(expression.head.text);
      for (const span of expression.templateSpans) {
        collect(span.expression);
        fragments.push(span.literal.text);
      }
      return;
    }
    if (ts.isIdentifier(expression)) {
      const initializer = declarations.get(expression.text);
      if (initializer && !resolving.has(expression.text)) {
        resolving.add(expression.text);
        collect(initializer);
        resolving.delete(expression.text);
      }
      return;
    }
    ts.forEachChild(expression, collect);
  }
  if (attribute.initializer.expression) {
    collect(attribute.initializer.expression);
  }
  return fragments.length > 0 ? fragments.join(" ") : null;
}

function hasOpaqueClassExpression(node, declarations) {
  const attribute = node.attributes.properties.find(
    (property) =>
      ts.isJsxAttribute(property) && property.name.getText() === "className",
  );
  if (
    !attribute ||
    !ts.isJsxAttribute(attribute) ||
    !attribute.initializer ||
    !ts.isJsxExpression(attribute.initializer) ||
    !attribute.initializer.expression
  ) {
    return false;
  }

  const resolving = new Set();
  function inspect(expression) {
    if (
      ts.isStringLiteral(expression) ||
      ts.isNoSubstitutionTemplateLiteral(expression) ||
      ts.isNumericLiteral(expression) ||
      expression.kind === ts.SyntaxKind.TrueKeyword ||
      expression.kind === ts.SyntaxKind.FalseKeyword ||
      expression.kind === ts.SyntaxKind.NullKeyword
    ) {
      return false;
    }
    if (ts.isIdentifier(expression)) {
      const initializer = declarations.get(expression.text);
      if (!initializer || resolving.has(expression.text)) return false;
      resolving.add(expression.text);
      const opaque = inspect(initializer);
      resolving.delete(expression.text);
      return opaque;
    }
    if (ts.isPropertyAccessExpression(expression)) return true;
    if (ts.isElementAccessExpression(expression)) return true;
    if (ts.isCallExpression(expression)) {
      if (
        ts.isIdentifier(expression.expression) &&
        ["cn", "clsx"].includes(expression.expression.text)
      ) {
        return expression.arguments.some(inspect);
      }
      return true;
    }
    if (ts.isConditionalExpression(expression)) {
      return inspect(expression.whenTrue) || inspect(expression.whenFalse);
    }
    if (
      ts.isBinaryExpression(expression) &&
      expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      return inspect(expression.right);
    }
    if (ts.isPrefixUnaryExpression(expression)) return false;
    let opaque = false;
    ts.forEachChild(expression, (child) => {
      if (!opaque && ts.isExpression(child)) opaque = inspect(child);
    });
    return opaque;
  }

  return inspect(attribute.initializer.expression);
}

const VISUAL_STYLE_PROPERTIES = new Set([
  "background",
  "backgroundColor",
  "border",
  "borderBottom",
  "borderColor",
  "borderLeft",
  "borderRadius",
  "borderRight",
  "borderTop",
  "boxShadow",
  "color",
  "columnGap",
  "fill",
  "gap",
  "height",
  "maxHeight",
  "minHeight",
  "outline",
  "outlineColor",
  "padding",
  "paddingBottom",
  "paddingLeft",
  "paddingRight",
  "paddingTop",
  "rowGap",
  "stroke",
]);

function staticStyleProperties(node, declarations) {
  const attribute = node.attributes.properties.find(
    (property) =>
      ts.isJsxAttribute(property) && property.name.getText() === "style",
  );
  if (
    !attribute ||
    !ts.isJsxAttribute(attribute) ||
    !attribute.initializer ||
    !ts.isJsxExpression(attribute.initializer) ||
    !attribute.initializer.expression
  ) {
    return [];
  }

  const properties = new Set();
  const resolving = new Set();
  function collect(expression) {
    if (ts.isObjectLiteralExpression(expression)) {
      for (const property of expression.properties) {
        if (
          (ts.isPropertyAssignment(property) ||
            ts.isShorthandPropertyAssignment(property)) &&
          (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
        ) {
          properties.add(property.name.text);
        } else if (ts.isSpreadAssignment(property)) {
          collect(property.expression);
        }
      }
      return;
    }
    if (ts.isIdentifier(expression)) {
      const initializer = declarations.get(expression.text);
      if (initializer && !resolving.has(expression.text)) {
        resolving.add(expression.text);
        collect(initializer);
        resolving.delete(expression.text);
      }
      return;
    }
    ts.forEachChild(expression, collect);
  }
  collect(attribute.initializer.expression);
  return [...properties].filter((property) =>
    VISUAL_STYLE_PROPERTIES.has(property),
  );
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

export function scanSourceText({
  adapterExports,
  adapterMatches,
  buttonDefaults,
  buttonUsages,
  file,
  registeredAdapters,
  source,
}) {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const imports = importsByLocalName(sourceFile);
  const declarations = indexStaticDeclarations(sourceFile);
  const rel = relative(file);
  const findings = [];
  const fileExports = exportedNames(sourceFile);

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
        const className = staticAttributeText(node, "className", declarations);
        const styleProperties = staticStyleProperties(node, declarations);
        if (
          isRawControl &&
          ((className && VISUAL_UTILITY.test(className)) ||
            styleProperties.length > 0)
        ) {
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
          const symbol = enclosingSymbol(node);
          const registeredAdapter = symbol
            ? registeredAdapters?.get(
                adapterKey({ file: rel, primitive: record.imported, symbol }),
              )
            : undefined;
          if (registeredAdapter && adapterMatches && adapterExports) {
            const key = adapterKey(registeredAdapter);
            adapterMatches.set(key, (adapterMatches.get(key) ?? 0) + 1);
            if (fileExports.has(registeredAdapter.symbol)) {
              adapterExports.add(key);
            }
          }
          if (record.imported === "Button" && buttonDefaults && buttonUsages) {
            for (const axis of BUTTON_AXES) {
              for (const value of jsxAxisValues(
                node,
                axis,
                buttonDefaults,
                declarations,
              )) {
                buttonUsages.push({ axis, file: rel, line, value });
              }
            }
          }
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
            const className = staticAttributeText(
              node,
              "className",
              declarations,
            );
            const visualUtility =
              record.imported === "Skeleton" || record.imported === "Tabs"
                ? SKELETON_PAINT_UTILITY
                : VISUAL_UTILITY;
            const styleProperties = staticStyleProperties(node, declarations);
            const opaqueClassName =
              !["Skeleton", "Tabs"].includes(record.imported) &&
              hasOpaqueClassExpression(node, declarations);
            if (
              (className && visualUtility.test(className)) ||
              styleProperties.length > 0 ||
              opaqueClassName
            ) {
              if (!registeredAdapter) {
                findings.push(
                  finding({
                    rule: "visual-override",
                    file: rel,
                    line,
                    symbol: record.imported,
                    detail:
                      "Canonical visual state must use a typed variant or a registered adapter owner; className is reserved for caller layout.",
                  }),
                );
              }
            }
          }
        }
      }
      const className = staticAttributeText(node, "className", declarations);
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
    if (
      buttonDefaults &&
      buttonUsages &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression)
    ) {
      const imported = imports.get(node.expression.text);
      const options = node.arguments[0];
      if (
        imported?.imported === "buttonVariants" &&
        resolvesToCanonical(imported, file) &&
        options &&
        ts.isObjectLiteralExpression(options)
      ) {
        const line =
          sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        for (const axis of BUTTON_AXES) {
          const property = objectProperty(options, axis);
          const values =
            property && ts.isPropertyAssignment(property)
              ? staticStringValues(property.initializer, declarations)
              : buttonDefaults[axis]
                ? [buttonDefaults[axis]]
                : [];
          for (const value of values) {
            buttonUsages.push({ axis, file: rel, line, value });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return findings;
}

export function validateExceptions(document, now) {
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
      exception.rule === "button-axis-reuse" ||
      typeof exception.file !== "string" ||
      typeof exception.symbol !== "string" ||
      typeof exception.owner !== "string" ||
      typeof exception.reason !== "string" ||
      typeof exception.reviewBy !== "string" ||
      !Number.isInteger(exception.matchCount) ||
      exception.matchCount < 1 ||
      (exception.lines !== undefined &&
        (!Array.isArray(exception.lines) ||
          exception.lines.length !== exception.matchCount ||
          exception.lines.some((line) => !Number.isInteger(line) || line < 1)))
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

function parseExceptions(now) {
  return validateExceptions(
    JSON.parse(fs.readFileSync(exceptionsPath, "utf8")),
    now,
  );
}

export function applyExceptions(findings, exceptions) {
  for (const exception of exceptions) {
    const matches = findings.filter(
      (entry) =>
        exception.rule === entry.rule &&
        exception.file === entry.file &&
        exception.symbol === entry.symbol &&
        (exception.lines === undefined || exception.lines.includes(entry.line)),
    );
    if (matches.length !== exception.matchCount) {
      throw new Error(
        `Design-system exception ${exception.id} expected ${exception.matchCount} match(es), found ${matches.length}`,
      );
    }
  }
  const used = new Set();
  const active = findings.filter((entry) => {
    const exception = exceptions.find(
      (candidate) =>
        candidate.rule === entry.rule &&
        candidate.file === entry.file &&
        candidate.symbol === entry.symbol &&
        (candidate.lines === undefined || candidate.lines.includes(entry.line)),
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
  const adapters = validateAdapterRegistry(
    JSON.parse(fs.readFileSync(adaptersPath, "utf8")),
  );
  const registeredAdapters = new Map(
    adapters.map((adapter) => [adapterKey(adapter), adapter]),
  );
  const adapterMatches = new Map();
  const adapterExports = new Set();
  const { definitions: buttonDefinitions, defaults: buttonDefaults } =
    extractButtonAxisDefinitions({
      file: buttonPath,
      source: fs.readFileSync(buttonPath, "utf8"),
    });
  const buttonUsages = [];
  for (const file of files) {
    findings.push(
      ...scanSourceText({
        adapterExports,
        adapterMatches,
        buttonDefaults,
        buttonUsages,
        file,
        registeredAdapters,
        source: fs.readFileSync(file, "utf8"),
      }),
    );
  }
  assertRegisteredAdaptersUsed(adapters, adapterMatches, adapterExports);
  const buttonAxes = buttonDefinitions.map((definition) => {
    const callers = buttonUsages.filter(
      (usage) =>
        usage.axis === definition.axis && usage.value === definition.value,
    );
    return { ...definition, callerCount: callers.length, callers };
  });
  for (const entry of buttonAxes) {
    if (entry.callerCount >= BUTTON_MIN_MAINTAINED_CALLERS) continue;
    findings.push(
      finding({
        rule: "button-axis-reuse",
        file: entry.file,
        line: entry.line,
        symbol: `${entry.axis}.${entry.value}`,
        detail: `Canonical Button axes require at least ${BUTTON_MIN_MAINTAINED_CALLERS} maintained callers; found ${entry.callerCount}.`,
      }),
    );
  }
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
    adapters,
    buttonAxes,
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
  lines.push("", "## Button axis inventory", "");
  for (const axis of BUTTON_AXES) {
    lines.push(
      `### ${axis}`,
      "",
      "| Value | Maintained callers |",
      "| --- | ---: |",
    );
    for (const entry of report.buttonAxes.filter(
      (item) => item.axis === axis,
    )) {
      lines.push(`| \`${entry.value}\` | ${entry.callerCount} |`);
    }
    lines.push("");
  }
  lines.push(
    "## Registered adapters",
    "",
    "| Owner | Exported symbol | Canonical primitive | Compositions |",
    "| --- | --- | --- | ---: |",
  );
  for (const adapter of report.adapters) {
    lines.push(
      `| ${adapter.owner} | \`${adapter.symbol}\` | \`${adapter.primitive}\` | ${adapter.matchCount} |`,
    );
  }
  lines.push("");
  lines.push("## Findings", "");
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

export function compareToTightBaseline(report, baseline) {
  return RULES.flatMap((rule) =>
    report.counts[rule] !== baseline.counts[rule]
      ? [
          `${rule}: actual ${report.counts[rule]} != baseline ${baseline.counts[rule]}`,
        ]
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
    const regressions = process.argv.includes("--require-tight-baseline")
      ? compareToTightBaseline(report, baseline)
      : compareToBaseline(report, baseline);
    if (regressions.length > 0) {
      throw new Error(
        `Design-system violations exceed baseline: ${regressions.join(", ")}`,
      );
    }
    process.stdout.write(markdown);
  }
}

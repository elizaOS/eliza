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
const atomicConsolidationLedgerPath = path.join(
  scriptDir,
  "atomic-consolidation-ledger.json",
);
const publicCardVariantsPath = path.join(
  scriptDir,
  "design-system-public-card-variants.json",
);
const packagePath = path.join(repoRoot, "packages/ui/package.json");
const reportPath = path.join(scriptDir, "design-system-compliance-report.md");
const buttonPath = path.join(
  repoRoot,
  "packages/ui/src/components/ui/button.tsx",
);
const cardPath = path.join(repoRoot, "packages/ui/src/components/ui/card.tsx");
const publicCardBarrelPaths = [
  path.join(repoRoot, "packages/ui/src/index.ts"),
  path.join(repoRoot, "packages/ui/src/components/primitives/index.ts"),
  path.join(repoRoot, "packages/ui/src/browser.ts"),
];
const BUTTON_AXES = ["variant", "size", "shape", "align"];
const BUTTON_MIN_MAINTAINED_CALLERS = 2;
const CARD_AXES = [
  "variant",
  "stack",
  "flow",
  "gap",
  "padding",
  "tone",
  "surface",
  "border",
  "radius",
  "shadow",
];
const CARD_MIN_MAINTAINED_CALLERS = 2;

export const RULES = [
  "atomic-duplicate",
  "raw-control",
  "raw-card-recipe",
  "raw-outlined-card-recipe",
  "card-report-panel-override",
  "raw-inset-card-recipe",
  "direct-primitive-import",
  "deep-canonical-import",
  "variant-helper-bypass",
  "button-axis-reuse",
  "card-variant-reuse",
  "unstyled-canonical",
  "visual-override",
  "off-token-color",
  "token-role-misuse",
  "equivalent-recipe-divergence",
];

/**
 * Semantic paint families are intentionally namespace-based. Adding a raw
 * color to this table would weaken the contract; new visual vocabulary must
 * first become a named theme token in tailwind-theme.css.
 */
const TOKEN_ROLE_CONTRACTS = Object.freeze({
  action: {
    foreground: [
      "content",
      "muted",
      "on-action",
      "inverse",
      "on-inverse",
      "action",
      "status",
      "context",
      "transparent",
    ],
    surface: [
      "neutral",
      "inverse",
      "transparent",
      "action",
      "status",
      "context",
    ],
    border: [
      "structure",
      "inverse",
      "transparent",
      "action",
      "status",
      "context",
    ],
    radius: ["none", "control", "container", "pill"],
    spacing: ["control"],
    elevation: ["none", "low"],
    state: [
      "hover",
      "focus",
      "active",
      "disabled",
      "selected",
      "invalid",
      "pointer",
      "responsive",
      "group",
    ],
  },
  field: {
    foreground: ["content", "muted", "inverse", "on-inverse"],
    surface: ["neutral", "inverse", "transparent", "status"],
    border: ["structure", "inverse", "transparent", "status"],
    radius: ["none", "control", "container", "pill"],
    spacing: ["control"],
    elevation: ["none"],
    state: [
      "hover",
      "focus",
      "disabled",
      "invalid",
      "placeholder",
      "file",
      "pointer",
      "responsive",
    ],
  },
  surface: {
    foreground: [
      "content",
      "muted",
      "inverse",
      "on-inverse",
      "action",
      "status",
    ],
    surface: ["neutral", "inverse", "transparent", "action", "status"],
    border: ["structure", "inverse", "transparent", "action", "status"],
    radius: ["none", "control", "container", "pill"],
    spacing: ["container"],
    elevation: ["none", "low", "raised"],
    state: [
      "hover",
      "focus",
      "active",
      "disabled",
      "selected",
      "invalid",
      "responsive",
      "group",
    ],
  },
  status: {
    foreground: [
      "content",
      "muted",
      "on-action",
      "action",
      "status",
      "transparent",
    ],
    surface: ["neutral", "transparent", "action", "status"],
    border: ["structure", "transparent", "action", "status"],
    radius: ["none", "control", "container", "pill"],
    spacing: ["compact", "container"],
    elevation: ["none", "low"],
    state: [
      "hover",
      "focus",
      "active",
      "disabled",
      "selected",
      "responsive",
      "group",
    ],
  },
  content: {
    foreground: ["content", "muted", "action", "status", "context"],
    surface: ["transparent"],
    border: ["structure", "transparent"],
    radius: ["none"],
    spacing: ["compact"],
    elevation: ["none"],
    state: ["hover", "responsive", "group"],
  },
  layout: {
    foreground: [],
    surface: [],
    border: [],
    radius: ["none"],
    spacing: ["layout"],
    elevation: ["none"],
    state: ["responsive", "group"],
  },
});

const CANONICAL_RECIPE_CONTRACTS = Object.freeze({
  "packages/ui/src/components/ui/alert.tsx:alertVariants": {
    role: "status",
    axes: { variant: "status" },
  },
  "packages/ui/src/components/ui/attachment.tsx:attachmentVariants": {
    role: "surface",
    axes: {
      size: "surface",
      orientation: "layout",
      presentation: "surface",
    },
  },
  "packages/ui/src/components/ui/attachment.tsx:attachmentMediaVariants": {
    role: "surface",
    axes: { variant: "surface" },
  },
  "packages/ui/src/components/ui/badge.tsx:badgeVariants": {
    role: "status",
    axes: {
      variant: "status",
      size: "status",
      tone: "status",
      presentation: "surface",
      overlay: "action",
    },
  },
  "packages/ui/src/components/ui/banner.tsx:bannerVariants": {
    role: "status",
    axes: { variant: "status" },
  },
  "packages/ui/src/components/ui/button.tsx:buttonVariants": {
    role: "action",
    axes: {
      variant: "action",
      size: "action",
      shape: "action",
      align: "action",
    },
  },
  "packages/ui/src/components/ui/card.tsx:cardVariants": {
    role: "surface",
    axes: {
      variant: "surface",
      stack: "surface",
      flow: "surface",
      gap: "surface",
      padding: "surface",
      tone: "surface",
      surface: "surface",
      border: "surface",
      radius: "surface",
      shadow: "surface",
    },
  },
  "packages/ui/src/components/ui/radio-group.tsx:radioGroupVariants": {
    role: "field",
    axes: { variant: "field" },
  },
  "packages/ui/src/components/ui/scroll-area.tsx:scrollAreaVariants": {
    role: "surface",
    axes: { variant: "surface" },
  },
  "packages/ui/src/components/ui/spinner.tsx:spinnerVariants": {
    role: "content",
    axes: { variant: "content" },
  },
  "packages/ui/src/components/ui/grid.tsx:gridVariants": {
    role: "layout",
    axes: { columns: "layout", spacing: "layout" },
  },
  "packages/ui/src/components/ui/input-group.tsx:inputGroupVariants": {
    role: "field",
    axes: { density: "field" },
  },
  "packages/ui/src/components/ui/input-group.tsx:inputGroupAddonVariants": {
    role: "field",
    axes: { align: "field" },
  },
  "packages/ui/src/components/ui/input.tsx:inputVariants": {
    role: "field",
    axes: { variant: "field", density: "field", adornment: "field" },
  },
  "packages/ui/src/components/ui/marker.tsx:markerVariants": {
    role: "content",
    axes: { variant: "content" },
  },
  "packages/ui/src/components/ui/native-select.tsx:nativeSelectVariants": {
    role: "field",
    axes: { presentation: "field" },
  },
  "packages/ui/src/components/ui/stack.tsx:stackVariants": {
    role: "layout",
    axes: {
      direction: "layout",
      align: "layout",
      justify: "layout",
      spacing: "layout",
    },
  },
  "packages/ui/src/components/ui/table.tsx:tableRowVariants": {
    role: "surface",
    axes: { variant: "surface" },
  },
  "packages/ui/src/components/ui/table.tsx:tableHeaderVariants": {
    role: "surface",
    axes: { variant: "surface" },
  },
  "packages/ui/src/components/ui/table.tsx:tableHeadVariants": {
    role: "surface",
    axes: { divider: "surface", interactive: "surface" },
  },
  "packages/ui/src/components/ui/table.tsx:tableCellVariants": {
    role: "surface",
    axes: { variant: "surface" },
  },
  "packages/ui/src/components/ui/tabs.tsx:tabsListVariants": {
    role: "surface",
    axes: { variant: "surface" },
  },
  "packages/ui/src/components/ui/tabs.tsx:tabsTriggerVariants": {
    role: "action",
    axes: { variant: "action" },
  },
  "packages/ui/src/components/ui/textarea.tsx:textareaVariants": {
    role: "field",
    axes: { variant: "field", density: "field" },
  },
  "packages/ui/src/components/ui/text-link.tsx:textLinkVariants": {
    role: "action",
    axes: { variant: "action" },
  },
  "packages/ui/src/components/ui/toggle.tsx:toggleVariants": {
    role: "action",
    axes: { variant: "action", size: "action" },
  },
  "packages/ui/src/components/ui/typography.tsx:textVariants": {
    role: "content",
    axes: { variant: "content" },
  },
  "packages/ui/src/components/ui/typography.tsx:headingVariants": {
    role: "content",
    axes: { level: "content" },
  },
});

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
      typeof adapter.role !== "string" ||
      !Object.hasOwn(TOKEN_ROLE_CONTRACTS, adapter.role) ||
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
  /(?:^|\s)(?:[a-z-]+:)*(?:(?:bg|border|rounded|shadow|ring|outline|fill|stroke|from|via|to)-(?:\[[^\]]+\]|[^\s]+)|text-(?:\[[^\]]+\]|(?:txt|foreground|card-fg|card-foreground|popover-foreground|muted|inverse|accent|primary|secondary|destructive|danger|warn|warning|ok|success|info|status|header|sidebar|black|white|slate|gray|zinc|neutral|stone|red|rose|pink|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia)(?:-|\/|$)[^\s]*))/;
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
    /\.[jt]sx?$/.test(rel) &&
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
    if (
      [
        "node_modules",
        "dist",
        "build",
        "coverage",
        "generated",
        "test-results",
        ".git",
      ].includes(entry.name) ||
      entry.name.startsWith(".playwright-artifacts-")
    )
      continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (isGovernedSource(full)) {
      if (/\.[jt]sx$/.test(full)) {
        yield full;
        continue;
      }
      const source = fs.readFileSync(full, "utf8");
      if (
        /\bcreateElement\b/.test(source) &&
        /from\s+["']react["']/.test(source)
      ) {
        yield full;
      }
    }
  }
}

function* walkStylesheets(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (
      [
        "node_modules",
        "dist",
        "build",
        "coverage",
        "generated",
        "test-results",
        ".git",
        "stories",
        "test",
        "__tests__",
        "__e2e__",
      ].includes(entry.name) ||
      entry.name.startsWith(".playwright-artifacts-")
    )
      continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walkStylesheets(full);
    else if (entry.name.endsWith(".css")) yield full;
  }
}

const CSS_PAINT_DECLARATION =
  /(?:^|;)\s*(?:-webkit-)?(?:backdrop-filter|background(?:-[a-z-]+)?|border(?:-[a-z-]+)?|box-shadow|color|filter|outline(?:-[a-z-]+)?)\s*:/im;

/** Maps named CSS classes to the maintained stylesheets that give them paint. */
export function indexPaintedCssClasses(stylesheets) {
  const painted = new Map();

  function splitSelectorList(selectorText) {
    const selectors = [];
    let bracketDepth = 0;
    let parenthesisDepth = 0;
    let quote = null;
    let start = 0;
    let escaped = false;
    for (let index = 0; index < selectorText.length; index += 1) {
      const character = selectorText[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (quote) {
        if (character === quote) quote = null;
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character === "[") bracketDepth += 1;
      else if (character === "]") bracketDepth = Math.max(0, bracketDepth - 1);
      else if (character === "(") parenthesisDepth += 1;
      else if (character === ")") {
        parenthesisDepth = Math.max(0, parenthesisDepth - 1);
      } else if (
        character === "," &&
        bracketDepth === 0 &&
        parenthesisDepth === 0
      ) {
        selectors.push(selectorText.slice(start, index));
        start = index + 1;
      }
    }
    selectors.push(selectorText.slice(start));
    return selectors;
  }

  function paintedSubjectClasses(selector) {
    const normalizedSelector = selector.trim();
    let bracketDepth = 0;
    let parenthesisDepth = 0;
    let quote = null;
    let subjectStart = 0;
    let escaped = false;
    for (let index = 0; index < normalizedSelector.length; index += 1) {
      const character = normalizedSelector[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (quote) {
        if (character === quote) quote = null;
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character === "[") bracketDepth += 1;
      else if (character === "]") bracketDepth = Math.max(0, bracketDepth - 1);
      else if (character === "(") parenthesisDepth += 1;
      else if (character === ")") {
        parenthesisDepth = Math.max(0, parenthesisDepth - 1);
      } else if (
        bracketDepth === 0 &&
        parenthesisDepth === 0 &&
        (/\s/.test(character) || [">", "+", "~"].includes(character))
      ) {
        subjectStart = index + 1;
      }
    }

    const subject = normalizedSelector.slice(subjectStart).trim();
    const classes = [];
    bracketDepth = 0;
    parenthesisDepth = 0;
    quote = null;
    escaped = false;
    for (let index = 0; index < subject.length; index += 1) {
      const character = subject[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (quote) {
        if (character === quote) quote = null;
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character === "[") {
        bracketDepth += 1;
        continue;
      }
      if (character === "]") {
        bracketDepth = Math.max(0, bracketDepth - 1);
        continue;
      }
      if (character === ":" && bracketDepth === 0 && parenthesisDepth === 0) {
        const functionalPseudo = /^:(?:where|is|global)\(/.exec(
          subject.slice(index),
        );
        if (functionalPseudo) {
          const openIndex = index + functionalPseudo[0].length - 1;
          let nestedDepth = 1;
          let nestedQuote = null;
          let nestedEscaped = false;
          let closeIndex = openIndex + 1;
          for (; closeIndex < subject.length; closeIndex += 1) {
            const nestedCharacter = subject[closeIndex];
            if (nestedEscaped) {
              nestedEscaped = false;
              continue;
            }
            if (nestedCharacter === "\\") {
              nestedEscaped = true;
              continue;
            }
            if (nestedQuote) {
              if (nestedCharacter === nestedQuote) nestedQuote = null;
              continue;
            }
            if (nestedCharacter === '"' || nestedCharacter === "'") {
              nestedQuote = nestedCharacter;
              continue;
            }
            if (nestedCharacter === "(") nestedDepth += 1;
            else if (nestedCharacter === ")") nestedDepth -= 1;
            if (nestedDepth === 0) break;
          }
          if (nestedDepth === 0) {
            const argumentsText = subject.slice(openIndex + 1, closeIndex);
            for (const argument of splitSelectorList(argumentsText)) {
              classes.push(...paintedSubjectClasses(argument));
            }
            index = closeIndex;
            continue;
          }
        }
      }
      if (character === "(") {
        parenthesisDepth += 1;
        continue;
      }
      if (character === ")") {
        parenthesisDepth = Math.max(0, parenthesisDepth - 1);
        continue;
      }
      if (character !== "." || bracketDepth !== 0 || parenthesisDepth !== 0) {
        continue;
      }
      const match = /^\.([_a-zA-Z][\w-]*)/.exec(subject.slice(index));
      if (!match) continue;
      classes.push(match[1]);
      index += match[0].length - 1;
    }
    return classes;
  }

  for (const { file, source } of stylesheets) {
    for (const block of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const declarations = block[2].replace(/\/\*[\s\S]*?\*\//g, "");
      if (!CSS_PAINT_DECLARATION.test(declarations)) continue;
      const selectorText = block[1].replace(/\/\*[\s\S]*?\*\//g, "");
      for (const selector of splitSelectorList(selectorText)) {
        for (const className of paintedSubjectClasses(selector)) {
          const owners = painted.get(className) ?? new Set();
          owners.add(file);
          painted.set(className, owners);
        }
      }
    }
  }
  return painted;
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
          names.add(element.propertyName?.text ?? element.name.text);
        }
      }
    }
  }
  return names;
}

function reachableOwnerNames(sourceFile) {
  const ownerNodes = new Map();
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      ownerNodes.set(statement.name.text, statement);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          ownerNodes.set(declaration.name.text, declaration);
        }
      }
    }
  }

  const reachable = new Set();
  const pending = [...exportedNames(sourceFile)].filter((name) =>
    ownerNodes.has(name),
  );
  while (pending.length > 0) {
    const owner = pending.pop();
    if (!owner || reachable.has(owner)) continue;
    reachable.add(owner);
    const ownerNode = ownerNodes.get(owner);
    if (!ownerNode) continue;
    function enqueue(name) {
      if (name !== owner && ownerNodes.has(name) && !reachable.has(name)) {
        pending.push(name);
      }
    }
    function visit(node) {
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        ts.isIdentifier(node.tagName)
      ) {
        enqueue(node.tagName.text);
      }
      if (ts.isCallExpression(node)) {
        if (ts.isIdentifier(node.expression)) enqueue(node.expression.text);
        const isCreateElement =
          (ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === "createElement") ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === "createElement");
        const rendered = node.arguments[0];
        if (isCreateElement && rendered && ts.isIdentifier(rendered)) {
          enqueue(rendered.text);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(ownerNode);
  }
  return reachable;
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

function resolvesCardUsage(record, file) {
  if (resolvesToCanonical(record, file)) return true;
  if (!record?.origin.startsWith(".")) return false;
  const resolved = relative(path.resolve(path.dirname(file), record.origin));
  return (
    resolved === "packages/ui/src/cloud-ui" ||
    resolved === "packages/ui/src/cloud-ui/index" ||
    resolved === "packages/ui/src/cloud-ui/components/primitives"
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

function loadCardTokenStyleKeys() {
  const sourceFile = ts.createSourceFile(
    cardPath,
    fs.readFileSync(cardPath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let keys = null;
  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "CARD_TOKEN_STYLE_KEYS" &&
      node.initializer
    ) {
      let initializer = node.initializer;
      while (ts.isAsExpression(initializer))
        initializer = initializer.expression;
      if (ts.isArrayLiteralExpression(initializer)) {
        keys = initializer.elements
          .filter(ts.isStringLiteral)
          .map((element) => element.text);
      }
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  if (!keys || keys.length === 0 || new Set(keys).size !== keys.length) {
    throw new Error("Card must declare a unique CARD_TOKEN_STYLE_KEYS array");
  }
  return new Set(keys);
}

const CARD_TOKEN_STYLE_KEYS = loadCardTokenStyleKeys();

function objectProperty(object, name) {
  return object.properties.find(
    (property) =>
      (ts.isPropertyAssignment(property) ||
        ts.isShorthandPropertyAssignment(property)) &&
      propertyNameText(property) === name,
  );
}

const RAW_COLOR_TOKEN =
  /^(?:black|white|slate|gray|zinc|neutral|stone|red|rose|pink|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia)(?:-|$)/;
const STATUS_TOKEN =
  /^(?:destructive|danger|warn|warning|ok|success|info|status-)/;
const ACTION_TOKEN = /^(?:accent|primary|secondary)(?:-|$)/;
const CONTEXT_TOKEN = /^(?:header|sidebar)(?:-|$)/;
const CONTENT_TOKEN =
  /^(?:txt(?:-|$)|foreground$|card-fg$|card-foreground$|popover-foreground$|muted(?:-|$))/;
const NEUTRAL_SURFACE_TOKEN =
  /^(?:authorize-(?:backdrop|panel)(?:-|$)|bg(?:-|$)|background$|card$|homepage-canvas$|surface$|popover$|muted$|scrim$)/;
const STRUCTURE_TOKEN = /^(?:border(?:-|$)|brand-surface$|input$|ring$)/;

function tailwindUtility(token) {
  let bracketDepth = 0;
  let lastSeparator = -1;
  for (let index = 0; index < token.length; index += 1) {
    if (token[index] === "[") bracketDepth += 1;
    else if (token[index] === "]") bracketDepth -= 1;
    else if (token[index] === ":" && bracketDepth === 0) lastSeparator = index;
  }
  return {
    modifiers:
      lastSeparator === -1 ? [] : token.slice(0, lastSeparator).split(":"),
    utility: token.slice(lastSeparator + 1).replace(/!$/, ""),
  };
}

function semanticTokenFamily(token, channel) {
  const bare = token.replace(/\/.*$/, "");
  if (["transparent", "current", "none"].includes(bare)) return "transparent";
  if (bare === "inverse") return "inverse";
  if (bare === "inverse-foreground") {
    return channel === "foreground" ? "on-inverse" : "inverse";
  }
  if (bare.startsWith("[")) return "raw";
  if (RAW_COLOR_TOKEN.test(bare)) return "raw";
  if (STATUS_TOKEN.test(bare)) {
    return channel === "foreground" && /-(?:fg|foreground)$/.test(bare)
      ? "on-action"
      : "status";
  }
  if (ACTION_TOKEN.test(bare)) {
    return channel === "foreground" && /-(?:fg|foreground)$/.test(bare)
      ? "on-action"
      : "action";
  }
  if (CONTEXT_TOKEN.test(bare)) return "context";
  if (channel === "surface" && bare === "muted") return "neutral";
  if (CONTENT_TOKEN.test(bare)) {
    return bare.startsWith("muted") ? "muted" : "content";
  }
  if (NEUTRAL_SURFACE_TOKEN.test(bare)) return "neutral";
  if (STRUCTURE_TOKEN.test(bare)) return "structure";
  return "unknown";
}

function canonicalTokenIdentity(token) {
  const [name, opacity] = token.split("/");
  const aliases = {
    background: "bg",
    foreground: "txt",
    "card-foreground": "card-fg",
    "accent-foreground": "accent-fg",
    "primary-foreground": "primary-fg",
    warning: "warn",
    success: "ok",
  };
  return `${aliases[name] ?? name}${opacity ? `/${opacity}` : ""}`;
}

function stateFamilies(modifiers) {
  const states = new Set();
  for (const modifier of modifiers) {
    if (/placeholder/.test(modifier)) states.add("placeholder");
    else if (/file/.test(modifier)) states.add("file");
    else if (/pointer/.test(modifier)) states.add("pointer");
    else if (/disabled/.test(modifier)) states.add("disabled");
    else if (/invalid|error/.test(modifier)) states.add("invalid");
    else if (/focus/.test(modifier)) states.add("focus");
    else if (/hover/.test(modifier)) states.add("hover");
    else if (/active/.test(modifier)) states.add("active");
    else if (/selected|state=(?:on|open|checked)/.test(modifier))
      states.add("selected");
    else if (/^(?:sm|md|lg|xl|2xl)$/.test(modifier)) states.add("responsive");
    else if (/group|has-/.test(modifier)) states.add("group");
  }
  return [...states];
}

function colorClass(utility) {
  const match = /^(bg|text|border|ring|outline|fill|stroke|divide)-(.+)$/.exec(
    utility,
  );
  if (!match) return null;
  if (
    /^(?:bg-(?:clip|origin|gradient|linear|radial|conic|launcher-icon-sheen)|border-(?:solid|dashed|dotted|double|hidden|none)|outline-(?:none|hidden))/.test(
      utility,
    )
  ) {
    return null;
  }
  if (
    match[1] === "text" &&
    /^(?:left|right|center|justify|start|end|xs|sm|base|lg|xl|[2-9]xl|[23]xs|(?:xs|sm)-tight|chat-(?:body|lead)|\[[0-9.]+(?:px|rem)\])$/.test(
      match[2],
    )
  ) {
    return null;
  }
  if (
    match[1] === "border" &&
    /^(?:0|2|4|8|[xytrbl](?:-[0248])?)$/.test(match[2])
  )
    return null;
  if (match[1] === "ring" && /^(?:0|1|2|4|8|offset-[01248])$/.test(match[2]))
    return null;
  let channel =
    match[1] === "bg"
      ? "surface"
      : match[1] === "text"
        ? "foreground"
        : "border";
  if (
    channel === "surface" &&
    STRUCTURE_TOKEN.test(match[2].replace(/\/.*$/, ""))
  ) {
    channel = "border";
  }
  return {
    channel,
    token:
      match[1] === "ring" && match[2].startsWith("offset-")
        ? match[2].slice("offset-".length)
        : match[2],
  };
}

function radiusFamily(utility) {
  const match = /^rounded(?:-[trblse]{1,2})?-(.+)$/.exec(utility);
  if (!match) return null;
  if (match[1].startsWith("[")) return "raw";
  if (match[1] === "none") return "none";
  if (["xs", "sm", "md"].includes(match[1])) return "control";
  if (["lg", "xl", "2xl", "3xl"].includes(match[1])) return "container";
  if (match[1] === "full") return "pill";
  return "raw";
}

function elevationFamily(utility) {
  if (!utility.startsWith("shadow-")) return null;
  if (utility.startsWith("shadow-[")) return "raw";
  if (utility === "shadow-none") return "none";
  if (["shadow-2xs", "shadow-xs", "shadow-sm"].includes(utility)) return "low";
  return "raised";
}

function spacingFamily(utility, role) {
  if (!/^(?:p[trblxy]?|gap|space-[xy]|h|min-h|max-h|size)-\[/.test(utility))
    return null;
  if (role === "layout") return "layout";
  return "raw";
}

export function analyzeTokenRoleClasses({ className, role }) {
  const contract = TOKEN_ROLE_CONTRACTS[role];
  if (!contract) return [`Unknown token role ${role}.`];
  const violations = [];
  for (const token of className.split(/\s+/).filter(Boolean)) {
    const { modifiers, utility } = tailwindUtility(token);
    for (const state of stateFamilies(modifiers)) {
      if (!contract.state.includes(state)) {
        violations.push(`${state} state is not legal for ${role}.`);
      }
    }
    const color = colorClass(utility);
    if (color) {
      const family = semanticTokenFamily(color.token, color.channel);
      if (family === "raw") {
        violations.push(
          `${utility} uses a raw color instead of a semantic token.`,
        );
      } else if (family === "unknown") {
        violations.push(
          `${utility} is not in a recognized semantic token family.`,
        );
      } else if (!contract[color.channel].includes(family)) {
        violations.push(
          `${color.channel} family ${family} is not legal for ${role}.`,
        );
      }
    }
    const radius = radiusFamily(utility);
    if (radius && !contract.radius.includes(radius)) {
      violations.push(`radius family ${radius} is not legal for ${role}.`);
    }
    const spacing = spacingFamily(utility, role);
    if (spacing && !contract.spacing.includes(spacing)) {
      violations.push(
        `${utility} uses raw spacing instead of the density scale.`,
      );
    }
    const elevation = elevationFamily(utility);
    if (elevation && !contract.elevation.includes(elevation)) {
      violations.push(
        `elevation family ${elevation} is not legal for ${role}.`,
      );
    }
    if (utility === "transition-all") {
      violations.push(
        "transition-all is not legal; name the changing properties.",
      );
    }
  }
  return [...new Set(violations)];
}

function paintRecipe(className, canonical) {
  const entries = [];
  for (const token of className.split(/\s+/).filter(Boolean)) {
    const { modifiers, utility } = tailwindUtility(token);
    const color = colorClass(utility);
    if (!color) continue;
    const family = semanticTokenFamily(color.token, color.channel);
    if (["raw", "unknown"].includes(family)) continue;
    const states = stateFamilies(modifiers).sort().join("+") || "rest";
    const identity = canonical
      ? canonicalTokenIdentity(color.token)
      : color.token;
    entries.push(`${states}:${color.channel}:${identity}`);
  }
  return entries.sort().join("|");
}

function staticRecipeString(expression) {
  if (
    ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression)
  ) {
    return expression.text;
  }
  return null;
}

export function auditCanonicalTokenRoles({ file, source }) {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const rel = relative(file);
  const findings = [];
  const seenContracts = new Set();
  function addMisuse(node, symbol, detail) {
    findings.push(
      finding({
        rule: "token-role-misuse",
        file: rel,
        line:
          sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        symbol,
        detail,
      }),
    );
  }
  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === "cva"
    ) {
      const symbol = node.name.text;
      const key = `${rel}:${symbol}`;
      const contract = CANONICAL_RECIPE_CONTRACTS[key];
      if (!contract) {
        addMisuse(
          node,
          symbol,
          "Canonical cva helper has no token-role contract.",
        );
        return;
      }
      seenContracts.add(key);
      const base = node.initializer.arguments[0];
      const baseRecipe = base ? staticRecipeString(base) : "";
      if (base && baseRecipe === null)
        addMisuse(
          base,
          symbol,
          "Canonical cva base recipe must be a static string.",
        );
      if (baseRecipe !== null) {
        for (const detail of analyzeTokenRoleClasses({
          className: baseRecipe,
          role: contract.role,
        }))
          addMisuse(base, symbol, detail);
      }
      const config = node.initializer.arguments[1];
      if (!config || !ts.isObjectLiteralExpression(config)) {
        addMisuse(
          node,
          symbol,
          "Canonical cva helper must use an object-literal config.",
        );
        return;
      }
      const variants = objectProperty(config, "variants");
      if (
        !variants ||
        !ts.isPropertyAssignment(variants) ||
        !ts.isObjectLiteralExpression(variants.initializer)
      ) {
        addMisuse(
          config,
          symbol,
          "Canonical cva helper must declare object-literal variants.",
        );
        return;
      }
      const actualAxes = variants.initializer.properties
        .map(propertyNameText)
        .filter(Boolean);
      const expectedAxes = Object.keys(contract.axes);
      if (actualAxes.sort().join("|") !== expectedAxes.sort().join("|")) {
        addMisuse(
          variants,
          symbol,
          `Token-role axes must be exactly ${expectedAxes.join(", ")}.`,
        );
      }
      for (const axisProperty of variants.initializer.properties) {
        const axis = propertyNameText(axisProperty);
        if (
          !axis ||
          !ts.isPropertyAssignment(axisProperty) ||
          !ts.isObjectLiteralExpression(axisProperty.initializer)
        )
          continue;
        const role = contract.axes[axis];
        if (!role) continue;
        const recipes = [];
        for (const valueProperty of axisProperty.initializer.properties) {
          const value = propertyNameText(valueProperty);
          if (!value || !ts.isPropertyAssignment(valueProperty)) continue;
          const recipe = staticRecipeString(valueProperty.initializer);
          if (recipe === null) {
            addMisuse(
              valueProperty,
              `${symbol}.${axis}.${value}`,
              "Canonical recipe must be a static string.",
            );
            continue;
          }
          for (const detail of analyzeTokenRoleClasses({
            className: recipe,
            role,
          }))
            addMisuse(valueProperty, `${symbol}.${axis}.${value}`, detail);
          recipes.push({
            node: valueProperty,
            value,
            recipe,
            fingerprint: paintRecipe(recipe, true),
            paint: paintRecipe(recipe, false),
          });
        }
        for (let left = 0; left < recipes.length; left += 1) {
          for (let right = left + 1; right < recipes.length; right += 1) {
            const a = recipes[left];
            const b = recipes[right];
            const exactDuplicate =
              a.recipe.trim().replace(/\s+/g, " ") ===
              b.recipe.trim().replace(/\s+/g, " ");
            const aliasDivergence =
              a.fingerprint &&
              a.fingerprint === b.fingerprint &&
              a.paint !== b.paint;
            if (!exactDuplicate && !aliasDivergence) continue;
            findings.push(
              finding({
                rule: "equivalent-recipe-divergence",
                file: rel,
                line:
                  sourceFile.getLineAndCharacterOfPosition(b.node.getStart())
                    .line + 1,
                symbol: `${symbol}.${axis}.${b.value}`,
                detail: exactDuplicate
                  ? `Duplicates ${axis}.${a.value}; keep one canonical recipe.`
                  : `Uses token aliases equivalent to ${axis}.${a.value}; converge on one semantic recipe.`,
              }),
            );
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return { findings, seenContracts };
}

export function assertCanonicalRecipeContractsSeen(seenContracts) {
  const stale = Object.keys(CANONICAL_RECIPE_CONTRACTS).filter(
    (key) => !seenContracts.has(key),
  );
  if (stale.length > 0) {
    throw new Error(
      `Stale canonical token-role contracts: ${stale.join(", ")}`,
    );
  }
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
    if (
      ts.isFunctionDeclaration(candidate) &&
      candidate.name &&
      candidate.body
    ) {
      const existing = declarations.get(candidate.name.text);
      declarations.set(
        candidate.name.text,
        existing === undefined ? candidate : null,
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
      ts.isCallExpression(candidate) &&
      ts.isIdentifier(candidate.expression)
    ) {
      const declaration = declarations.get(candidate.expression.text);
      if (declaration && !resolving.has(candidate.expression.text)) {
        resolving.add(candidate.expression.text);
        collect(declaration);
        resolving.delete(candidate.expression.text);
      }
      return;
    }
    if (
      ts.isFunctionDeclaration(candidate) ||
      ts.isFunctionExpression(candidate) ||
      ts.isArrowFunction(candidate)
    ) {
      if (ts.isBlock(candidate.body)) {
        function collectReturns(node) {
          if (node !== candidate && ts.isFunctionLike(node)) return;
          if (ts.isReturnStatement(node) && node.expression) {
            collect(node.expression);
            return;
          }
          ts.forEachChild(node, collectReturns);
        }
        collectReturns(candidate.body);
      } else {
        collect(candidate.body);
      }
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

function objectPropertyExpressions(expression, propertyName, declarations) {
  const expressions = [];
  let opaque = false;
  const resolving = new Set();
  function visitFunction(candidate) {
    const body = candidate.body;
    if (!body) return;
    if (!ts.isBlock(body)) {
      visit(body);
      return;
    }
    function visitReturns(child) {
      if (child !== body && ts.isFunctionLike(child)) return;
      if (ts.isReturnStatement(child) && child.expression) {
        visit(child.expression);
        return;
      }
      ts.forEachChild(child, visitReturns);
    }
    visitReturns(body);
  }
  function localObjectMemberCall(candidate) {
    if (!ts.isCallExpression(candidate)) return null;
    const names = [];
    let root = candidate.expression;
    while (ts.isPropertyAccessExpression(root)) {
      names.unshift(root.name.text);
      root = root.expression;
    }
    if (!ts.isIdentifier(root) || names.length === 0) return null;
    let value = declarations.get(root.text);
    if (!value || !ts.isObjectLiteralExpression(value)) return null;
    for (let index = 0; index < names.length; index += 1) {
      const member = value.properties.find(
        (property) => propertyNameText(property) === names[index],
      );
      if (!member) return null;
      if (index === names.length - 1) return { member, rootName: root.text };
      if (
        !ts.isPropertyAssignment(member) ||
        !ts.isObjectLiteralExpression(member.initializer)
      ) {
        return null;
      }
      value = member.initializer;
    }
    return null;
  }
  function visit(candidate) {
    if (ts.isParenthesizedExpression(candidate)) {
      visit(candidate.expression);
      return;
    }
    if (ts.isIdentifier(candidate)) {
      const declaration = declarations.get(candidate.text);
      if (!declaration || resolving.has(candidate.text)) {
        opaque = true;
        return;
      }
      resolving.add(candidate.text);
      if (ts.isFunctionLike(declaration)) visitFunction(declaration);
      else visit(declaration);
      resolving.delete(candidate.text);
      return;
    }
    if (
      ts.isCallExpression(candidate) &&
      ts.isIdentifier(candidate.expression)
    ) {
      const declaration = declarations.get(candidate.expression.text);
      if (!declaration || resolving.has(candidate.expression.text)) {
        opaque = true;
        return;
      }
      resolving.add(candidate.expression.text);
      if (ts.isFunctionLike(declaration)) visitFunction(declaration);
      else visit(declaration);
      resolving.delete(candidate.expression.text);
      return;
    }
    if (ts.isCallExpression(candidate)) {
      const resolvedCall = localObjectMemberCall(candidate);
      if (!resolvedCall || resolving.has(resolvedCall.rootName)) {
        opaque = true;
        return;
      }
      const { member, rootName } = resolvedCall;
      resolving.add(rootName);
      if (ts.isMethodDeclaration(member)) {
        visitFunction(member);
      } else if (ts.isPropertyAssignment(member)) {
        if (ts.isFunctionLike(member.initializer)) {
          visitFunction(member.initializer);
        } else {
          visit(member.initializer);
        }
      } else {
        opaque = true;
      }
      resolving.delete(rootName);
      return;
    }
    if (ts.isConditionalExpression(candidate)) {
      visit(candidate.whenTrue);
      visit(candidate.whenFalse);
      return;
    }
    if (!ts.isObjectLiteralExpression(candidate)) {
      opaque = true;
      return;
    }
    for (const property of candidate.properties) {
      if (ts.isSpreadAssignment(property)) {
        visit(property.expression);
      } else if (
        ts.isPropertyAssignment(property) &&
        propertyNameText(property) === propertyName
      ) {
        expressions.push(property.initializer);
      } else if (
        ts.isShorthandPropertyAssignment(property) &&
        property.name.text === propertyName
      ) {
        expressions.push(property.name);
      }
    }
  }

  visit(expression);
  return { expressions, opaque };
}

function jsxPropertyExpressions(node, propertyName, declarations) {
  const expressions = [];
  let opaque = false;

  for (const property of node.attributes.properties) {
    if (ts.isJsxSpreadAttribute(property)) {
      const resolved = objectPropertyExpressions(
        property.expression,
        propertyName,
        declarations,
      );
      expressions.push(...resolved.expressions);
      opaque ||= resolved.opaque;
    } else if (
      ts.isJsxAttribute(property) &&
      property.name.getText() === propertyName
    ) {
      if (!property.initializer) continue;
      if (ts.isStringLiteral(property.initializer)) {
        expressions.push(property.initializer);
      } else if (
        ts.isJsxExpression(property.initializer) &&
        property.initializer.expression
      ) {
        expressions.push(property.initializer.expression);
      }
    }
  }
  return { expressions, opaque };
}

function jsxAxisValues(node, axis, defaults, declarations) {
  const property = jsxPropertyExpressions(node, axis, declarations);
  const values = property.expressions.flatMap((expression) =>
    staticStringValues(expression, declarations),
  );
  if (values.length > 0) return [...new Set(values)];
  return !property.opaque && defaults[axis] ? [defaults[axis]] : [];
}

export function extractCanonicalAxisDefinitions({
  axes,
  configName,
  file,
  source,
}) {
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
      node.name.text === configName &&
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
  if (!config) throw new Error(`${configName} must be a cva config object`);

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
      `${configName} must declare object-literal variants and defaultVariants`,
    );
  }

  const definitions = [];
  const defaults = {};
  for (const axis of axes) {
    const axisProperty = objectProperty(variantsProperty.initializer, axis);
    if (
      !axisProperty ||
      !ts.isPropertyAssignment(axisProperty) ||
      !ts.isObjectLiteralExpression(axisProperty.initializer)
    ) {
      throw new Error(`${configName} is missing the ${axis} axis`);
    }
    for (const valueProperty of axisProperty.initializer.properties) {
      const value = propertyNameText(valueProperty);
      if (!value) continue;
      const recipe =
        ts.isPropertyAssignment(valueProperty) &&
        (ts.isStringLiteral(valueProperty.initializer) ||
          ts.isNoSubstitutionTemplateLiteral(valueProperty.initializer))
          ? valueProperty.initializer.text
          : null;
      definitions.push({
        axis,
        file: relative(file),
        line:
          sourceFile.getLineAndCharacterOfPosition(valueProperty.getStart())
            .line + 1,
        recipe,
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

export function extractButtonAxisDefinitions(options) {
  return extractCanonicalAxisDefinitions({
    ...options,
    axes: BUTTON_AXES,
    configName: "buttonVariants",
  });
}

export function extractCardVariantDefinitions(options) {
  return extractCanonicalAxisDefinitions({
    ...options,
    axes: CARD_AXES,
    configName: "cardVariants",
  });
}

export function scanCanonicalAxisUsages({
  axes,
  componentName,
  defaults,
  file,
  helperName,
  source,
}) {
  if (/(^|\/)stories(\/|$)|\.stories\.[jt]sx?$/.test(relative(file))) {
    return [];
  }
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const reachableOwners = reachableOwnerNames(sourceFile);
  const imports = importsByLocalName(sourceFile);
  const declarations = indexStaticDeclarations(sourceFile);
  const usages = [];
  function record(axis, value, node) {
    usages.push({
      axis,
      file: relative(file),
      line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      owner: enclosingSymbol(node) ?? "<module>",
      value,
    });
  }
  function visit(node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const rootName = node.tagName.getText().split(".")[0];
      const imported = imports.get(rootName);
      if (
        imported?.imported === componentName &&
        (componentName === "Card"
          ? resolvesCardUsage(imported, file)
          : resolvesToCanonical(imported, file))
      ) {
        for (const axis of axes) {
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
        imported?.imported === helperName &&
        resolvesToCanonical(imported, file) &&
        options &&
        ts.isObjectLiteralExpression(options)
      ) {
        for (const axis of axes) {
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
  return usages.filter((usage) => reachableOwners.has(usage.owner));
}

export function scanButtonAxisUsages(options) {
  return scanCanonicalAxisUsages({
    ...options,
    axes: BUTTON_AXES,
    componentName: "Button",
    helperName: "buttonVariants",
  });
}

export function scanCardVariantUsages(options) {
  return scanCanonicalAxisUsages({
    ...options,
    axes: CARD_AXES,
    componentName: "Card",
    helperName: "cardVariants",
  });
}

export function findUnderusedCanonicalAxes({
  definitions,
  usages,
  minimumCallers,
}) {
  return inventoryCanonicalAxes({ definitions, usages }).filter(
    (entry) => entry.callerCount < minimumCallers,
  );
}

function inventoryCanonicalAxes({ definitions, usages }) {
  return definitions.map((definition) => {
    const matchingUsages = usages.filter(
      (usage) =>
        usage.axis === definition.axis && usage.value === definition.value,
    );
    const callers = [
      ...new Map(
        matchingUsages.map((usage) => [
          `${usage.file}#${usage.owner ?? `line:${usage.line}`}`,
          usage,
        ]),
      ).values(),
    ];
    return { ...definition, callerCount: callers.length, callers };
  });
}

export function findUnderusedButtonAxes(options) {
  return findUnderusedCanonicalAxes({
    ...options,
    minimumCallers: options.minimumCallers ?? BUTTON_MIN_MAINTAINED_CALLERS,
  });
}

export function findUnderusedCardVariants(options) {
  return findUnderusedCanonicalAxes({
    ...options,
    minimumCallers: options.minimumCallers ?? CARD_MIN_MAINTAINED_CALLERS,
  });
}

function cardVariantDomain(file) {
  const plugin = /^plugins\/([^/]+)\//.exec(file);
  if (plugin) return plugin[1];
  const cloudUiArea =
    /^packages\/ui\/src\/cloud-ui\/components\/([^/]+)\//.exec(file);
  if (cloudUiArea) return `cloud-ui/${cloudUiArea[1]}`;
  if (/^packages\/ui\/src\/cloud-ui\/components\/[^/]+\.[jt]sx$/.test(file))
    return "cloud-ui/core";
  const compositeArea =
    /^packages\/ui\/src\/components\/composites\/([^/]+)\//.exec(file);
  if (compositeArea) return `components/composites/${compositeArea[1]}`;
  const uiArea = /^packages\/ui\/src\/(cloud|components)\/([^/]+)\//.exec(file);
  if (uiArea) return `${uiArea[1]}/${uiArea[2]}`;
  const uiRoot = /^packages\/ui\/src\/([^/]+)\//.exec(file);
  if (uiRoot) return `ui/${uiRoot[1]}`;
  const packageName = /^packages\/([^/]+)\//.exec(file);
  return packageName ? packageName[1] : "other";
}

function genericCardAxes(recipe) {
  if (!recipe) return {};
  const tokens = new Set(recipe.split(/\s+/).filter(Boolean));
  const axes = {};
  if (tokens.has("space-y-3")) axes.stack = "compact";
  else if (tokens.has("space-y-4")) axes.stack = "default";
  if (tokens.has("flex-col")) axes.flow = "column";
  else if (tokens.has("items-center") && tokens.has("justify-between"))
    axes.flow = "rowBetween";
  else if (tokens.has("items-center")) axes.flow = "row";
  if (tokens.has("gap-1.5")) axes.gap = "tight";
  else if (tokens.has("gap-2")) axes.gap = "compact";
  else if (tokens.has("gap-3")) axes.gap = "default";
  if (tokens.has("p-4")) axes.padding = "comfortable";
  else if (tokens.has("p-3")) axes.padding = "default";
  else if (tokens.has("px-3") && tokens.has("py-2")) axes.padding = "compact";
  const tones = [
    ["text-accent", "accent"],
    ["text-warn", "warning"],
    ["text-status-info", "info"],
    ["text-ok", "success"],
    ["text-danger", "danger"],
    ["text-txt-strong", "strong"],
    ["text-muted-strong", "mutedStrong"],
    ["text-txt", "text"],
    ["text-inverse-foreground", "inverse"],
  ];
  const tone = tones.find(([token]) => tokens.has(token));
  if (tone) axes.tone = tone[1];
  return axes;
}

function suggestedCardOwner(value, domain) {
  if (/^attachment/.test(value)) return "Attachment atom";
  if (/(?:Notice|^errorFallback$|^viewStatus)/.test(value))
    return "Alert atom or local status molecule";
  if (/^(?:drawer|authorize)/.test(value)) return `${domain} overlay molecule`;
  return `${domain} molecule`;
}

export function buildCardVariantMigrationInventory(cardVariants) {
  const entries = cardVariants
    .filter((entry) => entry.callerCount < CARD_MIN_MAINTAINED_CALLERS)
    .map((entry) => {
      const callerFiles = [
        ...new Set(entry.callers.map((caller) => caller.file)),
      ];
      const domains = [...new Set(callerFiles.map(cardVariantDomain))];
      const primaryDomain = domains[0] ?? "unowned";
      return {
        callerCount: entry.callerCount,
        callers: entry.callers.map(({ file, line }) => ({ file, line })),
        domains,
        file: entry.file,
        line: entry.line,
        recipe: entry.recipe,
        suggestedAxes: genericCardAxes(entry.recipe),
        suggestedOwner: suggestedCardOwner(entry.value, primaryDomain),
        value: entry.value,
      };
    });
  const byDomain = Object.fromEntries(
    [...new Set(entries.flatMap((entry) => entry.domains))]
      .sort()
      .map((domain) => [
        domain,
        entries
          .filter((entry) => entry.domains.includes(domain))
          .map((entry) => entry.value),
      ]),
  );
  return {
    byDomain,
    entries,
    minimumMaintainedCallers: CARD_MIN_MAINTAINED_CALLERS,
  };
}

function staticPropertyText(property, declarations) {
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
      if (
        initializer &&
        !ts.isFunctionLike(initializer) &&
        !resolving.has(expression.text)
      ) {
        resolving.add(expression.text);
        collect(initializer);
        resolving.delete(expression.text);
      }
      return;
    }
    ts.forEachChild(expression, collect);
  }
  for (const expression of property.expressions) {
    collect(expression);
  }
  return fragments.length > 0 ? fragments.join(" ") : null;
}

function staticAttributeText(node, name, declarations) {
  return staticPropertyText(
    jsxPropertyExpressions(node, name, declarations),
    declarations,
  );
}

function hasOpaquePropertyExpression(property, declarations) {
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
      if (
        !initializer ||
        ts.isFunctionLike(initializer) ||
        resolving.has(expression.text)
      )
        return false;
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

  return property.expressions.some(inspect);
}

function hasOpaqueClassExpression(node, declarations) {
  return hasOpaquePropertyExpression(
    jsxPropertyExpressions(node, "className", declarations),
    declarations,
  );
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

const CARD_VISUAL_STYLE_PROPERTIES = new Set([
  "backdropFilter",
  "background",
  "backgroundColor",
  "backgroundImage",
  "border",
  "borderBottom",
  "borderColor",
  "borderLeft",
  "borderRadius",
  "borderRight",
  "borderTop",
  "boxShadow",
  "color",
  "WebkitBackdropFilter",
]);

const SAFE_LITERAL_PAINT = new Set([
  "currentColor",
  "inherit",
  "initial",
  "none",
  "revert",
  "revert-layer",
  "transparent",
  "unset",
]);

function hasInvalidTokenStyleKey(property, declarations) {
  const resolving = new Set();
  function hasRawValue(expression) {
    const values = staticStringValues(expression, declarations);
    if (values.length > 0) {
      return values.some((value) => !/var\(\s*--/.test(value));
    }
    if (
      ts.isNumericLiteral(expression) ||
      (ts.isPrefixUnaryExpression(expression) &&
        ts.isNumericLiteral(expression.operand))
    ) {
      return true;
    }
    if (ts.isIdentifier(expression)) {
      const initializer = declarations.get(expression.text);
      if (!initializer || resolving.has(expression.text)) return false;
      resolving.add(expression.text);
      const raw = hasRawValue(initializer);
      resolving.delete(expression.text);
      return raw;
    }
    return false;
  }
  function inspect(expression) {
    if (ts.isParenthesizedExpression(expression)) {
      return inspect(expression.expression);
    }
    if (ts.isIdentifier(expression)) {
      const initializer = declarations.get(expression.text);
      if (!initializer || resolving.has(expression.text)) return false;
      resolving.add(expression.text);
      const invalid = inspect(initializer);
      resolving.delete(expression.text);
      return invalid;
    }
    if (ts.isConditionalExpression(expression)) {
      return inspect(expression.whenTrue) || inspect(expression.whenFalse);
    }
    if (!ts.isObjectLiteralExpression(expression)) return false;
    for (const member of expression.properties) {
      if (ts.isSpreadAssignment(member)) {
        if (inspect(member.expression)) return true;
        continue;
      }
      if (
        !ts.isPropertyAssignment(member) &&
        !ts.isShorthandPropertyAssignment(member)
      ) {
        return true;
      }
      const name = propertyNameText(member);
      if (!name || !CARD_TOKEN_STYLE_KEYS.has(name)) return true;
      if (ts.isPropertyAssignment(member) && hasRawValue(member.initializer)) {
        return true;
      }
    }
    return false;
  }
  return property.expressions.some(inspect);
}

function hasRawVisualStyleLiteral(property, declarations) {
  const resolving = new Set();
  function staticValues(expression) {
    if (
      ts.isStringLiteral(expression) ||
      ts.isNoSubstitutionTemplateLiteral(expression) ||
      ts.isNumericLiteral(expression)
    ) {
      return [expression.text];
    }
    if (ts.isParenthesizedExpression(expression)) {
      return staticValues(expression.expression);
    }
    if (ts.isIdentifier(expression)) {
      const initializer = declarations.get(expression.text);
      if (!initializer || resolving.has(expression.text)) return null;
      resolving.add(expression.text);
      const values = staticValues(initializer);
      resolving.delete(expression.text);
      return values;
    }
    if (ts.isConditionalExpression(expression)) {
      const whenTrue = staticValues(expression.whenTrue);
      const whenFalse = staticValues(expression.whenFalse);
      return whenTrue && whenFalse ? [...whenTrue, ...whenFalse] : null;
    }
    if (
      ts.isBinaryExpression(expression) &&
      expression.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      const left = staticValues(expression.left);
      const right = staticValues(expression.right);
      if (!left || !right) return null;
      return left.flatMap((leftValue) =>
        right.map((rightValue) => `${leftValue}${rightValue}`),
      );
    }
    if (ts.isTemplateExpression(expression)) {
      let values = [expression.head.text];
      for (const span of expression.templateSpans) {
        const spanValues = staticValues(span.expression);
        if (!spanValues) return null;
        values = values.flatMap((prefix) =>
          spanValues.map(
            (spanValue) => `${prefix}${spanValue}${span.literal.text}`,
          ),
        );
      }
      return values;
    }
    if (
      ts.isPrefixUnaryExpression(expression) &&
      ts.isNumericLiteral(expression.operand)
    ) {
      return [
        `${expression.operator === ts.SyntaxKind.MinusToken ? "-" : ""}${expression.operand.text}`,
      ];
    }
    if (
      ts.isCallExpression(expression) &&
      ts.isIdentifier(expression.expression)
    ) {
      const declaration = declarations.get(expression.expression.text);
      if (!declaration || resolving.has(expression.expression.text)) {
        return null;
      }
      resolving.add(expression.expression.text);
      const values = staticValues(declaration);
      resolving.delete(expression.expression.text);
      return values;
    }
    if (ts.isFunctionLike(expression) && expression.body) {
      if (!ts.isBlock(expression.body)) return staticValues(expression.body);
      const values = [];
      let complete = true;
      function collectReturns(node) {
        if (node !== expression.body && ts.isFunctionLike(node)) return;
        if (ts.isReturnStatement(node)) {
          const returned = node.expression
            ? staticValues(node.expression)
            : null;
          if (!returned) complete = false;
          else values.push(...returned);
          return;
        }
        ts.forEachChild(node, collectReturns);
      }
      collectReturns(expression.body);
      return complete && values.length > 0 ? values : null;
    }
    return null;
  }

  function inspectValue(expression) {
    const values = staticValues(expression);
    if (values) {
      return values.some(
        (value) =>
          !SAFE_LITERAL_PAINT.has(value.trim()) && !/var\(\s*--/.test(value),
      );
    }
    if (ts.isIdentifier(expression)) {
      const initializer = declarations.get(expression.text);
      return initializer ? inspectValue(initializer) : false;
    }
    if (ts.isConditionalExpression(expression)) {
      return (
        inspectValue(expression.whenTrue) || inspectValue(expression.whenFalse)
      );
    }
    if (
      ts.isPropertyAccessExpression(expression) ||
      ts.isElementAccessExpression(expression)
    ) {
      return false;
    }
    if (ts.isCallExpression(expression)) {
      if (
        ts.isIdentifier(expression.expression) &&
        declarations.has(expression.expression.text)
      ) {
        return true;
      }
      return false;
    }
    if (ts.isTemplateExpression(expression)) {
      return expression.templateSpans.some((span) =>
        inspectValue(span.expression),
      );
    }
    return true;
  }
  function inspectObject(expression) {
    if (ts.isParenthesizedExpression(expression)) {
      return inspectObject(expression.expression);
    }
    if (ts.isIdentifier(expression)) {
      const initializer = declarations.get(expression.text);
      if (!initializer || resolving.has(expression.text)) return false;
      resolving.add(expression.text);
      const raw = inspectObject(initializer);
      resolving.delete(expression.text);
      return raw;
    }
    if (ts.isConditionalExpression(expression)) {
      return (
        inspectObject(expression.whenTrue) ||
        inspectObject(expression.whenFalse)
      );
    }
    if (!ts.isObjectLiteralExpression(expression)) return false;
    for (const member of expression.properties) {
      if (ts.isSpreadAssignment(member)) {
        if (inspectObject(member.expression)) return true;
        continue;
      }
      const name = propertyNameText(member);
      if (!name || !CARD_VISUAL_STYLE_PROPERTIES.has(name)) continue;
      if (ts.isPropertyAssignment(member) && inspectValue(member.initializer)) {
        return true;
      }
      if (
        ts.isShorthandPropertyAssignment(member) &&
        inspectValue(member.name)
      ) {
        return true;
      }
    }
    return false;
  }

  return property.expressions.some(inspectObject);
}

function staticStylePropertyNames(property, declarations) {
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
      if (
        initializer &&
        !ts.isFunctionLike(initializer) &&
        !resolving.has(expression.text)
      ) {
        resolving.add(expression.text);
        collect(initializer);
        resolving.delete(expression.text);
      }
      return;
    }
    ts.forEachChild(expression, collect);
  }
  for (const expression of property.expressions) {
    collect(expression);
  }
  return [...properties].filter((property) =>
    VISUAL_STYLE_PROPERTIES.has(property),
  );
}

function staticStyleProperties(node, declarations) {
  return staticStylePropertyNames(
    jsxPropertyExpressions(node, "style", declarations),
    declarations,
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

function importedExpressionIsOpaque(expression, imports, declarations) {
  let root = expression;
  if (ts.isCallExpression(root)) root = root.expression;
  while (
    ts.isPropertyAccessExpression(root) ||
    ts.isElementAccessExpression(root)
  ) {
    root = root.expression;
  }
  return (
    ts.isIdentifier(root) &&
    imports.has(root.text) &&
    !declarations.has(root.text)
  );
}

function hasOpaqueImportedJsxSpread(node, imports, declarations) {
  return node.attributes.properties.some(
    (property) =>
      ts.isJsxSpreadAttribute(property) &&
      importedExpressionIsOpaque(property.expression, imports, declarations),
  );
}

function bindingContainsName(binding, name) {
  if (ts.isIdentifier(binding)) return binding.text === name;
  return binding.elements.some(
    (element) =>
      ts.isBindingElement(element) && bindingContainsName(element.name, name),
  );
}

function expressionIsForwardedParameter(expression, node, declarations) {
  let root = expression;
  if (ts.isCallExpression(root)) root = root.expression;
  while (
    ts.isPropertyAccessExpression(root) ||
    ts.isElementAccessExpression(root)
  ) {
    root = root.expression;
  }
  if (
    !ts.isIdentifier(root) ||
    declarations.has(root.text) ||
    root.text === "undefined"
  ) {
    return false;
  }
  for (let owner = node.parent; owner; owner = owner.parent) {
    if (!ts.isFunctionLike(owner)) continue;
    const parameter = owner.parameters.find((candidate) =>
      bindingContainsName(candidate.name, root.text),
    );
    if (!parameter) return false;
    const contextualCall = ts.isCallExpression(owner.parent)
      ? owner.parent
      : null;
    if (contextualCall?.typeArguments?.length) return false;
    return (
      !parameter.type ||
      parameter.type.kind === ts.SyntaxKind.AnyKeyword ||
      parameter.type.kind === ts.SyntaxKind.UnknownKeyword
    );
  }
  return false;
}

function hasOpaqueForwardedJsxSpread(node, declarations) {
  return node.attributes.properties.some(
    (property) =>
      ts.isJsxSpreadAttribute(property) &&
      expressionIsForwardedParameter(property.expression, node, declarations),
  );
}

function canonicalRecordForExpression(
  expression,
  imports,
  declarations,
  resolving = new Set(),
) {
  function localObject(candidate) {
    if (ts.isParenthesizedExpression(candidate)) {
      return localObject(candidate.expression);
    }
    if (ts.isObjectLiteralExpression(candidate)) return candidate;
    if (ts.isIdentifier(candidate)) {
      const key = `object:${candidate.text}`;
      const declaration = declarations.get(candidate.text);
      if (!declaration || resolving.has(key)) return null;
      resolving.add(key);
      const object = localObject(declaration);
      resolving.delete(key);
      return object;
    }
    return null;
  }

  if (ts.isIdentifier(expression)) {
    const imported = imports.get(expression.text);
    if (imported) return imported;
    const key = `alias:${expression.text}`;
    const declaration = declarations.get(expression.text);
    if (!declaration || resolving.has(key)) return null;
    resolving.add(key);
    const record = canonicalRecordForExpression(
      declaration,
      imports,
      declarations,
      resolving,
    );
    resolving.delete(key);
    return record;
  }
  let root = null;
  let imported = null;
  if (ts.isPropertyAccessExpression(expression)) {
    root = expression.expression;
    imported = expression.name.text;
  } else if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression &&
    (ts.isStringLiteral(expression.argumentExpression) ||
      ts.isNoSubstitutionTemplateLiteral(expression.argumentExpression))
  ) {
    root = expression.expression;
    imported = expression.argumentExpression.text;
  }
  if (!root || !imported) return null;
  if (ts.isIdentifier(root)) {
    const namespace = imports.get(root.text);
    if (namespace?.imported === "*") return { ...namespace, imported };
  }
  const object = localObject(root);
  if (!object) return null;
  const member = object.properties.find(
    (property) => propertyNameText(property) === imported,
  );
  if (!member) return null;
  if (ts.isShorthandPropertyAssignment(member)) {
    return canonicalRecordForExpression(
      member.name,
      imports,
      declarations,
      resolving,
    );
  }
  if (ts.isPropertyAssignment(member)) {
    return canonicalRecordForExpression(
      member.initializer,
      imports,
      declarations,
      resolving,
    );
  }
  return null;
}

function reactFactoryReferences(sourceFile, imports) {
  const factories = new Set();
  const namespaces = new Set();
  for (const [local, record] of imports) {
    if (record.origin !== "react") continue;
    if (record.imported === "createElement") factories.add(local);
    if (["default", "*"].includes(record.imported)) namespaces.add(local);
  }
  function isFactoryReference(expression) {
    if (ts.isIdentifier(expression)) return factories.has(expression.text);
    if (
      ts.isPropertyAccessExpression(expression) &&
      expression.name.text === "createElement" &&
      ts.isIdentifier(expression.expression)
    ) {
      return namespaces.has(expression.expression.text);
    }
    return (
      ts.isElementAccessExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      namespaces.has(expression.expression.text) &&
      expression.argumentExpression &&
      (ts.isStringLiteral(expression.argumentExpression) ||
        ts.isNoSubstitutionTemplateLiteral(expression.argumentExpression)) &&
      expression.argumentExpression.text === "createElement"
    );
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const statement of sourceFile.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!declaration.initializer) continue;
        if (ts.isIdentifier(declaration.name)) {
          if (
            isFactoryReference(declaration.initializer) &&
            !factories.has(declaration.name.text)
          ) {
            factories.add(declaration.name.text);
            changed = true;
          }
          if (
            ts.isIdentifier(declaration.initializer) &&
            namespaces.has(declaration.initializer.text) &&
            !namespaces.has(declaration.name.text)
          ) {
            namespaces.add(declaration.name.text);
            changed = true;
          }
          continue;
        }
        if (
          ts.isObjectBindingPattern(declaration.name) &&
          ts.isIdentifier(declaration.initializer) &&
          namespaces.has(declaration.initializer.text)
        ) {
          for (const element of declaration.name.elements) {
            if (
              ts.isIdentifier(element.name) &&
              (element.propertyName ?? element.name).getText() ===
                "createElement" &&
              !factories.has(element.name.text)
            ) {
              factories.add(element.name.text);
              changed = true;
            }
          }
        }
      }
    }
  }
  return { factories, isFactoryReference };
}

function reactCreateElementProps(node, reactFactories) {
  if (!ts.isCallExpression(node)) return null;
  if (!reactFactories.isFactoryReference(node.expression)) return null;
  const [element, props] = node.arguments;
  if (!element || !props) return null;
  return { element, props };
}

export function scanSourceText({
  adapterExports,
  adapterMatches,
  buttonDefaults,
  buttonUsages,
  cardDefaults,
  cardUsages,
  file,
  paintedCssClasses,
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
  const reactFactories = reactFactoryReferences(sourceFile, imports);
  const rel = relative(file);
  const findings = [];
  const fileExports = exportedNames(sourceFile);
  const isStoryFile = /(^|\/)stories(\/|$)|\.stories\.[jt]sx?$/.test(rel);
  const maintainedReuseOwners = isStoryFile
    ? new Set()
    : reachableOwnerNames(sourceFile);

  function maintainedReuseOwner(node) {
    const owner = enclosingSymbol(node);
    return owner && maintainedReuseOwners.has(owner) ? owner : null;
  }

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
      if (
        ts.isIdentifier(node.tagName) &&
        /^[a-z]/.test(tag) &&
        !rel.startsWith(`${canonicalRoot}/`)
      ) {
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
        const classTokens = new Set(className?.split(/\s+/).filter(Boolean));
        if (
          classTokens.has("bg-card") &&
          classTokens.has("rounded-sm") &&
          classTokens.has("p-4") &&
          ![...classTokens].some((token) =>
            /^(?:border|shadow|ring)(?:-|$)/.test(token),
          )
        ) {
          findings.push(
            finding({
              rule: "raw-card-recipe",
              file: rel,
              line,
              symbol: tag,
              detail:
                'Use Card variant="flatPadded" instead of reconstructing its surface recipe on a raw host.',
            }),
          );
        }
        const hasInsetDensity =
          classTokens.has("p-3") ||
          (classTokens.has("px-3") && classTokens.has("py-2"));
        if (
          classTokens.has("bg-surface") &&
          classTokens.has("rounded-sm") &&
          classTokens.has("border") &&
          classTokens.has("border-border") &&
          hasInsetDensity &&
          ![...classTokens].some(
            (token) =>
              (token.startsWith("bg-") && token !== "bg-surface") ||
              (token.startsWith("border-") && token !== "border-border"),
          )
        ) {
          findings.push(
            finding({
              rule: "raw-inset-card-recipe",
              file: rel,
              line,
              symbol: tag,
              detail:
                'Use Card variant="insetCompact" or "insetPadded" instead of reconstructing its inset surface recipe on a raw host.',
            }),
          );
        }
        if (
          classTokens.has("bg-card") &&
          classTokens.has("rounded-sm") &&
          classTokens.has("border") &&
          classTokens.has("border-border") &&
          classTokens.has("p-4") &&
          ![...classTokens].some(
            (token) =>
              (token.startsWith("bg-") && token !== "bg-card") ||
              (token.startsWith("border-") && token !== "border-border"),
          )
        ) {
          findings.push(
            finding({
              rule: "raw-outlined-card-recipe",
              file: rel,
              line,
              symbol: tag,
              detail:
                'Use Card variant="outlinedPadded" instead of reconstructing its outlined surface recipe on a raw host.',
            }),
          );
        }
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
        const record = canonicalRecordForExpression(
          node.tagName,
          imports,
          declarations,
        );
        const reuseOwner = maintainedReuseOwner(node);
        if (
          record?.imported === "Card" &&
          cardDefaults &&
          cardUsages &&
          reuseOwner &&
          resolvesCardUsage(record, file)
        ) {
          for (const axis of CARD_AXES) {
            for (const value of jsxAxisValues(
              node,
              axis,
              cardDefaults,
              declarations,
            )) {
              cardUsages.push({
                axis,
                file: rel,
                line,
                owner: reuseOwner,
                value,
              });
            }
          }
        }
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
          if (
            record.imported === "Button" &&
            buttonDefaults &&
            buttonUsages &&
            reuseOwner
          ) {
            for (const axis of BUTTON_AXES) {
              for (const value of jsxAxisValues(
                node,
                axis,
                buttonDefaults,
                declarations,
              )) {
                buttonUsages.push({
                  axis,
                  file: rel,
                  line,
                  owner: reuseOwner,
                  value,
                });
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
            if (registeredAdapter && className) {
              for (const detail of analyzeTokenRoleClasses({
                className,
                role: registeredAdapter.role,
              })) {
                findings.push(
                  finding({
                    rule: "token-role-misuse",
                    file: rel,
                    line,
                    symbol: registeredAdapter.symbol,
                    detail,
                  }),
                );
              }
            }
            const visualUtility =
              record.imported === "Skeleton" || record.imported === "Tabs"
                ? SKELETON_PAINT_UTILITY
                : VISUAL_UTILITY;
            const styleProperties = staticStyleProperties(node, declarations);
            const paintedNamedClasses =
              record.imported === "Card"
                ? [
                    ...new Set(
                      (className?.split(/\s+/) ?? []).filter(
                        (classToken) =>
                          paintedCssClasses?.has(classToken) &&
                          !VISUAL_UTILITY.test(classToken),
                      ),
                    ),
                  ]
                : [];
            const opaqueClassName =
              !["Skeleton", "Tabs"].includes(record.imported) &&
              hasOpaqueClassExpression(node, declarations);
            const opaqueImportedSpread = hasOpaqueImportedJsxSpread(
              node,
              imports,
              declarations,
            );
            const opaqueForwardedSpread =
              !isStoryFile && hasOpaqueForwardedJsxSpread(node, declarations);
            const rawVisualStyle =
              record.imported === "Card" &&
              hasRawVisualStyleLiteral(
                jsxPropertyExpressions(node, "visualStyle", declarations),
                declarations,
              );
            const invalidTokenStyle =
              record.imported === "Card" &&
              hasInvalidTokenStyleKey(
                jsxPropertyExpressions(node, "tokenStyle", declarations),
                declarations,
              );
            if (
              (className && visualUtility.test(className)) ||
              styleProperties.length > 0 ||
              paintedNamedClasses.length > 0 ||
              opaqueClassName ||
              opaqueImportedSpread ||
              opaqueForwardedSpread ||
              rawVisualStyle ||
              invalidTokenStyle
            ) {
              if (!registeredAdapter) {
                findings.push(
                  finding({
                    rule: "visual-override",
                    file: rel,
                    line,
                    symbol: record.imported,
                    detail:
                      paintedNamedClasses.length > 0
                        ? `Canonical visual state is hidden in painted CSS class ${paintedNamedClasses.join(", ")}; move that paint into the atom's typed contract.`
                        : invalidTokenStyle
                          ? "Card tokenStyle keys must come from the canonical CSS-variable allowlist."
                          : rawVisualStyle
                            ? "Card visualStyle literals must use semantic CSS variables or runtime domain data."
                            : "Canonical visual state must use a typed variant or a registered adapter owner; className is reserved for caller layout.",
                  }),
                );
              }
            }
          }
        }
      }
      const className = staticAttributeText(node, "className", declarations);
      const classTokens = new Set(className?.split(/\s+/).filter(Boolean));
      if (
        tag === "Card" &&
        classTokens.has("border-border/70") &&
        classTokens.has("bg-background/85")
      ) {
        findings.push(
          finding({
            rule: "card-report-panel-override",
            file: rel,
            line,
            symbol: tag,
            detail:
              'Use Card variant="reportPanel" instead of repainting the canonical surface through className.',
          }),
        );
      }
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
    const reactFactory = reactCreateElementProps(node, reactFactories);
    if (reactFactory) {
      const record = canonicalRecordForExpression(
        reactFactory.element,
        imports,
        declarations,
      );
      if (
        record &&
        CANONICAL_NAMES.has(record.imported) &&
        resolvesToCanonical(record, file)
      ) {
        const line =
          sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        const classProperty = objectPropertyExpressions(
          reactFactory.props,
          "className",
          declarations,
        );
        const className = staticPropertyText(classProperty, declarations);
        const styleProperties = staticStylePropertyNames(
          objectPropertyExpressions(reactFactory.props, "style", declarations),
          declarations,
        );
        const paintedNamedClasses =
          record.imported === "Card"
            ? [
                ...new Set(
                  (className?.split(/\s+/) ?? []).filter(
                    (classToken) =>
                      paintedCssClasses?.has(classToken) &&
                      !VISUAL_UTILITY.test(classToken),
                  ),
                ),
              ]
            : [];
        const opaqueClassName =
          !["Skeleton", "Tabs"].includes(record.imported) &&
          hasOpaquePropertyExpression(classProperty, declarations);
        const opaqueImportedSpread = importedExpressionIsOpaque(
          reactFactory.props,
          imports,
          declarations,
        );
        const opaqueForwardedSpread =
          !isStoryFile &&
          expressionIsForwardedParameter(
            reactFactory.props,
            node,
            declarations,
          );
        const rawVisualStyle =
          record.imported === "Card" &&
          hasRawVisualStyleLiteral(
            objectPropertyExpressions(
              reactFactory.props,
              "visualStyle",
              declarations,
            ),
            declarations,
          );
        const invalidTokenStyle =
          record.imported === "Card" &&
          hasInvalidTokenStyleKey(
            objectPropertyExpressions(
              reactFactory.props,
              "tokenStyle",
              declarations,
            ),
            declarations,
          );
        const visualUtility =
          record.imported === "Skeleton" || record.imported === "Tabs"
            ? SKELETON_PAINT_UTILITY
            : VISUAL_UTILITY;
        if (
          (className && visualUtility.test(className)) ||
          styleProperties.length > 0 ||
          paintedNamedClasses.length > 0 ||
          opaqueClassName ||
          opaqueImportedSpread ||
          opaqueForwardedSpread ||
          rawVisualStyle ||
          invalidTokenStyle
        ) {
          findings.push(
            finding({
              rule: "visual-override",
              file: rel,
              line,
              symbol: record.imported,
              detail:
                paintedNamedClasses.length > 0
                  ? `Canonical visual state is hidden in painted CSS class ${paintedNamedClasses.join(", ")}; move that paint into the atom's typed contract.`
                  : invalidTokenStyle
                    ? "Card tokenStyle keys must come from the canonical CSS-variable allowlist."
                    : rawVisualStyle
                      ? "Card visualStyle literals must use semantic CSS variables or runtime domain data."
                      : "Canonical visual state must use a typed variant or a registered adapter owner; className is reserved for caller layout.",
            }),
          );
        }
      }
    }
    if (
      buttonDefaults &&
      buttonUsages &&
      maintainedReuseOwner(node) &&
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
            buttonUsages.push({
              axis,
              file: rel,
              line,
              owner: maintainedReuseOwner(node),
              value,
            });
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
      exception.rule === "card-variant-reuse" ||
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

function publicCardSourceContract(file, source) {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const names = new Set();
  let cardPropsDerivesCardVariants = false;
  for (const statement of sourceFile.statements) {
    const exported = ts
      .getModifiers(statement)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (
      exported &&
      "name" in statement &&
      statement.name &&
      ts.isIdentifier(statement.name)
    ) {
      names.add(statement.name.text);
    }
    if (
      exported &&
      ts.isInterfaceDeclaration(statement) &&
      statement.name.text === "CardProps"
    ) {
      cardPropsDerivesCardVariants =
        statement.heritageClauses?.some(
          (clause) =>
            clause.token === ts.SyntaxKind.ExtendsKeyword &&
            clause.types.some(
              (type) =>
                ts.isIdentifier(type.expression) &&
                type.expression.text === "VariantProps" &&
                type.typeArguments?.some(
                  (argument) =>
                    ts.isTypeQueryNode(argument) &&
                    ts.isIdentifier(argument.exprName) &&
                    argument.exprName.text === "cardVariants",
                ),
            ),
        ) === true;
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        names.add(element.name.text);
      }
    }
  }
  return { cardPropsDerivesCardVariants, names };
}

function reexportedModuleSpecifiers(file, source) {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  return new Set(
    sourceFile.statements
      .filter(
        (statement) =>
          ts.isExportDeclaration(statement) &&
          statement.exportClause === undefined &&
          statement.moduleSpecifier !== undefined &&
          ts.isStringLiteral(statement.moduleSpecifier),
      )
      .map((statement) => statement.moduleSpecifier.text),
  );
}

/**
 * Validates review-dated Card variants that remain part of the published API
 * even after their maintained in-repo callers have moved to newer layouts.
 */
export function validatePublicCardVariantCompatibility({
  cardSource,
  cardVariants,
  document,
  now,
  publicBarrelSources,
  packageDocument,
}) {
  if (
    document.schemaVersion !== 1 ||
    !Array.isArray(document.variants) ||
    typeof packageDocument !== "object" ||
    packageDocument === null ||
    typeof packageDocument.exports !== "object" ||
    packageDocument.exports === null
  ) {
    throw new Error(
      "Public Card variant compatibility requires schemaVersion 1, variants, and package exports",
    );
  }
  const ids = new Set();
  const values = new Set();
  const sourceContract = publicCardSourceContract(cardPath, cardSource);
  const requiredSymbols = ["Card", "CardProps", "cardVariants"];
  const requiredPackageExports = [".", "./card"];
  const requiredBarrels = [
    {
      file: "packages/ui/src/index.ts",
      reexport: "./components/primitives/index",
    },
    {
      file: "packages/ui/src/components/primitives/index.ts",
      reexport: "../ui/card",
    },
    {
      file: "packages/ui/src/browser.ts",
      reexport: "./components/ui/card.tsx",
    },
  ];

  return document.variants.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.id !== "string" ||
      ids.has(entry.id) ||
      typeof entry.value !== "string" ||
      values.has(entry.value) ||
      entry.file !== relative(cardPath) ||
      !Array.isArray(entry.packageExports) ||
      entry.packageExports.length !== requiredPackageExports.length ||
      !requiredPackageExports.every((packageExport) =>
        entry.packageExports.includes(packageExport),
      ) ||
      !Array.isArray(entry.publicSymbols) ||
      entry.publicSymbols.length !== requiredSymbols.length ||
      !requiredSymbols.every((symbol) =>
        entry.publicSymbols.includes(symbol),
      ) ||
      !Array.isArray(entry.publicBarrels) ||
      entry.publicBarrels.length !== requiredBarrels.length ||
      !requiredBarrels.every((requiredBarrel) =>
        entry.publicBarrels.some(
          (barrel) =>
            barrel?.file === requiredBarrel.file &&
            barrel.reexport === requiredBarrel.reexport,
        ),
      ) ||
      typeof entry.recipe !== "string" ||
      typeof entry.reason !== "string" ||
      entry.reason.trim() === "" ||
      typeof entry.reviewBy !== "string"
    ) {
      throw new Error(
        `Invalid public Card variant compatibility: ${JSON.stringify(entry)}`,
      );
    }
    ids.add(entry.id);
    values.add(entry.value);
    const reviewBy = Date.parse(`${entry.reviewBy}T23:59:59Z`);
    if (!Number.isFinite(reviewBy) || reviewBy < now.getTime()) {
      throw new Error(
        `Stale public Card variant compatibility ${entry.id}: reviewBy=${entry.reviewBy}`,
      );
    }
    const rootPackageExport = packageDocument.exports["."];
    if (
      typeof rootPackageExport !== "object" ||
      rootPackageExport === null ||
      rootPackageExport.types !== "./dist/index.d.ts" ||
      rootPackageExport.import !== "./dist/index.js" ||
      rootPackageExport.default !== "./dist/index.js"
    ) {
      throw new Error(
        `Public Card variant compatibility ${entry.id} requires the canonical root package export`,
      );
    }
    const packageExport = packageDocument.exports["./card"];
    if (
      typeof packageExport !== "object" ||
      packageExport === null ||
      packageExport.types !== "./dist/components/ui/card.d.ts" ||
      packageExport.import !== "./dist/components/ui/card.js" ||
      packageExport.default !== "./dist/components/ui/card.js"
    ) {
      throw new Error(
        `Public Card variant compatibility ${entry.id} requires the canonical ./card package export`,
      );
    }
    const missingSymbols = entry.publicSymbols.filter(
      (symbol) => !sourceContract.names.has(symbol),
    );
    if (missingSymbols.length > 0) {
      throw new Error(
        `Public Card variant compatibility ${entry.id} is missing exports ${missingSymbols.join(", ")}`,
      );
    }
    if (!sourceContract.cardPropsDerivesCardVariants) {
      throw new Error(
        `Public Card variant compatibility ${entry.id} requires CardProps to derive VariantProps<typeof cardVariants>`,
      );
    }
    for (const barrel of entry.publicBarrels) {
      const barrelSource = publicBarrelSources?.[barrel.file];
      if (
        typeof barrelSource !== "string" ||
        !reexportedModuleSpecifiers(barrel.file, barrelSource).has(
          barrel.reexport,
        )
      ) {
        throw new Error(
          `Public Card variant compatibility ${entry.id} is missing public barrel ${barrel.file} -> ${barrel.reexport}`,
        );
      }
    }
    const definition = cardVariants.find(
      (candidate) =>
        candidate.axis === "variant" && candidate.value === entry.value,
    );
    if (
      !definition ||
      definition.file !== entry.file ||
      definition.recipe !== entry.recipe
    ) {
      throw new Error(
        `Public Card variant compatibility ${entry.id} does not match its canonical recipe`,
      );
    }
    if (definition.callerCount >= CARD_MIN_MAINTAINED_CALLERS) {
      throw new Error(
        `Public Card variant compatibility ${entry.id} is no longer underused and must be removed`,
      );
    }
    return { ...entry, callerCount: definition.callerCount };
  });
}

export function parseAtomicConsolidationLedger(document) {
  if (
    !document ||
    typeof document !== "object" ||
    Array.isArray(document) ||
    document.schemaVersion !== 1 ||
    !Array.isArray(document.entries)
  ) {
    throw new Error(
      "atomic-consolidation-ledger.json must use schemaVersion 1 with entries",
    );
  }
  const componentIds = new Set();
  const statuses = {
    unresolved: true,
    "resolved-adapter": true,
    "resolved-deleted": true,
  };
  const allowedFields = {
    canonicalOwner: true,
    componentId: true,
    removedFile: true,
    status: true,
  };
  for (const entry of document.entries) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      typeof entry.componentId !== "string" ||
      !/^(packages|plugins)\/.*\.[jt]sx?:[^:]+$/.test(entry.componentId) ||
      typeof entry.canonicalOwner !== "string" ||
      !/^(packages|plugins)\/.*\.[jt]sx?$/.test(entry.canonicalOwner) ||
      !Object.hasOwn(statuses, entry.status) ||
      Object.keys(entry).some(
        (field) => !Object.hasOwn(allowedFields, field),
      ) ||
      componentIds.has(entry.componentId) ||
      (entry.removedFile !== undefined &&
        (typeof entry.removedFile !== "string" ||
          !/^(packages|plugins)\/.*\.[jt]sx?$/.test(entry.removedFile))) ||
      (entry.status !== "resolved-deleted" && entry.removedFile !== undefined)
    ) {
      throw new Error(
        `Invalid atomic consolidation ledger entry: ${JSON.stringify(entry)}`,
      );
    }
    componentIds.add(entry.componentId);
  }
  return document.entries;
}

export function collectAtomicDuplicateFindings(
  inventory,
  ledgerDocument,
  options = {},
) {
  const entries = parseAtomicConsolidationLedger(ledgerDocument);
  const ledgerComponentIds = new Set(entries.map((entry) => entry.componentId));
  const fileExists =
    options.fileExists ?? ((file) => fs.existsSync(path.join(repoRoot, file)));
  const candidates = new Map();
  for (const group of Object.values(inventory.atoms)) {
    for (const candidate of group.candidates) {
      const key = `${candidate.file}:${candidate.name}`;
      if (!candidates.has(key)) candidates.set(key, candidate);
    }
  }
  const componentIds = new Set(
    (inventory.components ?? []).map(
      (component) => `${component.file}:${component.name}`,
    ),
  );
  const findings = new Map();
  const errors = [];
  const addFinding = (componentId, canonicalOwner, candidate) => {
    const separator = componentId.lastIndexOf(":");
    const file = componentId.slice(0, separator);
    const symbol = componentId.slice(separator + 1);
    findings.set(
      componentId,
      finding({
        rule: "atomic-duplicate",
        file,
        line: candidate?.line ?? 1,
        symbol,
        detail: `Consolidate with ${canonicalOwner}.`,
      }),
    );
  };

  for (const entry of entries) {
    const candidate = candidates.get(entry.componentId);
    if (!fileExists(entry.canonicalOwner)) {
      errors.push(
        `${entry.componentId} lost canonical owner ${entry.canonicalOwner}`,
      );
    }
    if (entry.status === "unresolved") {
      addFinding(entry.componentId, entry.canonicalOwner, candidate);
      continue;
    }
    if (entry.status === "resolved-deleted") {
      if (componentIds.has(entry.componentId)) {
        errors.push(`${entry.componentId} was reintroduced after deletion`);
      }
      if (entry.removedFile && fileExists(entry.removedFile)) {
        errors.push(`${entry.removedFile} was reintroduced after deletion`);
      }
      continue;
    }
    if (
      candidate?.classification !== "canonical-wrapper" ||
      candidate.decision?.disposition !== "intentional-specialization" ||
      candidate.decision.canonicalOwner !== entry.canonicalOwner
    ) {
      errors.push(
        `${entry.componentId} no longer resolves as the reviewed adapter for ${entry.canonicalOwner}`,
      );
    }
  }

  for (const candidate of candidates.values()) {
    if (candidate.decision?.disposition !== "consolidation-candidate") continue;
    const componentId = `${candidate.file}:${candidate.name}`;
    if (!ledgerComponentIds.has(componentId)) {
      errors.push(
        `${componentId} must be recorded in the atomic consolidation ledger`,
      );
    }
    addFinding(componentId, candidate.decision.canonicalOwner, candidate);
  }
  if (errors.length > 0) {
    throw new Error(
      `Atomic consolidation ledger validation failed: ${errors.join("; ")}`,
    );
  }
  return [...findings.values()];
}

export function buildComplianceReport(options = {}) {
  const now = options.now ?? new Date();
  const inventory = buildInventory();
  const findings = collectAtomicDuplicateFindings(
    inventory,
    JSON.parse(fs.readFileSync(atomicConsolidationLedgerPath, "utf8")),
  );
  const files = [
    ...walk(path.join(repoRoot, "packages")),
    ...walk(path.join(repoRoot, "plugins")),
  ].sort();
  const paintedCssClasses = indexPaintedCssClasses(
    [
      ...walkStylesheets(path.join(repoRoot, "packages")),
      ...walkStylesheets(path.join(repoRoot, "plugins")),
    ]
      .sort()
      .map((file) => ({
        file: relative(file),
        source: fs.readFileSync(file, "utf8"),
      })),
  );
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
  const { definitions: cardDefinitions, defaults: cardDefaults } =
    extractCardVariantDefinitions({
      file: cardPath,
      source: fs.readFileSync(cardPath, "utf8"),
    });
  const cardUsages = [];
  const seenCanonicalRecipeContracts = new Set();
  for (const file of files) {
    if (relative(file).startsWith(`${canonicalRoot}/`)) {
      const tokenAudit = auditCanonicalTokenRoles({
        file,
        paintedCssClasses,
        source: fs.readFileSync(file, "utf8"),
      });
      findings.push(...tokenAudit.findings);
      for (const key of tokenAudit.seenContracts) {
        seenCanonicalRecipeContracts.add(key);
      }
    }
    findings.push(
      ...scanSourceText({
        adapterExports,
        adapterMatches,
        buttonDefaults,
        buttonUsages,
        cardDefaults,
        cardUsages,
        file,
        paintedCssClasses,
        registeredAdapters,
        source: fs.readFileSync(file, "utf8"),
      }),
    );
  }
  assertCanonicalRecipeContractsSeen(seenCanonicalRecipeContracts);
  assertRegisteredAdaptersUsed(adapters, adapterMatches, adapterExports);
  const buttonAxes = inventoryCanonicalAxes({
    definitions: buttonDefinitions,
    usages: buttonUsages,
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
  const cardVariants = inventoryCanonicalAxes({
    definitions: cardDefinitions,
    usages: cardUsages,
  });
  const publicCardVariantCompatibility = validatePublicCardVariantCompatibility(
    {
      cardSource: fs.readFileSync(cardPath, "utf8"),
      cardVariants,
      document: JSON.parse(fs.readFileSync(publicCardVariantsPath, "utf8")),
      now,
      publicBarrelSources: Object.fromEntries(
        publicCardBarrelPaths.map((file) => [
          relative(file),
          fs.readFileSync(file, "utf8"),
        ]),
      ),
      packageDocument: JSON.parse(fs.readFileSync(packagePath, "utf8")),
    },
  );
  const publicCompatibilityValues = new Set(
    publicCardVariantCompatibility.map((entry) => entry.value),
  );
  for (const entry of cardVariants) {
    if (
      entry.callerCount >= CARD_MIN_MAINTAINED_CALLERS ||
      publicCompatibilityValues.has(entry.value)
    )
      continue;
    findings.push(
      finding({
        rule: "card-variant-reuse",
        file: entry.file,
        line: entry.line,
        symbol: `${entry.axis}.${entry.value}`,
        detail: `Canonical Card variants require at least ${CARD_MIN_MAINTAINED_CALLERS} maintained callers; found ${entry.callerCount}. Domain-specific paint belongs to its molecule owner, while reusable surface concerns belong on generic Card axes.`,
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
    cardVariantMigration: buildCardVariantMigrationInventory(
      cardVariants.filter(
        (entry) => !publicCompatibilityValues.has(entry.value),
      ),
    ),
    cardVariants,
    canonicalRecipes: Object.entries(CANONICAL_RECIPE_CONTRACTS).map(
      ([owner, contract]) => ({
        owner,
        role: contract.role,
        axes: contract.axes,
      }),
    ),
    counts,
    findings: active,
    publicCardVariantCompatibility,
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
    "## Card variant inventory",
    "",
    "| Value | Maintained callers |",
    "| --- | ---: |",
  );
  for (const entry of report.cardVariants) {
    lines.push(`| \`${entry.value}\` | ${entry.callerCount} |`);
  }
  lines.push("");
  lines.push(
    "## Public Card variant compatibility",
    "",
    "| Value | Package exports | Public symbols | Maintained callers | Review by |",
    "| --- | --- | --- | ---: | --- |",
  );
  for (const entry of report.publicCardVariantCompatibility) {
    lines.push(
      `| \`${entry.value}\` | ${entry.packageExports.map((packageExport) => `\`${packageExport}\``).join(", ")} | ${entry.publicSymbols.map((symbol) => `\`${symbol}\``).join(", ")} | ${entry.callerCount} | ${entry.reviewBy} |`,
    );
  }
  lines.push("");
  lines.push(
    "## Underused Card variant ownership",
    "",
    "| Value | Caller | Domain | Reusable axes | Suggested owner |",
    "| --- | --- | --- | --- | --- |",
  );
  for (const entry of report.cardVariantMigration.entries) {
    const caller = entry.callers[0]
      ? `${entry.callers[0].file}:${entry.callers[0].line}`
      : "None";
    const axes = Object.entries(entry.suggestedAxes)
      .map(([axis, value]) => `${axis}=${value}`)
      .join(", ");
    lines.push(
      `| \`${entry.value}\` | \`${caller}\` | ${entry.domains.join(", ") || "unowned"} | ${axes || "None"} | ${entry.suggestedOwner} |`,
    );
  }
  lines.push("");
  lines.push(
    "## Canonical token-role inventory",
    "",
    "| Recipe helper | Base role | Axis roles |",
    "| --- | --- | --- |",
  );
  for (const recipe of report.canonicalRecipes) {
    lines.push(
      `| \`${recipe.owner}\` | \`${recipe.role}\` | ${Object.entries(
        recipe.axes,
      )
        .map(([axis, role]) => `\`${axis}:${role}\``)
        .join(", ")} |`,
    );
  }
  lines.push("");
  lines.push(
    "## Registered adapters",
    "",
    "| Owner | Exported symbol | Canonical primitive | Token role | Compositions |",
    "| --- | --- | --- | --- | ---: |",
  );
  for (const adapter of report.adapters) {
    lines.push(
      `| ${adapter.owner} | \`${adapter.symbol}\` | \`${adapter.primitive}\` | \`${adapter.role}\` | ${adapter.matchCount} |`,
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

#!/usr/bin/env node

/**
 * `translate-action-examples` — bulk-translation harness for ActionExamples.
 *
 * Wires the existing `MultilingualPromptRegistry` (W2-E,
 * `plugins/app-lifeops/src/lifeops/i18n/prompt-registry.ts`) into a CLI flow
 * that:
 *   1. Loads a TypeScript action file as text and extracts its
 *      `examples: ActionExample[][]` array via static AST parsing (no module
 *      load — the action graph would drag the whole runtime in).
 *   2. For each English example pair, calls Cerebras `gpt-oss-120b` with a
 *      strict translation prompt that returns JSON of the same shape.
 *   3. Emits a TypeScript source fragment registering the translations onto
 *      the registry, keyed `<actionName>.<index>:<locale>`.
 *
 * The harness is the proof-of-concept path. The Phase-3 sample translations
 * land as a generated `i18n/generated/<action>.<locale>.ts` file imported by
 * the registry's default-pack loader. The action's own `examples` field stays
 * English-canonical.
 *
 * Usage:
 *   bun plugins/app-lifeops/scripts/translate-action-examples.mjs \
 *       plugins/app-lifeops/src/actions/life.ts \
 *       --target-locale=es \
 *       --provider=cerebras \
 *       --max-examples=3 \
 *       --action-name=life \
 *       --output=plugins/app-lifeops/src/lifeops/i18n/generated/life.es.ts
 *
 * Environment:
 *   CEREBRAS_API_KEY — required when --provider=cerebras
 *   CEREBRAS_BASE_URL — defaults to https://api.cerebras.ai/v1
 *   CEREBRAS_MODEL — defaults to gpt-oss-120b
 *
 * Failure mode: bad LLM JSON, network errors, missing keys all throw and
 * exit non-zero. No silent fallback. The harness is loud by design.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { Project, SyntaxKind } from "ts-morph";

const SUPPORTED_LOCALES = new Set(["es", "fr", "ja"]);
const DEFAULT_MODEL = "gpt-oss-120b";
const DEFAULT_BASE_URL = "https://api.cerebras.ai/v1";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const elizaRoot = path.resolve(packageRoot, "..", "..");
const repoRoot = path.resolve(elizaRoot, "..");
for (const candidate of [
  path.join(packageRoot, ".env"),
  path.join(elizaRoot, ".env"),
  path.join(repoRoot, ".env"),
]) {
  if (fs.existsSync(candidate)) {
    dotenv.config({ path: candidate, override: false });
  }
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0) {
    fail(
      "Usage: translate-action-examples.mjs <action-file> --target-locale=<locale> [--provider=cerebras] [--max-examples=N] [--action-name=NAME] [--output=PATH] [--dry-run]",
    );
  }
  const result = {
    file: args[0],
    targetLocales: [],
    provider: "cerebras",
    maxExamples: Number.POSITIVE_INFINITY,
    actionName: null,
    outputPath: null,
    dryRun: false,
  };
  for (const arg of args.slice(1)) {
    if (arg === "--dry-run") {
      result.dryRun = true;
    } else if (arg.startsWith("--target-locale=")) {
      result.targetLocales = arg
        .slice("--target-locale=".length)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (arg.startsWith("--provider=")) {
      result.provider = arg.slice("--provider=".length);
    } else if (arg.startsWith("--max-examples=")) {
      result.maxExamples = Number(arg.slice("--max-examples=".length));
    } else if (arg.startsWith("--action-name=")) {
      result.actionName = arg.slice("--action-name=".length);
    } else if (arg.startsWith("--output=")) {
      result.outputPath = arg.slice("--output=".length);
    } else {
      fail(`Unknown arg: ${arg}`);
    }
  }
  if (result.targetLocales.length === 0) {
    fail("--target-locale=<locale> is required (e.g. --target-locale=es)");
  }
  for (const locale of result.targetLocales) {
    if (!SUPPORTED_LOCALES.has(locale)) {
      fail(
        `Locale "${locale}" not supported. Supported: ${[...SUPPORTED_LOCALES].join(", ")}`,
      );
    }
  }
  if (result.provider !== "cerebras") {
    fail(`Provider "${result.provider}" not supported. Supported: cerebras`);
  }
  if (!Number.isFinite(result.maxExamples) || result.maxExamples <= 0) {
    if (result.maxExamples !== Number.POSITIVE_INFINITY) {
      fail("--max-examples must be a positive integer");
    }
  }
  return result;
}

function fail(msg) {
  console.error(`[translate-action-examples] ${msg}`);
  process.exit(1);
}

/**
 * Extract the action `name` literal and the `examples` array from a TS file.
 * We use ts-morph to walk the AST so we don't have to evaluate the module
 * (action files import the entire runtime; loading them in a pure-Node script
 * is not feasible).
 *
 * Resolution strategies (each tried in order on the `examples:` initializer):
 *
 *   1. **Inline array literal.** `examples: [[user, agent], ...]` — read
 *      directly off the initializer. Fast path.
 *   2. **`as ActionExample[][]` cast.** Same shape wrapped in an
 *      `AsExpression`; we unwrap and re-classify the inner expression.
 *   3. **Identifier reference.** `examples: SOMETHING_EXAMPLES` —
 *      `getDefinitionNodes()` resolves the identifier (in-file or
 *      cross-file via re-exports/imports) to its `VariableDeclaration`
 *      initializer, which is then re-classified.
 *   4. **Spread + concatenation.** `examples: [...A_EXAMPLES,
 *      ...someAction.examples ?? [], inlinePair]` — each child is resolved
 *      independently via the same strategies and the resulting pair-array
 *      nodes are concatenated. `??` short-circuits: we recurse on the
 *      left-hand side.
 *   5. **Property access.** `someAction.examples` — resolve `someAction` to
 *      its declaration, find its inner `examples` property, recurse.
 *
 * Resolution always returns AST `ArrayLiteralExpression` nodes so the
 * existing pair parser (`parseExamplePair`) keeps working unchanged. If a
 * step cannot resolve to a concrete array, the harness fails loud with the
 * exact source location it stalled on (CLAUDE.md no-silent-fallback rule).
 */
function extractFromActionFile(filePath, actionNameOverride) {
  // Use the package's tsconfig so cross-file Identifier resolution works
  // (`getDefinitionNodes()` needs the target source file in the project, and
  // resolving `import { X } from "./Y"` requires the compiler to know the
  // module-resolution root).
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      allowJs: false,
      // baseUrl + module/target picked to match the action source files; we
      // only need symbol/identifier resolution, not emit.
      target: 99, // ESNext
      module: 99, // ESNext
      moduleResolution: 2, // NodeJs / Node10
      allowImportingTsExtensions: true,
      noEmit: true,
    },
  });
  const sourceFile = project.addSourceFileAtPath(filePath);

  // Locate the action's `examples:` property assignment + capture the
  // surrounding object literal (so we can read the `name` field from the
  // SAME literal — avoids matching a parameter schema's `name`/`examples`).
  const found = locateExamplesPropertyAssignment(sourceFile);

  // If we still haven't located a property assignment, fall back to a
  // top-level `const examples = [...]` (the legacy strategy 1 shape — used by
  // ~20 app-lifeops actions where `examples` is hoisted above the `Action`
  // literal).
  let examplesInitializer = found?.initializer ?? null;
  const actionLiteral = found?.actionLiteral ?? null;
  if (!examplesInitializer) {
    for (const stmt of sourceFile.getVariableStatements()) {
      for (const decl of stmt.getDeclarations()) {
        if (decl.getName() === "examples") {
          const init = decl.getInitializer();
          if (init) {
            examplesInitializer = init;
            break;
          }
        }
      }
      if (examplesInitializer) break;
    }
  }

  if (!examplesInitializer) {
    fail(`Could not locate an 'examples' property in ${filePath}`);
  }

  // Resolve the initializer to a flat list of pair-array AST nodes,
  // following Identifiers, spread elements, ??-fallbacks, and PropertyAccess
  // chains. The resolver throws via `fail()` on anything it can't reduce to
  // a concrete array literal — the harness has no silent fallback.
  const pairArrayNodes = resolveToPairArrayNodes(
    examplesInitializer,
    project,
    sourceFile,
    new Set(),
  );

  // Extract action name from the SAME object literal as the examples
  // property. Fall back to scanning sibling Action literals only if needed.
  // Accept either a string literal or an Identifier (e.g. `name: ACTION_NAME`)
  // — the latter is resolved via the same identifier-resolution path used
  // for examples.
  let actionName = actionNameOverride;
  if (!actionName && actionLiteral) {
    for (const prop of actionLiteral.getProperties()) {
      if (prop.getKind() !== SyntaxKind.PropertyAssignment) continue;
      const nameNode = prop.getNameNode?.();
      if (!nameNode || nameNode.getText() !== "name") continue;
      const init = prop.getInitializer?.();
      if (!init) continue;
      const resolved = resolveStringValue(init, project);
      if (resolved !== null) {
        actionName = resolved;
        break;
      }
    }
  }
  if (!actionName) {
    // Top-level `examples` const + separate Action literal in the same file.
    sourceFile.forEachDescendant((node) => {
      if (actionName) return;
      if (node.getKind() !== SyntaxKind.ObjectLiteralExpression) return;
      const obj = node;
      let candidateName = null;
      let looksLikeAction = false;
      for (const prop of obj.getProperties()) {
        if (prop.getKind() !== SyntaxKind.PropertyAssignment) continue;
        const propNameNode = prop.getNameNode?.();
        const propName = propNameNode?.getText();
        const init = prop.getInitializer?.();
        if (propName === "name" && init) {
          const resolved = resolveStringValue(init, project);
          if (resolved !== null) candidateName = resolved;
        }
        if (propName === "validate" || propName === "handler") {
          looksLikeAction = true;
        }
      }
      if (looksLikeAction && candidateName) {
        actionName = candidateName;
      }
    });
  }
  if (!actionName) {
    fail(
      `Could not locate action name in ${filePath}; pass --action-name=NAME explicitly`,
    );
  }

  const pairs = [];
  for (let i = 0; i < pairArrayNodes.length; i++) {
    const element = pairArrayNodes[i];
    const pair = parseExamplePair(element, i, filePath);
    if (pair) {
      pairs.push({ ...pair, index: i });
    }
  }

  return { actionName, pairs };
}

/**
 * Find the `examples:` property assignment that belongs to an Action object
 * literal (not a parameter schema). The disambiguation rule mirrors the
 * legacy strategy 2 logic: when the initializer is an inline array literal
 * we require the outer array's first element to itself be an array literal
 * (`[user, agent]` pair shape). For non-array initializers (Identifier,
 * SpreadCall, PropertyAccess) we trust the assignment — those shapes
 * trivially can't be a parameter `examples: string[]` schema list because
 * parameter schemas never reference cross-file identifiers in this
 * codebase.
 */
function locateExamplesPropertyAssignment(sourceFile) {
  let result = null;
  sourceFile.forEachDescendant((node) => {
    if (result) return;
    if (node.getKind() !== SyntaxKind.PropertyAssignment) return;
    const prop = node;
    const nameNode = prop.getNameNode?.();
    if (!nameNode || nameNode.getText() !== "examples") return;
    const init = prop.getInitializer?.();
    if (!init) return;

    const initKind = init.getKind();
    if (initKind === SyntaxKind.ArrayLiteralExpression) {
      // Disambiguate from a parameter schema's `examples: ["a", "b"]` list.
      const elements = init.getElements();
      const looksLikePairArray =
        elements.length === 0 ||
        elements.some(
          (el) =>
            el.getKind() === SyntaxKind.ArrayLiteralExpression ||
            el.getKind() === SyntaxKind.SpreadElement,
        );
      if (!looksLikePairArray) return;
    } else if (initKind === SyntaxKind.AsExpression) {
      const inner = init.getExpression?.();
      const innerKind = inner?.getKind?.();
      if (
        innerKind !== SyntaxKind.ArrayLiteralExpression &&
        innerKind !== SyntaxKind.Identifier &&
        innerKind !== SyntaxKind.PropertyAccessExpression
      ) {
        return;
      }
    } else if (
      initKind !== SyntaxKind.Identifier &&
      initKind !== SyntaxKind.PropertyAccessExpression
    ) {
      return;
    }

    result = {
      initializer: init,
      actionLiteral: prop.getParentIfKind?.(SyntaxKind.ObjectLiteralExpression),
    };
  });
  return result;
}

/**
 * Recursive resolver: takes any node that should evaluate to
 * `ActionExample[][]` and returns the flat list of pair-array
 * `ArrayLiteralExpression` nodes that compose it.
 *
 * The `seen` set tracks identifier full-text-with-source-file pairs to
 * prevent infinite recursion on cyclic re-exports. `project` is used to
 * lazily add cross-file source files for `getDefinitionNodes()` to follow
 * imports.
 */
function resolveToPairArrayNodes(node, project, originSource, seen) {
  if (!node) {
    fail(`resolveToPairArrayNodes: null node`);
  }
  const kind = node.getKind();
  const debugLoc = formatNodeLocation(node);

  switch (kind) {
    case SyntaxKind.ArrayLiteralExpression: {
      const out = [];
      for (const element of node.getElements()) {
        if (element.getKind() === SyntaxKind.ArrayLiteralExpression) {
          out.push(element);
          continue;
        }
        if (element.getKind() === SyntaxKind.SpreadElement) {
          const spreadInner = element.getExpression?.();
          if (!spreadInner) {
            fail(`Spread element with no inner expression at ${debugLoc}`);
          }
          for (const resolved of resolveToPairArrayNodes(
            spreadInner,
            project,
            originSource,
            seen,
          )) {
            out.push(resolved);
          }
          continue;
        }
        // Skip computed-call placeholders the harness can't safely
        // translate (e.g. `...getDefaultPromptExamplePair("...", "es")`).
        // These were already silently dropped by the legacy extractor.
        // We log so unexpected shapes are visible.
        console.warn(
          `[translate-action-examples] skipping non-literal example element (kind=${kind}) at ${formatNodeLocation(element)}`,
        );
      }
      return out;
    }

    case SyntaxKind.AsExpression: {
      const inner = node.getExpression?.();
      if (!inner) {
        fail(`AsExpression with no inner expression at ${debugLoc}`);
      }
      return resolveToPairArrayNodes(inner, project, originSource, seen);
    }

    case SyntaxKind.ParenthesizedExpression: {
      const inner = node.getExpression?.();
      if (!inner) {
        fail(`ParenthesizedExpression with no inner at ${debugLoc}`);
      }
      return resolveToPairArrayNodes(inner, project, originSource, seen);
    }

    case SyntaxKind.BinaryExpression: {
      // Handle `<expr> ?? []` and `<expr> ?? <expr>`.
      const opToken = node.getOperatorToken?.();
      const opKind = opToken?.getKind?.();
      if (opKind !== SyntaxKind.QuestionQuestionToken) {
        fail(
          `Unsupported BinaryExpression (operator kind=${opKind}) at ${debugLoc}`,
        );
      }
      const left = node.getLeft?.();
      const right = node.getRight?.();
      const leftResolved = resolveToPairArrayNodes(
        left,
        project,
        originSource,
        seen,
      );
      // If the left side already resolved to pair arrays the right side is
      // unreachable when the left is non-nullish; we still merge in case the
      // left has only spread-fallbacks.
      if (leftResolved.length > 0) return leftResolved;
      return resolveToPairArrayNodes(right, project, originSource, seen);
    }

    case SyntaxKind.Identifier: {
      const name = node.getText?.() ?? "";
      const sourceFilePath = node.getSourceFile?.()?.getFilePath?.() ?? "";
      const seenKey = `${sourceFilePath}::${name}`;
      if (seen.has(seenKey)) {
        fail(
          `Identifier resolution cycle: ${name} at ${debugLoc} already visited`,
        );
      }
      seen.add(seenKey);
      const declInit = resolveIdentifierToInitializer(node, project);
      if (!declInit) {
        fail(
          `Could not resolve identifier "${name}" to a VariableDeclaration initializer at ${debugLoc}`,
        );
      }
      return resolveToPairArrayNodes(declInit, project, originSource, seen);
    }

    case SyntaxKind.PropertyAccessExpression: {
      // e.g. `someAction.examples` or `someAction?.examples`. Resolve the
      // base expression to its declaration, then look up the named property
      // on that declaration's initializer.
      const propName = node.getName?.();
      const expression = node.getExpression?.();
      if (!propName || !expression) {
        fail(`PropertyAccessExpression with no name/expression at ${debugLoc}`);
      }
      const baseInit = resolveExpressionToInitializer(expression, project);
      if (!baseInit) {
        fail(
          `Could not resolve base of "${node.getText()}" to an initializer at ${debugLoc}`,
        );
      }
      // Walk into ObjectLiteralExpression to find the named property.
      const propInit = findObjectLiteralProperty(baseInit, propName);
      if (!propInit) {
        fail(
          `Could not locate "${propName}" property on resolved base of "${node.getText()}" at ${debugLoc}`,
        );
      }
      return resolveToPairArrayNodes(propInit, project, originSource, seen);
    }

    default:
      fail(
        `Unsupported initializer kind=${kind} (${node.getKindName?.() ?? "?"}) at ${debugLoc}`,
      );
      return []; // unreachable
  }
}

/**
 * Find the `<propName>` PropertyAssignment initializer on an
 * ObjectLiteralExpression. Strips trivial wrappers (AsExpression,
 * Parenthesized) so e.g. `{ examples: [...] as ActionExample[][] }` works.
 */
function findObjectLiteralProperty(node, propName) {
  let current = node;
  while (current) {
    const kind = current.getKind?.();
    if (kind === SyntaxKind.AsExpression) {
      current = current.getExpression?.();
      continue;
    }
    if (kind === SyntaxKind.ParenthesizedExpression) {
      current = current.getExpression?.();
      continue;
    }
    if (kind !== SyntaxKind.ObjectLiteralExpression) return null;
    for (const prop of current.getProperties()) {
      if (prop.getKind() !== SyntaxKind.PropertyAssignment) continue;
      const nameNode = prop.getNameNode?.();
      if (nameNode?.getText() !== propName) continue;
      return prop.getInitializer?.() ?? null;
    }
    return null;
  }
  return null;
}

/**
 * Resolve an Identifier to its VariableDeclaration's initializer, following
 * imports across files. Returns null if the identifier resolves to
 * something other than a `const X = <expr>` declaration (e.g. a function
 * parameter, a class member).
 */
function resolveIdentifierToInitializer(identifier, project) {
  const defs = identifier.getDefinitionNodes?.() ?? [];
  for (const def of defs) {
    const target = unwrapToVariableInitializer(def, project);
    if (target) return target;
  }
  return null;
}

/**
 * Resolve an arbitrary expression (Identifier, PropertyAccess, or any of
 * those wrapped in `as`/parens) to a VariableDeclaration initializer.
 */
function resolveExpressionToInitializer(expression, project) {
  const kind = expression.getKind?.();
  if (
    kind === SyntaxKind.AsExpression ||
    kind === SyntaxKind.ParenthesizedExpression
  ) {
    const inner = expression.getExpression?.();
    if (!inner) return null;
    return resolveExpressionToInitializer(inner, project);
  }
  if (kind === SyntaxKind.Identifier) {
    return resolveIdentifierToInitializer(expression, project);
  }
  if (kind === SyntaxKind.PropertyAccessExpression) {
    // `a.b.c` → resolve `a.b` first, then look up `.c`.
    const base = expression.getExpression?.();
    const propName = expression.getName?.();
    if (!base || !propName) return null;
    const baseInit = resolveExpressionToInitializer(base, project);
    if (!baseInit) return null;
    return findObjectLiteralProperty(baseInit, propName);
  }
  return null;
}

/**
 * Given a definition node from `getDefinitionNodes()` (typically a
 * VariableDeclaration, ImportSpecifier, or ExportSpecifier), unwrap it to
 * the underlying VariableDeclaration's initializer expression. Lazily adds
 * cross-file source files to the project so symbol resolution can follow
 * imports.
 */
function unwrapToVariableInitializer(node, _project) {
  let current = node;
  for (let hops = 0; hops < 5 && current; hops++) {
    const kind = current.getKind?.();
    if (kind === SyntaxKind.VariableDeclaration) {
      const init = current.getInitializer?.();
      return init ?? null;
    }
    if (
      kind === SyntaxKind.ImportSpecifier ||
      kind === SyntaxKind.ImportClause ||
      kind === SyntaxKind.NamespaceImport
    ) {
      // Resolve the import's module specifier and follow to the named
      // export's declaration.
      const importDecl = current.getFirstAncestorByKind?.(
        SyntaxKind.ImportDeclaration,
      );
      if (!importDecl) return null;
      const moduleSourceFile = importDecl.getModuleSpecifierSourceFile?.();
      if (!moduleSourceFile) return null;
      const importedName =
        kind === SyntaxKind.ImportSpecifier
          ? (current.getNameNode?.()?.getText?.() ?? null)
          : null;
      if (!importedName) return null;
      // The exported VariableDeclaration in the target source file.
      const targetDecl = moduleSourceFile
        .getVariableDeclarations?.()
        ?.find((d) => d.getName?.() === importedName);
      if (targetDecl) {
        return targetDecl.getInitializer?.() ?? null;
      }
      return null;
    }
    if (kind === SyntaxKind.ExportSpecifier) {
      // Re-export. Walk to the underlying local declaration.
      const localTarget = current.getLocalTargetSymbol?.();
      const decls = localTarget?.getDeclarations?.() ?? [];
      if (decls.length === 0) return null;
      current = decls[0];
      continue;
    }
    if (kind === SyntaxKind.Identifier) {
      // Some definition results are bare identifiers — climb to parent
      // VariableDeclaration.
      const parent = current.getParent?.();
      if (parent?.getKind?.() === SyntaxKind.VariableDeclaration) {
        return parent.getInitializer?.() ?? null;
      }
      return null;
    }
    return null;
  }
  return null;
}

/**
 * Resolve an expression to its underlying string literal value. Handles
 * `"FOO"`, `Identifier`-referencing-a-string-const, `as`-wrappers, and
 * parenthesized variants. Returns null if the expression doesn't reduce
 * to a literal string.
 */
function resolveStringValue(node, project) {
  if (!node) return null;
  const kind = node.getKind?.();
  if (kind === SyntaxKind.StringLiteral) {
    return node.getLiteralValue?.() ?? null;
  }
  if (kind === SyntaxKind.NoSubstitutionTemplateLiteral) {
    return node.getLiteralValue?.() ?? null;
  }
  if (
    kind === SyntaxKind.AsExpression ||
    kind === SyntaxKind.ParenthesizedExpression
  ) {
    return resolveStringValue(node.getExpression?.(), project);
  }
  if (kind === SyntaxKind.Identifier) {
    const init = resolveIdentifierToInitializer(node, project);
    if (!init) return null;
    return resolveStringValue(init, project);
  }
  if (kind === SyntaxKind.PropertyAccessExpression) {
    const init = resolveExpressionToInitializer(node, project);
    if (!init) return null;
    return resolveStringValue(init, project);
  }
  return null;
}

/**
 * Best-effort source location for diagnostics. Format:
 * `<relative-path>:<line>:<col>`.
 */
function formatNodeLocation(node) {
  try {
    const sf = node.getSourceFile?.();
    const filePath = sf?.getFilePath?.() ?? "<unknown>";
    const start = node.getStart?.() ?? 0;
    const lineAndCol = sf?.getLineAndColumnAtPos?.(start);
    const line = lineAndCol?.line ?? 0;
    const col = lineAndCol?.column ?? 0;
    const rel = path.relative(process.cwd(), filePath);
    return `${rel}:${line}:${col}`;
  } catch {
    return "<unknown>";
  }
}

/**
 * Parse one `[user, agent]` example pair into a plain JS object. We accept
 * only the two-element shape with `name` + `content.text` (+ optional
 * `actions` / `action`). Anything more exotic (spreads, computed keys) is
 * skipped so the harness can't accidentally translate something unsafe.
 */
function parseExamplePair(arrayLiteral, index, filePath) {
  const elements = arrayLiteral.getElements();
  if (elements.length < 2) return null;

  const turns = [];
  for (let t = 0; t < Math.min(2, elements.length); t++) {
    const turn = elements[t];
    if (turn.getKind() !== SyntaxKind.ObjectLiteralExpression) return null;
    const props = turn.getProperties();
    let name = null;
    let text = null;
    let actions = null;
    let action = null;
    for (const prop of props) {
      if (prop.getKind() !== SyntaxKind.PropertyAssignment) continue;
      const nameNode = prop.getNameNode?.();
      const propName = nameNode?.getText();
      const init = prop.getInitializer?.();
      if (!init) continue;
      if (propName === "name" && init.getKind() === SyntaxKind.StringLiteral) {
        name = init.getLiteralValue();
      } else if (
        propName === "content" &&
        init.getKind() === SyntaxKind.ObjectLiteralExpression
      ) {
        for (const cprop of init.getProperties()) {
          if (cprop.getKind() !== SyntaxKind.PropertyAssignment) continue;
          const cname = cprop.getNameNode?.()?.getText();
          const cinit = cprop.getInitializer?.();
          if (!cinit) continue;
          if (cname === "text") {
            if (
              cinit.getKind() === SyntaxKind.StringLiteral ||
              cinit.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral
            ) {
              text = cinit.getLiteralValue();
            }
          } else if (
            cname === "actions" &&
            cinit.getKind() === SyntaxKind.ArrayLiteralExpression
          ) {
            actions = cinit
              .getElements()
              .filter((e) => e.getKind() === SyntaxKind.StringLiteral)
              .map((e) => e.getLiteralValue());
          } else if (
            cname === "action" &&
            cinit.getKind() === SyntaxKind.StringLiteral
          ) {
            action = cinit.getLiteralValue();
          }
        }
      }
    }
    if (!name || text == null) {
      console.warn(
        `[translate-action-examples] skipping pair #${index} in ${path.basename(
          filePath,
        )}: missing name or text`,
      );
      return null;
    }
    turns.push({ name, content: { text, actions, action } });
  }

  return { user: turns[0], agent: turns[1] };
}

/**
 * Build the strict translation prompt. The model returns one JSON object
 * with `userText` + `agentText`. We deliberately do NOT ask it to translate
 * speaker names, action tokens, or `{{name1}}`/`{{agentName}}` placeholders.
 */
function buildTranslationPrompt(pair, locale) {
  const localeName = {
    es: "Spanish (es)",
    fr: "French (fr)",
    ja: "Japanese (ja)",
  }[locale];
  return [
    `You translate an ActionExample dialog pair from English into ${localeName}.`,
    "",
    "Rules:",
    "- Translate ONLY the user message text and the agent reply text.",
    "- DO NOT translate or alter speaker placeholders like {{name1}} or {{agentName}}.",
    "- DO NOT translate action tokens (e.g. LIFE, MESSAGE_HANDOFF, SCHEDULED_TASK).",
    "- Preserve tone, terseness, and confirm/preview semantics if present.",
    "- DO NOT introduce PII (names, phones, emails) that wasn't in the input.",
    "- Numbers, times (8 am / 9 pm), monetary amounts, and quoted titles stay as-is unless idiomatic in the target locale.",
    '- Output ONLY a JSON object: {"userText": "...", "agentText": "..."} — no prose, no fences.',
    "",
    "Source pair:",
    JSON.stringify(
      { userText: pair.user.content.text, agentText: pair.agent.content.text },
      null,
      2,
    ),
  ].join("\n");
}

async function callCerebras(prompt) {
  const apiKey = process.env.CEREBRAS_API_KEY;
  if (!apiKey) {
    fail("CEREBRAS_API_KEY is not set");
  }
  const baseUrl = process.env.CEREBRAS_BASE_URL ?? DEFAULT_BASE_URL;
  const model = process.env.CEREBRAS_MODEL ?? DEFAULT_MODEL;
  const body = {
    model,
    messages: [
      {
        role: "system",
        content:
          "You are a careful translator. Output JSON only. Never add commentary.",
      },
      { role: "user", content: prompt },
    ],
    temperature: 0,
    max_tokens: 1024,
  };
  if (model.startsWith("gpt-oss")) {
    body.reasoning_effort = "low";
  }
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(
      `cerebras error ${response.status}: ${errBody.slice(0, 300)}`,
    );
  }
  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content ?? "";
  if (!text) {
    throw new Error("cerebras returned empty content");
  }
  return text;
}

function parseTranslationJson(raw) {
  // Tolerate a leading ```json fence purely on the off-chance the model
  // ignores instructions; throw on anything else (no silent fallback).
  let body = raw.trim();
  if (body.startsWith("```")) {
    const firstNewline = body.indexOf("\n");
    body = body.slice(firstNewline + 1);
    const lastFence = body.lastIndexOf("```");
    if (lastFence >= 0) body = body.slice(0, lastFence);
    body = body.trim();
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    throw new Error(
      `Could not parse translation JSON: ${err instanceof Error ? err.message : String(err)}\nRaw: ${raw.slice(0, 400)}`,
    );
  }
  if (
    typeof parsed?.userText !== "string" ||
    typeof parsed?.agentText !== "string" ||
    parsed.userText.length === 0 ||
    parsed.agentText.length === 0
  ) {
    throw new Error(
      `Translation JSON missing userText/agentText:\n${JSON.stringify(parsed)}`,
    );
  }
  return parsed;
}

/**
 * Render the final TypeScript file: a self-registering pack that calls
 * `registry.register(...)` for each translated pair, keyed
 * `<actionName>.example.<index>:<locale>` so the registry composite key is
 * unique. Action authors then call
 * `getDefaultPromptExamplePair("<actionName>.example.<index>", "es")` to
 * pull the pair into their `examples` array (mirrors the W2-E pattern).
 */
function renderRegistryPack({ actionName, locale, translations }) {
  const lines = [];
  lines.push(
    "// AUTOGENERATED by plugins/app-lifeops/scripts/translate-action-examples.mjs",
  );
  lines.push("// Do not edit by hand. Re-run the harness to regenerate.");
  lines.push(`// action: ${actionName}`);
  lines.push(`// locale: ${locale}`);
  lines.push("");
  lines.push(
    'import type { PromptExampleEntry } from "../prompt-registry.js";',
  );
  lines.push("");
  lines.push(
    `export const ${packVarName(actionName, locale)}: ReadonlyArray<PromptExampleEntry> = [`,
  );
  for (const t of translations) {
    const key = `${actionName}.example.${t.index}`;
    const userActions = t.userActions ? actionsLiteral(t.userActions) : "";
    const userAction = t.userAction
      ? `, action: ${jsonString(t.userAction)}`
      : "";
    const agentActions = t.agentActions ? actionsLiteral(t.agentActions) : "";
    const agentAction = t.agentAction
      ? `, action: ${jsonString(t.agentAction)}`
      : "";
    lines.push("  {");
    lines.push(`    exampleKey: ${jsonString(key)},`);
    lines.push(`    locale: ${jsonString(locale)},`);
    lines.push(`    user: {`);
    lines.push(`      name: ${jsonString(t.userName)},`);
    lines.push(
      `      content: { text: ${jsonString(t.userText)}${userActions}${userAction} },`,
    );
    lines.push(`    },`);
    lines.push(`    agent: {`);
    lines.push(`      name: ${jsonString(t.agentName)},`);
    lines.push(
      `      content: { text: ${jsonString(t.agentText)}${agentActions}${agentAction} },`,
    );
    lines.push(`    },`);
    lines.push("  },");
  }
  lines.push("];");
  lines.push("");
  return lines.join("\n");
}

function packVarName(actionName, locale) {
  const safe = actionName.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return `${safe}_${locale}_examples`;
}

function jsonString(value) {
  return JSON.stringify(value);
}

function actionsLiteral(arr) {
  return `, actions: [${arr.map(jsonString).join(", ")}]`;
}

async function main() {
  const opts = parseArgs(process.argv);
  const absInput = path.isAbsolute(opts.file)
    ? opts.file
    : path.resolve(process.cwd(), opts.file);
  if (!fs.existsSync(absInput)) {
    fail(`Action file not found: ${absInput}`);
  }
  const { actionName, pairs } = extractFromActionFile(
    absInput,
    opts.actionName,
  );
  const cap = Math.min(opts.maxExamples, pairs.length);
  const subset = pairs.slice(0, cap);

  console.info(
    `[translate-action-examples] action="${actionName}" file="${path.relative(
      process.cwd(),
      absInput,
    )}" pairs=${pairs.length} translating=${subset.length} locales=${opts.targetLocales.join(",")}`,
  );

  const summary = { calls: 0, written: [] };

  for (const locale of opts.targetLocales) {
    const translations = [];
    for (const pair of subset) {
      const prompt = buildTranslationPrompt(pair, locale);
      let raw;
      if (opts.dryRun) {
        raw = JSON.stringify({
          userText: `[dry-run:${locale}] ${pair.user.content.text}`,
          agentText: `[dry-run:${locale}] ${pair.agent.content.text}`,
        });
      } else {
        raw = await callCerebras(prompt);
        summary.calls += 1;
      }
      const { userText, agentText } = parseTranslationJson(raw);
      translations.push({
        index: pair.index,
        userName: pair.user.name,
        userText,
        userActions: pair.user.content.actions ?? null,
        userAction: pair.user.content.action ?? null,
        agentName: pair.agent.name,
        agentText,
        agentActions: pair.agent.content.actions ?? null,
        agentAction: pair.agent.content.action ?? null,
      });
      console.info(
        `[translate-action-examples]   pair[${pair.index}] -> ${locale}: ${userText.slice(0, 60)}...`,
      );
    }

    const rendered = renderRegistryPack({ actionName, locale, translations });

    if (opts.outputPath) {
      const outPath = path.isAbsolute(opts.outputPath)
        ? opts.outputPath
        : path.resolve(process.cwd(), opts.outputPath);
      // When multiple locales are passed, splice locale into filename.
      const finalPath =
        opts.targetLocales.length === 1
          ? outPath
          : outPath.replace(/(\.[a-z]+)$/, `.${locale}$1`);
      fs.mkdirSync(path.dirname(finalPath), { recursive: true });
      fs.writeFileSync(finalPath, rendered, "utf8");
      summary.written.push(finalPath);
      console.info(
        `[translate-action-examples]   wrote ${path.relative(process.cwd(), finalPath)}`,
      );
    } else {
      process.stdout.write(`\n// ===== ${locale} =====\n${rendered}\n`);
    }
  }

  console.info(
    `[translate-action-examples] done. cerebras_calls=${summary.calls} files_written=${summary.written.length}`,
  );
}

// Run as CLI when executed directly, but stay importable for tests.
const __isDirectInvocation =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (__isDirectInvocation) {
  await main();
}

export {
  extractFromActionFile,
  parseExamplePair,
  resolveStringValue,
  resolveToPairArrayNodes,
};

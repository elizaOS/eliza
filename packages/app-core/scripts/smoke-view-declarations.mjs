/**
 * Authoritative source of the plugin-view declarations the UI-smoke API stub
 * serves, plus the parity check that pins them to the plugins that actually
 * ship those views today.
 *
 * The smoke stub (`playwright-ui-smoke-api-stub.mjs`) answers `GET /api/views`
 * with these rows and serves each view's `/api/views/<id>/bundle.js`. If a row
 * survives here after its plugin is deleted, an audit renders a fabricated
 * surface for a view production no longer registers — proving nothing. So the
 * declarations live here next to `checkSmokeViewParity`, which fails the moment
 * a declared view's plugin directory is gone or no longer exports the named
 * component. Removed plugin IDs (Shopify, Steward, Social Alpha) are therefore
 * kept out and cannot silently reappear.
 *
 * `resolveBundleProvenance` is the single decision the stub uses when serving a
 * bundle: serve the real built `dist/views/bundle.js`, or — only outside audit
 * mode — a clearly-marked synthesized placeholder. In audit mode a missing real
 * bundle is a hard, observable failure, never a generic fabrication.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * One GUI declaration per shipped plugin view: `[id, label, pluginDirName,
 * path, componentExport, viewType?]`. Every entry must pass
 * `checkSmokeViewParity` — its plugin directory exists and its source both
 * declares the `id` and exports the `componentExport`. The stub derives surface
 * grants and layout from that production declaration, including imported literal
 * constants, so the fixture cannot silently drop shell ownership or capabilities.
 * Do NOT add a view here for a plugin that no longer exists.
 */
export const smokeViewDeclarations = [
  ["cloud", "Cloud", "plugin-elizacloud", "/cloud", "CloudView"],
  ["contacts", "Contacts", "plugin-contacts", "/contacts", "ContactsView"],
  // The decomposed personal-assistant domain views are the real surfaces (the
  // old monolithic `lifeops` overview view was removed). `documents` is
  // intentionally absent — its `/documents` path collides with the built-in
  // Knowledge tab (`App.tsx` findView matches `/${tab}`).
  ["calendar", "Calendar", "plugin-calendar", "/calendar", "CalendarView"],
  [
    "computer-use-sessions",
    "Computer Sessions",
    "plugin-computeruse",
    "/computer-use-sessions",
    "ComputerUseSessionsView",
  ],
  ["finances", "Finances", "plugin-finances", "/finances", "FinancesView"],
  ["focus", "Focus", "plugin-blocker", "/focus", "FocusView"],
  ["goals", "Goals", "plugin-goals", "/goals", "GoalsView"],
  ["health", "Health", "plugin-health", "/health", "HealthView"],
  ["inbox", "Inbox", "plugin-inbox", "/inbox", "InboxView"],
  ["todos", "Todos", "plugin-todos", "/todos", "TodosView"],
  [
    "relationships",
    "Relationships",
    "plugin-relationships",
    "/relationships",
    "RelationshipsView",
  ],
  ["messages", "Messages", "plugin-messages", "/messages", "MessagesView"],
  ["phone", "Phone", "plugin-phone", "/phone", "PhoneView"],
  ["wallet", "Wallet", "plugin-wallet", "/wallet", "InventoryView"],
  ["views-manager", "Views", "plugin-app-control", "/views", "ViewManagerView"],
  ["notes", "Notes", "plugin-notes", "/notes", "NotesView"],
  [
    "task-coordinator",
    "Task Coordinator",
    "plugin-task-coordinator",
    "/task-coordinator",
    "TaskCoordinatorView",
  ],
  [
    "orchestrator",
    "Orchestrator",
    "plugin-task-coordinator",
    "/orchestrator",
    "OrchestratorView",
  ],
  [
    "trajectory-logger",
    "Trajectory Logger",
    "plugin-trajectory-logger",
    "/trajectory-logger",
    "TrajectoryLoggerView",
  ],
];

/**
 * Normalize a declaration tuple to a named record. Kept internal so callers
 * consume `id` / `pluginDirName` / `componentExport` rather than tuple indices.
 */
function toDeclaration(tuple) {
  const [id, label, pluginDirName, viewPath, componentExport] = tuple;
  return { id, label, pluginDirName, viewPath, componentExport };
}

function readSourceFiles(dir) {
  const sources = [];
  const walk = (current) => {
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === "__tests__" ||
        /\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name)
      ) {
        continue;
      }
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) {
        sources.push({ filePath: full, source: readFileSync(full, "utf8") });
      }
    }
  };
  walk(dir);
  return sources;
}

function stringProperty(object, propertyName) {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = property.name;
    const key =
      ts.isIdentifier(name) || ts.isStringLiteralLike(name)
        ? name.text
        : undefined;
    if (key !== propertyName) continue;
    return ts.isStringLiteralLike(property.initializer)
      ? property.initializer.text
      : undefined;
  }
  return undefined;
}

function readSurfaceValue(node, sourceFile, files, resolving = new Set()) {
  const fail = () => {
    throw new Error(
      `[smoke-view-declarations] Cannot resolve surface expression in ${sourceFile.fileName}: ${node.getText(sourceFile)}. Use static literals or relative imports of exported const literals; executable expressions and spreads cannot define audit metadata.`,
    );
  };
  if (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node)
  ) {
    return readSurfaceValue(node.expression, sourceFile, files, resolving);
  }
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map((item) =>
      readSurfaceValue(item, sourceFile, files, resolving),
    );
  }
  if (ts.isObjectLiteralExpression(node)) {
    return Object.fromEntries(
      node.properties.map((property) => {
        if (
          !ts.isPropertyAssignment(property) ||
          !(
            ts.isIdentifier(property.name) ||
            ts.isStringLiteralLike(property.name)
          )
        )
          return fail();
        return [
          property.name.text,
          readSurfaceValue(property.initializer, sourceFile, files, resolving),
        ];
      }),
    );
  }
  if (ts.isIdentifier(node)) {
    const key = `${sourceFile.fileName}#${node.text}`;
    if (resolving.has(key)) return fail();
    const next = new Set([...resolving, key]);
    for (const statement of sourceFile.statements) {
      if (
        ts.isVariableStatement(statement) &&
        statement.declarationList.flags & ts.NodeFlags.Const
      ) {
        const declaration = statement.declarationList.declarations.find(
          (entry) =>
            ts.isIdentifier(entry.name) && entry.name.text === node.text,
        );
        if (declaration?.initializer) {
          return readSurfaceValue(
            declaration.initializer,
            sourceFile,
            files,
            next,
          );
        }
      }
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteralLike(statement.moduleSpecifier) ||
        !statement.moduleSpecifier.text.startsWith(".")
      )
        continue;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      const binding = bindings.elements.find(
        (entry) => entry.name.text === node.text,
      );
      if (!binding) continue;
      const importedPath = path.resolve(
        path.dirname(sourceFile.fileName),
        statement.moduleSpecifier.text,
      );
      const imported =
        files.get(importedPath) ??
        files.get(importedPath.replace(/\.js$/, ".ts")) ??
        files.get(importedPath.replace(/\.js$/, ".tsx"));
      if (!imported) return fail();
      const exportedName = binding.propertyName?.text ?? binding.name.text;
      for (const exported of imported.statements) {
        if (
          !ts.isVariableStatement(exported) ||
          !(exported.declarationList.flags & ts.NodeFlags.Const) ||
          !exported.modifiers?.some(
            (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
          )
        )
          continue;
        const declaration = exported.declarationList.declarations.find(
          (entry) =>
            ts.isIdentifier(entry.name) && entry.name.text === exportedName,
        );
        if (declaration?.initializer) {
          return readSurfaceValue(
            declaration.initializer,
            imported,
            files,
            next,
          );
        }
      }
      return fail();
    }
  }
  return fail();
}

function inspectViewDeclarations(
  sourceFiles,
  { id, viewPath, componentExport },
) {
  let declaresIdAndPath = false;
  let declaresExactView = false;
  let surface;
  const files = new Map(
    sourceFiles.map(({ filePath, source }) => [
      filePath,
      ts.createSourceFile(
        filePath,
        source,
        ts.ScriptTarget.Latest,
        true,
        filePath.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      ),
    ]),
  );
  for (const sourceFile of files.values()) {
    const visit = (node) => {
      if (ts.isObjectLiteralExpression(node)) {
        const objectId = stringProperty(node, "id");
        const objectPath = stringProperty(node, "path");
        if (objectId === id && objectPath === viewPath) {
          declaresIdAndPath = true;
          if (stringProperty(node, "componentExport") === componentExport) {
            declaresExactView = true;
            // Module-level const/import lookup is sound only outside lexical scopes
            // that can shadow those bindings. Nested declarations fail explicitly.
            for (
              let scope = node.parent;
              scope && !ts.isSourceFile(scope);
              scope = scope.parent
            ) {
              if (
                ts.isFunctionLike(scope) ||
                ts.isBlock(scope) ||
                ts.isModuleBlock(scope) ||
                ts.isClassDeclaration(scope) ||
                ts.isClassExpression(scope) ||
                ts.isCatchClause(scope) ||
                ts.isForStatement(scope) ||
                ts.isForInStatement(scope) ||
                ts.isForOfStatement(scope) ||
                ts.isWhileStatement(scope) ||
                ts.isDoStatement(scope)
              ) {
                throw new Error(
                  `[smoke-view-declarations] Cannot resolve nested view declaration ${id} in ${sourceFile.fileName}; expose its surface through a module-level declaration so lexical bindings cannot be mistaken for imported metadata.`,
                );
              }
            }
            for (const property of node.properties) {
              if (
                ts.isSpreadAssignment(property) ||
                (property.name && ts.isComputedPropertyName(property.name))
              ) {
                throw new Error(
                  `[smoke-view-declarations] Cannot resolve spread or computed view declaration ${id} in ${sourceFile.fileName}; declare its audit metadata explicitly.`,
                );
              }
              if (
                !(
                  ts.isIdentifier(property.name) ||
                  ts.isStringLiteralLike(property.name)
                ) ||
                property.name.text !== "surface"
              )
                continue;
              if (ts.isPropertyAssignment(property)) {
                surface = readSurfaceValue(
                  property.initializer,
                  sourceFile,
                  files,
                );
              } else if (ts.isShorthandPropertyAssignment(property)) {
                surface = readSurfaceValue(property.name, sourceFile, files);
              } else {
                throw new Error(
                  `[smoke-view-declarations] Cannot resolve executable surface property for ${id} in ${sourceFile.fileName}; use a static surface assignment.`,
                );
              }
            }
          }
        }
      }
      if (!declaresExactView) ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    if (declaresExactView) break;
  }
  return { declaresExactView, declaresIdAndPath, surface };
}

/**
 * Check every smoke view declaration against the plugin that must register it.
 * A declaration is in parity when the plugin directory exists and its source
 * both declares the view `id` and exports the named component. Returns the full
 * declaration list plus the misses so a test can assert the shipped set is
 * clean AND that a removed plugin id would be caught.
 */
export function checkSmokeViewParity(
  repoRoot,
  declarations = smokeViewDeclarations,
) {
  const pluginsDir = path.join(repoRoot, "plugins");
  const missing = [];
  const resolved = [];
  for (const tuple of declarations) {
    const { id, pluginDirName, componentExport, viewPath } =
      toDeclaration(tuple);
    const pluginDir = path.join(pluginsDir, pluginDirName);
    const dirExists =
      existsSync(pluginDir) && statSync(pluginDir).isDirectory();
    if (!dirExists) {
      missing.push({
        id,
        pluginDirName,
        componentExport,
        reason: "plugin-directory-missing",
      });
      continue;
    }
    const declaration = inspectViewDeclarations(
      readSourceFiles(path.join(pluginDir, "src")),
      { id, viewPath, componentExport },
    );
    if (declaration.declaresExactView) {
      resolved.push([
        ...tuple.slice(0, 5),
        tuple[5] ?? "gui",
        declaration.surface,
      ]);
    }
    if (!declaration.declaresExactView) {
      missing.push({
        id,
        pluginDirName,
        componentExport,
        reason: declaration.declaresIdAndPath
          ? "component-export-missing"
          : "view-id-not-declared",
      });
    }
  }
  return {
    declarations,
    resolvedDeclarations: resolved,
    missing,
    ok: missing.length === 0,
  };
}

/** Derives the smoke registry's shell ownership and capability grants from production source. */
export function resolveSmokeViewDeclarations(
  repoRoot,
  declarations = smokeViewDeclarations,
) {
  const result = checkSmokeViewParity(repoRoot, declarations);
  if (!result.ok) {
    throw new Error(
      `[smoke-view-declarations] Production view declarations are unavailable: ${JSON.stringify(result.missing)}`,
    );
  }
  return result.resolvedDeclarations;
}

/**
 * Provenance the smoke stub must attach when serving a plugin-view bundle. The
 * value flows out on the `X-Eliza-View-Bundle-Provenance` response header so an
 * audit can assert WHICH bundle rendered — the real built one or a marked
 * placeholder — and never mistake a fabricated surface for the production one.
 */
export const VIEW_BUNDLE_PROVENANCE_HEADER = "X-Eliza-View-Bundle-Provenance";

/**
 * Decide how the stub serves a view's bundle. In audit mode
 * (`requireRealBundle`) a missing real `dist/views/bundle.js` is a hard failure
 * (`status` 424, mode `missing-real-bundle`) — the stub must NOT fabricate a
 * generic bundle for a production-declared view. Outside audit mode a missing
 * bundle degrades to a clearly-marked synthesized placeholder so the offline
 * keyless smoke can still exercise routing, but the provenance says so.
 */
export function resolveBundleProvenance({
  viewId,
  realBundleExists,
  requireRealBundle,
}) {
  if (realBundleExists) {
    return { mode: "real-dist", status: 200, synthesized: false };
  }
  if (requireRealBundle) {
    return { mode: "missing-real-bundle", status: 424, synthesized: false };
  }
  const dedicated = new Set(["screenshare", "task-coordinator"]);
  return {
    mode: dedicated.has(viewId)
      ? `synthesized-${viewId}`
      : "synthesized-generic",
    status: 200,
    synthesized: true,
  };
}

/** True when `plugins/<pluginDirName>/dist/views/bundle.js` exists on disk. */
export function realViewBundleExists(repoRoot, pluginDirName) {
  return existsSync(
    path.join(repoRoot, "plugins", pluginDirName, "dist", "views", "bundle.js"),
  );
}

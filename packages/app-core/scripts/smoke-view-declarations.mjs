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
 * component. Navigation grants must also match in both directions; unrelated
 * surface grants are outside this check. Removed plugin IDs
 * (Shopify, Steward, Social Alpha) are therefore
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
 * path, componentExport, viewType?, surface?]`. Every entry must pass
 * `checkSmokeViewParity` — its plugin directory exists and its source both
 * declares the `id` and exports the `componentExport`. Surface grants are
 * explicit because omitting one makes the smoke registry less capable than the
 * production manifest and can turn a valid bridge action into a false denial.
 * Do NOT add a view here for a plugin that no longer exists.
 */
export const smokeViewDeclarations = [
  [
    "cloud",
    "Cloud",
    "plugin-elizacloud",
    "/cloud",
    "CloudView",
    "gui",
    { header: "fullscreen", capabilities: ["agent-surface", "navigate"] },
  ],
  ["contacts", "Contacts", "plugin-contacts", "/contacts", "ContactsView"],
  // The decomposed personal-assistant domain views are the real surfaces (the
  // old monolithic `lifeops` overview view was removed). `documents` is
  // intentionally absent — its `/documents` path collides with the built-in
  // Knowledge tab (`App.tsx` findView matches `/${tab}`).
  [
    "calendar",
    "Calendar",
    "plugin-calendar",
    "/calendar",
    "CalendarView",
    "gui",
    { header: "fullscreen", capabilities: ["agent-surface"] },
  ],
  [
    "computer-use-sessions",
    "Computer Sessions",
    "plugin-computeruse",
    "/computer-use-sessions",
    "ComputerUseSessionsView",
    "gui",
    { capabilities: ["agent-surface"] },
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
  [
    "wallet",
    "Wallet",
    "plugin-wallet",
    "/wallet",
    "InventoryView",
    "gui",
    {
      background: "shared",
      capabilities: ["agent-surface", "wallpaper"],
    },
  ],
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
    "gui",
    { capabilities: ["agent-surface"] },
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

function propertyInitializer(object, propertyName) {
  // The last matching property wins. A later spread can replace the policy.
  for (const property of [...object.properties].reverse()) {
    if (ts.isSpreadAssignment(property)) return null;
    const name = property.name;
    const key =
      name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name))
        ? name.text
        : undefined;
    if (key === undefined) return null;
    if (key !== propertyName) continue;
    return ts.isPropertyAssignment(property) ? property.initializer : null;
  }
  return undefined;
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

function literalExpression(node) {
  while (
    node &&
    (ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isParenthesizedExpression(node) ||
      ts.isTypeAssertionExpression(node))
  ) {
    node = node.expression;
  }
  return node;
}

function immutablePolicyInitializer(node) {
  if (ts.isStringLiteralLike(literalExpression(node))) return true;
  while (ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) {
    node = node.expression;
  }
  return (
    ts.isAsExpression(node) &&
    ts.isTypeReferenceNode(node.type) &&
    ts.isIdentifier(node.type.typeName) &&
    node.type.typeName.text === "const"
  );
}

function isModulePolicyReference(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (
      ts.isFunctionLike(parent) ||
      ts.isBlock(parent) ||
      ts.isModuleBlock(parent) ||
      ts.isClassLike(parent) ||
      ts.isCaseBlock(parent) ||
      ts.isForStatement(parent) ||
      ts.isForInStatement(parent) ||
      ts.isForOfStatement(parent)
    )
      return false;
  }
  return true;
}

function hasUnsupportedPolicyUse(sourceFile, name) {
  let unsupported = false;
  const visit = (node) => {
    if (ts.isIdentifier(node) && node.text === name) {
      let reference = node;
      while (
        reference.parent &&
        (ts.isAsExpression(reference.parent) ||
          ts.isSatisfiesExpression(reference.parent) ||
          ts.isTypeAssertionExpression(reference.parent) ||
          ts.isParenthesizedExpression(reference.parent))
      )
        reference = reference.parent;
      const parent = reference.parent;
      if (
        parent &&
        (((ts.isPropertyAccessExpression(parent) ||
          ts.isElementAccessExpression(parent)) &&
          parent.expression === reference) ||
          ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
            parent.arguments?.includes(reference)) ||
          (ts.isBinaryExpression(parent) && parent.left === reference) ||
          ts.isDeleteExpression(parent) ||
          ts.isPostfixUnaryExpression(parent) ||
          ts.isPrefixUnaryExpression(parent))
      )
        unsupported = true;
    }
    if (!unsupported) ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return unsupported;
}

function resolvePolicyExpression(node, sources, resolving = new Set()) {
  node = literalExpression(node);
  if (!node || !ts.isIdentifier(node)) return node;
  // This is a static manifest contract, not a lexical binder or mutation analysis.
  if (!isModulePolicyReference(node)) return null;
  const sourceFile = node.getSourceFile();
  if (hasUnsupportedPolicyUse(sourceFile, node.text)) return null;
  const key = `${sourceFile.fileName}:${node.text}`;
  if (resolving.has(key)) return null;
  const next = new Set(resolving).add(key);
  for (const statement of sourceFile.statements) {
    if (
      ts.isVariableStatement(statement) &&
      statement.declarationList.flags & ts.NodeFlags.Const
    ) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === node.text
        ) {
          return declaration.initializer &&
            immutablePolicyInitializer(declaration.initializer)
            ? resolvePolicyExpression(declaration.initializer, sources, next)
            : null;
        }
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
      (element) => element.name.text === node.text,
    );
    if (!binding) continue;
    const target = path.resolve(
      path.dirname(sourceFile.fileName),
      statement.moduleSpecifier.text,
    );
    const imported = sources.find(
      ({ filePath }) =>
        filePath === target ||
        filePath === target.replace(/\.js$/, ".ts") ||
        filePath === `${target}.ts`,
    );
    if (!imported) return null;
    const importedFile = ts.createSourceFile(
      imported.filePath,
      imported.source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const exportedName = binding.propertyName?.text ?? binding.name.text;
    if (hasUnsupportedPolicyUse(importedFile, exportedName)) return null;
    for (const importedStatement of importedFile.statements) {
      if (
        !ts.isVariableStatement(importedStatement) ||
        !(importedStatement.declarationList.flags & ts.NodeFlags.Const) ||
        !importedStatement.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
        )
      )
        continue;
      for (const declaration of importedStatement.declarationList
        .declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === exportedName
        ) {
          return declaration.initializer &&
            immutablePolicyInitializer(declaration.initializer)
            ? resolvePolicyExpression(declaration.initializer, sources, next)
            : null;
        }
      }
    }
    return null;
  }
  return null;
}

function navigationGrant(object, sources) {
  const surface = resolvePolicyExpression(
    propertyInitializer(object, "surface"),
    sources,
  );
  if (surface === undefined) return false;
  if (!surface || !ts.isObjectLiteralExpression(surface)) return null;
  const capabilities = resolvePolicyExpression(
    propertyInitializer(surface, "capabilities"),
    sources,
  );
  if (capabilities === undefined) return false;
  if (!capabilities || !ts.isArrayLiteralExpression(capabilities)) return null;
  const grants = capabilities.elements.map((element) =>
    resolvePolicyExpression(element, sources),
  );
  if (!grants.every((grant) => grant && ts.isStringLiteralLike(grant)))
    return null;
  return grants.some((grant) => grant.text === "navigate");
}

function inspectViewDeclarations(
  sourceFiles,
  { id, viewPath, componentExport },
) {
  let declaresIdAndPath = false;
  let declaresExactView = false;
  let grantsNavigation = null;
  for (const { filePath, source } of sourceFiles) {
    const sourceFile = ts.createSourceFile(
      filePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      filePath.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node) => {
      if (ts.isObjectLiteralExpression(node)) {
        const objectId = stringProperty(node, "id");
        const objectPath = stringProperty(node, "path");
        if (objectId === id && objectPath === viewPath) {
          declaresIdAndPath = true;
          if (stringProperty(node, "componentExport") === componentExport) {
            declaresExactView = true;
            grantsNavigation = navigationGrant(node, sourceFiles);
          }
        }
      }
      if (!declaresExactView) ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    if (declaresExactView) break;
  }
  return { declaresExactView, declaresIdAndPath, grantsNavigation };
}

/**
 * Check every smoke view declaration against the plugin that must register it.
 * A declaration is in parity when the plugin directory exists and its source
 * both declares the view `id` and exports the named component. Navigation must
 * be equally granted or denied by the smoke and production declarations.
 * Other surface capabilities are not compared. Returns the full
 * declaration list plus the misses so a test can assert the shipped set is
 * clean AND that a removed plugin id would be caught.
 */
export function checkSmokeViewParity(
  repoRoot,
  declarations = smokeViewDeclarations,
) {
  const pluginsDir = path.join(repoRoot, "plugins");
  const missing = [];
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
    if (!declaration.declaresExactView) {
      missing.push({
        id,
        pluginDirName,
        componentExport,
        reason: declaration.declaresIdAndPath
          ? "component-export-missing"
          : "view-id-not-declared",
      });
    } else if (declaration.grantsNavigation === null) {
      missing.push({
        id,
        pluginDirName,
        componentExport,
        reason: "surface-navigation-policy-unresolved",
      });
    } else if (
      declaration.grantsNavigation !==
      (tuple[6]?.capabilities?.includes("navigate") ?? false)
    ) {
      missing.push({
        id,
        pluginDirName,
        componentExport,
        reason: "surface-navigation-mismatch",
      });
    }
  }
  return { declarations, missing, ok: missing.length === 0 };
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

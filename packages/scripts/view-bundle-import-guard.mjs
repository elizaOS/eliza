/**
 * View-bundle import guard.
 *
 * A plugin view bundle is built with `@elizaos/ui`, `react`, etc. left as
 * *external* bare imports (see `view-bundle-vite.config.ts`). At runtime the
 * shell's `DynamicViewLoader` does NOT load those bare specifiers directly —
 * the agent's bundle route wraps the bundle as a host-external factory
 * (`wrapBundleAsHostExternalFactory`), binding each external specifier to the
 * loader's `HOST_EXTERNAL_IMPORTERS` map so the view shares the host's
 * singletons.
 *
 * That binding is an EXACT-STRING match against the map's keys. The Vite build,
 * however, externalises by PREFIX (`@elizaos/ui` and anything under it). The two
 * therefore disagree: a view that imports an `@elizaos/ui/<subpath>` the loader
 * does not list is externalised by the build but never bound by the loader,
 * so the browser receives a bare `import … from "@elizaos/ui/<subpath>"` it
 * cannot resolve and the view fails to load with "Failed to resolve module
 * specifier".
 *
 * This guard closes that gap: it reads the loader's map (the single source of
 * truth) and asserts every bare import in every built view bundle is one the
 * loader can rewrite. Run at the end of `build-views.mjs` so a drift fails the
 * build instead of shipping a view that silently won't load.
 */

import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverViewBundleInventory } from "./lib/view-bundle-inventory.mjs";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const LOADER_PATH = path.join(
  repoRoot,
  "packages/ui/src/components/views/DynamicViewLoader.tsx",
);

// Build-variant entrypoints contribute plugin-owned host-external specifiers
// through `registerHostExternalImporter` (the loader's trunk map stays
// framework-only). These specifiers are just as loadable as the trunk ones, so
// the guard must union them into the allowed set. Any additional file that
// registers host externals must be listed here.
const HOST_EXTERNAL_REGISTRATION_PATHS = [
  {
    entryPath: path.join(repoRoot, "packages/app/src/main.tsx"),
    registrationPath: path.join(repoRoot, "packages/app/src/host-externals.ts"),
  },
];

function parseSource(source, file, scriptKind) {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  if (sourceFile.parseDiagnostics?.length > 0) {
    const diagnostic = sourceFile.parseDiagnostics[0];
    throw new Error(
      `[view-bundle-guard] ${file} is not parseable TypeScript: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`,
    );
  }
  return sourceFile;
}

function unwrapExpression(expression) {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function staticPropertyName(property, file) {
  const name = property.name;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) {
    return name.text;
  }
  if (
    ts.isComputedPropertyName(name) &&
    ts.isStringLiteralLike(name.expression)
  ) {
    return name.expression.text;
  }
  throw new Error(
    `[view-bundle-guard] HOST_EXTERNAL_IMPORTERS in ${file} contains a non-static property`,
  );
}

function hasExportModifier(node) {
  return node.modifiers?.some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  );
}

function topLevelUnits(sourceFile) {
  const units = new Map();
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      units.set(statement.name.text, {
        exported: hasExportModifier(statement),
        node: statement,
      });
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) {
        units.set(declaration.name.text, {
          exported: hasExportModifier(statement),
          node: declaration.initializer,
        });
      }
    }
  }
  return units;
}

function assertLoaderMapIsRuntimeReachable(
  sourceFile,
  declaration,
  loaderFile,
) {
  const units = topLevelUnits(sourceFile);
  const graph = new Map();
  for (const [name, unit] of units) {
    const dependencies = new Set();
    let consumesMap = false;
    const visit = (node) => {
      if (
        ts.isIdentifier(node) &&
        node.text === "HOST_EXTERNAL_IMPORTERS" &&
        node !== declaration.name
      ) {
        consumesMap = true;
      }
      if (ts.isIdentifier(node) && units.has(node.text) && node.text !== name) {
        dependencies.add(node.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(unit.node);
    graph.set(name, { consumesMap, dependencies });
  }
  const pending = [...units]
    .filter(([, unit]) => unit.exported)
    .map(([name]) => name);
  const visited = new Set();
  while (pending.length > 0) {
    const name = pending.pop();
    if (visited.has(name)) continue;
    visited.add(name);
    const record = graph.get(name);
    if (record?.consumesMap) return;
    pending.push(...(record?.dependencies ?? []));
  }
  throw new Error(
    `[view-bundle-guard] HOST_EXTERNAL_IMPORTERS in ${loaderFile} is not consumed by an exported runtime path`,
  );
}

function importedLocalName(sourceFile, imported, moduleSpecifier, file) {
  const names = [];
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== moduleSpecifier ||
      statement.importClause?.isTypeOnly ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      continue;
    }
    for (const element of statement.importClause.namedBindings.elements) {
      if (
        !element.isTypeOnly &&
        (element.propertyName?.text ?? element.name.text) === imported
      ) {
        names.push(element.name.text);
      }
    }
  }
  if (names.length !== 1) {
    throw new Error(
      `[view-bundle-guard] ${file} must import ${imported} exactly once from ${moduleSpecifier}`,
    );
  }
  return names[0];
}

function exportedSynchronousInitializers(sourceFile, file) {
  const initializers = [];
  for (const statement of sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name &&
      statement.body &&
      hasExportModifier(statement)
    ) {
      if (
        statement.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
        ) ||
        statement.asteriskToken
      ) {
        throw new Error(
          `[view-bundle-guard] ${file} host-external initializer must be synchronous`,
        );
      }
      initializers.push(statement);
    }
  }
  return initializers;
}

function directRegistrationCalls(initializer, localRegistrationName, file) {
  let shadowed = false;
  const findShadow = (node) => {
    if (
      ((ts.isParameter(node) || ts.isVariableDeclaration(node)) &&
        ts.isIdentifier(node.name) &&
        node.name.text === localRegistrationName) ||
      ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
        node !== initializer &&
        node.name?.text === localRegistrationName)
    ) {
      shadowed = true;
    }
    ts.forEachChild(node, findShadow);
  };
  findShadow(initializer);
  if (shadowed) {
    throw new Error(
      `[view-bundle-guard] ${file} shadows the registration API inside its initializer`,
    );
  }
  const calls = [];
  for (const statement of initializer.body.statements) {
    if (
      ts.isExpressionStatement(statement) &&
      ts.isCallExpression(unwrapExpression(statement.expression)) &&
      ts.isIdentifier(unwrapExpression(statement.expression).expression) &&
      unwrapExpression(statement.expression).expression.text ===
        localRegistrationName
    ) {
      calls.push(unwrapExpression(statement.expression));
    }
  }
  let totalCalls = 0;
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === localRegistrationName
    ) {
      totalCalls += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(initializer.body);
  if (calls.length !== totalCalls) {
    throw new Error(
      `[view-bundle-guard] ${file} registrations must be direct statements in the exported synchronous initializer`,
    );
  }
  return calls;
}

function callableImporterSpecifier(expression, file) {
  const callable = unwrapExpression(expression);
  if (!ts.isArrowFunction(callable) && !ts.isFunctionExpression(callable)) {
    throw new Error(
      `[view-bundle-guard] ${file} host-external importer must be an inline callable`,
    );
  }
  const literals = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "importHostExternal")) &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      literals.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(callable.body);
  if (literals.length !== 1) {
    throw new Error(
      `[view-bundle-guard] ${file} host-external importer must consume exactly one literal specifier`,
    );
  }
  return literals[0];
}

function registrationModuleSpecifier(registrationFile, entryFile) {
  const relative = path.posix.relative(
    path.posix.dirname(entryFile),
    registrationFile.replace(/\.[^.]+$/, ""),
  );
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function assertInitializerRunsAtEntry(
  initializerName,
  registrationFile,
  entryFile,
  entrySource,
) {
  if (typeof entrySource !== "string") {
    throw new Error(
      `[view-bundle-guard] ${registrationFile} requires an entry source proving its initializer runs`,
    );
  }
  const sourceFile = parseSource(entrySource, entryFile, ts.ScriptKind.TSX);
  const moduleSpecifier = registrationModuleSpecifier(
    registrationFile,
    entryFile,
  );
  const localName = importedLocalName(
    sourceFile,
    initializerName,
    moduleSpecifier,
    entryFile,
  );
  const calls = sourceFile.statements.filter(
    (statement) =>
      ts.isExpressionStatement(statement) &&
      ts.isCallExpression(unwrapExpression(statement.expression)) &&
      ts.isIdentifier(unwrapExpression(statement.expression).expression) &&
      unwrapExpression(statement.expression).expression.text === localName &&
      unwrapExpression(statement.expression).arguments.length === 0,
  );
  if (calls.length !== 1) {
    throw new Error(
      `[view-bundle-guard] ${entryFile} must call ${initializerName} exactly once at module scope`,
    );
  }
}

/**
 * Extract the exact runtime host-external contract from parsed source.
 *
 * Comments and string examples cannot become allowlist entries, and every
 * extension source must import and call the real registration API with a
 * literal specifier.
 */
export function hostExternalSpecifiersFromSources(
  loaderSource,
  registrationSources,
) {
  const loaderFile = "<DynamicViewLoader.tsx>";
  const loader = parseSource(loaderSource, loaderFile, ts.ScriptKind.TSX);
  const declarations = [];
  const findDeclarations = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "HOST_EXTERNAL_IMPORTERS"
    ) {
      declarations.push(node);
    }
    ts.forEachChild(node, findDeclarations);
  };
  findDeclarations(loader);
  if (declarations.length !== 1) {
    throw new Error(
      `[view-bundle-guard] expected exactly one HOST_EXTERNAL_IMPORTERS declaration in ${loaderFile}, found ${declarations.length}`,
    );
  }
  const declarationStatement = declarations[0].parent?.parent;
  if (
    !declarationStatement ||
    !ts.isVariableStatement(declarationStatement) ||
    declarationStatement.parent !== loader
  ) {
    throw new Error(
      `[view-bundle-guard] HOST_EXTERNAL_IMPORTERS in ${loaderFile} must be declared at module scope`,
    );
  }
  const initializer = declarations[0].initializer;
  const objectLiteral = initializer && unwrapExpression(initializer);
  if (!objectLiteral || !ts.isObjectLiteralExpression(objectLiteral)) {
    throw new Error(
      `[view-bundle-guard] HOST_EXTERNAL_IMPORTERS in ${loaderFile} must be an object literal`,
    );
  }

  const specifiers = new Set();
  for (const property of objectLiteral.properties) {
    if (ts.isSpreadAssignment(property)) {
      throw new Error(
        `[view-bundle-guard] HOST_EXTERNAL_IMPORTERS in ${loaderFile} may not use spread properties`,
      );
    }
    const specifier = staticPropertyName(property, loaderFile);
    if (specifiers.has(specifier)) {
      throw new Error(
        `[view-bundle-guard] HOST_EXTERNAL_IMPORTERS contains duplicate specifier ${specifier}`,
      );
    }
    specifiers.add(specifier);
  }
  if (specifiers.size === 0) {
    throw new Error(
      "[view-bundle-guard] extracted zero host-external specifiers",
    );
  }
  assertLoaderMapIsRuntimeReachable(loader, declarations[0], loaderFile);

  for (const { entryFile, entrySource, file, source } of registrationSources) {
    const sourceFile = parseSource(source, file, ts.ScriptKind.TS);
    const localRegistrationName = importedLocalName(
      sourceFile,
      "registerHostExternalImporter",
      "@elizaos/ui/app-shell-registry",
      file,
    );
    const initializers = exportedSynchronousInitializers(sourceFile, file);
    let initializer;
    let calls = [];
    for (const candidate of initializers) {
      const candidateCalls = directRegistrationCalls(
        candidate,
        localRegistrationName,
        file,
      );
      if (candidateCalls.length > 0) {
        if (initializer) {
          throw new Error(
            `[view-bundle-guard] ${file} must expose one host-external initializer`,
          );
        }
        initializer = candidate;
        calls = candidateCalls;
      }
    }
    if (!initializer?.name || calls.length === 0) {
      throw new Error(
        `[view-bundle-guard] ${file} contains no registrations in an exported synchronous initializer`,
      );
    }
    assertInitializerRunsAtEntry(
      initializer.name.text,
      file,
      entryFile,
      entrySource,
    );
    for (const call of calls) {
      const registeredSpecifier = call.arguments[0];
      const importer = call.arguments[1];
      if (
        !registeredSpecifier ||
        !ts.isStringLiteralLike(registeredSpecifier)
      ) {
        throw new Error(
          `[view-bundle-guard] ${file} must register host externals with literal specifiers`,
        );
      }
      if (!importer) {
        throw new Error(
          `[view-bundle-guard] ${file} must register a callable importer`,
        );
      }
      const importedSpecifier = callableImporterSpecifier(importer, file);
      if (importedSpecifier !== registeredSpecifier.text) {
        throw new Error(
          `[view-bundle-guard] ${file} importer for ${registeredSpecifier.text} consumes mismatched specifier ${importedSpecifier}`,
        );
      }
      if (specifiers.has(registeredSpecifier.text)) {
        throw new Error(
          `[view-bundle-guard] ${file} duplicates host-external specifier ${registeredSpecifier.text}`,
        );
      }
      specifiers.add(registeredSpecifier.text);
    }
  }
  return specifiers;
}

/** Read the host runtime sources and return their exact external specifiers. */
export async function getHostExternalSpecifiers() {
  const loaderSource = await fs.readFile(LOADER_PATH, "utf8");
  const registrationSources = await Promise.all(
    HOST_EXTERNAL_REGISTRATION_PATHS.map(
      async ({ entryPath, registrationPath }) => ({
        entryFile: path.relative(repoRoot, entryPath).split(path.sep).join("/"),
        entrySource: await fs.readFile(entryPath, "utf8"),
        file: path
          .relative(repoRoot, registrationPath)
          .split(path.sep)
          .join("/"),
        source: await fs.readFile(registrationPath, "utf8"),
      }),
    ),
  );
  return hostExternalSpecifiersFromSources(loaderSource, registrationSources);
}

/** Pull every static or literal dynamic bare import from an emitted ESM bundle. */
export function bareImportSpecifiers(source, file = "<view-bundle>") {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  if (sourceFile.parseDiagnostics?.length > 0) {
    const diagnostic = sourceFile.parseDiagnostics[0];
    throw new Error(
      `[view-bundle-guard] ${file} is not parseable JavaScript: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`,
    );
  }

  const out = new Set();
  const add = (specifier) => {
    if (!specifier || !ts.isStringLiteralLike(specifier)) return;
    const spec = specifier.text;
    if (spec.startsWith(".") || spec.startsWith("/")) {
      throw new Error(
        `[view-bundle-guard] ${file} contains a relative or absolute-path import (${spec}); view bundles must be self-contained`,
      );
    }
    out.add(spec);
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      add(node.moduleSpecifier);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      if (!node.arguments[0] || !ts.isStringLiteralLike(node.arguments[0])) {
        throw new Error(
          `[view-bundle-guard] ${file} contains a computed dynamic import that the host cannot validate or rewrite`,
        );
      }
      add(node.arguments[0]);
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require"
    ) {
      throw new Error(
        `[view-bundle-guard] ${file} contains CommonJS require(), which is unavailable in a browser ESM bundle`,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}

/**
 * Resolve every expected bundle through the same workspace inventory as the
 * producer. Tests may inject inventory options to exercise malformed trees.
 */
export function listExpectedViewBundles(options = {}) {
  const root = path.resolve(options.repoRoot ?? repoRoot);
  const inventory = discoverViewBundleInventory({
    ...options,
    repoRoot: root,
  });
  return inventory.targets.map((target) => ({
    name: target.name,
    bundle: target.bundleAbsolute,
    relativeBundle: target.bundle,
    relativeConfig: target.config,
  }));
}

async function listBuiltBundles(options = {}) {
  const expected = options.expected ?? listExpectedViewBundles(options);
  const bundles = [];
  const missingBundles = [];
  for (const entry of expected) {
    try {
      const metadata = await fs.lstat(entry.bundle);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error(
          `[view-bundle-guard] expected bundle is not a regular file: ${entry.relativeBundle}`,
        );
      }
    } catch (error) {
      if (error?.code === "ENOENT") {
        missingBundles.push(entry);
        continue;
      }
      throw error;
    }
    bundles.push(entry);
  }
  return { bundles, missingBundles, expectedBundleCount: expected.length };
}

async function listOutputFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listOutputFiles(absolute)));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      files.push(absolute);
    }
  }
  return files;
}

async function listUnexpectedOutputs(expected) {
  const chunks = [];
  const artifacts = [];
  for (const entry of expected) {
    const directory = path.dirname(entry.bundle);
    let files;
    try {
      files = await listOutputFiles(directory);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const file of files) {
      const metadata = await fs.lstat(file);
      const isSymlink = metadata.isSymbolicLink();
      if (!isSymlink && path.resolve(file) === path.resolve(entry.bundle)) {
        continue;
      }
      if (
        !isSymlink &&
        path.resolve(file) === path.resolve(`${entry.bundle}.map`)
      ) {
        continue;
      }
      const record = {
        name: entry.name,
        artifact: file,
        relativeArtifact: path
          .relative(path.dirname(path.dirname(directory)), file)
          .split(path.sep)
          .join("/"),
      };
      if (!isSymlink && /\.(?:js|mjs|cjs)$/i.test(file)) {
        chunks.push({
          ...record,
          chunk: record.artifact,
          relativeChunk: record.relativeArtifact,
        });
      } else {
        artifacts.push(record);
      }
    }
  }
  return { unexpectedChunks: chunks, unexpectedArtifacts: artifacts };
}

/**
 * Validate every expected view bundle. Returns missing bundle records plus
 * import violations `{ plugin, specifier }`; both empty when every bundle is
 * present and loadable.
 */
export async function validateViewBundles(options = {}) {
  const allowed =
    options.allowedSpecifiers === undefined
      ? await getHostExternalSpecifiers()
      : new Set(options.allowedSpecifiers);
  const expected = listExpectedViewBundles(options);
  const { bundles, missingBundles, expectedBundleCount } =
    await listBuiltBundles({ ...options, expected });
  // TypeScript package builds legitimately emit declarations and importable
  // modules beside bundle.js. Only the dedicated clean Vite producer can prove
  // that another file is a bundle artifact, so strict output-shape validation
  // is opt-in there rather than at the post-Turbo import-check boundary.
  const { unexpectedChunks, unexpectedArtifacts } = options.enforceFreshOutputs
    ? await listUnexpectedOutputs(expected)
    : { unexpectedChunks: [], unexpectedArtifacts: [] };
  const violations = [];
  for (const { name, bundle } of bundles) {
    const source = await fs.readFile(bundle, "utf8");
    for (const spec of bareImportSpecifiers(source, bundle)) {
      if (!allowed.has(spec))
        violations.push({ plugin: name, specifier: spec });
    }
  }
  return {
    violations,
    missingBundles,
    unexpectedChunks,
    unexpectedArtifacts,
    bundleCount: bundles.length,
    expectedBundleCount,
    allowedCount: allowed.size,
  };
}

// CLI entry: `bun packages/scripts/view-bundle-import-guard.mjs`
if (import.meta.main || process.argv[1] === fileURLToPath(import.meta.url)) {
  const {
    violations,
    missingBundles,
    unexpectedChunks,
    unexpectedArtifacts,
    bundleCount,
    expectedBundleCount,
    allowedCount,
  } = await validateViewBundles();
  if (
    missingBundles.length === 0 &&
    violations.length === 0 &&
    unexpectedChunks.length === 0 &&
    unexpectedArtifacts.length === 0
  ) {
    console.log(
      `[view-bundle-guard] OK — ${bundleCount}/${expectedBundleCount} bundle(s) present and import only host-external specifiers (${allowedCount} allowed).`,
    );
    process.exit(0);
  }
  if (missingBundles.length > 0) {
    console.error(
      `[view-bundle-guard] ${missingBundles.length} expected view bundle(s) missing.\n` +
        "Each plugin with vite.config.views.ts must produce dist/views/bundle.js during\n" +
        "the Turbo build; otherwise the root build would ship a view manifest with no\n" +
        "browser-loadable bundle.\n",
    );
    for (const bundle of missingBundles) {
      console.error(
        `  ✗ ${bundle.name}: missing ${bundle.relativeBundle} (declared by ${bundle.relativeConfig})`,
      );
    }
  }
  if (violations.length > 0) {
    console.error(
      `[view-bundle-guard] ${violations.length} un-loadable import(s) found.\n` +
        "These specifiers are externalised by the view build but NOT rewritable by\n" +
        "DynamicViewLoader, so the view fails to load in the browser. Import them from\n" +
        "a specifier the loader's HOST_EXTERNAL_IMPORTERS map already provides (e.g. the\n" +
        "`@elizaos/ui/components` barrel) instead of a deep subpath, or contribute the\n" +
        "specifier through registerHostExternalImporter (see packages/app/src/host-externals.ts).\n",
    );
    for (const v of violations) {
      console.error(`  ✗ ${v.plugin}: ${v.specifier}`);
    }
  }
  if (unexpectedChunks.length > 0) {
    console.error(
      `[view-bundle-guard] ${unexpectedChunks.length} unexpected JavaScript chunk(s) found; each view must emit only bundle.js.\n`,
    );
    for (const chunk of unexpectedChunks) {
      console.error(`  ✗ ${chunk.name}: ${chunk.relativeChunk}`);
    }
  }
  if (unexpectedArtifacts.length > 0) {
    console.error(
      `[view-bundle-guard] ${unexpectedArtifacts.length} unexpected sidecar artifact(s) found; only bundle.js and bundle.js.map may be emitted.\n`,
    );
    for (const artifact of unexpectedArtifacts) {
      console.error(`  ✗ ${artifact.name}: ${artifact.relativeArtifact}`);
    }
  }
  process.exit(1);
}

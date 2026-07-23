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
  path.join(repoRoot, "packages/app/src/host-externals.ts"),
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

  for (const { file, source } of registrationSources) {
    const sourceFile = parseSource(source, file, ts.ScriptKind.TS);
    const localRegistrationNames = new Set();
    for (const statement of sourceFile.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteralLike(statement.moduleSpecifier) ||
        statement.moduleSpecifier.text !== "@elizaos/ui/app-shell-registry" ||
        statement.importClause?.isTypeOnly ||
        !statement.importClause?.namedBindings ||
        !ts.isNamedImports(statement.importClause.namedBindings)
      ) {
        continue;
      }
      for (const element of statement.importClause.namedBindings.elements) {
        if (
          !element.isTypeOnly &&
          (element.propertyName?.text ?? element.name.text) ===
            "registerHostExternalImporter"
        ) {
          localRegistrationNames.add(element.name.text);
        }
      }
    }
    if (localRegistrationNames.size !== 1) {
      throw new Error(
        `[view-bundle-guard] ${file} must import registerHostExternalImporter exactly once from @elizaos/ui/app-shell-registry`,
      );
    }

    let registrationCount = 0;
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        localRegistrationNames.has(node.expression.text)
      ) {
        const specifier = node.arguments[0];
        if (!specifier || !ts.isStringLiteralLike(specifier)) {
          throw new Error(
            `[view-bundle-guard] ${file} must register host externals with literal specifiers`,
          );
        }
        if (specifiers.has(specifier.text)) {
          throw new Error(
            `[view-bundle-guard] ${file} duplicates host-external specifier ${specifier.text}`,
          );
        }
        specifiers.add(specifier.text);
        registrationCount += 1;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    if (registrationCount === 0) {
      throw new Error(
        `[view-bundle-guard] ${file} contains no host-external registrations`,
      );
    }
  }
  return specifiers;
}

/** Read the host runtime sources and return their exact external specifiers. */
export async function getHostExternalSpecifiers() {
  const loaderSource = await fs.readFile(LOADER_PATH, "utf8");
  const registrationSources = await Promise.all(
    HOST_EXTERNAL_REGISTRATION_PATHS.map(async (registrationPath) => ({
      file: path.relative(repoRoot, registrationPath),
      source: await fs.readFile(registrationPath, "utf8"),
    })),
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

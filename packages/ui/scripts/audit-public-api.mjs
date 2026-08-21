/**
 * Freezes the public API surface so compatibility work can shrink it
 * deliberately, without allowing accidental additions or removals in CI.
 *
 * Three distinct surfaces are frozen. The root barrel (`src/index.ts`) is
 * checked via the TypeScript checker, same as before. Exact non-root entries
 * in package.json `exports` are frozen with their complete target mappings.
 * Wildcard subpath exports (e.g. `./cloud/*`, `./components/*` in package.json
 * `exports`) are a SEPARATE public surface: every source file the build emits
 * under the corresponding `dist/<prefix>/...` path is importable from
 * outside this package as `@elizaos/ui/<prefix>/<path>`, whether or not the
 * monorepo currently imports it. An in-repo importer search finds zero
 * hits for such a file and makes deleting it look free — it is not, because
 * an external deep-importer can still reach it. Walking the exports map is
 * the only way to see this surface; `checker.getExportsOfModule` on
 * `src/index.ts` never will.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  collectExplicitSubpathExports,
  diffExplicitSubpathExports,
} from "./public-api-explicit-subpaths.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = resolve(packageRoot, "scripts/public-api-baseline.json");
const updateBaseline = process.argv.includes("--update-baseline");

const configPath = resolve(packageRoot, "tsconfig.json");
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error) {
  throw new Error(
    ts.flattenDiagnosticMessageText(config.error.messageText, "\n"),
  );
}
const parsed = ts.parseJsonConfigFileContent(
  config.config,
  ts.sys,
  packageRoot,
  { noEmit: true },
  configPath,
);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();
const entry = program.getSourceFile(resolve(packageRoot, "src/index.ts"));
if (!entry) throw new Error("Could not load src/index.ts");
const moduleSymbol = checker.getSymbolAtLocation(entry);
if (!moduleSymbol) throw new Error("Could not resolve the root module symbol");

const api = checker
  .getExportsOfModule(moduleSymbol)
  .map((symbol) => {
    const resolved =
      symbol.flags & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(symbol)
        : symbol;
    const declaration = resolved.declarations?.[0];
    const source = declaration?.getSourceFile().fileName;
    return {
      name: symbol.getName(),
      source: source
        ? relative(packageRoot, source).replaceAll("\\", "/")
        : "<synthetic>",
    };
  })
  .sort((left, right) => left.name.localeCompare(right.name));

// Wildcard subpath entry points: every `"./<prefix>/*"` key in package.json
// `exports` whose target lands under `dist/` (not a `.css` passthrough) turns
// every non-test, non-story source file under `src/<prefix>/**` into a
// resolvable `@elizaos/ui/<prefix>/<path>` module, because the build (`tsc
// -p tsconfig.build.json`, include: ["src"]) emits one output file per source
// file with no dead-code elimination at the package boundary.
const SOURCE_EXTENSIONS = [".tsx", ".ts"];
const EXCLUDED_SUFFIXES = [
  ".test.ts",
  ".test.tsx",
  ".stories.ts",
  ".stories.tsx",
  ".d.ts",
];

async function collectSourceFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const dirent of entries) {
    const full = resolve(dir, dirent.name);
    if (dirent.isDirectory()) {
      out.push(...(await collectSourceFiles(full)));
      continue;
    }
    if (!dirent.isFile()) continue;
    if (!SOURCE_EXTENSIONS.some((ext) => dirent.name.endsWith(ext))) continue;
    if (EXCLUDED_SUFFIXES.some((suffix) => dirent.name.endsWith(suffix)))
      continue;
    out.push(full);
  }
  return out;
}

function stripSourceExtension(filePath) {
  for (const ext of SOURCE_EXTENSIONS) {
    if (filePath.endsWith(ext)) return filePath.slice(0, -ext.length);
  }
  return filePath;
}

const pkgJson = JSON.parse(
  await readFile(resolve(packageRoot, "package.json"), "utf8"),
);
const exportsMap = pkgJson.exports ?? {};
const explicitSubpathExports = collectExplicitSubpathExports(
  exportsMap,
  pkgJson.name,
);

const wildcardPrefixes = Object.entries(exportsMap)
  .filter(([key, value]) => {
    if (!key.endsWith("/*") || key.endsWith(".css")) return false;
    const target =
      typeof value === "string" ? value : (value.import ?? value.default ?? "");
    return (
      typeof target === "string" &&
      target.startsWith("./dist/") &&
      target.endsWith(".js")
    );
  })
  .map(([key]) => key.slice(2, -2)); // "./cloud/*" -> "cloud"

const subpathExports = [];
for (const prefix of wildcardPrefixes) {
  const dir = resolve(packageRoot, "src", prefix);
  const files = await collectSourceFiles(dir);
  for (const file of files) {
    const relFromSrc = relative(resolve(packageRoot, "src"), file).replaceAll(
      "\\",
      "/",
    );
    subpathExports.push({
      specifier: `@elizaos/ui/${stripSourceExtension(relFromSrc)}`,
      source: relative(packageRoot, file).replaceAll("\\", "/"),
    });
  }
}
subpathExports.sort((left, right) =>
  left.specifier.localeCompare(right.specifier),
);

const report = {
  exports: api,
  count: api.length,
  subpathExports,
  subpathCount: subpathExports.length,
  explicitSubpathExports,
  explicitSubpathCount: explicitSubpathExports.length,
};

if (updateBaseline) {
  await writeFile(baselinePath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `Updated public API baseline (${api.length} root exports, ${explicitSubpathExports.length} explicit subpaths, ${subpathExports.length} wildcard subpath entry points).`,
  );
  process.exit(0);
}

const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
const currentText = JSON.stringify(report);
const baselineText = JSON.stringify(baseline);
if (currentText !== baselineText) {
  const previous = new Map(
    baseline.exports.map((entry) => [entry.name, entry.source]),
  );
  const current = new Map(api.map((entry) => [entry.name, entry.source]));
  const added = api.filter((entry) => !previous.has(entry.name));
  const removed = baseline.exports.filter((entry) => !current.has(entry.name));
  const moved = api.filter(
    (entry) =>
      previous.has(entry.name) && previous.get(entry.name) !== entry.source,
  );

  const previousSubpaths = new Map(
    (baseline.subpathExports ?? []).map((entry) => [
      entry.specifier,
      entry.source,
    ]),
  );
  const currentSubpaths = new Map(
    subpathExports.map((entry) => [entry.specifier, entry.source]),
  );
  const addedSubpaths = subpathExports.filter(
    (entry) => !previousSubpaths.has(entry.specifier),
  );
  const removedSubpaths = (baseline.subpathExports ?? []).filter(
    (entry) => !currentSubpaths.has(entry.specifier),
  );
  const movedSubpaths = subpathExports.filter(
    (entry) =>
      previousSubpaths.has(entry.specifier) &&
      previousSubpaths.get(entry.specifier) !== entry.source,
  );

  const explicitSubpathDiff = diffExplicitSubpathExports(
    baseline.explicitSubpathExports ?? [],
    explicitSubpathExports,
  );

  throw new Error(
    [
      "Public API changed. Prefer an explicit subpath; update the baseline only for an intentional compatibility decision.",
      added.length
        ? `Root added: ${added.map((entry) => entry.name).join(", ")}`
        : "",
      removed.length
        ? `Root removed: ${removed.map((entry) => entry.name).join(", ")}`
        : "",
      moved.length
        ? `Root moved: ${moved.map((entry) => entry.name).join(", ")}`
        : "",
      addedSubpaths.length
        ? `Subpath added: ${addedSubpaths.map((entry) => entry.specifier).join(", ")}`
        : "",
      removedSubpaths.length
        ? `Subpath removed: ${removedSubpaths.map((entry) => entry.specifier).join(", ")}`
        : "",
      movedSubpaths.length
        ? `Subpath moved: ${movedSubpaths.map((entry) => entry.specifier).join(", ")}`
        : "",
      explicitSubpathDiff.added.length
        ? `Explicit subpath added: ${explicitSubpathDiff.added.map((entry) => entry.specifier).join(", ")}`
        : "",
      explicitSubpathDiff.removed.length
        ? `Explicit subpath removed: ${explicitSubpathDiff.removed.map((entry) => entry.specifier).join(", ")}`
        : "",
      explicitSubpathDiff.retargeted.length
        ? `Explicit subpath retargeted: ${explicitSubpathDiff.retargeted.map((entry) => entry.specifier).join(", ")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

console.log(
  `Public API matches baseline (${api.length} root exports, ${explicitSubpathExports.length} explicit subpaths, ${subpathExports.length} wildcard subpath entry points).`,
);

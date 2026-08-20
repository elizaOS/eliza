/**
 * Freezes the root package exports so compatibility work can shrink the public
 * API deliberately without allowing accidental additions or removals in CI.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

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

const report = { exports: api, count: api.length };
if (updateBaseline) {
  await writeFile(baselinePath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Updated public API baseline (${api.length} root exports).`);
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
  throw new Error(
    [
      "Root public API changed. Prefer an explicit subpath; update the baseline only for an intentional compatibility decision.",
      added.length
        ? `Added: ${added.map((entry) => entry.name).join(", ")}`
        : "",
      removed.length
        ? `Removed: ${removed.map((entry) => entry.name).join(", ")}`
        : "",
      moved.length
        ? `Moved: ${moved.map((entry) => entry.name).join(", ")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

console.log(`Public API matches baseline (${api.length} root exports).`);

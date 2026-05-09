#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = new Set(process.argv.slice(2));
const asJson = args.has("--json");
const check = args.has("--check");

const repoRoot = process.cwd();
const ignoredPath = /(^|\/)(node_modules|dist|build|\.turbo|\.next|coverage)(\/|$)/;
const sourceExtensions = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

function shellLines(command, commandArgs) {
  const output = execFileSync(command, commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 64,
  }).trim();
  return output ? output.split("\n") : [];
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function sortByCountThenName(left, right) {
  if (right.count !== left.count) return right.count - left.count;
  return left.name.localeCompare(right.name);
}

function increment(map, key, count = 1) {
  map.set(key, (map.get(key) ?? 0) + count);
}

function countMapEntries(map) {
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort(sortByCountThenName);
}

function packageOwnerForFile(file, packages) {
  let owner = null;
  for (const pkg of packages) {
    const dir = pkg.dir === "." ? "" : `${pkg.dir}/`;
    if (file === pkg.dir || file.startsWith(dir)) {
      if (!owner || pkg.dir.length > owner.dir.length) {
        owner = pkg;
      }
    }
  }
  return owner;
}

function classifySubpath(subpath) {
  if (subpath.endsWith(".css") || subpath.endsWith(".json")) return "asset";
  if (subpath === "browser" || subpath.startsWith("browser/")) return "platform";
  if (subpath === "node" || subpath.startsWith("node/")) return "platform";
  if (
    subpath === "ui" ||
    subpath.startsWith("ui/") ||
    subpath === "register" ||
    subpath.startsWith("register") ||
    subpath === "widgets" ||
    subpath.startsWith("widgets/") ||
    subpath.startsWith("components/") ||
    subpath.startsWith("hooks/") ||
    subpath.startsWith("layouts/") ||
    subpath.startsWith("styles/")
  ) {
    return "frontend";
  }
  if (
    subpath === "plugin" ||
    subpath === "routes" ||
    subpath.startsWith("routes/") ||
    subpath === "register-routes" ||
    subpath === "setup-routes" ||
    subpath.startsWith("cloud/") ||
    subpath.startsWith("lib/") ||
    subpath.startsWith("services/")
  ) {
    return "node";
  }
  return "shared";
}

const packageJsonFiles = shellLines("find", [
  ".",
  "-name",
  "package.json",
  "-not",
  "-path",
  "*/node_modules/*",
  "-not",
  "-path",
  "*/dist/*",
  "-not",
  "-path",
  "*/build/*",
]).sort();

const packages = packageJsonFiles
  .map((file) => {
    const manifest = readJson(file);
    return manifest.name
      ? {
          dir: path.dirname(file).replace(/^\.\//, ""),
          exports: manifest.exports,
          file: file.replace(/^\.\//, ""),
          manifest,
          name: manifest.name,
        }
      : null;
  })
  .filter(Boolean);

const packageNames = packages.map((pkg) => pkg.name).sort((a, b) => b.length - a.length);

const sourceFiles = shellLines("rg", [
  "--files",
  "-g",
  "*.cjs",
  "-g",
  "*.cts",
  "-g",
  "*.js",
  "-g",
  "*.jsx",
  "-g",
  "*.mjs",
  "-g",
  "*.mts",
  "-g",
  "*.ts",
  "-g",
  "*.tsx",
  "-g",
  "!**/node_modules/**",
  "-g",
  "!**/dist/**",
  "-g",
  "!**/build/**",
  "-g",
  "!**/.turbo/**",
  "-g",
  "!**/.next/**",
  "-g",
  "!**/coverage/**",
]).filter((file) => sourceExtensions.has(path.extname(file)));

const specifierPattern =
  /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;

const subpathReferences = [];
for (const file of sourceFiles) {
  const source = fs.readFileSync(file, "utf8");
  const owner = packageOwnerForFile(file, packages);
  let match;
  while ((match = specifierPattern.exec(source))) {
    const specifier = match[1] || match[2];
    const packageName = packageNames.find(
      (name) => specifier === name || specifier.startsWith(`${name}/`),
    );
    if (!packageName || specifier === packageName || specifier.endsWith("/package.json")) {
      continue;
    }
    const subpath = specifier.slice(packageName.length + 1);
    subpathReferences.push({
      classification: classifySubpath(subpath),
      file,
      owner: owner?.name ?? null,
      packageName,
      specifier,
      subpath,
    });
  }
}

const packageSubpathExports = [];
for (const pkg of packages) {
  if (!pkg.exports || typeof pkg.exports !== "object" || Array.isArray(pkg.exports)) {
    continue;
  }
  for (const exportKey of Object.keys(pkg.exports)) {
    if (exportKey === "." || exportKey === "./package.json") continue;
    packageSubpathExports.push({
      classification: classifySubpath(exportKey.replace(/^\.\//, "")),
      exportKey,
      file: pkg.file,
      packageName: pkg.name,
    });
  }
}

let reExportMarkers = [];
try {
  reExportMarkers = shellLines("rg", [
    "-n",
    "--hidden",
    "-i",
    "-g",
    "!**/node_modules/**",
    "-g",
    "!**/dist/**",
    "-g",
    "!**/build/**",
    "-g",
    "!**/.turbo/**",
    "-g",
    "!**/.next/**",
    "-g",
    "!**/coverage/**",
    "re-export|reexport",
    ".",
  ]).filter((line) => !ignoredPath.test(line));
} catch (error) {
  if (error.status !== 1) throw error;
}

const referencesByPackage = new Map();
const referencesBySpecifier = new Map();
const referencesByClass = new Map();
for (const ref of subpathReferences) {
  increment(referencesByPackage, ref.packageName);
  increment(referencesBySpecifier, ref.specifier);
  increment(referencesByClass, ref.classification);
}

const exportsByPackage = new Map();
const exportsByClass = new Map();
for (const exported of packageSubpathExports) {
  increment(exportsByPackage, exported.packageName);
  increment(exportsByClass, exported.classification);
}

const report = {
  packageSubpathExports,
  reExportMarkers,
  summary: {
    packages: packages.length,
    sourceFiles: sourceFiles.length,
    subpathReferenceCount: subpathReferences.length,
    subpathExportCount: packageSubpathExports.length,
    reExportMarkerCount: reExportMarkers.length,
  },
  subpathReferences,
  totals: {
    exportsByClass: countMapEntries(exportsByClass),
    exportsByPackage: countMapEntries(exportsByPackage),
    referencesByClass: countMapEntries(referencesByClass),
    referencesByPackage: countMapEntries(referencesByPackage),
    referencesBySpecifier: countMapEntries(referencesBySpecifier),
  },
};

if (asJson) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  console.log("Package Barrel Audit");
  console.log("====================");
  console.log(`Workspace packages: ${report.summary.packages}`);
  console.log(`Source files scanned: ${report.summary.sourceFiles}`);
  console.log(`Workspace package subpath references: ${report.summary.subpathReferenceCount}`);
  console.log(`Published package subpath exports: ${report.summary.subpathExportCount}`);
  console.log(`Literal re-export markers: ${report.summary.reExportMarkerCount}`);

  console.log("\nReferences by class");
  for (const item of report.totals.referencesByClass) {
    console.log(`${String(item.count).padStart(5)}  ${item.name}`);
  }

  console.log("\nReferences by package");
  for (const item of report.totals.referencesByPackage.slice(0, 40)) {
    console.log(`${String(item.count).padStart(5)}  ${item.name}`);
  }

  console.log("\nTop subpath specifiers");
  for (const item of report.totals.referencesBySpecifier.slice(0, 80)) {
    console.log(`${String(item.count).padStart(5)}  ${item.name}`);
  }

  console.log("\nPublished subpath exports by package");
  for (const item of report.totals.exportsByPackage.slice(0, 60)) {
    console.log(`${String(item.count).padStart(5)}  ${item.name}`);
  }

  console.log("\nFirst subpath references");
  for (const ref of report.subpathReferences.slice(0, 80)) {
    console.log(`${ref.file}: ${ref.specifier}`);
  }

  console.log("\nFirst re-export markers");
  for (const marker of report.reExportMarkers.slice(0, 80)) {
    console.log(marker);
  }

  console.log("\nRemediation order");
  console.log("1. Move shared symbols used through package subpaths into each package root barrel.");
  console.log("2. Replace cross-package subpath imports with bare package imports.");
  console.log("3. Split frontend and node-only surfaces with conditional root exports, not ./ui, ./routes, ./node, or ./browser imports.");
  console.log("4. Delete compatibility re-export shims and remove subpath keys/wildcards from package.json exports.");
}

if (
  check &&
  (subpathReferences.length > 0 ||
    packageSubpathExports.length > 0 ||
    reExportMarkers.length > 0)
) {
  process.exitCode = 1;
}

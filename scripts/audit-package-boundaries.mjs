#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const args = new Set(process.argv.slice(2));
const check = args.has("--check");
const asJson = args.has("--json");
const includeTests = args.has("--include-tests");

const repoRoot = process.cwd();
const ignoredPath =
  /(^|\/)(node_modules|dist|build|\.turbo|\.next|coverage|\.vite)(\/|$)/;
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
    maxBuffer: 1024 * 1024 * 128,
  }).trim();
  return output ? output.split("\n") : [];
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function normalize(file) {
  return file.split(path.sep).join("/");
}

function relative(file) {
  return normalize(path.relative(repoRoot, file));
}

function packageOwnerForPath(absPath, packages) {
  let owner = null;
  for (const pkg of packages) {
    if (
      absPath === pkg.absDir ||
      absPath.startsWith(`${pkg.absDir}${path.sep}`)
    ) {
      if (!owner || pkg.absDir.length > owner.absDir.length) {
        owner = pkg;
      }
    }
  }
  return owner;
}

function getManifestDeps(manifest) {
  return {
    dependencies: manifest.dependencies ?? {},
    devDependencies: manifest.devDependencies ?? {},
    optionalDependencies: manifest.optionalDependencies ?? {},
    peerDependencies: manifest.peerDependencies ?? {},
  };
}

function hasDeclaredDependency(manifest, packageName) {
  const deps = getManifestDeps(manifest);
  return Object.values(deps).some((section) =>
    Object.hasOwn(section, packageName),
  );
}

function shouldScanPackageJson(file) {
  return (
    /^packages\/[^/]+\/package\.json$/.test(file) ||
    /^packages\/examples\/[^/]+(?:\/[^/]+){0,2}\/package\.json$/.test(file) ||
    /^packages\/native-plugins\/[^/]+\/package\.json$/.test(file) ||
    /^packages\/app-core\/platforms\/[^/]+\/package\.json$/.test(file) ||
    /^plugins\/[^/]+\/package\.json$/.test(file) ||
    /^cloud\/packages\/sdk\/package\.json$/.test(file)
  );
}

function isTestLikeFile(file) {
  const normalized = normalize(file);
  return (
    /(^|\/)(__tests__|test|tests|fixtures|mocks)(\/|$)/.test(normalized) ||
    /\.(?:test|spec|e2e|live)\.[cm]?[jt]sx?$/.test(normalized) ||
    /(^|\/)(vitest|playwright|jest)\.config\.[cm]?[jt]s$/.test(normalized) ||
    /(^|\/)test-/.test(normalized)
  );
}

const packageJsonFiles = shellLines("rg", [
  "--files",
  "-g",
  "package.json",
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
])
  .filter(shouldScanPackageJson)
  .sort();

const packages = packageJsonFiles
  .map((file) => {
    const absFile = path.join(repoRoot, file);
    const manifest = readJson(absFile);
    if (!manifest.name) return null;
    const dir = path.dirname(file).replace(/^\.$/, "");
    const absDir = path.dirname(absFile);
    return {
      absDir,
      dir,
      file,
      manifest,
      name: manifest.name,
    };
  })
  .filter(Boolean)
  .sort((left, right) => left.absDir.length - right.absDir.length);

const packageByName = new Map(packages.map((pkg) => [pkg.name, pkg]));
const packageNames = [...packageByName.keys()].sort(
  (left, right) => right.length - left.length,
);

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
  "-g",
  "!**/.vite/**",
])
  .filter((file) => sourceExtensions.has(path.extname(file)))
  .filter((file) => !ignoredPath.test(file))
  .map((file) => path.join(repoRoot, file))
  .filter((file) => packageOwnerForPath(file, packages))
  .filter((file) => includeTests || !isTestLikeFile(relative(file)));

function scriptKindForFile(file) {
  switch (path.extname(file)) {
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".json":
      return ts.ScriptKind.JSON;
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

function literalText(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
    ? node.text
    : null;
}

function getImportSpecifiers(file, source) {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForFile(file),
  );
  const specifiers = [];

  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    ) {
      const specifier = literalText(node.moduleSpecifier);
      if (specifier) specifiers.push(specifier);
    } else if (ts.isCallExpression(node)) {
      if (node.arguments.length === 1) {
        const firstArg = node.arguments[0];
        const specifier = literalText(firstArg);
        if (
          specifier &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) &&
              node.expression.text === "require"))
        ) {
          specifiers.push(specifier);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specifiers;
}

const relativeCrossPackageImports = [];
const relativeOutsidePackageImports = [];
const undeclaredWorkspaceImports = [];
const pluginDependencyViolations = [];

for (const file of sourceFiles) {
  const owner = packageOwnerForPath(file, packages);
  if (!owner) continue;
  const source = fs.readFileSync(file, "utf8");
  for (const specifier of getImportSpecifiers(file, source)) {
    if (!specifier) continue;

    if (specifier.startsWith(".")) {
      const resolved = path.resolve(path.dirname(file), specifier);
      if (
        resolved === owner.absDir ||
        resolved.startsWith(`${owner.absDir}${path.sep}`)
      ) {
        continue;
      }
      const target = packageOwnerForPath(resolved, packages);
      const record = {
        file: relative(file),
        isTestLike: isTestLikeFile(relative(file)),
        owner: owner.name,
        ownerDir: owner.dir,
        specifier,
        target: target?.name ?? null,
        targetDir: target?.dir ?? null,
      };
      if (target) {
        relativeCrossPackageImports.push(record);
      } else {
        relativeOutsidePackageImports.push(record);
      }
      continue;
    }

    const packageName = packageNames.find(
      (name) => specifier === name || specifier.startsWith(`${name}/`),
    );
    if (!packageName || packageName === owner.name) continue;
    if (!hasDeclaredDependency(owner.manifest, packageName)) {
      undeclaredWorkspaceImports.push({
        file: relative(file),
        isTestLike: isTestLikeFile(relative(file)),
        owner: owner.name,
        packageName,
        specifier,
      });
    }
  }
}

for (const pkg of packages) {
  if (!pkg.dir.startsWith("plugins/plugin-")) continue;
  const deps = getManifestDeps(pkg.manifest);
  for (const [sectionName, section] of Object.entries(deps)) {
    for (const dependencyName of Object.keys(section)) {
      if (!packageByName.has(dependencyName)) continue;
      if (dependencyName === "@elizaos/core") continue;
      pluginDependencyViolations.push({
        dependencyName,
        file: pkg.file,
        packageName: pkg.name,
        section: sectionName,
      });
    }
  }
}

function groupCount(records, key) {
  const counts = new Map();
  for (const record of records) {
    const value = record[key] ?? "(none)";
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort(
      (left, right) =>
        right.count - left.count || left.name.localeCompare(right.name),
    );
}

const report = {
  packageCount: packages.length,
  sourceFileCount: sourceFiles.length,
  relativeCrossPackageImports,
  relativeOutsidePackageImports,
  undeclaredWorkspaceImports,
  pluginDependencyViolations,
  counts: {
    relativeCrossPackageImports: relativeCrossPackageImports.length,
    relativeOutsidePackageImports: relativeOutsidePackageImports.length,
    undeclaredWorkspaceImports: undeclaredWorkspaceImports.length,
    pluginDependencyViolations: pluginDependencyViolations.length,
  },
  byOwner: {
    relativeCrossPackageImports: groupCount(
      relativeCrossPackageImports,
      "owner",
    ),
    relativeOutsidePackageImports: groupCount(
      relativeOutsidePackageImports,
      "owner",
    ),
    undeclaredWorkspaceImports: groupCount(undeclaredWorkspaceImports, "owner"),
    pluginDependencyViolations: groupCount(
      pluginDependencyViolations,
      "packageName",
    ),
  },
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Packages: ${report.packageCount}`);
  console.log(`Source files: ${report.sourceFileCount}`);
  console.log(
    `Relative cross-package imports: ${report.counts.relativeCrossPackageImports}`,
  );
  console.log(
    `Relative imports outside package roots: ${report.counts.relativeOutsidePackageImports}`,
  );
  console.log(
    `Undeclared workspace package imports: ${report.counts.undeclaredWorkspaceImports}`,
  );
  console.log(
    `Plugin dependency violations: ${report.counts.pluginDependencyViolations}`,
  );

  for (const [label, records] of [
    ["Relative cross-package imports", relativeCrossPackageImports],
    ["Relative imports outside package roots", relativeOutsidePackageImports],
    ["Undeclared workspace package imports", undeclaredWorkspaceImports],
    ["Plugin dependency violations", pluginDependencyViolations],
  ]) {
    if (records.length === 0) continue;
    console.log(`\n${label}:`);
    for (const record of records) {
      if ("specifier" in record) {
        console.log(
          `- ${record.file}: ${record.owner} imports ${record.specifier}` +
            (record.target ? ` (${record.target})` : ""),
        );
      } else {
        console.log(
          `- ${record.file}: ${record.packageName} ${record.section} -> ${record.dependencyName}`,
        );
      }
    }
  }
}

const failed =
  relativeCrossPackageImports.length > 0 ||
  relativeOutsidePackageImports.length > 0 ||
  undeclaredWorkspaceImports.length > 0 ||
  pluginDependencyViolations.length > 0;

if (check && failed) {
  process.exitCode = 1;
}

#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const WORKSPACE_BASES = [
  "packages",
  "plugins",
  "cloud/packages",
  "cloud/apps",
  "packages/native-plugins",
];
const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".d.ts",
  ".html",
];
const GENERATED_DIRS = new Set([
  ".git",
  ".turbo",
  ".vite",
  ".wrangler",
  ".wrangler-dry-run",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);
const GENERATED_PATH_PARTS = [
  "packages/app/android/app/src/main/assets",
  "packages/app/electrobun/build",
];
const ASSET_EXPORT_EXTENSIONS = new Set([
  ".css",
  ".json",
  ".wasm",
  ".png",
  ".jpg",
  ".jpeg",
  ".svg",
  ".webp",
]);
const PLATFORM_EXPORT_KEYS = new Set([
  "./browser",
  "./node",
  "./edge",
  "./react-native",
]);

function parseArgs(argv) {
  const args = {
    apply: false,
    addRootBarrels: true,
    collapseExplicitExports: false,
    collapseWildcardExports: false,
    rewriteImports: true,
    report: "reports/barrel-audit.md",
    json: "reports/barrel-audit.json",
    packageNames: new Set(),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--dry-run") args.apply = false;
    else if (arg === "--collapse-explicit-exports")
      args.collapseExplicitExports = true;
    else if (arg === "--collapse-wildcard-exports")
      args.collapseWildcardExports = true;
    else if (arg === "--no-add-root-barrels") args.addRootBarrels = false;
    else if (arg === "--no-rewrite-imports") args.rewriteImports = false;
    else if (arg === "--report") args.report = argv[++i];
    else if (arg === "--json") args.json = argv[++i];
    else if (arg === "--package") args.packageNames.add(argv[++i]);
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/barrel/audit-and-transform.mjs [options]

Default mode is dry-run. The script always writes an audit report.

Options:
  --apply                       Write planned file changes.
  --dry-run                     Preview only. This is the default.
  --collapse-explicit-exports   Remove explicit non-root JS/TS package exports
                                after adding root barrel exports.
  --collapse-wildcard-exports   Remove wildcard non-root JS/TS package exports.
  --no-add-root-barrels         Do not append root barrel export lines.
  --no-rewrite-imports          Do not rewrite source imports to package roots.
  --package <name>              Limit transforms to one package. Repeatable.
  --report <path>               Markdown report path.
  --json <path>                 JSON report path.
`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(`${file}.tmp`, file);
}

function ensureDir(file) {
  fs.mkdirSync(path.dirname(path.join(ROOT, file)), { recursive: true });
}

function walk(dir, visit) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (GENERATED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, visit);
    } else {
      visit(full);
    }
  }
}

function discoverPackages() {
  const packages = [];
  for (const base of WORKSPACE_BASES) {
    const abs = path.join(ROOT, base);
    if (!fs.existsSync(abs)) continue;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const packageJsonPath = path.join(abs, entry.name, "package.json");
      if (!fs.existsSync(packageJsonPath)) continue;
      const manifest = readJson(packageJsonPath);
      if (!manifest.name) continue;
      packages.push({
        name: manifest.name,
        dir: path.dirname(packageJsonPath),
        packageJsonPath,
        packageJsonRel: path.relative(ROOT, packageJsonPath),
        manifest,
      });
    }
  }
  packages.sort((left, right) => left.name.localeCompare(right.name));
  return packages;
}

function findOwningPackage(file, packages) {
  let best = null;
  for (const pkg of packages) {
    if (file === pkg.dir || file.startsWith(`${pkg.dir}${path.sep}`)) {
      if (!best || pkg.dir.length > best.dir.length) best = pkg;
    }
  }
  return best;
}

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function isSourceFile(file) {
  return SOURCE_EXTENSIONS.some((ext) => file.endsWith(ext));
}

function isAssetSpecifier(specifier) {
  const ext = path.extname(specifier);
  return ASSET_EXPORT_EXTENSIONS.has(ext);
}

function listSourceFiles(packages) {
  const files = [];
  for (const base of WORKSPACE_BASES) {
    const abs = path.join(ROOT, base);
    walk(abs, (file) => {
      const relative = path.relative(ROOT, file).replace(/\\/g, "/");
      if (GENERATED_PATH_PARTS.some((part) => relative.startsWith(part))) {
        return;
      }
      if (isSourceFile(file)) files.push(file);
    });
  }
  return files.filter((file) => findOwningPackage(file, packages));
}

function findImports(packages) {
  const packageNames = packages
    .map((pkg) => pkg.name)
    .sort((left, right) => right.length - left.length);
  const imports = [];
  const importRegex =
    /(?:from\s+|import\s*\(\s*|import\s+|export\s+[^;]*?from\s+)["']([^"']+)["']/g;
  for (const file of listSourceFiles(packages)) {
    if (!fs.existsSync(file)) continue;
    const text = stripComments(fs.readFileSync(file, "utf8"));
    let match;
    while ((match = importRegex.exec(text))) {
      const specifier = match[1];
      const packageName = packageNames.find(
        (name) => specifier === name || specifier.startsWith(`${name}/`),
      );
      if (!packageName || specifier === packageName) continue;
      if (specifier.endsWith("/package.json")) continue;
      const owner = findOwningPackage(file, packages);
      imports.push({
        file: path.relative(ROOT, file),
        owner: owner?.name ?? null,
        packageName,
        specifier,
        subpath: specifier.slice(packageName.length + 1),
        asset: isAssetSpecifier(specifier),
        selfImport: owner?.name === packageName,
      });
    }
  }
  return imports;
}

function findStringReferences(packages) {
  const packageNames = packages
    .map((pkg) => pkg.name)
    .sort((left, right) => right.length - left.length);
  const references = [];
  const stringRegex = /["'](@(?:elizaos|elizaai|clawville)\/[^"']+)["']/g;
  for (const file of listSourceFiles(packages)) {
    if (!fs.existsSync(file)) continue;
    const text = stripComments(fs.readFileSync(file, "utf8"));
    let match;
    while ((match = stringRegex.exec(text))) {
      const specifier = match[1];
      if (/\s/.test(specifier)) continue;
      const packageName = packageNames.find(
        (name) => specifier === name || specifier.startsWith(`${name}/`),
      );
      if (!packageName || specifier === packageName) continue;
      if (specifier.endsWith("/package.json")) continue;
      const owner = findOwningPackage(file, packages);
      references.push({
        file: path.relative(ROOT, file),
        owner: owner?.name ?? null,
        packageName,
        specifier,
        subpath: specifier.slice(packageName.length + 1),
        asset: isAssetSpecifier(specifier),
        selfImport: owner?.name === packageName,
      });
    }
  }
  return references;
}

function getExportTarget(entry) {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object") return null;
  for (const key of ["import", "default", "types", "browser", "node"]) {
    const value = entry[key];
    if (typeof value === "string") return value;
    const nested = getExportTarget(value);
    if (nested) return nested;
  }
  return null;
}

function listPackageExports(pkg) {
  const exportsField = pkg.manifest.exports;
  if (!exportsField || typeof exportsField !== "object") return [];
  return Object.entries(exportsField)
    .filter(([key]) => key !== "." && key !== "./package.json")
    .map(([key, value]) => {
      const target = getExportTarget(value);
      const asset = isAssetSpecifier(key) || (target && isAssetSpecifier(target));
      const wildcard = key.includes("*") || String(target ?? "").includes("*");
      return {
        packageName: pkg.name,
        packageJson: pkg.packageJsonRel,
        key,
        target,
        asset,
        wildcard,
        platform: PLATFORM_EXPORT_KEYS.has(key),
      };
    });
}

function rootBarrelPath(pkg) {
  if (pkg.name === "@elizaos/core") {
    const nodeEntry = path.join(pkg.dir, "src/index.node.ts");
    if (fs.existsSync(nodeEntry)) return nodeEntry;
  }
  for (const candidate of [
    "src/index.ts",
    "src/index.tsx",
    "src/index.js",
    "src/index.jsx",
  ]) {
    const full = path.join(pkg.dir, candidate);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

function withoutKnownExtension(file) {
  for (const ext of [".d.ts", ".mjs", ".cjs", ".js", ".jsx", ".mts", ".cts", ".ts", ".tsx"]) {
    if (file.endsWith(ext)) return file.slice(0, -ext.length);
  }
  return file;
}

function resolveSourceFromExport(pkg, exportEntry) {
  if (exportEntry.asset || exportEntry.wildcard) return null;
  const rawTarget = exportEntry.target;
  const rawKey = exportEntry.key.slice(2);
  const candidates = [];

  if (rawTarget) {
    let source = rawTarget;
    source = source.replace(/^\.\//, "");
    if (source.startsWith("dist/")) source = `src/${source.slice("dist/".length)}`;
    if (source.startsWith("dist/src/")) source = `src/${source.slice("dist/src/".length)}`;
    if (!source.startsWith("src/") && rawTarget.startsWith("./")) {
      source = `src/${source}`;
    }
    candidates.push(withoutKnownExtension(source));
  }
  candidates.push(`src/${rawKey}`);

  for (const candidate of candidates) {
    for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"]) {
      const full = path.join(pkg.dir, `${candidate}${ext}`);
      if (fs.existsSync(full)) return full;
    }
    for (const index of ["index.ts", "index.tsx", "index.js", "index.jsx"]) {
      const full = path.join(pkg.dir, candidate, index);
      if (fs.existsSync(full)) return full;
    }
  }
  return null;
}

function normalizeModuleSpecifier(specifier) {
  return specifier
    .replace(/^\.\//, "")
    .replace(/\/index$/, "")
    .replace(/\.(js|jsx|ts|tsx|mjs|mts|cjs|cts)$/, "");
}

function existingRootExports(rootFile) {
  if (!rootFile || !fs.existsSync(rootFile)) return new Set();
  const text = fs.readFileSync(rootFile, "utf8");
  const exports = new Set();
  const regex =
    /export\s+(?:type\s+)?(?:\*\s+from|\{[\s\S]*?\}\s+from)\s+["']([^"']+)["']/g;
  let match;
  while ((match = regex.exec(text))) {
    exports.add(normalizeModuleSpecifier(match[1]));
  }
  return exports;
}

function rootUsesJsExtensions(rootFile) {
  if (!rootFile || !fs.existsSync(rootFile)) return false;
  const text = fs.readFileSync(rootFile, "utf8");
  const matches = [...text.matchAll(/export\s+[^"']+["']([^"']+)["']/g)];
  if (matches.length === 0) return true;
  const withJs = matches.filter((match) => /\.(js|mjs|cjs)["']?$/.test(match[1]));
  return withJs.length >= matches.length / 2;
}

function barrelSpecifier(rootFile, sourceFile) {
  let relative = path.relative(path.dirname(rootFile), sourceFile);
  if (!relative.startsWith(".")) relative = `./${relative}`;
  relative = relative.replace(/\\/g, "/");
  relative = withoutKnownExtension(relative);
  if (relative.endsWith("/index")) relative = relative.slice(0, -"/index".length);
  if (rootUsesJsExtensions(rootFile)) return `${relative}.js`;
  return relative;
}

function collectAudit(packages) {
  const imports = findImports(packages);
  const stringReferences = findStringReferences(packages);
  const exports = packages.flatMap(listPackageExports);
  const rootBarrels = packages.map((pkg) => {
    const root = rootBarrelPath(pkg);
    const packageExports = listPackageExports(pkg);
    return {
      packageName: pkg.name,
      root: root ? path.relative(ROOT, root) : null,
      nonRootExports: packageExports.length,
      explicitExports: packageExports.filter((entry) => !entry.asset && !entry.wildcard).length,
      wildcardExports: packageExports.filter((entry) => entry.wildcard).length,
      assetExports: packageExports.filter((entry) => entry.asset).length,
      platformExports: packageExports.filter((entry) => entry.platform).length,
    };
  });
  return { packages, imports, stringReferences, exports, rootBarrels };
}

function planTransforms(audit, args) {
  const packageByName = new Map(audit.packages.map((pkg) => [pkg.name, pkg]));
  const packageFilter = (name) =>
    args.packageNames.size === 0 || args.packageNames.has(name);
  const importRewrites = [];
  const rootBarrelAdds = [];
  const exportMapCollapses = [];
  const manual = [];

  for (const imp of audit.imports) {
    if (imp.asset) continue;
    if (!packageFilter(imp.packageName)) continue;
    importRewrites.push({
      file: imp.file,
      from: imp.specifier,
      to: imp.packageName,
      reason: "source subpath import",
    });
  }

  for (const pkg of audit.packages) {
    if (!packageFilter(pkg.name)) continue;
    const root = rootBarrelPath(pkg);
    const existing = existingRootExports(root);
    const packageExports = listPackageExports(pkg);
    for (const exp of packageExports) {
      if (exp.asset) continue;
      if (exp.wildcard) {
        manual.push({
          packageName: pkg.name,
          key: exp.key,
          reason: "wildcard export needs a package-level barrel decision",
        });
        continue;
      }
      if (exp.platform) {
        manual.push({
          packageName: pkg.name,
          key: exp.key,
          reason: "platform export should become a root conditional export, not a blind barrel",
        });
        continue;
      }
      const source = resolveSourceFromExport(pkg, exp);
      if (!root || !source) {
        manual.push({
          packageName: pkg.name,
          key: exp.key,
          target: exp.target,
          reason: root
            ? "could not resolve export target to a source module"
            : "package has no root source barrel",
        });
        continue;
      }
      const specifier = barrelSpecifier(root, source);
      const normalized = normalizeModuleSpecifier(specifier);
      if (!existing.has(normalized)) {
        rootBarrelAdds.push({
          packageName: pkg.name,
          file: path.relative(ROOT, root),
          specifier,
          line: `export * from "${specifier}";`,
          key: exp.key,
        });
        existing.add(normalized);
      }
    }

    if (args.collapseExplicitExports) {
      const collapsibleKeys = packageExports
        .filter((exp) => !exp.asset && !exp.wildcard && !exp.platform)
        .map((exp) => exp.key);
      if (args.collapseWildcardExports) {
        collapsibleKeys.push(
          ...packageExports
            .filter((exp) => !exp.asset && exp.wildcard && !exp.platform)
            .map((exp) => exp.key),
        );
      }
      if (collapsibleKeys.length > 0) {
        exportMapCollapses.push({
          packageName: pkg.name,
          packageJson: pkg.packageJsonRel,
          remove: collapsibleKeys,
        });
      }
    }
  }

  return { importRewrites, rootBarrelAdds, exportMapCollapses, manual };
}

function replaceImportSpecifiers(file, replacements) {
  let text = fs.readFileSync(path.join(ROOT, file), "utf8");
  const unique = new Map();
  for (const replacement of replacements) unique.set(replacement.from, replacement.to);
  for (const [from, to] of unique) {
    text = text
      .replaceAll(`"${from}"`, `"${to}"`)
      .replaceAll(`'${from}'`, `'${to}'`);
  }
  fs.writeFileSync(path.join(ROOT, file), text);
}

function applyTransforms(plan, audit, args) {
  if (args.rewriteImports) {
    const byFile = new Map();
    for (const rewrite of plan.importRewrites) {
      if (!byFile.has(rewrite.file)) byFile.set(rewrite.file, []);
      byFile.get(rewrite.file).push(rewrite);
    }
    for (const [file, replacements] of byFile) {
      replaceImportSpecifiers(file, replacements);
    }
  }

  if (args.addRootBarrels) {
    const byFile = new Map();
    for (const add of plan.rootBarrelAdds) {
      if (!byFile.has(add.file)) byFile.set(add.file, []);
      byFile.get(add.file).push(add.line);
    }
    for (const [file, lines] of byFile) {
      const abs = path.join(ROOT, file);
      const text = fs.readFileSync(abs, "utf8");
      const prefix = text.endsWith("\n") ? text : `${text}\n`;
      fs.writeFileSync(abs, `${prefix}${[...new Set(lines)].join("\n")}\n`);
    }
  }

  if (args.collapseExplicitExports) {
    const packageByRel = new Map(audit.packages.map((pkg) => [pkg.packageJsonRel, pkg]));
    for (const collapse of plan.exportMapCollapses) {
      const pkg = packageByRel.get(collapse.packageJson);
      if (!pkg) continue;
      const manifest = readJson(pkg.packageJsonPath);
      for (const key of collapse.remove) {
        delete manifest.exports[key];
      }
      writeJson(pkg.packageJsonPath, manifest);
    }
  }
}

function groupBy(items, keyFn) {
  const grouped = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  }
  return grouped;
}

function writeReports(audit, plan, args) {
  ensureDir(args.json);
  fs.writeFileSync(
    path.join(ROOT, args.json),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        summary: {
          packages: audit.packages.length,
          sourceSubpathImports: audit.imports.length,
          sourceSubpathStringReferences: audit.stringReferences.length,
          nonRootExports: audit.exports.length,
          importRewrites: plan.importRewrites.length,
          rootBarrelAdds: plan.rootBarrelAdds.length,
          exportMapCollapses: plan.exportMapCollapses.reduce(
            (sum, item) => sum + item.remove.length,
            0,
          ),
          manual: plan.manual.length,
        },
        imports: audit.imports,
        stringReferences: audit.stringReferences,
        exports: audit.exports,
        rootBarrels: audit.rootBarrels,
        plan,
      },
      null,
      2,
    )}\n`,
  );

  const sourceImports = groupBy(audit.imports, (item) => item.specifier);
  const stringReferences = groupBy(
    audit.stringReferences,
    (item) => item.specifier,
  );
  const exportsByPackage = groupBy(audit.exports, (item) => item.packageName);
  const lines = [];
  lines.push("# Barrel Audit");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Workspace packages: ${audit.packages.length}`);
  lines.push(`- Source subpath import/export sites: ${audit.imports.length}`);
  lines.push(
    `- Source subpath string references: ${audit.stringReferences.length}`,
  );
  lines.push(`- Non-root package export entries: ${audit.exports.length}`);
  lines.push(`- Planned import rewrites: ${plan.importRewrites.length}`);
  lines.push(`- Planned root barrel additions: ${plan.rootBarrelAdds.length}`);
  lines.push(
    `- Planned explicit export-map removals: ${plan.exportMapCollapses.reduce(
      (sum, item) => sum + item.remove.length,
      0,
    )}`,
  );
  lines.push(`- Manual review items: ${plan.manual.length}`);
  lines.push("");
  lines.push("## Source Subpath Imports");
  lines.push("");
  for (const [specifier, imports] of [...sourceImports.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  )) {
    lines.push(`### ${specifier} (${imports.length})`);
    for (const item of imports) {
      lines.push(`- ${item.file}${item.asset ? " (asset)" : ""}`);
    }
    lines.push("");
  }
  lines.push("## Source Subpath String References");
  lines.push("");
  for (const [specifier, references] of [...stringReferences.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  )) {
    lines.push(`### ${specifier} (${references.length})`);
    for (const item of references) {
      lines.push(`- ${item.file}${item.asset ? " (asset)" : ""}`);
    }
    lines.push("");
  }
  lines.push("## Non-Root Exports By Package");
  lines.push("");
  for (const [packageName, entries] of [...exportsByPackage.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  )) {
    const explicit = entries.filter((entry) => !entry.asset && !entry.wildcard);
    const wildcard = entries.filter((entry) => entry.wildcard);
    const assets = entries.filter((entry) => entry.asset);
    lines.push(
      `### ${packageName} (${entries.length}; explicit ${explicit.length}, wildcard ${wildcard.length}, asset ${assets.length})`,
    );
    for (const entry of entries) {
      const tags = [
        entry.asset ? "asset" : null,
        entry.wildcard ? "wildcard" : null,
        entry.platform ? "platform" : null,
      ]
        .filter(Boolean)
        .join(", ");
      lines.push(
        `- ${entry.key}${entry.target ? ` -> ${entry.target}` : ""}${
          tags ? ` (${tags})` : ""
        }`,
      );
    }
    lines.push("");
  }
  lines.push("## Planned Import Rewrites");
  lines.push("");
  for (const item of plan.importRewrites) {
    lines.push(`- ${item.file}: ${item.from} -> ${item.to}`);
  }
  lines.push("");
  lines.push("## Planned Root Barrel Additions");
  lines.push("");
  for (const item of plan.rootBarrelAdds) {
    lines.push(`- ${item.file}: ${item.line} (${item.key})`);
  }
  lines.push("");
  lines.push("## Planned Explicit Export-Map Removals");
  lines.push("");
  for (const item of plan.exportMapCollapses) {
    lines.push(`- ${item.packageJson}: ${item.remove.join(", ")}`);
  }
  lines.push("");
  lines.push("## Manual Review");
  lines.push("");
  for (const item of plan.manual) {
    lines.push(
      `- ${item.packageName} ${item.key}: ${item.reason}${
        item.target ? ` (${item.target})` : ""
      }`,
    );
  }
  lines.push("");

  ensureDir(args.report);
  fs.writeFileSync(path.join(ROOT, args.report), `${lines.join("\n")}\n`);
}

const args = parseArgs(process.argv.slice(2));
const packages = discoverPackages();
const audit = collectAudit(packages);
const plan = planTransforms(audit, args);
writeReports(audit, plan, args);

console.log(args.apply ? "Applying barrel transform..." : "Dry run only.");
console.log(`Packages: ${audit.packages.length}`);
console.log(`Source subpath imports: ${audit.imports.length}`);
console.log(`Source subpath string references: ${audit.stringReferences.length}`);
console.log(`Non-root export entries: ${audit.exports.length}`);
console.log(`Planned import rewrites: ${plan.importRewrites.length}`);
console.log(`Planned root barrel additions: ${plan.rootBarrelAdds.length}`);
console.log(
  `Planned explicit export-map removals: ${plan.exportMapCollapses.reduce(
    (sum, item) => sum + item.remove.length,
    0,
  )}`,
);
console.log(`Manual review items: ${plan.manual.length}`);
console.log(`Report: ${args.report}`);
console.log(`JSON: ${args.json}`);

if (args.apply) {
  applyTransforms(plan, audit, args);
  console.log("Applied.");
}

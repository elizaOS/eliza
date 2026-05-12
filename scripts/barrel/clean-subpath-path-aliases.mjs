#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import * as ts from "typescript";

const ROOT = process.cwd();
const WORKSPACE_BASES = [
  "packages",
  "plugins",
  "cloud/packages",
  "cloud/apps",
  "packages/native-plugins",
];
const GENERATED_DIRS = new Set([
  ".claude",
  ".codex",
  ".git",
  ".turbo",
  ".vite",
  ".wrangler",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);
const SCOPE_WILDCARDS = new Set(["@elizaos/*", "@elizaai/*", "@clawville/*"]);

function parseArgs(argv) {
  const args = {
    apply: false,
    report: "reports/path-alias-audit.md",
    json: "reports/path-alias-audit.json",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--dry-run") args.apply = false;
    else if (arg === "--report") args.report = argv[++i];
    else if (arg === "--json") args.json = argv[++i];
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
  console.log(`Usage: node scripts/barrel/clean-subpath-path-aliases.mjs [options]

Default mode is dry-run. The script always writes an audit report.

Options:
  --apply          Remove workspace package subpath aliases from tsconfig paths.
  --dry-run        Preview only. This is the default.
  --report <path>  Markdown report path.
  --json <path>    JSON report path.
`);
}

function readJson(file) {
  if (path.basename(file).startsWith("tsconfig")) {
    const parsed = ts.parseConfigFileTextToJson(
      file,
      fs.readFileSync(file, "utf8"),
    );
    if (parsed.error) {
      const message = ts.flattenDiagnosticMessageText(
        parsed.error.messageText,
        "\n",
      );
      throw new Error(message);
    }
    return parsed.config;
  }
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
      });
    }
  }
  packages.sort((left, right) => right.name.length - left.name.length);
  return packages;
}

function rootBarrelPath(pkg, mode) {
  const sourceCandidates =
    pkg.name === "@elizaos/core"
      ? ["src/index.node.ts", "src/index.ts", "index.ts", "index.js"]
      : [
          "src/index.ts",
          "src/index.tsx",
          "src/index.js",
          "src/index.jsx",
          "index.ts",
          "index.js",
        ];
  const distCandidates = [
    "dist/index.d.ts",
    "dist/index.d.mts",
    "dist/index.d.cts",
    "dist/index.js",
    "dist/src/index.d.ts",
    "dist/src/index.js",
  ];
  const candidates = mode === "dist" ? distCandidates : sourceCandidates;
  for (const candidate of candidates) {
    const full = path.join(pkg.dir, candidate);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

function inferMode(targets) {
  return targets.some(
    (target) => target.includes("/dist/") || target.startsWith("dist/"),
  )
    ? "dist"
    : "source";
}

function relativeFromTsconfig(tsconfigPath, target) {
  const relative = path
    .relative(path.dirname(tsconfigPath), target)
    .replace(/\\/g, "/");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function findTsconfigs() {
  const files = [];
  walk(ROOT, (file) => {
    if (path.basename(file).startsWith("tsconfig") && file.endsWith(".json")) {
      files.push(file);
    }
  });
  return files.sort((left, right) => left.localeCompare(right));
}

function workspacePackageForAlias(alias, packages) {
  for (const pkg of packages) {
    if (alias === pkg.name || alias.startsWith(`${pkg.name}/`)) return pkg;
  }
  return null;
}

function scopedPackageName(alias) {
  const match = alias.match(/^@(?:elizaos|elizaai|clawville)\/[^/]+/);
  return match ? match[0] : null;
}

function isScopedPackageSubpathAlias(alias) {
  const packageName = scopedPackageName(alias);
  return Boolean(packageName && alias !== packageName);
}

function collectPlan(packages) {
  const removals = [];
  const additions = [];
  const manual = [];
  const files = [];

  for (const tsconfigPath of findTsconfigs()) {
    const rel = path.relative(ROOT, tsconfigPath);
    let json;
    try {
      json = readJson(tsconfigPath);
    } catch (error) {
      manual.push({
        file: rel,
        reason: `could not parse JSON: ${error.message}`,
      });
      continue;
    }

    const paths = json.compilerOptions?.paths;
    if (!paths || typeof paths !== "object") continue;

    const removeKeys = [];
    const addEntries = [];
    const existingKeys = new Set(Object.keys(paths));

    for (const [alias, targets] of Object.entries(paths)) {
      const pkg = workspacePackageForAlias(alias, packages);
      const isScopeWildcard = SCOPE_WILDCARDS.has(alias);
      const genericSubpath = isScopedPackageSubpathAlias(alias);
      const isPackageSubpath = pkg && alias !== pkg.name;
      if (!isScopeWildcard && !isPackageSubpath && !genericSubpath) continue;

      removeKeys.push(alias);
      removals.push({
        file: rel,
        alias,
        targets,
        packageName: pkg?.name ?? scopedPackageName(alias),
        reason: isScopeWildcard
          ? "workspace scope wildcard path alias"
          : pkg
            ? "workspace package subpath path alias"
            : "scoped package subpath path alias",
      });

      if (!pkg || existingKeys.has(pkg.name)) continue;
      const targetList = Array.isArray(targets) ? targets : [];
      const root = rootBarrelPath(pkg, inferMode(targetList));
      if (!root) {
        manual.push({
          file: rel,
          alias,
          packageName: pkg.name,
          reason:
            "removed subpath alias but package has no discoverable root barrel for a replacement root path",
        });
        continue;
      }
      const rootTarget = relativeFromTsconfig(tsconfigPath, root);
      addEntries.push([pkg.name, [rootTarget]]);
      additions.push({
        file: rel,
        alias: pkg.name,
        targets: [rootTarget],
        from: alias,
      });
      existingKeys.add(pkg.name);
    }

    if (removeKeys.length > 0 || addEntries.length > 0) {
      files.push({
        file: rel,
        remove: removeKeys,
        add: Object.fromEntries(addEntries),
      });
    }
  }

  return { removals, additions, manual, files };
}

function applyPlan(plan) {
  for (const filePlan of plan.files) {
    const tsconfigPath = path.join(ROOT, filePlan.file);
    const json = readJson(tsconfigPath);
    const paths = json.compilerOptions?.paths;
    if (!paths) continue;
    for (const key of filePlan.remove) delete paths[key];
    for (const [key, value] of Object.entries(filePlan.add)) {
      if (!paths[key]) paths[key] = value;
    }
    writeJson(tsconfigPath, json);
  }
}

function writeReports(plan, args) {
  const summary = {
    files: plan.files.length,
    removals: plan.removals.length,
    additions: plan.additions.length,
    manual: plan.manual.length,
  };
  ensureDir(args.json);
  fs.writeFileSync(
    path.join(ROOT, args.json),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), summary, plan }, null, 2)}\n`,
  );

  const lines = [];
  lines.push("# Path Alias Audit");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Files with planned changes: ${summary.files}`);
  lines.push(`- Subpath aliases removed: ${summary.removals}`);
  lines.push(`- Root aliases added: ${summary.additions}`);
  lines.push(`- Manual review items: ${summary.manual}`);
  lines.push("");
  lines.push("## Planned Removals");
  lines.push("");
  for (const removal of plan.removals) {
    lines.push(`- ${removal.file}: ${removal.alias}`);
  }
  lines.push("");
  lines.push("## Planned Additions");
  lines.push("");
  for (const addition of plan.additions) {
    lines.push(
      `- ${addition.file}: ${addition.alias} -> ${addition.targets.join(", ")}`,
    );
  }
  lines.push("");
  lines.push("## Manual Review");
  lines.push("");
  for (const item of plan.manual) {
    lines.push(
      `- ${item.file}${item.alias ? ` (${item.alias})` : ""}: ${item.reason}`,
    );
  }
  lines.push("");

  ensureDir(args.report);
  fs.writeFileSync(path.join(ROOT, args.report), `${lines.join("\n")}\n`);
}

const args = parseArgs(process.argv.slice(2));
const packages = discoverPackages();
const plan = collectPlan(packages);
writeReports(plan, args);

console.log(args.apply ? "Applying path alias cleanup..." : "Dry run only.");
console.log(`Files with planned changes: ${plan.files.length}`);
console.log(`Subpath aliases removed: ${plan.removals.length}`);
console.log(`Root aliases added: ${plan.additions.length}`);
console.log(`Manual review items: ${plan.manual.length}`);
console.log(`Report: ${args.report}`);
console.log(`JSON: ${args.json}`);

if (args.apply) {
  applyPlan(plan);
  console.log("Applied.");
}

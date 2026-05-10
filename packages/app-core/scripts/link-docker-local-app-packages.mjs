#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { resolveRepoRootFromImportMeta } from "./lib/repo-root.mjs";
import { collectWorkspaceMaps } from "./lib/workspace-discovery.mjs";

const repoRoot = resolveRepoRootFromImportMeta(import.meta.url);
const rootPkg = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
);
const { workspaceDirs } = collectWorkspaceMaps(
  repoRoot,
  rootPkg.workspaces ?? [],
);
const localPackages = [
  "eliza/plugins/app-companion",
  "eliza/plugins/app-elizamaker",
  "eliza/plugins/app-documents",
  "eliza/plugins/app-lifeops",
  "eliza/plugins/app-steward",
  "eliza/plugins/app-task-coordinator",
  "eliza/plugins/app-training",
  "eliza/plugins/app-shopify",
  "eliza/plugins/app-vincent",
  "eliza/packages/app-core",
  "eliza/packages/shared",
  "eliza/packages/skills",
  "eliza/packages/ui",
  "eliza/packages/vault",
  "eliza/plugins/plugin-agent-skills",
  "eliza/plugins/plugin-browser",
  "eliza/plugins/plugin-computeruse",
  "eliza/plugins/plugin-local-embedding",
  "eliza/plugins/plugin-pdf",
  "eliza/packages/native-plugins/activity-tracker",
  "eliza/plugins/plugin-sql",
  "eliza/plugins/plugin-telegram",
];

function resolveSourceExportPath(packageDir, exportPath) {
  if (typeof exportPath !== "string" || !exportPath.startsWith("./dist/")) {
    return exportPath;
  }

  if (pathExists(path.join(packageDir, exportPath))) {
    return exportPath;
  }

  const sourcePath = exportPath
    .replace("./dist/", "./src/")
    .replace(/\.d\.ts$/, ".ts")
    .replace(/\.js$/, ".ts");
  if (pathExists(path.join(packageDir, sourcePath))) {
    return sourcePath;
  }

  const rootEntrypointPath = exportPath
    .replace("./dist/node/", "./")
    .replace("./dist/browser/", "./")
    .replace("./dist/", "./")
    .replace(/\.d\.ts$/, ".ts")
    .replace(/\.js$/, ".ts");
  return pathExists(path.join(packageDir, rootEntrypointPath))
    ? rootEntrypointPath
    : exportPath;
}

function rewriteDistExportsToSource(packageDir, pkg) {
  let changed = false;

  function rewrite(value, key = "") {
    if (key === "types") {
      return value;
    }
    if (typeof value === "string") {
      const next = resolveSourceExportPath(packageDir, value);
      changed ||= next !== value;
      return next;
    }
    if (Array.isArray(value)) {
      return value.map((item) => rewrite(item));
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([entryKey, entry]) => [
          entryKey,
          rewrite(entry, entryKey),
        ]),
      );
    }
    return value;
  }

  const nextPkg = { ...pkg };
  nextPkg.main = rewrite(pkg.main);
  nextPkg.module = rewrite(pkg.module);
  nextPkg.types = pkg.types;
  nextPkg.exports = rewrite(pkg.exports);

  return { changed, pkg: changed ? nextPkg : pkg };
}

const shimSkipEntries = new Set([
  ".git",
  ".turbo",
  "node_modules",
  "package.json",
]);

function linkPackageContents(packageDir, target) {
  for (const entry of fs.readdirSync(packageDir, { withFileTypes: true })) {
    if (shimSkipEntries.has(entry.name)) {
      continue;
    }
    const sourcePath = path.join(packageDir, entry.name);
    const targetPath = path.join(target, entry.name);
    fs.symlinkSync(
      path.relative(path.dirname(targetPath), sourcePath),
      targetPath,
    );
  }
}

function linkPackageTarget({ packageDir, pkg, rewroteExports, target }) {
  removePath(target);
  if (!rewroteExports) {
    fs.symlinkSync(
      path.relative(path.dirname(target), packageDir),
      target,
      "dir",
    );
    return;
  }

  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(
    path.join(target, "package.json"),
    `${JSON.stringify(pkg, null, 2)}\n`,
  );
  linkPackageContents(packageDir, target);
}

function pathExists(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function removePath(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(filePath);
      return;
    }
    fs.rmSync(filePath, { force: true, recursive: stat.isDirectory() });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

function resolveRootPackageDir(packageName) {
  const packageDir = path.join(
    repoRoot,
    "node_modules",
    ...packageName.split("/"),
  );
  if (fs.existsSync(path.join(packageDir, "package.json"))) {
    return packageDir;
  }

  const bunStoreDir = path.join(repoRoot, "node_modules", ".bun");
  if (pathExists(bunStoreDir)) {
    const packageSegments = packageName.split("/");
    for (const entry of fs.readdirSync(bunStoreDir).sort().reverse()) {
      const candidate = path.join(
        bunStoreDir,
        entry,
        "node_modules",
        ...packageSegments,
      );
      if (fs.existsSync(path.join(candidate, "package.json"))) {
        return candidate;
      }
    }
  }

  throw new Error(
    `Missing root package manifest: node_modules/${packageName}/package.json`,
  );
}

function linkRootDependency({ packageName, target }) {
  const packageDir = resolveRootPackageDir(packageName);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  removePath(target);
  fs.symlinkSync(
    path.relative(path.dirname(target), packageDir),
    target,
    "dir",
  );
}

function resolveLocalPackageDir(packagePath) {
  const candidates = [packagePath];
  if (packagePath.startsWith("eliza/")) {
    candidates.push(packagePath.slice("eliza/".length));
  }

  for (const candidate of candidates) {
    const packageDir = path.join(repoRoot, candidate);
    if (fs.existsSync(path.join(packageDir, "package.json"))) {
      return packageDir;
    }
  }

  throw new Error(
    `Missing local package manifest: ${candidates
      .map((candidate) =>
        path.relative(repoRoot, path.join(repoRoot, candidate, "package.json")),
      )
      .join(" or ")}`,
  );
}

function collectScopeDirs() {
  const scopeDirs = new Set([path.join(repoRoot, "node_modules", "@elizaos")]);
  for (const workspaceDir of workspaceDirs) {
    const scopeDir = path.join(workspaceDir, "node_modules", "@elizaos");
    if (pathExists(scopeDir)) {
      scopeDirs.add(scopeDir);
    }
  }
  return [...scopeDirs].sort();
}

let linked = 0;
const scopeDirs = collectScopeDirs();
for (const scopeDir of scopeDirs) {
  fs.mkdirSync(scopeDir, { recursive: true });
}

for (const packagePath of localPackages) {
  const packageDir = resolveLocalPackageDir(packagePath);
  const packageJsonPath = path.join(packageDir, "package.json");

  let pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  if (typeof pkg.name !== "string" || !pkg.name.startsWith("@elizaos/")) {
    throw new Error(
      `Invalid local package name in ${path.relative(repoRoot, packageJsonPath)}`,
    );
  }
  const rewriteResult = rewriteDistExportsToSource(packageDir, pkg);
  pkg = rewriteResult.pkg;

  const packageName = pkg.name.slice("@elizaos/".length);
  for (const scopeDir of scopeDirs) {
    const target = path.join(scopeDir, packageName);
    if (scopeDir !== path.join(repoRoot, "node_modules", "@elizaos")) {
      if (!pathExists(target)) {
        continue;
      }
    }
    linkPackageTarget({
      packageDir,
      pkg,
      rewroteExports: rewriteResult.changed,
      target,
    });
    linked += 1;
  }

  if (pkg.name === "@elizaos/plugin-sql") {
    const pluginSqlRootDeps = [
      "@electric-sql/pglite",
      "@neondatabase/serverless",
      "dotenv",
      "drizzle-orm",
      "pg",
      "uuid",
      "ws",
    ];
    for (const rootDep of pluginSqlRootDeps) {
      linkRootDependency({
        packageName: rootDep,
        target: path.join(packageDir, "node_modules", rootDep),
      });
      linkRootDependency({
        packageName: rootDep,
        target: path.join(packageDir, "typescript", "node_modules", rootDep),
      });
      // Also ensure root-level node_modules has it so ESM resolution always
      // finds the package regardless of which symlink depth Node traverses.
      try {
        linkRootDependency({
          packageName: rootDep,
          target: path.join(repoRoot, "node_modules", rootDep),
        });
      } catch {
        // Not all deps may be installed; non-fatal.
      }
    }
  }

  if (pkg.name === "@elizaos/app-core") {
    for (const rootDep of ["@node-rs/argon2", "jose"]) {
      linkRootDependency({
        packageName: rootDep,
        target: path.join(packageDir, "node_modules", rootDep),
      });
      // Also ensure root-level node_modules has it so ESM resolution always
      // finds the package regardless of which symlink depth Node traverses.
      linkRootDependency({
        packageName: rootDep,
        target: path.join(repoRoot, "node_modules", rootDep),
      });
    }
  }
}

console.log(
  `[docker-local-apps] linked ${linked} local package entr${linked === 1 ? "y" : "ies"}`,
);

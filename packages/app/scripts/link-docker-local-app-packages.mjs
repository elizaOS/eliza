#!/usr/bin/env node
/** Links workspace packages into the prebuilt agent Docker image. */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { collectDockerWorkspaceDirs } from "./collect-docker-runtime-deps.mjs";
import { resolveRepoRootFromImportMeta } from "./lib/repo-root.mjs";
import { collectWorkspaceMaps } from "./lib/workspace-discovery.mjs";

const repoRoot = resolveRepoRootFromImportMeta(import.meta.url);
const recursiveCleanupScript = path.join(
  repoRoot,
  "packages/scripts/rm-path-recursive.mjs",
);
const rootPkg = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
);
const { workspaceDirs } = collectWorkspaceMaps(
  repoRoot,
  rootPkg.workspaces ?? [],
);

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

  // rewroteExports === true means this package had no built dist, so its
  // exports were rewritten from ./dist/*.js to ./src/*.ts (rewriteDistExportsToSource).
  // The production image now starts the agent under plain `node` (no tsx loader,
  // #8837), so importing a .ts entry at runtime throws ERR_UNKNOWN_FILE_EXTENSION
  // on the core boot path or silently fails an app-route plugin (post-ready,
  // swallowed → that plugin registers zero routes). Surface it loudly so a
  // missing-dist build is visible instead of shipping a half-broken image.
  console.warn(
    `[link-docker] WARNING: ${pkg.name ?? "(unknown package)"} has no built dist; ` +
      "its exports were rewritten to .ts source. The production agent starts under " +
      "plain node (tsx removed in #8837), so this package will fail to import at " +
      "runtime — build its dist before imaging.",
  );

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

function removeDirectoryRecursive(filePath) {
  try {
    execFileSync("node", [recursiveCleanupScript, filePath], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (error) {
    const detail = [error?.stdout, error?.stderr].filter(Boolean).join("\n");
    throw new Error(
      `Failed to remove directory ${filePath}${detail ? `: ${detail}` : ""}`,
      { cause: error },
    );
  }
}

function removePath(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(filePath);
      return;
    }
    if (stat.isDirectory()) {
      removeDirectoryRecursive(filePath);
      return;
    }
    fs.rmSync(filePath, { force: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

function resolveDependencyPackageDir(packageName, baseDirs = [repoRoot]) {
  const packageSegments = packageName.split("/");
  // Return the realpath so `linkDependencyPackage`'s `packageDir === target`
  // check works when a previous loop iteration already symlinked the dep
  // (avoids circular symlinks like jose → app/jose → root jose).
  const realIfExists = (dir) => {
    if (!fs.existsSync(path.join(dir, "package.json"))) return null;
    try {
      return fs.realpathSync(dir);
    } catch {
      return null;
    }
  };
  for (const baseDir of baseDirs) {
    const real = realIfExists(
      path.join(baseDir, "node_modules", ...packageSegments),
    );
    if (real) return real;
  }

  for (const baseDir of baseDirs) {
    const bunStoreDir = path.join(baseDir, "node_modules", ".bun");
    if (pathExists(bunStoreDir)) {
      for (const entry of fs.readdirSync(bunStoreDir).sort().reverse()) {
        const real = realIfExists(
          path.join(bunStoreDir, entry, "node_modules", ...packageSegments),
        );
        if (real) return real;
      }
    }
  }

  throw new Error(
    `Missing package manifest: ${baseDirs
      .map((baseDir) =>
        path.relative(
          repoRoot,
          path.join(
            baseDir,
            "node_modules",
            ...packageSegments,
            "package.json",
          ),
        ),
      )
      .join(" or ")}`,
  );
}

function linkDependencyPackage({ packageDir, target }) {
  if (path.resolve(packageDir) === path.resolve(target)) {
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  removePath(target);
  fs.symlinkSync(
    path.relative(path.dirname(target), packageDir),
    target,
    "dir",
  );
}

function linkDependency({ packageName, target, baseDirs = [repoRoot] }) {
  const packageDir = resolveDependencyPackageDir(packageName, baseDirs);
  linkDependencyPackage({ packageDir, target });
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

const runtimeDirs = collectDockerWorkspaceDirs();
for (const packageDir of runtimeDirs) {
  const packageJsonPath = path.join(packageDir, "package.json");

  let pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  if (typeof pkg.name !== "string" || !pkg.name) {
    throw new Error(
      `Invalid local package name in ${path.relative(repoRoot, packageJsonPath)}`,
    );
  }
  // The agent already points at its published dist manifest in Dockerfile.ci.
  if (pkg.name === "@elizaos/agent") continue;
  const rewriteResult = rewriteDistExportsToSource(packageDir, pkg);
  pkg = rewriteResult.pkg;

  const packageName = pkg.name.startsWith("@elizaos/")
    ? pkg.name.slice("@elizaos/".length)
    : pkg.name;
  const targets = pkg.name.startsWith("@elizaos/")
    ? scopeDirs
    : [path.join(repoRoot, "node_modules")];
  for (const scopeDir of targets) {
    const target = path.join(scopeDir, packageName);
    if (
      scopeDir !== path.join(repoRoot, "node_modules", "@elizaos") &&
      scopeDir !== path.join(repoRoot, "node_modules")
    ) {
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

  if (pkg.name === "@elizaos/app") {
    for (const rootDep of ["@node-rs/argon2", "jose"]) {
      linkDependency({
        packageName: rootDep,
        target: path.join(packageDir, "node_modules", rootDep),
        baseDirs: [packageDir, repoRoot],
      });
      // Also ensure root-level node_modules has it so ESM resolution always
      // finds the package regardless of which symlink depth Node traverses.
      linkDependency({
        packageName: rootDep,
        target: path.join(repoRoot, "node_modules", rootDep),
        baseDirs: [packageDir, repoRoot],
      });
    }
  }
}

// Only the disposable image stage opts into removing plugin sources outside its closure.
if (process.argv.includes("--prune-unlinked-plugins")) {
  const retained = new Set(runtimeDirs);
  const pluginRoot = path.join(repoRoot, "plugins");
  for (const entry of fs.readdirSync(pluginRoot, { withFileTypes: true })) {
    const directory = path.join(pluginRoot, entry.name);
    if (entry.isDirectory() && !retained.has(directory)) removePath(directory);
  }
}

console.log(
  `[docker-local-apps] linked ${linked} local package entr${linked === 1 ? "y" : "ies"}`,
);

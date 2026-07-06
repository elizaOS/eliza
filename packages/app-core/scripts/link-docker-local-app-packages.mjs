#!/usr/bin/env node
/** Supports app-core build, packaging, or development orchestration for link docker local app packages mjs. */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
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
const localPackages = [
  // Foundational workspace packages. These build to ./dist/ but keep their
  // package.json at the package root (no dist/package.json), so they are
  // linked package-root -> package-root here rather than via
  // relink-workspace-packages-to-dist.mjs (which targets <pkg>/dist and
  // requires a dist/package.json). @elizaos/shared declares @elizaos/core as
  // a runtime dep and shared/dist/api/http-helpers.js imports it eagerly, so
  // node_modules/@elizaos/core MUST exist or boot crashes with
  // "Cannot find package '@elizaos/core'". Listed first so they link before
  // any per-package side effects (e.g. the app-core argon2/jose linking).
  "eliza/packages/core",
  "eliza/packages/contracts",
  "eliza/packages/cloud/routing",
  // @elizaos/app-core's registry/index.ts eagerly re-exports
  // `@elizaos/registry/first-party` (#9190 moved the curated app/plugin/connector
  // registry out of app-core into this package). It must be linked or the agent
  // boot crashes with "Cannot find package '@elizaos/registry' imported from
  // .../app-core/dist/registry/index.js". Foundational, so listed up here.
  "eliza/packages/registry",
  // Compatibility package for remote workers that still import
  // @elizaos/plugin-worker-runtime. Keep it linked so those historical imports
  // resolve inside local Docker app packages.
  "eliza/packages/plugin-worker-runtime",
  "eliza/plugins/plugin-documents",
  "eliza/plugins/plugin-personal-assistant",
  "eliza/plugins/plugin-task-coordinator",
  "eliza/plugins/plugin-training",
  "eliza/plugins/plugin-agent-orchestrator",
  "eliza/plugins/plugin-app-control",
  "eliza/plugins/plugin-commands",
  "eliza/packages/plugin-remote-manifest",
  "eliza/packages/auth",
  "eliza/packages/logger",
  "eliza/packages/security",
  "eliza/packages/app-core",
  "eliza/packages/cloud/sdk",
  "eliza/packages/shared",
  "eliza/packages/skills",
  "eliza/packages/ui",
  "eliza/packages/vault",
  "eliza/plugins/plugin-agent-skills",
  "eliza/plugins/plugin-app-manager",
  "eliza/plugins/plugin-browser",
  "eliza/plugins/plugin-capacitor-bridge",
  "eliza/plugins/plugin-coding-tools",
  "eliza/plugins/plugin-computeruse",
  "eliza/plugins/plugin-discord",
  "eliza/plugins/plugin-elizacloud",
  "eliza/plugins/plugin-imessage",
  "eliza/plugins/plugin-local-inference",
  "eliza/plugins/plugin-mcp",
  "eliza/plugins/plugin-pdf",
  "eliza/plugins/plugin-signal",
  "eliza/plugins/plugin-streaming",
  "eliza/plugins/plugin-native-activity-tracker",
  "eliza/plugins/plugin-sql",
  "eliza/plugins/plugin-telegram",
  "eliza/plugins/plugin-video",
  "eliza/plugins/plugin-wallet",
  "eliza/plugins/plugin-whatsapp",
  "eliza/plugins/plugin-workflow",
  "eliza/plugins/plugin-x402",
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
  // (avoids circular symlinks like jose → app-core/jose → root jose).
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

function resolveRootPackageDir(packageName) {
  return resolveDependencyPackageDir(packageName);
}

function linkRootDependency({ packageName, target }) {
  const packageDir = resolveRootPackageDir(packageName);
  linkDependencyPackage({ packageDir, target });
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

console.log(
  `[docker-local-apps] linked ${linked} local package entr${linked === 1 ? "y" : "ies"}`,
);

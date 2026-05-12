#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_REPO_ROOT = path.resolve(__dirname, "..");

export const LOCAL_UPSTREAM_SKIP_ENVS = ["ELIZA_SKIP_LOCAL_UPSTREAMS"];
export const LOCAL_UPSTREAM_FORCE_ENVS = ["ELIZA_FORCE_LOCAL_UPSTREAMS"];
export const ELIZA_GIT_URL = "https://github.com/elizaos/eliza.git";
export const ELIZA_BRANCH = "develop";
export const ELIZA_REQUIRED_FILES = ["package.json"];
export const ELIZA_BUILD_STEPS = [
  {
    // Fresh CI checkouts do not track generated protobuf types for @elizaos/core.
    // Build the package once so src/types/generated exists before root typecheck/tests.
    check: path.join(
      "packages",
      "typescript",
      "src",
      "types",
      "generated",
      "eliza",
      "v1",
      "agent_pb.ts",
    ),
    cwd: path.join("packages", "typescript"),
    args: ["run", "build"],
    label: "@elizaos/core",
  },
  {
    check: path.join("packages", "prompts", "dist", "typescript", "index.ts"),
    cwd: path.join("packages", "prompts"),
    args: ["run", "build:typescript"],
    label: "@elizaos/prompts",
  },
  {
    check: path.join("packages", "skills", "dist", "index.js"),
    cwd: path.join("packages", "skills"),
    args: ["run", "build"],
    label: "@elizaos/skills",
  },
  {
    // plugin-elizacloud imports types from @elizaos/cloud-sdk; without dist
    // its tsup --dts pass fails with TS2307.
    check: path.join("cloud", "packages", "sdk", "dist", "index.d.ts"),
    cwd: path.join("cloud", "packages", "sdk"),
    args: ["run", "build"],
    label: "@elizaos/cloud-sdk",
  },
  {
    // plugin-streaming imports isCloudConnected from @elizaos/cloud-routing;
    // without dist its tsup --dts pass fails with TS2307.
    check: path.join("packages", "cloud-routing", "dist", "index.js"),
    cwd: path.join("packages", "cloud-routing"),
    args: ["run", "build"],
    label: "@elizaos/cloud-routing",
  },
];

const PACKAGE_LINK_ROOTS = [
  ["node_modules"],
  ["apps", "app", "node_modules"],
  ["apps", "home", "node_modules"],
];

function toDisplayPath(targetPath) {
  return path.normalize(targetPath);
}

function runCommand(command, args, { cwd, env = process.env, label } = {}) {
  const printable = label ?? `${command} ${args.join(" ")}`;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: "inherit",
    });

    child.on("error", (error) => {
      reject(
        new Error(
          `${printable} failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    });

    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${printable} exited due to signal ${signal}`));
        return;
      }

      if ((code ?? 1) !== 0) {
        reject(new Error(`${printable} exited with code ${code ?? 1}`));
        return;
      }

      resolve();
    });
  });
}

function commandExists(command) {
  const result = spawnSync(command, ["--version"], {
    stdio: "ignore",
  });
  return result.status === 0;
}

function readPackageJson(packageDir) {
  try {
    return JSON.parse(
      readFileSync(path.join(packageDir, "package.json"), "utf8"),
    );
  } catch {
    return null;
  }
}

function uniqueLinks(links) {
  const deduped = new Map();
  for (const link of links) {
    deduped.set(link.linkPath, link);
  }
  return [...deduped.values()];
}

function getForceEnvKey(env = process.env) {
  return LOCAL_UPSTREAM_FORCE_ENVS.find((key) => env[key] === "1") ?? null;
}

export function getRepoElizaRoot(repoRoot = DEFAULT_REPO_ROOT) {
  return path.resolve(repoRoot, "eliza");
}

export function getRepoPluginsRoot(repoRoot = DEFAULT_REPO_ROOT) {
  return path.resolve(repoRoot, "eliza", "plugins");
}

export function getElizaWorkspaceSkipReason(
  repoRoot = DEFAULT_REPO_ROOT,
  { env = process.env, pathExists = existsSync } = {},
) {
  const matchedSkipEnv =
    LOCAL_UPSTREAM_SKIP_ENVS.find((key) => env[key] === "1") ?? null;
  if (matchedSkipEnv) {
    return `${matchedSkipEnv}=1`;
  }

  const devWorkspaceMarkers = [
    path.join(repoRoot, ".git"),
    path.join(repoRoot, "tsconfig.json"),
    path.join(repoRoot, "apps", "app", "vite.config.ts"),
  ];

  const isDevCheckout = devWorkspaceMarkers.every((marker) =>
    pathExists(marker),
  );
  if (!isDevCheckout && !getForceEnvKey(env)) {
    return "non-development install";
  }

  return null;
}

export function shouldSetupElizaWorkspace(
  repoRoot = DEFAULT_REPO_ROOT,
  options,
) {
  return getElizaWorkspaceSkipReason(repoRoot, options) === null;
}

export function hasRequiredElizaWorkspaceFiles(
  elizaRoot,
  { pathExists = existsSync } = {},
) {
  return ELIZA_REQUIRED_FILES.every((relativePath) =>
    pathExists(path.join(elizaRoot, relativePath)),
  );
}

export function hasInstalledElizaDependencies(
  elizaRoot,
  { pathExists = existsSync } = {},
) {
  return (
    pathExists(path.join(elizaRoot, "node_modules", ".bun")) &&
    pathExists(path.join(elizaRoot, "node_modules", ".bin"))
  );
}

function getPackageLinkEntries(repoRoot, packageName, targetPath) {
  if (typeof packageName !== "string" || packageName.length === 0) {
    return [];
  }

  const packageSegments = packageName.startsWith("@")
    ? packageName.split("/").filter(Boolean)
    : [packageName];

  if (
    packageSegments.length === 0 ||
    (packageName.startsWith("@") && packageSegments.length !== 2)
  ) {
    return [];
  }

  return PACKAGE_LINK_ROOTS.map((segments) => ({
    linkPath: path.join(repoRoot, ...segments, ...packageSegments),
    targetPath,
  }));
}

function discoverElizaPackageDirs(elizaRoot) {
  const packageDirs = [];
  for (const parentDir of ["packages", "plugins"]) {
    const searchRoot = path.join(elizaRoot, parentDir);
    if (!existsSync(searchRoot)) {
      continue;
    }

    let entries = [];
    try {
      entries = readdirSync(searchRoot, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        continue;
      }
      const packageDir = path.join(searchRoot, entry.name);
      const packageJson = readPackageJson(packageDir);
      if (packageJson?.name?.startsWith("@elizaos/")) {
        packageDirs.push(packageDir);
      }
    }
  }

  return packageDirs;
}

function discoverPluginPackageDirs(pluginsRoot) {
  if (!existsSync(pluginsRoot)) {
    return [];
  }

  const packageDirs = [];
  let entries = [];
  try {
    entries = readdirSync(pluginsRoot, { withFileTypes: true });
  } catch {
    return packageDirs;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      continue;
    }

    const repoDir = path.join(pluginsRoot, entry.name);
    const tsDir = path.join(repoDir, "typescript");
    const tsPackage = readPackageJson(tsDir);
    if (tsPackage?.name?.startsWith("@elizaos/")) {
      packageDirs.push(tsDir);
      continue;
    }

    const rootPackage = readPackageJson(repoDir);
    const rootName = rootPackage?.name;
    const shouldLinkRoot =
      typeof rootName === "string" &&
      rootName.startsWith("@") &&
      !rootName.endsWith("-root");

    if (shouldLinkRoot) {
      packageDirs.push(repoDir);
    }
  }

  return packageDirs;
}

export function getElizaPackageLinks(
  repoRoot = DEFAULT_REPO_ROOT,
  elizaRoot = getRepoElizaRoot(repoRoot),
) {
  const links = [];
  for (const packageDir of discoverElizaPackageDirs(elizaRoot)) {
    const packageJson = readPackageJson(packageDir);
    links.push(
      ...getPackageLinkEntries(repoRoot, packageJson?.name, packageDir),
    );
  }
  return uniqueLinks(links);
}

export function getPluginPackageLinks(
  repoRoot = DEFAULT_REPO_ROOT,
  pluginsRoot = getRepoPluginsRoot(repoRoot),
) {
  const links = [];
  for (const packageDir of discoverPluginPackageDirs(pluginsRoot)) {
    const packageJson = readPackageJson(packageDir);
    links.push(
      ...getPackageLinkEntries(repoRoot, packageJson?.name, packageDir),
    );
  }
  return uniqueLinks(links);
}

export function getUpstreamPackageLinks(
  repoRoot = DEFAULT_REPO_ROOT,
  {
    elizaRoot = getRepoElizaRoot(repoRoot),
    pluginsRoot = getRepoPluginsRoot(repoRoot),
  } = {},
) {
  const combinedByTarget = new Map();

  for (const link of getElizaPackageLinks(repoRoot, elizaRoot)) {
    combinedByTarget.set(link.linkPath, link);
  }

  for (const link of getPluginPackageLinks(repoRoot, pluginsRoot)) {
    combinedByTarget.set(link.linkPath, link);
  }

  return [...combinedByTarget.values()];
}

export function isPackageLinkCurrent(linkPath, targetPath) {
  if (!existsSync(linkPath) || !existsSync(targetPath)) {
    return false;
  }

  try {
    return realpathSync(linkPath) === realpathSync(targetPath);
  } catch {
    return false;
  }
}

function createLink(linkPath, targetPath, kind = "dir") {
  if (isPackageLinkCurrent(linkPath, targetPath)) {
    return false;
  }

  rmSync(linkPath, {
    force: true,
    recursive: true,
  });

  mkdirSync(path.dirname(linkPath), { recursive: true });

  const linkTarget =
    process.platform === "win32"
      ? targetPath
      : path.relative(path.dirname(linkPath), targetPath) || ".";
  const linkType =
    process.platform === "win32"
      ? kind === "dir"
        ? "junction"
        : "file"
      : kind;

  symlinkSync(linkTarget, linkPath, linkType);
  return true;
}

export function createPackageLink(linkPath, targetPath) {
  return createLink(linkPath, targetPath, "dir");
}

function createBinLink(linkPath, targetPath) {
  return createLink(linkPath, targetPath, "file");
}

function getPackageBinEntries(packageJson) {
  if (!packageJson) {
    return [];
  }

  if (typeof packageJson.bin === "string") {
    const packageBasename = packageJson.name?.split("/").pop();
    if (!packageBasename) {
      return [];
    }
    return [[packageBasename, packageJson.bin]];
  }

  if (!packageJson.bin || typeof packageJson.bin !== "object") {
    return [];
  }

  return Object.entries(packageJson.bin).filter(
    ([binName, binPath]) =>
      typeof binName === "string" &&
      binName.length > 0 &&
      typeof binPath === "string" &&
      binPath.length > 0,
  );
}

function ensurePackageBinLinks(
  packageDir,
  dependencyLinkPath,
  dependencyPackageDir,
) {
  let linkedBins = 0;
  const dependencyPackageJson = readPackageJson(dependencyPackageDir);
  const binEntries = getPackageBinEntries(dependencyPackageJson);
  if (binEntries.length === 0) {
    return linkedBins;
  }

  const packageBinDir = path.join(packageDir, "node_modules", ".bin");
  mkdirSync(packageBinDir, { recursive: true });

  for (const [binName, binRelativePath] of binEntries) {
    const targetFile = path.join(dependencyPackageDir, binRelativePath);
    if (!existsSync(targetFile)) {
      continue;
    }

    const binLinkPath = path.join(packageBinDir, binName);
    const binTargetPath = path.join(dependencyLinkPath, binRelativePath);
    if (createBinLink(binLinkPath, binTargetPath)) {
      linkedBins += 1;
    }
  }

  return linkedBins;
}

function findInstalledPackageDir(
  repoRoot,
  packageName,
  preferredVersion,
  localTargetPath = null,
) {
  const directPackagePath = path.join(
    repoRoot,
    "node_modules",
    ...packageName.split("/"),
  );
  try {
    const resolved = realpathSync(directPackagePath);
    const resolvedLocalTarget =
      localTargetPath && existsSync(localTargetPath)
        ? realpathSync(localTargetPath)
        : null;
    if (existsSync(resolved) && resolved !== resolvedLocalTarget) {
      return directPackagePath;
    }
  } catch {}

  const bunCacheRoot = path.join(repoRoot, "node_modules", ".bun");
  if (!existsSync(bunCacheRoot)) {
    return null;
  }

  const packagePrefix = `${packageName.replace("/", "+")}@`;
  const preferredPrefix =
    preferredVersion === undefined
      ? null
      : `${packageName.replace("/", "+")}@${preferredVersion}+`;
  const matches = [];

  for (const entry of readdirSync(bunCacheRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(packagePrefix)) {
      continue;
    }

    const candidate = path.join(
      bunCacheRoot,
      entry.name,
      "node_modules",
      ...packageName.split("/"),
    );
    if (!existsSync(candidate)) {
      continue;
    }

    matches.push({
      candidate,
      preferred:
        preferredPrefix !== null && entry.name.startsWith(preferredPrefix),
    });
  }

  matches.sort(
    (left, right) => Number(right.preferred) - Number(left.preferred),
  );
  return matches[0]?.candidate ?? null;
}

export function ensurePluginDependencyLinks(
  repoRoot,
  pluginsRoot = getRepoPluginsRoot(repoRoot),
) {
  let linkedDependencies = 0;

  for (const packageDir of discoverPluginPackageDirs(pluginsRoot)) {
    const packageJson = readPackageJson(packageDir);
    const packageName = packageJson?.name;
    if (!packageName?.startsWith("@elizaos/")) {
      continue;
    }

    rmSync(path.join(packageDir, "node_modules", ".bin"), {
      force: true,
      recursive: true,
    });

    const packageDependencies = {
      ...(packageJson.peerDependencies ?? {}),
      ...(packageJson.dependencies ?? {}),
      ...(packageJson.optionalDependencies ?? {}),
      ...(packageJson.devDependencies ?? {}),
    };
    const dependencyNames = Object.keys(packageDependencies);
    if (dependencyNames.length === 0) {
      continue;
    }

    for (const dependencyName of dependencyNames) {
      const installedDependencyDir = findInstalledPackageDir(
        repoRoot,
        dependencyName,
      );
      if (!installedDependencyDir) {
        continue;
      }

      const dependencyLinkPath = path.join(
        packageDir,
        "node_modules",
        ...dependencyName.split("/"),
      );
      if (createPackageLink(dependencyLinkPath, installedDependencyDir)) {
        linkedDependencies += 1;
      }
      linkedDependencies += ensurePackageBinLinks(
        packageDir,
        dependencyLinkPath,
        installedDependencyDir,
      );
    }
  }

  if (linkedDependencies > 0) {
    console.log(
      `[setup-upstreams] Linked ${linkedDependencies} plugin dependency ${linkedDependencies === 1 ? "entry" : "entries"}`,
    );
  }

  return linkedDependencies;
}

export function getPublishedElizaPackageSpecs(repoRoot = DEFAULT_REPO_ROOT) {
  const rootPackageJson = readPackageJson(repoRoot);
  if (!rootPackageJson) {
    return [];
  }

  const collectedSpecs = new Map();
  for (const dependencyGroup of [
    rootPackageJson.dependencies,
    rootPackageJson.devDependencies,
    rootPackageJson.optionalDependencies,
    rootPackageJson.peerDependencies,
  ]) {
    if (!dependencyGroup || typeof dependencyGroup !== "object") {
      continue;
    }

    for (const [packageName, version] of Object.entries(dependencyGroup)) {
      if (
        !packageName.startsWith("@elizaos/") ||
        typeof version !== "string" ||
        version.startsWith("workspace:")
      ) {
        continue;
      }
      collectedSpecs.set(packageName, version);
    }
  }

  return [...collectedSpecs.entries()];
}

export function ensurePublishedElizaPackageLinks(repoRoot = DEFAULT_REPO_ROOT) {
  let linkedEntries = 0;

  for (const [packageName, preferredVersion] of getPublishedElizaPackageSpecs(
    repoRoot,
  )) {
    const installedPackageDir = findInstalledPackageDir(
      repoRoot,
      packageName,
      preferredVersion,
    );
    if (!installedPackageDir) {
      continue;
    }

    for (const { linkPath, targetPath } of getPackageLinkEntries(
      repoRoot,
      packageName,
      installedPackageDir,
    )) {
      if (path.resolve(linkPath) === path.resolve(targetPath)) {
        continue;
      }

      if (createPackageLink(linkPath, targetPath)) {
        linkedEntries += 1;
      }
    }
  }

  if (linkedEntries > 0) {
    console.log(
      `[setup-upstreams] Linked ${linkedEntries} published @elizaos package ${linkedEntries === 1 ? "entry" : "entries"}`,
    );
  }

  return linkedEntries;
}

async function ensureRepoLocalEliza(repoRoot) {
  const elizaRoot = getRepoElizaRoot(repoRoot);
  if (hasRequiredElizaWorkspaceFiles(elizaRoot)) {
    return elizaRoot;
  }

  if (existsSync(path.join(repoRoot, ".git"))) {
    console.log("[setup-upstreams] Initializing tracked submodules");
    try {
      await runCommand(
        "git",
        ["submodule", "update", "--init", "--recursive", "--", "eliza"],
        {
          cwd: repoRoot,
          label: "git submodule update eliza",
        },
      );
    } catch (error) {
      if (existsSync(elizaRoot)) {
        throw error;
      }

      console.warn(
        `[setup-upstreams] Could not initialize eliza as a tracked submodule. Falling back to a direct clone (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
  }

  if (!hasRequiredElizaWorkspaceFiles(elizaRoot) && !existsSync(elizaRoot)) {
    console.log(
      `[setup-upstreams] Cloning ${ELIZA_GIT_URL} (${ELIZA_BRANCH}) into ${toDisplayPath(elizaRoot)}`,
    );
    await runCommand(
      "git",
      [
        "clone",
        "--branch",
        ELIZA_BRANCH,
        "--single-branch",
        ELIZA_GIT_URL,
        elizaRoot,
      ],
      {
        cwd: repoRoot,
        label: "git clone eliza",
      },
    );
  }

  if (!hasRequiredElizaWorkspaceFiles(elizaRoot)) {
    throw new Error(
      `Repo-local eliza workspace at ${toDisplayPath(elizaRoot)} is missing required files after setup.`,
    );
  }

  return elizaRoot;
}

async function ensureElizaDependencies(elizaRoot) {
  if (hasInstalledElizaDependencies(elizaRoot)) {
    return;
  }

  console.log(
    `[setup-upstreams] Installing eliza workspace dependencies in ${toDisplayPath(elizaRoot)}`,
  );
  await runCommand("bun", ["install"], {
    cwd: elizaRoot,
    label: "bun install (eliza)",
  });
}

async function ensureElizaBuildOutputs(elizaRoot) {
  for (const step of ELIZA_BUILD_STEPS) {
    if (existsSync(path.join(elizaRoot, step.check))) {
      continue;
    }

    console.log(`[setup-upstreams] Building ${step.label}`);
    await runCommand("bun", step.args, {
      cwd: path.join(elizaRoot, step.cwd),
      label: `bun ${step.args.join(" ")} (${step.label})`,
    });
  }
}

export async function ensurePluginBuildOutputs(
  pluginsRoot,
  { pathExists = existsSync, runCommandImpl = runCommand } = {},
) {
  for (const packageDir of discoverPluginPackageDirs(pluginsRoot)) {
    const packageJson = readPackageJson(packageDir);
    if (!packageJson?.name?.startsWith("@elizaos/")) {
      continue;
    }

    const hasBuildScript =
      packageJson.scripts && typeof packageJson.scripts.build === "string";
    if (!hasBuildScript || pathExists(path.join(packageDir, "dist"))) {
      continue;
    }

    console.log(`[setup-upstreams] Building ${packageJson.name}`);
    await runCommandImpl("bun", ["run", "build"], {
      cwd: packageDir,
      label: `bun run build (${packageJson.name})`,
    });
  }
}

export function linkUpstreamPackages(
  repoRoot = DEFAULT_REPO_ROOT,
  {
    elizaRoot = getRepoElizaRoot(repoRoot),
    pluginsRoot = getRepoPluginsRoot(repoRoot),
  } = {},
) {
  let updatedLinks = 0;
  for (const { linkPath, targetPath } of getUpstreamPackageLinks(repoRoot, {
    elizaRoot,
    pluginsRoot,
  })) {
    if (createPackageLink(linkPath, targetPath)) {
      updatedLinks += 1;
    }
  }
  return updatedLinks;
}

export async function setupUpstreams(repoRoot = DEFAULT_REPO_ROOT) {
  const skipReason = getElizaWorkspaceSkipReason(repoRoot);
  if (skipReason) {
    if (skipReason.endsWith("=1")) {
      ensurePublishedElizaPackageLinks(repoRoot);
    }
    console.log(`[setup-upstreams] Skipping: ${skipReason}`);
    return { skipped: true, reason: skipReason };
  }

  if (!commandExists("git")) {
    throw new Error(
      "git is required to initialize repo-local upstream sources",
    );
  }

  if (!commandExists("bun")) {
    throw new Error(
      "bun is required to install and link repo-local upstream sources",
    );
  }

  const elizaRoot = await ensureRepoLocalEliza(repoRoot);
  await ensureElizaDependencies(elizaRoot);
  await ensureElizaBuildOutputs(elizaRoot);

  const pluginsRoot = getRepoPluginsRoot(repoRoot);
  ensurePluginDependencyLinks(repoRoot, pluginsRoot);
  await ensurePluginBuildOutputs(pluginsRoot);
  const updatedLinks = linkUpstreamPackages(repoRoot, {
    elizaRoot,
    pluginsRoot,
  });

  if (updatedLinks === 0) {
    console.log(
      "[setup-upstreams] Repo-local @elizaos package links already up to date",
    );
  } else {
    console.log(
      `[setup-upstreams] Linked ${updatedLinks} repo-local @elizaos package ${updatedLinks === 1 ? "entry" : "entries"}`,
    );
  }

  return {
    skipped: false,
    elizaRoot,
    pluginsRoot: existsSync(pluginsRoot) ? pluginsRoot : null,
    linkedEntries: updatedLinks,
  };
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isMain) {
  setupUpstreams().catch((error) => {
    console.error(
      `[setup-upstreams] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}

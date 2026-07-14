#!/usr/bin/env node
/**
 * Builds a production-only Node runtime from prepared monorepo packages.
 * Linux package builders consume the resulting self-contained tree instead of
 * leaking workspace symlinks or depending on partially published npm graphs.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  cpSync,
  existsSync,
  globSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const DEPENDENCY_SECTIONS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
];
const COMMAND_TIMEOUT_MS = 30 * 60 * 1_000;
const COMMAND_MAX_BUFFER = 32 * 1024 * 1024;
const INSTALL_LIFECYCLE_SCRIPTS = new Set([
  "preinstall",
  "install",
  "postinstall",
  "preprepare",
  "prepare",
  "postprepare",
]);
const DEPENDENCY_INSTALL_SCRIPTS = new Set([
  "preinstall",
  "install",
  "postinstall",
]);
const REVIEWED_WORKSPACE_LIFECYCLE_SCRIPTS = new Map([
  ["@elizaos/plugin-computeruse", new Set(["postinstall"])],
]);
const REVIEWED_TRUSTED_DEPENDENCY_SCRIPT_VERSIONS = new Set([
  "bigint-buffer@1.1.5",
  "bufferutil@4.1.0",
  "esbuild@0.28.1",
  "keccak@3.0.4",
  "protobufjs@7.4.0",
  "protobufjs@7.5.5",
  "protobufjs@7.6.4",
  "utf-8-validate@5.0.10",
  "utf-8-validate@6.0.6",
]);
const REVIEWED_SUPPRESSED_DEPENDENCY_SCRIPT_VERSIONS = new Set([
  "ffmpeg-static@5.3.0",
]);
const INSTALLER_LOCK_BASENAMES = new Set([
  ".package-lock.json",
  "bun.lock",
  "bun.lockb",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "pnpm-lock.yml",
  "yarn.lock",
]);
const GENERATED_PACKAGE_ARTIFACT_BASENAMES = new Set([".turbo"]);

function isGeneratedPackageArtifact(path) {
  const leaf = basename(path);
  return (
    GENERATED_PACKAGE_ARTIFACT_BASENAMES.has(leaf) ||
    leaf.endsWith(".tsbuildinfo")
  );
}
const PACKAGED_RUNTIME_SCHEMA_VERSION = 1;
const RUNTIME_DEPENDENCY_INVENTORY_FILE = "elizaos-runtime-dependencies.json";
const RUNTIME_DEPENDENCY_INVENTORY_SCHEMA_VERSION = 1;
const IN_CHECKOUT_RUNTIME_DESTINATIONS = new Set([
  join("packages", "app-core", "packaging", "debian", "runtime"),
  join("packages", "app-core", "packaging", "flatpak", "runtime"),
  join("packages", "app-core", "packaging", "snap", "runtime"),
]);
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/iu;
const PROHIBITED_RUNTIME_DEPENDENCY_NAMES = new Set([
  "libsignal",
  "sharp",
  "whatsapp-rust-bridge",
]);
const PROHIBITED_RUNTIME_DEPENDENCY_PREFIXES = [
  "@img/",
  "@metamask/",
  "@rainbow-me/",
  "@raydium-io/",
  "@signalapp/",
  "@steerprotocol/",
  "@trezor/",
  "@whiskeysockets/",
];

function reviewedBlockedDependencyScriptVersions(targetCpu) {
  return new Set([
    "@capacitor/background-runner@3.0.0",
    "@discordjs/opus@0.10.0",
    "@parcel/watcher@2.5.6",
    `@smithers-orchestrator/jj-linux-${targetCpu}@0.26.1`,
    "@stellar/stellar-sdk@14.2.0",
    "@tsparticles/engine@3.9.1",
    "blake-hash@2.0.0",
    "cpu-features@0.0.10",
    "msgpackr-extract@3.0.4",
    "ssh2@1.17.0",
    "tiny-secp256k1@1.1.7",
    "usb@2.18.0",
    "youtube-dl-exec@3.1.8",
  ]);
}

function assertAllowedRuntimePackageIdentity(installName, manifestName) {
  for (const identity of new Set([installName, manifestName])) {
    if (
      PROHIBITED_RUNTIME_DEPENDENCY_NAMES.has(identity) ||
      PROHIBITED_RUNTIME_DEPENDENCY_PREFIXES.some((prefix) =>
        identity.startsWith(prefix),
      )
    ) {
      throw new Error(
        `Packaged runtime contains prohibited dependency identity: ${identity}`,
      );
    }
  }
}

function parsePackageJson(path) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError(`Package manifest must contain an object: ${path}`);
  }
  return parsed;
}

function packagePath(root, packageName) {
  if (
    typeof packageName !== "string" ||
    !PACKAGE_NAME_PATTERN.test(packageName)
  ) {
    throw new TypeError(`Invalid package name: ${String(packageName)}`);
  }
  return join(root, "node_modules", ...packageName.split("/"));
}

function lockedPackageInstallName(lockKey) {
  const segments = lockKey.split("/");
  const leaf = segments.at(-1);
  const scope = segments.at(-2);
  if (!leaf) return null;
  const installName = scope?.startsWith("@") ? `${scope}/${leaf}` : leaf;
  return PACKAGE_NAME_PATTERN.test(installName) ? installName : null;
}

/**
 * Extracts exact npm-alias resolutions from Bun's committed JSONC lockfile.
 * An alias is accepted only when the lock contains both its `npm:` declaration
 * and a package-table entry resolving that install name to the actual manifest
 * name and version.
 */
export function parseLockedNpmAliasIdentities(lockText) {
  if (typeof lockText !== "string") {
    throw new TypeError("Bun lockfile contents must be a string");
  }
  const declaredAliases = new Set();
  const declarationPattern =
    /"((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)"\s*:\s*"npm:((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)@[^"\r\n]+"/giu;
  for (const match of lockText.matchAll(declarationPattern)) {
    declaredAliases.add(`${match[1]}\0${match[2]}`);
  }

  const identities = new Set();
  const resolutionPattern =
    /"([^"\r\n]+)"\s*:\s*\[\s*"((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)@([^"\r\n]+)"/giu;
  for (const match of lockText.matchAll(resolutionPattern)) {
    const installName = lockedPackageInstallName(match[1]);
    const actualName = match[2];
    const version = match[3];
    if (installName && declaredAliases.has(`${installName}\0${actualName}`)) {
      identities.add(`${installName}\0${actualName}\0${version}`);
    }
  }
  return identities;
}

function validateInstalledPackageIdentity(
  installName,
  manifest,
  lockedAliasIdentities,
  manifestPath,
) {
  if (
    typeof manifest.name !== "string" ||
    !PACKAGE_NAME_PATTERN.test(manifest.name) ||
    typeof manifest.version !== "string" ||
    manifest.version.trim().length === 0
  ) {
    throw new Error(`Installed package has invalid identity: ${manifestPath}`);
  }
  if (manifest.name === installName) return;
  const aliasIdentity = `${installName}\0${manifest.name}\0${manifest.version}`;
  if (!lockedAliasIdentities.has(aliasIdentity)) {
    throw new Error(
      `Installed package identity mismatch at ${manifestPath}: install name ${installName}, manifest ${manifest.name}@${manifest.version} is not an exact locked npm alias`,
    );
  }
}

function isWithinRoot(root, candidate) {
  const rel = relative(root, candidate);
  return (
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  );
}

function canonicalizePotentialPath(candidate) {
  let existingAncestor = resolve(candidate);
  const missingSegments = [];
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) {
      throw new Error(
        `Could not resolve an existing ancestor for ${candidate}`,
      );
    }
    missingSegments.unshift(basename(existingAncestor));
    existingAncestor = parent;
  }
  return resolve(realpathSync(existingAncestor), ...missingSegments);
}

function assertGeneratedRuntimeIdentity(candidate) {
  const status = lstatSync(candidate, { throwIfNoEntry: false });
  if (!status) return;
  if (!status.isDirectory()) {
    throw new Error(
      `Refusing to replace a packaged runtime destination that is not a directory: ${candidate}`,
    );
  }

  const manifestPath = join(candidate, "package.json");
  const manifestStatus = lstatSync(manifestPath, { throwIfNoEntry: false });
  if (!manifestStatus?.isFile() || manifestStatus.isSymbolicLink()) {
    throw new Error(
      `Refusing to replace a directory without a regular packaged runtime manifest: ${candidate}`,
    );
  }

  let manifest;
  try {
    manifest = parsePackageJson(manifestPath);
  } catch (error) {
    // error-policy:J2 replacement safety depends on retaining the invalid
    // manifest cause rather than treating an unreadable destination as empty.
    throw new Error(
      `Refusing to replace a directory with an invalid packaged runtime manifest: ${candidate}`,
      { cause: error },
    );
  }
  const runtime = manifest.elizaosRuntime;
  const nativeArtifacts = runtime?.nativeArtifacts;
  const ffmpeg = runtime?.externalTools?.ffmpeg;
  if (
    manifest.name !== "elizaos-packaged-runtime" ||
    manifest.private !== true ||
    runtime?.schemaVersion !== PACKAGED_RUNTIME_SCHEMA_VERSION ||
    typeof runtime.sourceLockSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(runtime.sourceLockSha256) ||
    nativeArtifacts?.os !== "linux" ||
    !["x64", "arm64"].includes(nativeArtifacts?.cpu) ||
    nativeArtifacts?.libc !== "glibc" ||
    ffmpeg?.suppliedByRuntime !== false
  ) {
    throw new Error(
      `Refusing to replace a directory that is not a schema-${PACKAGED_RUNTIME_SCHEMA_VERSION} packaged runtime: ${candidate}`,
    );
  }
}

function assertSafeRuntimeDestination(sourceRoot, destination) {
  if (!isWithinRoot(sourceRoot, destination)) {
    assertGeneratedRuntimeIdentity(destination);
    return;
  }

  const destinationRelative = relative(sourceRoot, destination);
  if (!IN_CHECKOUT_RUNTIME_DESTINATIONS.has(destinationRelative)) {
    throw new Error(
      `Packaged runtime destination inside the source checkout is not an approved generated path: ${destination}`,
    );
  }
  assertGeneratedRuntimeIdentity(destination);
}

function preparationLockPath(destination) {
  return join(dirname(destination), `.${basename(destination)}.prepare.lock`);
}

function acquirePreparationLock(destination, sourceRoot) {
  const lockPath = preparationLockPath(destination);
  const token = randomUUID();
  try {
    mkdirSync(lockPath, { mode: 0o700 });
  } catch (error) {
    // error-policy:J2 retain the atomic mkdir failure with destination context.
    if (
      error &&
      typeof error === "object" &&
      Reflect.get(error, "code") === "EEXIST"
    ) {
      let owner = "<owner metadata unavailable>";
      try {
        owner = readFileSync(join(lockPath, "owner.json"), "utf8")
          .trim()
          .slice(0, 4096);
      } catch (metadataError) {
        // error-policy:J3 a racing or malformed stale lock is reported as
        // explicitly unavailable metadata, never treated as safe to steal.
        owner = `<owner metadata unavailable: ${metadataError instanceof Error ? metadataError.message : String(metadataError)}>`;
      }
      throw new Error(
        `Packaged runtime destination is already being prepared: ${destination} (lock: ${lockPath}, owner: ${owner})`,
        { cause: error },
      );
    }
    throw new Error(
      `Could not lock packaged runtime destination: ${destination}`,
      { cause: error },
    );
  }
  try {
    writeFileSync(
      join(lockPath, "owner.json"),
      `${JSON.stringify(
        {
          token,
          pid: process.pid,
          hostname: hostname(),
          sourceRoot,
          destination,
          startedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    rmSync(lockPath, { recursive: true, force: true });
    // error-policy:J2 retain the metadata failure after rolling back the lock.
    throw new Error(
      `Could not record packaged runtime lock ownership: ${lockPath}`,
      { cause: error },
    );
  }
  return { path: lockPath, token };
}

function releasePreparationLock(lock) {
  let owner;
  try {
    owner = parsePackageJson(join(lock.path, "owner.json"));
  } catch (error) {
    // error-policy:J2 a missing/malformed owner means this process cannot
    // prove that removing the lock would be safe.
    throw new Error(
      `Could not verify packaged runtime lock ownership: ${lock.path}`,
      { cause: error },
    );
  }
  if (owner.token !== lock.token) {
    throw new Error(
      `Packaged runtime lock ownership changed before release: ${lock.path}`,
    );
  }
  rmSync(lock.path, { recursive: true });
}

function interruptedPreparationPaths(destination, activeLockPath) {
  const parent = dirname(destination);
  const prefix = `.${basename(destination)}.prepare-`;
  return readdirSync(parent)
    .filter((name) => name.startsWith(prefix))
    .map((name) => join(parent, name))
    .filter((path) => path !== activeLockPath)
    .sort();
}

function assertNoInterruptedPreparation(destination, activeLockPath) {
  const interrupted = interruptedPreparationPaths(destination, activeLockPath);
  if (interrupted.length > 0) {
    throw new Error(
      `Packaged runtime has interrupted preparation artifacts; inspect and remove them before retrying: ${interrupted.join(", ")}`,
    );
  }
}

function commitPreparedRuntime(
  stagingRoot,
  destination,
  token,
  rename = renameSync,
  validateCommitted = () => {},
) {
  assertGeneratedRuntimeIdentity(stagingRoot);
  const destinationStatus = lstatSync(destination, { throwIfNoEntry: false });
  if (!destinationStatus) {
    rename(stagingRoot, destination);
    try {
      validateCommitted(destination);
    } catch (validationError) {
      try {
        rename(destination, stagingRoot);
      } catch (rollbackError) {
        // error-policy:J2 both failures are needed to diagnose a commit that
        // could not restore its private staging state.
        throw new AggregateError(
          [validationError, rollbackError],
          `Packaged runtime validation and rollback both failed: ${destination}`,
        );
      }
      throw new Error(
        `Committed packaged runtime failed validation: ${destination}`,
        {
          cause: validationError,
        },
      );
    }
    return;
  }
  assertGeneratedRuntimeIdentity(destination);

  const backup = join(
    dirname(destination),
    `.${basename(destination)}.prepare-backup-${token}`,
  );
  if (lstatSync(backup, { throwIfNoEntry: false })) {
    throw new Error(`Packaged runtime backup already exists: ${backup}`);
  }
  rename(destination, backup);
  try {
    rename(stagingRoot, destination);
    validateCommitted(destination);
  } catch (commitError) {
    try {
      if (
        lstatSync(destination, { throwIfNoEntry: false }) &&
        !lstatSync(stagingRoot, { throwIfNoEntry: false })
      ) {
        rename(destination, stagingRoot);
      }
      rename(backup, destination);
    } catch (restoreError) {
      // error-policy:J2 both failures are required to recover the destination.
      throw new AggregateError(
        [commitError, restoreError],
        `Packaged runtime commit and rollback both failed: ${destination}`,
      );
    }
    // error-policy:J2 the prior destination is restored before surfacing the
    // failed atomic replacement.
    throw new Error(`Could not commit packaged runtime: ${destination}`, {
      cause: commitError,
    });
  }
  rmSync(backup, { recursive: true });
}

export const preparationTesting = Object.freeze({
  acquirePreparationLock,
  assertGeneratedRuntimeIdentity,
  assertSafeRuntimeDestination,
  commitPreparedRuntime,
  preparationLockPath,
  releasePreparationLock,
  assertAllowedRuntimePackageIdentity,
  validateInstalledPackageIdentity,
});

function walkTree(root, visit) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = join(root, entry.name);
    const status = lstatSync(entryPath);
    visit(entryPath, status);
    if (status.isDirectory()) walkTree(entryPath, visit);
  }
}

export function validatePackagePayload(root, selectedFiles = null) {
  const canonicalRoot = realpathSync(resolve(root));
  if (selectedFiles !== null) {
    for (const path of selectedFiles) {
      const source = resolve(canonicalRoot, path);
      if (!isWithinRoot(canonicalRoot, source)) {
        throw new Error(`Package payload path escapes its root: ${path}`);
      }

      const relativePath = relative(canonicalRoot, source);
      let current = canonicalRoot;
      for (const segment of relativePath.split(sep)) {
        current = join(current, segment);
        const status = lstatSync(current, { throwIfNoEntry: false });
        if (!status) {
          throw new Error(
            `Package payload path is not a regular file: ${path}`,
          );
        }
        if (status.isSymbolicLink()) {
          throw new Error(
            `Package payload path contains a symbolic link: ${path}`,
          );
        }
        if (current === source ? !status.isFile() : !status.isDirectory()) {
          throw new Error(
            `Package payload path is not a regular file: ${path}`,
          );
        }
      }

      const canonicalSource = realpathSync(source);
      if (!isWithinRoot(canonicalRoot, canonicalSource)) {
        throw new Error(`Package payload path escapes its root: ${path}`);
      }
    }
    return;
  }

  walkTree(canonicalRoot, (entryPath, status) => {
    if (!status.isDirectory() && !status.isFile()) {
      throw new Error(
        `Package payload contains a non-regular entry: ${relative(canonicalRoot, entryPath)}`,
      );
    }
  });
}

export function auditRuntimeSymlinkContainment(root) {
  const canonicalRoot = realpathSync(resolve(root));
  walkTree(canonicalRoot, (entryPath, status) => {
    if (!status.isSymbolicLink()) return;
    const lexicalTarget = readlinkSync(entryPath);
    if (isAbsolute(lexicalTarget)) {
      throw new Error(
        `Packaged runtime contains an absolute symlink: ${relative(canonicalRoot, entryPath)} -> ${lexicalTarget}`,
      );
    }
    let target;
    try {
      target = realpathSync(entryPath);
    } catch (error) {
      // error-policy:J2 preserve the filesystem cause at the package boundary.
      throw new Error(
        `Packaged runtime contains a broken symlink: ${relative(canonicalRoot, entryPath)}`,
        { cause: error },
      );
    }
    if (!isWithinRoot(canonicalRoot, target)) {
      throw new Error(
        `Packaged runtime symlink escapes its root: ${relative(canonicalRoot, entryPath)} -> ${target}`,
      );
    }
  });
}

function workspaceIndex(sourceRoot) {
  const canonicalSourceRoot = realpathSync(resolve(sourceRoot));
  const rootManifestPath = join(sourceRoot, "package.json");
  if (!existsSync(rootManifestPath)) return new Map();
  validatePackagePayload(canonicalSourceRoot, ["package.json"]);
  const rootManifest = parsePackageJson(rootManifestPath);
  if (!Array.isArray(rootManifest.workspaces)) return new Map();
  const excluded = new Set(
    rootManifest.workspaces
      .filter(
        (pattern) => typeof pattern === "string" && pattern.startsWith("!"),
      )
      .map((pattern) => pattern.slice(1)),
  );
  const packages = new Map();
  for (const pattern of rootManifest.workspaces) {
    if (typeof pattern !== "string" || pattern.startsWith("!")) continue;
    for (const manifestPath of globSync(`${pattern}/package.json`, {
      cwd: canonicalSourceRoot,
    })) {
      validatePackagePayload(canonicalSourceRoot, [manifestPath]);
      const workspaceRoot = realpathSync(
        resolve(canonicalSourceRoot, dirname(manifestPath)),
      );
      if (!isWithinRoot(canonicalSourceRoot, workspaceRoot)) {
        throw new Error(`Workspace escapes source: ${workspaceRoot}`);
      }
      const relativeRoot = relative(canonicalSourceRoot, workspaceRoot);
      if (excluded.has(relativeRoot)) continue;
      const manifest = parsePackageJson(join(workspaceRoot, "package.json"));
      if (typeof manifest.name !== "string" || manifest.name.length === 0)
        continue;
      const existing = packages.get(manifest.name);
      if (existing && existing !== workspaceRoot) {
        throw new Error(
          `Duplicate workspace package ${manifest.name}: ${existing} and ${workspaceRoot}`,
        );
      }
      packages.set(manifest.name, workspaceRoot);
    }
  }
  return packages;
}

function resolveWorkspace(sourceRoot, packageName, workspaces) {
  const indexed = workspaces.get(packageName);
  if (indexed) return indexed;
  const link = packagePath(sourceRoot, packageName);
  const status = lstatSync(link, { throwIfNoEntry: false });
  if (!status?.isSymbolicLink()) return null;
  const target = realpathSync(link);
  if (isWithinRoot(join(sourceRoot, "node_modules"), target)) return null;
  if (!isWithinRoot(sourceRoot, target)) {
    throw new Error(
      `Workspace package ${packageName} resolves outside the source root: ${target}`,
    );
  }
  return target;
}

function distributionDescriptor(workspaceRoot, packageName) {
  const canonicalWorkspaceRoot = realpathSync(resolve(workspaceRoot));
  validatePackagePayload(canonicalWorkspaceRoot, ["package.json"]);
  const sourceManifestPath = join(workspaceRoot, "package.json");
  const sourceManifest = parsePackageJson(sourceManifestPath);
  if (sourceManifest.name !== packageName) {
    throw new Error(
      `Workspace package name mismatch for ${packageName}: ${String(sourceManifest.name)}`,
    );
  }
  const preparedManifest = join(workspaceRoot, "dist", "package.json");
  if (existsSync(preparedManifest)) {
    validatePackagePayload(canonicalWorkspaceRoot, [
      join("dist", "package.json"),
    ]);
    const manifest = parsePackageJson(preparedManifest);
    if (manifest.name !== packageName) {
      throw new Error(
        `Built package name mismatch for ${packageName}: ${String(manifest.name)}`,
      );
    }
    return {
      manifest,
      prepared: true,
      root: realpathSync(join(workspaceRoot, "dist")),
      sourceManifest,
    };
  }

  return {
    manifest: sourceManifest,
    prepared: false,
    root: canonicalWorkspaceRoot,
    sourceManifest,
  };
}

function sourcePackageFiles(
  workspaceRoot,
  packageName,
  npmCommand,
  nodeCommand,
) {
  const dryRun = JSON.parse(
    runPackagerCommand(
      npmCommand,
      [
        "pack",
        "--dry-run",
        "--json",
        "--ignore-scripts",
        "--workspaces=false",
        workspaceRoot,
      ],
      { cwd: workspaceRoot, env: npmProcessEnvironment(nodeCommand) },
    ),
  );
  if (
    !Array.isArray(dryRun) ||
    dryRun.length !== 1 ||
    !Array.isArray(dryRun[0]?.files)
  ) {
    throw new Error(
      `npm pack returned an invalid file inventory for ${packageName}`,
    );
  }
  const selectedFiles = new Set();
  for (const file of dryRun[0].files) {
    const path = file?.path;
    if (typeof path !== "string" || path.length === 0) {
      throw new Error(
        `npm pack returned an invalid file path for ${packageName}`,
      );
    }
    if (path === "package.json") continue;
    const source = resolve(workspaceRoot, path);
    if (!isWithinRoot(workspaceRoot, source)) {
      throw new Error(
        `npm pack selected a file outside ${packageName}: ${path}`,
      );
    }
    selectedFiles.add(path);
  }
  const files = [...selectedFiles];
  try {
    validatePackagePayload(workspaceRoot, files);
  } catch (error) {
    // error-policy:J2 name the package while preserving the rejected entry.
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `npm pack selected an invalid file for ${packageName}: ${reason}`,
      { cause: error },
    );
  }
  return files;
}

export function resolveRuntimeWorkspaceClosure(
  sourceRoot,
  entryPackages,
  stubPackages = [],
) {
  const canonicalSourceRoot = realpathSync(resolve(sourceRoot));
  const workspaces = workspaceIndex(canonicalSourceRoot);
  const pending = [...entryPackages];
  const packages = new Map();
  if (pending.length === 0)
    throw new TypeError("At least one entry package is required");
  const stubSet = new Set(stubPackages);
  for (const stubName of stubSet) {
    if (entryPackages.includes(stubName)) {
      throw new Error(`Entry package cannot be stubbed: ${stubName}`);
    }
  }

  while (pending.length > 0) {
    const packageName = pending.shift();
    if (packages.has(packageName)) continue;
    const workspaceRoot = resolveWorkspace(
      canonicalSourceRoot,
      packageName,
      workspaces,
    );
    if (!workspaceRoot) {
      throw new Error(`Entry/runtime workspace is not linked: ${packageName}`);
    }
    const descriptor = distributionDescriptor(workspaceRoot, packageName);
    if (stubSet.has(packageName)) {
      // Stubbed workspaces stay in the closure so dependents resolve them,
      // but they materialize as inert null-plugin packages and none of their
      // dependencies (typically license-incompatible for redistribution)
      // enter the packaged runtime.
      packages.set(packageName, { ...descriptor, workspaceRoot, stub: true });
      continue;
    }
    packages.set(packageName, { ...descriptor, workspaceRoot, stub: false });

    for (const section of DEPENDENCY_SECTIONS) {
      const dependencies = descriptor.manifest[section];
      if (!dependencies || typeof dependencies !== "object") continue;
      for (const [dependency, specifier] of Object.entries(dependencies)) {
        if (packages.has(dependency)) continue;
        if (resolveWorkspace(canonicalSourceRoot, dependency, workspaces)) {
          pending.push(dependency);
        } else if (
          typeof specifier === "string" &&
          specifier.startsWith("workspace:")
        ) {
          throw new Error(
            `Runtime workspace ${packageName} references unavailable ${dependency}`,
          );
        } else if (
          typeof specifier === "string" &&
          specifier.startsWith("file:")
        ) {
          throw new Error(
            `Runtime workspace ${packageName} has a non-workspace local dependency: ${dependency} (${specifier})`,
          );
        }
      }
    }
  }
  const unreachedStubs = [...stubSet].filter((name) => !packages.has(name));
  if (unreachedStubs.length > 0) {
    throw new Error(
      `Stubbed packages are not part of the runtime closure: ${unreachedStubs.join(", ")}`,
    );
  }
  return packages;
}

export function runPackagerCommand(
  command,
  args,
  { timeoutMs = COMMAND_TIMEOUT_MS, ...options } = {},
) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: COMMAND_MAX_BUFFER,
    ...options,
  });
  if (result.error) {
    if (result.error.code === "ETIMEDOUT") {
      throw new Error(
        `${command} ${args.join(" ")} timed out after ${timeoutMs}ms`,
        { cause: result.error },
      );
    }
    throw new Error(`Could not run ${command}: ${result.error.message}`, {
      cause: result.error,
    });
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${String(result.status)}\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

function validateRequiredPeerClosure(closure) {
  const backedDependencies = new Set(closure.keys());
  for (const descriptor of closure.values()) {
    // A stubbed workspace installs none of its declared dependencies, so they
    // cannot back another package's required peer.
    if (descriptor.stub) continue;
    for (const dependency of Object.keys(
      descriptor.manifest.dependencies ?? {},
    )) {
      backedDependencies.add(dependency);
    }
  }
  for (const [packageName, descriptor] of closure) {
    if (descriptor.stub) continue;
    for (const peer of Object.keys(
      descriptor.manifest.peerDependencies ?? {},
    )) {
      if (descriptor.manifest.peerDependenciesMeta?.[peer]?.optional === true)
        continue;
      if (!backedDependencies.has(peer)) {
        throw new Error(
          `Runtime workspace ${packageName} has an unbacked required peer: ${peer}`,
        );
      }
    }
  }
}

function workspaceSpecifierForVersion(specifier, version) {
  if (specifier === "workspace:^" || specifier === "workspace:~") {
    return `${specifier.at(-1)}${version}`;
  }
  if (specifier === "workspace:*") return version;
  const publishedSpecifier = specifier.slice("workspace:".length);
  if (publishedSpecifier.length === 0) {
    throw new Error("Empty workspace dependency specifier");
  }
  return publishedSpecifier;
}

function preparedWorkspaceSpecifierForVersion(specifier, version) {
  const publishedSpecifier = specifier.slice("workspace:".length);
  if (
    publishedSpecifier === "" ||
    publishedSpecifier === "*" ||
    publishedSpecifier === "^"
  ) {
    return `^${version}`;
  }
  if (publishedSpecifier === "~") return `~${version}`;
  return publishedSpecifier;
}

function dependencyRecord(manifest, section, packageName, manifestKind) {
  const dependencies = manifest[section];
  if (dependencies === undefined) return {};
  if (
    !dependencies ||
    typeof dependencies !== "object" ||
    Array.isArray(dependencies)
  ) {
    throw new TypeError(
      `${manifestKind} manifest for ${packageName} has invalid ${section}`,
    );
  }
  for (const [dependency, specifier] of Object.entries(dependencies)) {
    if (typeof specifier !== "string" || specifier.length === 0) {
      throw new TypeError(
        `${manifestKind} manifest for ${packageName} has invalid ${section}.${dependency}`,
      );
    }
  }
  return dependencies;
}

function validatePreparedDependencyParity(closure, versions) {
  for (const [packageName, descriptor] of closure) {
    if (
      descriptor.prepared &&
      descriptor.manifest.version !== descriptor.sourceManifest.version
    ) {
      throw new Error(
        `Prepared runtime version mismatch for ${packageName}: expected ${JSON.stringify(descriptor.sourceManifest.version)}, found ${JSON.stringify(descriptor.manifest.version)}`,
      );
    }
    for (const section of DEPENDENCY_SECTIONS) {
      const sourceDependencies = dependencyRecord(
        descriptor.sourceManifest,
        section,
        packageName,
        "Source",
      );
      const preparedDependencies = dependencyRecord(
        descriptor.manifest,
        section,
        packageName,
        "Prepared",
      );
      const dependencyNames = [
        ...new Set([
          ...Object.keys(sourceDependencies),
          ...Object.keys(preparedDependencies),
        ]),
      ].sort();
      for (const dependency of dependencyNames) {
        const sourceSpecifier = sourceDependencies[dependency];
        const preparedSpecifier = preparedDependencies[dependency];
        let expectedSpecifier = sourceSpecifier;
        if (descriptor.prepared && sourceSpecifier?.startsWith("workspace:")) {
          const dependencyVersion = versions.get(dependency);
          if (!dependencyVersion) {
            throw new Error(
              `Prepared runtime dependency mismatch for ${packageName} ${section}.${dependency}: workspace dependency is outside the prepared closure`,
            );
          }
          expectedSpecifier = preparedWorkspaceSpecifierForVersion(
            sourceSpecifier,
            dependencyVersion,
          );
        }
        if (preparedSpecifier !== expectedSpecifier) {
          throw new Error(
            `Prepared runtime dependency mismatch for ${packageName} ${section}.${dependency}: expected ${JSON.stringify(expectedSpecifier)}, found ${JSON.stringify(preparedSpecifier)}`,
          );
        }
      }
    }
    if (
      !isDeepStrictEqual(
        descriptor.manifest.peerDependenciesMeta,
        descriptor.sourceManifest.peerDependenciesMeta,
      )
    ) {
      throw new Error(
        `Prepared runtime dependency metadata mismatch for ${packageName}`,
      );
    }
  }
}

function stripInstallLifecycleScripts(manifest) {
  if (!manifest.scripts || typeof manifest.scripts !== "object") return;
  for (const scriptName of INSTALL_LIFECYCLE_SCRIPTS) {
    delete manifest.scripts[scriptName];
  }
  if (Object.keys(manifest.scripts).length === 0) delete manifest.scripts;
}

function validateWorkspaceLifecyclePolicy(closure) {
  for (const [packageName, descriptor] of closure) {
    // Stubbed workspaces never install or run their real package code, so
    // their source lifecycle scripts cannot execute inside the runtime.
    if (descriptor.stub) continue;
    const allowed = REVIEWED_WORKSPACE_LIFECYCLE_SCRIPTS.get(packageName);
    const present = Object.keys(descriptor.sourceManifest.scripts ?? {}).filter(
      (scriptName) => INSTALL_LIFECYCLE_SCRIPTS.has(scriptName),
    );
    for (const scriptName of present) {
      if (!allowed?.has(scriptName)) {
        throw new Error(
          `Runtime workspace ${packageName} adds unreviewed ${scriptName} lifecycle code`,
        );
      }
    }
    if (allowed && present.length !== allowed.size) {
      throw new Error(
        `Runtime workspace lifecycle policy drifted for ${packageName}: expected ${[...allowed].join(", ")}, found ${present.join(", ")}`,
      );
    }
  }
}

function packageVersions(closure) {
  const versions = new Map();
  for (const [packageName, descriptor] of closure) {
    const version = descriptor.manifest.version;
    if (typeof version !== "string" || version.length === 0) {
      throw new Error(`Runtime workspace ${packageName} has no version`);
    }
    versions.set(packageName, version);
  }
  return versions;
}

// Named exports the agent's optional-plugin call sites destructure off these
// packages at runtime. Node's cjs-module-lexer/ESM interop resolves named
// bindings statically, so the stub must export them explicitly as no-ops —
// a Proxy default alone leaves the bindings undefined and crashes callers.
// The list mirrors packages/agent/scripts/mobile-stubs/null-plugin.cjs, the
// proven mobile-bundle stub for the same optional-plugin seams.
const STUB_EXPORTED_NAMES = [
  "applyWhatsAppQrOverride",
  "handleWhatsAppRoute",
  "WHATSAPP_MAX_PAIRING_SESSIONS",
  "applySignalQrOverride",
  "handleSignalRoute",
  "handleDiscordLocalRoute",
  "handleComputerUseRoutes",
  "handleTriggerRoutes",
  "createPaymentAwareHandler",
  "isRoutePaymentWrapped",
  "handleMcpRoutes",
  "handleTtsRoutes",
  "validateX402Startup",
  "streamManager",
];

function stubPackageManifest(descriptor, versions) {
  return {
    name: descriptor.manifest.name,
    version: versions.get(descriptor.manifest.name),
    description:
      "Inert stub: the real package's dependency tree carries licenses that cannot be redistributed inside this packaged runtime.",
    license: "MIT",
    type: "module",
    main: "./index.mjs",
    exports: { ".": "./index.mjs", "./package.json": "./package.json" },
  };
}

// Per-package consumer surfaces that need more than a plain no-op. These
// mirror the shapes in packages/os/linux/scripts/prepare-elizaos-app-overlay.mjs,
// the shipping Linux-OS overlay that already runs the agent with these
// packages stubbed out.
const STUB_EXTRA_SOURCES = new Map([
  [
    "@elizaos/plugin-whatsapp",
    [
      "export const sanitizeWhatsAppAccountId = (value) =>",
      '  typeof value === "string" ? value.trim() : "";',
      "export class WhatsAppPairingSession {",
      "  constructor() {",
      '    this.status = { state: "unavailable" };',
      "  }",
      "  start() {",
      "    return Promise.resolve(this.status);",
      "  }",
      "  stop() {",
      "    return Promise.resolve(this.status);",
      "  }",
      "  snapshot() {",
      "    return this.status;",
      "  }",
      "}",
      "export const whatsappAuthExists = async () => false;",
      "export const whatsappLogout = async () => false;",
    ],
  ],
]);

function stubModuleSource(packageName) {
  return [
    `// Inert packaged-runtime stub for ${packageName}.`,
    "// The real package pulls in dependencies whose licenses prohibit",
    "// redistribution inside this artifact; every optional consumer surface",
    "// resolves to a no-op so the agent boots and reports the feature absent.",
    "const noop = () => undefined;",
    ...STUB_EXPORTED_NAMES.map(
      (name) =>
        `export const ${name} = ${name === "WHATSAPP_MAX_PAIRING_SESSIONS" ? "0" : "noop"};`,
    ),
    ...(STUB_EXTRA_SOURCES.get(packageName) ?? []),
    "export const __elizaPackagedStub = true;",
    "export default undefined;",
    "",
  ].join("\n");
}

function writeStubPackage(descriptor, destination, versions, sourceRoot) {
  const packageName = descriptor.manifest.name;
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  writeFileSync(
    join(destination, "package.json"),
    `${JSON.stringify(stubPackageManifest(descriptor, versions), null, 2)}\n`,
  );
  writeFileSync(join(destination, "index.mjs"), stubModuleSource(packageName));
  const projectLicense = join(sourceRoot, "LICENSE");
  validatePackagePayload(sourceRoot, ["LICENSE"]);
  cpSync(projectLicense, join(destination, "LICENSE"));
}

function runtimePackageManifest(descriptor, versions) {
  if (descriptor.stub) return stubPackageManifest(descriptor, versions);
  const manifest = structuredClone(descriptor.manifest);
  delete manifest.devDependencies;
  stripInstallLifecycleScripts(manifest);
  for (const section of DEPENDENCY_SECTIONS) {
    const dependencies = manifest[section];
    if (!dependencies || typeof dependencies !== "object") continue;
    const sourceDependencies = descriptor.sourceManifest[section];
    for (const [dependency, specifier] of Object.entries(dependencies)) {
      const version = versions.get(dependency);
      if (!version) continue;
      const sourceSpecifier = sourceDependencies?.[dependency];
      const workspaceSpecifier = [sourceSpecifier, specifier].find(
        (candidate) =>
          typeof candidate === "string" && candidate.startsWith("workspace:"),
      );
      dependencies[dependency] = workspaceSpecifier
        ? workspaceSpecifierForVersion(workspaceSpecifier, version)
        : specifier;
    }
  }
  return manifest;
}

function auditRuntimeWorkspaceManifests(root, sourceRoot, closure, versions) {
  for (const [packageName, descriptor] of closure) {
    const workspaceRoot = workspaceDestination(
      root,
      sourceRoot,
      descriptor.workspaceRoot,
    );
    validatePackagePayload(workspaceRoot, ["package.json"]);
    const manifest = parsePackageJson(join(workspaceRoot, "package.json"));
    if (manifest.name !== packageName) {
      throw new Error(
        `Materialized workspace name mismatch for ${packageName}: ${String(manifest.name)}`,
      );
    }
    if (manifest.version !== versions.get(packageName)) {
      throw new Error(
        `Materialized workspace version mismatch for ${packageName}: ${String(manifest.version)}`,
      );
    }
    const expected = runtimePackageManifest(descriptor, versions);
    for (const section of DEPENDENCY_SECTIONS) {
      for (const [dependency, specifier] of Object.entries(
        manifest[section] ?? {},
      )) {
        if (
          typeof specifier === "string" &&
          (specifier.startsWith("workspace:") || specifier.startsWith("file:"))
        ) {
          throw new Error(
            `Materialized workspace ${packageName} retains local ${dependency} dependency: ${specifier}`,
          );
        }
        if (
          versions.has(dependency) &&
          specifier !== expected[section]?.[dependency]
        ) {
          throw new Error(
            `Materialized workspace ${packageName} misstates ${dependency}: ${String(specifier)}`,
          );
        }
      }
    }
  }
}

function digestFilesystemTree(root) {
  const digest = createHash("sha256");
  const visit = (directory, relativeDirectory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    )) {
      const entryPath = join(directory, entry.name);
      const entryRelative = join(relativeDirectory, entry.name);
      const status = lstatSync(entryPath);
      if (status.isDirectory()) {
        digest.update(`directory\0${entryRelative}\0${status.mode}\0`);
        visit(entryPath, entryRelative);
      } else if (status.isFile()) {
        digest.update(`file\0${entryRelative}\0${status.mode}\0`);
        digest.update(readFileSync(entryPath));
      } else if (status.isSymbolicLink()) {
        digest.update(
          `symlink\0${entryRelative}\0${status.mode}\0${readlinkSync(entryPath)}\0`,
        );
      } else {
        throw new Error(
          `Nested workspace dependency contains unsupported entry: ${entryRelative}`,
        );
      }
    }
  };
  visit(root, "");
  return digest.digest("hex");
}

function snapshotNestedWorkspaceDependencies(root, sourceRoot, closure) {
  const snapshots = new Map();
  for (const [packageName, descriptor] of closure) {
    const nestedNodeModules = join(
      workspaceDestination(root, sourceRoot, descriptor.workspaceRoot),
      "node_modules",
    );
    snapshots.set(
      packageName,
      existsSync(nestedNodeModules)
        ? digestFilesystemTree(nestedNodeModules)
        : null,
    );
  }
  return snapshots;
}

function assertNestedWorkspaceDependenciesUnchanged(
  root,
  sourceRoot,
  closure,
  snapshots,
) {
  for (const [packageName, expectedDigest] of snapshots) {
    const descriptor = closure.get(packageName);
    if (!descriptor) {
      throw new Error(`Nested dependency snapshot lost ${packageName}`);
    }
    const nestedNodeModules = join(
      workspaceDestination(root, sourceRoot, descriptor.workspaceRoot),
      "node_modules",
    );
    if (expectedDigest === null) {
      if (existsSync(nestedNodeModules)) {
        throw new Error(
          `Materializing ${packageName} introduced dependencies outside the frozen install`,
        );
      }
      continue;
    }
    if (!existsSync(nestedNodeModules)) {
      throw new Error(
        `Materializing ${packageName} removed its locked nested dependencies`,
      );
    }
    const actualDigest = digestFilesystemTree(nestedNodeModules);
    if (actualDigest !== expectedDigest) {
      throw new Error(
        `Materializing ${packageName} changed its locked nested dependencies`,
      );
    }
  }
}

function materializePackage(
  packageName,
  descriptor,
  destination,
  versions,
  npmCommand,
  nodeCommand,
) {
  mkdirSync(destination, { recursive: true });
  const selectedFiles = sourcePackageFiles(
    descriptor.root,
    packageName,
    npmCommand,
    nodeCommand,
  );
  for (const path of selectedFiles) {
    cpSync(join(descriptor.root, path), join(destination, path), {
      recursive: true,
    });
  }
  writeFileSync(
    join(destination, "package.json"),
    `${JSON.stringify(runtimePackageManifest(descriptor, versions), null, 2)}\n`,
  );
}

function parsePackageManagerVersion(rootManifest) {
  const match = /^bun@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(
    rootManifest.packageManager ?? "",
  );
  if (!match) {
    throw new Error("Root packageManager must pin an exact Bun version");
  }
  return match[1];
}

function validateToolchain(rootManifest, bunCommand, nodeCommand) {
  const expectedBun = parsePackageManagerVersion(rootManifest);
  const actualBun = runPackagerCommand(bunCommand, ["--version"]);
  if (actualBun !== expectedBun) {
    throw new Error(
      `Packaged runtime requires Bun ${expectedBun}, received ${actualBun}`,
    );
  }
  const expectedNode = exactNodeVersion(rootManifest);
  const actualNode = runPackagerCommand(nodeCommand, ["--version"]).replace(
    /^v/u,
    "",
  );
  if (actualNode !== expectedNode) {
    throw new Error(
      `Packaged runtime requires Node ${expectedNode}, received ${actualNode}`,
    );
  }
  return { bunVersion: expectedBun, nodeVersion: expectedNode };
}

function exactNodeVersion(rootManifest) {
  const expectedNode = rootManifest.engines?.node;
  if (
    typeof expectedNode !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(expectedNode)
  ) {
    throw new Error("Root engines.node must pin an exact Node.js version");
  }
  return expectedNode;
}

function defaultNodeCommand() {
  if (!process.versions.bun) return realpathSync(process.execPath);
  const executable = process.platform === "win32" ? "node.exe" : "node";
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = resolve(directory, executable);
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        ["ENOENT", "ENOTDIR", "EACCES"].includes(Reflect.get(error, "code"))
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new Error(
    "Could not resolve Node.js from PATH while running under Bun",
  );
}

function defaultNpmCommand(nodeCommand = defaultNodeCommand()) {
  const adjacentNpm = join(
    dirname(realpathSync(nodeCommand)),
    process.platform === "win32" ? "npm.cmd" : "npm",
  );
  return existsSync(adjacentNpm) ? adjacentNpm : "npm";
}

function npmProcessEnvironment(nodeCommand) {
  const executableDirectory = dirname(realpathSync(nodeCommand));
  const inheritedPath = process.env.PATH?.trim();
  return {
    ...process.env,
    PATH: inheritedPath
      ? `${executableDirectory}${delimiter}${inheritedPath}`
      : executableDirectory,
  };
}

function validateNpmToolchain(rootManifest, npmCommand, nodeCommand) {
  const expectedNode = exactNodeVersion(rootManifest);
  {
    const canonicalNodeCommand = realpathSync(nodeCommand);
    const adjacentNpm = join(
      dirname(canonicalNodeCommand),
      process.platform === "win32" ? "npm.cmd" : "npm",
    );
    const expectedStatus = lstatSync(adjacentNpm, { throwIfNoEntry: false });
    if (!expectedStatus) {
      throw new Error(
        `Node ${expectedNode} does not provide its adjacent npm executable: ${adjacentNpm}`,
      );
    }
    let actualNpmPath;
    try {
      actualNpmPath = realpathSync(npmCommand);
    } catch (error) {
      // error-policy:J2 identify the unresolvable package tool while retaining
      // the filesystem cause.
      throw new Error(
        `Packaged runtime npm is not a concrete file: ${npmCommand}`,
        {
          cause: error,
        },
      );
    }
    const expectedNpmPath = realpathSync(adjacentNpm);
    if (actualNpmPath !== expectedNpmPath) {
      throw new Error(
        `Packaged runtime must use npm bundled with Node ${expectedNode}: expected ${expectedNpmPath}, received ${actualNpmPath}`,
      );
    }
  }

  const npmVersion = runPackagerCommand(npmCommand, ["--version"], {
    env: npmProcessEnvironment(nodeCommand),
  });
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(npmVersion)) {
    throw new Error(
      `Packaged runtime received an invalid npm version: ${npmVersion}`,
    );
  }

  {
    const npmManifestPath = resolve(
      dirname(realpathSync(nodeCommand)),
      "../lib/node_modules/npm/package.json",
    );
    validatePackagePayload(dirname(npmManifestPath), ["package.json"]);
    const bundledNpmVersion = parsePackageJson(npmManifestPath).version;
    if (npmVersion !== bundledNpmVersion) {
      throw new Error(
        `Packaged runtime npm version mismatch: bundled ${String(bundledNpmVersion)}, executed ${npmVersion}`,
      );
    }
  }
  return npmVersion;
}

// Bun's frozen install materializes the dependency graph of every workspace
// reachable from the filtered set — including stubbed workspaces, whose trees
// are exactly what must not ship. After install, keep only packages reachable
// from non-stub closure members and delete the rest (plus any resulting
// dangling .bin launchers) before the audits certify the runtime contents.
function pruneStubOnlyRuntimeDependencies(root, sourceRoot, closure) {
  const canonicalRoot = realpathSync(resolve(root));

  const resolveDependencyFrom = (startDir, dependencyName) => {
    let current = startDir;
    while (true) {
      const candidate = join(
        current,
        "node_modules",
        ...dependencyName.split("/"),
      );
      if (existsSync(join(candidate, "package.json"))) return candidate;
      if (current === canonicalRoot) return null;
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  };

  const reachable = new Set();
  const queue = [];
  for (const descriptor of closure.values()) {
    const workspaceDir = realpathSync(
      workspaceDestination(canonicalRoot, sourceRoot, descriptor.workspaceRoot),
    );
    reachable.add(workspaceDir);
    // Stub roots stay resolvable, but their declared dependencies are the
    // license-prohibited trees this prune exists to remove.
    if (!descriptor.stub) queue.push(workspaceDir);
  }
  while (queue.length > 0) {
    const packageRoot = queue.shift();
    const manifestPath = join(packageRoot, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = parsePackageJson(manifestPath);
    const dependencyNames = new Set();
    for (const section of [...DEPENDENCY_SECTIONS, "peerDependencies"]) {
      for (const dependencyName of Object.keys(manifest[section] ?? {})) {
        dependencyNames.add(dependencyName);
      }
    }
    for (const dependencyName of dependencyNames) {
      const resolved = resolveDependencyFrom(packageRoot, dependencyName);
      if (!resolved) continue;
      const canonical = realpathSync(resolved);
      if (reachable.has(canonical)) continue;
      reachable.add(canonical);
      queue.push(canonical);
    }
  }

  const prunedEntries = [];
  const visitNodeModules = (nodeModulesDir) => {
    if (!existsSync(nodeModulesDir)) return;
    const inspectEntry = (entryPath) => {
      const status = lstatSync(entryPath, { throwIfNoEntry: false });
      if (!status) return;
      if (!existsSync(join(entryPath, "package.json"))) {
        // Not an installed package (helper dirs, stray files): leave for the
        // dedicated audits.
        return;
      }
      const canonical = realpathSync(entryPath);
      if (!reachable.has(canonical)) {
        prunedEntries.push(relative(canonicalRoot, entryPath));
        rmSync(entryPath, { recursive: true, force: true });
        return;
      }
      if (status.isDirectory()) {
        visitNodeModules(join(entryPath, "node_modules"));
      }
    };
    for (const entry of readdirSync(nodeModulesDir, { withFileTypes: true })) {
      if (entry.name === ".bin" || entry.name === ".cache") continue;
      const entryPath = join(nodeModulesDir, entry.name);
      if (entry.name.startsWith("@")) {
        const scopeStatus = lstatSync(entryPath, { throwIfNoEntry: false });
        if (!scopeStatus?.isDirectory() || scopeStatus.isSymbolicLink()) {
          continue;
        }
        for (const scopedEntry of readdirSync(entryPath, {
          withFileTypes: true,
        })) {
          inspectEntry(join(entryPath, scopedEntry.name));
        }
        if (readdirSync(entryPath).length === 0) {
          rmSync(entryPath, { recursive: true, force: true });
        }
        continue;
      }
      inspectEntry(entryPath);
    }
  };
  visitNodeModules(join(canonicalRoot, "node_modules"));
  for (const workspaceDir of reachable) {
    if (isWithinRoot(canonicalRoot, workspaceDir)) {
      visitNodeModules(join(workspaceDir, "node_modules"));
    }
  }

  // Bin launchers for pruned packages are now dangling symlinks that the
  // symlink-containment audit would (correctly) reject; delete them.
  const cleanBinDirectory = (binDir) => {
    if (!existsSync(binDir)) return;
    for (const entry of readdirSync(binDir, { withFileTypes: true })) {
      const entryPath = join(binDir, entry.name);
      const status = lstatSync(entryPath, { throwIfNoEntry: false });
      if (!status?.isSymbolicLink()) continue;
      try {
        realpathSync(entryPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        // error-policy:J6 removing a launcher whose target was pruned.
        rmSync(entryPath, { force: true });
      }
    }
  };
  cleanBinDirectory(join(canonicalRoot, "node_modules", ".bin"));
  for (const workspaceDir of reachable) {
    if (isWithinRoot(canonicalRoot, workspaceDir)) {
      cleanBinDirectory(join(workspaceDir, "node_modules", ".bin"));
    }
  }
  return prunedEntries.sort();
}

function copyInstallSkeleton(
  sourceRoot,
  destination,
  workspaces,
  rootManifest,
) {
  const installRootManifest = structuredClone(rootManifest);
  delete installRootManifest.scripts;
  delete installRootManifest.trustedDependencies;
  writeFileSync(
    join(destination, "package.json"),
    `${JSON.stringify(installRootManifest, null, 2)}\n`,
  );
  cpSync(join(sourceRoot, "bun.lock"), join(destination, "bun.lock"));
  const bunfig = join(sourceRoot, "bunfig.toml");
  if (existsSync(bunfig)) cpSync(bunfig, join(destination, "bunfig.toml"));

  for (const workspaceRoot of workspaces.values()) {
    const workspaceRelative = relative(sourceRoot, workspaceRoot);
    if (!isWithinRoot(sourceRoot, workspaceRoot)) {
      throw new Error(`Workspace skeleton escapes source: ${workspaceRoot}`);
    }
    const manifest = structuredClone(
      parsePackageJson(join(workspaceRoot, "package.json")),
    );
    delete manifest.scripts;
    const target = join(destination, workspaceRelative, "package.json");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  for (const patchPath of Object.values(
    rootManifest.patchedDependencies ?? {},
  )) {
    if (typeof patchPath !== "string") {
      throw new TypeError("patchedDependencies paths must be strings");
    }
    validatePackagePayload(sourceRoot, [patchPath]);
    const target = join(destination, patchPath);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(sourceRoot, patchPath), target);
  }
}

function installedWorkspaceNames(root, sourceRoot, workspaces) {
  const installed = new Set();
  for (const [packageName, workspaceRoot] of workspaces) {
    const packageEntry = packagePath(root, packageName);
    const status = lstatSync(packageEntry, { throwIfNoEntry: false });
    if (!status) continue;
    if (!status.isSymbolicLink()) {
      throw new Error(
        `Bun installed workspace ${packageName} as a non-link entry`,
      );
    }
    const expectedTarget = join(root, relative(sourceRoot, workspaceRoot));
    const actualTarget = realpathSync(packageEntry);
    if (actualTarget !== expectedTarget) {
      throw new Error(
        `Bun workspace link target mismatch for ${packageName}: ${actualTarget}`,
      );
    }
    installed.add(packageName);
  }
  return installed;
}

function assertSamePackageSet(expected, actual) {
  const missing = [...expected].filter((name) => !actual.has(name));
  const extra = [...actual].filter((name) => !expected.has(name));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `Frozen Bun install workspace mismatch; missing=[${missing.join(", ")}], extra=[${extra.join(", ")}]`,
    );
  }
}

export function parseBlockedLifecyclePackagePaths(output) {
  const paths = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\.\/node_modules\/\S+)\s+@\S+/.exec(line.trim());
    if (match) paths.push(match[1]);
  }
  return paths;
}

function collectInstalledLifecycleDescriptors(nodeModulesRoots) {
  const descriptors = new Set();
  const visitedPackageRoots = new Set();

  const inspectPackage = (packageRoot) => {
    const status = lstatSync(packageRoot, { throwIfNoEntry: false });
    if (!status?.isDirectory() || status.isSymbolicLink()) return;
    const canonicalPackageRoot = realpathSync(packageRoot);
    if (visitedPackageRoots.has(canonicalPackageRoot)) return;
    visitedPackageRoots.add(canonicalPackageRoot);

    const manifestPath = join(canonicalPackageRoot, "package.json");
    const manifestStatus = lstatSync(manifestPath, { throwIfNoEntry: false });
    if (!manifestStatus?.isFile() || manifestStatus.isSymbolicLink()) return;
    const manifest = parsePackageJson(manifestPath);
    const lifecycleScripts = Object.keys(manifest.scripts ?? {}).filter(
      (scriptName) => DEPENDENCY_INSTALL_SCRIPTS.has(scriptName),
    );
    if (lifecycleScripts.length > 0) {
      if (
        typeof manifest.name !== "string" ||
        typeof manifest.version !== "string"
      ) {
        throw new Error(
          `Installed lifecycle package has invalid identity: ${manifestPath}`,
        );
      }
      descriptors.add(`${manifest.name}@${manifest.version}`);
    }
    inspectNodeModules(join(canonicalPackageRoot, "node_modules"));
  };

  const inspectNodeModules = (nodeModulesRoot) => {
    const status = lstatSync(nodeModulesRoot, { throwIfNoEntry: false });
    if (!status?.isDirectory() || status.isSymbolicLink()) return;
    for (const entry of readdirSync(nodeModulesRoot, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const entryRoot = join(nodeModulesRoot, entry.name);
      if (entry.name.startsWith("@")) {
        for (const scopedEntry of readdirSync(entryRoot, {
          withFileTypes: true,
        })) {
          if (scopedEntry.isDirectory()) {
            inspectPackage(join(entryRoot, scopedEntry.name));
          }
        }
      } else {
        inspectPackage(entryRoot);
      }
    }
  };

  for (const root of nodeModulesRoots) inspectNodeModules(root);
  return descriptors;
}

function assertExactPolicySet(label, expected, actual) {
  const missing = [...expected].filter((entry) => !actual.has(entry));
  const unexpected = [...actual].filter((entry) => !expected.has(entry));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `${label} drifted; missing=[${missing.sort().join(", ")}], unexpected=[${unexpected.sort().join(", ")}]`,
    );
  }
}

function auditBlockedDependencyScripts(
  root,
  { targetCpu, requiresAgentRuntime, sourceRoot, closure },
) {
  const lifecycleDescriptors = collectInstalledLifecycleDescriptors([
    join(root, "node_modules"),
    ...[...closure.values()].map((descriptor) =>
      join(
        workspaceDestination(root, sourceRoot, descriptor.workspaceRoot),
        "node_modules",
      ),
    ),
  ]);
  const reviewedInventory = new Set([
    ...REVIEWED_TRUSTED_DEPENDENCY_SCRIPT_VERSIONS,
    ...REVIEWED_SUPPRESSED_DEPENDENCY_SCRIPT_VERSIONS,
    ...reviewedBlockedDependencyScriptVersions(targetCpu).values(),
  ]);
  const unreviewed = [...lifecycleDescriptors].filter(
    (descriptor) => !reviewedInventory.has(descriptor),
  );
  if (unreviewed.length > 0) {
    throw new Error(
      `Runtime dependency lifecycle review required for: ${unreviewed.sort().join(", ")}`,
    );
  }
  if (requiresAgentRuntime) {
    assertExactPolicySet(
      "Installed dependency lifecycle inventory",
      reviewedInventory,
      lifecycleDescriptors,
    );
  }
  return [...lifecycleDescriptors]
    .map((descriptor) => descriptor.slice(0, descriptor.lastIndexOf("@")))
    .sort();
}

function remediateLockedRuntimeFiles(root, targetCpu, required) {
  const packageName = `@smithers-orchestrator/jj-linux-${targetCpu}`;
  const binary = join(packagePath(root, packageName), "bin", "jj");
  if (!existsSync(binary)) {
    if (required) {
      throw new Error(`Locked Jujutsu binary is missing: ${packageName}`);
    }
    return;
  }
  chmodSync(binary, 0o755);
  runPackagerCommand(binary, ["--version"], { cwd: root, timeoutMs: 30_000 });
}

function runRuntimeFeatureProbes(root, required, nodeCommand) {
  const probe = `
const assert = require("node:assert/strict");
const fs = require("node:fs");
const has = (name) => {
  try {
    require.resolve(name);
    return true;
  } catch (error) {
    // error-policy:J3 an unresolved optional probe is an explicit absent signal.
    if (error && error.code === "MODULE_NOT_FOUND") return false;
    throw error;
  }
};
const required = process.env.ELIZA_REQUIRE_AGENT_RUNTIME_PROBES === "1";
const requireFeature = (name) => {
  if (required) assert.equal(has(name), true, "missing locked runtime feature: " + name);
  return has(name);
};

if (requireFeature("ffmpeg-static")) {
  const configuredFfmpeg = "/elizaos/external-tools/ffmpeg";
  process.env.FFMPEG_BIN = configuredFfmpeg;
  delete require.cache[require.resolve("ffmpeg-static")];
  const ffmpeg = require("ffmpeg-static");
  assert.equal(ffmpeg, configuredFfmpeg);
  assert.equal(fs.existsSync(require.resolve("ffmpeg-static")), true);
  assert.equal(fs.existsSync(require("node:path").join(require("node:path").dirname(require.resolve("ffmpeg-static")), "ffmpeg")), false);
}

// ffprobe-static belongs to optional evidence/music surfaces outside the
// @elizaos/agent closure. If a caller adds it to another entry closure, keep
// its JavaScript API but require the redistributed binary to remain absent.
if (has("ffprobe-static")) {
  const ffprobe = require("ffprobe-static");
  assert.equal(typeof ffprobe.path, "string");
  assert.equal(fs.existsSync(ffprobe.path), false);
}

for (const name of ["ssh2", "usb", "@parcel/watcher", "@nut-tree-fork/nut-js", "@nut-tree-fork/libnut"]) {
  if (requireFeature(name)) require(name);
}

if (requireFeature("prism-media") && requireFeature("opusscript")) {
  const prism = require("prism-media");
  const encoder = new prism.opus.Encoder({ rate: 48000, channels: 2, frameSize: 960 });
  assert.equal(prism.opus.Encoder.type, "opusscript");
  const packet = encoder._encode(Buffer.alloc(960 * 2 * 2));
  const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
  assert.equal(decoder._decode(packet).length, 960 * 2 * 2);
  encoder.destroy();
  decoder.destroy();
}

if (requireFeature("msgpackr")) {
  const { pack, unpack } = require("msgpackr");
  assert.deepEqual(unpack(pack({ runtime: "locked", count: 89 })), { runtime: "locked", count: 89 });
}

if (requireFeature("blake-hash")) {
  const blakeHash = require("blake-hash");
  assert.equal(blakeHash("blake256").digest("hex"), "716f6e863f744b9ac22c97ec7b76ea5f5908bc5b2f67c61510bfc4751384ea7a");
}

if (requireFeature("tiny-secp256k1")) {
  const secp = require("tiny-secp256k1");
  const privateKey = Buffer.alloc(32); privateKey[31] = 1;
  const hash = Buffer.alloc(32, 2);
  const publicKey = secp.pointFromScalar(privateKey);
  const signature = secp.sign(hash, privateKey);
  assert.equal(secp.verify(hash, publicKey, signature), true);
}
`;
  runPackagerCommand(nodeCommand, ["-e", probe], {
    cwd: root,
    timeoutMs: 120_000,
    env: {
      ...process.env,
      ELIZA_REQUIRE_AGENT_RUNTIME_PROBES: required ? "1" : "0",
    },
  });
}

function fileContainsNeedle(path, needle) {
  const descriptor = openSync(path, "r");
  const chunk = Buffer.allocUnsafe(1024 * 1024 + needle.length);
  let carry = 0;
  try {
    while (true) {
      const count = readSync(descriptor, chunk, carry, 1024 * 1024, null);
      if (count === 0) return false;
      const length = carry + count;
      if (chunk.subarray(0, length).includes(needle)) return true;
      carry = Math.min(needle.length - 1, length);
      chunk.copy(chunk, 0, length - carry, length);
    }
  } finally {
    closeSync(descriptor);
  }
}

function nativeBinaryDescriptor(path, status) {
  if (!status.isFile()) return null;
  const descriptor = openSync(path, "r");
  const header = Buffer.alloc(64);
  let count;
  try {
    count = readSync(descriptor, header, 0, header.length, 0);
  } finally {
    closeSync(descriptor);
  }
  if (
    count >= 20 &&
    header[0] === 0x7f &&
    header.subarray(1, 4).toString("ascii") === "ELF"
  ) {
    if (header[4] !== 2 || header[5] !== 1) {
      return { format: "elf", machine: -1, incompatibleLibc: false };
    }
    return {
      format: "elf",
      machine: header.readUInt16LE(18),
      incompatibleLibc:
        fileContainsNeedle(path, Buffer.from("libc.musl-")) ||
        fileContainsNeedle(path, Buffer.from("ld-musl-")) ||
        fileContainsNeedle(path, Buffer.from("libc.so\0")) ||
        fileContainsNeedle(path, Buffer.from("liblog.so\0")) ||
        fileContainsNeedle(path, Buffer.from("libandroid.so\0")) ||
        fileContainsNeedle(path, Buffer.from("libc++_shared.so\0")),
    };
  }

  if (count >= 64 && header[0] === 0x4d && header[1] === 0x5a) {
    const peOffset = header.readUInt32LE(60);
    if (peOffset >= 64 && peOffset <= 16 * 1024 * 1024) {
      const peSignature = Buffer.alloc(4);
      const peDescriptor = openSync(path, "r");
      let peCount;
      try {
        peCount = readSync(peDescriptor, peSignature, 0, 4, peOffset);
      } finally {
        closeSync(peDescriptor);
      }
      if (peCount === 4 && peSignature.equals(Buffer.from("PE\0\0"))) {
        return { format: "pe" };
      }
    }
  }
  if (count >= 4) {
    const magic = header.readUInt32BE(0);
    if (
      magic === 0xfeedface ||
      magic === 0xfeedfacf ||
      magic === 0xcefaedfe ||
      magic === 0xcffaedfe ||
      magic === 0xcafebabe ||
      magic === 0xbebafeca ||
      magic === 0xcafebabf ||
      magic === 0xbfbafeca
    ) {
      return { format: "mach-o" };
    }
  }
  return null;
}

/** Removes binaries that cannot execute on the target Linux glibc runtime. */
export function pruneIncompatibleNativeArtifacts(root, targetCpu) {
  const expectedMachine =
    targetCpu === "x64" ? 62 : targetCpu === "arm64" ? 183 : null;
  if (expectedMachine === null) {
    throw new Error(`Unsupported native artifact target CPU: ${targetCpu}`);
  }
  const canonicalRoot = realpathSync(resolve(root));
  const removedAbsolutePaths = new Set();
  const removedRelativePaths = [];
  walkTree(canonicalRoot, (entryPath, status) => {
    const descriptor = nativeBinaryDescriptor(entryPath, status);
    const incompatible =
      descriptor?.format === "pe" ||
      descriptor?.format === "mach-o" ||
      (descriptor?.format === "elf" &&
        (descriptor.machine !== expectedMachine ||
          descriptor.incompatibleLibc));
    if (!incompatible) return;
    removedAbsolutePaths.add(resolve(entryPath));
    removedRelativePaths.push(relative(canonicalRoot, entryPath));
    rmSync(entryPath, { force: true });
  });

  walkTree(canonicalRoot, (entryPath, status) => {
    if (!status.isSymbolicLink()) return;
    const target = resolve(dirname(entryPath), readlinkSync(entryPath));
    if (removedAbsolutePaths.has(target)) {
      removedRelativePaths.push(relative(canonicalRoot, entryPath));
      rmSync(entryPath, { force: true });
    }
  });

  walkTree(canonicalRoot, (entryPath, status) => {
    const descriptor = nativeBinaryDescriptor(entryPath, status);
    if (
      descriptor?.format === "pe" ||
      descriptor?.format === "mach-o" ||
      (descriptor?.format === "elf" &&
        (descriptor.machine !== expectedMachine || descriptor.incompatibleLibc))
    ) {
      throw new Error(
        `Packaged runtime retains an incompatible native artifact: ${relative(canonicalRoot, entryPath)}`,
      );
    }
  });
  return removedRelativePaths.sort();
}

/**
 * Discards node-gyp's compile-only graph while retaining its loadable output.
 * Makefiles, dependency graphs, and intermediate objects are neither needed by
 * Node at runtime nor relocatable: node-gyp records absolute build paths in
 * them even when the final addon is position-independent.
 */
export function pruneGeneratedNativeBuildMetadata(root) {
  const canonicalRoot = realpathSync(resolve(root));
  const removals = new Set();

  walkTree(canonicalRoot, (entryPath, status) => {
    const relativePath = relative(canonicalRoot, entryPath);
    const segments = relativePath.split(sep);
    const nodeModulesIndex = segments.lastIndexOf("node_modules");
    const buildIndex = segments.indexOf("build", nodeModulesIndex + 1);
    if (nodeModulesIndex < 0 || buildIndex < 0) return;

    for (const directory of [".deps", "node_gyp_bins", "obj.target"]) {
      const directoryIndex = segments.indexOf(directory, buildIndex + 1);
      if (directoryIndex >= 0) {
        removals.add(
          join(canonicalRoot, ...segments.slice(0, directoryIndex + 1)),
        );
        return;
      }
    }

    if (!status.isFile()) return;
    const leaf = segments.at(-1);
    if (
      leaf === "Makefile" ||
      leaf === "config.gypi" ||
      leaf === "gyp-mac-tool" ||
      leaf?.endsWith(".mk")
    ) {
      removals.add(entryPath);
    }
  });

  const removedRelativePaths = [...removals]
    .map((entryPath) => relative(canonicalRoot, entryPath))
    .sort();
  for (const entryPath of [...removals].sort(
    (left, right) => right.length - left.length,
  )) {
    rmSync(entryPath, { recursive: true, force: true });
  }
  return removedRelativePaths;
}

/**
 * Removes redistributed FFmpeg executables from npm wrappers. Linux packages
 * bind those wrappers to a separately maintained platform FFmpeg at launch,
 * avoiding an unverifiable static build while preserving dependency APIs.
 */
export function removeBundledMediaToolBinaries(root) {
  const canonicalRoot = realpathSync(resolve(root));
  const candidates = [
    join(packagePath(canonicalRoot, "ffmpeg-static"), "ffmpeg"),
    join(packagePath(canonicalRoot, "ffmpeg-static"), "ffmpeg.exe"),
    join(packagePath(canonicalRoot, "ffprobe-static"), "bin"),
  ];
  const removed = [];
  for (const candidate of candidates) {
    const status = lstatSync(candidate, { throwIfNoEntry: false });
    if (!status) continue;
    if (status.isDirectory()) {
      walkTree(candidate, (entryPath, entryStatus) => {
        if (entryStatus.isFile() || entryStatus.isSymbolicLink()) {
          removed.push(relative(canonicalRoot, entryPath));
        }
      });
    } else {
      removed.push(relative(canonicalRoot, candidate));
    }
    rmSync(candidate, { recursive: true, force: true });
  }

  for (const candidate of candidates) {
    if (lstatSync(candidate, { throwIfNoEntry: false })) {
      throw new Error(
        `Packaged runtime retains a bundled media executable: ${relative(canonicalRoot, candidate)}`,
      );
    }
  }
  return removed.sort();
}

/** Removes package-manager state that cannot participate in the frozen tree. */
export function removeInstallerLockArtifacts(root) {
  const canonicalRoot = realpathSync(resolve(root));
  const removals = [];
  walkTree(canonicalRoot, (entryPath, status) => {
    if (
      (status.isFile() || status.isSymbolicLink()) &&
      INSTALLER_LOCK_BASENAMES.has(basename(entryPath))
    ) {
      removals.push(entryPath);
    }
  });
  const removedRelativePaths = removals
    .map((entryPath) => relative(canonicalRoot, entryPath))
    .sort();
  for (const entryPath of removals) rmSync(entryPath, { force: true });
  return removedRelativePaths;
}

/** Removes build-system state that npm's package inventory can otherwise admit. */
export function pruneGeneratedPackageArtifacts(root) {
  const canonicalRoot = realpathSync(resolve(root));
  const removals = [];
  walkTree(canonicalRoot, (entryPath) => {
    if (isGeneratedPackageArtifact(entryPath)) removals.push(entryPath);
  });
  const removedRelativePaths = removals
    .map((entryPath) => relative(canonicalRoot, entryPath))
    .sort();
  for (const entryPath of [...removals].sort(
    (left, right) => right.length - left.length,
  )) {
    rmSync(entryPath, { recursive: true, force: true });
  }
  return removedRelativePaths;
}

export function auditRuntimeSourceResidue(root, forbiddenRoots) {
  const needles = [...new Set(forbiddenRoots.map((path) => resolve(path)))].map(
    (path) => Buffer.from(path),
  );
  walkTree(realpathSync(resolve(root)), (entryPath, status) => {
    const runtimeRelative = relative(root, entryPath);
    if (isGeneratedPackageArtifact(entryPath)) {
      throw new Error(
        `Packaged runtime contains a generated package artifact: ${runtimeRelative}`,
      );
    }
    if (!status.isFile()) return;
    for (const needle of needles) {
      if (fileContainsNeedle(entryPath, needle)) {
        throw new Error(
          `Packaged runtime contains source checkout path in ${relative(root, entryPath)}`,
        );
      }
    }
    if (INSTALLER_LOCK_BASENAMES.has(basename(runtimeRelative))) {
      throw new Error(
        `Packaged runtime contains an installer lock artifact: ${runtimeRelative}`,
      );
    }
  });
}

function workspaceDestination(root, sourceRoot, workspaceRoot) {
  const workspaceRelative = relative(sourceRoot, workspaceRoot);
  if (workspaceRelative === "" || workspaceRelative.startsWith(`..${sep}`)) {
    throw new Error(`Invalid runtime workspace path: ${workspaceRoot}`);
  }
  return join(root, workspaceRelative);
}

function removeInstallSkeletonFiles(
  root,
  sourceRoot,
  workspaces,
  closureNames,
  rootManifest,
) {
  for (const [packageName, workspaceRoot] of workspaces) {
    if (closureNames.has(packageName)) continue;
    rmSync(
      join(
        workspaceDestination(root, sourceRoot, workspaceRoot),
        "package.json",
      ),
      {
        force: true,
      },
    );
  }
  for (const patchPath of Object.values(
    rootManifest.patchedDependencies ?? {},
  )) {
    if (typeof patchPath === "string")
      rmSync(join(root, patchPath), { force: true });
  }
  rmSync(join(root, "bun.lock"), { force: true });
  rmSync(join(root, "bunfig.toml"), { force: true });
}

function digestPackagePayload(packageRoot) {
  const digest = createHash("sha256");
  const visit = (directory, relativeDirectory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    )) {
      if (entry.name === "node_modules") continue;
      const entryPath = join(directory, entry.name);
      const entryRelative = join(relativeDirectory, entry.name)
        .split(sep)
        .join("/");
      const status = lstatSync(entryPath);
      if (status.isDirectory()) {
        digest.update(`directory\0${entryRelative}\0${status.mode}\0`);
        visit(entryPath, entryRelative);
      } else if (status.isFile()) {
        digest.update(`file\0${entryRelative}\0${status.mode}\0`);
        digest.update(readFileSync(entryPath));
      } else if (status.isSymbolicLink()) {
        digest.update(
          `symlink\0${entryRelative}\0${status.mode}\0${readlinkSync(entryPath)}\0`,
        );
      } else {
        throw new Error(
          `Installed package contains unsupported payload entry: ${entryRelative}`,
        );
      }
    }
  };
  visit(packageRoot, "");
  return digest.digest("hex");
}

/**
 * Captures every package instance in the materialized runtime after native and
 * payload pruning. The committed Bun lock remains the install authority; this
 * purpose-built inventory lets later distribution stages audit the exact tree
 * without retaining an installer lock that could be mistaken for reinstallable
 * state.
 */
function writeRuntimeDependencyInventory(
  root,
  sourceRoot,
  closure,
  lockDigest,
  lockedAliasIdentities,
) {
  const canonicalRoot = realpathSync(resolve(root));
  const packageRecords = new Map();
  const visitedNodeModules = new Set();

  function inspectPackage(packageEntry, expectedName) {
    const status = lstatSync(packageEntry, { throwIfNoEntry: false });
    if (!status || (!status.isDirectory() && !status.isSymbolicLink())) {
      throw new Error(`Installed package entry is invalid: ${packageEntry}`);
    }
    const packageRoot = realpathSync(packageEntry);
    if (!isWithinRoot(canonicalRoot, packageRoot)) {
      throw new Error(`Installed package escapes the runtime: ${packageEntry}`);
    }

    const prior = packageRecords.get(packageRoot);
    if (prior) {
      if (prior.installName !== expectedName) {
        throw new Error(
          `Installed package aliases different install names at ${packageRoot}: ${prior.installName} and ${expectedName}`,
        );
      }
      return;
    }

    const manifestPath = join(packageRoot, "package.json");
    const manifestStatus = lstatSync(manifestPath, { throwIfNoEntry: false });
    if (!manifestStatus?.isFile() || manifestStatus.isSymbolicLink()) {
      throw new Error(
        `Installed package has no regular manifest: ${packageEntry}`,
      );
    }
    const manifestBytes = readFileSync(manifestPath);
    const manifest = parsePackageJson(manifestPath);
    assertAllowedRuntimePackageIdentity(expectedName, manifest.name);
    validateInstalledPackageIdentity(
      expectedName,
      manifest,
      lockedAliasIdentities,
      manifestPath,
    );

    packageRecords.set(packageRoot, {
      path: relative(canonicalRoot, packageRoot).split(sep).join("/"),
      installName: expectedName,
      name: manifest.name,
      version: manifest.version,
      packageJsonSha256: createHash("sha256")
        .update(manifestBytes)
        .digest("hex"),
      payloadSha256: digestPackagePayload(packageRoot),
    });
    inspectNodeModules(join(packageRoot, "node_modules"));
  }

  function inspectNodeModules(nodeModulesEntry) {
    const status = lstatSync(nodeModulesEntry, { throwIfNoEntry: false });
    if (!status) return;
    if (!status.isDirectory() && !status.isSymbolicLink()) {
      throw new Error(
        `Installed node_modules entry is invalid: ${nodeModulesEntry}`,
      );
    }
    const nodeModulesRoot = realpathSync(nodeModulesEntry);
    if (!isWithinRoot(canonicalRoot, nodeModulesRoot)) {
      throw new Error(
        `Installed node_modules escapes the runtime: ${nodeModulesEntry}`,
      );
    }
    if (visitedNodeModules.has(nodeModulesRoot)) return;
    visitedNodeModules.add(nodeModulesRoot);

    for (const entry of readdirSync(nodeModulesRoot, {
      withFileTypes: true,
    }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name.startsWith(".")) continue;
      const entryPath = join(nodeModulesRoot, entry.name);
      if (entry.name.startsWith("@")) {
        const scopeStatus = lstatSync(entryPath);
        if (!scopeStatus.isDirectory() || scopeStatus.isSymbolicLink()) {
          throw new Error(`Installed package scope is invalid: ${entryPath}`);
        }
        for (const scopedEntry of readdirSync(entryPath, {
          withFileTypes: true,
        }).sort((left, right) => left.name.localeCompare(right.name))) {
          if (scopedEntry.name.startsWith(".")) continue;
          inspectPackage(
            join(entryPath, scopedEntry.name),
            `${entry.name}/${scopedEntry.name}`,
          );
        }
      } else {
        inspectPackage(entryPath, entry.name);
      }
    }
  }

  inspectNodeModules(join(canonicalRoot, "node_modules"));
  for (const [packageName, descriptor] of [...closure].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    inspectPackage(
      workspaceDestination(canonicalRoot, sourceRoot, descriptor.workspaceRoot),
      packageName,
    );
  }

  const packages = [...packageRecords.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  if (packages.length === 0) {
    throw new Error("Prepared runtime dependency inventory is empty");
  }
  const packagesSha256 = createHash("sha256")
    .update(JSON.stringify(packages))
    .digest("hex");
  const bytes = Buffer.from(
    `${JSON.stringify(
      {
        schemaVersion: RUNTIME_DEPENDENCY_INVENTORY_SCHEMA_VERSION,
        generatedFrom: "frozen-bun-install",
        sourceLockSha256: lockDigest,
        packageCount: packages.length,
        packagesSha256,
        packages,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(canonicalRoot, RUNTIME_DEPENDENCY_INVENTORY_FILE), bytes);
  return {
    file: RUNTIME_DEPENDENCY_INVENTORY_FILE,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    packageCount: packages.length,
    packagesSha256,
  };
}

function writeRuntimeRootManifest(
  root,
  runtimeVersion,
  versions,
  nodeVersion,
  bunVersion,
  npmVersion,
  lockDigest,
  blockedLifecyclePackages,
  targetCpu,
  removedNativeArtifacts,
  removedNativeBuildMetadata,
  removedMediaToolBinaries,
  removedInstallerLocks,
  removedGeneratedPackageArtifacts,
  dependencyInventory,
  stubbedPackages,
) {
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "elizaos-packaged-runtime",
        version: runtimeVersion,
        private: true,
        packageManager: `bun@${bunVersion}`,
        dependencies: Object.fromEntries(
          [...versions].sort(([left], [right]) => left.localeCompare(right)),
        ),
        elizaosRuntime: {
          schemaVersion: PACKAGED_RUNTIME_SCHEMA_VERSION,
          sourceLockSha256: lockDigest,
          // Workspace packages replaced by inert stubs because their real
          // dependency trees carry licenses that cannot be redistributed.
          stubbedPackages: [...stubbedPackages].sort(),
          dependencyInventory,
          blockedLifecyclePackages,
          installerLocks: {
            removedCount: removedInstallerLocks.length,
            removedPathsSha256: createHash("sha256")
              .update(JSON.stringify(removedInstallerLocks))
              .digest("hex"),
          },
          generatedPackageArtifacts: {
            removedCount: removedGeneratedPackageArtifacts.length,
            removedPathsSha256: createHash("sha256")
              .update(JSON.stringify(removedGeneratedPackageArtifacts))
              .digest("hex"),
          },
          toolchain: {
            node: nodeVersion,
            bun: bunVersion,
            npm: npmVersion,
          },
          nativeArtifacts: {
            os: "linux",
            cpu: targetCpu,
            libc: "glibc",
            removedCount: removedNativeArtifacts.length,
            removedPathsSha256: createHash("sha256")
              .update(JSON.stringify(removedNativeArtifacts))
              .digest("hex"),
            discardedBuildMetadataCount: removedNativeBuildMetadata.length,
            discardedBuildMetadataPathsSha256: createHash("sha256")
              .update(JSON.stringify(removedNativeBuildMetadata))
              .digest("hex"),
          },
          externalTools: {
            ffmpeg: {
              suppliedByRuntime: false,
              environment: [
                "FFMPEG_BIN",
                "FFMPEG_PATH",
                "ELIZA_FFMPEG_PATH",
                "FFPROBE_PATH",
                "FFMPEG_LOCATION",
              ],
              removedBundledBinaryCount: removedMediaToolBinaries.length,
              removedBundledPathsSha256: createHash("sha256")
                .update(JSON.stringify(removedMediaToolBinaries))
                .digest("hex"),
            },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
}

export function preparePackagedRuntime({
  sourceRoot,
  destinationRoot,
  entryPackages,
  stubPackages = [],
  bunCommand = "bun",
  nodeCommand = defaultNodeCommand(),
  npmCommand = defaultNpmCommand(nodeCommand),
  targetOs = process.platform,
  targetCpu = process.arch,
  runtimeValidationPolicy = "production",
  onProgress = () => {},
}) {
  if (typeof onProgress !== "function") {
    throw new TypeError("onProgress must be a function");
  }
  if (targetOs !== "linux" || !["x64", "arm64"].includes(targetCpu)) {
    throw new Error(
      `Unsupported packaged runtime target: ${targetOs}/${targetCpu}`,
    );
  }
  if (targetOs !== process.platform || targetCpu !== process.arch) {
    throw new Error(
      `Packaged native runtime must be built on its target architecture: requested ${targetOs}/${targetCpu}, host ${process.platform}/${process.arch}`,
    );
  }

  const canonicalSourceRoot = realpathSync(resolve(sourceRoot));
  const unresolvedDestination = resolve(destinationRoot);
  const destinationStatus = lstatSync(unresolvedDestination, {
    throwIfNoEntry: false,
  });
  if (destinationStatus?.isSymbolicLink()) {
    throw new Error(
      `Packaged runtime destination cannot be a symlink: ${unresolvedDestination}`,
    );
  }
  const destination = canonicalizePotentialPath(unresolvedDestination);
  if (isWithinRoot(destination, canonicalSourceRoot)) {
    throw new Error(
      `Packaged runtime destination cannot contain the source root: ${destination}`,
    );
  }
  assertSafeRuntimeDestination(canonicalSourceRoot, destination);
  if (!existsSync(join(canonicalSourceRoot, "bun.lock"))) {
    throw new Error("Packaged runtime requires the committed bun.lock");
  }
  if (!existsSync(join(canonicalSourceRoot, ".nvmrc"))) {
    throw new Error("Packaged runtime requires the committed .nvmrc");
  }
  const requiredSourceFiles = ["package.json", "bun.lock", ".nvmrc"];
  if (existsSync(join(canonicalSourceRoot, "bunfig.toml"))) {
    requiredSourceFiles.push("bunfig.toml");
  }
  validatePackagePayload(canonicalSourceRoot, requiredSourceFiles);
  const rootManifest = parsePackageJson(
    join(canonicalSourceRoot, "package.json"),
  );
  const pinnedNodeVersion = exactNodeVersion(rootManifest);
  const nvmVersion = readFileSync(
    join(canonicalSourceRoot, ".nvmrc"),
    "utf8",
  ).trim();
  if (nvmVersion !== pinnedNodeVersion) {
    throw new Error(
      `Root .nvmrc must match engines.node exactly: expected ${pinnedNodeVersion}, received ${JSON.stringify(nvmVersion)}`,
    );
  }
  const { bunVersion, nodeVersion } = validateToolchain(
    rootManifest,
    bunCommand,
    nodeCommand,
  );
  const npmVersion = validateNpmToolchain(
    rootManifest,
    npmCommand,
    nodeCommand,
  );
  const lockBytes = readFileSync(join(canonicalSourceRoot, "bun.lock"));
  const lockDigest = createHash("sha256").update(lockBytes).digest("hex");
  const lockedAliasIdentities = parseLockedNpmAliasIdentities(
    lockBytes.toString("utf8"),
  );

  const closure = resolveRuntimeWorkspaceClosure(
    canonicalSourceRoot,
    entryPackages,
    stubPackages,
  );
  validateRequiredPeerClosure(closure);
  validateWorkspaceLifecyclePolicy(closure);
  const versions = packageVersions(closure);
  validatePreparedDependencyParity(closure, versions);
  const runtimeVersion = versions.get(entryPackages[0]);
  if (!runtimeVersion) {
    throw new Error(`Entry package ${entryPackages[0]} is outside the closure`);
  }
  const workspaces = workspaceIndex(canonicalSourceRoot);
  for (const workspaceRoot of workspaces.values()) {
    if (isWithinRoot(destination, workspaceRoot)) {
      throw new Error(
        `Packaged runtime destination cannot contain a source workspace: ${destination}`,
      );
    }
  }
  const closureNames = new Set(closure.keys());
  if (
    !new Set(["production", "lightweight-fixture"]).has(runtimeValidationPolicy)
  ) {
    throw new TypeError(
      `Unknown packaged runtime validation policy: ${String(runtimeValidationPolicy)}`,
    );
  }
  if (
    runtimeValidationPolicy === "lightweight-fixture" &&
    (rootManifest.name !== "packaged-runtime-fixture" ||
      rootManifest.private !== true)
  ) {
    throw new Error(
      "The lightweight packaged runtime policy is restricted to the private test fixture",
    );
  }
  const requiresAgentRuntime =
    closureNames.has("@elizaos/agent") &&
    runtimeValidationPolicy === "production";
  const sortedPackages = [...closure].sort(([left], [right]) =>
    left.localeCompare(right),
  );

  mkdirSync(dirname(destination), { recursive: true });
  const lock = acquirePreparationLock(destination, canonicalSourceRoot);
  let stagingRoot;
  let completed = false;
  try {
    assertNoInterruptedPreparation(destination, lock.path);
    stagingRoot = mkdtempSync(
      join(dirname(destination), `.${basename(destination)}.prepare-`),
    );
    onProgress("Creating frozen-lock workspace skeleton");
    copyInstallSkeleton(
      canonicalSourceRoot,
      stagingRoot,
      workspaces,
      rootManifest,
    );
    onProgress("Installing the locked production dependency tree");
    runPackagerCommand(
      bunCommand,
      [
        "install",
        "--omit=dev",
        "--frozen-lockfile",
        "--linker=hoisted",
        "--backend=copyfile",
        "--ignore-scripts",
        "--no-progress",
        `--os=${targetOs}`,
        `--cpu=${targetCpu}`,
        // Stubbed workspaces are deliberately not filtered in: bun then never
        // installs their (license-prohibited) dependency trees.
        ...sortedPackages
          .filter(([, descriptor]) => !descriptor.stub)
          .flatMap(([packageName]) => ["--filter", packageName]),
      ],
      {
        cwd: stagingRoot,
        env: {
          ...process.env,
          ELIZA_COMPUTERUSE_DRIVER: "nutjs",
        },
      },
    );
    onProgress("Pruning stub-only dependency trees");
    pruneStubOnlyRuntimeDependencies(stagingRoot, canonicalSourceRoot, closure);
    auditRuntimeSymlinkContainment(stagingRoot);

    const removedMediaToolBinaries = requiresAgentRuntime
      ? removeBundledMediaToolBinaries(stagingRoot)
      : [];

    onProgress("Pruning incompatible native runtime artifacts");
    const removedNativeArtifacts = pruneIncompatibleNativeArtifacts(
      stagingRoot,
      targetCpu,
    );
    const removedNativeBuildMetadata =
      pruneGeneratedNativeBuildMetadata(stagingRoot);

    const installedNames = installedWorkspaceNames(
      stagingRoot,
      canonicalSourceRoot,
      workspaces,
    );
    // Bun links only filtered workspaces, so stub packages may lack their
    // node_modules entry; dependents still need the name to resolve to the
    // inert stub payload.
    for (const [packageName, descriptor] of closure) {
      if (!descriptor.stub || installedNames.has(packageName)) continue;
      const linkPath = packagePath(stagingRoot, packageName);
      const workspaceDir = workspaceDestination(
        stagingRoot,
        canonicalSourceRoot,
        descriptor.workspaceRoot,
      );
      mkdirSync(dirname(linkPath), { recursive: true });
      symlinkSync(relative(dirname(linkPath), workspaceDir), linkPath, "dir");
      installedNames.add(packageName);
    }
    assertSamePackageSet(closureNames, installedNames);
    const nestedWorkspaceDependencies = snapshotNestedWorkspaceDependencies(
      stagingRoot,
      canonicalSourceRoot,
      closure,
    );
    const blockedLifecyclePackages = auditBlockedDependencyScripts(
      stagingRoot,
      {
        targetCpu,
        requiresAgentRuntime,
        sourceRoot: canonicalSourceRoot,
        closure,
      },
    );
    remediateLockedRuntimeFiles(stagingRoot, targetCpu, requiresAgentRuntime);

    for (const [index, [packageName, descriptor]] of sortedPackages.entries()) {
      onProgress(
        `Materializing workspace ${index + 1}/${sortedPackages.length}: ${packageName}`,
      );
      const packageDestination = workspaceDestination(
        stagingRoot,
        canonicalSourceRoot,
        descriptor.workspaceRoot,
      );
      if (descriptor.stub) {
        writeStubPackage(
          descriptor,
          packageDestination,
          versions,
          canonicalSourceRoot,
        );
      } else {
        materializePackage(
          packageName,
          descriptor,
          packageDestination,
          versions,
          npmCommand,
          nodeCommand,
        );
      }
    }
    assertNestedWorkspaceDependenciesUnchanged(
      stagingRoot,
      canonicalSourceRoot,
      closure,
      nestedWorkspaceDependencies,
    );
    auditRuntimeWorkspaceManifests(
      stagingRoot,
      canonicalSourceRoot,
      closure,
      versions,
    );
    removedNativeArtifacts.push(
      ...pruneIncompatibleNativeArtifacts(stagingRoot, targetCpu),
    );
    removedNativeArtifacts.sort();
    removedNativeBuildMetadata.push(
      ...pruneGeneratedNativeBuildMetadata(stagingRoot),
    );
    removedNativeBuildMetadata.sort();
    if (requiresAgentRuntime) {
      removedMediaToolBinaries.push(
        ...removeBundledMediaToolBinaries(stagingRoot),
      );
      removedMediaToolBinaries.sort();
    }
    removeInstallSkeletonFiles(
      stagingRoot,
      canonicalSourceRoot,
      workspaces,
      closureNames,
      rootManifest,
    );
    const removedGeneratedPackageArtifacts =
      pruneGeneratedPackageArtifacts(stagingRoot);
    const removedInstallerLocks = removeInstallerLockArtifacts(stagingRoot);
    const dependencyInventory = writeRuntimeDependencyInventory(
      stagingRoot,
      canonicalSourceRoot,
      closure,
      lockDigest,
      lockedAliasIdentities,
    );
    writeRuntimeRootManifest(
      stagingRoot,
      runtimeVersion,
      versions,
      nodeVersion,
      bunVersion,
      npmVersion,
      lockDigest,
      blockedLifecyclePackages,
      targetCpu,
      removedNativeArtifacts,
      removedNativeBuildMetadata,
      removedMediaToolBinaries,
      removedInstallerLocks,
      removedGeneratedPackageArtifacts,
      dependencyInventory,
      [...closure]
        .filter(([, descriptor]) => descriptor.stub)
        .map(([packageName]) => packageName),
    );

    const pluginsManifest = join(canonicalSourceRoot, "plugins.json");
    if (existsSync(pluginsManifest)) {
      validatePackagePayload(canonicalSourceRoot, ["plugins.json"]);
      cpSync(pluginsManifest, join(stagingRoot, "plugins.json"));
    }

    const entryManifest = parsePackageJson(
      join(packagePath(stagingRoot, entryPackages[0]), "package.json"),
    );
    const bin = Object.values(entryManifest.bin ?? {})[0];
    if (
      typeof bin !== "string" ||
      !existsSync(join(packagePath(stagingRoot, entryPackages[0]), bin))
    ) {
      throw new Error(
        `Installed entry package ${entryPackages[0]} has no executable bin`,
      );
    }

    onProgress("Probing native and fallback runtime features");
    runRuntimeFeatureProbes(stagingRoot, requiresAgentRuntime, nodeCommand);
    auditRuntimeSymlinkContainment(stagingRoot);
    auditRuntimeSourceResidue(stagingRoot, [canonicalSourceRoot, stagingRoot]);

    commitPreparedRuntime(stagingRoot, destination, lock.token);
    completed = true;
    return {
      entryPackage: entryPackages[0],
      packageCount: closure.size,
      runtimeVersion,
    };
  } finally {
    if (!completed && stagingRoot) {
      rmSync(stagingRoot, { recursive: true, force: true });
    }
    releasePreparationLock(lock);
  }
}

export function parseArguments(argv) {
  let sourceRoot;
  let destinationRoot;
  let bunCommand = "bun";
  let nodeCommand = defaultNodeCommand();
  let npmCommand;
  let targetOs;
  let targetCpu;
  const entryPackages = [];
  const stubPackages = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--source-root" && value) sourceRoot = value;
    else if (argument === "--destination-root" && value)
      destinationRoot = value;
    else if (argument === "--entry" && value) entryPackages.push(value);
    else if (argument === "--stub" && value) stubPackages.push(value);
    else if (argument === "--bun" && value) bunCommand = value;
    else if (argument === "--node" && value) nodeCommand = value;
    else if (argument === "--npm" && value) npmCommand = value;
    else if (argument === "--target-os" && value) targetOs = value;
    else if (argument === "--target-cpu" && value) targetCpu = value;
    else throw new TypeError(`Unknown or incomplete argument: ${argument}`);
    index += 1;
  }
  if (!sourceRoot || !destinationRoot) {
    throw new TypeError("--source-root and --destination-root are required");
  }
  return {
    sourceRoot,
    destinationRoot,
    entryPackages,
    stubPackages,
    bunCommand,
    nodeCommand,
    npmCommand: npmCommand ?? defaultNpmCommand(nodeCommand),
    targetOs,
    targetCpu,
  };
}

function main(argv = process.argv.slice(2)) {
  const result = preparePackagedRuntime({
    ...parseArguments(argv),
    onProgress: (message) => process.stdout.write(`${message}\n`),
  });
  process.stdout.write(
    `Prepared ${result.entryPackage} ${result.runtimeVersion} with ${result.packageCount} workspace packages\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    // error-policy:J1 CLI boundary reports packaging failures to the build job.
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

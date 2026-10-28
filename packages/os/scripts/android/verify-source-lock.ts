#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hashFile } from "./release-contract.ts";
import { verifyDeviceSource } from "./verify-device-source.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
export const defaultLockPath = join(repositoryRoot, "android/aosp.lock.json");

function fail(message) {
  throw new Error(`[aosp-lock] ${message}`);
}

function gitHead(directory) {
  const result = spawnSync("git", ["-C", directory, "rev-parse", "HEAD"], {
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    fail(`cannot resolve Git HEAD for ${directory}`);
  }
  return result.stdout.trim();
}

function isRelativePath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    value.split("/").every((part) => part && part !== "." && part !== "..")
  );
}

export function loadProfile(profileName, lockPath = defaultLockPath) {
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  if (
    lock?.schemaVersion !== 1 ||
    !lock.profiles ||
    typeof lock.profiles !== "object" ||
    Array.isArray(lock.profiles)
  ) {
    fail(`${lockPath} is not an AOSP lock schemaVersion 1 document`);
  }
  const profile = lock.profiles[profileName];
  if (!Object.hasOwn(lock.profiles, profileName) || !profile)
    fail(`unknown profile ${profileName}`);
  if (profile.kind !== "virtual" && profile.kind !== "physical") {
    fail(`${profileName}.kind must be virtual or physical`);
  }
  for (const field of ["url", "tag", "tagObject", "commit"]) {
    if (
      typeof profile.manifest?.[field] !== "string" ||
      !profile.manifest[field].trim()
    ) {
      fail(`${profileName}.manifest.${field} is required`);
    }
  }
  for (const field of ["tagObject", "commit"]) {
    if (!/^[0-9a-f]{40}$/.test(profile.manifest[field]))
      fail(`${profileName}.manifest.${field} must be a full Git object ID`);
  }
  if (profile.sourceInventory) readSourceInventory(profile, lockPath);
  return profile;
}

function readSourceInventory(profile, lockPath) {
  const reference = profile.sourceInventory;
  if (
    profile.kind !== "physical" ||
    !isRelativePath(reference?.path) ||
    !/^[0-9a-f]{64}$/.test(reference?.sha256 ?? "") ||
    ["sourceTarget", "codename", "androidRelease"].some(
      (field) =>
        typeof profile.device?.[field] !== "string" || !profile.device[field],
    )
  )
    fail("invalid complete source inventory reference");
  const inventoryPath = resolve(dirname(lockPath), reference.path);
  if (hashFile(inventoryPath).sha256 !== reference.sha256)
    fail("complete source inventory SHA-256 differs from the profile");
  const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
  if (
    inventory.target !== profile.device.sourceTarget ||
    inventory.device?.codename !== profile.device.codename ||
    inventory.device?.androidRelease !== profile.device.androidRelease ||
    ["tag", "tagObject", "commit"].some(
      (field) => inventory.manifest?.[field] !== profile.manifest[field],
    )
  )
    fail(
      "complete source inventory target or manifest differs from the profile",
    );
  return inventoryPath;
}

/** Verify every recorded input of an inventory-backed physical source profile. */
export function verifyProfileSource(
  profile,
  { aospRoot, archivePath, lockPath = defaultLockPath, appliedPatches = [] },
) {
  if (!aospRoot || !archivePath)
    fail("complete source inventory requires --aosp-root and --vendor-archive");
  return verifyDeviceSource({
    source: aospRoot,
    factory: archivePath,
    lock: readSourceInventory(profile, lockPath),
    expected: {
      target: profile.device.sourceTarget,
      codename: profile.device.codename,
      androidRelease: profile.device.androidRelease,
    },
    appliedPatches,
  });
}

export function verifyArchive(profile, archivePath) {
  const contract = profile.proprietaryArchive;
  if (!contract) fail("selected profile has no proprietary archive contract");
  const resolved = resolve(archivePath);
  if (!existsSync(resolved))
    fail(`proprietary archive is missing: ${resolved}`);
  if (basename(resolved) !== contract.filename) {
    fail(`archive filename must be ${contract.filename}`);
  }
  const { sizeBytes: size, sha256: digest } = hashFile(resolved);
  if (size !== contract.sizeBytes) {
    fail(`archive size ${size} does not match locked ${contract.sizeBytes}`);
  }
  if (digest !== contract.sha256) {
    fail(`archive SHA-256 ${digest} does not match locked ${contract.sha256}`);
  }
  return { path: resolved, sizeBytes: size, sha256: digest };
}

export function verifyCheckout(profile, aospRoot) {
  if (profile.sourceInventory)
    fail(
      "complete source inventory requires verifyProfileSource with the factory archive",
    );
  if (
    !Array.isArray(profile.projects ?? []) ||
    (profile.projects ?? []).some(
      (project) =>
        !isRelativePath(project?.path) ||
        !/^[0-9a-f]{40}$/.test(project?.commit ?? ""),
    )
  )
    fail("invalid locked project path or commit");
  if (
    !Array.isArray(profile.requiredSourceFiles ?? []) ||
    (profile.requiredSourceFiles ?? []).some((path) => !isRelativePath(path))
  ) {
    fail("required source files must use relative paths");
  }
  const root = resolve(aospRoot);
  const manifestCheckout = join(root, ".repo", "manifests");
  if (!existsSync(manifestCheckout)) {
    fail(`${root} is not a repo-managed AOSP checkout`);
  }
  const manifestHead = gitHead(manifestCheckout);
  if (manifestHead !== profile.manifest.commit) {
    fail(
      `manifest HEAD ${manifestHead} does not match ${profile.manifest.commit}`,
    );
  }
  const projects = [];
  for (const project of profile.projects ?? []) {
    const directory = join(root, project.path);
    if (!existsSync(directory)) fail(`missing locked project ${project.path}`);
    const head = gitHead(directory);
    if (head !== project.commit) {
      fail(`${project.path} HEAD ${head} does not match ${project.commit}`);
    }
    projects.push({ path: project.path, commit: head });
  }
  for (const path of profile.requiredSourceFiles ?? []) {
    const file = join(root, path);
    if (!existsSync(file) || !statSync(file).isFile())
      fail(`missing required source file ${path}`);
  }
  return { root, manifest: manifestHead, projects };
}

export function verifyExtractedVendor(profile, aospRoot) {
  const root = resolve(aospRoot);
  const files = profile.proprietaryArchive?.requiredExtractedFiles;
  if (
    !Array.isArray(files) ||
    files.length === 0 ||
    files.some((path) => !isRelativePath(path))
  )
    fail(
      "selected profile requires a nonempty list of relative vendor file paths",
    );
  const missing = files.filter((path) => {
    const file = join(root, path);
    return !existsSync(file) || !statSync(file).isFile();
  });
  if (missing.length > 0) {
    fail(`licensed vendor extraction is incomplete: ${missing.join(", ")}`);
  }
  return { root, files };
}

function parseArgs(argv) {
  const options = {
    profile: "cuttlefish",
    lockPath: defaultLockPath,
    aospRoot: "",
    archivePath: "",
    verifyVendorTree: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[++index];
      if (!next || next.startsWith("--")) fail(`${arg} requires a value`);
      return next;
    };
    if (arg === "--profile") options.profile = value();
    else if (arg === "--lock") options.lockPath = resolve(value());
    else if (arg === "--aosp-root") options.aospRoot = resolve(value());
    else if (arg === "--vendor-archive") options.archivePath = resolve(value());
    else if (arg === "--verify-vendor-tree") options.verifyVendorTree = true;
    else if (arg === "--json") options.json = true;
    else fail(`unknown argument ${arg}`);
  }
  if (!options.profile) fail("--profile requires a value");
  if (options.verifyVendorTree && !options.aospRoot) {
    fail("--verify-vendor-tree requires --aosp-root");
  }
  return options;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const profile = loadProfile(options.profile, options.lockPath);
  const result = {
    profile: options.profile,
    manifest: profile.manifest,
    repoInit: `repo init -u ${profile.manifest.url} -b ${profile.manifest.tag}`,
  };
  if (
    profile.sourceInventory &&
    (options.aospRoot || options.archivePath || options.verifyVendorTree)
  ) {
    return verifyProfileSource(profile, options).then((sourceInventory) =>
      printResult({ ...result, sourceInventory }, options.json),
    );
  }
  if (options.archivePath)
    result.archive = verifyArchive(profile, options.archivePath);
  if (options.aospRoot)
    result.checkout = verifyCheckout(profile, options.aospRoot);
  if (options.verifyVendorTree) {
    result.vendorTree = verifyExtractedVendor(profile, options.aospRoot);
  }
  return printResult(result, options.json);
}

function printResult(result, json) {
  const output = JSON.stringify(result, null, 2);
  if (json) process.stdout.write(`${output}\n`);
  else {
    const checks = [
      "archive",
      "checkout",
      "vendorTree",
      "sourceInventory",
    ].filter((key) => result[key]);
    const scope = checks.length
      ? `verified ${checks.join(", ")}`
      : "loaded profile only";
    console.log(`[aosp-lock] ${result.profile}: ${scope}\n${output}`);
  }
  return result;
}

if (import.meta.main) await main();

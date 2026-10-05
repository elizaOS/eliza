#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hashFile } from "../android/release-contract.ts";

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
  return profile;
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
  if (options.archivePath)
    result.archive = verifyArchive(profile, options.archivePath);
  if (options.aospRoot)
    result.checkout = verifyCheckout(profile, options.aospRoot);
  if (options.verifyVendorTree) {
    result.vendorTree = verifyExtractedVendor(profile, options.aospRoot);
  }
  const output = JSON.stringify(result, null, 2);
  if (options.json) process.stdout.write(`${output}\n`);
  else {
    const checks = ["archive", "checkout", "vendorTree"].filter(
      (key) => result[key],
    );
    const scope = checks.length
      ? `verified ${checks.join(", ")}`
      : "loaded profile only";
    console.log(`[aosp-lock] ${options.profile}: ${scope}\n${output}`);
  }
  return result;
}

if (import.meta.main) main();

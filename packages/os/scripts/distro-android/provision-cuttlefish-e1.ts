#!/usr/bin/env node
/** Materialize the revision-locked E1 Cuttlefish simulator device overlay. */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "../..");
export const defaultLockPath = path.join(
  repositoryRoot,
  "android/cuttlefish-e1.lock.json",
);

const isSafeRelativePath = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  !path.isAbsolute(value) &&
  !value.split(/[\\/]/).includes("..");

function fail(message) {
  throw new Error(`[cuttlefish-e1] ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) fail(`${command} failed: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} exited with code ${result.status}`);
  }
  return options.capture ? result.stdout.trim() : "";
}

export function loadCuttlefishE1Lock(lockPath = defaultLockPath) {
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  if (lock.schemaVersion !== 1) fail(`invalid schemaVersion in ${lockPath}`);
  const source = lock.source;
  if (
    !source ||
    typeof source.url !== "string" ||
    !source.url.startsWith("https://") ||
    typeof source.ref !== "string" ||
    !source.ref.startsWith("refs/heads/") ||
    !/^[0-9a-f]{40}$/.test(source.commit ?? "") ||
    !isSafeRelativePath(source.root)
  ) {
    fail(`invalid source contract in ${lockPath}`);
  }
  if (!Array.isArray(lock.trees) || lock.trees.length === 0) {
    fail(`trees must be a non-empty array in ${lockPath}`);
  }
  const destinations = new Set();
  for (const tree of lock.trees) {
    if (
      !isSafeRelativePath(tree?.source) ||
      !isSafeRelativePath(tree?.destination) ||
      !Array.isArray(tree?.requiredFiles) ||
      tree.requiredFiles.length === 0 ||
      tree.requiredFiles.some((file) => !isSafeRelativePath(file)) ||
      destinations.has(tree.destination)
    ) {
      fail(`invalid E1 source tree in ${lockPath}`);
    }
    destinations.add(tree.destination);
  }
  if (
    !Array.isArray(lock.license?.requiredFiles) ||
    lock.license.requiredFiles.length === 0 ||
    lock.license.requiredFiles.some((file) => !isSafeRelativePath(file)) ||
    typeof lock.license.notice !== "string" ||
    lock.license.notice.length === 0
  ) {
    fail(`invalid license contract in ${lockPath}`);
  }
  return lock;
}

function assertRequiredFiles(root, lock) {
  for (const tree of lock.trees) {
    const sourceRoot = path.join(root, lock.source.root, tree.source);
    if (!fs.existsSync(sourceRoot)) fail(`missing source tree ${tree.source}`);
    for (const requiredFile of tree.requiredFiles) {
      if (!fs.existsSync(path.join(sourceRoot, requiredFile))) {
        fail(`missing required E1 source file ${tree.source}/${requiredFile}`);
      }
    }
  }
  for (const requiredFile of lock.license.requiredFiles) {
    if (!fs.existsSync(path.join(root, lock.source.root, requiredFile))) {
      fail(`missing required E1 license file ${requiredFile}`);
    }
  }
}

function materializeSourceCheckout(lock) {
  const checkout = fs.mkdtempSync(
    path.join(os.tmpdir(), "elizaos-cuttlefish-e1-"),
  );
  run("git", ["init", "--quiet"], { cwd: checkout });
  run("git", ["remote", "add", "origin", lock.source.url], { cwd: checkout });
  run("git", ["sparse-checkout", "init", "--no-cone"], { cwd: checkout });
  run(
    "git",
    [
      "sparse-checkout",
      "set",
      "--no-cone",
      ...lock.trees.map((tree) => `/${lock.source.root}/${tree.source}/**`),
    ],
    { cwd: checkout },
  );
  run(
    "git",
    ["fetch", "--filter=blob:none", "--depth=1", "origin", lock.source.commit],
    { cwd: checkout },
  );
  run("git", ["checkout", "--detach", "FETCH_HEAD"], { cwd: checkout });
  const head = run("git", ["rev-parse", "HEAD"], {
    cwd: checkout,
    capture: true,
  });
  if (head !== lock.source.commit) {
    fail(`source HEAD ${head} does not match locked ${lock.source.commit}`);
  }
  return checkout;
}

export function provisionCuttlefishE1({
  aospRoot,
  lockPath = defaultLockPath,
  check = false,
  sourceCheckout = null,
}) {
  if (!aospRoot) fail("--aosp-root is required");
  const root = path.resolve(aospRoot);
  if (!fs.existsSync(path.join(root, "build", "envsetup.sh"))) {
    fail(`${root} is not an AOSP checkout`);
  }
  const lock = loadCuttlefishE1Lock(lockPath);
  const sourceRoot = sourceCheckout
    ? path.resolve(sourceCheckout)
    : materializeSourceCheckout(lock);
  assertRequiredFiles(sourceRoot, lock);
  const markerPath = path.join(
    root,
    "device/eliza/.elizaos-cuttlefish-e1-source.json",
  );
  if (check) {
    if (!fs.existsSync(markerPath))
      fail(`missing E1 source marker ${markerPath}`);
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    if (
      marker.commit !== lock.source.commit ||
      marker.url !== lock.source.url
    ) {
      fail("AOSP E1 source marker does not match the lock");
    }
    for (const tree of lock.trees) {
      for (const requiredFile of tree.requiredFiles) {
        if (!fs.existsSync(path.join(root, tree.destination, requiredFile))) {
          fail(
            `AOSP checkout is missing imported E1 file ${tree.destination}/${requiredFile}`,
          );
        }
      }
    }
    return { commit: marker.commit, checked: true, trees: lock.trees };
  }
  for (const tree of lock.trees) {
    const destination = path.join(root, tree.destination);
    if (fs.existsSync(destination)) {
      if (!fs.existsSync(markerPath)) {
        fail(`refusing to overwrite unmanaged AOSP path ${destination}`);
      }
      const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
      if (marker.commit !== lock.source.commit) {
        fail(`existing AOSP E1 source is not locked to ${lock.source.commit}`);
      }
      fs.rmSync(destination, { recursive: true, force: true });
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(
      path.join(sourceRoot, lock.source.root, tree.source),
      destination,
      {
        recursive: true,
        force: true,
        errorOnExist: true,
      },
    );
  }
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(
    markerPath,
    `${JSON.stringify({ commit: lock.source.commit, ref: lock.source.ref, url: lock.source.url }, null, 2)}\n`,
  );
  return { commit: lock.source.commit, checked: false, trees: lock.trees };
}

function parseArgs(argv) {
  const args = { aospRoot: "", lockPath: defaultLockPath, check: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--aosp-root") args.aospRoot = argv[++i] ?? "";
    else if (arg === "--lock") args.lockPath = path.resolve(argv[++i] ?? "");
    else if (arg === "--check") args.check = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node scripts/distro-android/provision-cuttlefish-e1.ts --aosp-root <PATH> [--lock <PATH>] [--check]",
      );
      return null;
    } else fail(`unknown argument ${arg}`);
  }
  if (!args.aospRoot) fail("--aosp-root requires a value");
  return args;
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  if (args) {
    const result = provisionCuttlefishE1(args);
    console.log(
      `[cuttlefish-e1] ${result.checked ? "verified" : "imported"} ${result.commit}`,
    );
  }
}

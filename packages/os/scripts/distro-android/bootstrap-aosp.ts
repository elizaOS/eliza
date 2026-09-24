#!/usr/bin/env node
/** Materialize the complete AOSP checkout pinned by android/aosp.lock.json. */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.ts";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, "../..");
export const aospLockPath = path.join(repositoryRoot, "android/aosp.lock.json");

function fail(message) {
  throw new Error(`[distro-android:bootstrap] ${message}`);
}

export function loadAospLock(filePath = aospLockPath) {
  const document = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const cuttlefishProfile = document?.profiles?.cuttlefish;
  const lock = cuttlefishProfile
    ? {
        schemaVersion: document.schemaVersion,
        manifestUrl: cuttlefishProfile.manifest?.url,
        manifestRevision: cuttlefishProfile.manifest?.tag,
        manifestTagObject: cuttlefishProfile.manifest?.tagObject,
        manifestCommit: cuttlefishProfile.manifest?.commit,
        projects: cuttlefishProfile.projects,
        requiredSourceFiles: cuttlefishProfile.requiredSourceFiles,
      }
    : document;
  if (
    lock.schemaVersion !== 1 ||
    typeof lock.manifestUrl !== "string" ||
    typeof lock.manifestRevision !== "string" ||
    !/^[0-9a-f]{40}$/.test(lock.manifestTagObject ?? "") ||
    !/^[0-9a-f]{40}$/.test(lock.manifestCommit ?? "")
  ) {
    fail(`invalid AOSP lock: ${filePath}`);
  }
  const safeRelativePath = (value) =>
    typeof value === "string" &&
    value.length > 0 &&
    !path.isAbsolute(value) &&
    !value.split(/[\\/]/).includes("..");
  if (lock.device !== undefined) {
    const device = lock.device;
    if (
      typeof device?.targetId !== "string" ||
      !/^[A-Za-z0-9._-]+$/.test(device.targetId) ||
      typeof device?.codename !== "string" ||
      !/^[A-Za-z0-9._-]+$/.test(device.codename) ||
      typeof device?.buildId !== "string" ||
      device.buildId.length === 0 ||
      typeof device?.productBrand !== "string" ||
      !/^[A-Za-z0-9._-]+$/.test(device.productBrand) ||
      typeof device?.productName !== "string" ||
      !/^[A-Za-z0-9._-]+$/.test(device.productName) ||
      device.expectedFingerprintPrefix !==
        `${device.productBrand}/${device.productName}/${device.codename}:`
    ) {
      fail(`invalid device contract in AOSP lock: ${filePath}`);
    }
  }
  if (lock.projects !== undefined) {
    if (!Array.isArray(lock.projects) || lock.projects.length === 0) {
      fail(`invalid projects in AOSP lock: ${filePath}`);
    }
    const seen = new Set();
    for (const project of lock.projects) {
      if (
        !safeRelativePath(project?.path) ||
        !safeRelativePath(project?.name) ||
        !/^[0-9a-f]{40}$/.test(project?.tagObject ?? "") ||
        !/^[0-9a-f]{40}$/.test(project?.commit ?? "") ||
        seen.has(project.path)
      ) {
        fail(`invalid locked project in ${filePath}`);
      }
      seen.add(project.path);
    }
  }
  if (lock.externalProjects !== undefined) {
    if (
      !Array.isArray(lock.externalProjects) ||
      lock.externalProjects.length === 0
    ) {
      fail(`invalid externalProjects in AOSP lock: ${filePath}`);
    }
    const seen = new Set();
    for (const project of lock.externalProjects) {
      if (
        !safeRelativePath(project?.path) ||
        typeof project?.url !== "string" ||
        !project.url.startsWith("https://") ||
        typeof project?.ref !== "string" ||
        !project.ref.startsWith("refs/heads/") ||
        !/^[0-9a-f]{40}$/.test(project?.commit ?? "") ||
        (project.sparsePaths !== undefined &&
          (!Array.isArray(project.sparsePaths) ||
            project.sparsePaths.length === 0 ||
            project.sparsePaths.some(
              (sparsePath) => !safeRelativePath(sparsePath),
            ))) ||
        seen.has(project.path)
      ) {
        fail(`invalid locked external project in ${filePath}`);
      }
      seen.add(project.path);
    }
  }
  if (lock.sourceOverlays !== undefined) {
    if (
      !Array.isArray(lock.sourceOverlays) ||
      lock.sourceOverlays.length === 0 ||
      lock.sourceOverlays.some(
        (overlay) =>
          !safeRelativePath(overlay?.path) ||
          typeof overlay?.url !== "string" ||
          !overlay.url.startsWith("https://") ||
          !/^[0-9a-f]{40}$/.test(overlay?.sourceCommit ?? "") ||
          !/^[0-9a-f]{64}$/.test(overlay?.sha256 ?? "") ||
          (overlay.baseSha256 !== null &&
            !/^[0-9a-f]{64}$/.test(overlay?.baseSha256 ?? "")),
      )
    ) {
      fail(`invalid sourceOverlays in AOSP lock: ${filePath}`);
    }
    const seen = new Set();
    for (const overlay of lock.sourceOverlays) {
      if (seen.has(overlay.path)) {
        fail(`duplicate source overlay in AOSP lock: ${overlay.path}`);
      }
      seen.add(overlay.path);
    }
  }
  for (const requiredPath of lock.requiredSourceFiles ?? []) {
    if (!safeRelativePath(requiredPath)) {
      fail(`invalid requiredSourceFiles entry in ${filePath}`);
    }
  }
  if (lock.proprietaryArchive !== undefined) {
    const archive = lock.proprietaryArchive;
    if (
      typeof archive.filename !== "string" ||
      path.basename(archive.filename) !== archive.filename ||
      typeof archive.url !== "string" ||
      !archive.url.startsWith("https://") ||
      !Number.isSafeInteger(archive.sizeBytes) ||
      archive.sizeBytes <= 0 ||
      !/^[0-9a-f]{64}$/.test(archive.sha256 ?? "") ||
      archive.sha256 === "0".repeat(64) ||
      !Array.isArray(archive.requiredExtractedFiles) ||
      archive.requiredExtractedFiles.length === 0 ||
      archive.requiredExtractedFiles.some(
        (requiredPath) => !safeRelativePath(requiredPath),
      )
    ) {
      fail(`invalid proprietaryArchive in ${filePath}`);
    }
  }
  for (const field of ["referenceFactoryImage", "rollbackFactoryImage"]) {
    const image = lock[field];
    if (
      image !== undefined &&
      (typeof image.filename !== "string" ||
        path.basename(image.filename) !== image.filename ||
        typeof image.url !== "string" ||
        !image.url.startsWith("https://") ||
        !Number.isSafeInteger(image.sizeBytes) ||
        image.sizeBytes <= 0 ||
        !/^[0-9a-f]{64}$/.test(image.sha256 ?? "") ||
        image.sha256 === "0".repeat(64) ||
        typeof image.buildId !== "string" ||
        image.buildId.length === 0)
    ) {
      fail(`invalid ${field} in ${filePath}`);
    }
  }
  if (lock.avbVerification !== undefined) {
    const entries = lock.avbVerification;
    if (
      !Array.isArray(entries) ||
      entries.length === 0 ||
      entries.some(
        (entry) =>
          typeof entry?.image !== "string" ||
          path.basename(entry.image) !== entry.image ||
          !/^vbmeta(?:_[A-Za-z0-9._+-]+)?\.img$/.test(entry.image) ||
          !safeRelativePath(entry?.keyPath) ||
          !/^[0-9a-f]{64}$/.test(entry?.keySha256 ?? "") ||
          entry.keySha256 === "0".repeat(64) ||
          entry.authorization !== "public-aosp-userdebug-test-key",
      ) ||
      new Set(entries.map((entry) => entry.image)).size !== entries.length
    ) {
      fail(`invalid avbVerification in ${filePath}`);
    }
  }
  if (
    lock.resolvedManifest !== undefined &&
    (!safeRelativePath(lock.resolvedManifest?.path) ||
      !/^[0-9a-f]{64}$/.test(lock.resolvedManifest?.sha256 ?? "") ||
      lock.resolvedManifest.sha256 === "0".repeat(64))
  ) {
    fail(`invalid resolvedManifest in ${filePath}`);
  }
  if (lock.generatedVendor !== undefined) {
    const generated = lock.generatedVendor;
    if (
      !Array.isArray(generated.command) ||
      generated.command.length === 0 ||
      generated.command.some(
        (argument) => typeof argument !== "string" || argument.length === 0,
      ) ||
      !Array.isArray(generated.requiredFiles) ||
      generated.requiredFiles.length === 0 ||
      generated.requiredFiles.some(
        (requiredPath) => !safeRelativePath(requiredPath),
      ) ||
      (generated.requiredTextFiles !== undefined &&
        (!Array.isArray(generated.requiredTextFiles) ||
          generated.requiredTextFiles.length === 0 ||
          generated.requiredTextFiles.some(
            (entry) =>
              !safeRelativePath(entry?.path) ||
              !generated.requiredFiles.includes(entry.path) ||
              !Array.isArray(entry?.includes) ||
              entry.includes.length === 0 ||
              entry.includes.some(
                (token) => typeof token !== "string" || token.length === 0,
              ),
          ))) ||
      (generated.requiredArtifacts !== undefined &&
        (!Array.isArray(generated.requiredArtifacts) ||
          generated.requiredArtifacts.length === 0 ||
          generated.requiredArtifacts.some(
            (artifact) =>
              !safeRelativePath(artifact?.path) ||
              !generated.requiredFiles.includes(artifact.path) ||
              !Number.isSafeInteger(artifact?.sizeBytes) ||
              artifact.sizeBytes <= 0 ||
              !/^[0-9a-f]{64}$/.test(artifact?.sha256 ?? "") ||
              artifact.sha256 === "0".repeat(64),
          )))
    ) {
      fail(`invalid generatedVendor in ${filePath}`);
    }
  }
  return lock;
}

export function parseBootstrapArgs(argv) {
  const parsed = {
    aospRoot: "",
    initOnly: false,
    jobs: Math.max(1, os.cpus().length),
    repoBin: process.env.REPO_BIN || "repo",
    lockPath: aospLockPath,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--aosp-root" && value) {
      parsed.aospRoot = path.resolve(value);
      index += 1;
    } else if (arg === "--jobs" && value) {
      if (!/^\d+$/.test(value)) fail("--jobs must be a positive integer");
      parsed.jobs = Number(value);
      index += 1;
    } else if (arg === "--repo-bin" && value) {
      parsed.repoBin = value.includes(path.sep) ? path.resolve(value) : value;
      index += 1;
    } else if (arg === "--lock" && value) {
      parsed.lockPath = path.resolve(value);
      index += 1;
    } else if (arg === "--init-only") {
      parsed.initOnly = true;
    } else {
      fail(`unknown or incomplete argument: ${arg}`);
    }
  }
  if (!parsed.aospRoot) fail("--aosp-root is required");
  if (
    !Number.isSafeInteger(parsed.jobs) ||
    parsed.jobs < 1 ||
    parsed.jobs > 256
  ) {
    fail("--jobs must be an integer from 1 through 256");
  }
  return parsed;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) fail(`${command} failed: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} exited ${result.status}`);
  }
  return (result.stdout ?? "").trim();
}

export function assertPinnedAospCheckout(
  aospRoot,
  lock = loadAospLock(),
  { requireProjects = true } = {},
) {
  const manifests = path.join(aospRoot, ".repo/manifests");
  if (!fs.existsSync(manifests)) {
    fail(`missing repo manifest checkout: ${manifests}`);
  }
  const actual = run("git", ["rev-parse", "HEAD"], {
    cwd: manifests,
    capture: true,
  });
  if (actual !== lock.manifestCommit) {
    fail(
      `AOSP manifest mismatch: expected ${lock.manifestCommit} (${lock.manifestRevision}), got ${actual}`,
    );
  }
  if (requireProjects) {
    for (const project of lock.projects ?? []) {
      const projectRoot = path.join(aospRoot, project.path);
      if (!fs.existsSync(projectRoot)) {
        fail(`missing locked AOSP project: ${project.path}`);
      }
      const projectHead = run("git", ["rev-parse", "HEAD"], {
        cwd: projectRoot,
        capture: true,
      });
      if (projectHead !== project.commit) {
        fail(
          `AOSP project mismatch for ${project.path}: expected ${project.commit}, got ${projectHead}`,
        );
      }
      const dirty = run("git", ["status", "--porcelain"], {
        cwd: projectRoot,
        capture: true,
      });
      if (dirty) {
        fail(`locked AOSP project is dirty: ${project.path}`);
      }
    }
    for (const project of lock.externalProjects ?? []) {
      const projectRoot = path.join(aospRoot, project.path);
      if (!fs.existsSync(path.join(projectRoot, ".git"))) {
        fail(`missing locked external project: ${project.path}`);
      }
      const projectHead = run("git", ["rev-parse", "HEAD"], {
        cwd: projectRoot,
        capture: true,
      });
      if (projectHead !== project.commit) {
        fail(
          `external project mismatch for ${project.path}: expected ${project.commit}, got ${projectHead}`,
        );
      }
      const dirty = run("git", ["status", "--porcelain"], {
        cwd: projectRoot,
        capture: true,
      });
      if (dirty) {
        fail(`locked external project is dirty: ${project.path}`);
      }
    }
    for (const requiredPath of lock.requiredSourceFiles ?? []) {
      if (!fs.existsSync(path.join(aospRoot, requiredPath))) {
        fail(`missing required AOSP source path: ${requiredPath}`);
      }
    }
  }
  return actual;
}

export function assertRemoteManifestTag(lock = loadAospLock()) {
  const output = run(
    "git",
    [
      "ls-remote",
      lock.manifestUrl,
      `refs/tags/${lock.manifestRevision}`,
      `refs/tags/${lock.manifestRevision}^{}`,
    ],
    { capture: true },
  );
  const refs = new Map(
    output.split("\n").map((line) => {
      const [hash, ref] = line.trim().split(/\s+/, 2);
      return [ref, hash];
    }),
  );
  if (
    refs.get(`refs/tags/${lock.manifestRevision}`) !== lock.manifestTagObject ||
    refs.get(`refs/tags/${lock.manifestRevision}^{}`) !== lock.manifestCommit
  ) {
    fail(`remote AOSP tag ${lock.manifestRevision} does not match the lock`);
  }
  for (const project of lock.projects ?? []) {
    const projectUrl = `https://android.googlesource.com/${project.name}`;
    const projectOutput = run(
      "git",
      [
        "ls-remote",
        projectUrl,
        `refs/tags/${lock.manifestRevision}`,
        `refs/tags/${lock.manifestRevision}^{}`,
      ],
      { capture: true },
    );
    const projectRefs = new Map(
      projectOutput.split("\n").map((line) => {
        const [hash, ref] = line.trim().split(/\s+/, 2);
        return [ref, hash];
      }),
    );
    if (
      projectRefs.get(`refs/tags/${lock.manifestRevision}`) !==
        project.tagObject ||
      projectRefs.get(`refs/tags/${lock.manifestRevision}^{}`) !==
        project.commit
    ) {
      fail(
        `remote AOSP project tag ${project.name}@${lock.manifestRevision} does not match the lock`,
      );
    }
  }
}

export function materializeExternalProjects(aospRoot, lock) {
  for (const project of lock.externalProjects ?? []) {
    const projectRoot = path.join(aospRoot, project.path);
    if (fs.existsSync(projectRoot)) {
      if (!fs.existsSync(path.join(projectRoot, ".git"))) {
        fail(`external project path is not a Git checkout: ${project.path}`);
      }
      continue;
    }
    fs.mkdirSync(path.dirname(projectRoot), { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true });
    run("git", ["init"], { cwd: projectRoot });
    run("git", ["remote", "add", "origin", project.url], {
      cwd: projectRoot,
    });
    if (project.sparsePaths?.length) {
      run("git", ["sparse-checkout", "init", "--no-cone"], {
        cwd: projectRoot,
      });
      run(
        "git",
        [
          "sparse-checkout",
          "set",
          "--no-cone",
          ...project.sparsePaths.map((sparsePath) => `/${sparsePath}`),
        ],
        { cwd: projectRoot },
      );
    }
    // Fetch the immutable object rather than a moving branch head. The
    // recorded ref remains provenance only; a future upstream push must not
    // make a previously pinned build unreproducible.
    run(
      "git",
      ["fetch", "--filter=blob:none", "--depth=1", "origin", project.commit],
      { cwd: projectRoot },
    );
    run("git", ["checkout", "--detach", "FETCH_HEAD"], {
      cwd: projectRoot,
    });
  }
  return lock.externalProjects ?? [];
}

export async function verifyLockedArtifact(
  contract,
  artifactPath,
  { enforceFilename = true, label = "artifact" } = {},
) {
  if (!contract) fail(`selected AOSP lock has no ${label} contract`);
  const resolved = path.resolve(artifactPath);
  if (!fs.existsSync(resolved)) fail(`${label} is missing: ${resolved}`);
  if (enforceFilename && path.basename(resolved) !== contract.filename) {
    fail(`${label} filename must be ${contract.filename}`);
  }
  const sizeBytes = fs.statSync(resolved).size;
  if (sizeBytes !== contract.sizeBytes) {
    fail(
      `${label} size ${sizeBytes} does not match locked ${contract.sizeBytes}`,
    );
  }
  const hash = createHash("sha256");
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = fs.createReadStream(resolved);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectPromise);
    stream.on("end", resolvePromise);
  });
  const sha256 = hash.digest("hex");
  if (sha256 !== contract.sha256) {
    fail(`${label} SHA-256 ${sha256} does not match locked ${contract.sha256}`);
  }
  return { path: resolved, sizeBytes, sha256 };
}

/** Apply immutable source files required to reconcile pinned AOSP with adevtool. */
export async function materializeLockedSourceOverlays(aospRoot, lock) {
  let changed = false;
  for (const overlay of lock.sourceOverlays ?? []) {
    const destination = path.join(aospRoot, overlay.path);
    const currentSha = fs.existsSync(destination)
      ? createHash("sha256").update(fs.readFileSync(destination)).digest("hex")
      : null;
    if (currentSha === overlay.sha256) continue;
    if (currentSha !== overlay.baseSha256) {
      fail(
        `source overlay base mismatch for ${overlay.path}: expected ${overlay.baseSha256 ?? "absent"}, got ${currentSha ?? "absent"}`,
      );
    }
    const partial = `${destination}.partial`;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    run("curl", [
      "--location",
      "--fail",
      "--retry",
      "5",
      "--output",
      partial,
      overlay.url,
    ]);
    const downloadedSha = createHash("sha256")
      .update(fs.readFileSync(partial))
      .digest("hex");
    if (downloadedSha !== overlay.sha256) {
      fs.rmSync(partial, { force: true });
      fail(
        `source overlay SHA-256 mismatch for ${overlay.path}: expected ${overlay.sha256}, got ${downloadedSha}`,
      );
    }
    fs.renameSync(partial, destination);
    changed = true;
  }
  return { overlays: lock.sourceOverlays ?? [], changed };
}

export async function verifyProprietaryArchive(lock, archivePath) {
  return verifyLockedArtifact(lock.proprietaryArchive, archivePath, {
    label: "proprietary archive",
  });
}

export function assertExtractedVendorTree(aospRoot, lock) {
  const contract = lock.proprietaryArchive;
  if (!contract) fail("selected AOSP lock has no proprietary archive contract");
  const missing = contract.requiredExtractedFiles.filter(
    (requiredPath) => !fs.existsSync(path.join(aospRoot, requiredPath)),
  );
  if (missing.length > 0) {
    fail(`licensed vendor extraction is incomplete: ${missing.join(", ")}`);
  }
  return contract.requiredExtractedFiles;
}

export function assertGeneratedVendorTree(aospRoot, lock) {
  const contract = lock.generatedVendor;
  if (!contract) fail("selected AOSP lock has no generated vendor contract");
  const missing = contract.requiredFiles.filter(
    (requiredPath) => !fs.existsSync(path.join(aospRoot, requiredPath)),
  );
  if (missing.length > 0) {
    fail(`generated vendor tree is incomplete: ${missing.join(", ")}`);
  }
  for (const entry of contract.requiredTextFiles ?? []) {
    const contents = fs.readFileSync(path.join(aospRoot, entry.path), "utf8");
    const missingTokens = entry.includes.filter(
      (token) => !contents.includes(token),
    );
    if (missingTokens.length > 0) {
      fail(
        `generated vendor contract mismatch in ${entry.path}: ${missingTokens.join(", ")}`,
      );
    }
  }
  for (const artifact of contract.requiredArtifacts ?? []) {
    const artifactPath = path.join(aospRoot, artifact.path);
    const bytes = fs.readFileSync(artifactPath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== artifact.sizeBytes || sha256 !== artifact.sha256) {
      fail(
        `generated vendor artifact mismatch in ${artifact.path}: expected ${artifact.sizeBytes}/${artifact.sha256}, got ${bytes.length}/${sha256}`,
      );
    }
  }
  return contract.requiredFiles;
}

export function bootstrapAosp({
  aospRoot,
  initOnly,
  jobs,
  repoBin,
  lockPath = aospLockPath,
}) {
  const lock = loadAospLock(lockPath);
  fs.mkdirSync(aospRoot, { recursive: true });
  const entries = fs.readdirSync(aospRoot).filter((entry) => entry !== ".repo");
  if (!fs.existsSync(path.join(aospRoot, ".repo")) && entries.length > 0) {
    fail(
      `refusing to initialize nonempty directory without .repo: ${aospRoot}`,
    );
  }
  assertRemoteManifestTag(lock);
  run(
    repoBin,
    ["init", "-u", lock.manifestUrl, "-b", lock.manifestRevision, "--depth=1"],
    { cwd: aospRoot },
  );
  assertPinnedAospCheckout(aospRoot, lock, { requireProjects: false });
  if (!initOnly) {
    run(
      repoBin,
      [
        "sync",
        "-c",
        "--no-tags",
        "--optimized-fetch",
        "--retry-fetches=5",
        "--prune",
        "--fail-fast",
        `-j${jobs}`,
      ],
      { cwd: aospRoot },
    );
    materializeExternalProjects(aospRoot, lock);
    assertPinnedAospCheckout(aospRoot, lock);
  }
  fs.copyFileSync(lockPath, path.join(aospRoot, ".elizaos-aosp-lock.json"));
  return lock;
}

if (isMainModule(import.meta)) {
  const args = parseBootstrapArgs(process.argv.slice(2));
  const lock = bootstrapAosp(args);
  console.log(
    `[distro-android:bootstrap] ready ${args.aospRoot} at ${lock.manifestRevision} (${lock.manifestCommit})`,
  );
}

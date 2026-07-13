/**
 * Builds one immutable npm release candidate from a clean, explicit Git state.
 * It runs the caller-supplied build once, packs each allowlisted workspace once
 * with lifecycle scripts disabled, records real tarball integrity, and refuses
 * every later manifest, commit, or artifact mutation.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import {
  advanceReleaseState,
  createReleaseState,
  deriveReleaseCandidateTag,
  RELEASE_PLAN_SCHEMA_VERSION,
  resolveReleaseCohort,
  sha512Hex,
  sha512Integrity,
  stableStringify,
  validateReleaseIdentity,
  validateReleasePlan,
  validateReleaseState,
} from "./release-contract.mjs";

export const RELEASE_PLAN_FILENAME = "release-plan.json";
export const RELEASE_STATE_FILENAME = "release-state.json";

const RELEASE_STATE_LOCK_SCHEMA_VERSION = 1;
const RELEASE_STATE_LOCK_LEASE_MS = 5 * 60 * 1000;

function runGit(repoRoot, args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function assertCleanExpectedCommit(repoRoot, identity) {
  const actualHead = runGit(repoRoot, ["rev-parse", "HEAD"]).toLowerCase();
  if (
    actualHead !== identity.sourceSha ||
    actualHead !== identity.expectedCommit
  ) {
    throw new Error(
      `Candidate source moved: HEAD is ${actualHead}, expected ${identity.expectedCommit}; rebase before packing`,
    );
  }
  const status = runGit(repoRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (status.length > 0) {
    throw new Error(`Release candidates require a clean Git tree:\n${status}`);
  }
}

function manifestSnapshots(repoRoot, cohort) {
  return new Map(
    cohort.packages.map(({ name, directory }) => {
      const manifestPath = path.join(repoRoot, directory, "package.json");
      return [name, { manifestPath, bytes: readFileSync(manifestPath) }];
    }),
  );
}

function assertManifestsUnchanged(snapshots) {
  for (const [name, snapshot] of snapshots) {
    const current = readFileSync(snapshot.manifestPath);
    if (!current.equals(snapshot.bytes)) {
      throw new Error(
        `${name} package.json changed after release planning; discard and rebuild the candidate`,
      );
    }
  }
}

function runBuildOnce(repoRoot, build) {
  if (
    !build ||
    typeof build.command !== "string" ||
    build.command.length === 0 ||
    !Array.isArray(build.args) ||
    build.args.some((argument) => typeof argument !== "string")
  ) {
    throw new Error(
      "Candidate creation requires an explicit build { command, args } invocation",
    );
  }
  const result = spawnSync(build.command, build.args, {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Release build failed with exit code ${result.status}`);
  }
}

function normalizePackedPath(value) {
  return value.replace(/^\.\//, "").split(path.sep).join("/");
}

function collectExportTargets(value, targets) {
  if (typeof value === "string") {
    if (value.startsWith("./") && !value.includes("*"))
      targets.add(normalizePackedPath(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectExportTargets(entry, targets);
    return;
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value))
      collectExportTargets(entry, targets);
  }
}

function validatePackedEntrypoints(packageRecord, packedFiles) {
  const expected = new Set();
  for (const field of ["main", "module", "types"]) {
    const target = packageRecord.entrypoints[field];
    if (target !== null && !target.includes("*"))
      expected.add(normalizePackedPath(target));
  }
  for (const target of Object.values(packageRecord.entrypoints.bin)) {
    expected.add(normalizePackedPath(target));
  }
  collectExportTargets(packageRecord.entrypoints.exports, expected);
  const available = new Set(
    packedFiles.map(({ path: filePath }) => normalizePackedPath(filePath)),
  );
  const missing = [...expected].filter((target) => !available.has(target));
  if (missing.length > 0) {
    throw new Error(
      `${packageRecord.name} tarball is missing declared entrypoints: ${missing.join(", ")}`,
    );
  }
}

function parsePackResult(stdout, packageName) {
  let parsed;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch (error) {
    // error-policy:J2 npm's process boundary returned malformed candidate metadata
    throw new Error(`npm pack returned malformed JSON for ${packageName}`, {
      cause: error,
    });
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error(
      `npm pack returned ${Array.isArray(parsed) ? parsed.length : "non-array"} records for ${packageName}`,
    );
  }
  const result = parsed[0];
  if (
    !result ||
    typeof result.filename !== "string" ||
    typeof result.integrity !== "string" ||
    !Array.isArray(result.files)
  ) {
    throw new Error(`npm pack omitted required metadata for ${packageName}`);
  }
  return result;
}

function packOnce({ repoRoot, stagingDirectory, packageRecord, npmCommand }) {
  const tarballsDirectory = path.join(stagingDirectory, "tarballs");
  const packageDirectory = path.join(repoRoot, packageRecord.directory);
  const result = spawnSync(
    npmCommand,
    [
      "pack",
      packageDirectory,
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      tarballsDirectory,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `npm pack failed for ${packageRecord.name}:\n${result.stderr.trim()}`,
    );
  }
  const metadata = parsePackResult(result.stdout, packageRecord.name);
  const tarballPath = path.join(tarballsDirectory, metadata.filename);
  if (!existsSync(tarballPath) || !statSync(tarballPath).isFile()) {
    throw new Error(`npm pack did not create ${tarballPath}`);
  }
  const bytes = readFileSync(tarballPath);
  const integrity = sha512Integrity(bytes);
  if (metadata.integrity !== integrity) {
    throw new Error(
      `${packageRecord.name} npm integrity ${metadata.integrity} does not match packed bytes ${integrity}`,
    );
  }
  if (
    metadata.name !== packageRecord.name ||
    metadata.version !== packageRecord.version
  ) {
    throw new Error(
      `${packageRecord.name} tarball identity is ${metadata.name}@${metadata.version}, expected ${packageRecord.name}@${packageRecord.version}`,
    );
  }
  validatePackedEntrypoints(packageRecord, metadata.files);
  return {
    filename: metadata.filename,
    path: `tarballs/${metadata.filename}`,
    size: bytes.length,
    sha512: sha512Hex(bytes),
    integrity,
    npmShasum: typeof metadata.shasum === "string" ? metadata.shasum : null,
  };
}

function writeCandidateFile(directory, filename, value) {
  const destination = path.join(directory, filename);
  const temporary = `${destination}.tmp`;
  writeFileSync(temporary, stableStringify(value), {
    encoding: "utf8",
    flag: "wx",
  });
  renameSync(temporary, destination);
}

/**
 * Create an immutable candidate directory. Existing output is never replaced:
 * retries must verify and resume the recorded tarballs instead of repacking.
 */
export function buildAndPackReleaseCandidate({
  repoRoot,
  outputDirectory,
  packageNames,
  version,
  channel,
  sourceSha,
  expectedCommit,
  build,
  npmCommand = "npm",
}) {
  const root = path.resolve(repoRoot);
  const output = path.resolve(outputDirectory);
  if (existsSync(output))
    throw new Error(`Candidate output already exists: ${output}`);
  const identity = validateReleaseIdentity({
    version,
    channel,
    sourceSha,
    expectedCommit,
  });
  assertCleanExpectedCommit(root, identity);
  const cohort = resolveReleaseCohort({
    repoRoot: root,
    packageNames,
    version: identity.version,
  });
  const snapshots = manifestSnapshots(root, cohort);
  const parentDirectory = path.dirname(output);
  mkdirSync(parentDirectory, { recursive: true });
  const stagingDirectory = mkdtempSync(
    path.join(parentDirectory, `.${path.basename(output)}-`),
  );

  try {
    mkdirSync(path.join(stagingDirectory, "tarballs"));
    runBuildOnce(root, build);
    assertCleanExpectedCommit(root, identity);
    assertManifestsUnchanged(snapshots);

    const packages = [];
    const filenames = new Set();
    for (const packageRecord of cohort.packages) {
      const snapshot = snapshots.get(packageRecord.name);
      const tarball = packOnce({
        repoRoot: root,
        stagingDirectory,
        packageRecord,
        npmCommand,
      });
      if (filenames.has(tarball.filename))
        throw new Error(`Duplicate tarball filename ${tarball.filename}`);
      filenames.add(tarball.filename);
      packages.push({
        ...packageRecord,
        manifest: {
          path: `${packageRecord.directory}/package.json`,
          sha512: sha512Hex(snapshot.bytes),
          integrity: sha512Integrity(snapshot.bytes),
        },
        tarball,
      });
      assertManifestsUnchanged(snapshots);
    }
    assertCleanExpectedCommit(root, identity);

    const plan = {
      schemaVersion: RELEASE_PLAN_SCHEMA_VERSION,
      sourceSha: identity.sourceSha,
      expectedCommit: identity.expectedCommit,
      version: identity.version,
      channel: identity.channel,
      candidateTag: deriveReleaseCandidateTag(identity, cohort.publishOrder),
      build: { command: build.command, args: [...build.args] },
      publishOrder: cohort.publishOrder,
      dependencyGraph: cohort.dependencyGraph,
      dependencyCycles: cohort.dependencyCycles,
      packages,
    };
    const planSource = stableStringify(plan);
    const planIntegrity = sha512Integrity(planSource);
    writeCandidateFile(stagingDirectory, RELEASE_PLAN_FILENAME, plan);

    let state = createReleaseState(planIntegrity, {
      sourceSha: identity.sourceSha,
      expectedCommit: identity.expectedCommit,
      version: identity.version,
      channel: identity.channel,
      packages: cohort.publishOrder,
    });
    state = advanceReleaseState(state, "built-packed", {
      build: plan.build,
      tarballs: packages.map(({ name, tarball }) => ({
        name,
        integrity: tarball.integrity,
      })),
    });
    state = advanceReleaseState(state, "candidate-recorded", {
      planIntegrity,
      candidateTag: plan.candidateTag,
    });
    writeCandidateFile(stagingDirectory, RELEASE_STATE_FILENAME, state);
    renameSync(stagingDirectory, output);
    return { plan, state, planPath: path.join(output, RELEASE_PLAN_FILENAME) };
  } catch (error) {
    // error-policy:J6 incomplete candidate staging has no resumable meaning
    rmSync(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}

function parseCandidateJson(filePath, kind) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    // error-policy:J2 identify the immutable candidate file that is invalid
    throw new Error(`Unable to parse ${kind} ${filePath}`, { cause: error });
  }
  return parsed;
}

export function loadReleasePlan(candidateDirectory) {
  const planPath = path.join(
    path.resolve(candidateDirectory),
    RELEASE_PLAN_FILENAME,
  );
  const plan = parseCandidateJson(planPath, "release plan");
  try {
    validateReleasePlan(plan);
  } catch (error) {
    // error-policy:J2 identify the candidate whose contract validation failed
    throw new Error(`Malformed release plan ${planPath}`, { cause: error });
  }
  const source = readFileSync(planPath, "utf8");
  if (source !== stableStringify(plan)) {
    throw new Error(`Release plan is not canonically serialized: ${planPath}`);
  }
  return { plan, planPath };
}

export function loadReleaseState(candidateDirectory) {
  const statePath = path.join(
    path.resolve(candidateDirectory),
    RELEASE_STATE_FILENAME,
  );
  const state = parseCandidateJson(statePath, "release state");
  validateReleaseState(state);
  return { state, statePath };
}

function hasErrorCode(error, code) {
  return error && typeof error === "object" && error.code === code;
}

function lockOwnerIsDead(owner) {
  if (
    owner?.schemaVersion !== RELEASE_STATE_LOCK_SCHEMA_VERSION ||
    owner.hostname !== hostname() ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0
  ) {
    return false;
  }
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    // error-policy:J3 process liveness maps only ESRCH to an abandoned owner
    if (hasErrorCode(error, "ESRCH")) return true;
    if (hasErrorCode(error, "EPERM")) return false;
    throw error;
  }
}

function removeRecoverableStateLock(lockPath) {
  let owner = null;
  let source;
  try {
    source = readFileSync(lockPath, "utf8");
    owner = JSON.parse(source);
  } catch (error) {
    // error-policy:J3 malformed ownership remains active until its lease expires
    if (hasErrorCode(error, "ENOENT")) return true;
    if (!(error instanceof SyntaxError)) throw error;
  }
  let lockStat;
  try {
    lockStat = statSync(lockPath);
    if (readFileSync(lockPath, "utf8") !== source) return true;
  } catch (error) {
    // error-policy:J3 another contender may remove a stale lock first
    if (hasErrorCode(error, "ENOENT")) return true;
    throw error;
  }
  const leaseExpired =
    Date.now() - lockStat.mtimeMs >= RELEASE_STATE_LOCK_LEASE_MS;
  const localOwner = owner?.hostname === hostname();
  const recoverable = localOwner ? lockOwnerIsDead(owner) : leaseExpired;
  if (!recoverable) return false;

  try {
    unlinkSync(lockPath);
  } catch (error) {
    // error-policy:J3 a competing recovery makes acquisition retry safely
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
  return true;
}

function acquireReleaseStateLock(lockPath) {
  const owner = {
    schemaVersion: RELEASE_STATE_LOCK_SCHEMA_VERSION,
    ownerToken: randomUUID(),
    hostname: hostname(),
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
  };
  const source = stableStringify(owner);
  while (true) {
    try {
      writeFileSync(lockPath, source, { encoding: "utf8", flag: "wx" });
      return owner;
    } catch (error) {
      // error-policy:J2 exclusive-create collisions carry lock-owner context
      if (!hasErrorCode(error, "EEXIST")) {
        throw new Error(`Unable to acquire release-state lock ${lockPath}`, {
          cause: error,
        });
      }
      if (removeRecoverableStateLock(lockPath)) continue;
      throw new Error(
        `Release state is locked by another writer: ${lockPath}`,
        {
          cause: error,
        },
      );
    }
  }
}

function releaseReleaseStateLock(lockPath, owner) {
  let currentOwner;
  try {
    currentOwner = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch (error) {
    // error-policy:J2 a lost lock invalidates the protected transition
    throw new Error(`Unable to validate release-state lock ${lockPath}`, {
      cause: error,
    });
  }
  if (currentOwner?.ownerToken !== owner.ownerToken) {
    throw new Error(`Release-state lock ownership changed: ${lockPath}`);
  }
  unlinkSync(lockPath);
}

export function recordReleaseTransition(
  candidateDirectory,
  targetPhase,
  evidence,
) {
  const statePath = path.join(
    path.resolve(candidateDirectory),
    RELEASE_STATE_FILENAME,
  );
  const lockPath = `${statePath}.lock`;
  const lockOwner = acquireReleaseStateLock(lockPath);
  let transitionError = null;
  let result = null;
  try {
    const { state } = loadReleaseState(candidateDirectory);
    const nextState = advanceReleaseState(state, targetPhase, evidence);
    if (nextState === state) {
      result = state;
    } else {
      const temporary = `${statePath}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(temporary, stableStringify(nextState), {
        encoding: "utf8",
        flag: "wx",
      });
      renameSync(temporary, statePath);
      result = nextState;
    }
  } catch (error) {
    // error-policy:J2 defer rethrow until lock ownership is validated
    transitionError = error;
  }
  let lockError = null;
  try {
    releaseReleaseStateLock(lockPath, lockOwner);
  } catch (error) {
    // error-policy:J2 combine lock loss with the protected write failure
    lockError = error;
  }
  if (transitionError && lockError) {
    // error-policy:J2 preserve both a transition failure and lost-lock failure
    throw new AggregateError(
      [transitionError, lockError],
      "Release transition and lock release failed",
    );
  }
  if (transitionError) throw transitionError;
  if (lockError) throw lockError;
  return result;
}

/** Verify Git, manifests, plan integrity, and every tarball before side effects. */
export function verifyReleaseCandidate({ repoRoot, candidateDirectory }) {
  const root = path.resolve(repoRoot);
  const candidate = path.resolve(candidateDirectory);
  const { plan, planPath } = loadReleasePlan(candidate);
  const { state } = loadReleaseState(candidate);
  const planSource = readFileSync(planPath);
  const planIntegrity = sha512Integrity(planSource);
  if (state.planIntegrity !== planIntegrity) {
    throw new Error(
      `Release state expects ${state.planIntegrity}, but the plan is ${planIntegrity}`,
    );
  }
  assertCleanExpectedCommit(root, plan);
  for (const packageRecord of plan.packages) {
    const manifestPath = path.join(root, packageRecord.manifest.path);
    const manifestBytes = readFileSync(manifestPath);
    if (
      sha512Hex(manifestBytes) !== packageRecord.manifest.sha512 ||
      sha512Integrity(manifestBytes) !== packageRecord.manifest.integrity
    ) {
      throw new Error(
        `${packageRecord.name} manifest no longer matches the recorded candidate`,
      );
    }
    const tarballPath = path.join(candidate, packageRecord.tarball.path);
    const tarballBytes = readFileSync(tarballPath);
    if (
      tarballBytes.length !== packageRecord.tarball.size ||
      sha512Hex(tarballBytes) !== packageRecord.tarball.sha512 ||
      sha512Integrity(tarballBytes) !== packageRecord.tarball.integrity
    ) {
      throw new Error(
        `${packageRecord.name} tarball no longer matches the recorded candidate`,
      );
    }
  }
  return { plan, state, planIntegrity };
}

#!/usr/bin/env node
/**
 * Produces and verifies the signed Linux GTK/WebKit desktop artifact set that
 * the elizaOS OS image consumes: one `<name>-<arch>.tar.zst` archive per
 * architecture plus `desktop-artifact-manifest.json`, the fixed adjacent
 * `desktop-artifact-manifest.json.sig` over the exact manifest bytes, and a
 * manifest-named detached signature over the exact archive bytes — all
 * Ed25519, matching `schemas/desktop-artifact-manifest.schema.json` (the
 * vendored copy of `elizaOS/os:packages/os/linux/schemas/`; the OS repository
 * owns the contract, this copy must track it byte-for-byte).
 *
 * The producer takes an already-built shell stage directory (the GTK shell
 * build output containing `bin/` entrypoints) so the same command covers
 * x86_64, arm64, and riscv64 cross-builds. It refuses to package a stage
 * whose declared entrypoints are missing or non-executable, and the verifier
 * re-derives every digest and signature from bytes rather than trusting the
 * manifest. Refs elizaOS/eliza#21783.
 */

import { execFileSync } from "node:child_process";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as edSign,
  verify as edVerify,
  generateKeyPairSync,
} from "node:crypto";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

export const MANIFEST_NAME = "desktop-artifact-manifest.json";
export const MANIFEST_SIGNATURE_NAME = "desktop-artifact-manifest.json.sig";
export const SCHEMA_PATH = path.join(
  scriptDir,
  "schemas",
  "desktop-artifact-manifest.schema.json",
);

export const ARCHITECTURES = ["x86_64", "arm64", "riscv64"];

const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const ARCHIVE_RE = /^[A-Za-z0-9._-]+\.tar\.zst$/;
const SIGNATURE_RE = /^[A-Za-z0-9._-]+\.sig$/;
const ENTRYPOINT_RE = /^bin\/[A-Za-z0-9._-]+$/;

const REQUIRED_ENTRYPOINTS = ["desktop", "agent", "doctor"];
const REQUIRED_CAPABILITIES = [
  "tray",
  "overlay",
  "wayland",
  "cloudAuth",
  "computerUse",
  "remoteControl",
];

/** Error type for every contract violation this module detects. */
export class ArtifactContractError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ArtifactContractError";
  }
}

function fail(message) {
  throw new ArtifactContractError(message);
}

function pathEntryExists(filePath) {
  try {
    lstatSync(filePath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function assertRegularFile(filePath, label) {
  let stats;
  try {
    stats = lstatSync(filePath);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      fail(`missing ${label}`);
    }
    throw error;
  }
  if (!stats.isFile()) {
    fail(`${label} must be a regular non-symlink file`);
  }
}

function isWithinDirectory(rootDir, candidatePath) {
  return (
    candidatePath === rootDir ||
    candidatePath.startsWith(`${rootDir}${path.sep}`)
  );
}

function hasControlCharacters(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

/** Rejects stage entries that could escape or create special files on extraction. */
export function assertSafeStageTree(stageDir) {
  const canonicalStageDir = realpathSync(stageDir);
  const pending = [canonicalStageDir];
  let entryCount = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      entryCount += 1;
      if (entryCount > 100_000) fail("stage contains more than 100000 entries");
      if (hasControlCharacters(entry.name)) {
        fail("stage entry names must not contain control characters");
      }
      const fullPath = path.join(directory, entry.name);
      const stats = lstatSync(fullPath);
      if (stats.isDirectory()) {
        pending.push(fullPath);
        continue;
      }
      if (stats.isFile()) {
        if (stats.nlink > 1) fail("stage must not contain hard-linked files");
        continue;
      }
      if (stats.isSymbolicLink()) {
        const target = readlinkSync(fullPath);
        if (path.isAbsolute(target) || target.split(/[\\/]/).includes("..")) {
          fail("stage symlinks must use a non-traversing relative target");
        }
        let resolvedTarget;
        try {
          resolvedTarget = realpathSync(fullPath);
        } catch (error) {
          // error-policy:J2 context-adding rethrow: identify the unsafe stage link.
          throw new ArtifactContractError(
            `stage symlink target is missing: ${path.relative(canonicalStageDir, fullPath)}`,
            { cause: error },
          );
        }
        if (!isWithinDirectory(canonicalStageDir, resolvedTarget)) {
          fail("stage symlink resolves outside the stage directory");
        }
        continue;
      }
      fail("stage contains a socket, device, FIFO, or unsupported entry type");
    }
  }
}

function requireEd25519PrivateKey(privateKeyPem) {
  let privateKey;
  try {
    privateKey = createPrivateKey(privateKeyPem);
  } catch (error) {
    // error-policy:J2 context-adding rethrow: keep parser diagnostics as cause.
    throw new ArtifactContractError(
      "artifact signing key is not a valid private key",
      { cause: error },
    );
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    fail("artifact signing key must be Ed25519");
  }
  return privateKey;
}

function requireEd25519PublicKey(publicKeyPem) {
  let publicKey;
  try {
    publicKey = createPublicKey(publicKeyPem);
  } catch (error) {
    // error-policy:J2 context-adding rethrow: keep parser diagnostics as cause.
    throw new ArtifactContractError(
      "artifact verification key is not a valid public key",
      { cause: error },
    );
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    fail("artifact verification key must be Ed25519");
  }
  return publicKey;
}

/** SHA-256 hex digest of a file's exact bytes. */
export function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

/** Detached Ed25519 signature (raw 64 bytes) over `bytes`. */
export function signBytes(privateKeyPem, bytes) {
  return edSign(null, bytes, requireEd25519PrivateKey(privateKeyPem));
}

/** Verifies a detached Ed25519 signature over `bytes`. */
export function verifyBytes(publicKeyPem, bytes, signature) {
  return edVerify(
    null,
    bytes,
    requireEd25519PublicKey(publicKeyPem),
    signature,
  );
}

/** Generates a PEM Ed25519 keypair for local/dev signing. */
export function generateSigningKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
  };
}

/** Creates a signing keypair without rotating or weakening an existing key. */
export function writeSigningKeyPair(outDir) {
  mkdirSync(outDir, { recursive: true });
  const privateKeyPath = path.join(outDir, "desktop-signing.key.pem");
  const publicKeyPath = path.join(outDir, "desktop-signing.pub.pem");
  if (pathEntryExists(privateKeyPath) || pathEntryExists(publicKeyPath)) {
    fail("refusing to overwrite an existing desktop signing keypair");
  }
  const { privateKeyPem, publicKeyPem } = generateSigningKeyPair();
  let privateKeyCreated = false;
  try {
    writeFileSync(privateKeyPath, privateKeyPem, {
      flag: "wx",
      mode: 0o600,
    });
    privateKeyCreated = true;
    writeFileSync(publicKeyPath, publicKeyPem, { flag: "wx", mode: 0o644 });
  } catch (error) {
    if (privateKeyCreated) {
      try {
        unlinkSync(privateKeyPath);
      } catch {
        // error-policy:J6 best-effort teardown: preserve the original write failure.
      }
    }
    throw error;
  }
  return { privateKeyPath, publicKeyPath };
}

/**
 * Validates a parsed manifest object against the vendored schema contract.
 * Returns the list of violations (empty when valid); `assertValidManifest`
 * throws instead.
 */
export function manifestViolations(manifest) {
  const problems = [];
  if (typeof manifest !== "object" || manifest === null) {
    return ["manifest is not an object"];
  }
  const allowedTop = [
    "schemaVersion",
    "sourceCommit",
    "version",
    "architecture",
    "shell",
    "archive",
    "sha256",
    "signature",
    "manifestSignature",
    "entrypoints",
    "capabilities",
  ];
  for (const key of allowedTop) {
    if (!(key in manifest)) problems.push(`missing required field "${key}"`);
  }
  for (const key of Object.keys(manifest)) {
    if (!allowedTop.includes(key)) problems.push(`unknown field "${key}"`);
  }
  if (manifest.schemaVersion !== 1) problems.push("schemaVersion must be 1");
  if (!COMMIT_RE.test(String(manifest.sourceCommit ?? ""))) {
    problems.push("sourceCommit must be a 40-char lowercase hex commit");
  }
  if (!VERSION_RE.test(String(manifest.version ?? ""))) {
    problems.push("version must be semver (x.y.z with optional prerelease)");
  }
  if (!ARCHITECTURES.includes(manifest.architecture)) {
    problems.push(`architecture must be one of ${ARCHITECTURES.join(", ")}`);
  }
  if (manifest.shell !== "gtk-webkit") {
    problems.push('shell must be "gtk-webkit"');
  }
  if (!ARCHIVE_RE.test(String(manifest.archive ?? ""))) {
    problems.push("archive must be a bare *.tar.zst filename");
  }
  if (!SHA256_RE.test(String(manifest.sha256 ?? ""))) {
    problems.push("sha256 must be a 64-char lowercase hex digest");
  }
  if (!SIGNATURE_RE.test(String(manifest.signature ?? ""))) {
    problems.push("signature must be a bare *.sig filename");
  }
  if (manifest.manifestSignature !== MANIFEST_SIGNATURE_NAME) {
    problems.push(`manifestSignature must be "${MANIFEST_SIGNATURE_NAME}"`);
  }
  const entrypoints = manifest.entrypoints;
  if (typeof entrypoints !== "object" || entrypoints === null) {
    problems.push("entrypoints must be an object");
  } else {
    for (const key of REQUIRED_ENTRYPOINTS) {
      if (!ENTRYPOINT_RE.test(String(entrypoints[key] ?? ""))) {
        problems.push(`entrypoints.${key} must match bin/<name>`);
      }
    }
    for (const key of Object.keys(entrypoints)) {
      if (!REQUIRED_ENTRYPOINTS.includes(key)) {
        problems.push(`unknown entrypoint "${key}"`);
      }
    }
  }
  const capabilities = manifest.capabilities;
  if (typeof capabilities !== "object" || capabilities === null) {
    problems.push("capabilities must be an object");
  } else {
    for (const key of REQUIRED_CAPABILITIES) {
      if (capabilities[key] !== true) {
        problems.push(`capabilities.${key} must be true`);
      }
    }
    for (const key of Object.keys(capabilities)) {
      if (!REQUIRED_CAPABILITIES.includes(key)) {
        problems.push(`unknown capability "${key}"`);
      }
    }
  }
  return problems;
}

/** Throws ArtifactContractError listing every schema violation. */
export function assertValidManifest(manifest) {
  const problems = manifestViolations(manifest);
  if (problems.length > 0) {
    fail(
      `manifest violates the desktop artifact contract:\n- ${problems.join("\n- ")}`,
    );
  }
}

/**
 * Asserts every declared entrypoint exists in the stage directory as an
 * executable regular file. Entrypoint paths are manifest-relative (bin/...).
 */
export function assertStageEntrypoints(stageDir, entrypoints) {
  const binStats = lstatSync(path.join(stageDir, "bin"));
  if (!binStats.isDirectory()) {
    fail("stage bin must be a real directory, not a symlink");
  }
  for (const key of REQUIRED_ENTRYPOINTS) {
    const rel = entrypoints[key];
    if (!ENTRYPOINT_RE.test(String(rel ?? ""))) {
      fail(`entrypoints.${key} "${rel}" does not match bin/<name>`);
    }
    const full = path.join(stageDir, rel);
    let stats;
    try {
      stats = lstatSync(full);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        fail(`entrypoint ${key} missing from stage: ${rel}`);
      }
      throw error;
    }
    if (!stats.isFile()) {
      fail(`entrypoint ${key} is not a regular non-symlink file: ${rel}`);
    }
    if ((stats.mode & 0o111) === 0) {
      fail(`entrypoint ${key} is not executable: ${rel}`);
    }
  }
}

function runTar(args) {
  execFileSync("tar", args, { stdio: ["ignore", "pipe", "inherit"] });
}

/** Lists archive member paths, normalized without a leading "./". */
export function listArchiveMembers(archivePath) {
  const out = execFileSync("tar", ["--zstd", "-tf", archivePath], {
    encoding: "utf8",
  });
  return out
    .split("\n")
    .map((line) => line.replace(/^\.\//, "").replace(/\/$/, ""))
    .filter((line) => line.length > 0 && line !== ".");
}

function assertSafeArchiveMembers(archivePath) {
  for (const member of listArchiveMembers(archivePath)) {
    if (
      path.posix.isAbsolute(member) ||
      member.split("/").some((segment) => segment === "..") ||
      hasControlCharacters(member)
    ) {
      fail(`archive contains an unsafe member path: ${JSON.stringify(member)}`);
    }
  }
  const verbose = execFileSync("tar", ["--zstd", "-tvf", archivePath], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  });
  for (const line of verbose.split("\n").filter(Boolean)) {
    const type = line[0];
    if (type !== "-" && type !== "d" && type !== "l") {
      fail(
        "archive contains a hard link, socket, device, FIFO, or unsupported type",
      );
    }
    if (type === "l") {
      const arrow = line.lastIndexOf(" -> ");
      const target = arrow >= 0 ? line.slice(arrow + 4) : "";
      if (
        !target ||
        path.posix.isAbsolute(target) ||
        target.split("/").includes("..")
      ) {
        fail("archive contains an unsafe symlink target");
      }
    }
  }
}

function assertArchivedEntrypoint(archivePath, relativePath, key) {
  const listing = execFileSync(
    "tar",
    ["--zstd", "-tvf", archivePath, `./${relativePath}`],
    { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } },
  ).trim();
  const mode = listing.split(/\s+/, 1)[0] ?? "";
  if (!/^-[rwx-]{9}$/.test(mode)) {
    fail(`entrypoint ${key} (${relativePath}) is not a regular archive file`);
  }
  if (mode[3] !== "x" && mode[6] !== "x" && mode[9] !== "x") {
    fail(
      `entrypoint ${key} (${relativePath}) is not executable in the archive`,
    );
  }
}

/**
 * Packages a staged shell build into the signed artifact set. Returns the
 * absolute paths of the four emitted files.
 */
export function produceArtifact({
  stageDir,
  outDir,
  privateKeyPem,
  version,
  architecture,
  sourceCommit,
  artifactBaseName = "eliza-desktop-gtk",
  entrypoints = {
    desktop: "bin/eliza-desktop",
    agent: "bin/eliza-agent",
    doctor: "bin/eliza-desktop-doctor",
  },
}) {
  if (!ARCHITECTURES.includes(architecture)) {
    fail(`unsupported architecture "${architecture}"`);
  }
  if (!VERSION_RE.test(version)) fail(`invalid version "${version}"`);
  if (!COMMIT_RE.test(sourceCommit)) {
    fail(`invalid sourceCommit "${sourceCommit}"`);
  }
  const signingKey = requireEd25519PrivateKey(privateKeyPem);
  if (!pathEntryExists(stageDir) || !statSync(stageDir).isDirectory()) {
    fail(`stage directory does not exist: ${stageDir}`);
  }

  mkdirSync(outDir, { recursive: true });
  const canonicalStageDir = realpathSync(stageDir);
  const canonicalOutDir = realpathSync(outDir);
  if (
    canonicalOutDir === canonicalStageDir ||
    canonicalOutDir.startsWith(`${canonicalStageDir}${path.sep}`)
  ) {
    fail(
      "output directory must not be the stage directory or one of its descendants",
    );
  }
  assertSafeStageTree(canonicalStageDir);
  assertStageEntrypoints(canonicalStageDir, entrypoints);
  const archiveName = `${artifactBaseName}-${version}-${architecture}.tar.zst`;
  if (!ARCHIVE_RE.test(archiveName)) {
    fail(`derived archive name "${archiveName}" violates the contract`);
  }
  const archiveSignatureName = `${archiveName.replace(/\.tar\.zst$/, "")}.sig`;
  const outputNames = [
    archiveName,
    archiveSignatureName,
    MANIFEST_SIGNATURE_NAME,
    MANIFEST_NAME,
  ];
  for (const outputName of outputNames) {
    if (pathEntryExists(path.join(canonicalOutDir, outputName))) {
      fail(`refusing to overwrite existing artifact output: ${outputName}`);
    }
  }
  const stagingDir = mkdtempSync(
    path.join(canonicalOutDir, ".linux-gtk-artifact-"),
  );
  const publishedEntries = [];
  try {
    const stagedArchivePath = path.join(stagingDir, archiveName);
    runTar(["--zstd", "-cf", stagedArchivePath, "-C", canonicalStageDir, "."]);
    assertSafeArchiveMembers(stagedArchivePath);
    const archiveBytes = readFileSync(stagedArchivePath);
    const archiveDigest = createHash("sha256")
      .update(archiveBytes)
      .digest("hex");
    writeFileSync(
      path.join(stagingDir, archiveSignatureName),
      edSign(null, archiveBytes, signingKey),
      { flag: "wx" },
    );

    const manifest = {
      schemaVersion: 1,
      sourceCommit,
      version,
      architecture,
      shell: "gtk-webkit",
      archive: archiveName,
      sha256: archiveDigest,
      signature: archiveSignatureName,
      manifestSignature: MANIFEST_SIGNATURE_NAME,
      entrypoints,
      capabilities: {
        tray: true,
        overlay: true,
        wayland: true,
        cloudAuth: true,
        computerUse: true,
        remoteControl: true,
      },
    };
    assertValidManifest(manifest);
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(path.join(stagingDir, MANIFEST_NAME), manifestBytes, {
      flag: "wx",
    });
    writeFileSync(
      path.join(stagingDir, MANIFEST_SIGNATURE_NAME),
      edSign(null, manifestBytes, signingKey),
      { flag: "wx" },
    );

    for (const outputName of outputNames) {
      const publishedPath = path.join(canonicalOutDir, outputName);
      linkSync(path.join(stagingDir, outputName), publishedPath);
      const publishedStats = lstatSync(publishedPath);
      publishedEntries.push({
        dev: publishedStats.dev,
        ino: publishedStats.ino,
        path: publishedPath,
      });
    }
    return {
      archivePath: path.join(canonicalOutDir, archiveName),
      archiveSignaturePath: path.join(canonicalOutDir, archiveSignatureName),
      manifestPath: path.join(canonicalOutDir, MANIFEST_NAME),
      manifestSignaturePath: path.join(
        canonicalOutDir,
        MANIFEST_SIGNATURE_NAME,
      ),
    };
  } catch (error) {
    for (const published of publishedEntries.reverse()) {
      try {
        const current = lstatSync(published.path);
        if (current.dev === published.dev && current.ino === published.ino) {
          unlinkSync(published.path);
        }
      } catch {
        // error-policy:J6 best-effort teardown: preserve the publication failure.
      }
    }
    throw error;
  } finally {
    try {
      rmSync(stagingDir, { force: true, recursive: true });
    } catch {
      // error-policy:J6 best-effort teardown: published bytes remain authoritative.
    }
  }
}

/**
 * Fully verifies an artifact directory: schema validity, manifest signature
 * over exact manifest bytes, archive digest, archive signature over exact
 * archive bytes, and presence of every declared entrypoint in the archive.
 * Throws ArtifactContractError on the first failure; returns the manifest.
 */
export function verifyArtifactDir(outDir, publicKeyPem) {
  const manifestPath = path.join(outDir, MANIFEST_NAME);
  assertRegularFile(manifestPath, MANIFEST_NAME);
  const manifestBytes = readFileSync(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch (error) {
    // error-policy:J2 context-adding rethrow: name the file that failed to parse.
    throw new ArtifactContractError(
      `${MANIFEST_NAME} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  assertValidManifest(manifest);

  const manifestSigPath = path.join(outDir, MANIFEST_SIGNATURE_NAME);
  assertRegularFile(manifestSigPath, MANIFEST_SIGNATURE_NAME);
  if (
    !verifyBytes(publicKeyPem, manifestBytes, readFileSync(manifestSigPath))
  ) {
    fail("manifest signature does not verify over the exact manifest bytes");
  }

  const archivePath = path.join(outDir, manifest.archive);
  assertRegularFile(archivePath, `archive ${manifest.archive}`);
  const archiveBytes = readFileSync(archivePath);
  const digest = createHash("sha256").update(archiveBytes).digest("hex");
  if (digest !== manifest.sha256) {
    fail(
      `archive digest mismatch: manifest says ${manifest.sha256}, archive is ${digest}`,
    );
  }
  const archiveSigPath = path.join(outDir, manifest.signature);
  assertRegularFile(archiveSigPath, `archive signature ${manifest.signature}`);
  if (!verifyBytes(publicKeyPem, archiveBytes, readFileSync(archiveSigPath))) {
    fail("archive signature does not verify over the exact archive bytes");
  }

  const members = new Set(listArchiveMembers(archivePath));
  assertSafeArchiveMembers(archivePath);
  for (const key of REQUIRED_ENTRYPOINTS) {
    if (!members.has(manifest.entrypoints[key])) {
      fail(
        `entrypoint ${key} (${manifest.entrypoints[key]}) is not present in the archive`,
      );
    }
    assertArchivedEntrypoint(archivePath, manifest.entrypoints[key], key);
  }
  return manifest;
}

function parseArgs(argv) {
  const args = new Map();
  for (const arg of argv) {
    const [key, ...rest] = arg.replace(/^--/, "").split("=");
    args.set(key, rest.join("=") || "true");
  }
  return args;
}

function cliMain() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (command === "produce") {
    const keyPath = args.get("key");
    if (!keyPath) fail("--key=<ed25519-private-key.pem> is required");
    const sourceCommit =
      args.get("source-commit") ??
      execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const result = produceArtifact({
      stageDir: path.resolve(args.get("stage") ?? ""),
      outDir: path.resolve(args.get("out") ?? ""),
      privateKeyPem: readFileSync(keyPath, "utf8"),
      version: args.get("version") ?? "",
      architecture: args.get("arch") ?? "",
      sourceCommit,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "verify") {
    const pubPath = args.get("public-key");
    if (!pubPath) fail("--public-key=<ed25519-public-key.pem> is required");
    const manifest = verifyArtifactDir(
      path.resolve(args.get("dir") ?? ""),
      readFileSync(pubPath, "utf8"),
    );
    process.stdout.write(
      `verified ${manifest.archive} (${manifest.architecture}) at schema v${manifest.schemaVersion}\n`,
    );
    return;
  }
  if (command === "generate-key") {
    const outDir = path.resolve(args.get("out") ?? ".");
    writeSigningKeyPair(outDir);
    process.stdout.write(`wrote Ed25519 keypair under ${outDir}\n`);
    return;
  }
  fail(
    "usage: package-linux-gtk-artifact.mjs <produce|verify|generate-key> [--stage= --out= --key= --version= --arch= | --dir= --public-key=]",
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  cliMain();
}

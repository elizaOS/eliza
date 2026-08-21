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
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
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
  constructor(message) {
    super(message);
    this.name = "ArtifactContractError";
  }
}

function fail(message) {
  throw new ArtifactContractError(message);
}

/** SHA-256 hex digest of a file's exact bytes. */
export function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

/** Detached Ed25519 signature (raw 64 bytes) over `bytes`. */
export function signBytes(privateKeyPem, bytes) {
  return edSign(null, bytes, createPrivateKey(privateKeyPem));
}

/** Verifies a detached Ed25519 signature over `bytes`. */
export function verifyBytes(publicKeyPem, bytes, signature) {
  return edVerify(null, bytes, createPublicKey(publicKeyPem), signature);
}

/** Generates a PEM Ed25519 keypair for local/dev signing. */
export function generateSigningKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
  };
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
  for (const key of REQUIRED_ENTRYPOINTS) {
    const rel = entrypoints[key];
    if (!ENTRYPOINT_RE.test(String(rel ?? ""))) {
      fail(`entrypoints.${key} "${rel}" does not match bin/<name>`);
    }
    const full = path.join(stageDir, rel);
    if (!existsSync(full)) {
      fail(`entrypoint ${key} missing from stage: ${rel}`);
    }
    const stats = statSync(full);
    if (!stats.isFile()) {
      fail(`entrypoint ${key} is not a regular file: ${rel}`);
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
  if (!existsSync(stageDir) || !statSync(stageDir).isDirectory()) {
    fail(`stage directory does not exist: ${stageDir}`);
  }
  assertStageEntrypoints(stageDir, entrypoints);

  mkdirSync(outDir, { recursive: true });
  const archiveName = `${artifactBaseName}-${version}-${architecture}.tar.zst`;
  if (!ARCHIVE_RE.test(archiveName)) {
    fail(`derived archive name "${archiveName}" violates the contract`);
  }
  const archivePath = path.join(outDir, archiveName);
  runTar(["--zstd", "-cf", archivePath, "-C", stageDir, "."]);

  const archiveBytes = readFileSync(archivePath);
  const archiveDigest = createHash("sha256").update(archiveBytes).digest("hex");
  const archiveSignatureName = `${archiveName.replace(/\.tar\.zst$/, "")}.sig`;
  writeFileSync(
    path.join(outDir, archiveSignatureName),
    signBytes(privateKeyPem, archiveBytes),
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
  const manifestPath = path.join(outDir, MANIFEST_NAME);
  writeFileSync(manifestPath, manifestBytes);
  writeFileSync(
    path.join(outDir, MANIFEST_SIGNATURE_NAME),
    signBytes(privateKeyPem, manifestBytes),
  );

  return {
    archivePath,
    archiveSignaturePath: path.join(outDir, archiveSignatureName),
    manifestPath,
    manifestSignaturePath: path.join(outDir, MANIFEST_SIGNATURE_NAME),
  };
}

/**
 * Fully verifies an artifact directory: schema validity, manifest signature
 * over exact manifest bytes, archive digest, archive signature over exact
 * archive bytes, and presence of every declared entrypoint in the archive.
 * Throws ArtifactContractError on the first failure; returns the manifest.
 */
export function verifyArtifactDir(outDir, publicKeyPem) {
  const manifestPath = path.join(outDir, MANIFEST_NAME);
  if (!existsSync(manifestPath)) fail(`missing ${MANIFEST_NAME} in ${outDir}`);
  const manifestBytes = readFileSync(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch (error) {
    // error-policy:J2 context-adding rethrow: name the file that failed to parse.
    throw new ArtifactContractError(
      `${MANIFEST_NAME} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assertValidManifest(manifest);

  const manifestSigPath = path.join(outDir, MANIFEST_SIGNATURE_NAME);
  if (!existsSync(manifestSigPath)) {
    fail(`missing ${MANIFEST_SIGNATURE_NAME} next to the manifest`);
  }
  if (
    !verifyBytes(publicKeyPem, manifestBytes, readFileSync(manifestSigPath))
  ) {
    fail("manifest signature does not verify over the exact manifest bytes");
  }

  const archivePath = path.join(outDir, manifest.archive);
  if (!existsSync(archivePath)) fail(`missing archive ${manifest.archive}`);
  const archiveBytes = readFileSync(archivePath);
  const digest = createHash("sha256").update(archiveBytes).digest("hex");
  if (digest !== manifest.sha256) {
    fail(
      `archive digest mismatch: manifest says ${manifest.sha256}, archive is ${digest}`,
    );
  }
  const archiveSigPath = path.join(outDir, manifest.signature);
  if (!existsSync(archiveSigPath)) {
    fail(`missing archive signature ${manifest.signature}`);
  }
  if (!verifyBytes(publicKeyPem, archiveBytes, readFileSync(archiveSigPath))) {
    fail("archive signature does not verify over the exact archive bytes");
  }

  const members = new Set(listArchiveMembers(archivePath));
  for (const key of REQUIRED_ENTRYPOINTS) {
    if (!members.has(manifest.entrypoints[key])) {
      fail(
        `entrypoint ${key} (${manifest.entrypoints[key]}) is not present in the archive`,
      );
    }
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
    mkdirSync(outDir, { recursive: true });
    const { privateKeyPem, publicKeyPem } = generateSigningKeyPair();
    writeFileSync(path.join(outDir, "desktop-signing.key.pem"), privateKeyPem, {
      mode: 0o600,
    });
    writeFileSync(path.join(outDir, "desktop-signing.pub.pem"), publicKeyPem);
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

#!/usr/bin/env node
/** Build and collect a fail-closed Pixel 11 Pro flash handoff bundle. */

import { spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { contractCandidate } from "../android/contract-candidate.mjs";
import {
  assertSafeFlashMetadata,
  parseFastbootInfoArtifacts,
  REQUIRED_GRIZZLY_ARTIFACTS,
} from "../android/flash-metadata.mjs";
import {
  assertGeneratedVendorTree,
  assertPinnedAospCheckout,
  loadAospLock,
} from "../distro-android/bootstrap-aosp.mjs";
import {
  assertGeneratedVintfApi,
  grizzlyLunchTarget,
} from "../distro-android/prepare-grizzly.mjs";

export {
  assertSafeFlashMetadata,
  parseFastbootInfoArtifacts,
  REQUIRED_GRIZZLY_ARTIFACTS,
} from "../android/flash-metadata.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "../..");
const defaultLockPath = path.join(
  repositoryRoot,
  "android/pixel11pro.lock.json",
);
const REQUIRED_BUILD_RECEIPTS = Object.freeze([
  "build_fingerprint-eliza_grizzly_phone.txt",
  "host_init_verifier_output.txt",
  "obj/PACKAGING/check_vintf_all_intermediates/check_vintf_compatible.log",
  "obj/PACKAGING/check_vintf_all_intermediates/check_vintf_system.log",
  "obj/PACKAGING/check_vintf_all_intermediates/check_vintf_vendor.log",
]);

export const REQUIRED_APK_PROVENANCE = Object.freeze([
  "assets/agent/android-agent-runtime-provenance.json",
  "META-INF/eliza/aosp-build-provenance.json",
]);

function fail(message) {
  throw new Error(`[grizzly-bundle] ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error || result.status !== 0) {
    fail(
      `${command} ${args.join(" ")} failed${
        result.error
          ? `: ${result.error.message}`
          : ` with exit ${result.status}`
      }${result.stderr ? `\n${result.stderr}` : ""}`,
    );
  }
  const output = options.stdoutOnly
    ? (result.stdout ?? "")
    : `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return options.raw ? output : output.trim();
}

function runWithReceipt(command, args, { cwd, receiptPath }) {
  const descriptor = fs.openSync(
    receiptPath,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_NOFOLLOW,
    0o600,
  );
  let result;
  try {
    fs.writeSync(
      descriptor,
      `command=${JSON.stringify([command, ...args])}\nworkingDirectory=${JSON.stringify(cwd)}\n--- output ---\n`,
    );
    result = spawnSync(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", descriptor, descriptor],
    });
    fs.writeSync(
      descriptor,
      `\n--- result ---\nexitStatus=${result.status ?? "none"}\nsignal=${result.signal ?? "none"}\n`,
    );
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  if (result.error || result.status !== 0) {
    fail(
      `${command} ${args.join(" ")} failed${
        result.error
          ? `: ${result.error.message}`
          : ` with exit ${result.status ?? "none"}`
      }`,
    );
  }
  return {
    filename: path.basename(receiptPath),
    sizeBytes: assertRegularFile(receiptPath, "successful build receipt").size,
    sha256: sha256File(receiptPath),
  };
}

function sameFile(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function sameInode(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function readStableFile(filename, { allowEmpty = false } = {}) {
  const descriptor = fs.openSync(
    filename,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const before = fs.fstatSync(descriptor);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      (!allowEmpty && before.size < 1)
    ) {
      fail(`input must be a private regular file: ${filename}`);
    }
    const contents = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    const pathState = fs.lstatSync(filename);
    if (
      contents.length !== before.size ||
      !sameFile(before, after) ||
      !sameFile(before, pathState) ||
      pathState.isSymbolicLink()
    ) {
      fail(`input changed while reading: ${filename}`);
    }
    return contents;
  } finally {
    fs.closeSync(descriptor);
  }
}

export function sha256File(filename, { allowEmpty = false } = {}) {
  const descriptor = fs.openSync(
    filename,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const before = fs.fstatSync(descriptor);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      (!allowEmpty && before.size < 1)
    ) {
      fail(`input must be a private regular file: ${filename}`);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < before.size) {
      const bytesRead = fs.readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, before.size - position),
        position,
      );
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = fs.fstatSync(descriptor);
    const pathState = fs.lstatSync(filename);
    if (
      position !== before.size ||
      !sameFile(before, after) ||
      !sameFile(before, pathState) ||
      pathState.isSymbolicLink()
    ) {
      fail(`input changed while hashing: ${filename}`);
    }
    return hash.digest("hex");
  } finally {
    fs.closeSync(descriptor);
  }
}

export function assertRegularFile(
  filename,
  label = filename,
  allowEmpty = false,
) {
  const stat = fs.lstatSync(filename, { throwIfNoEntry: false });
  if (
    !stat?.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (!allowEmpty && stat.size < 1)
  ) {
    fail(
      `${label} must be a private ${allowEmpty ? "" : "non-empty "}regular file: ${filename}`,
    );
  }
  return stat;
}

function copyVerifiedFile(source, destination, label) {
  const sourceDescriptor = fs.openSync(
    source,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  let destinationDescriptor;
  try {
    const before = fs.fstatSync(sourceDescriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size < 1) {
      fail(`${label} is not a private non-empty regular file`);
    }
    destinationDescriptor = fs.openSync(
      destination,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o644,
    );
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < before.size) {
      const bytesRead = fs.readSync(
        sourceDescriptor,
        buffer,
        0,
        Math.min(buffer.length, before.size - position),
        position,
      );
      if (bytesRead === 0) break;
      let written = 0;
      while (written < bytesRead) {
        written += fs.writeSync(
          destinationDescriptor,
          buffer,
          written,
          bytesRead - written,
          position + written,
        );
      }
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    fs.fsyncSync(destinationDescriptor);
    const sourceAfter = fs.fstatSync(sourceDescriptor);
    const sourcePathState = fs.lstatSync(source);
    const destinationState = fs.fstatSync(destinationDescriptor);
    const destinationPathState = fs.lstatSync(destination);
    if (
      position !== before.size ||
      !sameFile(before, sourceAfter) ||
      !sameFile(before, sourcePathState) ||
      destinationState.size !== before.size ||
      !sameFile(destinationState, destinationPathState)
    ) {
      fail(`${label} changed or was replaced while copying`);
    }
    return { sizeBytes: before.size, sha256: hash.digest("hex") };
  } finally {
    if (destinationDescriptor !== undefined)
      fs.closeSync(destinationDescriptor);
    fs.closeSync(sourceDescriptor);
  }
}

export function assertApkProvenanceEntries(entries) {
  const missing = REQUIRED_APK_PROVENANCE.filter(
    (required) => entries.filter((entry) => entry === required).length !== 1,
  );
  if (missing.length > 0) {
    fail(
      `privileged APK must contain each provenance entry exactly once: ${missing.join(", ")}`,
    );
  }
  return [...REQUIRED_APK_PROVENANCE];
}

export function collectGrizzlyArtifacts({ productOut, bundleDir }) {
  for (const filename of REQUIRED_GRIZZLY_ARTIFACTS) {
    assertRegularFile(
      path.join(productOut, filename),
      `required build artifact ${filename}`,
    );
  }
  const fastbootInfo = readStableFile(
    path.join(productOut, "fastboot-info.txt"),
  ).toString("utf8");
  const { artifacts: referencedArtifacts } =
    parseFastbootInfoArtifacts(fastbootInfo);
  const filenames = [
    ...new Set([...REQUIRED_GRIZZLY_ARTIFACTS, ...referencedArtifacts]),
  ];
  fs.mkdirSync(bundleDir, { recursive: false, mode: 0o700 });
  return filenames.map((filename) => {
    const source = path.join(productOut, filename);
    assertRegularFile(source, `required build artifact ${filename}`);
    const destination = path.join(bundleDir, filename);
    const evidence = copyVerifiedFile(
      source,
      destination,
      `required build artifact ${filename}`,
    );
    return { filename, ...evidence };
  });
}

export function parseArgs(argv) {
  const args = {
    aospRoot: null,
    outputDir: null,
    jobs: Math.max(1, os.cpus().length),
    preflightOnly: false,
    lockPath: defaultLockPath,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[++index];
      if (!next || next.startsWith("--")) fail(`${flag} requires a value`);
      return next;
    };
    if (flag === "--aosp-root") args.aospRoot = path.resolve(value());
    else if (flag === "--output-dir") args.outputDir = path.resolve(value());
    else if (flag === "--lock") args.lockPath = path.resolve(value());
    else if (flag === "--jobs") args.jobs = Number(value());
    else if (flag === "--preflight-only") args.preflightOnly = true;
    else fail(`unknown argument: ${flag}`);
  }
  if (!args.aospRoot) fail("--aosp-root is required");
  if (!args.preflightOnly && !args.outputDir) fail("--output-dir is required");
  if (!Number.isSafeInteger(args.jobs) || args.jobs < 1 || args.jobs > 256) {
    fail("--jobs must be an integer from 1 through 256");
  }
  return args;
}

function physicalCoreCount() {
  const output = run("lscpu", ["-p=CORE,SOCKET"], { capture: true });
  return new Set(
    output
      .split("\n")
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => line.trim()),
  ).size;
}

export function assertBuilderCapacity({
  platform,
  architecture,
  physicalCores,
  memoryBytes,
  totalBytes,
  freeBytes,
}) {
  if (platform !== "linux" || architecture !== "x64") {
    fail("Pixel 11 Pro bundles require a Linux x86_64 builder");
  }
  if (physicalCores < 32 || memoryBytes < 128 * 1024 ** 3) {
    fail(
      `dedicated builder is undersized: ${physicalCores} physical cores/${Math.floor(memoryBytes / 1024 ** 3)} GiB RAM; require 32/128`,
    );
  }
  if (totalBytes < 1_500_000_000_000 || freeBytes < 600 * 1024 ** 3) {
    fail(
      `dedicated builder storage is undersized: ${Math.floor(totalBytes / 1_000_000_000)} GB total/${Math.floor(freeBytes / 1024 ** 3)} GiB free; require 1500 GB/600 GiB`,
    );
  }
  return { physicalCores, memoryBytes, totalBytes, freeBytes };
}

function existingFilesystemPath(candidate) {
  let current = candidate;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current)
      fail(`no existing filesystem for path: ${candidate}`);
    current = parent;
  }
  return current;
}

export function assertDedicatedBuilder(aospRoot, outRoot = aospRoot) {
  if (!fs.existsSync(aospRoot)) fail(`AOSP root does not exist: ${aospRoot}`);
  const sourceFilesystem = fs.statfsSync(aospRoot);
  const outputFilesystemPath = existingFilesystemPath(outRoot);
  const outputFilesystem = fs.statfsSync(outputFilesystemPath);
  const host = {
    platform: process.platform,
    architecture: process.arch,
    physicalCores: physicalCoreCount(),
    memoryBytes: os.totalmem(),
  };
  const sourceCapacity = assertBuilderCapacity({
    ...host,
    totalBytes: sourceFilesystem.blocks * sourceFilesystem.bsize,
    freeBytes: sourceFilesystem.bavail * sourceFilesystem.bsize,
  });
  const outputCapacity = assertBuilderCapacity({
    ...host,
    totalBytes: outputFilesystem.blocks * outputFilesystem.bsize,
    freeBytes: outputFilesystem.bavail * outputFilesystem.bsize,
  });
  return { ...sourceCapacity, outputCapacity, outputFilesystemPath };
}

function sourceDate() {
  const value = process.env.SOURCE_DATE_EPOCH;
  if (!value || !/^\d+$/.test(value)) {
    fail("SOURCE_DATE_EPOCH is required for a reproducible bundle timestamp");
  }
  const milliseconds = Number(value) * 1000;
  const date = new Date(milliseconds);
  if (!Number.isSafeInteger(milliseconds) || Number.isNaN(date.valueOf())) {
    fail("SOURCE_DATE_EPOCH is out of range");
  }
  return date.toISOString();
}

function cleanGitCommit(root, label) {
  const commit = run("git", ["rev-parse", "HEAD"], {
    cwd: root,
    capture: true,
  });
  const status = run("git", ["status", "--porcelain=v1"], {
    cwd: root,
    capture: true,
  });
  if (status) fail(`${label} checkout is dirty; refusing ambiguous provenance`);
  return commit;
}

function assertOutputOutsideSource(outputDir, sourceRoot, label) {
  const canonicalSource = fs.realpathSync(sourceRoot);
  const canonicalParent = fs.realpathSync(path.dirname(outputDir));
  const canonicalOutput = path.join(canonicalParent, path.basename(outputDir));
  const relative = path.relative(canonicalSource, canonicalOutput);
  if (
    !relative ||
    (!relative.startsWith(`..${path.sep}`) && relative !== "..")
  ) {
    fail(`output directory must be outside the ${label} checkout`);
  }
}

function captureBuilderEnvironment({ aospRoot, outRoot, builder }) {
  const toolVersions = Object.fromEntries(
    [
      ["git", "git", ["--version"]],
      ["java", "java", ["-version"]],
      ["python", "python3", ["--version"]],
      ["go", "go", ["version"]],
      ["rust", "rustc", ["--version"]],
      ["bun", "bun", ["--version"]],
      ["node", "node", ["--version"]],
      ["adb", "adb", ["version"]],
      ["fastboot", "fastboot", ["--version"]],
    ].map(([name, command, args]) => [
      name,
      run(command, args, { capture: true }),
    ]),
  );
  return {
    ...builder,
    osRelease: fs.readFileSync("/etc/os-release", "utf8").trim(),
    kernel: run("uname", ["-srvmo"], { capture: true }),
    cpu: {
      logicalCount: os.cpus().length,
      model: os.cpus()[0]?.model ?? "unknown",
    },
    buildFilesystem: run(
      "df",
      [
        "-B1",
        "--output=source,fstype,size,avail,target",
        aospRoot,
        builder.outputFilesystemPath,
      ],
      { capture: true },
    ),
    storageDevices: run(
      "lsblk",
      ["-b", "-o", "NAME,MODEL,SERIAL,SIZE,ROTA,TYPE,FSTYPE,MOUNTPOINTS"],
      { capture: true },
    ),
    limits: run("bash", ["-lc", "ulimit -a"], { capture: true }),
    toolVersions,
    cachePaths: {
      aospRoot,
      outRoot,
      sisoCacheDir: process.env.SISO_CACHE_DIR?.trim() || null,
      remoteBuildCacheDir: process.env.RBE_cache_dir?.trim() || null,
    },
  };
}

function readApkProvenance(apk, entry) {
  const contents = run("unzip", ["-p", apk, entry], {
    capture: true,
    raw: true,
    stdoutOnly: true,
  });
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    fail(`${entry} is not valid JSON: ${error.message}`);
  }
  return {
    entry,
    parsed,
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
}

function extractApkEntryEvidence(apk, entry, destination) {
  const descriptor = fs.openSync(
    destination,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_NOFOLLOW,
    0o600,
  );
  let result;
  try {
    result = spawnSync("unzip", ["-p", apk, entry], {
      encoding: "utf8",
      stdio: ["ignore", descriptor, "pipe"],
    });
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  if (result.error || result.status !== 0) {
    fail(`could not extract APK provenance input ${entry}`);
  }
  const stat = assertRegularFile(
    destination,
    `extracted APK entry ${entry}`,
    true,
  );
  return {
    sizeBytes: stat.size,
    sha256: sha256File(destination, { allowEmpty: true }),
  };
}

function verifyApkProvenance(apk, apkEntries, elizaCommit, scratchDir) {
  const [runtime, build] = REQUIRED_APK_PROVENANCE.map((entry) =>
    readApkProvenance(apk, entry),
  );
  if (runtime.parsed?.schema !== "eliza.android_agent_runtime_provenance.v1") {
    fail("privileged APK runtime provenance has an unsupported schema");
  }
  if (
    build.parsed?.schema !== "eliza.aosp_build_provenance.v1" ||
    build.parsed.git_revision !== elizaCommit ||
    build.parsed.android_package !== "ai.elizaos.app" ||
    build.parsed.runtime_provenance_entry !== runtime.entry ||
    build.parsed.runtime_provenance_sha256 !== runtime.sha256 ||
    !identicalSnapshot(build.parsed.runtime_provenance, runtime.parsed)
  ) {
    fail(
      "privileged APK build provenance does not bind the Eliza commit, package, and embedded runtime provenance",
    );
  }
  if (
    !Array.isArray(runtime.parsed.files) ||
    runtime.parsed.files.length === 0 ||
    runtime.parsed.files.length > 10_000
  ) {
    fail("privileged APK runtime provenance must contain a bounded file set");
  }
  const seen = new Set();
  for (const [index, file] of runtime.parsed.files.entries()) {
    if (
      typeof file?.path !== "string" ||
      path.posix.normalize(file.path) !== file.path ||
      file.path.startsWith("/") ||
      (!file.path.startsWith("assets/agent/") &&
        !file.path.startsWith("lib/")) ||
      !Number.isSafeInteger(file.size_bytes) ||
      file.size_bytes < 0 ||
      !/^[a-f0-9]{64}$/.test(file.sha256 ?? "") ||
      seen.has(file.path) ||
      apkEntries.filter((entry) => entry === file.path).length !== 1
    ) {
      fail("privileged APK runtime provenance contains an invalid file entry");
    }
    seen.add(file.path);
    const extracted = path.join(scratchDir, `.apk-provenance-entry-${index}`);
    try {
      const evidence = extractApkEntryEvidence(apk, file.path, extracted);
      if (
        evidence.sizeBytes !== file.size_bytes ||
        evidence.sha256 !== file.sha256
      ) {
        fail(
          `privileged APK runtime file does not match provenance: ${file.path}`,
        );
      }
    } finally {
      fs.rmSync(extracted, { force: true });
    }
  }
  const unboundAgentAssets = apkEntries.filter(
    (entry) =>
      entry.startsWith("assets/agent/") &&
      !entry.endsWith("/") &&
      entry !== runtime.entry &&
      !seen.has(entry),
  );
  if (unboundAgentAssets.length > 0) {
    fail(
      `privileged APK contains agent assets outside runtime provenance: ${unboundAgentAssets.join(", ")}`,
    );
  }
  return [runtime, build].map(({ entry, parsed, sha256 }) => ({
    entry,
    schema: parsed.schema,
    sha256,
  }));
}

function certificateSha256(pemPath) {
  return new X509Certificate(readStableFile(pemPath)).fingerprint256
    .replaceAll(":", "")
    .toLowerCase();
}

export function apkSignerSha256(receipt) {
  const lines = receipt.split(/\r?\n/);
  const counts = lines.filter((line) => line.startsWith("Number of signers:"));
  // New apksigner versions name the verified scheme instead of numbering a
  // single signer. Do not accept rotation/hybrid receipts or silently ignore
  // extra, malformed or unknown certificate records.
  const certificates = lines.filter((line) =>
    line.includes("certificate SHA-256 digest:"),
  );
  const match = certificates[0]?.match(
    /^(?:Signer #1|(?:V1 |V2 |V3\.0 )?Signer:) certificate SHA-256 digest: ([a-fA-F0-9]{64})$/,
  );
  if (
    counts.length !== 1 ||
    counts[0] !== "Number of signers: 1" ||
    certificates.length !== 1 ||
    !match
  ) {
    fail("apksigner must report exactly one signing certificate");
  }
  return match[1].toLowerCase();
}

export function parseGrizzlyBuildFingerprint(contents, expectedPrefix) {
  const fingerprint = contents.replace(/\r?\n$/, "");
  if (
    typeof expectedPrefix !== "string" ||
    expectedPrefix.length === 0 ||
    !fingerprint.startsWith(expectedPrefix) ||
    !/^[A-Za-z0-9._+-]+\/[A-Za-z0-9._+-]+\/[A-Za-z0-9._+-]+:[A-Za-z0-9._+-]+\/[A-Za-z0-9._+-]+\/[A-Za-z0-9._+-]+:userdebug\/test-keys$/.test(
      fingerprint,
    )
  ) {
    fail(
      "built fingerprint does not match the locked grizzly userdebug identity",
    );
  }
  return fingerprint;
}

function artifactSourceSnapshot(productOut, filenames) {
  return Object.fromEntries(
    filenames.map((filename) => {
      const source = path.join(productOut, filename);
      const stat = assertRegularFile(source, `build artifact ${filename}`);
      return [filename, { sizeBytes: stat.size, sha256: sha256File(source) }];
    }),
  );
}

export function hashDirectoryTree(root, allowedRoot = root, deniedRoots = []) {
  const canonicalAllowedRoot = fs.realpathSync(allowedRoot);
  const canonicalDeniedRoots = deniedRoots.map((deniedRoot) => {
    const existing = existingFilesystemPath(deniedRoot);
    return fs.existsSync(deniedRoot)
      ? fs.realpathSync(deniedRoot)
      : path.join(
          fs.realpathSync(existing),
          path.relative(existing, deniedRoot),
        );
  });
  const hash = createHash("sha256");
  const visit = (directory, prefix = "") => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      if (entry.name === ".git") continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) {
        hash.update(`d ${relative}\0`);
        visit(absolute, relative);
      } else if (stat.isFile()) {
        hash.update(
          `f ${relative} ${stat.mode & 0o777}\0${sha256File(absolute, { allowEmpty: true })}\0`,
        );
      } else if (stat.isSymbolicLink()) {
        const target = fs.realpathSync(absolute);
        const targetRelative = path.relative(canonicalAllowedRoot, target);
        if (
          targetRelative === ".." ||
          targetRelative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(targetRelative)
        ) {
          fail(`source-tree symlink escapes the AOSP checkout: ${absolute}`);
        }
        if (
          canonicalDeniedRoots.some(
            (deniedRoot) =>
              target === deniedRoot ||
              target.startsWith(`${deniedRoot}${path.sep}`),
          )
        ) {
          fail(
            `source-tree symlink targets excluded AOSP metadata or output: ${absolute}`,
          );
        }
        hash.update(
          `l ${relative}\0${fs.readlinkSync(absolute)}\0${targetRelative}\0`,
        );
      } else {
        fail(`unsupported source-tree entry: ${absolute}`);
      }
    }
  };
  visit(root);
  return hash.digest("hex");
}

function assertLockedOverlays(aospRoot, lock) {
  for (const overlay of lock.sourceOverlays ?? []) {
    const actual = sha256File(path.join(aospRoot, overlay.path));
    if (actual !== overlay.sha256) {
      fail(`locked source overlay drifted: ${overlay.path}`);
    }
  }
}

function parseProjectList(aospRoot) {
  const projectListPath = path.join(aospRoot, ".repo/project.list");
  const listed = readStableFile(projectListPath)
    .toString("utf8")
    .split("\n")
    .filter(Boolean);
  const unique = new Set();
  for (const projectPath of listed) {
    if (
      path.isAbsolute(projectPath) ||
      projectPath === ".." ||
      projectPath.startsWith("../") ||
      projectPath.includes("\\") ||
      path.posix.normalize(projectPath) !== projectPath ||
      unique.has(projectPath)
    ) {
      fail(
        `AOSP project list contains an unsafe or duplicate path: ${projectPath}`,
      );
    }
    unique.add(projectPath);
  }
  return [...unique].sort((left, right) => left.localeCompare(right, "en"));
}

function manifestAttributes(fragment, label) {
  const result = {};
  let remaining = fragment;
  while (remaining.trim()) {
    remaining = remaining.trimStart();
    const match = remaining.match(
      /^([A-Za-z_][A-Za-z0-9_.:-]*)=(?:"([^"]*)"|'([^']*)')/,
    );
    if (!match) {
      fail(
        `locked AOSP manifest contains invalid attribute syntax in ${label}`,
      );
    }
    const [, name, doubleQuoted, singleQuoted] = match;
    if (Object.hasOwn(result, name)) {
      fail(`locked AOSP manifest contains a duplicate ${name} in ${label}`);
    }
    const value = doubleQuoted ?? singleQuoted;
    if (value.includes("&")) {
      fail(`locked AOSP manifest uses unsupported entities in ${label}`);
    }
    result[name] = value;
    remaining = remaining.slice(match[0].length);
  }
  return result;
}

function exactObjectKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort((left, right) =>
    left.localeCompare(right, "en"),
  );
  const wanted = [...expected].sort((left, right) =>
    left.localeCompare(right, "en"),
  );
  if (!identicalSnapshot(actual, wanted)) {
    fail(`${label} has unsupported or missing fields`);
  }
}

function safeManifestPath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value !== "." &&
    value !== ".repo" &&
    !value.startsWith(".repo/") &&
    !path.posix.isAbsolute(value) &&
    value !== ".." &&
    !value.startsWith("../") &&
    !value.includes("\\") &&
    path.posix.normalize(value) === value
  );
}

function manifestRootEntries(projectPath, body) {
  const entries = [];
  const withoutEntries = body.replace(
    /<(copyfile|linkfile)\b([^>]*)\/\s*>/g,
    (_whole, directive, attributesFragment) => {
      const attributes = manifestAttributes(
        attributesFragment,
        `${directive} in ${projectPath}`,
      );
      exactObjectKeys(
        attributes,
        ["src", "dest"],
        `${directive} in ${projectPath}`,
      );
      if (
        !safeManifestPath(attributes.src) ||
        !safeManifestPath(attributes.dest)
      ) {
        fail(`locked AOSP manifest contains an unsafe ${directive}`);
      }
      entries.push({
        path: attributes.dest,
        projectPath,
        sourcePath: attributes.src,
        mode: directive === "copyfile" ? "copy" : "link",
      });
      return "";
    },
  );
  const withoutAnnotations = withoutEntries.replace(
    /<annotation\b[^>]*\/\s*>/g,
    "",
  );
  if (withoutAnnotations.trim()) {
    fail(
      `locked AOSP manifest has unsupported project children in ${projectPath}`,
    );
  }
  return entries;
}

function resolveManifestRemoteUrl(manifestUrl, fetch, projectName) {
  let base;
  try {
    base = new URL(fetch.endsWith("/") ? fetch : `${fetch}/`, manifestUrl);
  } catch (error) {
    fail(
      `locked AOSP manifest has an invalid remote fetch URL: ${error.message}`,
    );
  }
  const resolved = new URL(projectName, base).href;
  return resolved.endsWith("/") ? resolved.slice(0, -1) : resolved;
}

function stripManifestComments(contents) {
  if (
    /<!(?:DOCTYPE|\[CDATA\[)/i.test(contents) ||
    /<\?(?!xml\s)/i.test(contents)
  ) {
    fail("locked AOSP manifest uses unsupported XML constructs");
  }
  const withoutComments = contents.replace(/<!--[\s\S]*?-->/g, "");
  if (withoutComments.includes("<!--") || withoutComments.includes("-->")) {
    fail("locked AOSP manifest contains an invalid comment");
  }
  return withoutComments;
}

export function selectedManifestPath(aospRoot, manifestsRoot) {
  const selectorPath = path.join(aospRoot, ".repo/manifest.xml");
  const selectorState = fs.lstatSync(selectorPath);
  let selectedManifest;
  if (selectorState.isSymbolicLink()) {
    selectedManifest = fs.realpathSync(selectorPath);
  } else if (selectorState.isFile() && selectorState.nlink === 1) {
    let selector = stripManifestComments(
      readStableFile(selectorPath).toString("utf8"),
    );
    selector = selector.replace(/<\?xml\s[^?]*\?>/, "").trim();
    const wrapper = selector.match(
      /^<manifest\s*>\s*<include\b([^>]*)\/\s*>\s*<\/manifest\s*>$/,
    );
    if (!wrapper) {
      fail("generated AOSP manifest selector must contain one exact include");
    }
    const include = manifestAttributes(wrapper[1], "manifest selector include");
    exactObjectKeys(include, ["name"], "manifest selector include");
    if (!safeManifestPath(include.name)) {
      fail("generated AOSP manifest selector has an unsafe include");
    }
    selectedManifest = fs.realpathSync(path.join(manifestsRoot, include.name));
  } else {
    fail("AOSP manifest selector must be a private file or symlink");
  }
  const manifestRelative = path.relative(manifestsRoot, selectedManifest);
  if (
    !manifestRelative ||
    manifestRelative === ".." ||
    manifestRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(manifestRelative)
  ) {
    fail("selected AOSP manifest is not in the locked manifest checkout");
  }
  return { selectedManifest, manifestRelative };
}

export function requireResolvedManifestContract(lock) {
  const contract = lock?.resolvedManifest;
  if (
    !contract ||
    typeof contract.path !== "string" ||
    !/^[0-9a-f]{64}$/.test(contract.sha256 ?? "")
  ) {
    fail(
      "grizzly source lock has no authoritative resolved AOSP manifest contract",
    );
  }
  exactObjectKeys(contract, ["path", "sha256"], "resolvedManifest lock");
  return contract;
}

function lockedManifestProjects(aospRoot, lock) {
  const resolvedContract = requireResolvedManifestContract(lock);
  const resolvedPath = path.join(repositoryRoot, resolvedContract.path);
  const resolvedRelative = path.relative(repositoryRoot, resolvedPath);
  if (
    !resolvedRelative ||
    resolvedRelative === ".." ||
    resolvedRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(resolvedRelative)
  ) {
    fail("resolved AOSP manifest must be retained in the elizaOS/os checkout");
  }
  const resolvedBytes = readStableFile(resolvedPath);
  if (
    createHash("sha256").update(resolvedBytes).digest("hex") !==
    resolvedContract.sha256
  ) {
    fail("authoritative resolved AOSP manifest digest does not match the lock");
  }
  let resolved;
  try {
    resolved = JSON.parse(resolvedBytes);
  } catch (error) {
    fail(
      `authoritative resolved AOSP manifest is invalid JSON: ${error.message}`,
    );
  }
  if (
    resolved?.schemaVersion !== 1 ||
    resolved.manifestCommit !== lock.manifestCommit ||
    !Array.isArray(resolved.projects) ||
    resolved.projects.length === 0 ||
    !Array.isArray(resolved.rootEntries)
  ) {
    fail("authoritative resolved AOSP manifest has an invalid contract");
  }
  exactObjectKeys(
    resolved,
    ["schemaVersion", "manifestCommit", "projects", "rootEntries"],
    "authoritative resolved AOSP manifest",
  );
  const localManifests = path.join(aospRoot, ".repo/local_manifests");
  if (fs.existsSync(localManifests)) {
    fail("AOSP checkout must not contain local manifests");
  }
  const manifestsRoot = fs.realpathSync(path.join(aospRoot, ".repo/manifests"));
  const { selectedManifest, manifestRelative } = selectedManifestPath(
    aospRoot,
    manifestsRoot,
  );
  run("git", ["ls-files", "--error-unmatch", manifestRelative], {
    cwd: manifestsRoot,
    capture: true,
  });
  const rawContents = readStableFile(selectedManifest).toString("utf8");
  const contents = stripManifestComments(rawContents);
  const supportedElements = new Set([
    "manifest",
    "remote",
    "default",
    "project",
    "copyfile",
    "linkfile",
    "annotation",
    "superproject",
    "contactinfo",
  ]);
  for (const match of contents.matchAll(
    /<\/?\s*([A-Za-z_:][A-Za-z0-9_.:-]*)\b/g,
  )) {
    if (!supportedElements.has(match[1])) {
      fail(`locked AOSP manifest uses unsupported element ${match[1]}`);
    }
  }
  if (/<(?:include|remove-project|extend-project)\b/.test(contents)) {
    fail("locked AOSP manifest uses unsupported graph-altering directives");
  }
  const defaultMatches = [...contents.matchAll(/<default\b([^>]*?)\s*\/?>/g)];
  if (defaultMatches.length !== 1) {
    fail("locked AOSP manifest must contain exactly one default");
  }
  const defaults = manifestAttributes(defaultMatches[0][1], "default");
  if (!defaults.remote || !defaults.revision) {
    fail("locked AOSP manifest default must name a remote and revision");
  }
  if (defaults.revision !== `refs/tags/${lock.manifestRevision}`) {
    fail(
      "locked AOSP manifest default revision does not match the source lock",
    );
  }
  const remotes = new Map();
  for (const match of contents.matchAll(/<remote\b([^>]*?)\s*\/?>/g)) {
    const remote = manifestAttributes(match[1], "remote");
    if (!remote.name || !remote.fetch || remotes.has(remote.name)) {
      fail("locked AOSP manifest contains an invalid or duplicate remote");
    }
    remotes.set(remote.name, remote);
  }
  const projects = [];
  const rootEntries = [];
  const seen = new Set();
  let projectDeclarationCount = 0;
  const projectPattern =
    /<project\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/project\s*>)/g;
  for (const match of contents.matchAll(projectPattern)) {
    projectDeclarationCount += 1;
    const project = manifestAttributes(match[1], "project");
    const projectPath = project.path ?? project.name;
    if (
      !project.name ||
      !projectPath ||
      path.isAbsolute(projectPath) ||
      projectPath === ".." ||
      projectPath.startsWith("../") ||
      projectPath.includes("\\") ||
      path.posix.normalize(projectPath) !== projectPath ||
      seen.has(projectPath)
    ) {
      fail("locked AOSP manifest contains an unsafe or duplicate project");
    }
    seen.add(projectPath);
    const groups = new Set((project.groups ?? "").split(",").filter(Boolean));
    if (groups.has("notdefault")) continue;
    rootEntries.push(...manifestRootEntries(projectPath, match[2] ?? ""));
    const remoteName = project.remote ?? defaults.remote;
    const remote = remotes.get(remoteName);
    if (!remote) {
      fail(`locked AOSP project ${projectPath} references an unknown remote`);
    }
    projects.push({
      path: projectPath,
      name: project.name,
      remoteName,
      remoteUrl: resolveManifestRemoteUrl(
        lock.manifestUrl,
        remote.fetch,
        project.name,
      ),
      revision: project.revision ?? defaults.revision,
    });
  }
  if (
    [...contents.matchAll(/<project\b/g)].length !== projectDeclarationCount
  ) {
    fail("locked AOSP manifest contains an unsupported project declaration");
  }
  const expectedPaths = projects
    .map((project) => project.path)
    .sort((left, right) => left.localeCompare(right, "en"));
  const listedPaths = parseProjectList(aospRoot);
  if (!identicalSnapshot(expectedPaths, listedPaths)) {
    fail(
      "AOSP project list does not match the locked manifest's default graph",
    );
  }
  const manifestGraph = projects
    .map(({ path: projectPath, name, remoteName, remoteUrl }) => ({
      path: projectPath,
      name,
      remoteName,
      remoteUrl,
    }))
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
  const resolvedGraph = resolved.projects
    .map((project) => {
      exactObjectKeys(
        project,
        ["path", "name", "remoteName", "remoteUrl", "commit"],
        "authoritative resolved AOSP manifest project",
      );
      if (
        !safeManifestPath(project?.path) ||
        typeof project?.name !== "string" ||
        typeof project?.remoteName !== "string" ||
        typeof project?.remoteUrl !== "string" ||
        !/^[0-9a-f]{40}$/.test(project?.commit ?? "")
      ) {
        fail(
          "authoritative resolved AOSP manifest contains an invalid project",
        );
      }
      return project;
    })
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
  if (
    !identicalSnapshot(
      manifestGraph,
      resolvedGraph.map(({ commit: _commit, ...project }) => project),
    )
  ) {
    fail(
      "authoritative resolved AOSP manifest does not match the locked graph",
    );
  }
  const seenRootEntries = new Set();
  const resolvedRootEntries = resolved.rootEntries
    .map((entry) => {
      exactObjectKeys(
        entry,
        ["path", "projectPath", "sourcePath", "sourceType", "mode", "sha256"],
        "authoritative resolved AOSP manifest root entry",
      );
      if (
        !safeManifestPath(entry.path) ||
        !safeManifestPath(entry.projectPath) ||
        !safeManifestPath(entry.sourcePath) ||
        !["file", "tree"].includes(entry.sourceType) ||
        !["copy", "link"].includes(entry.mode) ||
        (entry.mode === "copy" && entry.sourceType !== "file") ||
        !/^[0-9a-f]{64}$/.test(entry.sha256 ?? "") ||
        seenRootEntries.has(entry.path)
      ) {
        fail("authoritative resolved AOSP manifest has an invalid root entry");
      }
      seenRootEntries.add(entry.path);
      return entry;
    })
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
  const derivedRootEntries = rootEntries.sort((left, right) =>
    left.path.localeCompare(right.path, "en"),
  );
  if (
    !identicalSnapshot(
      derivedRootEntries,
      resolvedRootEntries.map(
        ({ sha256: _sha256, sourceType: _sourceType, ...entry }) => entry,
      ),
    )
  ) {
    fail(
      "authoritative resolved AOSP root entries do not match manifest copy/link directives",
    );
  }
  return { projects: resolvedGraph, rootEntries: resolvedRootEntries };
}

function parseProjectStatus(projectPath, status, allowedPaths) {
  const records = status.split("\0");
  const result = [];
  for (let index = 0; index < records.length - 1; index += 1) {
    const record = records[index];
    if (record.length < 4 || record[2] !== " ") {
      fail(`git reported malformed status for AOSP project ${projectPath}`);
    }
    const code = record.slice(0, 2);
    if (code.includes("R") || code.includes("C")) {
      fail(`AOSP project contains an unsupported rename/copy: ${projectPath}`);
    }
    const relativePath = record.slice(3);
    const repositoryPath = path.posix.normalize(
      path.posix.join(projectPath, relativePath),
    );
    if (
      path.isAbsolute(relativePath) ||
      relativePath === ".." ||
      relativePath.startsWith("../") ||
      repositoryPath === ".." ||
      repositoryPath.startsWith("../") ||
      !allowedPaths.has(repositoryPath)
    ) {
      fail(`AOSP project contains an unlocked modification: ${repositoryPath}`);
    }
    result.push(`${code} ${repositoryPath}`);
  }
  return result;
}

function pathContains(parent, candidate) {
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

function isAncestorOfAny(candidate, roots) {
  return roots.some((root) => root.startsWith(`${candidate}/`));
}

function verifyManifestRootEntry(aospRoot, entry) {
  const source = path.join(aospRoot, entry.projectPath, entry.sourcePath);
  const destination = path.join(aospRoot, entry.path);
  const sourceState = fs.lstatSync(source, { throwIfNoEntry: false });
  const sourceSha256 =
    entry.sourceType === "file"
      ? sha256File(source, { allowEmpty: true })
      : sourceState?.isDirectory() && !sourceState.isSymbolicLink()
        ? hashDirectoryTree(source, path.join(aospRoot, entry.projectPath))
        : null;
  if (sourceSha256 !== entry.sha256) {
    fail(`manifest root-entry source drifted: ${entry.path}`);
  }
  const destinationState = fs.lstatSync(destination, {
    throwIfNoEntry: false,
  });
  if (entry.mode === "copy") {
    if (
      !destinationState?.isFile() ||
      destinationState.isSymbolicLink() ||
      destinationState.nlink !== 1 ||
      destinationState.size !== sourceState?.size ||
      sha256File(destination, { allowEmpty: true }) !== entry.sha256
    ) {
      fail(`manifest copyfile output drifted: ${entry.path}`);
    }
  } else {
    if (
      !destinationState?.isSymbolicLink() ||
      fs.realpathSync(destination) !== fs.realpathSync(source)
    ) {
      fail(`manifest linkfile output drifted: ${entry.path}`);
    }
  }
}

export function assertClosedAospSourceRoot({
  aospRoot,
  outRoot,
  projectPaths,
  boundTreePaths,
  rootEntries,
}) {
  const authorizedTreePaths = [...projectPaths, ...boundTreePaths];
  for (const value of authorizedTreePaths) {
    if (!safeManifestPath(value)) {
      fail(`AOSP source-root authorization contains an unsafe path: ${value}`);
    }
  }
  if (new Set(authorizedTreePaths).size !== authorizedTreePaths.length) {
    fail("AOSP source-root authorization contains duplicate paths");
  }
  const seenRootEntryPaths = new Set();
  for (const entry of rootEntries) {
    if (
      !safeManifestPath(entry?.path) ||
      !safeManifestPath(entry?.projectPath) ||
      !safeManifestPath(entry?.sourcePath) ||
      !["file", "tree"].includes(entry?.sourceType) ||
      !["copy", "link"].includes(entry?.mode) ||
      (entry.mode === "copy" && entry.sourceType !== "file") ||
      !/^[0-9a-f]{64}$/.test(entry?.sha256 ?? "") ||
      seenRootEntryPaths.has(entry.path)
    ) {
      fail("AOSP source-root authorization contains an invalid root entry");
    }
    seenRootEntryPaths.add(entry.path);
  }
  const normalizedProjects = projectPaths.map((entry) =>
    path.posix.normalize(entry),
  );
  const normalizedBoundTrees = boundTreePaths.map((entry) =>
    path.posix.normalize(entry),
  );
  const canonicalAospRoot = fs.realpathSync(aospRoot);
  if (canonicalAospRoot !== aospRoot) {
    fail("AOSP source root must be canonical");
  }
  const repoRoot = path.join(aospRoot, ".repo");
  const repoState = fs.lstatSync(repoRoot, { throwIfNoEntry: false });
  if (
    !repoState?.isDirectory() ||
    repoState.isSymbolicLink() ||
    fs.realpathSync(repoRoot) !== repoRoot
  ) {
    fail("AOSP repo metadata root must be canonical");
  }
  for (const authorizedPath of [
    ...normalizedProjects,
    ...normalizedBoundTrees,
  ]) {
    const absolute = path.join(aospRoot, authorizedPath);
    const state = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (
      !state?.isDirectory() ||
      state.isSymbolicLink() ||
      fs.realpathSync(absolute) !== absolute
    ) {
      fail(`authorized AOSP source tree is not canonical: ${authorizedPath}`);
    }
  }
  const outputFilesystemPath = existingFilesystemPath(outRoot);
  const canonicalOutRoot = fs.existsSync(outRoot)
    ? fs.realpathSync(outRoot)
    : path.join(
        fs.realpathSync(outputFilesystemPath),
        path.relative(outputFilesystemPath, outRoot),
      );
  const outRelativeNative = path.relative(canonicalAospRoot, canonicalOutRoot);
  const outRelative = outRelativeNative.split(path.sep).join("/");
  if (
    canonicalOutRoot === canonicalAospRoot ||
    canonicalAospRoot.startsWith(`${canonicalOutRoot}${path.sep}`) ||
    outRelative === ".repo" ||
    outRelative.startsWith(".repo/")
  ) {
    fail("AOSP OUT_DIR overlaps source or repo metadata");
  }
  const excludedRoots =
    outRelative &&
    outRelative !== ".." &&
    !outRelative.startsWith("../") &&
    !path.posix.isAbsolute(outRelative)
      ? [outRelative]
      : [];
  const coveredRoots = [
    ...normalizedProjects,
    ...normalizedBoundTrees,
    ...excludedRoots,
  ];
  const rootEntryPaths = rootEntries.map((entry) => entry.path);
  const allExpectedPaths = [...coveredRoots, ...rootEntryPaths];

  if (
    excludedRoots.some((outputPath) =>
      [...normalizedProjects, ...normalizedBoundTrees, ...rootEntryPaths].some(
        (sourcePath) =>
          pathContains(outputPath, sourcePath) ||
          pathContains(sourcePath, outputPath),
      ),
    )
  ) {
    fail("AOSP OUT_DIR overlaps an authorized source path");
  }

  for (const entry of rootEntries) {
    if (
      coveredRoots.some((root) => pathContains(root, entry.path)) ||
      rootEntryPaths.some(
        (other) => other !== entry.path && pathContains(other, entry.path),
      )
    ) {
      fail(
        `manifest root entry overlaps another authorized source: ${entry.path}`,
      );
    }
    verifyManifestRootEntry(aospRoot, entry);
  }

  const visit = (directory, prefix = "") => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (relative === ".repo") continue;
      const absolute = path.join(directory, entry.name);
      if (coveredRoots.includes(relative)) continue;
      if (rootEntryPaths.includes(relative)) continue;
      if (
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        isAncestorOfAny(relative, allExpectedPaths)
      ) {
        visit(absolute, relative);
        continue;
      }
      fail(`AOSP source root contains an unlocked entry: ${relative}`);
    }
  };
  visit(aospRoot);
  return {
    projectCount: normalizedProjects.length,
    boundTrees: normalizedBoundTrees,
    rootEntries: rootEntries.map(({ path: entryPath, sha256 }) => ({
      path: entryPath,
      sha256,
    })),
  };
}

function aospProjectSnapshot(aospRoot, outRoot, lock) {
  const allowedPaths = new Set(
    (lock.sourceOverlays ?? []).map(({ path: overlayPath }) =>
      path.posix.normalize(overlayPath),
    ),
  );
  const { projects: manifestProjects, rootEntries } = lockedManifestProjects(
    aospRoot,
    lock,
  );
  const expectedProjects = [
    ...manifestProjects,
    ...(lock.externalProjects ?? []).map((project) => ({
      path: project.path,
      name: project.path,
      remoteName: "origin",
      remoteUrl: project.url,
      revision: project.commit,
      expectedCommit: project.commit,
    })),
  ];
  const projects = expectedProjects.map((expected) => {
    const projectPath = expected.path;
    const projectRoot = path.join(aospRoot, projectPath);
    if (fs.realpathSync(projectRoot) !== projectRoot) {
      fail(`AOSP project path is not canonical: ${projectPath}`);
    }
    const topLevel = run("git", ["rev-parse", "--show-toplevel"], {
      cwd: projectRoot,
      capture: true,
    });
    if (fs.realpathSync(topLevel) !== projectRoot) {
      fail(`AOSP project is not rooted at its declared path: ${projectPath}`);
    }
    const commit = run("git", ["rev-parse", "HEAD"], {
      cwd: projectRoot,
      capture: true,
    });
    const expectedCommit = expected.expectedCommit ?? expected.commit;
    if (commit !== expectedCommit) {
      fail(
        `AOSP project ${projectPath} is not at its authoritative resolved commit`,
      );
    }
    const remotes = run("git", ["remote"], {
      cwd: projectRoot,
      capture: true,
    })
      .split("\n")
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right, "en"))
      .map((name) => ({
        name,
        url: run("git", ["remote", "get-url", name], {
          cwd: projectRoot,
          capture: true,
        }),
      }));
    if (
      remotes.length !== 1 ||
      remotes[0].name !== expected.remoteName ||
      remotes[0].url !== expected.remoteUrl
    ) {
      fail(
        `AOSP project remote does not match the locked manifest: ${projectPath}`,
      );
    }
    const status = run(
      "git",
      [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignored=matching",
      ],
      {
        cwd: path.join(aospRoot, projectPath),
        capture: true,
        raw: true,
      },
    );
    return {
      path: projectPath,
      name: expected.name,
      commit,
      revision: expected.revision ?? expected.commit,
      remotes,
      status: parseProjectStatus(projectPath, status, allowedPaths),
    };
  });
  const sourceRoot = assertClosedAospSourceRoot({
    aospRoot,
    outRoot,
    projectPaths: expectedProjects.map(({ path: projectPath }) => projectPath),
    boundTreePaths: ["vendor/google_devices/grizzly", "vendor/eliza"],
    rootEntries,
  });
  return { projects, sourceRoot };
}

function sourceSnapshot({ aospRoot, outRoot, elizaRoot, lock, lockPath }) {
  assertPinnedAospCheckout(aospRoot, lock);
  assertGeneratedVendorTree(aospRoot, lock);
  grizzlyLunchTarget(aospRoot, lock);
  assertGeneratedVintfApi(aospRoot, lock.device.vendorApiLevel);
  assertLockedOverlays(aospRoot, lock);
  const { projects, sourceRoot } = aospProjectSnapshot(aospRoot, outRoot, lock);
  return {
    osCommit: cleanGitCommit(repositoryRoot, "elizaOS/os"),
    elizaCommit: cleanGitCommit(elizaRoot, "elizaOS/eliza"),
    lockSha256: sha256File(lockPath),
    manifestCommit: cleanGitCommit(
      path.join(aospRoot, ".repo/manifests"),
      "AOSP manifest",
    ),
    repoImplementationCommit: cleanGitCommit(
      path.join(aospRoot, ".repo/repo"),
      "repo implementation",
    ),
    aospProjects: projects,
    aospSourceRoot: sourceRoot,
    generatedVendorSha256: hashDirectoryTree(
      path.join(aospRoot, "vendor/google_devices/grizzly"),
      aospRoot,
      [path.join(aospRoot, ".repo"), outRoot],
    ),
    elizaVendorSha256: hashDirectoryTree(
      path.join(aospRoot, "vendor/eliza"),
      aospRoot,
      [path.join(aospRoot, ".repo"), outRoot],
    ),
  };
}

function identicalSnapshot(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function trustedOutputParent(outputDir) {
  if (fs.existsSync(outputDir)) {
    fail(`output directory must not already exist: ${outputDir}`);
  }
  const parent = path.dirname(outputDir);
  if (fs.realpathSync(parent) !== parent) {
    fail("output parent path must be canonical and contain no symlink aliases");
  }
  const parentStat = fs.lstatSync(parent, { throwIfNoEntry: false });
  if (
    !parentStat?.isDirectory() ||
    parentStat.isSymbolicLink() ||
    parentStat.uid !== process.geteuid() ||
    (parentStat.mode & 0o22) !== 0
  ) {
    fail(
      "output parent must be signer-owned, non-symlink, and non-group/world-writable",
    );
  }
  return parent;
}

export function assertBundleOutputLocation({ outputDir, sourceRoots }) {
  const outputParent = trustedOutputParent(outputDir);
  for (const [sourceRoot, label] of sourceRoots) {
    assertOutputOutsideSource(outputDir, sourceRoot, label);
  }
  return outputParent;
}

function collectProductValidationReceipts(productOut, evidenceDir) {
  return REQUIRED_BUILD_RECEIPTS.map((relativePath) => {
    const source = path.join(productOut, relativePath);
    const stat = assertRegularFile(
      source,
      `AOSP verification receipt ${relativePath}`,
      true,
    );
    const filename = relativePath.replaceAll("/", "__");
    const destination = path.join(evidenceDir, filename);
    if (stat.size === 0) {
      writeExclusiveFile(destination, "");
      return {
        filename,
        sizeBytes: 0,
        sha256: createHash("sha256").digest("hex"),
      };
    }
    return {
      filename,
      ...copyVerifiedFile(source, destination, relativePath),
    };
  });
}

function runRequiredBuildGates({ aospRoot, jobs, evidenceDir, lock }) {
  const shellPrefix = `source build/envsetup.sh && lunch ${grizzlyLunchTarget(aospRoot, lock)}`;
  const gates = [
    ["droidcore", `m -j${jobs} droidcore`],
    ["dist", `m -j${jobs} dist`],
    [
      "host-init-verifier",
      `product_out="$(get_build_var PRODUCT_OUT)" && m -j${jobs} "$product_out/host_init_verifier_output.txt"`,
    ],
    ["check-vintf-all", `m -j${jobs} check-vintf-all`],
    ["host-tools", `m -j${jobs} apksigner aapt2 avbtool`],
  ];
  return gates.map(([name, command]) =>
    runWithReceipt("bash", ["-lc", `${shellPrefix} && ${command}`], {
      cwd: aospRoot,
      receiptPath: path.join(evidenceDir, `build-${name}.log`),
    }),
  );
}

function toolSnapshot(tools) {
  return Object.fromEntries(
    tools.map(([tool, label]) => {
      const stat = assertRegularFile(tool, label);
      return [
        label,
        { path: tool, sizeBytes: stat.size, sha256: sha256File(tool) },
      ];
    }),
  );
}

function writeExclusiveFile(filename, contents) {
  const descriptor = fs.openSync(
    filename,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_NOFOLLOW,
    0o644,
  );
  try {
    fs.writeFileSync(descriptor, contents);
    fs.fsyncSync(descriptor);
    const descriptorState = fs.fstatSync(descriptor);
    const pathState = fs.lstatSync(filename);
    if (
      !descriptorState.isFile() ||
      descriptorState.nlink !== 1 ||
      !sameFile(descriptorState, pathState)
    ) {
      fail(`staged output was replaced while writing: ${filename}`);
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertPrivateBundleTree(root) {
  const visit = (directory) => {
    const directoryState = fs.lstatSync(directory);
    if (
      !directoryState.isDirectory() ||
      directoryState.isSymbolicLink() ||
      directoryState.uid !== process.geteuid() ||
      (directoryState.mode & 0o077) !== 0
    ) {
      fail(`bundle staging directory is not private: ${directory}`);
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const state = fs.lstatSync(absolute);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        visit(absolute);
      } else if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        state.uid !== process.geteuid() ||
        state.nlink !== 1
      ) {
        fail(`bundle contains an unsafe entry: ${absolute}`);
      }
    }
    const descriptor = fs.openSync(
      directory,
      fs.constants.O_RDONLY |
        fs.constants.O_DIRECTORY |
        fs.constants.O_NOFOLLOW,
    );
    try {
      if (!sameInode(directoryState, fs.fstatSync(descriptor))) {
        fail(`bundle staging directory changed while syncing: ${directory}`);
      }
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  };
  visit(root);
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const configuredOut = process.env.OUT_DIR?.trim() || "out";
  const outRoot = path.isAbsolute(configuredOut)
    ? configuredOut
    : path.resolve(args.aospRoot, configuredOut);
  const builder = assertDedicatedBuilder(args.aospRoot, outRoot);
  if (args.preflightOnly) {
    process.stdout.write(
      `[grizzly-bundle] builder preflight passed: ${JSON.stringify(builder)}\n`,
    );
    return;
  }
  const generatedAt = sourceDate();
  const lockBytes = readStableFile(args.lockPath);
  const lock = loadAospLock(args.lockPath);
  let stableLock;
  try {
    stableLock = JSON.parse(lockBytes);
  } catch (error) {
    fail(`grizzly source lock is not valid JSON: ${error.message}`);
  }
  if (!identicalSnapshot(lock, stableLock)) {
    fail("grizzly source lock changed while it was being loaded");
  }
  if (lock.device?.codename !== "grizzly") fail("lock is not for grizzly");
  const lockRelativePath = path.relative(repositoryRoot, args.lockPath);
  if (
    !lockRelativePath ||
    lockRelativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(lockRelativePath)
  ) {
    fail("the grizzly lock must be a file in the clean elizaOS/os checkout");
  }
  const elizaRootValue = process.env.ELIZAOS_ELIZA_ROOT?.trim();
  if (!elizaRootValue) fail("ELIZAOS_ELIZA_ROOT is required");
  const elizaRoot = path.resolve(elizaRootValue);
  if (fs.realpathSync(args.aospRoot) !== args.aospRoot) {
    fail("AOSP root must be a canonical path without symlink aliases");
  }
  if (fs.realpathSync(elizaRoot) !== elizaRoot) {
    fail("elizaOS/eliza root must be a canonical path without symlink aliases");
  }
  const productOut = path.join(outRoot, "target/product/grizzly");
  const hostBin = path.join(outRoot, "host/linux-x86/bin");
  const outputParent = assertBundleOutputLocation({
    outputDir: args.outputDir,
    sourceRoots: [
      [repositoryRoot, "elizaOS/os"],
      [elizaRoot, "elizaOS/eliza"],
      [args.aospRoot, "AOSP"],
    ],
  });
  const before = sourceSnapshot({
    aospRoot: args.aospRoot,
    outRoot,
    elizaRoot,
    lock,
    lockPath: args.lockPath,
  });
  const builderEnvironment = captureBuilderEnvironment({
    aospRoot: args.aospRoot,
    outRoot,
    builder,
  });
  const staging = fs.mkdtempSync(path.join(outputParent, ".grizzly-bundle-"));
  fs.chmodSync(staging, 0o700);
  let published = false;
  let renamed = false;
  const stagingState = fs.lstatSync(staging);
  try {
    const evidenceDir = path.join(staging, "host-validation");
    fs.mkdirSync(evidenceDir, { mode: 0o700 });
    const buildGateReceipts = runRequiredBuildGates({
      aospRoot: args.aospRoot,
      jobs: args.jobs,
      evidenceDir,
      lock,
    });

    const apk = path.join(productOut, "system/priv-app/Eliza/Eliza.apk");
    const stagedApk = path.join(evidenceDir, "Eliza.apk");
    const apkBefore = copyVerifiedFile(
      apk,
      stagedApk,
      "platform privileged Eliza APK",
    );
    const avbtool = path.join(hostBin, "avbtool");
    const apksigner = path.join(hostBin, "apksigner");
    const aapt2 = path.join(hostBin, "aapt2");
    const verificationTools = [
      [avbtool, "built avbtool"],
      [apksigner, "built apksigner"],
      [aapt2, "built aapt2"],
    ];
    const toolsBefore = toolSnapshot(verificationTools);
    const apkEntries = run("unzip", ["-Z1", stagedApk], {
      capture: true,
      stdoutOnly: true,
    }).split("\n");
    assertApkProvenanceEntries(apkEntries);
    const apkProvenance = verifyApkProvenance(
      stagedApk,
      apkEntries,
      before.elizaCommit,
      evidenceDir,
    );
    const apkSignatureReceipt = run(
      apksigner,
      ["verify", "--verbose", "--print-certs", stagedApk],
      { capture: true },
    );
    const apkBadgingReceipt = run(aapt2, ["dump", "badging", stagedApk], {
      capture: true,
    });
    if (!/^package: name='ai\.elizaos\.app'(?:\s|$)/m.test(apkBadgingReceipt)) {
      fail("privileged APK package name is not ai.elizaos.app");
    }
    const platformCertificate = path.join(
      args.aospRoot,
      "build/make/target/product/security/platform.x509.pem",
    );
    const expectedPlatformCertificateSha256 =
      certificateSha256(platformCertificate);
    const apkCertificateSha256 = apkSignerSha256(apkSignatureReceipt);
    if (apkCertificateSha256 !== expectedPlatformCertificateSha256) {
      fail(
        "privileged APK is not signed by the checked-out AOSP platform certificate",
      );
    }
    const apkAfter = {
      sizeBytes: assertRegularFile(stagedApk, "staged privileged Eliza APK")
        .size,
      sha256: sha256File(stagedApk),
    };
    if (!identicalSnapshot(apkBefore, apkAfter)) {
      fail("privileged APK changed while provenance was being verified");
    }

    const androidInfo = readStableFile(
      path.join(productOut, "android-info.txt"),
    ).toString("utf8");
    const fastbootInfo = readStableFile(
      path.join(productOut, "fastboot-info.txt"),
    ).toString("utf8");
    const flashMetadata = assertSafeFlashMetadata({
      androidInfo,
      fastbootInfo,
    });
    const artifactFilenames = [
      ...new Set([...REQUIRED_GRIZZLY_ARTIFACTS, ...flashMetadata.artifacts]),
    ];
    const artifactsBefore = artifactSourceSnapshot(
      productOut,
      artifactFilenames,
    );
    const verifiedVbmetaImages = artifactFilenames.filter((filename) =>
      /^vbmeta(?:_[A-Za-z0-9._+-]+)?\.img$/.test(filename),
    );
    const avbAuthorizations = new Map(
      (lock.avbVerification ?? []).map((entry) => [entry.image, entry]),
    );
    if (
      avbAuthorizations.size !== verifiedVbmetaImages.length ||
      verifiedVbmetaImages.some((filename) => !avbAuthorizations.has(filename))
    ) {
      fail(
        "every referenced vbmeta image must have exactly one locked AVB key authorization",
      );
    }
    const avbKeyEvidence = Object.fromEntries(
      verifiedVbmetaImages.map((filename) => {
        const authorization = avbAuthorizations.get(filename);
        const keyPath = path.join(args.aospRoot, authorization.keyPath);
        const keySha256 = sha256File(keyPath);
        if (keySha256 !== authorization.keySha256) {
          fail(`locked AVB verification key drifted for ${filename}`);
        }
        return [
          filename,
          {
            keyPath: authorization.keyPath,
            keySha256,
            authorization: authorization.authorization,
          },
        ];
      }),
    );
    const sourceManifest = path.join(staging, "aosp-source-snapshot.json");
    writeExclusiveFile(sourceManifest, `${JSON.stringify(before, null, 2)}\n`);
    const artifacts = collectGrizzlyArtifacts({
      productOut,
      bundleDir: path.join(staging, "flash"),
    });
    if (
      !identicalSnapshot(
        artifactsBefore,
        artifactSourceSnapshot(productOut, artifactFilenames),
      )
    ) {
      fail("build artifacts changed while the bundle was being collected");
    }
    const avbReceipts = Object.fromEntries(
      verifiedVbmetaImages.map((filename) => [
        filename,
        [
          "## info_image",
          run(
            avbtool,
            ["info_image", "--image", path.join(staging, "flash", filename)],
            { capture: true },
          ),
          "## verify_image",
          run(
            avbtool,
            [
              "verify_image",
              "--image",
              path.join(staging, "flash", filename),
              "--key",
              path.join(args.aospRoot, avbAuthorizations.get(filename).keyPath),
              ...(filename === "vbmeta.img"
                ? ["--follow_chain_partitions"]
                : []),
            ],
            { capture: true },
          ),
        ].join("\n"),
      ]),
    );
    const productValidationReceipts = collectProductValidationReceipts(
      productOut,
      evidenceDir,
    );
    writeExclusiveFile(
      path.join(staging, "host-validation/avbtool-vbmeta.txt"),
      `${Object.entries(avbReceipts)
        .map(([filename, receipt]) => `## ${filename}\n${receipt}`)
        .join("\n\n")}\n`,
    );
    writeExclusiveFile(
      path.join(staging, "host-validation/apksigner.txt"),
      `${apkSignatureReceipt}\n`,
    );
    writeExclusiveFile(
      path.join(staging, "host-validation/aapt2-badging.txt"),
      `${apkBadgingReceipt}\n`,
    );
    if (!identicalSnapshot(toolsBefore, toolSnapshot(verificationTools))) {
      fail(
        "AOSP verification tools changed while the bundle was being validated",
      );
    }

    // build/make/core/config.mk emits this canonical product fingerprint and
    // gen_build_prop.py consumes it. system/build.prop instead identifies the
    // generic system partition; init derives the overall property at boot.
    const buildFingerprintFilename =
      "build_fingerprint-eliza_grizzly_phone.txt";
    const buildFingerprint = parseGrizzlyBuildFingerprint(
      readStableFile(path.join(evidenceDir, buildFingerprintFilename)).toString(
        "utf8",
      ),
      lock.device.expectedFingerprintPrefix,
    );
    const manifest = {
      schemaVersion: 1,
      generatedAt,
      target: {
        targetId: lock.device.targetId,
        codename: lock.device.codename,
        productName: lock.device.productName,
        stockBuildId: lock.device.buildId,
        buildFingerprint,
        buildFingerprintSource: `host-validation/${buildFingerprintFilename}`,
      },
      builderEnvironment,
      sources: {
        osCommit: before.osCommit,
        elizaCommit: before.elizaCommit,
        lockFile: lockRelativePath,
        lockSha256: before.lockSha256,
        manifestCommit: before.manifestCommit,
        repoImplementationCommit: before.repoImplementationCommit,
        aospSourceSnapshot: path.basename(sourceManifest),
        aospSourceSnapshotSha256: sha256File(sourceManifest),
        aospProjectCount: before.aospProjects.length,
        generatedVendorSha256: before.generatedVendorSha256,
        elizaVendorSha256: before.elizaVendorSha256,
      },
      privilegedApk: {
        path: "system/priv-app/Eliza/Eliza.apk",
        retainedPath: "host-validation/Eliza.apk",
        ...apkAfter,
        packageName: "ai.elizaos.app",
        certificateSha256: apkCertificateSha256,
        provenance: apkProvenance,
      },
      artifacts,
      hostValidation: {
        buildGateReceipts,
        productValidationReceipts,
        avb: "host-validation/avbtool-vbmeta.txt",
        apkSignature: "host-validation/apksigner.txt",
        apkBadging: "host-validation/aapt2-badging.txt",
        completedBuildTargets: [
          "droidcore",
          "dist",
          "host_init_verifier",
          "check-vintf-all",
          "apksigner",
          "aapt2",
          "avbtool",
        ],
        collectionMode: "built-and-verified-in-this-invocation",
        verificationTools: toolsBefore,
        verifiedVbmetaImages,
        avbKeyEvidence,
        flashMetadata,
      },
      physicalDevice: "pending",
    };
    const manifestPath = path.join(staging, "grizzly-bundle-manifest.json");
    writeExclusiveFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    writeExclusiveFile(
      path.join(staging, "android-contract-candidate.json"),
      `${JSON.stringify(contractCandidate(manifest), null, 2)}\n`,
    );
    const checksumEntries = [];
    const addTree = (directory, prefix = "") => {
      for (const entry of fs
        .readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name, "en"))) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        const absolute = path.join(directory, entry.name);
        if (relative === "SHA256SUMS") continue;
        if (entry.isDirectory()) addTree(absolute, relative);
        else if (entry.isFile()) {
          checksumEntries.push(
            `${sha256File(absolute, { allowEmpty: true })}  ${relative}`,
          );
        } else fail(`bundle contains a non-regular entry: ${relative}`);
      }
    };
    addTree(staging);
    writeExclusiveFile(
      path.join(staging, "SHA256SUMS"),
      `${checksumEntries.join("\n")}\n`,
    );
    const after = sourceSnapshot({
      aospRoot: args.aospRoot,
      outRoot,
      elizaRoot,
      lock,
      lockPath: args.lockPath,
    });
    if (!identicalSnapshot(before, after)) {
      fail("source inputs changed while the bundle was being produced");
    }
    if (
      !identicalSnapshot(apkBefore, {
        sizeBytes: assertRegularFile(apk, "platform privileged Eliza APK").size,
        sha256: sha256File(apk),
      })
    ) {
      fail("privileged APK changed while the bundle was being produced");
    }
    assertPrivateBundleTree(staging);
    if (fs.existsSync(args.outputDir)) {
      fail(`output directory appeared before publication: ${args.outputDir}`);
    }
    const currentStagingState = fs.lstatSync(staging);
    if (!sameInode(stagingState, currentStagingState)) {
      fail("bundle staging directory changed before publication");
    }
    run("/usr/bin/mv", [
      "--no-clobber",
      "--no-target-directory",
      staging,
      args.outputDir,
    ]);
    renamed = !fs.lstatSync(staging, { throwIfNoEntry: false });
    const outputState = fs.lstatSync(args.outputDir, { throwIfNoEntry: false });
    if (!outputState || !sameInode(stagingState, outputState)) {
      fail(
        "published bundle identity does not match its verified staging directory",
      );
    }
    const parentDescriptor = fs.openSync(
      outputParent,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY,
    );
    fs.fsyncSync(parentDescriptor);
    fs.closeSync(parentDescriptor);
    published = true;
    process.stdout.write(`[grizzly-bundle] complete: ${args.outputDir}\n`);
  } finally {
    if (!published) {
      const cleanupPath = renamed ? args.outputDir : staging;
      const cleanupState = fs.lstatSync(cleanupPath, { throwIfNoEntry: false });
      if (cleanupState && sameInode(stagingState, cleanupState)) {
        fs.rmSync(cleanupPath, { recursive: true, force: true });
      }
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

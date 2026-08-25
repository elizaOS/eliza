#!/usr/bin/env node
/**
 * Verifies the Linux desktop distribution boundary around Electrobun's native
 * artifact. The pinned CEF wrapper disables Chromium's process sandboxes, so a
 * direct artifact can never satisfy a renderer-sandboxed claim; the supported
 * confined distribution is the exact-permission Flatpak outer sandbox.
 */

import { execFileSync } from "node:child_process";
import {
  closeSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statfsSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const GIB = 1024n ** 3n;
const REQUIRED_CEF_SWITCHES = ["disable-gpu-sandbox", "no-sandbox"];
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
const EXACT_FLATPAK_PERMISSIONS = {
  command: "eliza",
  devices: ["dri"],
  shared: ["ipc", "network"],
  sockets: ["fallback-x11", "pulseaudio", "wayland"],
};

/**
 * The pinned Electrobun 1.18.1 Linux native wrapper already requires
 * GLIBC_2.38. Direct packages cannot promise an older baseline until that
 * wrapper is rebuilt; no other packaged ELF may silently raise the floor.
 */
export const MAX_PACKAGED_GLIBC_VERSION = "2.38";

export const LINUX_DISTRIBUTION_CLAIMS = {
  DEVELOPMENT_DIRECT: "development-direct",
  FLATPAK_OUTER_SANDBOX: "flatpak-outer-sandbox",
  PRODUCTION_DIRECT: "production-direct",
  PRODUCTION_RENDERER_SANDBOXED: "production-renderer-sandboxed",
};

/** Typed failure for an unprovable Linux distribution or sandbox claim. */
export class LinuxDistributionContractError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "LinuxDistributionContractError";
  }
}

function fail(message) {
  throw new LinuxDistributionContractError(message);
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function equalStringSets(actual, expected) {
  return JSON.stringify(sorted(actual)) === JSON.stringify(sorted(expected));
}

function assertRegularFile(filePath, label) {
  let stats;
  try {
    stats = lstatSync(filePath);
  } catch (error) {
    throw new LinuxDistributionContractError(`missing ${label}: ${filePath}`, {
      cause: error,
    });
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    fail(`${label} must be a regular non-symlink file: ${filePath}`);
  }
  return stats;
}

function assertExecutable(filePath, label) {
  const stats = assertRegularFile(filePath, label);
  if ((stats.mode & 0o111) === 0) {
    fail(`${label} is not executable: ${filePath}`);
  }
  return stats;
}

function findLauncher(buildDir) {
  const candidates = [
    path.join(buildDir, "bin", "launcher"),
    ...readdirSync(buildDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(buildDir, entry.name, "bin", "launcher")),
  ];
  const launcher = candidates.find((candidate) => {
    try {
      return lstatSync(candidate).isFile();
    } catch {
      // error-policy:J3 candidate discovery treats an absent path as no match.
      return false;
    }
  });
  if (!launcher) fail(`missing Electrobun bin/launcher under ${buildDir}`);
  assertExecutable(launcher, "Electrobun launcher");
  return launcher;
}

function scanTree(rootDir) {
  const canonicalRoot = realpathSync(rootDir);
  const pending = [canonicalRoot];
  let allocatedBytes = 0n;
  let entryCount = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      entryCount += 1;
      if (entryCount > 250_000) {
        fail("Linux desktop build contains more than 250000 entries");
      }
      const entryPath = path.join(directory, entry.name);
      const stats = lstatSync(entryPath);
      // POSIX symlink modes are conventionally 0777 and do not control target
      // access; validate their resolved target below instead.
      if (!stats.isSymbolicLink() && (stats.mode & 0o022) !== 0) {
        fail(`group/world-writable build entry: ${entryPath}`);
      }
      if (stats.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (stats.isFile()) {
        allocatedBytes += BigInt(stats.blocks) * 512n;
        continue;
      }
      if (stats.isSymbolicLink()) {
        let target;
        try {
          target = realpathSync(entryPath);
        } catch (error) {
          throw new LinuxDistributionContractError(
            `broken build symlink: ${entryPath}`,
            { cause: error },
          );
        }
        if (
          target !== canonicalRoot &&
          !target.startsWith(`${canonicalRoot}${path.sep}`)
        ) {
          fail(`build symlink escapes the artifact: ${entryPath}`);
        }
        const targetStats = statSync(entryPath);
        if (!targetStats.isFile()) {
          fail(`build symlink must resolve to a regular file: ${entryPath}`);
        }
        // Flatpak staging dereferences build symlinks, so count the target once
        // more to model the actual copy size instead of only the source inode.
        allocatedBytes += BigInt(targetStats.blocks) * 512n;
        continue;
      }
      fail(`unsupported socket, device, or FIFO in build: ${entryPath}`);
    }
  }
  return { allocatedBytes, entryCount };
}

function binaryContainsAscii(filePath, value) {
  return readFileSync(filePath).includes(Buffer.from(value, "ascii"));
}

function isElfFile(filePath) {
  const descriptor = openSync(filePath, "r");
  try {
    const header = Buffer.alloc(ELF_MAGIC.length);
    return (
      readSync(descriptor, header, 0, header.length, 0) === header.length &&
      header.equals(ELF_MAGIC)
    );
  } finally {
    closeSync(descriptor);
  }
}

function compareVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

/** Extracts public numeric GLIBC requirements and rejects private/named ABI use. */
export function parseGlibcRequirements(versionInfo) {
  const markers = [
    ...new Set(versionInfo.match(/\bGLIBC_[A-Za-z0-9_.]+\b/g) ?? []),
  ].sort();
  const unsupportedMarkers = markers.filter(
    (marker) => !/^GLIBC_\d+(?:\.\d+)+$/.test(marker),
  );
  const versions = markers
    .filter((marker) => /^GLIBC_\d+(?:\.\d+)+$/.test(marker))
    .map((marker) => marker.slice("GLIBC_".length))
    .sort(compareVersions);
  return {
    maxVersion: versions.at(-1) ?? null,
    unsupportedMarkers,
    versions,
  };
}

function defaultReadelfVersionInfo(filePath) {
  try {
    return execFileSync("readelf", ["-W", "--version-info", filePath], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new LinuxDistributionContractError(
      `readelf could not audit packaged ELF: ${filePath}`,
      { cause: error },
    );
  }
}

/**
 * Finds every ELF by magic bytes rather than filename, including native
 * modules and lazy-loaded inference libraries nested anywhere in Resources.
 */
export function inspectPackagedGlibcCompatibility(
  buildDir,
  {
    maxVersion = MAX_PACKAGED_GLIBC_VERSION,
    readelfVersionInfo = defaultReadelfVersionInfo,
  } = {},
) {
  if (!/^\d+(?:\.\d+)+$/.test(maxVersion)) {
    fail(`invalid maximum packaged GLIBC version: ${maxVersion}`);
  }
  const canonicalRoot = realpathSync(buildDir);
  const pending = [canonicalRoot];
  const elfFiles = [];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if ((entry.isFile() || entry.isSymbolicLink()) && isElfFile(entryPath)) {
        elfFiles.push(entryPath);
      }
    }
  }
  if (elfFiles.length === 0) {
    fail(`Linux desktop build contains no ELF files: ${canonicalRoot}`);
  }

  const files = elfFiles
    .sort((left, right) => left.localeCompare(right))
    .map((filePath) => {
      const requirements = parseGlibcRequirements(readelfVersionInfo(filePath));
      return {
        maxVersion: requirements.maxVersion,
        path: path.relative(canonicalRoot, filePath),
        unsupportedMarkers: requirements.unsupportedMarkers,
      };
    });
  const violations = files.filter(
    (file) =>
      file.unsupportedMarkers.length > 0 ||
      (file.maxVersion !== null &&
        compareVersions(file.maxVersion, maxVersion) > 0),
  );
  if (violations.length > 0) {
    fail(
      `packaged ELF GLIBC requirements exceed the supported GLIBC_${maxVersion} ceiling: ${violations
        .map((file) => {
          const requirements = [
            file.maxVersion === null ? null : `GLIBC_${file.maxVersion}`,
            ...file.unsupportedMarkers,
          ].filter(Boolean);
          return `${file.path} (${requirements.join(", ")})`;
        })
        .join("; ")}`,
    );
  }
  const maxRequiredVersion = files
    .map((file) => file.maxVersion)
    .filter((version) => version !== null)
    .sort(compareVersions)
    .at(-1);
  return {
    elfFileCount: files.length,
    files,
    maxAllowedVersion: maxVersion,
    maxRequiredVersion: maxRequiredVersion ?? null,
  };
}

/** Inspects the real packaged tree without treating CEF file presence as sandbox proof. */
export function inspectLinuxDesktopBuild(buildDir, glibcAuditOptions) {
  const canonicalBuildDir = realpathSync(buildDir);
  const launcher = findLauncher(canonicalBuildDir);
  const { allocatedBytes, entryCount } = scanTree(canonicalBuildDir);
  const glibcCompatibility = inspectPackagedGlibcCompatibility(
    canonicalBuildDir,
    glibcAuditOptions,
  );
  const nativeWrapper = path.join(canonicalBuildDir, "bin/libNativeWrapper.so");
  assertRegularFile(nativeWrapper, "Linux native wrapper");

  const cefLibrary = path.join(canonicalBuildDir, "bin/cef/libcef.so");
  const hasCef = (() => {
    try {
      return lstatSync(cefLibrary).isFile();
    } catch {
      // error-policy:J3 renderer detection records an explicit non-CEF result.
      return false;
    }
  })();
  const unsafeCefSwitches = hasCef
    ? REQUIRED_CEF_SWITCHES.filter((flag) =>
        binaryContainsAscii(nativeWrapper, flag),
      )
    : [];
  let chromeSandbox = null;
  if (hasCef) {
    const chromeSandboxPath = path.join(
      canonicalBuildDir,
      "bin/chrome-sandbox",
    );
    const chromeSandboxStats = assertExecutable(
      chromeSandboxPath,
      "CEF chrome-sandbox helper",
    );
    chromeSandbox = {
      path: chromeSandboxPath,
      mode: chromeSandboxStats.mode & 0o7777,
      setuidRootCapable:
        (chromeSandboxStats.mode & 0o4000) !== 0 &&
        chromeSandboxStats.uid === 0,
    };
    if (!equalStringSets(unsafeCefSwitches, REQUIRED_CEF_SWITCHES)) {
      fail(
        "CEF wrapper sandbox posture is unknown: the pinned unsafe-switch markers changed; audit upstream native source before distributing",
      );
    }
  }

  return {
    allocatedBytes,
    buildDir: canonicalBuildDir,
    chromeSandbox,
    entryCount,
    glibcCompatibility,
    hasCef,
    launcher,
    rendererProcessSandboxed: false,
    unsafeCefSwitches,
  };
}

function finishArgValue(finishArgs, prefix) {
  return finishArgs
    .filter((arg) => arg.startsWith(prefix))
    .map((arg) => arg.slice(prefix.length));
}

/** Requires the exact reviewed Flatpak grants; additions fail closed. */
export function assertFlatpakFinishArgs(finishArgs) {
  const actual = {
    commands: finishArgValue(finishArgs, "--command="),
    devices: finishArgValue(finishArgs, "--device="),
    shared: finishArgValue(finishArgs, "--share="),
    sockets: finishArgValue(finishArgs, "--socket="),
  };
  const recognized = finishArgs.filter(
    (arg) =>
      arg.startsWith("--command=") ||
      arg.startsWith("--device=") ||
      arg.startsWith("--share=") ||
      arg.startsWith("--socket="),
  );
  if (recognized.length !== finishArgs.length) {
    fail(
      `unreviewed Flatpak permission arguments: ${finishArgs
        .filter((arg) => !recognized.includes(arg))
        .join(", ")}`,
    );
  }
  if (
    actual.commands.length !== 1 ||
    actual.commands[0] !== EXACT_FLATPAK_PERMISSIONS.command
  ) {
    fail(`Flatpak command must be ${EXACT_FLATPAK_PERMISSIONS.command}`);
  }
  for (const key of ["devices", "shared", "sockets"]) {
    if (!equalStringSets(actual[key], EXACT_FLATPAK_PERMISSIONS[key])) {
      fail(
        `Flatpak ${key} must equal ${EXACT_FLATPAK_PERMISSIONS[key].join(",")}; found ${actual[key].join(",")}`,
      );
    }
  }
  return actual;
}

function parseKeyFile(contents) {
  const groups = new Map();
  let current = null;
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const group = line.match(/^\[([^\]]+)]$/)?.[1];
    if (group) {
      current = new Map();
      groups.set(group, current);
      continue;
    }
    const separator = line.indexOf("=");
    if (!current || separator < 1) fail("malformed Flatpak metadata");
    current.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return groups;
}

function metadataList(value) {
  return value ? value.split(";").filter(Boolean) : [];
}

/** Verifies build-finish output rather than trusting the requested arguments. */
export function assertFinalizedFlatpakMetadata(
  metadataPath,
  { runtimeRef, sdkRef, appId = "ai.elizaos.app" },
) {
  assertRegularFile(metadataPath, "finalized Flatpak metadata");
  const groups = parseKeyFile(readFileSync(metadataPath, "utf8"));
  const application = groups.get("Application");
  const context = groups.get("Context");
  if (!application || !context) fail("Flatpak metadata lacks required groups");
  const unexpectedGroups = [...groups.keys()].filter(
    (group) => group !== "Application" && group !== "Context",
  );
  if (unexpectedGroups.length > 0) {
    fail(
      `finalized Flatpak metadata has unreviewed groups: ${unexpectedGroups.join(", ")}`,
    );
  }
  if (application.get("name") !== appId) {
    fail(`finalized Flatpak application ID is not ${appId}`);
  }
  if (application.get("command") !== EXACT_FLATPAK_PERMISSIONS.command) {
    fail("finalized Flatpak command does not match the reviewed contract");
  }
  if (application.get("runtime") !== runtimeRef) {
    fail(`finalized Flatpak runtime is not ${runtimeRef}`);
  }
  if (application.get("sdk") !== sdkRef) {
    fail(`finalized Flatpak SDK is not ${sdkRef}`);
  }
  const allowedContextKeys = new Set(["devices", "shared", "sockets"]);
  const unexpectedContextKeys = [...context.keys()].filter(
    (key) => !allowedContextKeys.has(key),
  );
  if (unexpectedContextKeys.length > 0) {
    fail(
      `finalized Flatpak metadata has unreviewed context keys: ${unexpectedContextKeys.join(", ")}`,
    );
  }
  for (const key of ["devices", "shared", "sockets"]) {
    const actual = metadataList(context.get(key));
    if (!equalStringSets(actual, EXACT_FLATPAK_PERMISSIONS[key])) {
      fail(`finalized Flatpak ${key} differ from the reviewed contract`);
    }
  }
  return { appId, runtimeRef, sdkRef };
}

/** Proves only the named distribution claim and never upgrades outer isolation to renderer isolation. */
export function assertLinuxDistributionClaim({
  buildDir,
  claim,
  finishArgs = [],
  glibcAuditOptions,
}) {
  const inspection = inspectLinuxDesktopBuild(buildDir, glibcAuditOptions);
  if (claim === LINUX_DISTRIBUTION_CLAIMS.DEVELOPMENT_DIRECT) {
    return inspection;
  }
  if (claim === LINUX_DISTRIBUTION_CLAIMS.PRODUCTION_DIRECT) {
    return inspection;
  }
  if (claim === LINUX_DISTRIBUTION_CLAIMS.PRODUCTION_RENDERER_SANDBOXED) {
    fail(
      "the pinned Electrobun Linux CEF wrapper disables Chromium's renderer and GPU sandboxes; direct artifacts cannot claim production renderer sandboxing",
    );
  }
  if (claim === LINUX_DISTRIBUTION_CLAIMS.FLATPAK_OUTER_SANDBOX) {
    assertFlatpakFinishArgs(finishArgs);
    return inspection;
  }
  fail(`unknown Linux distribution claim: ${String(claim)}`);
}

/** Additional free bytes required for independent staging, OSTree export, and bundle output. */
export function requiredFlatpakFreeBytes(allocatedBuildBytes) {
  return allocatedBuildBytes * 3n + GIB;
}

/** Stops before a multi-gigabyte copy when the target filesystem is too full. */
export function assertFlatpakPackagingSpace(
  buildDir,
  targetDir,
  knownInspection,
) {
  const inspection = knownInspection ?? inspectLinuxDesktopBuild(buildDir);
  if (inspection.buildDir !== realpathSync(buildDir)) {
    fail(
      "Flatpak disk preflight inspection does not match the build directory",
    );
  }
  const filesystem = statfsSync(targetDir, { bigint: true });
  const availableBytes = filesystem.bavail * filesystem.bsize;
  const requiredBytes = requiredFlatpakFreeBytes(inspection.allocatedBytes);
  if (availableBytes < requiredBytes) {
    fail(
      `insufficient Flatpak packaging space: build copy size ${inspection.allocatedBytes} bytes requires at least ${requiredBytes} free bytes (3 independent copies plus 1 GiB reserve), but ${availableBytes} bytes are available at ${targetDir}`,
    );
  }
  return { availableBytes, requiredBytes, ...inspection };
}

function parseArgs(argv) {
  return new Map(
    argv.map((arg) => {
      const [key, ...rest] = arg.replace(/^--/, "").split("=");
      return [key, rest.join("=") || "true"];
    }),
  );
}

function latestLinuxBuildDir() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const buildRoot = path.join(scriptDir, "../platforms/electrobun/build");
  const candidates = readdirSync(buildRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /linux/i.test(entry.name))
    .flatMap((entry) => {
      const platformDir = path.join(buildRoot, entry.name);
      return readdirSync(platformDir, { withFileTypes: true })
        .filter((child) => child.isDirectory())
        .map((child) => path.join(platformDir, child.name));
    })
    .filter((candidate) => {
      try {
        return statSync(candidate).isDirectory();
      } catch {
        // error-policy:J3 a disappearing build candidate is not selected.
        return false;
      }
    })
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  if (!candidates[0])
    fail(`no Linux Electrobun build found under ${buildRoot}`);
  return candidates[0];
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const buildDir = args.get("build-dir") ?? latestLinuxBuildDir();
  const claim =
    args.get("claim") ?? LINUX_DISTRIBUTION_CLAIMS.FLATPAK_OUTER_SANDBOX;
  const finishArgs =
    claim === LINUX_DISTRIBUTION_CLAIMS.FLATPAK_OUTER_SANDBOX
      ? [
          "--command=eliza",
          "--share=network",
          "--share=ipc",
          "--socket=wayland",
          "--socket=fallback-x11",
          "--socket=pulseaudio",
          "--device=dri",
        ]
      : [];
  const result = assertLinuxDistributionClaim({ buildDir, claim, finishArgs });
  const json = {
    ...result,
    allocatedBytes: result.allocatedBytes.toString(),
    claim,
  };
  process.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    main();
  } catch (error) {
    // error-policy:J1 CLI boundary emits one actionable contract failure.
    process.stderr.write(
      `[linux-distribution-contract] ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  }
}

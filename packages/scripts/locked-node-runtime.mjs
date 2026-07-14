/**
 * Provisions repository-pinned Linux Node.js distributions for self-contained
 * system packages. Architecture-specific archives are content-verified and
 * fully inspected in sibling staging directories before one atomic rename
 * makes the runtime visible to the package builder.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

export const LOCKED_NODE_VERSION = "24.15.0";

function lockedNodeArtifact(architecture, archive, executable) {
  const platform = `linux-${architecture}`;
  return Object.freeze({
    platform,
    architecture,
    archive: Object.freeze({
      name: `node-v${LOCKED_NODE_VERSION}-${platform}.tar.xz`,
      rootDirectory: `node-v${LOCKED_NODE_VERSION}-${platform}`,
      url: `https://nodejs.org/dist/v${LOCKED_NODE_VERSION}/node-v${LOCKED_NODE_VERSION}-${platform}.tar.xz`,
      ...archive,
    }),
    executable: Object.freeze({ path: "bin/node", ...executable }),
  });
}

export const LOCKED_NODE_ARTIFACTS = Object.freeze({
  "linux-x64": lockedNodeArtifact(
    "x64",
    {
      size: 31_164_460,
      sha256:
        "472655581fb851559730c48763e0c9d3bc25975c59d518003fc0849d3e4ba0f6",
    },
    {
      size: 122_889_056,
      sha256:
        "d1de76d8edf2fededf6f8b30d244e2c0529ac607923a018283b77e9c74bd932c",
    },
  ),
  "linux-arm64": lockedNodeArtifact(
    "arm64",
    {
      size: 30_108_656,
      sha256:
        "f3d5a797b5d210ce8e2cb265544c8e482eaedcb8aa409a8b46da7e8595d0dda0",
    },
    {
      size: 120_702_160,
      sha256:
        "d0b9f94a9771bba3c30a54f0aee622fa0bee37be684cc1df6da2d3448606d98d",
    },
  ),
});

/** Select the content lock for a native Linux packaging host. */
export function selectLockedNodeArtifact(platform, architecture) {
  const target = `${platform}-${architecture}`;
  const artifact = LOCKED_NODE_ARTIFACTS[target];
  if (artifact === undefined) {
    throw new Error(
      `The locked Node.js runtime supports only Linux x64 and arm64, received ${platform} ${architecture}`,
    );
  }
  return artifact;
}

const LOCKED_NODE_X64_ARTIFACT = LOCKED_NODE_ARTIFACTS["linux-x64"];
export const LOCKED_NODE_PLATFORM = LOCKED_NODE_X64_ARTIFACT.platform;
export const LOCKED_NODE_ARCHIVE = LOCKED_NODE_X64_ARTIFACT.archive;
export const LOCKED_NODE_EXECUTABLE = LOCKED_NODE_X64_ARTIFACT.executable;
export const LOCKED_NODE_SOURCE = Object.freeze({
  url: `https://nodejs.org/dist/v${LOCKED_NODE_VERSION}/node-v${LOCKED_NODE_VERSION}.tar.xz`,
  sha256: "a4f653d79ed140aaad921e8c22a3b585ca85cfdab80d4030f6309e4663a8a1c8",
});

const MODULE_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(MODULE_PATH), "../..");
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1_000;
const ARCHIVE_TIMEOUT_MS = 2 * 60 * 1_000;
const PROCESS_OUTPUT_LIMIT = 32 * 1024 * 1024;

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assertRegularFile(path, label) {
  const status = lstatSync(path, { throwIfNoEntry: false });
  if (status === undefined) {
    throw new Error(`${label} does not exist: ${path}`);
  }
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new Error(`${label} is not a regular file: ${path}`);
  }
  return status;
}

function assertContained(root, candidate, label) {
  const path = relative(root, candidate);
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error(`${label} escapes the staging root: ${candidate}`);
  }
}

function runChecked(command, args, options, label) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: PROCESS_OUTPUT_LIMIT,
    ...options,
  });
  if (result.error) {
    // error-policy:J2 retain the process failure while identifying the artifact operation.
    throw new Error(`${label} could not run`, { cause: result.error });
  }
  if (result.signal) {
    throw new Error(`${label} was terminated by ${result.signal}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${label} exited ${String(result.status)}\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout;
}

function verifyArchive(path, artifact) {
  const status = assertRegularFile(path, "Node.js archive");
  if (status.size !== artifact.size) {
    throw new Error(
      `Node.js archive size mismatch: expected ${artifact.size}, received ${status.size}`,
    );
  }
  const digest = sha256(path);
  if (digest !== artifact.sha256) {
    throw new Error(
      `Node.js archive SHA-256 mismatch: expected ${artifact.sha256}, received ${digest}`,
    );
  }
}

function validateArchiveEntries(listing, rootDirectory) {
  const entries = listing.split("\n").filter((entry) => entry.length > 0);
  if (entries.length === 0) {
    throw new Error("Node.js archive contains no entries");
  }
  for (const entry of entries) {
    const normalizedEntry = entry.endsWith("/") ? entry.slice(0, -1) : entry;
    const segments = normalizedEntry.split("/");
    if (
      normalizedEntry.length === 0 ||
      normalizedEntry.startsWith("/") ||
      normalizedEntry.includes("\\") ||
      segments.some(
        (segment) => segment === "" || segment === "." || segment === "..",
      ) ||
      posix.normalize(normalizedEntry) !== normalizedEntry
    ) {
      throw new Error(
        `Unsafe path in Node.js archive: ${JSON.stringify(entry)}`,
      );
    }
    if (
      normalizedEntry !== rootDirectory &&
      !normalizedEntry.startsWith(`${rootDirectory}/`)
    ) {
      throw new Error(
        `Node.js archive entry has unexpected root: ${JSON.stringify(entry)}`,
      );
    }
  }
  if (!entries.some((entry) => entry.replace(/\/$/, "") === rootDirectory)) {
    throw new Error(
      `Node.js archive is missing its ${JSON.stringify(rootDirectory)} root entry`,
    );
  }
}

function listArchive(archivePath) {
  return runChecked(
    "tar",
    ["--list", "--xz", "--file", archivePath],
    { timeout: ARCHIVE_TIMEOUT_MS },
    "Node.js archive listing",
  );
}

function extractArchive(archivePath, payloadRoot) {
  runChecked(
    "tar",
    [
      "--extract",
      "--xz",
      "--file",
      archivePath,
      "--directory",
      payloadRoot,
      "--strip-components=1",
      "--no-same-owner",
      "--same-permissions",
      "--delay-directory-restore",
    ],
    { timeout: ARCHIVE_TIMEOUT_MS },
    "Node.js archive extraction",
  );
}

function assertExtractedTree(payloadRoot) {
  const canonicalRoot = realpathSync(payloadRoot);
  const pending = [canonicalRoot];
  let entryCount = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const name of readdirSync(directory)) {
      entryCount += 1;
      const path = join(directory, name);
      const status = lstatSync(path);
      if (status.isSymbolicLink()) {
        const target = readlinkSync(path);
        if (isAbsolute(target)) {
          throw new Error(
            `Absolute symlink in Node.js runtime: ${path} -> ${target}`,
          );
        }
        const lexicalTarget = resolve(dirname(path), target);
        assertContained(
          canonicalRoot,
          lexicalTarget,
          "Node.js runtime symlink",
        );
        let canonicalTarget;
        try {
          canonicalTarget = realpathSync(path);
        } catch (error) {
          // error-policy:J2 retain the filesystem cause while identifying the invalid link.
          throw new Error(
            `Broken symlink in Node.js runtime: ${path} -> ${target}`,
            {
              cause: error,
            },
          );
        }
        assertContained(
          canonicalRoot,
          canonicalTarget,
          "Node.js runtime symlink",
        );
      } else if (status.isDirectory()) {
        if ((status.mode & 0o555) !== 0o555) {
          throw new Error(
            `Node.js runtime directory is not readable and searchable by the service user: ${path}`,
          );
        }
        pending.push(path);
      } else if (status.isFile()) {
        if ((status.mode & 0o444) !== 0o444) {
          throw new Error(
            `Node.js runtime file is not readable by the service user: ${path}`,
          );
        }
      } else {
        throw new Error(`Special filesystem entry in Node.js runtime: ${path}`);
      }
    }
  }
  if (entryCount === 0) {
    throw new Error("Extracted Node.js runtime is empty");
  }
}

function probeRuntime(payloadRoot, version, executable) {
  const nodePath = join(payloadRoot, executable.path);
  const nodeStatus = assertRegularFile(nodePath, "Node.js executable");
  if (
    nodeStatus.size !== executable.size ||
    sha256(nodePath) !== executable.sha256
  ) {
    throw new Error(
      `Node.js executable content does not match the locked ${version} distribution`,
    );
  }
  if ((nodeStatus.mode & 0o111) === 0) {
    throw new Error(
      `Node.js executable does not have an executable mode: ${nodePath}`,
    );
  }
  const licensePath = join(payloadRoot, "LICENSE");
  const licenseStatus = assertRegularFile(licensePath, "Node.js LICENSE");
  if (licenseStatus.size === 0) {
    throw new Error(`Node.js LICENSE is empty: ${licensePath}`);
  }

  const stdout = runChecked(
    nodePath,
    ["--version"],
    {
      cwd: payloadRoot,
      env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    },
    "Node.js runtime probe",
  );
  const expectedVersion = `v${version}`;
  if (stdout !== `${expectedVersion}\n`) {
    throw new Error(
      `Node.js runtime version mismatch: expected ${JSON.stringify(`${expectedVersion}\n`)}, received ${JSON.stringify(stdout)}`,
    );
  }
}

function downloadWithCurl(url, destination, maximumSize) {
  runChecked(
    "curl",
    [
      "--proto",
      "=https",
      "--tlsv1.2",
      "--fail",
      "--location",
      "--silent",
      "--show-error",
      "--connect-timeout",
      "15",
      "--max-time",
      String(DOWNLOAD_TIMEOUT_MS / 1_000),
      "--max-filesize",
      String(maximumSize),
      "--output",
      destination,
      url,
    ],
    { timeout: DOWNLOAD_TIMEOUT_MS + 5_000, maxBuffer: 1024 * 1024 },
    "Node.js archive download",
  );
}

function assertSafeDestination(destination) {
  const absoluteDestination = resolve(destination);
  if (absoluteDestination === resolve(absoluteDestination, "..")) {
    throw new Error("Refusing to provision Node.js over the filesystem root");
  }
  if (lstatSync(absoluteDestination, { throwIfNoEntry: false })) {
    throw new Error(
      `Node.js runtime destination already exists: ${absoluteDestination}`,
    );
  }

  const parent = dirname(absoluteDestination);
  const parentStatus = lstatSync(parent, { throwIfNoEntry: false });
  if (parentStatus === undefined) {
    throw new Error(
      `Node.js runtime destination parent does not exist: ${parent}`,
    );
  }
  if (!parentStatus.isDirectory() || parentStatus.isSymbolicLink()) {
    throw new Error(
      `Node.js runtime destination parent is not a directory: ${parent}`,
    );
  }
  const canonicalParent = realpathSync(parent);
  if (canonicalParent !== parent) {
    throw new Error(
      `Node.js runtime destination parent contains a symlink: ${parent} -> ${canonicalParent}`,
    );
  }
  return { absoluteDestination, parent };
}

function provisionVerifiedNodeRuntime({
  artifact,
  destination,
  downloadFile = downloadWithCurl,
}) {
  if (typeof downloadFile !== "function") {
    throw new TypeError("downloadFile must be a synchronous function");
  }
  const { absoluteDestination, parent } = assertSafeDestination(destination);
  const archiveRoot = mkdtempSync(join(parent, ".eliza-node-archive-"));
  let payloadRoot;
  let committed = false;
  try {
    payloadRoot = mkdtempSync(join(parent, ".eliza-node-payload-"));
    chmodSync(payloadRoot, 0o755);
    const archivePath = join(archiveRoot, artifact.archive.name);
    const downloadResult = downloadFile(
      artifact.archive.url,
      archivePath,
      artifact.archive.size,
    );
    if (downloadResult && typeof downloadResult.then === "function") {
      throw new TypeError("Node.js archive downloader must be synchronous");
    }
    verifyArchive(archivePath, artifact.archive);
    validateArchiveEntries(
      listArchive(archivePath),
      artifact.archive.rootDirectory,
    );
    extractArchive(archivePath, payloadRoot);
    assertExtractedTree(payloadRoot);
    probeRuntime(payloadRoot, LOCKED_NODE_VERSION, artifact.executable);
    writeFileSync(
      join(payloadRoot, "elizaos-runtime-provenance.json"),
      `${JSON.stringify(
        {
          sourceUrl: artifact.archive.url,
          archiveSha256: artifact.archive.sha256,
          executableSha256: artifact.executable.sha256,
          source: LOCKED_NODE_SOURCE,
          version: LOCKED_NODE_VERSION,
          platform: artifact.platform,
        },
        null,
        2,
      )}\n`,
    );
    chmodSync(join(payloadRoot, "elizaos-runtime-provenance.json"), 0o644);
    assertExtractedTree(payloadRoot);

    rmSync(archiveRoot, { recursive: true });
    if (lstatSync(absoluteDestination, { throwIfNoEntry: false })) {
      throw new Error(
        `Node.js runtime destination appeared during provisioning: ${absoluteDestination}`,
      );
    }
    renameSync(payloadRoot, absoluteDestination);
    committed = true;
    return {
      destination: absoluteDestination,
      version: LOCKED_NODE_VERSION,
      archiveSha256: artifact.archive.sha256,
    };
  } finally {
    if (!committed && payloadRoot) {
      // Staging is private to this invocation and never contains caller data.
      rmSync(payloadRoot, { recursive: true, force: true });
    }
    // The verified archive is disposable after success or failure.
    rmSync(archiveRoot, { recursive: true, force: true });
  }
}

function assertRepositoryNodePin() {
  assertRegularFile(join(REPOSITORY_ROOT, "package.json"), "package.json");
  assertRegularFile(join(REPOSITORY_ROOT, ".nvmrc"), ".nvmrc");
  const manifest = JSON.parse(
    readFileSync(join(REPOSITORY_ROOT, "package.json"), "utf8"),
  );
  if (
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    !manifest.engines ||
    typeof manifest.engines !== "object" ||
    Array.isArray(manifest.engines) ||
    typeof manifest.engines.node !== "string"
  ) {
    throw new Error("package.json must declare an exact engines.node string");
  }
  if (manifest.engines.node !== LOCKED_NODE_VERSION) {
    throw new Error(
      `Locked Node.js helper drifted from package.json engines.node: expected ${LOCKED_NODE_VERSION}, received ${JSON.stringify(manifest.engines.node)}`,
    );
  }
  const nvmVersion = readFileSync(
    join(REPOSITORY_ROOT, ".nvmrc"),
    "utf8",
  ).trim();
  if (nvmVersion !== LOCKED_NODE_VERSION) {
    throw new Error(
      `Locked Node.js helper drifted from .nvmrc: expected ${LOCKED_NODE_VERSION}, received ${JSON.stringify(nvmVersion)}`,
    );
  }
}

/** Provision the exact Node.js runtime declared by the repository toolchain. */
export function provisionLockedNodeRuntime(destination) {
  assertRepositoryNodePin();
  const artifact = selectLockedNodeArtifact(process.platform, process.arch);
  return provisionVerifiedNodeRuntime({
    artifact,
    destination,
  });
}

export const testing = Object.freeze({
  assertExtractedTree,
  assertRepositoryNodePin,
  provisionVerifiedNodeRuntime,
  validateArchiveEntries,
});

function runCli(argv) {
  if (argv.length !== 1) {
    throw new Error(
      "Usage: node packages/scripts/locked-node-runtime.mjs <destination>",
    );
  }
  const result = provisionLockedNodeRuntime(argv[0]);
  process.stdout.write(
    `Provisioned Node.js v${result.version} at ${result.destination}\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === MODULE_PATH) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    // error-policy:J1 CLI boundary translates a provisioning failure into a nonzero exit.
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

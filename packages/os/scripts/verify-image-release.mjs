#!/usr/bin/env node
// Verifies canonical image-release bytes. On the isolated signing runner it
// can publish those same held bytes into a fresh exclusive handoff tree.
import { createHash, verify } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateAgainstSchema } from "./json-schema-lite.mjs";
import { parseArgs } from "./os-release-lib.mjs";
import { loadReleaseKeyPolicy } from "./release-key-policy.mjs";

const architectures = ["x86_64", "arm64", "riscv64"];

function artifactSignaturePayload(artifact) {
  return Buffer.from(
    [
      "elizaOS-artifact-v1",
      artifact.url,
      artifact.architecture,
      String(artifact.sequence),
      String(artifact.compressedSize),
      String(artifact.expandedSize),
      artifact.sha256Compressed,
      artifact.sha256Expanded,
      "",
    ].join("\n"),
    "utf8",
  );
}

function sameFileState(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameDirectoryIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid
  );
}

async function testCheckpoint(name) {
  const hookDirectory = Reflect.get(
    process.env,
    "ELIZAOS_RELEASE_TEST_HOOK_DIRECTORY",
  );
  const selected = Reflect.get(process.env, "ELIZAOS_RELEASE_TEST_CHECKPOINT");
  if (process.env.NODE_ENV !== "test" || !hookDirectory || selected !== name)
    return;
  await writeFile(path.join(hookDirectory, `${name}.ready`), "ready\n", {
    flag: "wx",
  });
  const resume = path.join(hookDirectory, `${name}.resume`);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await lstat(resume);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out at test checkpoint ${name}`);
}

async function openHeldFile(filePath, expectedSize) {
  const handle = await open(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const [stats, pathStats] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(filePath, { bigint: true }),
    ]);
    if (
      !stats.isFile() ||
      pathStats.isSymbolicLink() ||
      !sameFileState(stats, pathStats) ||
      stats.size === 0n ||
      (expectedSize !== undefined && stats.size !== BigInt(expectedSize))
    ) {
      throw new Error(
        `release file is missing, linked, empty, changed, or wrong-sized: ${filePath}`,
      );
    }
    return { filePath, handle, stats };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function validateHeldFile(file) {
  const [stats, pathStats] = await Promise.all([
    file.handle.stat({ bigint: true }),
    lstat(file.filePath, { bigint: true }),
  ]);
  if (
    !sameFileState(file.stats, stats) ||
    !sameFileState(file.stats, pathStats) ||
    !pathStats.isFile() ||
    pathStats.isSymbolicLink()
  ) {
    throw new Error(
      `release file changed during verification: ${file.filePath}`,
    );
  }
}

async function readHeldBytes(file) {
  if (file.stats.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`release file is too large to read: ${file.filePath}`);
  }
  const bytes = Buffer.alloc(Number(file.stats.size));
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await file.handle.read(
      bytes,
      offset,
      bytes.length - offset,
      offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset !== bytes.length)
    throw new Error(`release file was truncated: ${file.filePath}`);
  await validateHeldFile(file);
  file.digest = createHash("sha256").update(bytes).digest("hex");
  return bytes;
}

async function hashHeldFile(file) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0n;
  while (position < file.stats.size) {
    const length = Number(
      file.stats.size - position > BigInt(buffer.length)
        ? BigInt(buffer.length)
        : file.stats.size - position,
    );
    const { bytesRead } = await file.handle.read(
      buffer,
      0,
      length,
      Number(position),
    );
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += BigInt(bytesRead);
  }
  if (position !== file.stats.size)
    throw new Error(`release file was truncated: ${file.filePath}`);
  await validateHeldFile(file);
  file.digest = hash.digest("hex");
  return file.digest;
}

async function trustedPrivateRoot(root) {
  const handle = await open(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const [pathStats, stats, canonicalRoot, entries] = await Promise.all([
      lstat(root, { bigint: true }),
      handle.stat({ bigint: true }),
      realpath(root),
      readdir(root),
    ]);
    if (
      canonicalRoot !== root ||
      !sameDirectoryIdentity(pathStats, stats) ||
      !stats.isDirectory() ||
      pathStats.isSymbolicLink() ||
      stats.uid !== BigInt(process.geteuid()) ||
      (stats.mode & 0o777n) !== 0o700n
    ) {
      throw new Error(
        "--artifact-root must remain an unpublished signer-owned mode-0700 directory during verification",
      );
    }
    const unfinished = entries.filter((name) =>
      name.startsWith(".elizaos-release-stage-"),
    );
    if (unfinished.length > 0) {
      throw new Error(
        `verification refuses unfinished unpublished signing state: ${unfinished.join(", ")}`,
      );
    }
    return { handle, stats };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function validatePrivateRoot(root, trusted) {
  const [pathStats, stats, canonicalRoot, entries] = await Promise.all([
    lstat(root, { bigint: true }),
    trusted.handle.stat({ bigint: true }),
    realpath(root),
    readdir(root),
  ]);
  if (
    canonicalRoot !== root ||
    !sameDirectoryIdentity(pathStats, trusted.stats) ||
    !sameDirectoryIdentity(stats, trusted.stats) ||
    entries.some((name) => name.startsWith(".elizaos-release-stage-"))
  ) {
    throw new Error("private artifact root changed during verification");
  }
}

async function createPublicationDirectories(publishRoot) {
  const parentPath = path.dirname(publishRoot);
  const parentHandle = await open(
    parentPath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let parent;
  try {
    const [stats, pathStats, canonicalParent] = await Promise.all([
      parentHandle.stat({ bigint: true }),
      lstat(parentPath, { bigint: true }),
      realpath(parentPath),
    ]);
    if (
      canonicalParent !== parentPath ||
      !sameDirectoryIdentity(stats, pathStats) ||
      !stats.isDirectory() ||
      pathStats.isSymbolicLink() ||
      stats.uid !== BigInt(process.geteuid()) ||
      (stats.mode & 0o22n) !== 0n
    ) {
      throw new Error(
        "publication root parent must be a canonical signer-owned non-writable directory",
      );
    }
    parent = { handle: parentHandle, stats };
    await mkdir(publishRoot, { mode: 0o700 });
    await parentHandle.sync();
    await validatePublicationDirectory(parentPath, parent);
  } catch (error) {
    await parentHandle.close().catch(() => {});
    throw error;
  }
  const paths = [
    path.join(publishRoot, "metadata"),
    ...architectures.map((architecture) =>
      path.join(publishRoot, architecture),
    ),
  ];
  const handles = new Map();
  try {
    for (const directory of paths) await mkdir(directory, { mode: 0o700 });
    for (const directory of [publishRoot, ...paths]) {
      const handle = await open(
        directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const [stats, pathStats] = await Promise.all([
        handle.stat({ bigint: true }),
        lstat(directory, { bigint: true }),
      ]);
      if (
        !sameDirectoryIdentity(stats, pathStats) ||
        !stats.isDirectory() ||
        stats.uid !== BigInt(process.geteuid()) ||
        (stats.mode & 0o777n) !== 0o700n
      ) {
        await handle.close().catch(() => {});
        throw new Error(`publication directory is not private: ${directory}`);
      }
      handles.set(directory, { handle, stats });
    }
    return { directories: handles, parentPath, parent };
  } catch (error) {
    await Promise.all([
      ...[...handles.values()].map(({ handle }) =>
        handle.close().catch(() => {}),
      ),
      parent.handle.close().catch(() => {}),
    ]);
    throw error;
  }
}

async function validatePublicationFile(file) {
  const [stats, pathStats] = await Promise.all([
    file.handle.stat({ bigint: true }),
    lstat(file.filePath, { bigint: true }),
  ]);
  if (
    !sameFileState(file.stats, stats) ||
    !sameFileState(file.stats, pathStats) ||
    !stats.isFile() ||
    pathStats.isSymbolicLink() ||
    stats.uid !== BigInt(process.geteuid()) ||
    (stats.mode & 0o777n) !== 0o400n
  ) {
    throw new Error(`publication file changed: ${file.filePath}`);
  }
}

async function validatePublicationDirectory(directory, trusted) {
  const [stats, pathStats] = await Promise.all([
    trusted.handle.stat({ bigint: true }),
    lstat(directory, { bigint: true }),
  ]);
  if (
    !sameDirectoryIdentity(trusted.stats, stats) ||
    !sameDirectoryIdentity(trusted.stats, pathStats) ||
    !stats.isDirectory() ||
    pathStats.isSymbolicLink()
  ) {
    throw new Error(`publication directory changed: ${directory}`);
  }
}

async function copyHeldFile(source, filePath) {
  await validateHeldFile(source);
  const handle = await open(
    filePath,
    constants.O_RDWR |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o400,
  );
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    const sourceHash = createHash("sha256");
    let position = 0n;
    while (position < source.stats.size) {
      const length = Number(
        source.stats.size - position > BigInt(buffer.length)
          ? BigInt(buffer.length)
          : source.stats.size - position,
      );
      const { bytesRead } = await source.handle.read(
        buffer,
        0,
        length,
        Number(position),
      );
      if (bytesRead === 0) break;
      sourceHash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const { bytesWritten } = await handle.write(
          buffer,
          written,
          bytesRead - written,
          Number(position) + written,
        );
        if (bytesWritten === 0)
          throw new Error(`publication write made no progress: ${filePath}`);
        written += bytesWritten;
      }
      position += BigInt(bytesRead);
    }
    if (
      position !== source.stats.size ||
      sourceHash.digest("hex") !== source.digest
    ) {
      throw new Error(
        `verified source changed while publishing: ${source.filePath}`,
      );
    }
    await handle.sync();
    const stats = await handle.stat({ bigint: true });
    const published = { filePath, handle, stats };
    await validatePublicationFile(published);
    const destinationHash = createHash("sha256");
    position = 0n;
    while (position < stats.size) {
      const length = Number(
        stats.size - position > BigInt(buffer.length)
          ? BigInt(buffer.length)
          : stats.size - position,
      );
      const { bytesRead } = await handle.read(
        buffer,
        0,
        length,
        Number(position),
      );
      if (bytesRead === 0) break;
      destinationHash.update(buffer.subarray(0, bytesRead));
      position += BigInt(bytesRead);
    }
    if (
      position !== stats.size ||
      destinationHash.digest("hex") !== source.digest
    ) {
      throw new Error(
        `published bytes do not match verified source: ${filePath}`,
      );
    }
    await validateHeldFile(source);
    await validatePublicationFile(published);
    return published;
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function publishVerifiedSet(publishRoot, files) {
  const { directories, parentPath, parent } =
    await createPublicationDirectories(publishRoot);
  const published = [];
  try {
    const manifestIndex = files.length - 1;
    const manifest = files[manifestIndex];
    for (let index = 0; index < manifestIndex; index += 1) {
      const { source, relativePath } = files[index];
      await testCheckpoint(`before-publication-copy-${index}`);
      await validatePublicationDirectory(parentPath, parent);
      for (const [directory, trusted] of directories) {
        await validatePublicationDirectory(directory, trusted);
      }
      published.push(
        await copyHeldFile(source, path.join(publishRoot, relativePath)),
      );
    }

    // Make every prerequisite entry durable before the manifest commit marker
    // is even created. Directory fsync ordering across sibling directories is
    // otherwise unconstrained after a host crash.
    const rootDirectory = publishRoot;
    const metadataDirectory = path.join(publishRoot, "metadata");
    for (const architecture of architectures) {
      const directory = path.join(publishRoot, architecture);
      const trusted = directories.get(directory);
      await trusted.handle.sync();
      await validatePublicationDirectory(directory, trusted);
    }
    const trustedMetadata = directories.get(metadataDirectory);
    await trustedMetadata.handle.sync();
    await validatePublicationDirectory(metadataDirectory, trustedMetadata);
    const trustedPublicationRoot = directories.get(rootDirectory);
    await trustedPublicationRoot.handle.sync();
    await validatePublicationDirectory(rootDirectory, trustedPublicationRoot);
    await parent.handle.sync();
    await validatePublicationDirectory(parentPath, parent);
    await testCheckpoint("before-publication-manifest-commit");

    await testCheckpoint(`before-publication-copy-${manifestIndex}`);
    await validatePublicationDirectory(parentPath, parent);
    for (const [directory, trusted] of directories) {
      await validatePublicationDirectory(directory, trusted);
    }
    published.push(
      await copyHeldFile(
        manifest.source,
        path.join(publishRoot, manifest.relativePath),
      ),
    );
    await trustedMetadata.handle.sync();
    await validatePublicationDirectory(metadataDirectory, trustedMetadata);
    await testCheckpoint("after-publication-manifest-sync");

    for (const [directory, trusted] of directories) {
      await validatePublicationDirectory(directory, trusted);
    }
    await trustedPublicationRoot.handle.sync();
    await validatePublicationDirectory(rootDirectory, trustedPublicationRoot);
    await parent.handle.sync();
    await validatePublicationDirectory(parentPath, parent);
    for (const source of new Set(files.map(({ source }) => source)))
      await validateHeldFile(source);
    for (const file of published) await validatePublicationFile(file);
  } catch (error) {
    throw new Error(
      `publication-input creation failed; discard the fresh publication root ${publishRoot}: ${error.message}`,
      { cause: error },
    );
  } finally {
    await Promise.all([
      ...published.map(({ handle }) => handle.close().catch(() => {})),
      ...[...directories.values()].map(({ handle }) =>
        handle.close().catch(() => {}),
      ),
      parent.handle.close().catch(() => {}),
    ]);
  }
}

const args = parseArgs(process.argv.slice(2));
if (!args.manifest || !args["artifact-root"]) {
  throw new Error("--manifest and --artifact-root are required");
}
if (
  args["require-private-root"] !== undefined &&
  args["require-private-root"] !== true
) {
  throw new Error("--require-private-root does not accept a value");
}
const requirePrivateRoot = args["require-private-root"] === true;
if (args["publish-root"] && !requirePrivateRoot) {
  throw new Error("--publish-root requires --require-private-root");
}
const manifestPath = path.resolve(args.manifest);
const root = path.resolve(args["artifact-root"]);
if (path.dirname(manifestPath) !== root) {
  throw new Error("--manifest must be a direct child of --artifact-root");
}
const publishRoot = args["publish-root"]
  ? path.resolve(args["publish-root"])
  : undefined;
if (
  publishRoot &&
  (publishRoot === root ||
    publishRoot.startsWith(`${root}${path.sep}`) ||
    root.startsWith(`${publishRoot}${path.sep}`))
) {
  throw new Error("--publish-root and --artifact-root must be separate trees");
}

const { key } = loadReleaseKeyPolicy();
const trustedRoot = requirePrivateRoot
  ? await trustedPrivateRoot(root)
  : undefined;
const heldFiles = [];
try {
  const manifestFile = await openHeldFile(manifestPath);
  heldFiles.push(manifestFile);
  const manifestSignatureFile = await openHeldFile(`${manifestPath}.sig`, 64);
  heldFiles.push(manifestSignatureFile);
  const manifestBytes = await readHeldBytes(manifestFile);
  const manifestSignature = await readHeldBytes(manifestSignatureFile);
  if (!verify(null, manifestBytes, key, manifestSignature)) {
    throw new Error("release manifest Ed25519 signature verification failed");
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const schemaPath = fileURLToPath(
    new URL(
      "../release/schema/elizaos-image-manifest.schema.json",
      import.meta.url,
    ),
  );
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  const schemaValidation = validateAgainstSchema(manifest, schema);
  if (!schemaValidation.ok) {
    throw new Error(
      `release manifest schema validation failed:\n${schemaValidation.errors.join("\n")}`,
    );
  }
  if (
    manifest?.schemaVersion !== 1 ||
    manifest?.product !== "elizaOS" ||
    !Array.isArray(manifest?.artifacts) ||
    manifest.artifacts.length !== architectures.length ||
    Object.keys(manifest).some(
      (field) => !["schemaVersion", "product", "artifacts"].includes(field),
    )
  ) {
    throw new Error("release manifest envelope is invalid");
  }
  const identities = new Set();
  const publicationFiles = [
    {
      source: manifestSignatureFile,
      relativePath: path.join("metadata", path.basename(`${manifestPath}.sig`)),
    },
  ];
  for (const architecture of architectures) {
    const matches = manifest.artifacts.filter(
      (artifact) => artifact?.architecture === architecture,
    );
    if (matches.length !== 1)
      throw new Error(
        `release manifest requires exactly one ${architecture} artifact`,
      );
    const artifact = matches[0];
    const allowed = new Set([
      "schemaVersion",
      "product",
      "version",
      "channel",
      "sequence",
      "expires",
      "architecture",
      "url",
      "compressedSize",
      "expandedSize",
      "sha256Compressed",
      "sha256Expanded",
      "signatureUrl",
      "minDeviceBytes",
      "publishedAt",
    ]);
    if (Object.keys(artifact).some((field) => !allowed.has(field))) {
      throw new Error(`${architecture} artifact contains unknown fields`);
    }
    const url = new URL(artifact.url);
    const signatureUrl = new URL(artifact.signatureUrl);
    const basename = path.basename(url.pathname);
    const canonicalTimestamp = (value) =>
      typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
      Number.isFinite(Date.parse(value));
    if (
      url.protocol !== "https:" ||
      signatureUrl.protocol !== "https:" ||
      signatureUrl.href !== `${url.href}.sig` ||
      basename !== `elizaos-${artifact.version}-${architecture}.raw.zst` ||
      artifact.schemaVersion !== 1 ||
      artifact.product !== "elizaOS" ||
      typeof artifact.version !== "string" ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(artifact.version) ||
      !["stable", "beta", "nightly"].includes(artifact.channel) ||
      !Number.isSafeInteger(artifact.sequence) ||
      artifact.sequence < 1 ||
      !canonicalTimestamp(artifact.expires) ||
      Date.parse(artifact.expires) <= Date.now() ||
      !canonicalTimestamp(artifact.publishedAt) ||
      !Number.isSafeInteger(artifact.compressedSize) ||
      artifact.compressedSize < 1 ||
      !Number.isSafeInteger(artifact.expandedSize) ||
      artifact.expandedSize < 1 ||
      typeof artifact.sha256Compressed !== "string" ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256Compressed) ||
      artifact.sha256Compressed === "0".repeat(64) ||
      typeof artifact.sha256Expanded !== "string" ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256Expanded) ||
      artifact.sha256Expanded === "0".repeat(64) ||
      !Number.isSafeInteger(artifact.minDeviceBytes) ||
      artifact.minDeviceBytes < 32_000_000_000
    ) {
      throw new Error(`${architecture} artifact metadata is invalid`);
    }
    identities.add(
      JSON.stringify([
        artifact.version,
        artifact.channel,
        artifact.sequence,
        artifact.expires,
        artifact.publishedAt,
      ]),
    );
    const compressedPath = path.join(root, basename);
    const expandedPath = path.join(root, basename.slice(0, -4));
    const compressed = await openHeldFile(
      compressedPath,
      artifact.compressedSize,
    );
    heldFiles.push(compressed);
    const expanded = await openHeldFile(expandedPath, artifact.expandedSize);
    heldFiles.push(expanded);
    if (
      artifact.sha256Compressed !== (await hashHeldFile(compressed)) ||
      artifact.sha256Expanded !== (await hashHeldFile(expanded)) ||
      artifact.sha256Compressed === artifact.sha256Expanded ||
      artifact.expandedSize < artifact.compressedSize ||
      artifact.minDeviceBytes < artifact.expandedSize
    ) {
      throw new Error(`${architecture} image byte binding is invalid`);
    }
    const signatureFile = await openHeldFile(`${compressedPath}.sig`, 64);
    heldFiles.push(signatureFile);
    const signature = await readHeldBytes(signatureFile);
    if (!verify(null, artifactSignaturePayload(artifact), key, signature)) {
      throw new Error(
        `${architecture} artifact Ed25519 signature verification failed`,
      );
    }
    publicationFiles.push(
      { source: compressed, relativePath: path.join(architecture, basename) },
      {
        source: signatureFile,
        relativePath: path.join(architecture, `${basename}.sig`),
      },
    );
  }
  if (identities.size !== 1) {
    throw new Error(
      "release artifacts do not share one version/channel/sequence identity",
    );
  }
  // The manifest remains the last-created commit marker in the bounded handoff.
  publicationFiles.push({
    source: manifestFile,
    relativePath: path.join("metadata", path.basename(manifestPath)),
  });
  for (const file of heldFiles) await validateHeldFile(file);
  if (trustedRoot) await validatePrivateRoot(root, trustedRoot);
  if (publishRoot) await publishVerifiedSet(publishRoot, publicationFiles);
  if (trustedRoot) await validatePrivateRoot(root, trustedRoot);
  for (const file of heldFiles) await validateHeldFile(file);
  console.log(`Verified canonical image release ${manifestPath}`);
} finally {
  await Promise.all([
    ...heldFiles.map(({ handle }) => handle.close().catch(() => {})),
    trustedRoot?.handle.close().catch(() => {}),
  ]);
}

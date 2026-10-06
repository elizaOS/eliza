import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

export class RuntimeInventoryError extends Error {
  constructor(message) {
    super(message);
    this.name = "RuntimeInventoryError";
    this.code = "RUNTIME_INVENTORY_INVALID";
  }
}
const fail = (message) => {
  throw new RuntimeInventoryError(message);
};
/** APK asset path (relative to `assets/`) that RuntimeBundleStore and the
 * ota-trust `VerifyRuntimeArtifact` read. Hosts must not rename it. */
export const ANDROID_RUNTIME_INVENTORY_ASSET = "agent-runtime.inventory";
/** Default first-line format. A host that sets another format must pass the same
 * value here, to RuntimeBundleStore and as its ota-trust `runtimeInventoryHeader`. */
export const DEFAULT_ANDROID_RUNTIME_INVENTORY_FORMAT = "eliza-runtime-v1";
const formatPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const safe = (value) =>
  typeof value === "string" &&
  value.length <= 1024 &&
  /^[A-Za-z0-9_@.+/-]+$/.test(value) &&
  value.split("/").every((part) => part && part !== "." && part !== "..");
function directory(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    fail("Runtime inventory requires real directories");
}
function read(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > 512 * 1024 * 1024)
      fail("Invalid runtime inventory file");
    const bytes = fs.readFileSync(fd),
      after = fs.fstatSync(fd);
    if (
      before.size !== bytes.length ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      fail("Runtime file changed during inventory");
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}
/** Package immutable, content-addressed assets for RuntimeBundleStore.
 * The APK signer authenticates the resulting inventory. This is not release authorization.
 * `.bin` blobs preserve gzip bytes through Android asset packaging; PGlite archives
 * are installed beside bundle/, as required by the embedded runtime's resolver.
 */
export function stageAndroidRuntimeInventory({
  assetsDirectory,
  nativeLibraryDirectory,
  excludedAgentDirectories = [],
  format = DEFAULT_ANDROID_RUNTIME_INVENTORY_FORMAT,
}) {
  if (typeof format !== "string" || !formatPattern.test(format))
    fail("Invalid runtime inventory format");
  directory(assetsDirectory);
  directory(nativeLibraryDirectory);
  const agent = path.join(assetsDirectory, "agent");
  directory(agent);
  if (
    !Array.isArray(excludedAgentDirectories) ||
    !excludedAgentDirectories.every(safe)
  )
    fail("Invalid runtime asset exclusions");
  const excluded = new Set(excludedAgentDirectories),
    entries = [],
    destinations = new Set(),
    blobs = new Map();
  let total = 0,
    assetBytes = 0;
  function add(kind, bytes, source, destination) {
    if (
      bytes.length > 512 * 1024 * 1024 ||
      !safe(source) ||
      (kind === "asset" && !safe(destination))
    )
      fail("Invalid runtime inventory entry");
    if (kind === "asset") {
      if (
        !destination.startsWith("bundle/") &&
        !/^[A-Za-z0-9_.+-]+\.tar\.gz$/.test(destination)
      )
        fail("Invalid runtime archive destination");
      if (destinations.has(destination)) fail("Duplicate runtime destination");
      destinations.add(destination);
      assetBytes += bytes.length;
    }
    total += bytes.length;
    if (total > 2 * 1024 * 1024 * 1024)
      fail("Runtime inventory exceeds extraction limit");
    entries.push(
      [kind, bytes.length, hash(bytes), source, destination].join("\t"),
    );
    if (entries.length > 16384) fail("Runtime inventory exceeds entry limit");
  }
  function walk(relative = "") {
    const current = path.join(agent, relative);
    directory(current);
    for (const name of fs.readdirSync(current).sort()) {
      const child = relative ? `${relative}/${name}` : name;
      if (!safe(child)) fail("Unsafe runtime asset path");
      const file = path.join(agent, child),
        stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) fail("Runtime assets must not be symlinks");
      if (stat.isDirectory()) {
        if (!excluded.has(child)) walk(child);
        continue;
      }
      let bytes = read(file),
        destination = `bundle/${child}`,
        source = `agent/${child}`;
      if (child.endsWith(".tar.gz")) destination = path.posix.basename(child);
      else if (child.endsWith(".tar")) {
        bytes = gzipSync(bytes);
        destination = `${path.posix.basename(child)}.gz`;
      }
      if (destination !== `bundle/${child}`) {
        const digest = hash(bytes);
        source = `runtime-blobs/${digest}.bin`;
        blobs.set(digest, bytes);
      }
      add("asset", bytes, source, destination);
    }
  }
  walk();
  const libraries = new Set();
  for (const name of fs.readdirSync(nativeLibraryDirectory).sort()) {
    if (!/^lib[A-Za-z0-9_.-]+\.so$/.test(name))
      fail("Invalid native runtime library name");
    add("native", read(path.join(nativeLibraryDirectory, name)), name, "-");
    libraries.add(name);
  }
  for (const required of [
    "bundle/agent-bundle.js",
    "bundle/gateway/bootstrap.mjs",
    "bundle/gateway/local-agent-gateway.mjs",
  ])
    if (!destinations.has(required)) fail("Incomplete runtime asset inventory");
  for (const required of ["libeliza_bun.so", "libeliza_ld_musl_aarch64.so"])
    if (!libraries.has(required)) fail("Incomplete runtime native inventory");
  const manifest = Buffer.from(`${format}\n${entries.join("\n")}\n`);
  if (manifest.length > 2 * 1024 * 1024)
    fail("Runtime manifest exceeds size limit");
  const blobDirectory = path.join(assetsDirectory, "runtime-blobs");
  if (!fs.existsSync(blobDirectory))
    fs.mkdirSync(blobDirectory, { mode: 0o700 });
  directory(blobDirectory);
  const blobDescriptor = fs.openSync(
    blobDirectory,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  try {
    const stat = fs.fstatSync(blobDescriptor);
    if (process.getuid && stat.uid !== process.getuid())
      fail("Runtime blob directory must be host-owned");
    fs.fchmodSync(blobDescriptor, 0o700);
  } finally {
    fs.closeSync(blobDescriptor);
  }
  for (const [digest, bytes] of blobs) {
    const file = path.join(blobDirectory, `${digest}.bin`);
    if (fs.existsSync(file)) {
      if (hash(read(file)) !== digest) fail("Existing runtime blob changed");
    } else fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
  }
  const target = path.join(assetsDirectory, ANDROID_RUNTIME_INVENTORY_ASSET);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, manifest, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return {
    manifestPath: target,
    sha256: hash(manifest),
    files: entries.length,
    assetBytes,
  };
}

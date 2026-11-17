import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function fail(message) {
  throw new Error(message);
}

const nativeName = "libeliza_node.so";
const machine = { "arm64-v8a": 183, x86_64: 62 };
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function regular(file) {
  const data = fs.lstatSync(file);
  if (!data.isFile() || data.size > 512 * 1024 * 1024) fail("Runtime input is not a bounded regular file");
  return fs.readFileSync(file);
}

function isAndroidNode(bytes, abi) {
  if (bytes.length < 64 || bytes.readUInt32BE(0) !== 0x7f454c46
    || bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(16) !== 3
    || bytes.readUInt16LE(18) !== machine[abi]) return false;
  const offset = bytes.readBigUInt64LE(32);
  const length = bytes.readUInt16LE(54);
  const count = bytes.readUInt16LE(56);
  if (length !== 56 || BigInt(length * count) + offset > BigInt(bytes.length)) return false;
  for (let index = 0; index < count; index++) {
    const entry = Number(offset) + index * length;
    if (bytes.readUInt32LE(entry) !== 3) continue;
    const start = bytes.readBigUInt64LE(entry + 8);
    const size = bytes.readBigUInt64LE(entry + 32);
    if (start + size > BigInt(bytes.length)) return false;
    return bytes.subarray(Number(start), Number(start + size)).equals(Buffer.from("/system/bin/linker64\0"));
  }
  return false;
}

export function stageRuntimePayload({ runtime, nodeLock, bundle, bundleManifest, sourceCommit, targetAbi, output }) {
  if (!Object.hasOwn(machine, targetAbi) || !/^[a-f0-9]{40}$/.test(sourceCommit))
    fail("Invalid runtime ABI or pinned source commit");
  const executable = regular(runtime.file);
  const pinned = nodeLock.entries.filter((entry) => entry.abi === targetAbi);
  if (pinned.length !== 1 || !/^26\.[0-9]+\.[0-9]+$/.test(runtime.version)
    || nodeLock.version !== runtime.version || nodeLock.ndk !== runtime.ndk || nodeLock.apiLevel !== runtime.apiLevel
    || pinned[0].sha256 !== digest(executable) || (runtime.url !== undefined && pinned[0].url !== runtime.url))
    fail("Android Node does not match the ABI's runtime lock");
  if (!isAndroidNode(executable, targetAbi)) fail("Node runtime is not an Android executable for the target ABI");

  const agent = regular(bundle);
  const manifestBytes = regular(bundleManifest);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.schema !== 1 || manifest.node !== "26" || manifest.sourceCommit !== sourceCommit
    || manifest.bundleSha256 !== digest(agent) || !Array.isArray(manifest.packages) || !manifest.packages.length
    || manifest.localInference !== false || manifest.workflowWorkerSha256)
    fail("Agent bundle does not match the pinned cloud-only package");
  const dataFiles = ["pglite.wasm", "pglite.data", "pglite-migrated.bin"].map((name) => ({
    path: `assets/agent/${name}`, bytes: regular(path.join(path.dirname(bundle), name)), mode: 0o644,
  }));
  const payload = [
    { path: "assets/agent/agent.mjs", bytes: agent, mode: 0o644 },
    ...dataFiles,
    { path: "assets/agent/manifest.json", bytes: manifestBytes, mode: 0o644 },
    { path: `lib/${targetAbi}/${nativeName}`, bytes: executable, mode: 0o755 },
  ];
  const rows = payload.map(({ path, bytes }) => ({ path, size: bytes.length, sha256: digest(bytes) }));
  const destination = path.resolve(output);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const scratch = fs.mkdtempSync(`${destination}.building-`);
  try {
    const main = path.join(scratch, "android/app/src/main");
    for (const file of payload) {
      const destination = path.join(main, file.path.replace(/^lib\//, "jniLibs/"));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, file.bytes, { flag: "wx", mode: file.mode });
    }
    fs.writeFileSync(path.join(main, "assets/agent/inventory.json"), JSON.stringify({ schema: 1, files: rows }), { flag: "wx" });
    fs.renameSync(scratch, destination);
    return destination;
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}

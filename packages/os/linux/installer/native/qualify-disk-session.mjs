import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createRequire } from "node:module";
import { connect, createServer } from "node:net";

// Destructive fixtures are restricted to the VM runner's explicitly named disk.
const [addon, evidence] = process.argv.slice(2);
assert.ok(addon && evidence, "addon and evidence paths are required");
assert.equal(process.getuid(), 0);
assert.match(
  readFileSync("/sys/class/dmi/id/product_name", "utf8"),
  /QEMU|Standard PC/,
);
assert.equal(
  readFileSync("/sys/class/block/vdb/serial", "utf8").trim(),
  "ELIZAOS-DISK-SESSION",
);
const target = "/dev/vdb";
const storage = "/dev/vda";
const directory = "/root/installer-backups";
assert.equal(
  execFileSync("blockdev", ["--getsize64", target], {
    encoding: "utf8",
  }).trim(),
  "134217728",
);
assert.equal(
  execFileSync("findmnt", ["-n", "-o", "SOURCE", "/"], {
    encoding: "utf8",
  }).trim(),
  "/dev/vda1",
);
assert.equal(
  execFileSync("findmnt", ["-n", "-o", "FSTYPE", "/"], {
    encoding: "utf8",
  }).trim(),
  "ext4",
);
execFileSync("sfdisk", [target], {
  input: "label: gpt\nstart=2048, size=8192, type=L\n",
});
execFileSync("udevadm", ["settle"]);
mkdirSync(directory, { mode: 0o700 });
const binding = createRequire(import.meta.url)(addon);
function identity(name) {
  const root = `/sys/class/block/${name}`;
  const [major, minor] = readFileSync(`${root}/dev`, "utf8")
    .trim()
    .split(":")
    .map(Number);
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(major, 0);
  bytes.writeUInt32LE(minor, 4);
  bytes.writeBigUInt64LE(
    BigInt(readFileSync(`${root}/diskseq`, "utf8").trim()),
    8,
  );
  bytes.writeBigUInt64LE(
    BigInt(
      execFileSync("blockdev", ["--getsize64", `/dev/${name}`], {
        encoding: "utf8",
      }).trim(),
    ),
    16,
  );
  bytes.writeUInt32LE(
    Number(readFileSync(`${root}/queue/logical_block_size`, "utf8").trim()),
    24,
  );
  return bytes;
}
const targetIdentity = identity("vdb");
const storageIdentity = identity("vda");
const args = [
  target,
  targetIdentity,
  storage,
  storageIdentity,
  "/dev/vda1",
  directory,
];
const refused = (operation) =>
  assert.throws(operation, { code: "ELIZAOS_INSTALL_DISK_ERROR" });
const cases = [];
const targetDigest = () =>
  createHash("sha256").update(readFileSync(target)).digest("hex");
const canaryFd = openSync(target, "r+");
try {
  writeSync(canaryFd, Buffer.alloc(4096, 0x5a), 0, 4096, 52 * 1024 ** 2);
} finally {
  closeSync(canaryFd);
}
const before = targetDigest();
for (const index of [0, 4, 8, 16, 24, 28]) {
  const wrong = Buffer.from(targetIdentity);
  wrong[index] ^= 1;
  refused(() => binding.openDiskSession(target, wrong, ...args.slice(2)));
}
refused(() => binding.openDiskSession(...args, "extra"));
refused(() => binding.openDiskSession(...args.slice(0, 5)));
refused(() => binding.openDiskSession(`${target}\0ignored`, ...args.slice(1)));
refused(() =>
  binding.openDiskSession(target, new Uint8Array(32), ...args.slice(2)),
);
refused(() =>
  binding.openDiskSession(target, Buffer.alloc(31), ...args.slice(2)),
);
cases.push("malformed-and-stale-identities-refused");
const baseline = readdirSync("/proc/self/fd").length;
for (let attempt = 0; attempt < 25; attempt++) {
  refused(() =>
    binding.openDiskSession(...args.slice(0, 4), "/dev/vdb1", directory),
  );
}
assert.equal(readdirSync("/proc/self/fd").length, baseline);
cases.push("failed-open-releases-descriptors");

const session = binding.openDiskSession(...args);
try {
  session.check();
  refused(() => session.check("extra"));
  refused(() => session.check.call({}));
  refused(() => session.close.call({}));
  refused(() => binding.openDiskSession(...args));
  const hashBinding = createHash("sha256")
    .update("VM trusted install plan binding")
    .digest();
  refused(() => session.backup(Buffer.alloc(31)));
  refused(() => session.backup(hashBinding, "extra"));
  const digest = session.backup(hashBinding);
  assert.ok(Buffer.isBuffer(digest) && digest.length === 32);
  const artifactPath = `${directory}/${digest.toString("hex")}.gpt`;
  const artifact = readFileSync(artifactPath);
  assert.equal(
    createHash("sha256").update(artifact).digest("hex"),
    digest.toString("hex"),
  );
  assert.equal(statSync(artifactPath).mode & 0o777, 0o600);
  session.verify(hashBinding, digest);
  refused(() => session.verify(Buffer.alloc(32), digest));
  refused(() => session.verify(hashBinding, Buffer.alloc(32)));
  refused(() => session.backup(hashBinding));
  assert.deepEqual(readFileSync(artifactPath), artifact);
  cases.push("durable-backup-readback-and-exclusive-artifact");
  const edit = (kind, role, start, end) => {
    const value = Buffer.alloc(24);
    value.writeUInt32LE(kind, 0);
    value.writeUInt32LE(role, 4);
    value.writeBigUInt64LE(BigInt(start), 8);
    value.writeBigUInt64LE(BigInt(end), 16);
    return value;
  };
  for (const invalid of [
    edit(3, 0, 0, 0),
    edit(1, 1, 0, 0),
    edit(2, 5, 16 * 1024 ** 2, 20 * 1024 ** 2),
    edit(2, 1, 0, 1024 ** 2),
    edit(2, 1, 1024 ** 2 + 1, 64 * 1024 ** 2),
    edit(2, 1, 1024 ** 2, 64 * 1024 ** 2),
    edit(2, 1, 64 * 1024 ** 2, 256 * 1024 ** 2),
  ])
    refused(() => session.editGpt(hashBinding, digest, digest, invalid));
  refused(() =>
    session.editGpt(hashBinding, Buffer.alloc(32), digest, edit(1, 0, 0, 0)),
  );
  refused(() =>
    session.editGpt(hashBinding, digest, Buffer.alloc(32), edit(1, 0, 0, 0)),
  );
  session.verify(hashBinding, digest);
  assert.equal(targetDigest(), before);
  cases.push(
    "invalid-overlapping-stale-and-unbacked-gpt-edits-refused-without-mutation",
  );

  renameSync(target, `${target}-retained`);
  try {
    writeFileSync(target, "PATH REPLACEMENT CANARY");
    session.check();
    session.verify(hashBinding, digest);
    assert.equal(readFileSync(target, "utf8"), "PATH REPLACEMENT CANARY");
  } finally {
    unlinkSync(target);
    renameSync(`${target}-retained`, target);
  }
  cases.push("device-path-replacement-uses-retained-descriptor");
  renameSync(directory, `${directory}-retained`);
  mkdirSync(directory, { mode: 0o700 });
  refused(() => session.check());
  refused(() => session.verify(hashBinding, digest));
  renameSync(directory, `${directory}-replacement`);
  renameSync(`${directory}-retained`, directory);
  session.check();
  chmodSync(directory, 0o755);
  refused(() => session.verify(hashBinding, digest));
  chmodSync(directory, 0o700);
  session.verify(hashBinding, digest);
  cases.push("storage-path-and-permission-changes-refused");

  const server = createServer();
  let client;
  let socket;
  let peer;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen("/root/disk-session.sock", resolve);
    });
    const accepted = new Promise((resolve) =>
      server.once("connection", resolve),
    );
    client = connect("/root/disk-session.sock");
    socket = await accepted;
    peer = binding.capture(socket._handle.fd);
    refused(() => session.close.call(peer));
    refused(() => session.check.call(peer));
    assert.throws(() => peer.close.call(session), /receiver is invalid/);
    assert.throws(() => peer.isAlive.call(session), /receiver is invalid/);
    assert.equal(peer.isAlive(), true);
    session.check();
  } finally {
    peer?.close();
    client?.destroy();
    socket?.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
  cases.push("cross-native-type-receivers-refused-without-closing-owner");
  const descriptor = openSync(artifactPath, "r+");
  try {
    writeSync(descriptor, Buffer.from([artifact[0] ^ 1]), 0, 1, 0);
  } finally {
    closeSync(descriptor);
  }
  refused(() => session.verify(hashBinding, digest));
  assert.equal(statSync(artifactPath).size, artifact.length);
  cases.push("tampered-backup-refused-and-retained");
} finally {
  session.close();
}
session.close();
refused(() => session.check());
// Node can initialize event-loop descriptors while the AF_UNIX test runs.
// Assert ownership of the disk-session descriptors rather than runtime internals.
assert.deepEqual(
  readdirSync("/proc/self/fd").flatMap((fd) => {
    try {
      const path = readlinkSync(`/proc/self/fd/${fd}`);
      return path.startsWith("/dev/vd") || path.startsWith(directory)
        ? [path]
        : [];
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return [];
    }
  }),
  [],
);
const reopened = binding.openDiskSession(...args);
reopened.close();
assert.equal(targetDigest(), before);
cases.push("explicit-close-releases-claim-and-target-unchanged");
// Keep a partition open so BLKRRPART fails after actual GPT writes. The addon
// must report the attempted effects and refuse further mutations in this session.
const faultSession = binding.openDiskSession(...args);
let heldPartition;
try {
  const faultBinding = createHash("sha256")
    .update("busy map failure fixture")
    .digest();
  const original = faultSession.backup(faultBinding);
  const previousTable = JSON.parse(
    execFileSync("sfdisk", ["--json", target], { encoding: "utf8" }),
  ).partitiontable;
  const create = Buffer.alloc(24);
  create.writeUInt32LE(2, 0);
  create.writeUInt32LE(4, 4);
  create.writeBigUInt64LE(64n * 1024n ** 2n, 8);
  create.writeBigUInt64LE(80n * 1024n ** 2n, 16);
  const created = faultSession.editGpt(
    faultBinding,
    original,
    original,
    create,
  );
  const current = created.subarray(0, 32);
  const currentTable = JSON.parse(
    execFileSync("sfdisk", ["--json", target], { encoding: "utf8" }),
  ).partitiontable;
  assert.equal(currentTable.id, previousTable.id);
  assert.deepEqual(currentTable.partitions[0], previousTable.partitions[0]);
  assert.equal(
    currentTable.partitions.length,
    previousTable.partitions.length + 1,
  );
  assert.deepEqual(
    readFileSync(target).subarray(52 * 1024 ** 2, 52 * 1024 ** 2 + 4096),
    Buffer.alloc(4096, 0x5a),
  );
  assert.throws(
    () => faultSession.editGpt(faultBinding, original, current, create),
    /write attempted=0/,
  );
  cases.push(
    "create-preserves-existing-partition-guid-entry-and-payload-canary",
  );
  heldPartition = openSync("/dev/vdb1", "r");
  const erase = Buffer.alloc(24);
  erase.writeUInt32LE(1, 0);
  assert.throws(
    () => faultSession.editGpt(faultBinding, original, current, erase),
    /write attempted=1.*map verified=0/,
  );
  assert.throws(
    () => faultSession.editGpt(faultBinding, original, current, erase),
    /requires explicit recovery/,
  );
  faultSession.verify(faultBinding, original);
  cases.push("busy-kernel-map-reports-written-effects-and-requires-recovery");
} finally {
  if (heldPartition !== undefined) closeSync(heldPartition);
  faultSession.close();
}
writeFileSync(
  evidence,
  `${JSON.stringify({ success: true, cases, sectorBytes: targetIdentity.readUInt32LE(24), targetSha256BeforeMutationFailure: before, runtime: process.version }, null, 2)}\n`,
);

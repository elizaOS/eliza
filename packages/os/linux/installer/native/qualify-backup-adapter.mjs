import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import {
  authorizeInstallPlan,
  buildFilesystemImage,
  createDiskConfirmationToken,
  createDiskInventoryFingerprint,
  createInstallPlan,
  NativeLinuxInstallDiskSession,
  renderInstalledGrubConfiguration,
} from "/inputs/installer.mjs";
import { assertUnmountedFixtureDisk } from "./qualification-inventory.mjs";

const [addon, evidence] = process.argv.slice(2);
assert.ok(addon && evidence);
assert.equal(process.getuid(), 0);
assert.match(
  readFileSync("/sys/class/dmi/id/product_name", "utf8"),
  /QEMU|Standard PC/,
);
const text = (path) => readFileSync(path, "utf8").trim();
assert.equal(text("/sys/class/block/vdc/serial"), "ELIZAOS-ADAPTER-TEST");
assert.equal(
  execFileSync("blockdev", ["--getsize64", "/dev/vdc"], {
    encoding: "utf8",
  }).trim(),
  String(80 * 1024 ** 3),
);
assert.equal(text("/sys/class/block/vda/serial"), "ELIZAOS-VM-ROOT");
assertUnmountedFixtureDisk("/dev/vdc");
execFileSync("sfdisk", ["/dev/vdc"], {
  input: "label: gpt\nstart=2048, size=8192, type=L\n",
});
execFileSync("udevadm", ["settle"]);
const table = () =>
  JSON.parse(
    execFileSync("sfdisk", ["--json", "/dev/vdc"], { encoding: "utf8" }),
  ).partitiontable;
const originalTable = table();
function disk(name) {
  const root = `/sys/class/block/${name}`;
  const serial = text(`${root}/serial`);
  return {
    stableId: `serial-${serial}`,
    path: `/dev/${name}`,
    kernelDeviceIdentity: `${text(`${root}/dev`)}:${text(`${root}/diskseq`)}`,
    sizeBytes: Number(text(`${root}/size`)) * 512,
    logicalSectorBytes: Number(text(`${root}/queue/logical_block_size`)),
    hardwareIdentity: { serial, firmwarePath: realpathSync(root) },
  };
}
const target = {
  ...disk("vdc"),
  partitionTable: "gpt",
  gptRedundancyVerified: true,
  bootAncestryResolved: true,
  currentBootSource: false,
  firmware: "uefi",
  partitions: originalTable.partitions.map((part) => ({
    id: part.node,
    startBytes: part.start * originalTable.sectorsize,
    endBytes: (part.start + part.size) * originalTable.sectorsize,
    mounted: false,
    role: "unknown",
    filesystem: "unknown",
  })),
  freeExtents: [
    {
      id: "free",
      startBytes: 64 * 1024 ** 2,
      endBytes: 80 * 1024 ** 3 - 1024 ** 2,
    },
  ],
};
target.hardwareIdentity.gptDiskGuid = originalTable.id.toLowerCase();
const request = {
  mode: "erase-disk",
  targetStableId: target.stableId,
  expectedSizeBytes: target.sizeBytes,
  confirmationToken: createDiskConfirmationToken(target),
};
const reviewed = createInstallPlan(request, target);
const now = Date.now();
const authorization = {
  planId: reviewed.planId,
  inventoryFingerprint: createDiskInventoryFingerprint(target),
  ownerId: "vm-qualification-owner",
  issuedAt: new Date(now - 1000).toISOString(),
  expiresAt: new Date(now + 600000).toISOString(),
  nonce: "vm-backup-qualification",
  credential: "fixture-credential",
};
// Fixture authorization exercises plan/inventory binding, not production logind
// or credential issuance. Native storage and device checks are real kernel I/O.
const plan = await authorizeInstallPlan(request, reviewed, authorization, {
  inventory: { inspect: async () => structuredClone(target) },
  authorization: { verify: async () => true },
});
const storage = {
  disk: disk("vda"),
  partitionPath: "/dev/vda1",
  directoryPath: "/root/adapter-backups",
};
mkdirSync(storage.directoryPath, { mode: 0o700 });
const native = createRequire(import.meta.url)(addon);
const backup = new NativeLinuxInstallDiskSession(plan, target, storage, native);
let receipt;
try {
  storage.directoryPath = "/root/mutated-caller-path";
  receipt = await backup.backupPartitionTable(target);
  assert.equal(receipt.storageStableId, storage.disk.stableId);
  assert.ok(receipt.location.startsWith("/root/adapter-backups/"));
  assert.equal(
    createHash("sha256").update(readFileSync(receipt.location)).digest("hex"),
    receipt.sha256,
  );
  assert.equal(await backup.verifyPartitionTableBackup(receipt, target), true);
  await assert.rejects(
    backup.verifyPartitionTableBackup(
      { ...receipt, location: "/root/elsewhere" },
      target,
    ),
    /receipt/,
  );
  await assert.rejects(
    backup.verifyPartitionTableBackup(receipt, {
      ...target,
      kernelDeviceIdentity: "8:16:99",
    }),
    /identity changed/,
  );
  const changedLayout = structuredClone(target);
  changedLayout.hardwareIdentity.gptDiskGuid =
    "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  assert.equal(
    await backup.verifyPartitionTableBackup(receipt, changedLayout),
    true,
  );
  await assert.rejects(
    backup.backupPartitionTable(changedLayout),
    /layout changed/,
  );
} finally {
  await backup.close();
}
await assert.rejects(
  backup.verifyPartitionTableBackup(receipt, target),
  /closed/,
);
assert.deepEqual(table(), originalTable);
// GPT receipts cover metadata only, not filesystem or payload completion.
const editStorage = { ...storage, directoryPath: "/root/adapter-backups" };
const editing = new NativeLinuxInstallDiskSession(
  plan,
  target,
  editStorage,
  native,
);
// A filesystem fixture stands in for bytes authenticated by the release
// producer. This proves preservation and expansion, not publisher signing.
const factoryTree = "/root/factory-tree";
mkdirSync(`${factoryTree}/etc`, { recursive: true });
mkdirSync(`${factoryTree}/usr/share/elizaos`, { recursive: true });
const payload = Buffer.from("factory payload\n".repeat(4096));
writeFileSync(`${factoryTree}/usr/share/elizaos/payload`, payload, {
  mode: 0o640,
});
linkSync(
  `${factoryTree}/usr/share/elizaos/payload`,
  `${factoryTree}/usr/share/elizaos/payload-link`,
);
symlinkSync("../usr/share/elizaos/payload", `${factoryTree}/etc/payload-link`);
writeFileSync(`${factoryTree}/etc/os-release`, "ID=elizaos\nNAME=elizaOS\n");
const seedPath = `${editStorage.directoryPath}/factory.partial`;
execFileSync("truncate", ["-s", "128M", seedPath]);
chmodSync(seedPath, 0o600);
execFileSync("mkfs.ext4", [
  "-q",
  "-F",
  "-b",
  "4096",
  "-d",
  factoryTree,
  seedPath,
]);
const seedUuid = execFileSync(
  "blkid",
  ["-p", "-s", "UUID", "-o", "value", seedPath],
  { encoding: "utf8" },
).trim();
const seedSha = execFileSync("sha256sum", [seedPath], {
  encoding: "utf8",
}).split(" ")[0];
renameSync(seedPath, `${editStorage.directoryPath}/${seedSha}.img`);
const factorySource = {
  sha256: seedSha,
  sizeBytes: 128 * 1024 ** 2,
  storageStableId: editStorage.disk.stableId,
};
const recoveryPartition = plan.actions.find(
  (action) =>
    action.type === "create-partition" && action.partition.role === "recovery",
).partition;
for (const overrides of [
  { sizeBytes: factorySource.sizeBytes + 1 },
  { storageStableId: "wrong-storage" },
  { sha256: "../escape" },
]) {
  await assert.rejects(
    buildFilesystemImage(
      editStorage,
      recoveryPartition,
      target.logicalSectorBytes,
      undefined,
      { ...factorySource, ...overrides },
    ),
    /Factory source requires/,
  );
}
const wrongFactoryDigest = "ef".repeat(32);
const wrongFactoryPath = `${editStorage.directoryPath}/${wrongFactoryDigest}.img`;
copyFileSync(`${editStorage.directoryPath}/${seedSha}.img`, wrongFactoryPath);
chmodSync(wrongFactoryPath, 0o600);
try {
  await assert.rejects(
    buildFilesystemImage(
      editStorage,
      recoveryPartition,
      target.logicalSectorBytes,
      undefined,
      { ...factorySource, sha256: wrongFactoryDigest },
    ),
    (error) => error.code === "ELIZAOS_FILESYSTEM_IMAGE_ERROR",
  );
} finally {
  unlinkSync(wrongFactoryPath);
}
assert.deepEqual(table(), originalTable);
const efiTree = "/root/efi-tree";
for (const dir of [
  "EFI/BOOT",
  "EFI/debian",
  "grub",
  "elizaos/kernel",
  "elizaos-recovery",
])
  mkdirSync(`${efiTree}/${dir}`, { recursive: true });
const efiPayload = Buffer.from([0x4d, 0x5a, 0, 0xff, 1, 2, 3, 4]);
for (const name of ["BOOTx64.EFI", "GRUBx64.EFI"])
  writeFileSync(`${efiTree}/EFI/BOOT/${name}`, efiPayload);
writeFileSync(`${efiTree}/EFI/debian/grub.cfg`, "configfile /grub/grub.cfg\n");
writeFileSync(`${efiTree}/grub/grub.cfg`, "# original factory menu\n");
for (const name of [
  "elizaos/kernel/vmlinuz",
  "elizaos/microcode.initrd",
  "elizaos/initrd",
  "elizaos/kernel/modules.initrd",
  "elizaos-recovery/vmlinuz",
  "elizaos-recovery/initrd",
])
  writeFileSync(`${efiTree}/${name}`, `fixture ${name}\n`);
const efiSeedPath = `${editStorage.directoryPath}/efi-factory.partial`;
execFileSync("truncate", ["-s", "128M", efiSeedPath]);
chmodSync(efiSeedPath, 0o600);
execFileSync("mkfs.vfat", ["-F", "32", efiSeedPath]);
execFileSync("mcopy", [
  "-s",
  "-i",
  efiSeedPath,
  ...["EFI", "grub", "elizaos", "elizaos-recovery"].map(
    (dir) => `${efiTree}/${dir}`,
  ),
  "::/",
]);
const efiSeedSha = execFileSync("sha256sum", [efiSeedPath], {
  encoding: "utf8",
}).split(" ")[0];
renameSync(efiSeedPath, `${editStorage.directoryPath}/${efiSeedSha}.img`);
const factoryEfiSource = {
  sha256: efiSeedSha,
  sizeBytes: 128 * 1024 ** 2,
  storageStableId: editStorage.disk.stableId,
};
const bootEvidence = [];
const factoryPayloadEvidence = [];
const editReceipts = [];
const filesystemReceipts = [];
try {
  await editing.verifyPartitionTableBackup(receipt, target);
  const actions = plan.actions.filter((action) =>
    ["erase-partition-table", "create-partition"].includes(action.type),
  );
  await assert.rejects(
    editing.applyGptEdit(actions[1], target, receipt),
    /next partition operation/,
  );
  let previousTable = table();
  for (const action of actions) {
    const result = await editing.applyGptEdit(action, target, receipt);
    assert.ok(result.bytesWritten > 0);
    const actual = table();
    if (action.type === "erase-partition-table") {
      assert.equal(actual.partitions?.length ?? 0, 0);
      assert.notEqual(actual.id, originalTable.id);
    } else {
      assert.deepEqual(
        actual.partitions.slice(0, -1),
        previousTable.partitions ?? [],
      );
      const added = actual.partitions.find(
        (part) => part.node === `/dev/vdc${result.partitionIndex}`,
      );
      assert.ok(added);
      assert.equal(
        added.start * actual.sectorsize,
        action.partition.startBytes,
      );
      assert.equal(
        (added.start + added.size) * actual.sectorsize,
        action.partition.endBytes,
      );
      assert.equal(
        added.name,
        {
          esp: "elizaos-esp",
          recovery: "elizaos-recovery",
          root: "elizaos-system",
          state: "elizaos-home",
        }[action.partition.role],
      );
      assert.equal(
        added.type.toUpperCase(),
        action.partition.role === "esp"
          ? "C12A7328-F81F-11D2-BA4B-00A0C93EC93B"
          : action.partition.role === "state"
            ? "933AC7E1-2EB4-4F13-B844-0E14E2AEF915"
            : "0FC63DAF-8483-4772-8E79-3D69D8477DE4",
      );
    }
    assert.equal(actual.partitions?.length ?? 0, result.partitionCount);
    await editing.verifyPartitionTableBackup(receipt, target);
    editReceipts.push({ action: action.type, ...result });
    previousTable = actual;
  }
  await assert.rejects(
    editing.applyGptEdit(actions[0], target, receipt),
    /next partition operation/,
  );
  const filesystemActions = actions.filter(
    (item) =>
      item.type === "create-partition" &&
      ["esp", "recovery"].includes(item.partition.role),
  );
  filesystemActions.sort(
    (a, b) =>
      Number(a.partition.role === "esp") - Number(b.partition.role === "esp"),
  );
  for (const action of filesystemActions) {
    const sourceReference = {
      ...(action.partition.role === "recovery"
        ? factorySource
        : factoryEfiSource),
    };
    const boot =
      action.partition.role === "esp"
        ? {
            architecture: "x86_64",
            kernelArguments: ["console=tty0", "console=ttyS0,115200n8"],
            rootUuid: "11111111-2222-4333-8444-555555555555",
            recoveryUuid: filesystemReceipts.find(
              (item) => item.role === "recovery",
            ).artifact.uuid,
            kernelPath: "/elizaos/kernel/vmlinuz",
            initrdPaths: [
              "/elizaos/microcode.initrd",
              "/elizaos/initrd",
              "/elizaos/kernel/modules.initrd",
            ],
            recoveryKernelPath: "/elizaos-recovery/vmlinuz",
            recoveryInitrdPaths: ["/elizaos-recovery/initrd"],
          }
        : undefined;
    if (boot) {
      const published = () =>
        readdirSync(editStorage.directoryPath)
          .filter((name) => name.endsWith(".img"))
          .sort();
      const before = published();
      await assert.rejects(
        buildFilesystemImage(
          editStorage,
          action.partition,
          target.logicalSectorBytes,
          undefined,
          sourceReference,
          { ...boot, kernelPath: "/missing-kernel" },
        ),
        (error) => error.code === "ELIZAOS_FILESYSTEM_IMAGE_ERROR",
      );
      assert.deepEqual(
        published(),
        before,
        "missing boot assets must not publish an ESP image",
      );
    }
    const preparation = buildFilesystemImage(
      editStorage,
      action.partition,
      target.logicalSectorBytes,
      undefined,
      sourceReference,
      boot,
    );
    if (sourceReference) {
      sourceReference.sha256 = "ff".repeat(32);
      sourceReference.sizeBytes = 0;
      sourceReference.storageStableId = "mutated-caller-reference";
    }
    const artifact = await preparation;
    const installed = await editing.writePartitionImage(
      action.partition,
      artifact,
      target,
      receipt,
    );
    const node = `/dev/vdc${installed.partitionIndex}`;
    const type = execFileSync(
      "blkid",
      ["-p", "-s", "TYPE", "-o", "value", node],
      { encoding: "utf8" },
    ).trim();
    assert.equal(type, artifact.filesystem === "fat32" ? "vfat" : "ext4");
    const uuid = execFileSync(
      "blkid",
      ["-p", "-s", "UUID", "-o", "value", node],
      { encoding: "utf8" },
    ).trim();
    assert.equal(uuid, artifact.uuid);
    execFileSync(
      artifact.filesystem === "fat32" ? "fsck.fat" : "e2fsck",
      artifact.filesystem === "fat32" ? ["-n", node] : ["-f", "-n", node],
    );
    if (boot) {
      const actualMenu = execFileSync(
        "mtype",
        ["-i", node, "::/grub/grub.cfg"],
        { encoding: "utf8" },
      );
      assert.equal(actualMenu, renderInstalledGrubConfiguration(boot));
      for (const name of ["BOOTx64.EFI", "GRUBx64.EFI"])
        assert.deepEqual(
          execFileSync("mtype", ["-i", node, `::/EFI/BOOT/${name}`]),
          efiPayload,
        );
      assert.equal(
        execFileSync(
          "sha256sum",
          [`${editStorage.directoryPath}/${efiSeedSha}.img`],
          { encoding: "utf8" },
        ).split(" ")[0],
        efiSeedSha,
      );
      bootEvidence.push({
        sourceSha256: efiSeedSha,
        menu: actualMenu,
        copiedEfiBytesVerified: true,
        missingPayloadRejected: true,
        sourceUnchanged: true,
        scope:
          "filesystem fixture; EFI bytes are not executable firmware and root UUID is a fixture",
      });
    }
    if (action.partition.role === "recovery") {
      assert.equal(artifact.sourceSha256, seedSha);
      assert.notEqual(artifact.uuid, seedUuid);
      const debug = (command) =>
        execFileSync("debugfs", ["-R", command, node], { encoding: "utf8" });
      assert.equal(debug("cat /etc/os-release"), "ID=elizaos\nNAME=elizaOS\n");
      assert.equal(debug("cat /usr/share/elizaos/payload"), payload.toString());
      const original = debug("stat /usr/share/elizaos/payload");
      const linked = debug("stat /usr/share/elizaos/payload-link");
      assert.match(original, /Mode:\s+0640/);
      assert.match(original, /Inode:\s+\d+/);
      assert.match(linked, /Inode:\s+\d+/);
      assert.equal(
        original.match(/Inode:\s+(\d+)/)?.[1],
        linked.match(/Inode:\s+(\d+)/)?.[1],
      );
      assert.match(
        debug("stat /etc/payload-link"),
        /Fast link dest: "..\/usr\/share\/elizaos\/payload"/,
      );
      const header = execFileSync("dumpe2fs", ["-h", node], {
        encoding: "utf8",
      });
      const blocks = Number(header.match(/^Block count:\s+(\d+)/m)?.[1]);
      const blockSize = Number(header.match(/^Block size:\s+(\d+)/m)?.[1]);
      assert.equal(
        blocks * blockSize,
        artifact.sizeBytes,
        "filesystem must expand to the complete reviewed partition",
      );
      assert.equal(
        execFileSync(
          "sha256sum",
          [`${editStorage.directoryPath}/${seedSha}.img`],
          { encoding: "utf8" },
        ).split(" ")[0],
        seedSha,
      );
      factoryPayloadEvidence.push({
        sourceSha256: seedSha,
        sourceUuid: seedUuid,
        installedUuid: artifact.uuid,
        payloadBytes: payload.length,
        filesystemBytes: blocks * blockSize,
        hardlinksPreserved: true,
        symlinkPreserved: true,
        modePreserved: true,
        sourceUnchanged: true,
      });
    }
    await editing.verifyPartitionTableBackup(receipt, target);
    filesystemReceipts.push({
      role: action.partition.role,
      artifact,
      installed,
      detectedType: type,
      uuid,
    });
  }
} finally {
  await editing.close();
}
assert.equal(
  createHash("sha256").update(readFileSync(receipt.location)).digest("hex"),
  receipt.sha256,
);
// Exercise failure and cancellation through the real asynchronous native worker.
function identity(info) {
  const [major, minor, sequence] = info.kernelDeviceIdentity.split(":");
  const result = Buffer.alloc(32);
  result.writeUInt32LE(Number(major), 0);
  result.writeUInt32LE(Number(minor), 4);
  result.writeBigUInt64LE(BigInt(sequence), 8);
  result.writeBigUInt64LE(BigInt(info.sizeBytes), 16);
  result.writeUInt32LE(info.logicalSectorBytes, 24);
  return result;
}
const raw = native.openDiskSession(
  target.path,
  identity(target),
  editStorage.disk.path,
  identity(editStorage.disk),
  editStorage.partitionPath,
  editStorage.directoryPath,
);
const imageBinding = createHash("sha256")
  .update("native-image-fault-fixture")
  .digest();
const currentDigest = raw.backup(imageBinding);
const artifact = filesystemReceipts.find(
  (item) => item.role === "esp",
).artifact;
const imageRequest = (overrides = {}) => {
  const values = {
    partitionIndex: 1,
    sizeBytes: artifact.sizeBytes,
    expiresAt: Date.now() + 600000,
    sha256: artifact.sha256,
    ...overrides,
  };
  const result = Buffer.alloc(56);
  result.writeUInt32LE(values.partitionIndex, 0);
  result.writeBigUInt64LE(BigInt(values.sizeBytes), 8);
  result.writeBigUInt64LE(BigInt(values.expiresAt), 16);
  Buffer.from(values.sha256, "hex").copy(result, 24);
  return result;
};
const imageFailures = [];
const rejectBeforeWrite = async (name, request, digest = currentDigest) => {
  await assert.rejects(
    raw.writeImage(imageBinding, currentDigest, digest, request),
    (error) =>
      error.code === "ELIZAOS_INSTALL_DISK_ERROR" &&
      /write attempted=0 bytes=0/.test(error.message),
  );
  raw.verify(imageBinding, currentDigest);
  imageFailures.push(name);
};
try {
  await rejectBeforeWrite(
    "missing-source",
    imageRequest({ sha256: "ab".repeat(32) }),
  );
  await rejectBeforeWrite(
    "wrong-size",
    imageRequest({ sizeBytes: artifact.sizeBytes - 4096 }),
  );
  await rejectBeforeWrite("stale-gpt", imageRequest(), Buffer.alloc(32, 1));
  await rejectBeforeWrite(
    "expired-authorization",
    imageRequest({ expiresAt: Date.now() - 1 }),
  );
  const sourcePath = `${editStorage.directoryPath}/${artifact.sha256}.img`;
  chmodSync(sourcePath, 0o644);
  try {
    await rejectBeforeWrite("unsafe-source-mode", imageRequest());
  } finally {
    chmodSync(sourcePath, 0o600);
  }
  const wrongDigest = "cd".repeat(32);
  const wrongPath = `${editStorage.directoryPath}/${wrongDigest}.img`;
  copyFileSync(sourcePath, wrongPath);
  chmodSync(wrongPath, 0o600);
  try {
    await rejectBeforeWrite(
      "wrong-source-digest",
      imageRequest({ sha256: wrongDigest }),
    );
  } finally {
    unlinkSync(wrongPath);
  }

  assert.equal(
    execFileSync("sha256sum", ["/dev/vdc1"], { encoding: "utf8" }).split(
      " ",
    )[0],
    artifact.sha256,
    "rejected operations must preserve every byte of the existing ESP",
  );
  const esp = plan.actions.find(
    (action) =>
      action.type === "create-partition" && action.partition.role === "esp",
  ).partition;
  const replacement = await buildFilesystemImage(
    editStorage,
    esp,
    target.logicalSectorBytes,
  );
  assert.notEqual(replacement.sha256, artifact.sha256);
  const observer = openSync(target.path, "r");
  try {
    const before = Buffer.alloc(4096);
    assert.equal(
      readSync(observer, before, 0, before.length, esp.startBytes),
      before.length,
    );
    let finished = false;
    const operation = raw.writeImage(
      imageBinding,
      currentDigest,
      currentDigest,
      imageRequest({ sha256: replacement.sha256 }),
    );
    // Attach rejection handling immediately, before polling the target.
    const outcome = operation
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      )
      .finally(() => {
        finished = true;
      });
    assert.throws(() => raw.close(), /busy|active/i);
    const deadline = Date.now() + 120000;
    let observedWrite = false;
    while (!finished && Date.now() < deadline) {
      const head = Buffer.alloc(4096);
      assert.equal(
        readSync(observer, head, 0, head.length, esp.startBytes),
        head.length,
      );
      if (!head.equals(before)) {
        observedWrite = true;
        break;
      }
      await delay(1);
    }
    raw.cancelImageWrite();
    const result = await outcome;
    assert.equal(
      observedWrite,
      true,
      "must observe actual target writes before cancellation",
    );
    assert.ok(result.error, "cancelled worker must reject after settling I/O");
    assert.equal(result.error.code, "ELIZAOS_INSTALL_DISK_ERROR");
    assert.match(result.error.message, /Operation canceled/);
    assert.match(result.error.message, /write attempted=1 bytes=[1-9][0-9]*/);
    assert.match(result.error.message, /settle error=0/);
    raw.verify(imageBinding, currentDigest);
    assert.throws(
      () =>
        raw.writeImage(
          imageBinding,
          currentDigest,
          currentDigest,
          imageRequest(),
        ),
      /requires explicit recovery/,
    );
    imageFailures.push(
      "cancel-after-observed-target-write-settles-and-requires-recovery",
    );
  } finally {
    closeSync(observer);
  }
} finally {
  raw.close();
}
writeFileSync(
  evidence,
  `${JSON.stringify({ success: true, sectorBytes: target.logicalSectorBytes, receipt, editReceipts, filesystemReceipts, factoryPayloadEvidence, bootEvidence, imageFailures, runtime: process.version, cases: ["real-native-adapter-backup-readback", "original-config-retained", "changed-receipt-and-incarnation-refused", "backup-binding-survives-layout-change", "closed-session-refused", "backup-only-phase-partition-table-unchanged", "real-reviewed-erase-and-four-partition-creates", "original-backup-preserved-after-mutations", "unreviewed-and-repeated-edits-refused", "real-fat32-and-ext4-images-installed-and-independently-fsck-verified"] }, null, 2)}\n`,
);

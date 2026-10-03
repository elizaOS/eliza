import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import {
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { inspect } from "node:util";
import {
  buildFilesystemImage,
  prepareInstallationFilesystems,
  produceFactoryManifest,
  renderInstalledFstab,
  stageFactorySources,
  verifyFactoryManifest,
} from "/inputs/installer.mjs";

const [evidence] = process.argv.slice(2);
inspect.defaultOptions.depth = 20;
assert.ok(evidence);
assert.match(
  readFileSync("/sys/class/dmi/id/product_name", "utf8"),
  /QEMU|Standard PC/,
);
const sector = Number(
  readFileSync("/sys/class/block/vdb/queue/logical_block_size", "utf8").trim(),
);
assert.ok([512, 4096].includes(sector));
const directory = "/root/factory-producer";
mkdirSync(directory, { mode: 0o700 });
const image = `${directory}/factory.raw`;
const size = 640 * 1024 ** 2;
writeFileSync(image, "", { flag: "wx", mode: 0o600 });
truncateSync(image, size);
const espOffset = 1024 ** 2;
const recoveryOffset = 513 * 1024 ** 2;
execFileSync("sfdisk", ["--sector-size", String(sector), image], {
  input: `label: gpt\nstart=${espOffset / sector},size=${(512 * 1024 ** 2) / sector},type=U,name=elizaos-esp\nstart=${recoveryOffset / sector},size=${(64 * 1024 ** 2) / sector},type=L,name=elizaos-recovery\n`,
});
const esp = `${directory}/esp.img`;
const recovery = `${directory}/recovery.img`;
for (const [file, bytes] of [
  [esp, 512 * 1024 ** 2],
  [recovery, 64 * 1024 ** 2],
]) {
  writeFileSync(file, "", { flag: "wx", mode: 0o600 });
  truncateSync(file, bytes);
}
execFileSync("mkfs.vfat", ["-F", "32", "-S", String(sector), esp]);
execFileSync("mkfs.ext4", ["-q", "-F", "-b", "4096", recovery]);
for (const path of ["/etc", "/home", "/efi"])
  execFileSync("debugfs", ["-w", "-R", `mkdir ${path}`, recovery]);
const factoryFstab = `${directory}/factory.fstab`;
writeFileSync(
  factoryFstab,
  "# /etc/fstab: static file system information.\n\n",
);
execFileSync("debugfs", [
  "-w",
  "-R",
  `write ${factoryFstab} /etc/fstab`,
  recovery,
]);
const marker = `${directory}/factory-version`;
writeFileSync(marker, "authenticated factory fixture\n");
execFileSync("debugfs", [
  "-w",
  "-R",
  `write ${marker} /factory-version`,
  recovery,
]);
const tree = `${directory}/boot`;
for (const name of [
  "EFI/BOOT",
  "EFI/debian",
  "grub",
  "elizaos",
  "elizaos-recovery",
])
  mkdirSync(`${tree}/${name}`, { recursive: true });
for (const name of [
  "EFI/BOOT/BOOTx64.EFI",
  "EFI/BOOT/GRUBx64.EFI",
  "elizaos/vmlinuz",
  "elizaos/initrd",
  "elizaos-recovery/vmlinuz",
  "elizaos-recovery/initrd",
])
  writeFileSync(`${tree}/${name}`, `fixture ${name}\n`);
writeFileSync(`${tree}/EFI/debian/grub.cfg`, "configfile /grub/grub.cfg\n");
writeFileSync(`${tree}/grub/grub.cfg`, "set timeout=0\n");
execFileSync("mcopy", [
  "-s",
  "-i",
  esp,
  `${tree}/EFI`,
  `${tree}/grub`,
  `${tree}/elizaos`,
  `${tree}/elizaos-recovery`,
  "::/",
]);
for (const [source, offset] of [
  [esp, espOffset],
  [recovery, recoveryOffset],
])
  execFileSync("dd", [
    `if=${source}`,
    `of=${image}`,
    "bs=4M",
    "oflag=seek_bytes",
    `seek=${offset}`,
    "conv=notrunc,sparse",
    "status=none",
  ]);
const fd = openSync(image, "r+");
fsyncSync(fd);
async function hash(file) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}
const before = await hash(image);
const keys = generateKeyPairSync("ed25519");
const options = {
  imagePath: image,
  outputDirectory: `${directory}/valid`,
  logicalSectorBytes: sector,
  privateKey: keys.privateKey,
  publicKey: keys.publicKey,
  version: "fixture-1",
  sequence: 12,
  expires: new Date(Date.now() + 86400000).toISOString(),
  boot: {
    architecture: "x86_64",
    kernelArguments: ["console=tty0"],
    kernelPath: "/elizaos/vmlinuz",
    initrdPaths: ["/elizaos/initrd"],
    recoveryKernelPath: "/elizaos-recovery/vmlinuz",
    recoveryInitrdPaths: ["/elizaos-recovery/initrd"],
  },
};
const receipt = await produceFactoryManifest(options);
const bytes = readFileSync(`${options.outputDirectory}/factory-manifest.json`);
const signature = readFileSync(
  `${options.outputDirectory}/factory-manifest.json.sig`,
);
const verified = verifyFactoryManifest(bytes, signature, {
  architecture: "x86_64",
  minimumSequence: 12,
  publicKey: keys.publicKey,
});
assert.equal(verified.manifest.esp.sha256, await hash(esp));
assert.equal(verified.manifest.esp.sizeBytes, 512 * 1024 ** 2);
assert.equal(verified.manifest.recovery.sha256, await hash(recovery));
assert.equal(verified.manifest.recovery.sizeBytes, 64 * 1024 ** 2);
assert.equal(receipt.imageSha256, before);
assert.equal(receipt.manifestSha256, verified.sha256);
const cases = ["real-GPT-filesystem-inspection-and-signed-partition-hashes"];
async function refused(name, overrides) {
  const outputDirectory = `${directory}/${name}`;
  await assert.rejects(
    produceFactoryManifest({ ...options, outputDirectory, ...overrides }),
    (error) => error.code === "ELIZAOS_FACTORY_MANIFEST_PRODUCTION_ERROR",
  );
  assert.equal(existsSync(outputDirectory), false);
  cases.push(name);
}
for (const [name, offset] of [
  ["corrupt-primary-GPT", sector + 16],
  ["corrupt-backup-GPT", size - sector + 16],
]) {
  const byte = Buffer.alloc(1);
  assert.equal(readSync(fd, byte, 0, 1, offset), 1);
  byte[0] ^= 1;
  writeSync(fd, byte, 0, 1, offset);
  try {
    await refused(name, {});
  } finally {
    byte[0] ^= 1;
    writeSync(fd, byte, 0, 1, offset);
  }
}
symlinkSync(image, `${directory}/linked.raw`);
await refused("source-symlink", { imagePath: `${directory}/linked.raw` });
await refused("missing-boot-file", {
  boot: { ...options.boot, kernelPath: "/missing" },
});
await refused("wrong-signing-key", {
  privateKey: generateKeyPairSync("ed25519").privateKey,
});
await refused("cancelled", {
  signal: AbortSignal.abort(new Error("fixture cancellation")),
});
await assert.rejects(
  produceFactoryManifest(options),
  (error) => error.code === "ELIZAOS_FACTORY_MANIFEST_PRODUCTION_ERROR",
);
assert.deepEqual(
  readFileSync(`${options.outputDirectory}/factory-manifest.json`),
  bytes,
);
cases.push("existing-output-preserved");
const sourceHandle = await open(image, "r");
const store = `${directory}/store`;
mkdirSync(store, { mode: 0o700 });
const stageOptions = {
  manifest: bytes,
  signature,
  policy: {
    architecture: "x86_64",
    minimumSequence: 12,
    publicKey: keys.publicKey,
  },
  sources: {
    esp: { file: sourceHandle, offsetBytes: espOffset },
    recovery: { file: sourceHandle, offsetBytes: recoveryOffset },
  },
  storage: { disk: { stableId: "fixture-storage" }, directoryPath: store },
};
const installPartitions = [
  {
    role: "esp",
    startBytes: 1024 ** 2,
    endBytes: 513 * 1024 ** 2,
    filesystem: "fat32",
  },
  {
    role: "recovery",
    startBytes: 513 * 1024 ** 2,
    endBytes: 577 * 1024 ** 2,
    filesystem: "ext4",
  },
  {
    role: "root",
    startBytes: 577 * 1024 ** 2,
    endBytes: 705 * 1024 ** 2,
    filesystem: "ext4",
  },
  {
    role: "state",
    startBytes: 705 * 1024 ** 2,
    endBytes: 769 * 1024 ** 2,
    filesystem: "ext4",
  },
];
const staging = prepareInstallationFilesystems(
  stageOptions,
  installPartitions,
  sector,
);
stageOptions.sources.esp.offsetBytes = 0;
const staged = await staging;
stageOptions.sources.esp.offsetBytes = espOffset;
for (const role of ["esp", "recovery"]) {
  const reference = staged.sources[role];
  assert.equal(reference.sha256, verified.manifest[role].sha256);
  assert.equal(reference.storageStableId, "fixture-storage");
  assert.equal(
    await hash(`${store}/${reference.sha256}.img`),
    reference.sha256,
  );
  assert.equal(Object.isFrozen(reference), true);
}
assert.equal(Object.isFrozen(staged.sources), true);
cases.push("authenticated-extents-staged-with-independent-readback");
cases.push("caller-source-extent-snapshotted-before-await");
const {
  root: prepared,
  esp: installedEsp,
  state: installedHome,
  recovery: installedRecovery,
} = staged.images;
const home = `${store}/${installedHome.sha256}.img`;
const mounts = {
  rootUuid: prepared.uuid,
  homeUuid: installedHome.uuid,
  espUuid: installedEsp.uuid,
};
assert.equal(Object.isFrozen(staged.images), true);
for (const artifact of Object.values(staged.images)) {
  assert.equal(Object.isFrozen(artifact), true);
  assert.equal(await hash(`${store}/${artifact.sha256}.img`), artifact.sha256);
}
assert.equal(
  new Set([prepared.uuid, installedHome.uuid, installedRecovery.uuid]).size,
  3,
);
const installedMenu = execFileSync(
  "mtype",
  ["-i", `${store}/${installedEsp.sha256}.img`, "::/grub/grub.cfg"],
  { encoding: "utf8" },
);
assert.ok(installedMenu.includes(`root=UUID=${prepared.uuid} rw`));
assert.ok(installedMenu.includes(`root=UUID=${installedRecovery.uuid} ro`));
cases.push(
  "four-prepared-filesystems-bind-root-home-efi-and-recovery-identities",
);
assert.equal(prepared.sourceSha256, verified.manifest.recovery.sha256);
assert.equal(prepared.sizeBytes, 128 * 1024 ** 2);
assert.equal(prepared.uuid, mounts.rootUuid);
assert.equal(
  execFileSync(
    "debugfs",
    ["-R", "cat /factory-version", `${store}/${prepared.sha256}.img`],
    { encoding: "utf8" },
  ),
  "authenticated factory fixture\n",
);
cases.push("signed-factory-source-to-expanded-installed-root-image");
assert.equal(
  execFileSync(
    "debugfs",
    ["-R", "cat /etc/fstab", `${store}/${prepared.sha256}.img`],
    { encoding: "utf8" },
  ),
  renderInstalledFstab(prepared.uuid, mounts),
);
assert.equal(
  execFileSync(
    "debugfs",
    ["-R", "cat /etc/machine-id", `${store}/${prepared.sha256}.img`],
    { encoding: "utf8" },
  ),
  "uninitialized\n",
);
cases.push("installed-root-preserves-systemd-first-boot-initialization");
const published = readdirSync(store)
  .filter((name) => name.endsWith(".img"))
  .sort();
await assert.rejects(
  buildFilesystemImage(
    stageOptions.storage,
    {
      role: "root",
      startBytes: 1024 ** 2,
      endBytes: 129 * 1024 ** 2,
      filesystem: "ext4",
    },
    sector,
    undefined,
    {
      sha256: prepared.sha256,
      sizeBytes: prepared.sizeBytes,
      storageStableId: prepared.storageStableId,
    },
    undefined,
    { ...mounts, rootUuid: randomUUID() },
  ),
  (error) => error.code === "ELIZAOS_FILESYSTEM_IMAGE_ERROR",
);
assert.deepEqual(
  readdirSync(store)
    .filter((name) => name.endsWith(".img"))
    .sort(),
  published,
);
assert.equal(await hash(`${store}/${prepared.sha256}.img`), prepared.sha256);
cases.push(
  "unused-factory-fstab-replaced-with-installed-UUIDs-and-custom-config-preserved",
);
if (sector === 4096) {
  const smallBlocks = `${store}/small-blocks.partial`;
  writeFileSync(smallBlocks, "", { mode: 0o600, flag: "wx" });
  truncateSync(smallBlocks, 64 * 1024 ** 2);
  execFileSync("mkfs.ext4", ["-q", "-F", "-b", "1024", smallBlocks]);
  const sha256 = await hash(smallBlocks);
  renameSync(smallBlocks, `${store}/${sha256}.img`);
  const beforeRefusal = readdirSync(store)
    .filter((name) => name.endsWith(".img"))
    .sort();
  await assert.rejects(
    buildFilesystemImage(
      stageOptions.storage,
      {
        role: "recovery",
        startBytes: 1024 ** 2,
        endBytes: 129 * 1024 ** 2,
        filesystem: "ext4",
      },
      sector,
      undefined,
      {
        sha256,
        sizeBytes: 64 * 1024 ** 2,
        storageStableId: prepared.storageStableId,
      },
    ),
    (error) =>
      error.code === "ELIZAOS_FILESYSTEM_IMAGE_ERROR" &&
      inspect(error).includes("block size is incompatible"),
  );
  assert.deepEqual(
    readdirSync(store)
      .filter((name) => name.endsWith(".img"))
      .sort(),
    beforeRefusal,
  );
  assert.equal(await hash(`${store}/${sha256}.img`), sha256);
  cases.push(
    "ext4-blocks-smaller-than-target-sectors-refused-before-publication",
  );
}
await assert.rejects(
  stageFactorySources(stageOptions),
  (error) => error.code === "ELIZAOS_FACTORY_SOURCE_ERROR",
);
for (const role of ["esp", "recovery"])
  assert.equal(
    await hash(`${store}/${staged.sources[role].sha256}.img`),
    staged.sources[role].sha256,
  );
cases.push("existing-staged-images-preserved");
async function refusedStage(name, overrides) {
  const destination = `${directory}/${name}`;
  mkdirSync(destination, { mode: 0o700 });
  await assert.rejects(
    stageFactorySources({
      ...stageOptions,
      storage: { ...stageOptions.storage, directoryPath: destination },
      ...overrides,
    }),
    (error) => error.code === "ELIZAOS_FACTORY_SOURCE_ERROR",
  );
  assert.deepEqual(
    readdirSync(destination).filter((name) => name.endsWith(".img")),
    [],
  );
  if (
    [
      "staging-wrong-signature",
      "staging-invalid-extent",
      "staging-cancelled",
    ].includes(name)
  )
    assert.deepEqual(readdirSync(destination), []);
  cases.push(name);
}
await refusedStage("staging-wrong-signature", { signature: Buffer.alloc(64) });
await refusedStage("staging-wrong-extent", {
  sources: {
    ...stageOptions.sources,
    esp: { file: sourceHandle, offsetBytes: espOffset + 4096 },
  },
});
await refusedStage("staging-invalid-extent", {
  sources: {
    ...stageOptions.sources,
    esp: { file: sourceHandle, offsetBytes: -1 },
  },
});
await refusedStage("staging-cancelled", {
  signal: AbortSignal.abort(new Error("cancelled")),
});
const cancellation = new AbortController();
const read = sourceHandle.read.bind(sourceHandle);
sourceHandle.read = async (...args) => {
  const result = await read(...args);
  cancellation.abort(new Error("cancelled after source read"));
  return result;
};
await refusedStage("staging-cancelled-during-copy", {
  signal: cancellation.signal,
});
sourceHandle.read = read;
await sourceHandle.close();
const loop = execFileSync(
  "losetup",
  [
    "--find",
    "--show",
    "--read-only",
    "--partscan",
    "--sector-size",
    String(sector),
    image,
  ],
  { encoding: "utf8" },
).trim();
try {
  const block = await open(loop, "r");
  try {
    const blockStore = `${directory}/block-store`;
    mkdirSync(blockStore, { mode: 0o700 });
    const result = await stageFactorySources({
      ...stageOptions,
      storage: { ...stageOptions.storage, directoryPath: blockStore },
      sources: {
        esp: { file: block, offsetBytes: espOffset },
        recovery: { file: block, offsetBytes: recoveryOffset },
      },
    });
    for (const role of ["esp", "recovery"])
      assert.equal(
        await hash(`${blockStore}/${result.sources[role].sha256}.img`),
        verified.manifest[role].sha256,
      );
    cases.push("read-only-block-source-staged-with-independent-readback");
  } finally {
    await block.close();
  }
  const installedLoops = [];
  const mountpoint = `${directory}/installed-mounts`;
  mkdirSync(mountpoint);
  const fstabPath = `${directory}/installed.fstab`;
  writeFileSync(fstabPath, renderInstalledFstab(prepared.uuid, mounts));
  try {
    for (const file of [
      `${store}/${prepared.sha256}.img`,
      home,
      `${store}/${installedEsp.sha256}.img`,
    ])
      installedLoops.push(
        execFileSync(
          "losetup",
          [
            "--find",
            "--show",
            "--read-only",
            "--sector-size",
            String(sector),
            file,
          ],
          { encoding: "utf8" },
        ).trim(),
      );
    execFileSync("udevadm", ["settle"]);
    for (const target of ["/", "/home", "/efi"])
      execFileSync("mount", [
        "--read-only",
        "--fstab",
        fstabPath,
        "--target-prefix",
        mountpoint,
        "--target",
        target,
      ]);
    for (const [suffix, uuid] of [
      ["", prepared.uuid],
      ["/home", mounts.homeUuid],
      ["/efi", installedEsp.uuid],
    ])
      assert.equal(
        execFileSync(
          "findmnt",
          [
            "--noheadings",
            "--output",
            "UUID",
            "--mountpoint",
            `${mountpoint}${suffix}`,
          ],
          { encoding: "utf8" },
        )
          .trim()
          .toLowerCase(),
        uuid.toLowerCase(),
      );
    assert.equal(
      readFileSync(`${mountpoint}/factory-version`, "utf8"),
      "authenticated factory fixture\n",
    );
    cases.push(
      "installed-fstab-mounts-correct-filesystems-with-factory-disk-attached",
    );
  } finally {
    for (const suffix of ["/efi", "/home", ""]) {
      const mounted = spawnSync("findmnt", [
        "--mountpoint",
        `${mountpoint}${suffix}`,
      ]);
      if (mounted.status === 0)
        execFileSync("umount", [`${mountpoint}${suffix}`]);
      else assert.equal(mounted.status, 1);
    }
    for (const device of installedLoops.reverse())
      execFileSync("losetup", ["--detach", device]);
  }
  for (const artifact of [prepared, installedEsp])
    assert.equal(
      await hash(`${store}/${artifact.sha256}.img`),
      artifact.sha256,
    );
} finally {
  execFileSync("losetup", ["--detach", loop]);
}
assert.equal(await hash(image), before);
closeSync(fd);
writeFileSync(
  evidence,
  `${JSON.stringify({ success: true, sectorBytes: sector, receipt, publicKeySpkiBase64: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"), manifest: verified.manifest, cases, scope: "regular-image filesystem fixtures and ephemeral signing key; no firmware boot or production publishing claim" }, null, 2)}\n`,
);

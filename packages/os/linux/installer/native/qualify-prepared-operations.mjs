// Runs only inside the disposable disk-session VM, after factory qualification.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { createRequire } from "node:module";
import {
  authorizeInstallPlan,
  createDiskConfirmationToken,
  createDiskInventoryFingerprint,
  createInstallPlan,
  DurableFileInstallJournal,
  Ed25519OwnerAuthorizationVerifier,
  executeAuthorizedInstallPlan,
  ownerAuthorizationPayload,
  PreparedInstallOperationFactory,
} from "/inputs/installer.mjs";
import { assertUnmountedFixtureDisk } from "./qualification-inventory.mjs";

const [addon, factoryEvidence, output] = process.argv.slice(2);
assert.ok(addon && factoryEvidence && output);
assert.equal(process.getuid(), 0);
const text = (path) => readFileSync(path, "utf8").trim();
assert.match(text("/sys/class/dmi/id/product_name"), /QEMU|Standard PC/);
assert.equal(text("/sys/class/block/vdc/serial"), "ELIZAOS-ADAPTER-TEST");
assert.equal(text("/sys/class/block/vda/serial"), "ELIZAOS-VM-ROOT");
const command = (name, args) =>
  execFileSync(name, args, { encoding: "utf8" }).trim();
assert.equal(
  command("blockdev", ["--getsize64", "/dev/vdc"]),
  String(80 * 1024 ** 3),
);
function identity(name) {
  const sys = `/sys/class/block/${name}`;
  const serial = text(`${sys}/serial`);
  return {
    stableId: `serial-${serial}`,
    path: `/dev/${name}`,
    kernelDeviceIdentity: `${text(`${sys}/dev`)}:${text(`${sys}/diskseq`)}`,
    sizeBytes: Number(text(`${sys}/size`)) * 512,
    logicalSectorBytes: Number(text(`${sys}/queue/logical_block_size`)),
    hardwareIdentity: { serial, firmwarePath: realpathSync(sys) },
  };
}
assertUnmountedFixtureDisk("/dev/vdc");
execFileSync("sfdisk", ["/dev/vdc"], {
  input: "label: gpt\nstart=2048, size=8192, type=L\n",
});
command("udevadm", ["settle"]);
function inspect() {
  assertUnmountedFixtureDisk("/dev/vdc");
  command("sfdisk", ["--verify", "/dev/vdc"]);
  const table = JSON.parse(
    command("sfdisk", ["--json", "/dev/vdc"]),
  ).partitiontable;
  const disk = identity("vdc");
  const partitions = (table.partitions ?? []).map((part) => {
    const probe = spawnSync(
      "blkid",
      ["-p", "-s", "TYPE", "-o", "value", part.node],
      { encoding: "utf8" },
    );
    assert.ok([0, 2].includes(probe.status), probe.stderr);
    const type = probe.stdout.trim();
    return {
      id: part.node,
      startBytes: part.start * table.sectorsize,
      endBytes: (part.start + part.size) * table.sectorsize,
      mounted: false,
      role:
        part.name === "elizaos-esp"
          ? "esp"
          : part.name === "elizaos-recovery"
            ? "recovery"
            : "data",
      filesystem: type === "vfat" ? "fat32" : type || "unknown",
      encryption: "none",
    };
  });
  const freeExtents = [];
  let cursor = 1024 ** 2;
  for (const part of [...partitions].sort(
    (a, b) => a.startBytes - b.startBytes,
  )) {
    if (part.startBytes > cursor)
      freeExtents.push({
        id: `free-${cursor}`,
        startBytes: cursor,
        endBytes: part.startBytes,
      });
    cursor = part.endBytes;
  }
  if (cursor < disk.sizeBytes - 1024 ** 2)
    freeExtents.push({
      id: `free-${cursor}`,
      startBytes: cursor,
      endBytes: disk.sizeBytes - 1024 ** 2,
    });
  return {
    ...disk,
    hardwareIdentity: {
      ...disk.hardwareIdentity,
      gptDiskGuid: table.id.toLowerCase(),
    },
    partitionTable: "gpt",
    gptRedundancyVerified: true,
    bootAncestryResolved: true,
    currentBootSource: false,
    firmware: "uefi",
    partitions,
    freeExtents,
  };
}
const target = inspect();
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
  ownerId: "vm-fixture-owner",
  issuedAt: new Date(now - 1000).toISOString(),
  expiresAt: new Date(now + 3600000).toISOString(),
  nonce: "vm-prepared-operations",
  credential: "",
};
// Ephemeral test issuer; production owner approval/provisioning is not qualified.
const ownerKeys = generateKeyPairSync("ed25519");
authorization.credential = `ed25519-v1:${sign(null, ownerAuthorizationPayload(authorization), ownerKeys.privateKey).toString("base64url")}`;
const dependencies = {
  inventory: { inspect: async () => inspect() },
  authorization: new Ed25519OwnerAuthorizationVerifier(async (ownerId) =>
    ownerId === authorization.ownerId ? ownerKeys.publicKey : null,
  ),
};
await assert.rejects(
  authorizeInstallPlan(
    request,
    reviewed,
    { ...authorization, nonce: "tampered" },
    dependencies,
  ),
  /credential verification failed/,
);
const plan = await authorizeInstallPlan(
  request,
  reviewed,
  authorization,
  dependencies,
);
const factory = JSON.parse(readFileSync(factoryEvidence, "utf8"));
assert.equal(factory.success, true);
const publicKey = createPublicKey({
  key: Buffer.from(factory.publicKeySpkiBase64, "base64"),
  format: "der",
  type: "spki",
});
const directory = "/root/prepared-operations";
mkdirSync(directory, { mode: 0o700 });
const source = await open("/root/factory-producer/factory.raw", "r");
let closed = false;
const selector = {
  open: async () => ({
    options: {
      manifest: readFileSync(
        "/root/factory-producer/valid/factory-manifest.json",
      ),
      signature: readFileSync(
        "/root/factory-producer/valid/factory-manifest.json.sig",
      ),
      policy: { architecture: "x86_64", minimumSequence: 12, publicKey },
      sources: {
        esp: { file: source, offsetBytes: 1024 ** 2 },
        recovery: { file: source, offsetBytes: 513 * 1024 ** 2 },
      },
      storage: {
        disk: identity("vda"),
        partitionPath: "/dev/vda1",
        directoryPath: directory,
      },
    },
    close: async () => {
      await source.close();
      closed = true;
    },
  }),
};
const native = createRequire(import.meta.url)(addon);
console.log(
  "Preparing authenticated installation filesystems",
  new Date().toISOString(),
);
const operations = await new PreparedInstallOperationFactory(
  selector,
  native,
).open(plan, target);
console.log("Filesystem preparation complete", new Date().toISOString());
const journal = new DurableFileInstallJournal(directory);
let result;
try {
  result = await executeAuthorizedInstallPlan(plan, {
    ...dependencies,
    journal: {
      read: (planId) => journal.read(planId),
      append: async (entry) => {
        await journal.append(entry);
        console.log(
          "Durable install checkpoint",
          entry.event,
          entry.actionIndex ?? "",
          new Date().toISOString(),
        );
      },
    },
    operations,
  });
} finally {
  await operations.close();
}
assert.equal(closed, true);
assert.equal(result.completedActions, plan.actions.length);
const final = inspect();
assert.equal(final.partitions.length, 4);
for (const part of final.partitions) {
  const check = spawnSync(
    part.filesystem === "fat32" ? "fsck.vfat" : "e2fsck",
    ["-n", part.id],
    { encoding: "utf8" },
  );
  assert.equal(check.status, 0, check.stdout + check.stderr);
}
const root = final.partitions.find(
  (part) =>
    part.startBytes ===
    plan.partitions.find((p) => p.role === "root").startBytes,
);
assert.match(
  command("debugfs", ["-R", "cat /factory-version", root.id]),
  /authenticated factory fixture/,
);
const fstab = command("debugfs", ["-R", "cat /etc/fstab", root.id]);
for (const role of ["root", "state", "esp"]) {
  const planned = plan.partitions.find((p) => p.role === role);
  const actual = final.partitions.find(
    (p) => p.startBytes === planned.startBytes,
  );
  const uuid = command("blkid", ["-p", "-s", "UUID", "-o", "value", actual.id]);
  assert.ok(fstab.includes(`UUID=${uuid}`), `missing installed ${role} UUID`);
}
const entries = await journal.read(plan.planId);
assert.equal(entries.at(-1).event, "execution-completed");
writeFileSync(
  output,
  `${JSON.stringify(
    {
      success: true,
      sectorBytes: target.logicalSectorBytes,
      result,
      ownerCredential: "ephemeral Ed25519; tampered claims rejected",
      actions: plan.actions,
      receipts: entries.filter((entry) => entry.event === "action-completed"),
      scope:
        "real native writes, filesystem checks and installed mount UUIDs on a disposable VM disk; ephemeral factory key and fixture owner authorization; no firmware boot claim",
    },
    null,
    2,
  )}\n`,
);

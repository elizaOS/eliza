import type {
  DiskInventory,
  InstallerAction,
  PartitionInventory,
} from "./types";

function fail(message: string): never {
  throw new Error(`Unexpected partition transition: ${message}`);
}

/** Inventory readback checks. Payload hashes, filesystem health and boot
 * evidence still belong to the real backend; a receipt alone proves none of them. */
export function assertInstallActionTransition(
  action: InstallerAction,
  before: DiskInventory,
  after: DiskInventory,
): void {
  if (after.partitionTable !== "gpt" || after.gptRedundancyVerified !== true) {
    fail("the operation did not leave a verified redundant GPT.");
  }
  if (action.type === "erase-partition-table") {
    if (after.partitions.length !== 0) fail("erase left existing partitions.");
    return;
  }
  if (
    before.partitionTable !== "gpt" ||
    before.hardwareIdentity.gptDiskGuid !== after.hardwareIdentity.gptDiskGuid
  ) {
    fail("an operation other than erase changed the GPT disk identity.");
  }
  const previous = new Map(before.partitions.map((item) => [item.id, item]));
  const current = new Map(after.partitions.map((item) => [item.id, item]));
  const expectedCount =
    before.partitions.length + (action.type === "create-partition" ? 1 : 0);
  if (after.partitions.length !== expectedCount) {
    fail("the operation added or removed an unexpected partition.");
  }
  for (const old of before.partitions) {
    const next = current.get(old.id);
    if (!next) fail(`partition ${old.id} was removed or changed identity.`);
    const expectedEnd =
      action.type === "shrink-partition" && action.partitionId === old.id
        ? action.newEndBytes
        : old.endBytes;
    if (
      next.startBytes !== old.startBytes ||
      next.endBytes !== expectedEnd ||
      next.filesystem !== old.filesystem ||
      next.role !== old.role ||
      (next.encryption ?? "unknown") !== (old.encryption ?? "unknown")
    ) {
      fail(`partition ${old.id} changed outside the reviewed operation.`);
    }
  }
  switch (action.type) {
    case "create-partition": {
      const added = after.partitions.filter((item) => !previous.has(item.id));
      const partition = added[0];
      if (
        added.length !== 1 ||
        !partition ||
        partition.startBytes !== action.partition.startBytes ||
        partition.endBytes !== action.partition.endBytes ||
        partition.filesystem !== action.partition.filesystem ||
        partition.encryption !== "none" ||
        (action.partition.role === "esp" && partition.role !== "esp") ||
        (action.partition.role === "recovery" && partition.role !== "recovery")
      ) {
        fail(
          "the new partition does not match the reviewed geometry and filesystem.",
        );
      }
      break;
    }
    case "shrink-partition": {
      const partition = previous.get(action.partitionId);
      if (
        !partition ||
        action.newEndBytes <= partition.startBytes ||
        action.newEndBytes >= partition.endBytes
      ) {
        fail("the reviewed shrink does not reduce an existing partition.");
      }
      break;
    }
    case "reuse-esp":
      assertEsp(previous.get(action.partitionId));
      break;
    case "install-system": {
      const root = before.partitions.find(
        (item) =>
          item.startBytes === action.rootStartBytes &&
          item.endBytes === action.rootEndBytes,
      );
      if (root?.filesystem !== "ext4" || root.encryption !== "none") {
        fail("the system image target is not the reviewed ext4 partition.");
      }
      break;
    }
    case "install-bootloader":
      if (action.espPartitionId !== undefined) {
        assertEsp(previous.get(action.espPartitionId));
      } else {
        const candidates = before.partitions.filter(
          (item) => item.role === "esp",
        );
        if (candidates.length !== 1)
          fail("the bootloader target ESP is ambiguous.");
        assertEsp(candidates[0]);
      }
      break;
    default: {
      const unsupported: never = action;
      fail(`unsupported action ${JSON.stringify(unsupported)}.`);
    }
  }
}

function assertEsp(partition: PartitionInventory | undefined): void {
  if (
    partition?.role !== "esp" ||
    partition.filesystem !== "fat32" ||
    partition.encryption !== "none"
  ) {
    fail(
      "the boot operation does not target an existing unencrypted FAT32 ESP.",
    );
  }
}

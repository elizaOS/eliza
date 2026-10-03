import { generateKeyPairSync, sign } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileReleaseSequenceStore } from "../../../usb-installer/src/backend/release-sequence-store";
import { DirectoryInstallationSourceSelector } from "./directory-source-selector";
import {
  createDiskConfirmationToken,
  createDiskInventoryFingerprint,
  createInstallPlan,
} from "./planner";
import { createTestDiskInventory } from "./test-inventory";

const roots: string[] = [];
const keys = generateKeyPairSync("ed25519");
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(sequence = 10) {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "installer-source-"),
  );
  roots.push(root);
  const directory = join(root, "factory");
  await mkdir(directory, { mode: 0o700 });
  const manifest = {
    schemaVersion: 1,
    product: "elizaOS",
    architecture: "x86_64",
    version: "1.0.0",
    sequence,
    expires: "2026-10-24T00:00:00.000Z",
    esp: { sha256: "ab".repeat(32), sizeBytes: 32 * 1024 ** 2 },
    recovery: { sha256: "cd".repeat(32), sizeBytes: 32 * 1024 ** 2 },
    boot: {
      kernelArguments: ["console=tty0"],
      kernelPath: "/elizaos/vmlinuz",
      initrdPaths: ["/elizaos/initrd"],
      recoveryKernelPath: "/elizaos-recovery/vmlinuz",
      recoveryInitrdPaths: ["/elizaos-recovery/initrd"],
    },
  };
  const metadata = Buffer.from(JSON.stringify(manifest));
  await writeFile(join(directory, "factory-manifest.json"), metadata, {
    mode: 0o600,
  });
  await writeFile(
    join(directory, "factory-manifest.json.sig"),
    sign(null, metadata, keys.privateKey),
    { mode: 0o600 },
  );
  // Sparse payload fixtures establish handle/size checks only. StageFactorySources
  // separately hashes full images; selection must not claim these bytes verified.
  for (const role of ["esp", "recovery"] as const) {
    const handle = await open(
      join(directory, `factory-${role}.img`),
      "wx",
      0o600,
    );
    await handle.writeFile(role);
    await handle.truncate(manifest[role].sizeBytes);
    await handle.close();
  }
  const inventory = createTestDiskInventory();
  const reviewed = createInstallPlan(
    {
      mode: "erase-disk",
      targetStableId: inventory.stableId,
      expectedSizeBytes: inventory.sizeBytes,
      confirmationToken: createDiskConfirmationToken(inventory),
    },
    inventory,
  );
  const plan = {
    ...reviewed,
    executable: true as const,
    authorization: {
      planId: reviewed.planId,
      inventoryFingerprint: createDiskInventoryFingerprint(inventory),
      ownerId: "fixture-owner",
      nonce: "fixture-nonce",
      credential: "fixture-only",
      issuedAt: "2026-09-24T00:00:00.000Z",
      expiresAt: "2026-09-24T01:00:00.000Z",
    },
  };
  const storage = {
    disk: {
      ...inventory,
      stableId: "serial-STORAGE",
      path: "/dev/sdc",
      kernelDeviceIdentity: "8:32:43",
      hardwareIdentity: {
        serial: "STORAGE",
        firmwarePath: "/sys/devices/test/storage",
      },
    },
    partitionPath: "/dev/sdc1",
    directoryPath: directory,
  };
  const statePath = join(root, "state", "sequences.json");
  const sequences = new FileReleaseSequenceStore(statePath);
  const policy = {
    publicKey: keys.publicKey,
    architecture: "x86_64" as const,
    minimumSequence: 1,
    now: new Date("2026-09-24T00:00:00.000Z"),
  };
  const configuration = {
    storage: async () => storage,
    policy: async () => policy,
    sequences,
    channel: "stable" as const,
  };
  return {
    root,
    directory,
    metadata,
    manifest,
    inventory,
    plan,
    storage,
    statePath,
    sequences,
    configuration,
    selector: new DirectoryInstallationSourceSelector(configuration),
  };
}

async function openFactoryDescriptors(root: string) {
  const links = await Promise.all(
    (await readdir("/proc/self/fd")).map(async (entry) => {
      try {
        return await readlink(`/proc/self/fd/${entry}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
        throw error;
      }
    }),
  );
  return links.filter((value) => value.startsWith(root));
}

describe.runIf(process.platform === "linux")(
  "service-owned factory directory selection",
  () => {
    it("retains fixed source handles and persists the authenticated release sequence", async () => {
      const f = await fixture();
      const selected = await f.selector.open(f.plan, f.inventory);
      try {
        expect(Buffer.from(selected.options.manifest)).toEqual(f.metadata);
        expect(
          JSON.parse(await readFile(f.statePath, "utf8")).sequences,
        ).toEqual({ "stable/x86_64": 10 });
        const moved = join(f.root, "retained");
        await rename(f.directory, moved);
        await mkdir(f.directory, { mode: 0o700 });
        await writeFile(join(f.directory, "factory-esp.img"), "replacement");
        const bytes = Buffer.alloc(3);
        await selected.options.sources.esp.file.read(bytes, 0, bytes.length, 0);
        expect(bytes.toString()).toBe("esp");
        expect(selected.options.sources.esp.offsetBytes).toBe(0);
      } finally {
        const closing = selected.close();
        expect(selected.close()).toBe(closing);
        await closing;
      }
      expect(await openFactoryDescriptors(f.root)).toEqual([]);
    });

    it("rejects rollback using the existing durable sequence store and closes sources", async () => {
      const f = await fixture();
      await f.sequences.accept({ "stable/x86_64": 11 });
      await expect(f.selector.open(f.plan, f.inventory)).rejects.toMatchObject({
        cause: { message: expect.stringContaining("rollback rejected") },
      });
      expect(await openFactoryDescriptors(f.root)).toEqual([]);
    });

    it("authenticates metadata before opening image files or consuming sequence state", async () => {
      const f = await fixture();
      await writeFile(
        join(f.directory, "factory-manifest.json.sig"),
        Buffer.alloc(64),
      );
      await rm(join(f.directory, "factory-esp.img"));
      await expect(f.selector.open(f.plan, f.inventory)).rejects.toMatchObject({
        cause: { name: "FactoryManifestError" },
      });
      await expect(readFile(f.statePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await openFactoryDescriptors(f.root)).toEqual([]);
    });

    it.each(["symlink", "hardlink", "permissions", "size", "metadata-size"])(
      "rejects unsafe %s inputs and releases every opened handle",
      async (kind) => {
        const f = await fixture();
        const path = join(f.directory, "factory-esp.img");
        if (kind === "symlink") {
          await rm(path);
          await symlink(join(f.directory, "factory-recovery.img"), path);
        } else if (kind === "hardlink")
          await link(path, join(f.directory, "alias"));
        else if (kind === "permissions") await chmod(path, 0o644);
        else if (kind === "size") await writeFile(path, "short");
        else
          await writeFile(
            join(f.directory, "factory-manifest.json"),
            Buffer.alloc(1024 * 1024 + 1),
          );
        await expect(
          f.selector.open(f.plan, f.inventory),
        ).rejects.toMatchObject({ name: "FactorySourceError" });
        expect(await openFactoryDescriptors(f.root)).toEqual([]);
        await expect(readFile(f.statePath)).rejects.toMatchObject({
          code: "ENOENT",
        });
      },
    );

    it("rejects target aliases before opening source storage", async () => {
      const f = await fixture();
      f.storage.disk.hardwareIdentity.serial =
        f.inventory.hardwareIdentity.serial;
      f.storage.directoryPath = join(f.root, "missing");
      await expect(f.selector.open(f.plan, f.inventory)).rejects.toMatchObject({
        cause: { message: expect.stringContaining("physically independent") },
      });
    });

    it("closes all source handles when cancellation follows durable acceptance", async () => {
      const f = await fixture();
      const cancellation = new AbortController();
      const cause = new Error("owner cancelled");
      const accept = vi
        .spyOn(f.sequences, "accept")
        .mockImplementation(async () => {
          cancellation.abort(cause);
        });
      await expect(
        f.selector.open(f.plan, f.inventory, cancellation.signal),
      ).rejects.toMatchObject({ cause });
      expect(accept).toHaveBeenCalledTimes(1);
      expect(await openFactoryDescriptors(f.root)).toEqual([]);
    });
  },
);

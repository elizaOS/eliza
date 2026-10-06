import { spawn } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import { expect, it, vi } from "vitest";
import { UnmountFailedError } from "./errors";
import {
  LinuxUsbInstallerBackend,
  writeCanonicalRawImageToLinuxDevice,
} from "./linux-backend";
import { MacOsUsbInstallerBackend } from "./macos-backend";
import type { WritePlan } from "./types";
import { WindowsUsbInstallerBackend } from "./windows-backend";

const plan: WritePlan = {
  request: {
    driveId: "usb-test",
    imageId: "image-test",
    dryRun: false,
    acknowledgeDataLoss: true,
  },
  drive: {
    id: "usb-test",
    name: "Disposable test USB",
    devicePath: "/dev/sdz",
    sizeBytes: 4096,
    bus: "usb",
    platform: "linux",
    safety: "safe-removable",
  },
  image: {
    id: "image-test",
    label: "Test image",
    version: "1.0.0",
    channel: "beta",
    architecture: "x86_64",
    buildId: "test",
    publishedAt: "2026-09-01T00:00:00.000Z",
    url: "https://example.test/image.raw.zst",
    signatureUrl: "https://example.test/image.raw.zst.sig",
    checksumSha256: "ab".repeat(32),
    sha256Compressed: "ab".repeat(32),
    sha256Expanded: "cd".repeat(32),
    sizeBytes: 256,
    compressedSize: 256,
    expandedSize: 1024,
    minDeviceBytes: 4096,
    minUsbSizeBytes: 4096,
    manifestVersion: 1,
    schemaVersion: 1,
    product: "elizaOS",
    sequence: 1,
    expires: "2099-01-01T00:00:00Z",
    format: "raw.zst",
  },
  steps: [],
  privilegedWriteImplemented: true,
};

it.each([undefined, "iso"])(
  "rejects unsupported image format %s before privilege or disk effects",
  async (format) => {
    const findEscalator = vi.fn();
    const progress = vi.fn();
    const backend = new LinuxUsbInstallerBackend({ findEscalator });
    const invalid = {
      ...plan,
      image: { ...plan.image, format },
    } as unknown as WritePlan;
    await expect(backend.executeWritePlan(invalid, progress)).rejects.toThrow(
      "Only signed raw.zst",
    );
    expect(findEscalator).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalled();
  },
);

it.each([true, false])(
  "requires a successful privileged unmount before writing (busy=%s)",
  async (busy) => {
    const calls: string[][] = [];
    const writer = vi.fn(async () => {});
    const backend = new LinuxUsbInstallerBackend({
      findEscalator: async () => ({ command: "sudo", argsPrefix: ["-n"] }),
      execFile: async (command, args) => {
        calls.push([command, ...args]);
        if (command === "lsblk") {
          return {
            stdout: JSON.stringify({
              blockdevices: [
                {
                  name: "sdz",
                  type: "disk",
                  mountpoint: null,
                  children: [
                    {
                      name: "sdz1",
                      type: "part",
                      pkname: "sdz",
                      mountpoint: "/media/test",
                    },
                  ],
                },
              ],
            }),
            stderr: "",
          };
        }
        expect([command, ...args]).toEqual([
          "sudo",
          "-n",
          "umount",
          "/dev/sdz1",
        ]);
        if (busy) {
          throw Object.assign(new Error("umount failed"), {
            code: 32,
            stderr: "umount: /media/test: target is busy.",
          });
        }
        return { stdout: "", stderr: "" };
      },
      writeCanonicalRawImage: writer,
    });
    const result = backend.executeWritePlan(plan, () => {});
    if (busy) {
      await expect(result).rejects.toBeInstanceOf(UnmountFailedError);
      expect(writer).not.toHaveBeenCalled();
    } else {
      await result;
      expect(writer).toHaveBeenCalledOnce();
    }
    expect(calls).toHaveLength(2);
  },
);

it("binds selection to the kernel disk incarnation, even when the serial and path are reused", async () => {
  let sequence = 41;
  const backend = new LinuxUsbInstallerBackend({
    currentSystemDiskNames: async () => new Set(),
    execFile: async () => ({
      stdout: JSON.stringify({
        blockdevices: [
          {
            name: "sdz",
            size: 4096,
            type: "disk",
            rm: true,
            model: "USB",
            serial: "same-serial",
            tran: "usb",
            hotplug: true,
            mountpoints: [],
            "maj:min": "8:240",
            "disk-seq": sequence,
            "log-sec": 512,
          },
        ],
      }),
      stderr: "",
    }),
  });
  backend.listImages = async () => [plan.image];
  const [selected] = await backend.listRemovableDrives();
  expect(selected?.safety).toBe("safe-removable");
  expect(selected?.kernelDeviceIdentity).toBe("8:240:41:512");
  sequence = 42;
  await expect(
    backend.createWritePlan({
      ...plan.request,
      driveId: "sdz",
      expectedDrive: {
        devicePath: "/dev/sdz",
        sizeBytes: 4096,
        stableId: "linux:same-serial",
        kernelDeviceIdentity: "8:240:41:512",
      },
    }),
  ).rejects.toThrow("kernel identity changed");
});

it("rejects placeholder checksums before platform writes", async () => {
  const backend = new LinuxUsbInstallerBackend();
  const progress = vi.fn();
  const invalidPlan = structuredClone(plan);
  invalidPlan.image.checksumSha256 = "0".repeat(64);
  await expect(backend.executeWritePlan(invalidPlan, progress)).rejects.toThrow(
    "trusted SHA-256 checksum",
  );
  expect(progress).not.toHaveBeenCalled();
});

it.each(["mountinfo", "sysfs"])(
  "propagates %s inspection failures instead of returning an incomplete safety inventory",
  async (stage) => {
    const error = Object.assign(new Error("inspection denied"), {
      code: "EACCES",
    });
    const read = vi.spyOn(fs, "readFile");
    const realpath = vi.spyOn(fs, "realpath");
    const readdir = vi.spyOn(fs, "readdir");
    if (stage === "mountinfo") read.mockRejectedValueOnce(error);
    else {
      read.mockResolvedValueOnce("31 20 8:1 / / rw - ext4 /dev/sdz1 rw\n");
      realpath.mockResolvedValueOnce("/dev/sdz1");
      readdir.mockRejectedValueOnce(error);
    }
    try {
      const backend = new LinuxUsbInstallerBackend({
        execFile: async () => ({ stdout: '{"blockdevices":[]}', stderr: "" }),
      });
      await expect(backend.listRemovableDrives()).rejects.toBe(error);
    } finally {
      read.mockRestore();
      realpath.mockRestore();
      readdir.mockRestore();
    }
  },
);

it.each([undefined, {}, [42]])(
  "rejects absent or malformed mount state %j",
  async (mountpoints) => {
    const backend = new LinuxUsbInstallerBackend({
      currentSystemDiskNames: async () => new Set(),
      execFile: async () => ({
        stdout: JSON.stringify({
          blockdevices: [
            {
              name: "sdz",
              size: 4096,
              type: "disk",
              rm: true,
              hotplug: true,
              tran: "usb",
              "maj:min": "8:240",
              "disk-seq": 42,
              "log-sec": 512,
              mountpoints,
            },
          ],
        }),
        stderr: "",
      }),
    });
    await expect(backend.listRemovableDrives()).rejects.toThrow("mount state");
  },
);

it.each([
  { blockdevices: [] },
  { blockdevices: [{ name: "other", type: "disk", mountpoint: null }] },
  { blockdevices: [{ name: "sdz", type: "disk" }] },
  { blockdevices: [{ name: "sdz", type: "disk", mountpoint: "/" }] },
  {
    blockdevices: [
      {
        name: "sdz",
        type: "disk",
        mountpoint: null,
        children: [
          {
            name: "sdz1",
            type: "part",
            pkname: "sdz",
            mountpoint: "/media/test",
          },
          { name: "mapper", type: "crypt", pkname: "sdz", mountpoint: null },
        ],
      },
    ],
  },
])(
  "refuses incomplete or mismatched pre-write inventory before unmounting",
  async (inventory) => {
    const writer = vi.fn(async () => {});
    const commands: string[] = [];
    const backend = new LinuxUsbInstallerBackend({
      findEscalator: async () => ({ command: "sudo", argsPrefix: ["-n"] }),
      execFile: async (command) => {
        commands.push(command);
        return { stdout: JSON.stringify(inventory), stderr: "" };
      },
      writeCanonicalRawImage: writer,
    });
    await expect(backend.executeWritePlan(plan, () => {})).rejects.toThrow(
      "lsblk output",
    );
    expect(commands).toEqual(["lsblk"]);
    expect(writer).not.toHaveBeenCalled();
  },
);

it.each(["privilege", "inventory", "unmount"])(
  "honors cancellation during %s before another side effect",
  async (stage) => {
    const controller = new AbortController();
    const reason = new Error("cancelled by owner");
    const writer = vi.fn(async () => {});
    const commands: string[] = [];
    const backend = new LinuxUsbInstallerBackend({
      findEscalator: async () => {
        if (stage === "privilege") controller.abort(reason);
        return { command: "sudo", argsPrefix: ["-n"] };
      },
      execFile: async (command) => {
        commands.push(command);
        if (
          (command === "lsblk" && stage === "inventory") ||
          (command === "sudo" && stage === "unmount")
        )
          controller.abort(reason);
        return {
          stdout: JSON.stringify({
            blockdevices: [
              {
                name: "sdz",
                type: "disk",
                mountpoint: null,
                children: [1, 2].map((n) => ({
                  name: `sdz${n}`,
                  pkname: "sdz",
                  type: "part",
                  mountpoint: `/media/test${n}`,
                })),
              },
            ],
          }),
          stderr: "",
        };
      },
      writeCanonicalRawImage: writer,
    });
    await expect(
      backend.executeWritePlan(plan, () => {}, { signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(commands).toEqual(
      stage === "privilege"
        ? []
        : stage === "inventory"
          ? ["lsblk"]
          : ["lsblk", "sudo"],
    );
    expect(writer).not.toHaveBeenCalled();
  },
);

it.each([0, -1, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
  "rejects invalid image size %s before effects",
  async (sizeBytes) => {
    const invalid = structuredClone(plan);
    invalid.image.sizeBytes = sizeBytes;
    const privilege = vi.fn();
    const backend = new LinuxUsbInstallerBackend({ findEscalator: privilege });
    await expect(backend.executeWritePlan(invalid, () => {})).rejects.toThrow(
      "positive safe integer",
    );
    expect(privilege).not.toHaveBeenCalled();
  },
);

it.runIf(process.platform === "linux")(
  "waits for a real writer with missing stdin to close before rejecting",
  async () => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
    const timer = setInterval(() => {}, 1000);
    process.on('SIGTERM', () => setTimeout(() => { clearInterval(timer); }, 200));
    process.stdout.write('ready');
  `,
      ],
      {
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const completed = once(child, "close");
    let closed = false;
    child.once("close", () => {
      closed = true;
    });
    try {
      if (!child.stdout) throw new Error("Fixture child has no stdout.");
      await once(child.stdout, "data");
      expect(child.stdin).toBe(null);
      await expect(
        writeCanonicalRawImageToLinuxDevice(
          { ...plan.image, expandedSize: 4096 },
          { ...plan.drive, kernelDeviceIdentity: "8:16:42:512" },
          { command: "sudo", argsPrefix: [] },
          () => child,
          () => {},
          async (_image, target) => {
            target.openWriteStream();
            throw new Error("unexpected writer admission");
          },
          {},
          "/fixture/unopened-writer",
        ),
      ).rejects.toThrow("did not expose stdin");
      expect(closed).toBe(true);
    } finally {
      if (!closed) child.kill("SIGTERM");
      await completed;
    }
  },
);

it.each([MacOsUsbInstallerBackend, WindowsUsbInstallerBackend])(
  "does not advertise canonical raw writes on an unsupported host (%s)",
  async (Backend) => {
    const backend = new Backend();
    vi.spyOn(backend, "listRemovableDrives").mockResolvedValue([plan.drive]);
    vi.spyOn(backend, "listImages").mockResolvedValue([plan.image]);
    const pending = await backend.createWritePlan(plan.request);
    expect(pending.privilegedWriteImplemented).toBe(false);
    expect(pending.steps.every((step) => step.status === "blocked")).toBe(true);
    const preview = await backend.createWritePlan({
      ...plan.request,
      dryRun: true,
    });
    expect(preview.privilegedWriteImplemented).toBe(false);
    expect(preview.steps.every((step) => step.status === "complete")).toBe(
      true,
    );
  },
);

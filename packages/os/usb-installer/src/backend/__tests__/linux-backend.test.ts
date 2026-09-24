import { expect, it, vi } from "vitest";
import { UnmountFailedError } from "../errors";
import { LinuxUsbInstallerBackend } from "../linux-backend";
import type { WritePlan } from "../types";

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
    format: "raw.zst",
  },
  steps: [],
  privilegedWriteImplemented: true,
};

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
                  children: [{ name: "sdz1", mountpoint: "/media/test" }],
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

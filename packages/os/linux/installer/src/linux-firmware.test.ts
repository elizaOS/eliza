import { lstat, statfs } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { detectLinuxInstallFirmware } from "./linux-firmware";

vi.mock("node:fs/promises", () => ({ lstat: vi.fn(), statfs: vi.fn() }));

const directory = { isDirectory: () => true };
const error = (code: string) => Object.assign(new Error(code), { code });

describe.runIf(process.platform === "linux")(
  "kernel firmware detection",
  () => {
    beforeEach(() => {
      vi.resetAllMocks();
      vi.mocked(lstat).mockResolvedValue(
        directory as Awaited<ReturnType<typeof lstat>>,
      );
      vi.mocked(statfs).mockResolvedValue({ type: 0x62656572 } as Awaited<
        ReturnType<typeof statfs>
      >);
    });

    it("identifies EFI from kernel sysfs", async () => {
      await expect(detectLinuxInstallFirmware()).resolves.toBe("uefi");
      expect(lstat).toHaveBeenCalledWith("/sys/firmware/efi");
    });

    it("identifies legacy x86 firmware only when EFI evidence is absent", async () => {
      vi.mocked(lstat)
        .mockResolvedValueOnce(directory as Awaited<ReturnType<typeof lstat>>)
        .mockRejectedValueOnce(error("ENOENT"));
      await expect(detectLinuxInstallFirmware()).resolves.toBe(
        process.arch === "x64" || process.arch === "ia32" ? "bios" : "unknown",
      );
    });

    it.each(["ENOENT", "EACCES", "EIO"])(
      "rejects unavailable sysfs (%s)",
      async (code) => {
        const failure = error(code);
        vi.mocked(lstat).mockRejectedValueOnce(failure);
        await expect(detectLinuxInstallFirmware()).rejects.toMatchObject({
          name: "LinuxFirmwareProbeError",
          cause: failure,
        });
      },
    );

    it("does not mistake an EFI probe error for legacy firmware", async () => {
      const failure = error("EACCES");
      vi.mocked(lstat)
        .mockResolvedValueOnce(directory as Awaited<ReturnType<typeof lstat>>)
        .mockRejectedValueOnce(failure);
      await expect(detectLinuxInstallFirmware()).rejects.toMatchObject({
        cause: failure,
      });
    });

    it("rejects firmware evidence outside sysfs", async () => {
      vi.mocked(statfs).mockResolvedValue({ type: 0xef53 } as Awaited<
        ReturnType<typeof statfs>
      >);
      await expect(detectLinuxInstallFirmware()).rejects.toThrow(
        "kernel sysfs",
      );
      expect(lstat).toHaveBeenCalledTimes(1);
    });

    it.each([1, 2])(
      "rejects a file or symlink in firmware path component %s",
      async (component) => {
        if (component === 2)
          vi.mocked(lstat).mockResolvedValueOnce(
            directory as Awaited<ReturnType<typeof lstat>>,
          );
        vi.mocked(lstat).mockResolvedValueOnce({
          isDirectory: () => false,
        } as Awaited<ReturnType<typeof lstat>>);
        await expect(detectLinuxInstallFirmware()).rejects.toMatchObject({
          name: "LinuxFirmwareProbeError",
        });
      },
    );
  },
);

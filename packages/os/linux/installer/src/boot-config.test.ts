import { describe, expect, it } from "vitest";
import {
  factoryBootPayloadPaths,
  type InstalledBootConfiguration,
  renderInstalledGrubConfiguration,
} from "./boot-config";

const config: InstalledBootConfiguration = {
  architecture: "x86_64",
  kernelArguments: ["console=tty0", "console=ttyS0,115200n8"],
  rootUuid: "11111111-2222-4333-8444-555555555555",
  recoveryUuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  kernelPath: "/elizaos/kernel/vmlinuz",
  initrdPaths: [
    "/elizaos/microcode.initrd",
    "/elizaos/initrd",
    "/elizaos/kernel/modules.initrd",
  ],
  recoveryKernelPath: "/elizaos-recovery/vmlinuz",
  recoveryInitrdPaths: ["/elizaos-recovery/initrd"],
};

describe("installed GRUB configuration", () => {
  it("requires both external GRUB configuration files in factory payloads", () => {
    expect(factoryBootPayloadPaths(config)).toEqual(
      expect.arrayContaining(["/EFI/debian/grub.cfg", "/grub/grub.cfg"]),
    );
  });
  it("uses distinct installed UUIDs and preserves the complete initrd order", () => {
    const menu = renderInstalledGrubConfiguration(config);
    expect(menu).toContain(
      `root=UUID=${config.rootUuid} rw console=tty0 console=ttyS0,115200n8`,
    );
    expect(menu).toContain(
      `root=UUID=${config.recoveryUuid} ro systemd.volatile=state systemd.unit=rescue.target elizaos.recovery=1`,
    );
    expect(menu).toContain(
      "initrd ($root)/elizaos/microcode.initrd ($root)/elizaos/initrd ($root)/elizaos/kernel/modules.initrd",
    );
    expect(menu).not.toMatch(/root=(?:LABEL|PARTUUID)=/);
  });

  it("rejects ambiguous filesystem identities", () => {
    for (const rootUuid of [
      config.recoveryUuid,
      "00000000-0000-0000-0000-000000000000",
      "root; reboot",
      "",
    ]) {
      expect(() =>
        renderInstalledGrubConfiguration({ ...config, rootUuid }),
      ).toThrow(/distinct nonzero/);
    }
  });

  it("rejects GRUB expressions, traversal, and whitespace in payload paths", () => {
    for (const kernelPath of [
      "/../kernel",
      "/foo/./kernel",
      "/kernel;reboot",
      "/$(reboot)",
      "/kernel\nreboot",
      "relative/kernel",
    ]) {
      expect(() =>
        renderInstalledGrubConfiguration({ ...config, kernelPath }),
      ).toThrow(/literal absolute FAT path/);
    }
  });

  it("rejects replacement root selectors and command expressions in kernel arguments", () => {
    for (const argument of [
      "root=LABEL=usb",
      "init=/bin/sh",
      "rdinit=/bin/sh",
      "systemd.unit=emergency.target",
      "systemd.volatile=no",
      "systemd.volatile=yes",
      "rd.systemd.volatile=overlay",
      "rd.systemd.unit=emergency.target",
      "systemd.machine_id=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "systemd.condition_first_boot=no",
      "systemd.condition-first-boot=no",
      "systemd.machine-id=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "rd.systemd.condition_first_boot=no",
      "elizaos.recovery=1",
      "ro",
      "rw",
      "quiet;reboot",
      "console=tty0\nreboot",
    ]) {
      expect(() =>
        renderInstalledGrubConfiguration({
          ...config,
          kernelArguments: [argument],
        }),
      ).toThrow(/literal non-root/);
    }
  });

  it("requires an initrd sequence for both boot entries", () => {
    expect(() =>
      renderInstalledGrubConfiguration({ ...config, initrdPaths: [] }),
    ).toThrow(/complete initrd/);
    expect(() =>
      renderInstalledGrubConfiguration({ ...config, recoveryInitrdPaths: [] }),
    ).toThrow(/complete initrd/);
  });
});

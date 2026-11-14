import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { configureInstalledRoot } from "./filesystem-image";

const available =
  process.platform === "linux" &&
  ["/usr/sbin/debugfs", "/usr/sbin/mkfs.ext4"].every(existsSync);
const fstab = "# Installed test mount table\n";
it.skipIf(!available)(
  "prepares unique machine identities in real ext4 images and preserves custom mount tables",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "installed-root-"));
    const parent = await open(directory, "r");
    const ids = new Set<string>();
    try {
      for (const kind of [
        "regular",
        "symlink",
        "external-symlink",
        "absent",
        "no-dbus",
        "custom-fstab",
      ]) {
        const pathname = join(directory, `${kind}.img`);
        const image = await open(pathname, "wx+", 0o600);
        try {
          await image.truncate(16 * 1024 ** 2);
          execFileSync("/usr/sbin/mkfs.ext4", ["-q", "-F", pathname]);
          const debug = (command: string) =>
            execFileSync("/usr/sbin/debugfs", ["-w", "-R", command, pathname], {
              encoding: "utf8",
              stdio: ["ignore", "pipe", "pipe"],
            });
          for (const path of [
            "/etc",
            "/home",
            "/efi",
            "/var",
            "/var/lib",
            "/var/lib/dbus",
          ]) {
            if (kind !== "no-dbus" || path !== "/var/lib/dbus")
              debug(`mkdir ${path}`);
          }
          const oldId = `${"a".repeat(32)}\n`;
          const source = join(directory, "source");
          await writeFile(source, oldId);
          if (kind !== "absent") {
            if (kind === "external-symlink") {
              debug(`write ${source} /identity-sentinel`);
              debug("symlink /etc/machine-id /identity-sentinel");
            } else debug(`write ${source} /etc/machine-id`);
            if (kind === "symlink")
              debug("symlink /var/lib/dbus/machine-id /etc/machine-id");
            else if (kind !== "no-dbus")
              debug(`write ${source} /var/lib/dbus/machine-id`);
          }
          const originalFstab =
            kind === "custom-fstab"
              ? "/dev/sda1 / ext4 defaults 0 1\n"
              : "# factory\n";
          await writeFile(source, originalFstab);
          debug(`write ${source} /etc/fstab`);
          if (kind === "custom-fstab") {
            await expect(
              configureInstalledRoot(parent, image, fstab),
            ).rejects.toThrow(/configuration failed/);
            expect(debug("cat /etc/fstab")).toBe(originalFstab);
            expect(debug("cat /etc/machine-id")).toBe(oldId);
          } else {
            await configureInstalledRoot(parent, image, fstab);
            expect(debug("cat /etc/fstab")).toBe(fstab);
            if (kind === "external-symlink")
              expect(debug("cat /identity-sentinel")).toBe(oldId);
            expect(debug("cat /etc/machine-id")).toBe("uninitialized\n");
            if (kind !== "no-dbus") {
              const id = debug("cat /var/lib/dbus/machine-id");
              expect(id).toMatch(/^[a-f0-9]{32}\n$/);
              expect(id).not.toBe(oldId);
              expect(ids.has(id)).toBe(false);
              ids.add(id);
            }
            expect(debug("stat /etc/machine-id")).toMatch(
              /Type:\s+regular\s+Mode:\s+0644/,
            );
            execFileSync("/usr/sbin/e2fsck", ["-f", "-n", pathname], {
              stdio: "pipe",
            });
          }
        } finally {
          await image.close();
        }
      }
    } finally {
      await parent.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

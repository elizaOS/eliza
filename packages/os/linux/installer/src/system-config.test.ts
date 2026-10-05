import { describe, expect, it } from "vitest";
import {
  assertUnusedFactoryFstab,
  renderInstalledFstab,
} from "./system-config";

const root = "11111111-2222-4333-8444-555555555555";
const mounts = {
  homeUuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  espUuid: "abcd-1234",
};
describe("installed filesystem mounts", () => {
  it("pins all three mounts to filesystem identities", () => {
    expect(renderInstalledFstab(root, mounts)).toBe(
      `# Installed elizaOS filesystems\nUUID=${root} / ext4 defaults,errors=remount-ro 0 1\nUUID=${mounts.homeUuid} /home ext4 defaults 0 2\nUUID=ABCD-1234 /efi vfat umask=0077 0 2\n`,
    );
  });
  it("refuses ambiguous and injected filesystem identities", () => {
    for (const homeUuid of [
      root,
      "00000000-0000-0000-0000-000000000000",
      "bad\n/dev/sda / ext4 defaults 0 1",
    ])
      expect(() =>
        renderInstalledFstab(root, { ...mounts, homeUuid }),
      ).toThrow();
    for (const espUuid of ["0000-0000", "abcd-1234\n", "abcd-1234 defaults"])
      expect(() =>
        renderInstalledFstab(root, { ...mounts, espUuid }),
      ).toThrow();
    expect(() => renderInstalledFstab("invalid", mounts)).toThrow();
  });
});

describe("factory mount configuration migration", () => {
  it("accepts empty and comment-only factory tables", () => {
    for (const content of [
      "",
      " \n\t",
      "# /etc/fstab: static file system information.\n",
      "  # UUID=old / ext4 defaults 0 1\r\n",
    ]) {
      expect(() =>
        assertUnusedFactoryFstab(Buffer.from(content)),
      ).not.toThrow();
    }
  });
  it("preserves existing mounts and rejects malformed content", () => {
    for (const content of [
      Buffer.from("UUID=old / ext4 defaults 0 1\n"),
      Buffer.from("# comment\n/dev/sda1 /efi vfat defaults 0 2"),
      Buffer.from("# comment\0"),
      Buffer.from([0xff]),
    ]) {
      expect(() => assertUnusedFactoryFstab(content)).toThrow();
    }
  });
});

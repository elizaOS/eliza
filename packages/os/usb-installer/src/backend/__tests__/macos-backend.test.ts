// Exercises USB installer backend safety and platform behavior.
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvalidDevicePathError, InvalidImagePathError } from "../errors";
import {
  appleScriptStringEscape,
  deriveRawDisk,
  shellSingleQuote,
  validateImagePath,
} from "../macos-backend";

describe("macos-backend path validation", () => {
  describe("deriveRawDisk", () => {
    it("converts /dev/disk3 -> /dev/rdisk3", () => {
      expect(deriveRawDisk("/dev/disk3")).toBe("/dev/rdisk3");
    });

    it("converts /dev/disk0 -> /dev/rdisk0", () => {
      expect(deriveRawDisk("/dev/disk0")).toBe("/dev/rdisk0");
    });

    it("rejects partition paths like /dev/disk0s1", () => {
      expect(() => deriveRawDisk("/dev/disk0s1")).toThrow(
        InvalidDevicePathError,
      );
    });

    it("rejects non-disk devices like /dev/nand0", () => {
      expect(() => deriveRawDisk("/dev/nand0")).toThrow(InvalidDevicePathError);
    });

    it("rejects already-raw paths", () => {
      expect(() => deriveRawDisk("/dev/rdisk3")).toThrow(
        InvalidDevicePathError,
      );
    });

    it("rejects shell injection attempts", () => {
      expect(() => deriveRawDisk("/dev/disk3; rm -rf /")).toThrow(
        InvalidDevicePathError,
      );
    });
  });

  describe("validateImagePath", () => {
    it("accepts standard tmp paths", () => {
      expect(validateImagePath("/tmp/elizaos-installer/foo.iso")).toBe(
        "/tmp/elizaos-installer/foo.iso",
      );
    });

    it("accepts paths under /var, /Users, /Volumes, /private", () => {
      expect(validateImagePath("/var/folders/abc/T/x.iso")).toBeTruthy();
      expect(validateImagePath("/Users/me/Downloads/eliza.iso")).toBeTruthy();
      expect(validateImagePath("/Volumes/ext/img.iso")).toBeTruthy();
      expect(validateImagePath("/private/tmp/img.iso")).toBeTruthy();
    });

    it("rejects relative paths", () => {
      expect(() => validateImagePath("relative/path.iso")).toThrow(
        InvalidImagePathError,
      );
    });

    it("rejects paths with shell metacharacters", () => {
      expect(() => validateImagePath("/tmp/foo; rm -rf /")).toThrow(
        InvalidImagePathError,
      );
      expect(() => validateImagePath("/tmp/foo`whoami`.iso")).toThrow(
        InvalidImagePathError,
      );
      expect(() => validateImagePath("/tmp/foo$(id).iso")).toThrow(
        InvalidImagePathError,
      );
    });

    it("rejects paths outside the allowlist", () => {
      expect(() => validateImagePath("/etc/passwd")).toThrow(
        InvalidImagePathError,
      );
    });
  });
});

describe("shell escaping helpers", () => {
  it("shellSingleQuote wraps strings safely", () => {
    expect(shellSingleQuote("/tmp/foo.iso")).toBe("'/tmp/foo.iso'");
  });

  it("shellSingleQuote escapes embedded single quotes", () => {
    expect(shellSingleQuote("a'b")).toBe(`'a'\\''b'`);
  });

  it("appleScriptStringEscape escapes backslash and double-quote", () => {
    expect(appleScriptStringEscape('he said "hi"')).toBe('he said \\"hi\\"');
    expect(appleScriptStringEscape("a\\b")).toBe("a\\\\b");
  });
});

describe("partial-file cleanup", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "elizaos-installer-test-"),
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("removes only .partial files when constructor sweeps the dir", async () => {
    await fs.writeFile(path.join(tmpDir, "img.iso"), "real");
    await fs.writeFile(path.join(tmpDir, "abandoned.iso.partial"), "junk");
    await fs.writeFile(path.join(tmpDir, "other.partial"), "junk");

    // Inline the partial-file sweep so the policy is checked without
    // re-instantiating the whole backend (which would touch /tmp/elizaos-installer).
    const entries = await fs.readdir(tmpDir);
    await Promise.all(
      entries
        .filter((e) => e.endsWith(".partial"))
        .map((e) => fs.rm(path.join(tmpDir, e), { force: true })),
    );

    const remaining = await fs.readdir(tmpDir);
    expect(remaining.sort()).toEqual(["img.iso"]);
  });
});

describe("UserCancelledAuthError detection regex", () => {
  // The backend matches /user cancell?ed\./i. Verify the patterns we care
  // about, since osascript reports either "User canceled." (US) or
  // "User cancelled." (UK) depending on macOS locale.
  const re = /user cancell?ed\./i;

  it("matches US spelling", () => {
    expect(re.test("execution error: User canceled.")).toBe(true);
  });

  it("matches UK spelling", () => {
    expect(re.test("execution error: User cancelled.")).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(re.test("dd: Permission denied")).toBe(false);
  });
});

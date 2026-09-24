// Exercises USB installer backend safety and platform behavior.
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  InvalidDevicePathError,
  InvalidDiskNumberError,
  InvalidImagePathError,
  InvalidScriptPathError,
  SystemDiskProtectedError,
  WslDetectedError,
} from "../errors";
import {
  assertValidDiskNumber,
  assertValidImagePath,
  assertValidPhysicalDrive,
  assertValidScriptPath,
  buildDiskpartScript,
  classifyDiskSafety,
  psEscape,
} from "../windows-backend";

describe("psEscape", () => {
  it("single-quotes a benign string", () => {
    expect(psEscape("hello")).toBe("'hello'");
  });

  it("doubles embedded single quotes", () => {
    expect(psEscape("it's")).toBe("'it''s'");
  });

  it("neutralizes a $() subexpression by literalizing it", () => {
    // The whole string ends up inside single quotes, where $() does not expand.
    const escaped = psEscape("$(Get-Process)");
    expect(escaped.startsWith("'")).toBe(true);
    expect(escaped.endsWith("'")).toBe(true);
    expect(escaped).toBe("'$(Get-Process)'");
  });

  it("neutralizes backticks and semicolons by single-quoting", () => {
    expect(psEscape("a`b;c")).toBe("'a`b;c'");
  });
});

describe("assertValidDiskNumber", () => {
  it("accepts 0 and a small positive integer", () => {
    expect(() => assertValidDiskNumber(0)).not.toThrow();
    expect(() => assertValidDiskNumber(7)).not.toThrow();
  });

  it("rejects negatives, NaN, floats, and huge numbers", () => {
    expect(() => assertValidDiskNumber(-1)).toThrow(InvalidDiskNumberError);
    expect(() => assertValidDiskNumber(Number.NaN)).toThrow(
      InvalidDiskNumberError,
    );
    expect(() => assertValidDiskNumber(1.5)).toThrow(InvalidDiskNumberError);
    expect(() => assertValidDiskNumber(10_000)).toThrow(InvalidDiskNumberError);
  });
});

describe("assertValidPhysicalDrive", () => {
  it("accepts canonical \\.\\PhysicalDriveN", () => {
    expect(() =>
      assertValidPhysicalDrive("\\\\.\\PhysicalDrive0"),
    ).not.toThrow();
    expect(() =>
      assertValidPhysicalDrive("\\\\.\\PhysicalDrive12"),
    ).not.toThrow();
  });

  it("rejects mangled or injected device paths", () => {
    expect(() => assertValidPhysicalDrive("\\\\.\\PhysicalDrive")).toThrow(
      InvalidDevicePathError,
    );
    expect(() =>
      assertValidPhysicalDrive("\\\\.\\PhysicalDrive0; rm -rf /"),
    ).toThrow(InvalidDevicePathError);
    expect(() => assertValidPhysicalDrive("C:\\foo")).toThrow(
      InvalidDevicePathError,
    );
  });
});

describe("assertValidImagePath", () => {
  it("accepts a normal Windows absolute path", () => {
    expect(() =>
      assertValidImagePath("C:\\Users\\me\\AppData\\Local\\Temp\\foo.iso"),
    ).not.toThrow();
  });

  it("rejects shell metacharacters", () => {
    expect(() => assertValidImagePath("C:\\foo;bar")).toThrow(
      InvalidImagePathError,
    );
    expect(() => assertValidImagePath("C:\\foo$(bad)")).toThrow(
      InvalidImagePathError,
    );
    expect(() => assertValidImagePath("C:\\foo`bad`")).toThrow(
      InvalidImagePathError,
    );
    expect(() => assertValidImagePath("/tmp/foo.iso")).toThrow(
      InvalidImagePathError,
    );
  });
});

describe("assertValidScriptPath", () => {
  const tmpRoot = path.join(os.tmpdir(), "elizaos-usb-installer");

  it("accepts a script inside the temp dir with the right name pattern", () => {
    // Skip on non-Windows because the regex requires a drive-letter prefix.
    if (process.platform !== "win32") return;
    const p = path.join(tmpRoot, "elizaos-diskpart.txt");
    expect(() => assertValidScriptPath(p, tmpRoot)).not.toThrow();
  });

  it("rejects paths outside the temp dir", () => {
    if (process.platform !== "win32") return;
    expect(() =>
      assertValidScriptPath("C:\\Windows\\System32\\elizaos-evil.txt", tmpRoot),
    ).toThrow(InvalidScriptPathError);
  });

  it("rejects non-Windows-absolute paths on Windows", () => {
    if (process.platform !== "win32") return;
    expect(() =>
      assertValidScriptPath("/tmp/elizaos-foo.txt", tmpRoot),
    ).toThrow(InvalidScriptPathError);
  });
});

describe("buildDiskpartScript", () => {
  it("validates the disk number before building", () => {
    expect(() => buildDiskpartScript(-1)).toThrow(InvalidDiskNumberError);
    expect(() => buildDiskpartScript(1000)).toThrow(InvalidDiskNumberError);
  });

  it("emits a CRLF script with select disk N", () => {
    const script = buildDiskpartScript(3);
    expect(script).toContain("select disk 3");
    expect(script).toContain("\r\n");
    expect(script.endsWith("exit")).toBe(true);
  });
});

describe("classifyDiskSafety", () => {
  const baseUsb = (): {
    number: number;
    friendlyName: string;
    size: number;
    busType: string;
    isBoot: boolean;
    isSystem: boolean;
    driveLetters: string[];
    systemDrive: string;
  } => ({
    number: 2,
    friendlyName: "SanDisk Ultra USB 3.0",
    size: 32 * 1024 ** 3,
    busType: "USB",
    isBoot: false,
    isSystem: false,
    driveLetters: ["E:"],
    systemDrive: "C:",
  });

  it("marks a clean USB stick as safe-removable", () => {
    const v = classifyDiskSafety({ ...baseUsb() });
    expect(v.safety).toBe("safe-removable");
  });

  it("blocks a USB disk with a boot partition", () => {
    const v = classifyDiskSafety({ ...baseUsb(), isBoot: true });
    expect(v.safety).toBe("blocked-system");
    expect(v.description).toMatch(/system or boot/i);
  });

  it("blocks a USB disk with a system partition", () => {
    const v = classifyDiskSafety({ ...baseUsb(), isSystem: true });
    expect(v.safety).toBe("blocked-system");
  });

  it("blocks a USB disk that holds the system drive letter", () => {
    const v = classifyDiskSafety({ ...baseUsb(), driveLetters: ["C:"] });
    expect(v.safety).toBe("blocked-system");
    expect(v.description).toMatch(/C:/);
  });

  it("blocks a non-USB bus", () => {
    const v = classifyDiskSafety({ ...baseUsb(), busType: "SATA" });
    expect(v.safety).toBe("blocked-system");
  });

  it("blocks when friendly name hints at an internal disk", () => {
    const v = classifyDiskSafety({
      ...baseUsb(),
      friendlyName: "Samsung SSD 990 Pro Internal",
    });
    expect(v.safety).toBe("blocked-system");
  });
});

describe("typed error shapes (Windows backend)", () => {
  it("WslDetectedError has a stable name and is an Error", () => {
    const err = new WslDetectedError();
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(WslDetectedError);
    expect(err.name).toBe("WslDetectedError");
    expect(err.message).toMatch(/wsl/i);
  });

  it("SystemDiskProtectedError carries the offending disk number", () => {
    const err = new SystemDiskProtectedError("boom", 0);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SystemDiskProtectedError);
    expect(err.name).toBe("SystemDiskProtectedError");
    expect(err.diskNumber).toBe(0);
    expect(err.message).toBe("boom");
  });
});

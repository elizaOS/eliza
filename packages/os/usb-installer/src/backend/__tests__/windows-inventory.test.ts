import { describe, expect, it } from "vitest";
import {
  classifyDiskSafety,
  parseWindowsDiskInventory,
} from "../windows-backend";

const disk = {
  Number: 2,
  FriendlyName: "USB disk",
  Size: 1024,
  BusType: "USB",
  IsBoot: false,
  IsSystem: false,
  DriveLetters: ["E:"],
  SystemDrive: "C:",
  UniqueId: "disk-id",
};

describe("Windows disk inventory", () => {
  it("accepts explicit empty inventory and complete disk records", () => {
    expect(parseWindowsDiskInventory("[]")).toEqual([]);
    expect(parseWindowsDiskInventory(JSON.stringify([disk]))).toEqual([disk]);
  });

  it.each([
    { IsBoot: undefined },
    { IsSystem: undefined },
    { IsBoot: "false" },
    { Size: -1 },
    { Size: 0.5 },
    { Size: Number.MAX_SAFE_INTEGER + 1 },
    { Number: -1 },
    { Number: "2" },
    { BusType: null },
    { SystemDrive: undefined },
    { SystemDrive: "" },
    { DriveLetters: null },
    { DriveLetters: ["E:", 3] },
    { DriveLetters: ["C:\\"] },
    { UniqueId: 5 },
  ])("rejects incomplete or malformed inventory: %j", (changes) => {
    expect(() =>
      parseWindowsDiskInventory(JSON.stringify([{ ...disk, ...changes }])),
    ).toThrow();
  });

  it.each(["", "null", "{}", "[null]", JSON.stringify([disk, disk])])(
    "rejects ambiguous inventory %s",
    (output) => {
      expect(() => parseWindowsDiskInventory(output)).toThrow();
    },
  );

  it.each(["IsBoot", "IsSystem"] as const)(
    "protects disks marked %s",
    (flag) => {
      const [raw] = parseWindowsDiskInventory(
        JSON.stringify([{ ...disk, [flag]: true }]),
      );
      if (!raw) throw new Error("Expected one disk");
      expect(
        classifyDiskSafety({
          number: raw.Number,
          friendlyName: raw.FriendlyName,
          size: raw.Size,
          busType: raw.BusType,
          isBoot: raw.IsBoot,
          isSystem: raw.IsSystem,
          driveLetters: raw.DriveLetters,
          systemDrive: raw.SystemDrive,
        }).safety,
      ).toBe("blocked-system");
    },
  );
});

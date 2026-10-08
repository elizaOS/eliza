import { describe, expect, it } from "vitest";
import { createZipArchive } from "./zip-utils.ts";

function generalPurposeFlag(zip: Buffer): number {
  expect(zip.readUInt32LE(0)).toBe(0x04034b50);
  return zip.readUInt16LE(6);
}

function centralDirectoryFlag(zip: Buffer): number {
  const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  const at = zip.indexOf(signature);
  expect(at).toBeGreaterThan(0);
  return zip.readUInt16LE(at + 8);
}

describe("createZipArchive filenames", () => {
  it("marks a non-ASCII entry name as UTF-8", () => {
    const name = "café.txt";
    const zip = createZipArchive([{ name, data: "hi" }]);
    const nameBytes = Buffer.from(name, "utf8");
    expect(zip.subarray(30, 30 + nameBytes.length)).toEqual(nameBytes);
    // APPNOTE bit 11. Without it, readers treat the UTF-8 bytes as CP437.
    expect(generalPurposeFlag(zip) & 0x0800).toBe(0x0800);
    expect(centralDirectoryFlag(zip) & 0x0800).toBe(0x0800);
  });

  it("leaves an ASCII entry name without the UTF-8 flag", () => {
    const zip = createZipArchive([{ name: "notes.txt", data: "hi" }]);
    expect(generalPurposeFlag(zip) & 0x0800).toBe(0);
    expect(centralDirectoryFlag(zip) & 0x0800).toBe(0);
  });
});

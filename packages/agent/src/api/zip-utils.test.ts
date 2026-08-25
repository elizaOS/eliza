/**
 * Covers createZipArchive: STORE-method packing, CRC32, DOS date/time (including
 * the 1980–2107 clamp), empty / single / multi-entry archives, insertion order,
 * Buffer / Uint8Array / string payloads, name normalization (backslashes, leading
 * slashes, empty, null byte, `.` / `..`), and the 65535-entry overflow guard.
 * Parses the real PKZIP bytes; no mocks.
 */
import { describe, expect, it } from "vitest";
import { createZipArchive } from "./zip-utils";

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const STORE_METHOD = 0;
const ZIP_VERSION = 20;
const MAX_ZIP_ENTRIES = 0xffff;

/** ITU-T V.42 / ISO 3309 / PKZIP CRC-32 (bitwise; not the SUT table). */
function pkzipCrc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

type ZipEntry = {
  name: string;
  data: Buffer;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  method: number;
  flags: number;
  versionNeeded: number;
  extraLength: number;
  dosTime: number;
  dosDate: number;
  localOffset: number;
};

type CentralRecord = {
  name: string;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  method: number;
  flags: number;
  versionMadeBy: number;
  versionNeeded: number;
  extraLength: number;
  commentLength: number;
  diskStart: number;
  internalAttrs: number;
  externalAttrs: number;
  dosTime: number;
  dosDate: number;
  localOffset: number;
};

type Eocd = {
  disk: number;
  cdDisk: number;
  recordsOnDisk: number;
  totalRecords: number;
  cdSize: number;
  cdOffset: number;
  commentLength: number;
};

function parseZip(archive: Buffer): {
  entries: ZipEntry[];
  central: CentralRecord[];
  eocd: Eocd;
} {
  if (archive.length < 22) {
    throw new Error(`archive too short: ${archive.length}`);
  }
  const eocdOff = archive.length - 22;
  if (archive.readUInt32LE(eocdOff) !== EOCD_SIG) {
    throw new Error(`missing EOCD signature at ${eocdOff}`);
  }
  const eocd: Eocd = {
    disk: archive.readUInt16LE(eocdOff + 4),
    cdDisk: archive.readUInt16LE(eocdOff + 6),
    recordsOnDisk: archive.readUInt16LE(eocdOff + 8),
    totalRecords: archive.readUInt16LE(eocdOff + 10),
    cdSize: archive.readUInt32LE(eocdOff + 12),
    cdOffset: archive.readUInt32LE(eocdOff + 16),
    commentLength: archive.readUInt16LE(eocdOff + 20),
  };

  const central: CentralRecord[] = [];
  let pos = eocd.cdOffset;
  for (let i = 0; i < eocd.totalRecords; i += 1) {
    if (archive.readUInt32LE(pos) !== CENTRAL_SIG) {
      throw new Error(`missing central signature at ${pos}`);
    }
    const nameLen = archive.readUInt16LE(pos + 28);
    const extraLen = archive.readUInt16LE(pos + 30);
    const commentLen = archive.readUInt16LE(pos + 32);
    const name = archive
      .subarray(pos + 46, pos + 46 + nameLen)
      .toString("utf-8");
    central.push({
      name,
      versionMadeBy: archive.readUInt16LE(pos + 4),
      versionNeeded: archive.readUInt16LE(pos + 6),
      flags: archive.readUInt16LE(pos + 8),
      method: archive.readUInt16LE(pos + 10),
      dosTime: archive.readUInt16LE(pos + 12),
      dosDate: archive.readUInt16LE(pos + 14),
      crc: archive.readUInt32LE(pos + 16),
      compressedSize: archive.readUInt32LE(pos + 20),
      uncompressedSize: archive.readUInt32LE(pos + 24),
      extraLength: extraLen,
      commentLength: commentLen,
      diskStart: archive.readUInt16LE(pos + 34),
      internalAttrs: archive.readUInt16LE(pos + 36),
      externalAttrs: archive.readUInt32LE(pos + 38),
      localOffset: archive.readUInt32LE(pos + 42),
    });
    pos += 46 + nameLen + extraLen + commentLen;
  }

  const entries: ZipEntry[] = [];
  for (const record of central) {
    const localPos = record.localOffset;
    if (archive.readUInt32LE(localPos) !== LOCAL_SIG) {
      throw new Error(`missing local signature at ${localPos}`);
    }
    const nameLen = archive.readUInt16LE(localPos + 26);
    const extraLen = archive.readUInt16LE(localPos + 28);
    const name = archive
      .subarray(localPos + 30, localPos + 30 + nameLen)
      .toString("utf-8");
    const dataStart = localPos + 30 + nameLen + extraLen;
    const data = Buffer.from(
      archive.subarray(dataStart, dataStart + record.uncompressedSize),
    );
    entries.push({
      name,
      data,
      crc: archive.readUInt32LE(localPos + 14),
      compressedSize: archive.readUInt32LE(localPos + 18),
      uncompressedSize: archive.readUInt32LE(localPos + 22),
      method: archive.readUInt16LE(localPos + 8),
      flags: archive.readUInt16LE(localPos + 6),
      versionNeeded: archive.readUInt16LE(localPos + 4),
      extraLength: extraLen,
      dosTime: archive.readUInt16LE(localPos + 10),
      dosDate: archive.readUInt16LE(localPos + 12),
      localOffset: localPos,
    });
  }

  return { entries, central, eocd };
}

function dosDateTime(
  year: number,
  month: number,
  day: number,
  hours: number,
  minutes: number,
  seconds: number,
): { date: number; time: number } {
  const dosDate = ((year - 1980) << 9) | (month << 5) | day;
  const dosTime = (hours << 11) | (minutes << 5) | Math.floor(seconds / 2);
  return { date: dosDate & 0xffff, time: dosTime & 0xffff };
}

describe("createZipArchive", () => {
  it("packs an empty archive as a 22-byte EOCD with zero records", () => {
    const archive = createZipArchive([]);
    expect(Buffer.isBuffer(archive)).toBe(true);
    expect(archive.length).toBe(22);

    const parsed = parseZip(archive);
    expect(parsed.entries).toEqual([]);
    expect(parsed.central).toEqual([]);
    expect(parsed.eocd).toEqual({
      disk: 0,
      cdDisk: 0,
      recordsOnDisk: 0,
      totalRecords: 0,
      cdSize: 0,
      cdOffset: 0,
      commentLength: 0,
    });
  });

  it("packs a single STORE entry with matching CRC, sizes, and payload", () => {
    const payload = Buffer.from("hello", "utf-8");
    const archive = createZipArchive([{ name: "hello.txt", data: payload }]);
    const parsed = parseZip(archive);

    expect(parsed.eocd.totalRecords).toBe(1);
    expect(parsed.eocd.recordsOnDisk).toBe(1);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.central).toHaveLength(1);

    const [entry] = parsed.entries;
    expect(entry).toBeDefined();
    if (!entry) throw new Error("expected one local entry");
    expect(entry.name).toBe("hello.txt");
    expect(entry.data.equals(payload)).toBe(true);
    expect(entry.method).toBe(STORE_METHOD);
    expect(entry.flags).toBe(0);
    expect(entry.versionNeeded).toBe(ZIP_VERSION);
    expect(entry.extraLength).toBe(0);
    expect(entry.compressedSize).toBe(payload.length);
    expect(entry.uncompressedSize).toBe(payload.length);
    expect(entry.crc).toBe(pkzipCrc32(payload));
    expect(entry.crc).toBe(0x3610a686);
    expect(entry.localOffset).toBe(0);

    const [central] = parsed.central;
    expect(central).toBeDefined();
    if (!central) throw new Error("expected one central record");
    expect(central.name).toBe("hello.txt");
    expect(central.crc).toBe(entry.crc);
    expect(central.method).toBe(STORE_METHOD);
    expect(central.versionMadeBy).toBe(ZIP_VERSION);
    expect(central.versionNeeded).toBe(ZIP_VERSION);
    expect(central.flags).toBe(0);
    expect(central.extraLength).toBe(0);
    expect(central.commentLength).toBe(0);
    expect(central.diskStart).toBe(0);
    expect(central.internalAttrs).toBe(0);
    expect(central.externalAttrs).toBe(0);
    expect(central.localOffset).toBe(0);
    expect(central.compressedSize).toBe(payload.length);
    expect(central.uncompressedSize).toBe(payload.length);
    expect(central.dosTime).toBe(entry.dosTime);
    expect(central.dosDate).toBe(entry.dosDate);
  });

  it("preserves insertion order across multiple entries, including duplicate names", () => {
    const archive = createZipArchive([
      { name: "b.txt", data: "second-written-first" },
      { name: "a.txt", data: "a" },
      { name: "b.txt", data: "duplicate-name" },
    ]);
    const parsed = parseZip(archive);

    expect(parsed.eocd.totalRecords).toBe(3);
    expect(parsed.entries.map((entry) => entry.name)).toEqual([
      "b.txt",
      "a.txt",
      "b.txt",
    ]);
    expect(parsed.entries.map((entry) => entry.data.toString("utf-8"))).toEqual(
      ["second-written-first", "a", "duplicate-name"],
    );
    expect(parsed.central.map((record) => record.localOffset)).toEqual(
      parsed.entries.map((entry) => entry.localOffset),
    );

    const first = parsed.entries[0];
    const second = parsed.entries[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (!first || !second) throw new Error("expected first two entries");
    expect(first.localOffset).toBe(0);
    expect(second.localOffset).toBe(
      30 + Buffer.byteLength(first.name, "utf-8") + first.data.length,
    );
  });

  it("accepts string, Buffer, and Uint8Array payloads including empty and sliced views", () => {
    const parent = new Uint8Array([0, 1, 2, 3, 4, 5]);
    const view = parent.subarray(1, 4);
    const bufferPayload = Buffer.from([0xde, 0xad, 0xbe, 0xef]);

    const archive = createZipArchive([
      { name: "empty.txt", data: "" },
      { name: "utf8.txt", data: "héllo" },
      { name: "buf.bin", data: bufferPayload },
      { name: "view.bin", data: view },
    ]);
    const parsed = parseZip(archive);

    expect(parsed.entries).toHaveLength(4);
    expect(parsed.entries[0]?.data.equals(Buffer.alloc(0))).toBe(true);
    expect(parsed.entries[0]?.crc).toBe(0);
    expect(parsed.entries[1]?.data.toString("utf-8")).toBe("héllo");
    expect(parsed.entries[1]?.crc).toBe(
      pkzipCrc32(Buffer.from("héllo", "utf-8")),
    );
    expect(parsed.entries[2]?.data.equals(bufferPayload)).toBe(true);
    expect(parsed.entries[3]?.data.equals(Buffer.from([1, 2, 3]))).toBe(true);
    for (const entry of parsed.entries) {
      expect(entry.crc).toBe(pkzipCrc32(entry.data));
      expect(entry.compressedSize).toBe(entry.uncompressedSize);
    }
  });

  it("matches the published CRC-32 of 123456789 and a 64 KiB STORE payload", () => {
    const vector = Buffer.from("123456789", "utf-8");
    expect(pkzipCrc32(vector)).toBe(0xcbf43926);

    const large = Buffer.alloc(64 * 1024, 0x5a);
    const archive = createZipArchive([
      { name: "vector.txt", data: vector },
      { name: "large.bin", data: large },
    ]);
    const parsed = parseZip(archive);
    expect(parsed.entries[0]?.crc).toBe(0xcbf43926);
    expect(parsed.entries[1]?.data.equals(large)).toBe(true);
    expect(parsed.entries[1]?.crc).toBe(pkzipCrc32(large));
    expect(parsed.entries[1]?.uncompressedSize).toBe(64 * 1024);
  });

  it("normalizes backslashes and strips leading slashes without treating dotted filenames as traversal", () => {
    const archive = createZipArchive([
      { name: "foo\\bar\\baz.txt", data: "win" },
      { name: "/docs/readme.md", data: "abs" },
      { name: "///nested/file", data: "slashes" },
      { name: ".hidden", data: "dotfile" },
      { name: "dir/.hidden", data: "nested-dot" },
      { name: "my file (1).txt", data: "spaces" },
    ]);
    const names = parseZip(archive).entries.map((entry) => entry.name);
    expect(names).toEqual([
      "foo/bar/baz.txt",
      "docs/readme.md",
      "nested/file",
      ".hidden",
      "dir/.hidden",
      "my file (1).txt",
    ]);
  });

  it("rejects empty names after slash stripping", () => {
    for (const name of ["", "/", "///", "\\", "\\\\"]) {
      expect(() => createZipArchive([{ name, data: "x" }])).toThrow(
        "ZIP entry name cannot be empty",
      );
    }
  });

  it("rejects names that contain a null byte", () => {
    expect(() =>
      createZipArchive([{ name: "foo\0bar.txt", data: "x" }]),
    ).toThrow("ZIP entry name contains invalid null byte");
  });

  it("rejects `.` and `..` path components using the original name in the error", () => {
    const unsafe = [
      ".",
      "..",
      "./x",
      "../x",
      "foo/.",
      "foo/..",
      "foo/./bar",
      "foo/../bar",
      "foo\\..\\bar",
    ];
    for (const name of unsafe) {
      expect(() => createZipArchive([{ name, data: "x" }])).toThrow(
        `ZIP entry name is not safe: ${name}`,
      );
    }
  });

  it("stores UTF-8 entry names and nested directory paths", () => {
    const archive = createZipArchive([
      { name: "文件.txt", data: "han" },
      { name: "dir/sub/file.txt", data: "nested" },
    ]);
    const parsed = parseZip(archive);
    expect(parsed.entries.map((entry) => entry.name)).toEqual([
      "文件.txt",
      "dir/sub/file.txt",
    ]);
    expect(parsed.central.map((record) => record.name)).toEqual([
      "文件.txt",
      "dir/sub/file.txt",
    ]);
  });

  it("encodes an explicit mtime with 2-second DOS resolution", () => {
    const mtime = new Date(2024, 5, 15, 14, 30, 8);
    const expected = dosDateTime(2024, 6, 15, 14, 30, 8);
    const archive = createZipArchive([{ name: "dated.txt", data: "x", mtime }]);
    const [entry] = parseZip(archive).entries;
    expect(entry?.dosDate).toBe(expected.date);
    expect(entry?.dosTime).toBe(expected.time);
  });

  it("clamps DOS years below 1980 and above 2107", () => {
    const tooOld = new Date(1970, 0, 1, 0, 0, 0);
    const tooNew = new Date(2108, 0, 1, 23, 59, 59);
    const archive = createZipArchive([
      { name: "old.txt", data: "o", mtime: tooOld },
      { name: "new.txt", data: "n", mtime: tooNew },
    ]);
    const parsed = parseZip(archive);
    const oldExpected = dosDateTime(1980, 1, 1, 0, 0, 0);
    const newExpected = dosDateTime(2107, 1, 1, 23, 59, 59);
    expect(parsed.entries[0]?.dosDate).toBe(oldExpected.date);
    expect(parsed.entries[0]?.dosTime).toBe(oldExpected.time);
    expect(parsed.entries[1]?.dosDate).toBe(newExpected.date);
    expect(parsed.entries[1]?.dosTime).toBe(newExpected.time);
  });

  it("encodes an invalid mtime as DOS date/time zero", () => {
    const archive = createZipArchive([
      { name: "invalid.txt", data: "x", mtime: new Date(Number.NaN) },
    ]);
    const [entry] = parseZip(archive).entries;
    expect(entry?.dosDate).toBe(0);
    expect(entry?.dosTime).toBe(0);
  });

  it("defaults mtime to now within 2-second DOS resolution", () => {
    const before = Date.now();
    const archive = createZipArchive([{ name: "now.txt", data: "x" }]);
    const after = Date.now();
    const [entry] = parseZip(archive).entries;
    expect(entry).toBeDefined();
    if (!entry) throw new Error("expected entry");

    const year = 1980 + ((entry.dosDate >> 9) & 0x7f);
    const month = (entry.dosDate >> 5) & 0x0f;
    const day = entry.dosDate & 0x1f;
    const hours = (entry.dosTime >> 11) & 0x1f;
    const minutes = (entry.dosTime >> 5) & 0x3f;
    const seconds = (entry.dosTime & 0x1f) * 2;
    const encoded = new Date(year, month - 1, day, hours, minutes, seconds);
    // DOS stamps have 2s resolution; allow a 2s pad on each side of the window.
    expect(encoded.getTime()).toBeGreaterThanOrEqual(before - 2000);
    expect(encoded.getTime()).toBeLessThanOrEqual(after + 2000);
  });

  it("throws when the entry list exceeds 65535 files before packing", () => {
    const tooMany = Array.from({ length: MAX_ZIP_ENTRIES + 1 }, (_, i) => ({
      name: `f${i}`,
      data: "",
    }));
    expect(() => createZipArchive(tooMany)).toThrow(
      "ZIP export supports up to 65535 files",
    );
  });

  it("sets EOCD central-directory size and offset to the packed local section", () => {
    const archive = createZipArchive([
      { name: "a.txt", data: "aa" },
      { name: "bb.txt", data: "bbb" },
    ]);
    const parsed = parseZip(archive);
    const localSize = parsed.entries.reduce((sum, entry) => {
      return (
        sum + 30 + Buffer.byteLength(entry.name, "utf-8") + entry.data.length
      );
    }, 0);
    expect(parsed.eocd.cdOffset).toBe(localSize);
    expect(parsed.eocd.cdSize).toBe(
      parsed.central.reduce((sum, record) => {
        return sum + 46 + Buffer.byteLength(record.name, "utf-8");
      }, 0),
    );
    expect(archive.length).toBe(parsed.eocd.cdOffset + parsed.eocd.cdSize + 22);
  });
});

interface ZipEntryInput {
  name: string;
  data: Buffer | Uint8Array | string;
  mtime?: Date;
}

const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i += 1) {
  let crc = i;
  for (let j = 0; j < 8; j += 1) {
    if ((crc & 1) === 1) {
      crc = (crc >>> 1) ^ 0xedb88320;
    } else {
      crc >>>= 1;
    }
  }
  CRC32_TABLE[i] = crc >>> 0;
}

function normalizeZipEntryName(name: string): string {
  const normalized = name.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized) throw new Error("ZIP entry name cannot be empty");
  if (normalized.includes("\0")) {
    throw new Error("ZIP entry name contains invalid null byte");
  }
  const parts = normalized.split("/");
  for (const part of parts) {
    if (part === "." || part === "..") {
      throw new Error(`ZIP entry name is not safe: ${name}`);
    }
  }
  return normalized;
}

function toBuffer(data: Buffer | Uint8Array | string): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === "string") return Buffer.from(data, "utf-8");
  return Buffer.from(data);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    const index = (crc ^ byte) & 0xff;
    crc = (crc >>> 8) ^ (CRC32_TABLE[index] ?? 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toDosDateTime(date: Date): { date: number; time: number } {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  const month = Math.min(Math.max(date.getMonth() + 1, 1), 12);
  const day = Math.min(Math.max(date.getDate(), 1), 31);
  const hours = Math.min(Math.max(date.getHours(), 0), 23);
  const minutes = Math.min(Math.max(date.getMinutes(), 0), 59);
  const seconds = Math.min(Math.max(Math.floor(date.getSeconds() / 2), 0), 29);

  const dosDate = ((year - 1980) << 9) | (month << 5) | day;
  const dosTime = (hours << 11) | (minutes << 5) | seconds;
  return { date: dosDate & 0xffff, time: dosTime & 0xffff };
}

export function createZipArchive(entries: ZipEntryInput[]): Buffer {
  if (entries.length > 0xffff) {
    throw new Error("ZIP export supports up to 65535 files");
  }

  const fileParts: Buffer[] = [];
  const centralDirectoryParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = normalizeZipEntryName(entry.name);
    const nameBuffer = Buffer.from(name, "utf-8");
    const dataBuffer = toBuffer(entry.data);
    const checksum = crc32(dataBuffer);
    const { date, time } = toDosDateTime(entry.mtime ?? new Date());

    const localHeader = Buffer.alloc(30 + nameBuffer.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // local file header signature
    localHeader.writeUInt16LE(20, 4); // version needed to extract
    localHeader.writeUInt16LE(0, 6); // general purpose bit flag
    localHeader.writeUInt16LE(0, 8); // compression method: store
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(dataBuffer.length, 18); // compressed size
    localHeader.writeUInt32LE(dataBuffer.length, 22); // uncompressed size
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length
    nameBuffer.copy(localHeader, 30);

    const centralHeader = Buffer.alloc(46 + nameBuffer.length);
    centralHeader.writeUInt32LE(0x02014b50, 0); // central file header signature
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed to extract
    centralHeader.writeUInt16LE(0, 8); // general purpose bit flag
    centralHeader.writeUInt16LE(0, 10); // compression method: store
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(dataBuffer.length, 20); // compressed size
    centralHeader.writeUInt32LE(dataBuffer.length, 24); // uncompressed size
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra field length
    centralHeader.writeUInt16LE(0, 32); // file comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal file attrs
    centralHeader.writeUInt32LE(0, 38); // external file attrs
    centralHeader.writeUInt32LE(offset, 42); // relative offset of local header
    nameBuffer.copy(centralHeader, 46);

    fileParts.push(localHeader, dataBuffer);
    centralDirectoryParts.push(centralHeader);
    offset += localHeader.length + dataBuffer.length;
  }

  const centralDirectory = Buffer.concat(centralDirectoryParts);
  const endOfCentralDirectory = Buffer.alloc(22);
  endOfCentralDirectory.writeUInt32LE(0x06054b50, 0); // EOCD signature
  endOfCentralDirectory.writeUInt16LE(0, 4); // number of this disk
  endOfCentralDirectory.writeUInt16LE(0, 6); // disk where central directory starts
  endOfCentralDirectory.writeUInt16LE(entries.length, 8); // number of central dir records on this disk
  endOfCentralDirectory.writeUInt16LE(entries.length, 10); // total number of records
  endOfCentralDirectory.writeUInt32LE(centralDirectory.length, 12);
  endOfCentralDirectory.writeUInt32LE(offset, 16); // offset of central directory
  endOfCentralDirectory.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...fileParts, centralDirectory, endOfCentralDirectory]);
}

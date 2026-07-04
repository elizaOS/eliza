/**
 * Minimal zip reader: locate a single entry via the end-of-central-directory
 * record and stream its inflated bytes. Lets the export parsers read
 * `conversations.json` straight out of a `.zip` without unpacking the archive
 * or pulling in a zip dependency. Handles zip64 sentinels; rejects encrypted
 * entries.
 */

import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import { createInflateRaw } from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const ZIP64_SENTINEL_16 = 0xffff;
const ZIP64_SENTINEL_32 = 0xffffffff;
const MAX_EOCD_SEARCH = 22 + 0xffff;

type ZipEntryMetadata = {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  encrypted: boolean;
};

function normalizeEntryName(name: string): string {
  return name.replace(/\\/g, "/");
}

function entryMatches(name: string, targetName: string): boolean {
  const normalized = normalizeEntryName(name);
  return normalized === targetName || normalized.endsWith(`/${targetName}`);
}

async function readRange(
  path: string,
  start: number,
  length: number,
): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function findEndOfCentralDirectory(path: string): Promise<{
  centralDirectoryOffset: number;
  centralDirectorySize: number;
}> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const tailLength = Math.min(size, MAX_EOCD_SEARCH);
    const tailStart = size - tailLength;
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, tailStart);

    for (let offset = tailLength - 22; offset >= 0; offset -= 1) {
      if (tail.readUInt32LE(offset) !== EOCD_SIGNATURE) continue;

      const totalEntries = tail.readUInt16LE(offset + 10);
      const centralDirectorySize = tail.readUInt32LE(offset + 12);
      const centralDirectoryOffset = tail.readUInt32LE(offset + 16);
      if (
        totalEntries === ZIP64_SENTINEL_16 ||
        centralDirectorySize === ZIP64_SENTINEL_32 ||
        centralDirectoryOffset === ZIP64_SENTINEL_32
      ) {
        throw new Error("ZIP64 conversation exports are not supported yet");
      }

      return { centralDirectoryOffset, centralDirectorySize };
    }
  } finally {
    await handle.close();
  }

  throw new Error("Could not find ZIP central directory");
}

export async function findZipEntryMetadata(
  path: string,
  targetName = "conversations.json",
): Promise<ZipEntryMetadata | undefined> {
  const { centralDirectoryOffset, centralDirectorySize } =
    await findEndOfCentralDirectory(path);
  const centralDirectory = await readRange(
    path,
    centralDirectoryOffset,
    centralDirectorySize,
  );

  let offset = 0;
  while (offset + 46 <= centralDirectory.length) {
    if (centralDirectory.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error("Malformed ZIP central directory");
    }

    const generalPurposeFlags = centralDirectory.readUInt16LE(offset + 8);
    const compressionMethod = centralDirectory.readUInt16LE(offset + 10);
    const compressedSize = centralDirectory.readUInt32LE(offset + 20);
    const uncompressedSize = centralDirectory.readUInt32LE(offset + 24);
    const fileNameLength = centralDirectory.readUInt16LE(offset + 28);
    const extraLength = centralDirectory.readUInt16LE(offset + 30);
    const commentLength = centralDirectory.readUInt16LE(offset + 32);
    const localHeaderOffset = centralDirectory.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + fileNameLength;
    const name = centralDirectory.subarray(nameStart, nameEnd).toString("utf8");

    if (
      compressedSize === ZIP64_SENTINEL_32 ||
      uncompressedSize === ZIP64_SENTINEL_32 ||
      localHeaderOffset === ZIP64_SENTINEL_32
    ) {
      throw new Error(
        "ZIP64 conversation export entries are not supported yet",
      );
    }

    if (entryMatches(name, targetName)) {
      return {
        name: normalizeEntryName(name),
        compressionMethod,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
        encrypted: (generalPurposeFlags & 0x1) !== 0,
      };
    }

    offset = nameEnd + extraLength + commentLength;
  }

  return undefined;
}

export async function openZipEntryStream(
  path: string,
  targetName = "conversations.json",
): Promise<Readable> {
  const metadata = await findZipEntryMetadata(path, targetName);
  if (!metadata) {
    throw new Error(`ZIP export does not contain ${targetName}`);
  }
  if (metadata.encrypted) {
    throw new Error("Encrypted ZIP conversation exports are not supported");
  }
  if (metadata.compressionMethod !== 0 && metadata.compressionMethod !== 8) {
    throw new Error(
      `Unsupported ZIP compression method ${metadata.compressionMethod}`,
    );
  }
  if (metadata.compressedSize === 0) {
    return Readable.from([]);
  }

  const localHeader = await readRange(path, metadata.localHeaderOffset, 30);
  if (localHeader.readUInt32LE(0) !== LOCAL_FILE_HEADER_SIGNATURE) {
    throw new Error("Malformed ZIP local file header");
  }

  const localFileNameLength = localHeader.readUInt16LE(26);
  const localExtraLength = localHeader.readUInt16LE(28);
  const dataStart =
    metadata.localHeaderOffset + 30 + localFileNameLength + localExtraLength;
  const dataEnd = dataStart + metadata.compressedSize - 1;
  const compressed = createReadStream(path, { start: dataStart, end: dataEnd });

  if (metadata.compressionMethod === 0) {
    return compressed;
  }

  return compressed.pipe(createInflateRaw());
}

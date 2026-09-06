/**
 * Decodes the USTAR subset emitted by PGlite into candidate-relative records.
 * It never opens filesystem paths; callers retain candidate filesystem authority.
 * Archive modes are replaced with private database modes at installation.
 */
import { ElizaError } from "@elizaos/core";

export interface CandidateDatabaseArchiveLimits {
  readonly maximumBytes: number;
  readonly maximumEntries: number;
}

export interface CandidateDatabaseArchiveRecord {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly sizeBytes: number;
  readonly offsetBytes: number;
  readonly payload: Uint8Array;
}

function invalid(message: string): never {
  throw new ElizaError(message, {
    code: "AGENT_BACKUP_RESTORE_V3_DATABASE_ARCHIVE_INVALID",
    severity: "fatal",
  });
}

function textField(header: Uint8Array, start: number, end: number): string {
  const field = header.subarray(start, end);
  const nul = field.indexOf(0);
  if (nul >= 0 && field.subarray(nul).some((byte) => byte !== 0)) {
    invalid(
      "Database archive field contains hidden bytes after its terminator",
    );
  }
  // error-policy:J3 malformed archive text is rejected without replacement characters.
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      nul < 0 ? field : field.subarray(0, nul),
    );
  } catch (cause) {
    throw new ElizaError("Database archive field is not valid UTF-8", {
      code: "AGENT_BACKUP_RESTORE_V3_DATABASE_ARCHIVE_INVALID",
      cause,
      severity: "fatal",
    });
  }
}

function octal(header: Uint8Array, start: number, end: number): number {
  // USTAR numeric fields may end in NUL and/or ASCII space.
  const bytes = header.subarray(start, end);
  const text = String.fromCharCode(...bytes)
    .replace(/[\0 ]+$/u, "")
    .trimStart();
  if (!/^[0-7]+$/u.test(text))
    invalid("Database archive has a non-octal numeric field");
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value))
    invalid("Database archive numeric field overflows");
  return value;
}

function archivePath(header: Uint8Array): string {
  const name = textField(header, 0, 100);
  // PGlite emits a single archive-root slash, not a host absolute path.
  const relative = name.startsWith("/") ? name.substring(1) : name;
  if (
    !relative ||
    relative.includes("\\") ||
    relative.includes(":") ||
    Array.from(relative).some(
      (character) =>
        character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127,
    ) ||
    relative
      .split("/")
      .some((part) => !part || part === "." || part === "..") ||
    textField(header, 345, 476) !== ""
  )
    invalid("Database archive path is not an exact candidate-relative path");
  return relative;
}

/** Input is decompressed tar, supplied by the authenticated component reader. */
export async function* decodeCandidateDatabaseArchive(
  input: AsyncIterable<Uint8Array>,
  limits: Readonly<CandidateDatabaseArchiveLimits>,
): AsyncGenerator<Readonly<CandidateDatabaseArchiveRecord>> {
  const maximumBytes = limits.maximumBytes;
  const maximumEntries = limits.maximumEntries;
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes <= 0 ||
    !Number.isSafeInteger(maximumEntries) ||
    maximumEntries <= 0
  )
    invalid("Database archive limits must be positive safe integers");
  const iterator = input[Symbol.asyncIterator]();
  let pending: Uint8Array = new Uint8Array(0);
  let cursor = 0;
  let ended = false;
  const seen = new Map<string, "file" | "directory">();
  const parents = new Set<string>();
  let totalBytes = 0;

  async function read(size: number): Promise<Uint8Array> {
    const output = new Uint8Array(size);
    let filled = 0;
    while (filled < size) {
      if (cursor === pending.byteLength) {
        const next = await iterator.next();
        if (next.done) {
          ended = true;
          invalid("Database archive ended before its complete framing");
        }
        if (
          !(next.value instanceof Uint8Array) ||
          next.value.byteLength === 0
        ) {
          invalid("Database archive emitted an invalid byte fragment");
        }
        pending = next.value;
        cursor = 0;
      }
      const count = Math.min(size - filled, pending.byteLength - cursor);
      output.set(pending.subarray(cursor, cursor + count), filled);
      filled += count;
      cursor += count;
    }
    return output;
  }

  try {
    while (true) {
      const header = await read(512);
      if (header.every((byte) => byte === 0)) {
        if ((await read(512)).some((byte) => byte !== 0)) {
          invalid("Database archive has an incomplete end marker");
        }
        if (cursor !== pending.byteLength)
          invalid("Database archive has trailing bytes");
        const next = await iterator.next();
        if (!next.done)
          invalid("Database archive has trailing records or padding");
        ended = true;
        return;
      }
      let checksum = 0;
      for (const [index, byte] of header.entries())
        checksum += index >= 148 && index < 156 ? 32 : byte;
      if (checksum !== octal(header, 148, 156))
        invalid("Database archive checksum differs");
      if (
        textField(header, 257, 263) !== "ustar" ||
        textField(header, 263, 265) !== "00"
      ) {
        invalid("Database archive is not the supported USTAR format");
      }
      const type = textField(header, 156, 157);
      if (
        (type !== "0" && type !== "5") ||
        textField(header, 157, 257) !== ""
      ) {
        invalid("Database archive contains a link or unsupported entry type");
      }
      // PGlite's tinytar producer uses a 131-byte prefix followed by atime/ctime.
      // These timestamps are metadata, never another path prefix.
      for (const start of [476, 488]) {
        if (header.subarray(start, start + 12).some((byte) => byte !== 0))
          octal(header, start, start + 12);
      }
      if (header.subarray(500).some((byte) => byte !== 0))
        invalid("Database archive has unsupported header extensions");
      const filePath = archivePath(header);
      const sizeBytes = octal(header, 124, 136);
      const kind = type === "5" ? "directory" : "file";
      if (kind === "directory" && sizeBytes !== 0)
        invalid("Database archive directory has data");
      if (seen.has(filePath) || seen.size >= maximumEntries) {
        invalid("Database archive repeats a path or exceeds its entry budget");
      }
      const parts = filePath.split("/");
      for (let i = 1; i < parts.length; i++) {
        if (seen.get(parts.slice(0, i).join("/")) === "file") {
          invalid("Database archive places an entry below a regular file");
        }
      }
      if (kind === "file" && parents.has(filePath)) {
        invalid(
          "Database archive replaces an existing parent directory with a file",
        );
      }
      if (sizeBytes > maximumBytes - totalBytes)
        invalid("Database archive exceeds its expanded byte budget");
      totalBytes += sizeBytes;
      seen.set(filePath, kind);
      for (let i = 1; i < parts.length; i++)
        parents.add(parts.slice(0, i).join("/"));
      if (sizeBytes === 0) {
        yield Object.freeze({
          path: filePath,
          kind,
          sizeBytes,
          offsetBytes: 0,
          payload: new Uint8Array(0),
        });
      }
      for (let offsetBytes = 0; offsetBytes < sizeBytes; ) {
        const payload = await read(
          Math.min(64 * 1024, sizeBytes - offsetBytes),
        );
        try {
          yield Object.freeze({
            path: filePath,
            kind,
            sizeBytes,
            offsetBytes,
            payload,
          });
        } finally {
          payload.fill(0);
        }
        offsetBytes += payload.byteLength;
      }
      const padding = (512 - (sizeBytes % 512)) % 512;
      if (padding && (await read(padding)).some((byte) => byte !== 0)) {
        invalid("Database archive file padding is not zero");
      }
    }
  } finally {
    if (!ended && iterator.return) await iterator.return();
  }
}

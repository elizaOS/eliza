import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

export class PrivateRuntimeFileError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(code);
    this.name = "PrivateRuntimeFileError";
    this.code = code;
  }
}

/**
 * Read-only POSIX private JSON. Hosts own trusted parent directories and schema validation.
 * @param {string} file
 * @param {{maxBytes?: number, ownerUid?: number}} options
 * @returns {Promise<unknown>}
 */
export async function readPrivateRuntimeJson(
  file,
  { maxBytes, ownerUid = process.getuid?.() } = {},
) {
  if (
    typeof file !== "string" ||
    !isAbsolute(file) ||
    typeof maxBytes !== "number" ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 0x7fffffff ||
    typeof ownerUid !== "number" ||
    !Number.isSafeInteger(ownerUid) ||
    ownerUid < 0 ||
    !constants.O_NOFOLLOW ||
    !constants.O_NONBLOCK
  ) {
    throw new PrivateRuntimeFileError("INVALID_PRIVATE_FILE_POLICY");
  }
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.uid !== ownerUid ||
      (info.mode & 0o077) !== 0 ||
      info.size > maxBytes
    ) {
      throw new PrivateRuntimeFileError("INVALID_PRIVATE_FILE");
    }
    const chunks = [];
    let size = 0;
    for (;;) {
      // Read one byte beyond the remaining budget to detect growth after stat.
      const buffer = Buffer.alloc(Math.min(65536, maxBytes - size + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > maxBytes)
        throw new PrivateRuntimeFileError("INVALID_PRIVATE_FILE");
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } finally {
    await handle.close();
  }
}

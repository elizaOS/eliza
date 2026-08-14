/**
 * Container-level validation shared by Android and iOS device recorders. A
 * non-empty `.mp4` is not sufficient evidence: interrupted recorders commonly
 * leave media without the closing `moov` box, which GitHub cannot render.
 */
import fs from "node:fs";

function isNonEmptyFile(filePath) {
  try {
    return fs.statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

export function isFinalizedMp4(filePath) {
  if (!isNonEmptyFile(filePath)) return false;

  const fd = fs.openSync(filePath, "r");
  try {
    const fileSize = fs.fstatSync(fd).size;
    const header = Buffer.alloc(16);
    let offset = 0;
    let sawFileType = false;
    let sawMovie = false;

    while (offset + 8 <= fileSize) {
      const bytesRead = fs.readSync(fd, header, 0, 16, offset);
      if (bytesRead < 8) return false;

      const size32 = header.readUInt32BE(0);
      const type = header.toString("ascii", 4, 8);
      let boxSize = size32;
      let headerSize = 8;
      if (size32 === 1) {
        if (bytesRead < 16) return false;
        const size64 = header.readBigUInt64BE(8);
        if (size64 > BigInt(Number.MAX_SAFE_INTEGER)) return false;
        boxSize = Number(size64);
        headerSize = 16;
      } else if (size32 === 0) {
        boxSize = fileSize - offset;
      }

      if (boxSize < headerSize || offset + boxSize > fileSize) return false;
      if (type === "ftyp") sawFileType = true;
      if (type === "moov") sawMovie = true;
      offset += boxSize;
    }

    return sawFileType && sawMovie && offset === fileSize;
  } finally {
    fs.closeSync(fd);
  }
}

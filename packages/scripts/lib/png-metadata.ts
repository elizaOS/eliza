/** Inspect PNG structure and chunk checksums; this does not decode image pixels. */
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function pngMetadata(
  bytes: Uint8Array,
  complete: boolean,
  minimumWidth = 1,
  minimumHeight = 1,
) {
  if (
    bytes.length < 41 ||
    ![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
      (byte, index) => bytes[index] === byte,
    )
  ) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const validDepths = new Map([
    [0, new Set([1, 2, 4, 8, 16])],
    [2, new Set([8, 16])],
    [3, new Set([1, 2, 4, 8])],
    [4, new Set([8, 16])],
    [6, new Set([8, 16])],
  ]);
  let offset = 8;
  let width = 0;
  let height = 0;
  let hasIdat = false;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = new TextDecoder().decode(
      bytes.subarray(offset + 4, offset + 8),
    );
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > bytes.length) {
      if (
        !complete &&
        type === "IDAT" &&
        width > 0 &&
        bytes.length - dataStart >= 256
      ) {
        return { height, kind: "image", width };
      }
      return null;
    }
    if (
      view.getUint32(dataEnd) !== crc32(bytes.subarray(offset + 4, dataEnd))
    ) {
      return null;
    }
    if (offset === 8) {
      if (type !== "IHDR" || length !== 13) return null;
      width = view.getUint32(dataStart);
      height = view.getUint32(dataStart + 4);
      const bitDepth = bytes[dataStart + 8];
      const colorType = bytes[dataStart + 9];
      if (
        width < minimumWidth ||
        height < minimumHeight ||
        validDepths.get(colorType)?.has(bitDepth) !== true ||
        bytes[dataStart + 10] !== 0 ||
        bytes[dataStart + 11] !== 0 ||
        ![0, 1].includes(bytes[dataStart + 12])
      ) {
        return null;
      }
    } else if (type === "IHDR") {
      return null;
    } else if (type === "IDAT") {
      if (length === 0) return null;
      hasIdat = true;
    } else if (type === "IEND") {
      if (length !== 0 || !hasIdat || chunkEnd !== bytes.length) return null;
      return { height, kind: "image", width };
    }
    offset = chunkEnd;
  }
  return !complete && hasIdat ? { height, kind: "image", width } : null;
}

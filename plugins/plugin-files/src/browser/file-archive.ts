/** Stored ZIP entries: portable downloads without executable archive paths. */
export function fileArchive(
  files: { path: string; bytes: Uint8Array<ArrayBuffer> }[],
) {
  const parts: BlobPart[] = [],
    central: BlobPart[] = [];
  let offset = 0,
    centralSize = 0;
  // 0xffff is the ZIP64 sentinel in the EOCD entry-count fields. This writer
  // does not emit ZIP64 records, so that count cannot be represented safely.
  if (files.length >= 0xffff) throw Error("Choose fewer than 65,535 files.");
  const paths = new Set<string>();
  for (const file of files) {
    const path = file.path.endsWith("/") ? file.path.slice(0, -1) : file.path;
    if (
      !path ||
      /[\\\0]/.test(path) ||
      /^[a-z]:/i.test(path) ||
      path
        .split("/")
        .some((part) => !part.trim() || [".", ".."].includes(part.trim())) ||
      paths.has(path)
    )
      throw Error("Choose files with distinct relative archive paths.");
    paths.add(path);
    const name = new TextEncoder().encode(file.path);
    if (name.length > 65535 || file.bytes.length > 0xffffffff)
      throw Error("Choose a smaller selection.");
    let crc = 0xffffffff;
    for (const byte of file.bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = new Uint8Array(30),
      h = new DataView(header.buffer);
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, 20, true);
    h.setUint16(6, 0x800, true);
    h.setUint16(12, 33, true);
    h.setUint32(14, crc, true);
    h.setUint32(18, file.bytes.length, true);
    h.setUint32(22, file.bytes.length, true);
    h.setUint16(26, name.length, true);
    const record = new Uint8Array(46),
      c = new DataView(record.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x800, true);
    c.setUint16(14, 33, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, file.bytes.length, true);
    c.setUint32(24, file.bytes.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    parts.push(header, name, file.bytes);
    central.push(record, name);
    offset += 30 + name.length + file.bytes.length;
    centralSize += 46 + name.length;
    if (offset + centralSize > 0xffffffff)
      throw Error("Choose a smaller selection.");
  }
  const end = new Uint8Array(22),
    e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, files.length, true);
  e.setUint16(10, files.length, true);
  e.setUint32(12, centralSize, true);
  e.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: "application/zip" });
}

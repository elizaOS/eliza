import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** Fail before staging a musl agent library into Android's bionic JNI namespace. */
export function assertAndroidElf(bytes, abi) {
  const machines = { "arm64-v8a": 183, x86_64: 62 };
  if (!machines[abi])
    throw new Error(`Unsupported native inference ABI: ${abi}`);
  if (
    bytes.length < 64 ||
    bytes.toString("hex", 0, 4) !== "7f454c46" ||
    bytes[4] !== 2 ||
    bytes[5] !== 1
  ) {
    throw new Error(
      "Native inference library must be a little-endian ELF64 shared library",
    );
  }
  if (
    bytes.readUInt16LE(16) !== 3 ||
    bytes.readUInt16LE(18) !== machines[abi]
  ) {
    throw new Error(`Native inference library does not match Android ${abi}`);
  }
  const sectionOffset = Number(bytes.readBigUInt64LE(40));
  const entrySize = bytes.readUInt16LE(58);
  const count = bytes.readUInt16LE(60);
  const namesIndex = bytes.readUInt16LE(62);
  if (
    !Number.isSafeInteger(sectionOffset) ||
    entrySize < 64 ||
    count === 0 ||
    namesIndex >= count ||
    sectionOffset + entrySize * count > bytes.length
  )
    throw new Error("Invalid ELF section table");
  const section = (index) => {
    const offset = sectionOffset + index * entrySize;
    const start = Number(bytes.readBigUInt64LE(offset + 24));
    const size = Number(bytes.readBigUInt64LE(offset + 32));
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(size) ||
      start + size > bytes.length
    ) {
      throw new Error("Invalid ELF section bounds");
    }
    return { offset, start, size };
  };
  const needed = [];
  for (let i = 0; i < count; i++) {
    const offset = sectionOffset + i * entrySize;
    if (bytes.readUInt32LE(offset + 4) !== 6) continue;
    const dynamic = section(i);
    const stringsIndex = bytes.readUInt32LE(offset + 40);
    if (stringsIndex >= count || dynamic.size % 16 !== 0)
      throw new Error("Invalid ELF dynamic section");
    const strings = section(stringsIndex);
    for (
      let cursor = dynamic.start;
      cursor < dynamic.start + dynamic.size;
      cursor += 16
    ) {
      const tag = bytes.readBigInt64LE(cursor);
      if (tag === 0n) break;
      if (tag !== 1n) continue;
      const name = Number(bytes.readBigUInt64LE(cursor + 8));
      const end = bytes.indexOf(0, strings.start + name);
      if (
        !Number.isSafeInteger(name) ||
        name >= strings.size ||
        end < strings.start + name ||
        end >= strings.start + strings.size
      )
        throw new Error("Invalid ELF dependency name");
      needed.push(bytes.toString("utf8", strings.start + name, end));
    }
  }
  const names = section(namesIndex);
  for (let i = 0; i < count; i++) {
    const offset = sectionOffset + i * entrySize;
    const name = bytes.readUInt32LE(offset);
    const start = names.start + name;
    const end = bytes.indexOf(0, start);
    if (name >= names.size || end < start || end >= names.start + names.size)
      throw new Error("Invalid ELF section name");
    if (bytes.toString("utf8", start, end) !== ".note.android.ident") continue;
    const note = section(i);
    if (
      bytes.readUInt32LE(offset + 4) !== 7 ||
      note.size < 24 ||
      bytes.readUInt32LE(note.start) !== 8 ||
      bytes.readUInt32LE(note.start + 8) !== 1 ||
      bytes.toString("ascii", note.start + 12, note.start + 20) !== "Android\0"
    ) {
      throw new Error("Invalid Android NDK identity note");
    }
    return needed;
  }
  throw new Error(
    "Native JNI inference library lacks Android NDK identity; musl agent libraries belong only in assets/agent. Supply a bionic Android NDK build via ELIZA_MTP_ANDROID_LIBDIR.",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const library = process.argv[2];
  const needed = assertAndroidElf(readFileSync(library), process.argv[3]);
  if (
    needed.includes("libc++_shared.so") &&
    !existsSync(join(dirname(library), "libc++_shared.so"))
  ) {
    throw new Error(
      "JNI inference requires libc++_shared.so beside its configured source library; stage the matching Android NDK C++ runtime too.",
    );
  }
}

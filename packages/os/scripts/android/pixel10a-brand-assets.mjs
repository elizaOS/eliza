/**
 * Optional reviewed brand assets of a Pixel 10a product. A composition pins each
 * asset by SHA-256 (`brandAssets.bootAnimation.sha256` in
 * android/products/pixel10a-<brand>.json); staging then requires exactly those bytes
 * and installs them on the product partition. A product without a pin keeps the stock
 * asset. Assets change presentation only, never privileges or hardware.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const HEX64 = /^[0-9a-f]{64}$/;
const MAX_BOOT_ANIMATION_BYTES = 64 << 20;
export const BOOT_ANIMATION_DESTINATION =
  "$(TARGET_COPY_OUT_PRODUCT)/media/bootanimation.zip";

/** The composition's optional asset pins. */
export function validateBrandAssets(value) {
  if (value === undefined) return {};
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== "bootAnimation")
  )
    throw new Error("Pixel 10a brandAssets may only pin a bootAnimation");
  const boot = value.bootAnimation;
  if (
    !boot ||
    typeof boot !== "object" ||
    Object.keys(boot).join() !== "sha256" ||
    !HEX64.test(boot.sha256)
  )
    throw new Error("Pixel 10a bootAnimation must pin exactly its sha256");
  return value;
}

/**
 * The stored entries of a bootanimation.zip: every entry uncompressed (the boot
 * animation daemon maps frames directly), safe relative names, a root desc.txt, and
 * at least one PNG frame in every part desc.txt declares.
 */
export function inspectBootAnimationArchive(bytes) {
  const fail = (message) => {
    throw new Error(`bootanimation.zip ${message}`);
  };
  if (!Buffer.isBuffer(bytes) || bytes.length < 22)
    fail("is not a ZIP archive");
  let eocd = -1;
  for (
    let at = bytes.length - 22;
    at >= Math.max(0, bytes.length - 22 - 0xffff);
    at--
  )
    if (bytes.readUInt32LE(at) === 0x06054b50) {
      eocd = at;
      break;
    }
  if (eocd < 0) fail("has no end-of-central-directory record");
  const count = bytes.readUInt16LE(eocd + 10),
    size = bytes.readUInt32LE(eocd + 12),
    offset = bytes.readUInt32LE(eocd + 16);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff)
    fail("uses ZIP64, which a boot animation never needs");
  if (offset + size > eocd) fail("has a central directory outside the archive");
  const entries = new Map();
  let at = offset;
  for (let index = 0; index < count; index++) {
    if (at + 46 > offset + size || bytes.readUInt32LE(at) !== 0x02014b50)
      fail("has a malformed central directory");
    const method = bytes.readUInt16LE(at + 10),
      compressed = bytes.readUInt32LE(at + 20),
      uncompressed = bytes.readUInt32LE(at + 24),
      nameLength = bytes.readUInt16LE(at + 28),
      extraLength = bytes.readUInt16LE(at + 30),
      commentLength = bytes.readUInt16LE(at + 32),
      local = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    if (
      !name ||
      name.startsWith("/") ||
      name.includes("\\") ||
      name.split("/").some((part) => !part || part === "." || part === "..")
    )
      fail(`has an unsafe entry name ${JSON.stringify(name)}`);
    if (method !== 0 || compressed !== uncompressed)
      fail(`entry ${name} is compressed; every entry must be stored`);
    if (entries.has(name)) fail(`repeats entry ${name}`);
    if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50)
      fail(`entry ${name} has no local header`);
    const data =
      local +
      30 +
      bytes.readUInt16LE(local + 26) +
      bytes.readUInt16LE(local + 28);
    if (data + compressed > bytes.length) fail(`entry ${name} is truncated`);
    entries.set(name, bytes.subarray(data, data + compressed));
  }
  const desc = entries.get("desc.txt");
  if (!desc) fail("has no root desc.txt");
  const parts = [
    ...new Set(
      desc
        .toString("utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^[pcf]\s/.test(line))
        .map((line) => line.split(/\s+/)[3]),
    ),
  ];
  if (!parts.length) fail("desc.txt declares no animation parts");
  for (const part of parts)
    if (
      !part ||
      ![...entries.keys()].some(
        (name) =>
          name.startsWith(`${part}/`) &&
          name
            .slice(part.length + 1)
            .toLowerCase()
            .endsWith(".png") &&
          !name.slice(part.length + 1).includes("/"),
      )
    )
      fail(`part ${part} has no PNG frames`);
  return { entries: [...entries.keys()].sort(), parts };
}

/**
 * Verify the brand's pinned assets against the supplied files without writing.
 * Returns the bytes to install and their evidence.
 */
export function admitBrandAssets(product, { bootAnimation = null } = {}) {
  const pins = validateBrandAssets(product.brandAssets);
  const pinned = pins.bootAnimation?.sha256 ?? null;
  if (!pinned) {
    if (bootAnimation)
      throw new Error(
        `${product.productName} pins no boot animation; record its sha256 in the composition first`,
      );
    return { files: [], evidence: { bootAnimation: null } };
  }
  if (!bootAnimation)
    throw new Error(
      `${product.productName} pins a boot animation; supply the reviewed bootanimation.zip`,
    );
  const stat = fs.lstatSync(bootAnimation);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > MAX_BOOT_ANIMATION_BYTES
  )
    throw new Error(
      "The boot animation must be a regular file of at most 64 MiB",
    );
  const bytes = fs.readFileSync(bootAnimation);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== pinned)
    throw new Error(
      `The boot animation is ${sha256}, not the composition's pinned ${pinned}`,
    );
  const { parts } = inspectBootAnimationArchive(bytes);
  return {
    files: [{ path: "brand/bootanimation.zip", bytes }],
    // The composition is staged at vendor/<vendorDirectory> in the source tree.
    makefile: `\n# Reviewed brand boot animation (brandAssets.bootAnimation).\nPRODUCT_COPY_FILES += vendor/${product.vendorDirectory}/brand/bootanimation.zip:${BOOT_ANIMATION_DESTINATION}\n`,
    evidence: { bootAnimation: { sha256, sizeBytes: bytes.length, parts } },
  };
}

/** Install admitted assets into a new overlay directory. */
export function writeBrandAssets(output, admitted) {
  for (const file of admitted.files) {
    const target = path.join(output, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.bytes, { flag: "wx" });
  }
}

#!/usr/bin/env node
/**
 * Version/hash compatibility record for one signed AOSP release.
 *
 * Reads a signed target-files zip and its OTA package and writes, as JSON, the
 * identities a signed update, rollback or recovery decision compares: build
 * fingerprints, versions and security patch levels, the vbmeta image hashes and their
 * AVB rollback indexes, the payload hash and OTA metadata, the release certificate
 * digests and the application signer digests a product's APK verification recorded.
 * It only reads archives (with `unzip`); it never reads private keys, applies an
 * update or flashes a device, and every record says so: imageBooted,
 * signedUpdateApplied, releaseQualified and deviceAcceptanceVerified stay false.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RECORD_KIND = "aosp-release-compatibility";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function fileSha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** SHA-256 of an X.509 certificate's DER bytes: the digest apksigner prints. */
export function certificateSha256(pem) {
  return new X509Certificate(pem).fingerprint256
    .replaceAll(":", "")
    .toLowerCase();
}

export function entries(zip) {
  return execFileSync("unzip", ["-Z1", zip], {
    encoding: "utf8",
    maxBuffer: 256 << 20,
  })
    .split(/\r?\n/)
    .filter(Boolean);
}
export function entry(zip, name) {
  return execFileSync("unzip", ["-p", zip, name], { maxBuffer: 256 << 20 });
}
/** Stream-hash one zip entry (payload.bin is several GB). */
function entrySha256(zip, name) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    let size = 0;
    const child = spawn("unzip", ["-p", zip, name], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      hash.update(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve({ sha256: hash.digest("hex"), sizeBytes: size })
        : reject(new Error(`unzip ${name} from ${zip} exited ${code}`)),
    );
  });
}

/** key=value lines (build.prop, payload_properties.txt, OTA metadata); comments ignored. */
export function parseProperties(text) {
  const values = {};
  for (const line of String(text).split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const at = line.indexOf("=");
    if (at > 0) values[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return values;
}

/** `key="value"` rows (META/apkcerts.txt, META/apexkeys.txt). */
export function parseQuotedRows(text) {
  return String(text)
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) =>
      Object.fromEntries(
        [...line.matchAll(/([A-Za-z_]+)="([^"]*)"/g)].map((match) => [
          match[1],
          match[2],
        ]),
      ),
    );
}

/**
 * Chained AVB partitions of a target-files build, from META/misc_info.txt: every
 * partition with its own `avb_<partition>_key_path` (vbmeta_system, vbmeta_vendor,
 * boot, init_boot, vendor_boot, ...) other than vbmeta itself. Each one needs its
 * own --avb_<partition>_key at signing time.
 */
export function chainedPartitionsFromMiscInfo(info) {
  return Object.keys(info)
    .map((key) => /^avb_([a-z0-9_]+)_key_path$/.exec(key)?.[1])
    .filter((name) => name && name !== "vbmeta" && info[`avb_${name}_key_path`])
    .sort();
}

/** Public certificate digests of a key directory (x509 certificates only; private keys are never opened). */
export function keyCertificates(keysDir, names) {
  const result = {};
  for (const name of names) {
    const file = path.join(keysDir, `${name}.x509.pem`);
    if (!fs.existsSync(file)) {
      result[name] = null;
      continue;
    }
    try {
      result[name] = certificateSha256(fs.readFileSync(file));
    } catch {
      result[name] = "invalid certificate";
    }
  }
  return result;
}

const AVB_HEADER_SIZE = 256;
const AVB_FOOTER_SIZE = 64;
const AVB_CHAIN_PARTITION_TAG = 4n;
const AVB_CHAIN_PARTITION_FIXED = 92;

/**
 * The vbmeta struct of an AVB image: a vbmeta image itself, or the struct an
 * `AVBf` footer locates at the end of a hash/hashtree-footer partition image.
 */
export function vbmetaStruct(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < AVB_HEADER_SIZE) return null;
  if (bytes.subarray(0, 4).toString("latin1") === "AVB0") return bytes;
  const footer = bytes.subarray(bytes.length - AVB_FOOTER_SIZE);
  if (footer.subarray(0, 4).toString("latin1") !== "AVBf") return null;
  const offset = footer.readBigUInt64BE(20),
    size = footer.readBigUInt64BE(28);
  if (offset + size > BigInt(bytes.length - AVB_FOOTER_SIZE)) return null;
  const struct = bytes.subarray(Number(offset), Number(offset + size));
  return struct.subarray(0, 4).toString("latin1") === "AVB0" ? struct : null;
}

/**
 * Rollback index, its header location and chain-partition descriptors of a vbmeta
 * struct (AvbVBMetaImageHeader and AvbChainPartitionDescriptor, big-endian). Returns
 * null for anything that is not a well-formed vbmeta struct. Signatures are not
 * verified here; avbtool and the bootloader do that.
 */
export function parseVbmeta(bytes) {
  const struct = vbmetaStruct(bytes);
  if (!struct) return null;
  const authSize = struct.readBigUInt64BE(12),
    auxSize = struct.readBigUInt64BE(20);
  const descriptorsOffset = struct.readBigUInt64BE(96),
    descriptorsSize = struct.readBigUInt64BE(104);
  const auxStart = BigInt(AVB_HEADER_SIZE) + authSize;
  if (
    auxStart + auxSize > BigInt(struct.length) ||
    descriptorsOffset + descriptorsSize > auxSize
  )
    return null;
  const chains = [];
  let at = auxStart + descriptorsOffset;
  const end = at + descriptorsSize;
  while (at + 16n <= end) {
    const tag = struct.readBigUInt64BE(Number(at)),
      following = struct.readBigUInt64BE(Number(at) + 8);
    const next = at + 16n + following;
    if (following % 8n !== 0n || next > end) return null;
    if (tag === AVB_CHAIN_PARTITION_TAG) {
      const base = Number(at);
      if (following + 16n < BigInt(AVB_CHAIN_PARTITION_FIXED)) return null;
      const location = struct.readUInt32BE(base + 16),
        nameLength = struct.readUInt32BE(base + 20),
        keyLength = struct.readUInt32BE(base + 24);
      if (
        BigInt(AVB_CHAIN_PARTITION_FIXED + nameLength + keyLength) >
        following + 16n
      )
        return null;
      const name = struct
        .subarray(
          base + AVB_CHAIN_PARTITION_FIXED,
          base + AVB_CHAIN_PARTITION_FIXED + nameLength,
        )
        .toString("utf8");
      const publicKey = struct.subarray(
        base + AVB_CHAIN_PARTITION_FIXED + nameLength,
        base + AVB_CHAIN_PARTITION_FIXED + nameLength + keyLength,
      );
      chains.push({
        partition: name,
        rollbackIndexLocation: location,
        publicKeySha256: sha256(publicKey),
      });
    }
    at = next;
  }
  return {
    rollbackIndex: struct.readBigUInt64BE(112).toString(),
    flags: struct.readUInt32BE(120),
    rollbackIndexLocation: struct.readUInt32BE(124),
    chains,
  };
}

/**
 * The AVB rollback index each location of a signed build carries: the main vbmeta's
 * own location, and for each chained partition the location its chain descriptor
 * assigns with the index from that partition's own vbmeta struct. Problems name an
 * unreadable image or a chained partition the main vbmeta does not chain.
 */
export function rollbackIndexes(images) {
  const problems = [];
  const main = images.vbmeta ? parseVbmeta(images.vbmeta) : null;
  if (!main)
    return {
      indexes: [],
      problems: ["IMAGES/vbmeta.img is not an AVB vbmeta image"],
    };
  const indexes = [
    {
      partition: "vbmeta",
      location: main.rollbackIndexLocation,
      index: main.rollbackIndex,
    },
  ];
  for (const [partition, bytes] of Object.entries(images)) {
    if (partition === "vbmeta" || !bytes) continue;
    const chain = main.chains.find((row) => row.partition === partition);
    if (!chain) {
      problems.push(`vbmeta does not chain ${partition}`);
      continue;
    }
    const parsed = parseVbmeta(bytes);
    if (!parsed) {
      problems.push(`IMAGES/${partition}.img carries no AVB vbmeta struct`);
      continue;
    }
    indexes.push({
      partition,
      location: chain.rollbackIndexLocation,
      index: parsed.rollbackIndex,
    });
  }
  const locations = new Set();
  for (const row of indexes) {
    if (locations.has(row.location))
      problems.push(
        `AVB rollback index location ${row.location} is used twice`,
      );
    locations.add(row.location);
  }
  return { indexes, problems };
}

/**
 * Build the compatibility record. `product` and `channel` are the parsed release
 * descriptor and update channel; `apkManifest` is the product's APK verification
 * manifest (optional; rows with mode "release"). Problems found while reading are
 * listed in `problems`; a record with problems is evidence of a mismatch, never an
 * admission.
 */
export async function compatibilityRecord({
  signedTargetFiles,
  ota,
  product,
  channel,
  apkManifest = null,
  certificates = {},
  avbPublicKeySha256 = null,
  inputs = {},
  incrementalFrom = null,
  createdAt = new Date().toISOString(),
}) {
  const problems = [];
  /** A missing input is recorded as a problem and read as `fallback`, never filled in. */
  const missing = (message, fallback) => {
    problems.push(message);
    return fallback;
  };
  const tf = entries(signedTargetFiles);
  const props = (name) =>
    tf.includes(name)
      ? parseProperties(entry(signedTargetFiles, name).toString("utf8"))
      : missing(`${name} is missing from the signed target-files`, {});
  const system = props("SYSTEM/build.prop");
  const vendor = tf.includes("VENDOR/build.prop")
    ? parseProperties(
        entry(signedTargetFiles, "VENDOR/build.prop").toString("utf8"),
      )
    : {};
  // The required images derive from the signed build's own chained-partition list.
  const miscInfo = tf.includes("META/misc_info.txt")
    ? parseProperties(
        entry(signedTargetFiles, "META/misc_info.txt").toString("utf8"),
      )
    : missing("META/misc_info.txt is missing from the signed target-files", {});
  const chainedPartitions = chainedPartitionsFromMiscInfo(miscInfo);
  const images = {},
    imageBytes = {};
  for (const name of ["vbmeta", ...chainedPartitions]) {
    const file = `IMAGES/${name}.img`;
    imageBytes[name] = tf.includes(file)
      ? entry(signedTargetFiles, file)
      : null;
    images[name] = imageBytes[name] ? sha256(imageBytes[name]) : null;
    if (!images[name])
      problems.push(`${file} is missing from the signed target-files`);
  }
  const rollback = imageBytes.vbmeta
    ? rollbackIndexes(imageBytes)
    : { indexes: [], problems: [] };
  problems.push(...rollback.problems);
  const otaEntries = entries(ota);
  const payload = otaEntries.includes("payload.bin")
    ? await entrySha256(ota, "payload.bin")
    : missing("payload.bin is missing from the OTA package", null);
  const payloadProperties = otaEntries.includes("payload_properties.txt")
    ? parseProperties(entry(ota, "payload_properties.txt").toString("utf8"))
    : missing("payload_properties.txt is missing from the OTA package", {});
  const metadata = otaEntries.includes("META-INF/com/android/metadata")
    ? parseProperties(
        entry(ota, "META-INF/com/android/metadata").toString("utf8"),
      )
    : missing(
        "META-INF/com/android/metadata is missing from the OTA package",
        {},
      );
  const fingerprint =
    system["ro.system.build.fingerprint"] ??
    system["ro.build.fingerprint"] ??
    null;
  if (!fingerprint)
    problems.push("the signed target-files records no build fingerprint");
  if (
    metadata["post-build"] &&
    fingerprint &&
    metadata["post-build"] !== fingerprint
  )
    problems.push(
      `OTA post-build ${metadata["post-build"]} is not the target-files fingerprint ${fingerprint}`,
    );
  if (
    payload &&
    payloadProperties.FILE_HASH &&
    Buffer.from(payload.sha256, "hex").toString("base64") !==
      payloadProperties.FILE_HASH
  )
    problems.push(
      "payload_properties.txt FILE_HASH is not the payload.bin SHA-256",
    );
  if (
    product?.device?.codename &&
    metadata["pre-device"] &&
    metadata["pre-device"] !== product.device.codename
  )
    problems.push(
      `OTA pre-device ${metadata["pre-device"]} is not ${product.device.codename}`,
    );
  if (incrementalFrom && !metadata["pre-build"])
    problems.push("an incremental OTA records no pre-build fingerprint");
  if (!incrementalFrom && metadata["pre-build"])
    problems.push("a full OTA records a pre-build fingerprint");
  if (
    incrementalFrom &&
    !(
      typeof incrementalFrom.file === "string" &&
      /^[0-9a-f]{64}$/.test(incrementalFrom.sha256 ?? "")
    )
  )
    problems.push(
      "incrementalFrom must identify the previous signed target-files by file and SHA-256",
    );
  const androidRelease =
    system["ro.build.version.release"] ??
    system["ro.system.build.version.release"] ??
    null;
  if (
    product?.device?.androidRelease &&
    androidRelease &&
    androidRelease !== product.device.androidRelease
  )
    problems.push(
      `Android release ${androidRelease} is not ${product.device.androidRelease}`,
    );
  const apks = (apkManifest?.results ?? [])
    .filter((row) => row.mode === "release")
    .map((row) => ({
      file: row.file,
      sha256: row.sha256 ?? null,
      signerSha256: row.signerSha256 ?? null,
      versionCode: row.versionCode ?? null,
      distributable: row.distributable === true,
    }));
  const [signedTf, otaPackage] = await Promise.all([
    fileSha256(signedTargetFiles),
    fileSha256(ota),
  ]);
  return {
    schema: 1,
    kind: RECORD_KIND,
    product: product?.product ?? null,
    device: product?.device?.codename ?? null,
    channel: channel?.channel ?? null,
    createdAt,
    build: {
      fingerprint,
      vendorFingerprint: vendor["ro.vendor.build.fingerprint"] ?? null,
      id: system["ro.build.id"] ?? system["ro.system.build.id"] ?? null,
      incremental:
        system["ro.build.version.incremental"] ??
        system["ro.system.build.version.incremental"] ??
        null,
      androidRelease,
      sdk:
        system["ro.build.version.sdk"] ??
        system["ro.system.build.version.sdk"] ??
        null,
      securityPatch: system["ro.build.version.security_patch"] ?? null,
      vendorSecurityPatch: vendor["ro.vendor.build.security_patch"] ?? null,
      dateUtc:
        system["ro.build.date.utc"] ??
        system["ro.system.build.date.utc"] ??
        null,
    },
    inputs,
    artifacts: {
      signedTargetFiles: {
        file: path.basename(signedTargetFiles),
        sha256: signedTf,
        sizeBytes: fs.statSync(signedTargetFiles).size,
      },
      ota: {
        file: path.basename(ota),
        sha256: otaPackage,
        sizeBytes: fs.statSync(ota).size,
        type: incrementalFrom ? "incremental" : "full",
        incrementalFrom,
      },
    },
    verifiedBoot: {
      algorithm: product?.avb?.algorithm ?? null,
      publicKeySha256: avbPublicKeySha256,
      chainedPartitions,
      images,
      rollbackIndexes: rollback.indexes,
    },
    payload: {
      sha256: payload?.sha256 ?? null,
      sizeBytes: payload?.sizeBytes ?? null,
      properties: payloadProperties,
      metadata,
    },
    certificates,
    apks,
    downgradeAllowed: channel?.downgradeAllowed === true,
    drills: channel?.drills ?? null,
    problems,
    imageBooted: false,
    signedUpdateApplied: false,
    releaseQualified: false,
    deviceAcceptanceVerified: false,
  };
}

/** The previous signed target-files an incremental OTA starts from, identified the same way on every path. */
export async function incrementalSource(file) {
  return file
    ? { file: path.basename(file), sha256: await fileSha256(file) }
    : null;
}

export function writeRecord(file, record) {
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, {
    flag: "wx",
  });
}

/**
 * Standalone record generation. `product` defaults to the descriptor a product's
 * wrapper passes; `--product` and `--channel` override it.
 */
export async function main(
  args = process.argv.slice(2),
  { product: defaultProduct = null, root = process.cwd() } = {},
) {
  const values = {};
  const names = [
    "--signed-target-files",
    "--ota",
    "--product",
    "--channel",
    "--apk-manifest",
    "--keys-dir",
    "--out",
    "--incremental-from",
  ];
  for (let i = 0; i < args.length; i += 2) {
    if (
      !names.includes(args[i]) ||
      !args[i + 1] ||
      args[i + 1].startsWith("--") ||
      values[args[i]]
    )
      throw new Error(
        "Use --signed-target-files ZIP --ota ZIP --out NEW_FILE [--product FILE] [--channel FILE] [--apk-manifest FILE] [--keys-dir DIR] [--incremental-from ZIP]",
      );
    values[args[i]] = args[i + 1];
  }
  if (!values["--signed-target-files"] || !values["--ota"] || !values["--out"])
    throw new Error("--signed-target-files, --ota and --out are required");
  const productFile = values["--product"] ?? defaultProduct;
  if (!productFile)
    throw new Error("--product names the release descriptor of the product");
  const product = JSON.parse(
    fs.readFileSync(path.resolve(root, productFile), "utf8"),
  );
  const channel = JSON.parse(
    fs.readFileSync(
      path.resolve(root, values["--channel"] ?? product.ota?.channel),
      "utf8",
    ),
  );
  const apkManifest = values["--apk-manifest"]
    ? JSON.parse(fs.readFileSync(values["--apk-manifest"], "utf8"))
    : null;
  const keysDir = values["--keys-dir"];
  const certificates = keysDir
    ? keyCertificates(keysDir, ["releasekey", "platform"])
    : {};
  const pkmd =
    keysDir &&
    path.join(keysDir, product.avb?.publicKeyMetadata ?? "avb_pkmd.bin");
  const record = await compatibilityRecord({
    signedTargetFiles: values["--signed-target-files"],
    ota: values["--ota"],
    product,
    channel,
    apkManifest,
    certificates,
    avbPublicKeySha256:
      pkmd && fs.existsSync(pkmd) ? sha256(fs.readFileSync(pkmd)) : null,
    incrementalFrom: await incrementalSource(values["--incremental-from"]),
  });
  writeRecord(values["--out"], record);
  console.log(JSON.stringify(record, null, 2));
  if (record.problems.length) process.exitCode = 1;
  return record;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();

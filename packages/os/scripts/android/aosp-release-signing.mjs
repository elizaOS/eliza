/**
 * Release-sign a Pixel 10a product's target-files zip and build its OTA.
 *
 * Runs on the Linux image host, after the production image build, with AOSP
 * releasetools (otatools `bin/`) and a decrypted release key directory supplied at
 * runtime. A brand's wrapper binds its release descriptor (root-relative paths):
 *
 *   signRelease({ root, descriptorFile, sourceLockPath, applicationSignerFile,
 *     targetFiles, targetFilesSha256, keysDir, releasetools, out,
 *     [apksigner], [keyMap], [apkManifest], [incrementalFrom], [dryRun],
 *     [pkcs11Config, avbSigningHelper, payloadSigner, payloadSignerArgs,
 *      payloadSignerSignatureSize] })
 *
 * It follows the key layout in android/signing (key-manifest.json). Before anything
 * runs it reads the unsigned target-files' META/misc_info.txt, apkcerts.txt and
 * apexkeys.txt, and refuses an APK certificate it does not map to a release key, a
 * chained AVB partition without its own key mapping, or a missing APEX key. It then
 * runs `sign_target_files_apks -o -d KEYS` (plus -k for bluetooth, nfc and mapped
 * sources, --extra_apex_payload_key/--extra_apks for every non-presigned APEX, and
 * the `avb` key for vbmeta and each chained partition), verifies with apksigner that
 * every non-presigned APK and APEX in the signed target-files carries a release
 * certificate and every APEX the release payload key, and only then runs
 * `ota_from_target_files -k KEYS/releasekey` and writes release-record.json
 * (aosp-release-record.mjs) and the public avb_pkmd.bin for avb_custom_key enrollment.
 *
 * Keys never come from a repository: the key directory must be outside every Git
 * working tree and private to its owner. Private keys are only passed by path to the
 * releasetools; this job reads public certificates and avb_pkmd.bin to compare them
 * with the reviewed digests in the release descriptor and update channel, and refuses
 * on any UNSET or mismatching value. A dry run prints the plan and every problem and
 * runs nothing.
 *
 * Managed (hardware-backed) signing keeps every private key in a PKCS#11 token: the
 * four managed options are given together and the key directory then holds only
 * certificates and public keys. signapk loads the APK, APEX container and OTA package
 * keys from the token (SunPKCS11, labels `<key-dir>/<name>.pk8`), avbtool signs
 * vbmeta, chained partitions and APEX payloads through `--signing_helper_with_files`,
 * and the OTA payload is signed by `--payload_signer`. PINs and credentials stay with
 * the token's own configuration, never on a command line.
 *
 * A signed output is not an image boot, an applied update, a rollback or recovery
 * drill, or release qualification.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, createPublicKey } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  chainedPartitionsFromMiscInfo,
  compatibilityRecord,
  entries,
  entry,
  fileSha256,
  incrementalSource,
  keyCertificates,
  parseProperties,
  parseQuotedRows,
  writeRecord,
} from "./aosp-release-record.mjs";
import { encodeAvbPublicKey } from "./generate-release-keys.ts";
import {
  AVB_SIGNABLE_PARTITIONS,
  avbDescriptorProblems,
  channelDistributionProblems,
  channelSigningProblems,
  releaseDescriptorProblems,
  safeRelativePath,
} from "./pixel10a-release.mjs";

export { AVB_SIGNABLE_PARTITIONS };
/** x509/pk8 keys sign_target_files_apks maps by default name (android/signing/key-manifest.json). */
export const X509_KEYS = Object.freeze([
  "releasekey",
  "platform",
  "shared",
  "media",
  "networkstack",
  "sdk_sandbox",
  "bluetooth",
  "nfc",
]);
export const RELEASETOOLS = Object.freeze([
  "sign_target_files_apks",
  "ota_from_target_files",
]);
/** AOSP development keys `-d KEYS` remaps to the same-named release key (releasekey for testkey and devkey). */
export const DEFAULT_KEY_MAP = Object.freeze({
  testkey: "releasekey",
  devkey: "releasekey",
  platform: "platform",
  shared: "shared",
  media: "media",
  networkstack: "networkstack",
  sdk_sandbox: "sdk_sandbox",
});
/** Development keys `-d` does not remap; passed explicitly with -k. */
export const EXPLICIT_KEYS = Object.freeze(["bluetooth", "nfc"]);
const DEV_KEY_DIRS = Object.freeze([
  "build/make/target/product/security",
  "build/target/product/security",
]);
/** One APEX container key pair and one APEX payload key (android/signing/key-manifest.json). */
export const APEX_KEYS = Object.freeze({
  container: "apex",
  payload: "apex_payload",
});
const KEY_NAME = /^[a-z][a-z0-9_]*$/;
const PRESIGNED = new Set(["PRESIGNED", "EXTERNAL"]);
const HEX64 = /^[0-9a-f]{64}$/;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** signapk loads private keys from this JCA provider and keystore type for managed signing. */
export const PKCS11 = Object.freeze({
  providerClass: "sun.security.pkcs11.SunPKCS11",
  keyStore: "PKCS11",
});
/**
 * JVM arguments for signapk under managed signing: the releasetools default heap,
 * plus the module export without which a JDK 9+ signapk cannot instantiate
 * SunPKCS11 from -providerClass.
 */
export const PKCS11_JAVA_ARGS = Object.freeze([
  "-Xmx4096m",
  "--add-exports=jdk.crypto.cryptoki/sun.security.pkcs11=ALL-UNNAMED",
]);
const MANAGED_OPTIONS = Object.freeze({
  pkcs11Config: "--pkcs11-config",
  avbSigningHelper: "--avb-signing-helper",
  payloadSigner: "--payload-signer",
  payloadSignerSignatureSize: "--payload-signer-signature-size",
});
/** Values the releasetools split with shlex: plain words only, so nothing is re-split or quoted. */
const SHLEX_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;
const PUBLIC_PEM = "-----BEGIN PUBLIC KEY-----";

/** Refuse unless git positively says the directory is outside any repository; a missing or failing git is not proof. */
export function gitWorkTreeProblem(dir, run = spawnSync) {
  const out = run("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (out.error || out.status === null)
    return "--keys-dir could not be confirmed to be outside a Git working tree (git did not run)";
  if (out.status === 0)
    return "--keys-dir is inside a Git working tree; release keys never enter a working tree";
  if (!/not a git repository/i.test(String(out.stderr ?? "")))
    return "--keys-dir could not be confirmed to be outside a Git working tree";
  return null;
}

/** True when `child` is `parent` or inside it (a sibling named `..keys` is not). */
export function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return !(
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  );
}

/** True when any managed-signing option is given; the job then needs all of them. */
export function isManaged(options = {}) {
  return (
    Object.keys(MANAGED_OPTIONS).some((name) => options[name] !== undefined) ||
    (options.payloadSignerArgs ?? []).length > 0
  );
}

/** Managed-signing option problems: all given together, absolute shlex-safe paths, executables and a signature size. */
export function managedSigningProblems(options = {}) {
  if (!isManaged(options)) return [];
  const problems = [];
  const missing = Object.entries(MANAGED_OPTIONS)
    .filter(([name]) => options[name] === undefined)
    .map(([, flag]) => flag);
  if (missing.length)
    problems.push(
      `managed signing needs ${Object.values(MANAGED_OPTIONS).join(", ")} together; missing ${missing.join(", ")} (private key files and token keys are never mixed)`,
    );
  for (const [name, executable] of [
    ["pkcs11Config", false],
    ["avbSigningHelper", true],
    ["payloadSigner", true],
  ]) {
    const value = options[name],
      flag = MANAGED_OPTIONS[name];
    if (value === undefined) continue;
    if (!path.isAbsolute(value)) {
      problems.push(`${flag} must be an absolute path`);
      continue;
    }
    if (!SHLEX_WORD.test(value)) {
      problems.push(
        `${flag} must be a path without spaces, quotes or shell characters`,
      );
      continue;
    }
    let stat = null;
    try {
      stat = fs.statSync(value);
    } catch {
      stat = null;
    }
    if (!stat?.isFile()) {
      problems.push(`${flag} ${value} is not a regular file`);
      continue;
    }
    if (executable)
      try {
        fs.accessSync(value, fs.constants.X_OK);
      } catch {
        problems.push(`${flag} ${value} is not executable`);
      }
  }
  if (
    options.payloadSignerSignatureSize !== undefined &&
    !/^[1-9][0-9]*$/.test(String(options.payloadSignerSignatureSize))
  )
    problems.push(
      `${MANAGED_OPTIONS.payloadSignerSignatureSize} must be the signer's maximum signature size in bytes (512 for RSA-4096)`,
    );
  for (const arg of options.payloadSignerArgs ?? [])
    if (!SHLEX_WORD.test(arg))
      problems.push(
        `--payload-signer-arg ${JSON.stringify(arg)} must be a plain word without spaces, quotes or shell characters`,
      );
  return problems;
}

/** The PKCS#11 labels signapk looks up for each release key name (the private-key path it would otherwise read). */
export function tokenKeyLabels(keysDir, names) {
  return Object.fromEntries(
    names.map((name) => [name, path.join(keysDir, `${name}.pk8`)]),
  );
}

/** First bytes of a key file, enough to tell a public PEM from anything else without reading a private key. */
function keyFileHead(file) {
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(PUBLIC_PEM.length);
    return head
      .subarray(0, fs.readSync(fd, head, 0, head.length, 0))
      .toString("latin1");
  } finally {
    fs.closeSync(fd);
  }
}

/** The AVB public key metadata a public RSA key file encodes to (never opens a private key). */
export function avbPublicKeyFileMetadata(file) {
  if (keyFileHead(file) !== PUBLIC_PEM)
    throw new Error(`${file} is not a public key`);
  return encodeAvbPublicKey(createPublicKey(fs.readFileSync(file)));
}

/** The source key (path without .x509.pem) an apkcerts/apexkeys row names, or null when presigned. */
function sourceKey(certificate) {
  if (!certificate || PRESIGNED.has(certificate)) return null;
  return certificate.replace(/\.x509\.pem$/, "");
}

/** Release key name for a development key source, from the default -d map, the explicit -k keys and mapped keys. */
export function releaseKeyFor(source, keyMap = {}) {
  if (Object.hasOwn(keyMap, source)) return keyMap[source];
  const dir = path.posix.dirname(source),
    base = path.posix.basename(source);
  if (DEV_KEY_DIRS.includes(dir) && Object.hasOwn(DEFAULT_KEY_MAP, base))
    return DEFAULT_KEY_MAP[base];
  if (DEV_KEY_DIRS.includes(dir) && EXPLICIT_KEYS.includes(base)) return base;
  return null;
}

/** Signing-relevant metadata of a target-files zip (read with unzip; no image bytes). */
export function inspectTargetFiles(zip) {
  const names = new Set(entries(zip));
  const read = (name) =>
    names.has(name) ? entry(zip, name).toString("utf8") : null;
  const misc = read("META/misc_info.txt");
  const miscInfo = misc === null ? null : parseProperties(misc);
  const apkcerts = parseQuotedRows(read("META/apkcerts.txt") ?? "");
  const apexkeys = parseQuotedRows(read("META/apexkeys.txt") ?? "");
  // apkcerts.txt lists every APK the build knows (test and CTS packages included); only packaged ones are signed.
  const packages = new Set(
    [...names]
      .filter((name) => /\.(apk|apex|capex)$/.test(name))
      .map((name) => path.posix.basename(name)),
  );
  return {
    miscInfo,
    apkcerts,
    apexkeys,
    packages,
    hasApkcerts: names.has("META/apkcerts.txt"),
    chainedPartitions: miscInfo ? chainedPartitionsFromMiscInfo(miscInfo) : [],
  };
}

/** APEXes the job re-signs (neither payload nor container presigned). */
function signedApexes(apexkeys) {
  return apexkeys.filter(
    (row) =>
      row.name &&
      !PRESIGNED.has(row.private_key) &&
      !PRESIGNED.has(row.container_private_key),
  );
}

/** Every key file the job passes to the releasetools, for these target-files. */
export function requiredKeyFiles({
  product,
  keyMap = {},
  inspection = null,
  managed = false,
}) {
  const names = new Set([
    ...Object.values(DEFAULT_KEY_MAP),
    ...EXPLICIT_KEYS,
    "releasekey",
    ...Object.values(keyMap),
  ]);
  // Managed signing keeps the private halves in the token: only certificates and public keys are files.
  const pair = (name) =>
    managed ? [`${name}.x509.pem`] : [`${name}.pk8`, `${name}.x509.pem`];
  const files = [...names].flatMap(pair);
  files.push(
    product?.avb?.vbmetaKey ?? "avb.pem",
    product?.avb?.publicKeyMetadata ?? "avb_pkmd.bin",
  );
  if (inspection && signedApexes(inspection.apexkeys).length)
    files.push(
      ...pair(APEX_KEYS.container),
      `${APEX_KEYS.payload}.pem`,
      `${APEX_KEYS.payload}.avbpubkey`,
    );
  return [...new Set(files)];
}

/** Pre-sign target-files problems: AVB chaining against the product's key mapping, and unmapped APK or APEX keys. */
export function targetFilesProblems(
  inspection,
  { product, keyMap = {}, descriptorFile = "release descriptor" },
) {
  const problems = [];
  if (!inspection.miscInfo)
    return [
      "--target-files has no META/misc_info.txt; its AVB chaining cannot be checked",
    ];
  if (inspection.miscInfo.avb_enable !== "true")
    problems.push(
      "--target-files was built without AVB (avb_enable is not true)",
    );
  const mapped = new Set(product?.avb?.chainedPartitions ?? []);
  for (const partition of inspection.chainedPartitions)
    if (!mapped.has(partition))
      problems.push(
        `chained AVB partition ${partition} has no mapped --avb_${partition}_key (add it to avb.chainedPartitions in ${descriptorFile})`,
      );
  for (const partition of mapped)
    if (!inspection.chainedPartitions.includes(partition))
      problems.push(
        `${descriptorFile} maps --avb_${partition}_key, but the target-files does not chain ${partition}`,
      );
  if (!inspection.hasApkcerts)
    problems.push(
      "--target-files has no META/apkcerts.txt; its APK certificates cannot be checked",
    );
  for (const row of inspection.apkcerts) {
    if (inspection.packages && !inspection.packages.has(row.name)) continue;
    if (row.certificate === "EXTERNAL") {
      problems.push(
        `APK ${row.name} is EXTERNAL; externally signed APKs are not supported by this job`,
      );
      continue;
    }
    const source = sourceKey(row.certificate);
    if (source && !releaseKeyFor(source, keyMap))
      problems.push(
        `APK ${row.name} is signed with ${row.certificate}, which no release key mapping covers (use --map-key ${source}=NAME)`,
      );
  }
  for (const row of inspection.apexkeys)
    if (
      PRESIGNED.has(row.private_key) !==
      PRESIGNED.has(row.container_private_key)
    )
      problems.push(
        `APEX ${row.name} is only partly presigned (payload ${row.private_key}, container ${row.container_private_key})`,
      );
  return problems;
}

/** Runtime key directory checks: location, permissions, every required file and public digests. Never opens a private key. */
export function keyDirectoryProblems(
  keysDir,
  {
    product,
    channel,
    root = process.cwd(),
    keyMap = {},
    inspection = null,
    runGit,
    managed = false,
    descriptorFile = "release descriptor",
  } = {},
) {
  if (!keysDir)
    return [
      "--keys-dir is required: the decrypted release key directory, supplied at signing time",
    ];
  if (!path.isAbsolute(keysDir)) return ["--keys-dir must be an absolute path"];
  if (!fs.existsSync(keysDir) || !fs.statSync(keysDir).isDirectory())
    return [`--keys-dir ${keysDir} is not a directory`];
  const problems = [];
  const real = fs.realpathSync(keysDir),
    repo = fs.realpathSync(root);
  if (isWithin(repo, real))
    problems.push(
      "--keys-dir is inside this repository; release keys never enter a working tree",
    );
  const git = gitWorkTreeProblem(real, runGit);
  if (git) problems.push(git);
  if (fs.statSync(real).mode & 0o077)
    problems.push(
      "--keys-dir must not be readable or writable by group or others (mode 0700)",
    );
  const missing = [];
  for (const name of requiredKeyFiles({
    product,
    keyMap,
    inspection,
    managed,
  })) {
    let stat;
    try {
      stat = fs.lstatSync(path.join(real, name));
    } catch {
      missing.push(name);
      continue;
    }
    if (stat.isSymbolicLink())
      problems.push(
        `--keys-dir ${name} is a symbolic link; key files must be regular files in the key directory`,
      );
    else if (!stat.isFile())
      problems.push(`--keys-dir ${name} is not a regular file`);
    else if (stat.mode & 0o077)
      problems.push(
        `--keys-dir ${name} must not be readable or writable by group or others (mode 0600)`,
      );
  }
  if (missing.length)
    problems.push(
      managed
        ? `--keys-dir lacks ${missing.join(", ")} (managed signing needs every release certificate and public key)`
        : `--keys-dir lacks ${missing.join(", ")} (decrypt the release key bundle first; .enc files are not read)`,
    );
  const apexSigned = inspection && signedApexes(inspection.apexkeys).length > 0;
  if (managed) {
    for (const name of fs
      .readdirSync(real)
      .filter((item) => item.endsWith(".pk8")))
      problems.push(
        `--keys-dir holds ${name}; managed signing keeps private keys in the PKCS#11 token, never in the key directory`,
      );
    for (const name of [
      product?.avb?.vbmetaKey ?? "avb.pem",
      ...(apexSigned ? [`${APEX_KEYS.payload}.pem`] : []),
    ]) {
      const file = path.join(real, name);
      if (
        fs.existsSync(file) &&
        fs.lstatSync(file).isFile() &&
        keyFileHead(file) !== PUBLIC_PEM
      )
        problems.push(
          `--keys-dir ${name} must be the public key (${PUBLIC_PEM}) when managed signing holds the private key`,
        );
    }
    // The public key avbtool signs with must be the one the device verifies: avb.pem
    // against avb_pkmd.bin, and apex_payload.pem against apex_payload.avbpubkey.
    const pairs = [
      [
        product?.avb?.vbmetaKey ?? "avb.pem",
        product?.avb?.publicKeyMetadata ?? "avb_pkmd.bin",
      ],
      ...(apexSigned
        ? [[`${APEX_KEYS.payload}.pem`, `${APEX_KEYS.payload}.avbpubkey`]]
        : []),
    ];
    for (const [pem, metadata] of pairs) {
      const [pemFile, metadataFile] = [
        path.join(real, pem),
        path.join(real, metadata),
      ];
      if (
        !fs.existsSync(pemFile) ||
        !fs.existsSync(metadataFile) ||
        keyFileHead(pemFile) !== PUBLIC_PEM
      )
        continue;
      let encoded = null;
      try {
        encoded = avbPublicKeyFileMetadata(pemFile);
      } catch {
        encoded = null;
      }
      if (!encoded)
        problems.push(`--keys-dir ${pem} is not a readable RSA public key`);
      else if (!encoded.equals(fs.readFileSync(metadataFile)))
        problems.push(`--keys-dir ${pem} is not the key in ${metadata}`);
    }
  }
  const certs = keyCertificates(real, ["platform", "releasekey"]);
  if (
    certs.platform &&
    certs.platform !== product?.signer?.platformCertificateSha256
  )
    problems.push(
      `platform.x509.pem is ${certs.platform}, not the product's signer.platformCertificateSha256`,
    );
  if (certs.releasekey && certs.releasekey !== channel?.otaCertificateSha256)
    problems.push(
      `releasekey.x509.pem is ${certs.releasekey}, not the channel's otaCertificateSha256`,
    );
  // Every other certificate the job signs with is pinned too, so no public AOSP test key
  // (shared, media, networkstack, ...) can be signed into the image under a release name.
  const pinned = product?.signer?.releaseCertificates ?? {};
  const others = [
    ...new Set([
      ...Object.values(DEFAULT_KEY_MAP),
      ...EXPLICIT_KEYS,
      ...Object.values(keyMap),
      ...(apexSigned ? [APEX_KEYS.container] : []),
    ]),
  ].filter((name) => !["platform", "releasekey"].includes(name));
  const other = keyCertificates(real, others);
  for (const name of others) {
    if (!HEX64.test(pinned[name] ?? ""))
      problems.push(
        `${descriptorFile} signer.releaseCertificates.${name} must be the reviewed certificate SHA-256`,
      );
    else if (other[name] && other[name] !== pinned[name])
      problems.push(
        `${name}.x509.pem is ${other[name]}, not the product's signer.releaseCertificates.${name}`,
      );
  }
  const pkmd = path.join(
    real,
    product?.avb?.publicKeyMetadata ?? "avb_pkmd.bin",
  );
  if (
    fs.existsSync(pkmd) &&
    !fs.lstatSync(pkmd).isSymbolicLink() &&
    sha256(fs.readFileSync(pkmd)) !== product?.avb?.publicKeySha256
  )
    problems.push(
      `${path.basename(pkmd)} is not the product's avb.publicKeySha256`,
    );
  return problems;
}

/**
 * The exact releasetools invocations. `keysDir` must already be the key directory's
 * realpath. Key paths are arguments only; their contents are never read here.
 */
export function signingCommands({
  targetFiles,
  keysDir,
  releasetools,
  out,
  product,
  incrementalFrom = null,
  keyMap = {},
  inspection = { apexkeys: [] },
  managed = null,
}) {
  const keys = keysDir,
    tools = path.resolve(releasetools);
  const algorithm = product.avb.algorithm,
    avbKey = path.join(keys, product.avb.vbmetaKey);
  const signed = path.join(out, "signed-target_files.zip"),
    ota = path.join(out, incrementalFrom ? "incremental-ota.zip" : "ota.zip");
  const explicit = [
    ...EXPLICIT_KEYS.map((name) => [`${DEV_KEY_DIRS[0]}/${name}`, name]),
    ...Object.entries(keyMap),
  ].flatMap(([source, name]) => ["-k", `${source}=${path.join(keys, name)}`]);
  const apex = signedApexes(inspection.apexkeys).flatMap((row) => [
    "--extra_apex_payload_key",
    `${row.name}=${path.join(keys, `${APEX_KEYS.payload}.pem`)}`,
    "--extra_apks",
    `${row.name}=${path.join(keys, APEX_KEYS.container)}`,
  ]);
  // Managed signing: avbtool calls the helper for every AVB signature, signapk takes its keys from the token.
  const helper = (partition) =>
    managed
      ? [
          `--avb_${partition}_extra_args`,
          `--signing_helper_with_files ${managed.avbSigningHelper}`,
        ]
      : [];
  const avb = [
    "--avb_vbmeta_key",
    avbKey,
    "--avb_vbmeta_algorithm",
    algorithm,
    ...helper("vbmeta"),
    ...product.avb.chainedPartitions.flatMap((partition) => [
      `--avb_${partition}_key`,
      avbKey,
      `--avb_${partition}_algorithm`,
      algorithm,
      ...helper(partition),
    ]),
  ];
  const token = managed
    ? [
        "--java_args",
        PKCS11_JAVA_ARGS.join(" "),
        "--extra_signapk_args",
        `-providerClass ${PKCS11.providerClass} -providerArg ${managed.pkcs11Config} -loadPrivateKeysFromKeyStore ${PKCS11.keyStore}`,
      ]
    : [];
  const apexHelper = managed && apex.length ? helper("apex") : [];
  const payload = managed
    ? [
        "--payload_signer",
        managed.payloadSigner,
        ...((managed.payloadSignerArgs ?? []).length
          ? ["--payload_signer_args", managed.payloadSignerArgs.join(" ")]
          : []),
        "--payload_signer_maximum_signature_size",
        String(managed.payloadSignerSignatureSize),
      ]
    : [];
  return {
    signed,
    ota,
    commands: [
      // --package_key and the payload signer also re-sign any embedded boot OTA
      // (boot_otas/*.zip); without them sign_target_files_apks would use the build's
      // development certificate.
      {
        tool: path.join(tools, "sign_target_files_apks"),
        args: [
          "-p",
          path.dirname(tools),
          ...token,
          "-o",
          "-d",
          keys,
          ...explicit,
          ...apex,
          ...apexHelper,
          ...avb,
          "--package_key",
          path.join(keys, "releasekey"),
          ...payload,
          path.resolve(targetFiles),
          signed,
        ],
      },
      {
        tool: path.join(tools, "ota_from_target_files"),
        args: [
          "-p",
          path.dirname(tools),
          ...token,
          "-k",
          path.join(keys, "releasekey"),
          ...payload,
          ...(incrementalFrom ? ["-i", path.resolve(incrementalFrom)] : []),
          signed,
          ota,
        ],
      },
    ],
  };
}

/** Certificate SHA-256 digests apksigner reports for one APK or APEX. */
function signerDigests(apksigner, file) {
  const out = spawnSync(apksigner, ["verify", "--print-certs", file], {
    encoding: "utf8",
    maxBuffer: 16 << 20,
  });
  if (out.status !== 0) return null;
  return [
    ...out.stdout.matchAll(
      /Signer #\d+ certificate SHA-256 digest:\s*([0-9a-fA-F]{64})/g,
    ),
  ].map((match) => match[1].toLowerCase());
}

/**
 * After sign_target_files_apks and before any OTA: every APK and APEX in the signed
 * target-files that is not presigned must be signed only by a release certificate
 * from the key directory, and every re-signed APEX must carry the release payload
 * public key. A remaining test or development certificate (or any unknown one) is
 * refused.
 */
export function signedTargetFilesProblems({
  signed,
  keysDir,
  apksigner,
  keyMap = {},
}) {
  const problems = [];
  const releaseNames = [
    ...new Set([
      ...Object.values(DEFAULT_KEY_MAP),
      ...EXPLICIT_KEYS,
      "releasekey",
      ...Object.values(keyMap),
      APEX_KEYS.container,
    ]),
  ];
  const release = new Set(
    Object.values(keyCertificates(keysDir, releaseNames)).filter((value) =>
      HEX64.test(value ?? ""),
    ),
  );
  const inspection = inspectTargetFiles(signed);
  const presigned = new Set([
    ...inspection.apkcerts
      .filter((row) => !sourceKey(row.certificate))
      .map((row) => row.name),
    ...inspection.apexkeys
      .filter((row) => PRESIGNED.has(row.private_key))
      .map((row) => row.name),
  ]);
  const listed = new Set(
    [...inspection.apkcerts, ...inspection.apexkeys].map((row) => row.name),
  );
  for (const row of inspection.apkcerts) {
    const source = sourceKey(row.certificate);
    if (source && !isWithin(keysDir, path.resolve(path.dirname(source))))
      problems.push(
        `signed apkcerts.txt still names ${row.certificate} for ${row.name}`,
      );
  }
  const payloadFile = path.join(keysDir, `${APEX_KEYS.payload}.avbpubkey`);
  const payload = fs.existsSync(payloadFile)
    ? fs.readFileSync(payloadFile)
    : null;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "aosp-signed-check-"));
  try {
    for (const name of entries(signed).filter((item) =>
      /\.(apk|apex)$/.test(item),
    )) {
      const base = path.posix.basename(name);
      if (presigned.has(base)) continue;
      if (!listed.has(base)) {
        problems.push(`${name} is in neither apkcerts.txt nor apexkeys.txt`);
        continue;
      }
      const file = path.join(work, "package");
      fs.writeFileSync(file, entry(signed, name));
      const digests = signerDigests(apksigner, file);
      if (!digests?.length)
        problems.push(`${name}: apksigner could not verify its signature`);
      else
        for (const digest of digests)
          if (!release.has(digest))
            problems.push(
              `${name} is signed with ${digest}, which is not a release certificate (test or development key remains)`,
            );
      if (base.endsWith(".apex")) {
        let key = null;
        try {
          key = execFileSync("unzip", ["-p", file, "apex_pubkey"], {
            maxBuffer: 1 << 20,
            stdio: ["ignore", "pipe", "ignore"],
          });
        } catch {
          key = null;
        }
        if (!key || !payload || !key.equals(payload))
          problems.push(`${name} does not carry the release APEX payload key`);
      }
      fs.rmSync(file);
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  return problems;
}

function apksignerPath(options) {
  if (options.apksigner) return options.apksigner;
  return options.releasetools
    ? path.join(options.releasetools, "apksigner")
    : null;
}

/** The release descriptor, its update channel and the pinned source lock, read from the product's root. */
export function readReleaseInputs({ root, descriptorFile }) {
  const read = (rel) =>
    JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
  const product = read(descriptorFile);
  let channel = null,
    sourceLock = null;
  try {
    channel = safeRelativePath(product.ota?.channel)
      ? read(product.ota.channel)
      : null;
  } catch {
    channel = null;
  }
  try {
    sourceLock = safeRelativePath(product.sourceLock?.file)
      ? read(product.sourceLock.file)
      : null;
  } catch {
    sourceLock = null;
  }
  return { product, channel, sourceLock };
}

/** Every reason the signing job would refuse, without running anything. */
export async function signingProblems({
  root = process.cwd(),
  descriptorFile,
  sourceLockPath,
  applicationSignerFile = null,
  targetFiles,
  targetFilesSha256,
  keysDir,
  releasetools,
  apksigner,
  out,
  incrementalFrom,
  product,
  channel,
  sourceLock = null,
  keyMap = {},
  runGit,
  ...managedOptions
}) {
  const problems = [
    ...releaseDescriptorProblems(product, {
      root,
      file: descriptorFile,
      sourceLockPath,
      applicationSignerFile,
    }),
    ...avbDescriptorProblems(product, descriptorFile),
  ];
  problems.push(
    ...channelSigningProblems(
      channel,
      product,
      product?.ota?.channel,
      sourceLock,
    ),
  );
  for (const [source, name] of Object.entries(keyMap))
    if (!KEY_NAME.test(name) || !source || source.includes("="))
      problems.push(
        `--map-key ${source}=${name} must map a source key path to a key name`,
      );
  let inspection = null;
  if (
    !targetFiles ||
    !fs.existsSync(targetFiles) ||
    !fs.statSync(targetFiles).isFile()
  )
    problems.push("--target-files must name the unsigned target-files zip");
  else {
    if (!HEX64.test(targetFilesSha256 ?? ""))
      problems.push(
        "--target-files-sha256 must be the SHA-256 from the image build record",
      );
    else if ((await fileSha256(targetFiles)) !== targetFilesSha256)
      problems.push("--target-files differs from --target-files-sha256");
    try {
      inspection = inspectTargetFiles(targetFiles);
    } catch (error) {
      problems.push(`--target-files could not be read: ${error.message}`);
    }
    if (inspection)
      problems.push(
        ...targetFilesProblems(inspection, { product, keyMap, descriptorFile }),
      );
  }
  if (incrementalFrom && !fs.existsSync(incrementalFrom))
    problems.push(
      "--incremental-from must name the previous signed target-files zip",
    );
  if (!releasetools)
    problems.push("--releasetools is required: the otatools bin directory");
  else
    for (const name of RELEASETOOLS) {
      try {
        fs.accessSync(path.join(releasetools, name), fs.constants.X_OK);
      } catch {
        problems.push(`--releasetools lacks an executable ${name}`);
      }
    }
  const verifier = apksignerPath({ apksigner, releasetools });
  try {
    fs.accessSync(verifier ?? "", fs.constants.X_OK);
  } catch {
    problems.push(
      "an executable apksigner is required to verify the signed target-files (--apksigner, or apksigner in --releasetools)",
    );
  }
  if (!out) problems.push("--out is required: a new output directory");
  else if (fs.existsSync(out)) problems.push(`--out ${out} already exists`);
  problems.push(...managedSigningProblems(managedOptions));
  problems.push(
    ...keyDirectoryProblems(keysDir, {
      product,
      channel,
      root,
      keyMap,
      inspection,
      runGit,
      managed: isManaged(managedOptions),
      descriptorFile,
    }),
  );
  return { problems: [...new Set(problems)], inspection };
}

/**
 * Sign a brand's release. `root`, `descriptorFile`, `sourceLockPath` and
 * `applicationSignerFile` bind the brand's reviewed release inputs; the remaining
 * options are the signing job's runtime inputs.
 */
export async function signRelease(options) {
  const root = options.root ?? process.cwd();
  if (!safeRelativePath(options.descriptorFile))
    throw new Error("signRelease needs the product's release descriptorFile");
  const { product, channel, sourceLock } = readReleaseInputs({
    root,
    descriptorFile: options.descriptorFile,
  });
  const keyMap = options.keyMap ?? {};
  const { problems, inspection } = await signingProblems({
    ...options,
    root,
    product,
    channel,
    sourceLock,
    keyMap,
  });
  const keysDir =
    options.keysDir &&
    path.isAbsolute(options.keysDir) &&
    fs.existsSync(options.keysDir)
      ? fs.realpathSync(options.keysDir)
      : options.keysDir;
  const managed = isManaged(options)
    ? {
        pkcs11Config: options.pkcs11Config,
        avbSigningHelper: options.avbSigningHelper,
        payloadSigner: options.payloadSigner,
        payloadSignerArgs: options.payloadSignerArgs ?? [],
        payloadSignerSignatureSize: options.payloadSignerSignatureSize,
      }
    : null;
  const plan =
    Array.isArray(product.avb?.chainedPartitions) &&
    product.avb?.vbmetaKey &&
    options.targetFiles &&
    keysDir &&
    options.releasetools &&
    options.out
      ? signingCommands({
          ...options,
          keysDir,
          product,
          keyMap,
          inspection: inspection ?? { apexkeys: [] },
          managed,
        })
      : null;
  const signedApexCount = inspection
    ? signedApexes(inspection.apexkeys).length
    : 0;
  const tokenLabels =
    managed && keysDir
      ? tokenKeyLabels(keysDir, [
          ...new Set([
            ...Object.values(DEFAULT_KEY_MAP),
            ...EXPLICIT_KEYS,
            "releasekey",
            ...Object.values(keyMap),
            ...(signedApexCount ? [APEX_KEYS.container] : []),
          ]),
        ])
      : null;
  if (options.dryRun)
    return {
      dryRun: true,
      problems,
      commands: plan?.commands ?? [],
      ran: false,
      signingMode: managed ? "managed" : "key-files",
      tokenLabels,
    };
  if (problems.length)
    throw new Error(
      `Refusing to sign the release:\n${problems.map((item) => `  - ${item}`).join("\n")}`,
    );
  fs.mkdirSync(options.out, { mode: 0o700 });
  const env = {
    ...process.env,
    PATH: `${path.resolve(options.releasetools)}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  const [sign, makeOta] = plan.commands;
  execFileSync(sign.tool, sign.args, { stdio: "inherit", env });
  // No OTA is built from target-files that still carry a test, development or unknown certificate.
  const remaining = signedTargetFilesProblems({
    signed: plan.signed,
    keysDir,
    apksigner: apksignerPath(options),
    keyMap,
  });
  if (remaining.length)
    throw new Error(
      `Refusing the signed target-files; no OTA was built:\n${remaining.map((item) => `  - ${item}`).join("\n")}`,
    );
  execFileSync(makeOta.tool, makeOta.args, { stdio: "inherit", env });
  const pkmd = path.join(keysDir, product.avb.publicKeyMetadata);
  fs.copyFileSync(
    pkmd,
    path.join(options.out, "avb_pkmd.bin"),
    fs.constants.COPYFILE_EXCL,
  );
  const apkManifest = options.apkManifest
    ? JSON.parse(fs.readFileSync(options.apkManifest, "utf8"))
    : null;
  const certificates = keyCertificates(keysDir, [
    ...new Set([
      ...X509_KEYS,
      ...Object.values(keyMap),
      ...(fs.existsSync(path.join(keysDir, `${APEX_KEYS.container}.x509.pem`))
        ? [APEX_KEYS.container]
        : []),
    ]),
  ]);
  const record = await compatibilityRecord({
    signedTargetFiles: plan.signed,
    ota: plan.ota,
    product,
    channel,
    apkManifest,
    certificates,
    avbPublicKeySha256: sha256(fs.readFileSync(pkmd)),
    incrementalFrom: await incrementalSource(options.incrementalFrom),
    inputs: {
      unsignedTargetFilesSha256: options.targetFilesSha256,
      productDescriptorSha256: sha256(
        fs.readFileSync(path.join(root, options.descriptorFile)),
      ),
      sourceLockSha256: product.sourceLock.sha256,
      signingMode: managed ? "managed" : "key-files",
    },
  });
  const recordFile = path.join(options.out, "release-record.json");
  writeRecord(recordFile, record);
  if (record.problems.length)
    throw new Error(
      `Signed outputs are inconsistent; see ${recordFile}:\n${record.problems.map((item) => `  - ${item}`).join("\n")}`,
    );
  return {
    dryRun: false,
    problems: [],
    commands: plan.commands,
    ran: true,
    record: recordFile,
    signingMode: managed ? "managed" : "key-files",
    distributionProblems: channelDistributionProblems(
      channel,
      product.ota.channel,
    ),
  };
}

export const SIGNING_USAGE =
  "Use --target-files ZIP --target-files-sha256 HEX --keys-dir DIR --releasetools DIR --out NEW_DIR [--apksigner FILE] [--map-key SOURCE=NAME ...] [--apk-manifest FILE] [--incremental-from ZIP] [--dry-run] [--pkcs11-config FILE --avb-signing-helper FILE --payload-signer FILE [--payload-signer-arg ARG ...] --payload-signer-signature-size BYTES]";

export function parseSigningArgs(args) {
  const names = {
    "--target-files": "targetFiles",
    "--target-files-sha256": "targetFilesSha256",
    "--keys-dir": "keysDir",
    "--releasetools": "releasetools",
    "--apksigner": "apksigner",
    "--out": "out",
    "--apk-manifest": "apkManifest",
    "--incremental-from": "incrementalFrom",
    ...Object.fromEntries(
      Object.entries(MANAGED_OPTIONS).map(([name, flag]) => [flag, name]),
    ),
  };
  const options = { dryRun: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (args[i] === "--map-key") {
      const value = args[i + 1] ?? "",
        at = value.indexOf("=");
      if (at <= 0 || value.startsWith("--")) throw new Error(SIGNING_USAGE);
      options.keyMap = {
        ...(options.keyMap ?? {}),
        [value.slice(0, at)]: value.slice(at + 1),
      };
      i++;
      continue;
    }
    // A signer argument may itself start with "-" or "--"; it is always the next word.
    if (args[i] === "--payload-signer-arg") {
      if (i + 1 >= args.length) throw new Error(SIGNING_USAGE);
      options.payloadSignerArgs = [
        ...(options.payloadSignerArgs ?? []),
        args[++i],
      ];
      continue;
    }
    const key = names[args[i]];
    if (
      !key ||
      !args[i + 1] ||
      args[i + 1].startsWith("--") ||
      options[key] !== undefined
    )
      throw new Error(SIGNING_USAGE);
    options[key] = args[++i];
  }
  return options;
}

/** CLI for a brand wrapper: `release` binds the brand's root and release descriptor. */
export async function signingMain(args, release) {
  const result = await signRelease({ ...parseSigningArgs(args), ...release });
  if (result.dryRun) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          ran: false,
          signingMode: result.signingMode,
          ...(result.tokenLabels ? { tokenLabels: result.tokenLabels } : {}),
          commands: result.commands.map(({ tool, args }) => [tool, ...args]),
          problems: result.problems,
        },
        null,
        2,
      ),
    );
    if (result.problems.length)
      console.warn(
        `Signing would be refused (${result.problems.length} problem${result.problems.length === 1 ? "" : "s"}).`,
      );
    return result;
  }
  console.log(
    `Signed release written to ${path.dirname(result.record)}. Compatibility record: ${result.record}.`,
  );
  for (const problem of result.distributionProblems)
    console.warn(`NOT DISTRIBUTABLE ${problem}`);
  console.log(
    "This is a signed build output, not an image boot, an applied update, a rollback or recovery drill, or release qualification.",
  );
  return result;
}

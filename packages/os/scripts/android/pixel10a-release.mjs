/**
 * Release inputs for a Pixel 10a (stallion) Android 17 product composed from
 * android/products/pixel10a-<brand>.json.
 *
 * Every brand keeps its own release descriptor, update channel and qualification
 * record: they carry its signing identity (certificate and AVB key digests), its one
 * update channel and its own evidence. This module validates those records for any
 * brand; it never reads key material and never records qualification. Paths inside
 * a descriptor are relative to the brand's repository root, which the caller passes.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validatePixel10aProduct } from "./pixel10a-product.ts";

export const PIXEL10A_DEVICE = Object.freeze({
  codename: "stallion",
  androidRelease: "17",
});
/** The shared stallion source inventory every Pixel 10a product pins. */
export const SHARED_SOURCE_LOCK = fileURLToPath(
  new URL("../../android/sources/pixel10a-stallion.json", import.meta.url),
);
const productsDirectory = fileURLToPath(
  new URL("../../android/products/", import.meta.url),
);
/** The distinct distribution gates; one gate's evidence never satisfies another. */
export const GATE_NAMES = Object.freeze([
  "sourceAdmission",
  "apkVariants",
  "cuttlefishBoot",
  "physicalDevice",
  "signedUpdateRecovery",
  "userAcceptance",
]);
/** Drills a channel must record as passed before a signed release is distributed. */
export const CHANNEL_DRILLS = Object.freeze([
  "signedUpdate",
  "interruptedUpdate",
  "compatibleRollback",
  "stockRecovery",
]);
/**
 * Chained partitions AOSP 17 sign_target_files_apks accepts --avb_<partition>_key,
 * _algorithm and _extra_args for (vbmeta is always signed).
 */
export const AVB_SIGNABLE_PARTITIONS = Object.freeze([
  "boot",
  "dtbo",
  "init_boot",
  "recovery",
  "system",
  "system_other",
  "vbmeta_system",
  "vbmeta_vendor",
  "vendor",
]);
export const AVB_ALGORITHMS = Object.freeze([
  "SHA256_RSA4096",
  "SHA512_RSA4096",
  "SHA256_RSA8192",
  "SHA512_RSA8192",
]);
const GATE_STATUSES = ["not run", "development", "failed", "passed"];
const EVIDENCE_LEVELS = ["development", "release"];
export const HEX64 = /^[0-9a-f]{64}$/;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** JSON paths whose string value is unset or a placeholder (descriptions excluded). */
export function placeholderFields(value, at = "") {
  if (typeof value === "string")
    return /^(unset|todo|tbd)$/i.test(value.trim()) ||
      /placeholder/i.test(value)
      ? [at || "(value)"]
      : [];
  if (Array.isArray(value))
    return value.flatMap((item, index) =>
      placeholderFields(item, `${at}[${index}]`),
    );
  if (value && typeof value === "object")
    return Object.entries(value)
      .filter(([key]) => key !== "description")
      .flatMap(([key, item]) =>
        placeholderFields(item, at ? `${at}.${key}` : key),
      );
  return [];
}

/** A repository-relative path that cannot leave the root. */
export function safeRelativePath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !path.isAbsolute(value) &&
    !value.includes("\0") &&
    !value.split(/[\\/]/).some((part) => !part || part === "." || part === "..")
  );
}

/** The shared Pixel 10a composition with this product name, or null. */
export function pixel10aComposition(productName) {
  if (typeof productName !== "string") return null;
  for (const name of fs.readdirSync(productsDirectory).sort()) {
    if (!/^pixel10a-[a-z0-9-]+\.json$/.test(name)) continue;
    const product = JSON.parse(
      fs.readFileSync(path.join(productsDirectory, name), "utf8"),
    );
    if (product.productName === productName)
      return validatePixel10aProduct(product);
  }
  return null;
}

function readJson(root, rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
}

/**
 * Problems that keep a brand's Pixel 10a product from production staging and
 * signing: the release descriptor, its pinned source lock and its application and
 * image platform signers. `sourceLockPath` is the root-relative path of the shared
 * source inventory (the descriptor must pin exactly that file). With
 * `applicationSignerFile`, the descriptor names that file and its `signerSha256` is
 * the application release certificate; otherwise the descriptor carries
 * `signer.applicationCertificateSha256` itself. `productName`, when given, is the
 * brand's own composition: a descriptor naming another brand's product is refused.
 * An empty list admits staging inputs only; it is never an image build, signed
 * image, boot or qualification.
 */
export function releaseDescriptorProblems(
  descriptor,
  {
    root,
    file = "release descriptor",
    sourceLockPath,
    applicationSignerFile = null,
    productName = null,
  },
) {
  if (!descriptor || typeof descriptor !== "object")
    return [`${file} is missing or unreadable`];
  const problems = [];
  if (descriptor.schema !== 1) problems.push(`${file}: schema must be 1`);
  if (productName !== null && descriptor.product !== productName)
    problems.push(
      `${file}: product must be ${productName}, this brand's Pixel 10a composition`,
    );
  for (const field of placeholderFields(descriptor))
    problems.push(`${file}: ${field} is unset or a placeholder`);
  let composition = null;
  try {
    composition = pixel10aComposition(descriptor.product);
  } catch (error) {
    problems.push(
      `${file}: the shared composition is invalid: ${error.message}`,
    );
  }
  if (!composition)
    problems.push(
      `${file}: product ${JSON.stringify(descriptor.product)} is not a shared Pixel 10a composition (android/products/pixel10a-*.json)`,
    );
  if (descriptor.target !== "pixel10a")
    problems.push(`${file}: target must be pixel10a`);
  if (
    descriptor.device?.codename !== PIXEL10A_DEVICE.codename ||
    descriptor.device?.androidRelease !== PIXEL10A_DEVICE.androidRelease
  )
    problems.push(`${file}: device must be stallion on Android 17`);
  if (composition) {
    const lunch = `${composition.productName}-${composition.releaseConfig}`;
    if (descriptor.lunch?.production !== `${lunch}-user`)
      problems.push(
        `${file}: lunch.production must be the user build ${lunch}-user`,
      );
    if (descriptor.lunch?.development !== `${lunch}-userdebug`)
      problems.push(
        `${file}: lunch.development must be the userdebug build ${lunch}-userdebug`,
      );
  }
  // Software never records release qualification or device acceptance.
  if (descriptor.releaseQualified !== false)
    problems.push(
      `${file}: releaseQualified must stay false; it is release evidence, not a staging input`,
    );
  if (descriptor.deviceAcceptanceVerified !== false)
    problems.push(
      `${file}: deviceAcceptanceVerified must stay false; it is device evidence, not a staging input`,
    );
  // The pinned source lock: exact bytes, the stallion Android 17 contract, admitted for release.
  const lockFile = descriptor.sourceLock?.file;
  if (
    lockFile !== sourceLockPath ||
    !safeRelativePath(lockFile) ||
    !fs.existsSync(path.join(root, lockFile))
  )
    problems.push(`${file}: sourceLock.file must be ${sourceLockPath}`);
  else {
    const bytes = fs.readFileSync(path.join(root, lockFile));
    if (!HEX64.test(descriptor.sourceLock.sha256 ?? ""))
      problems.push(
        `${file}: sourceLock.sha256 must pin the reviewed source lock`,
      );
    else if (sha256(bytes) !== descriptor.sourceLock.sha256)
      problems.push(`${lockFile} differs from the pinned sourceLock.sha256`);
    let lock = null;
    try {
      lock = JSON.parse(bytes);
    } catch {
      problems.push(`${lockFile} is unreadable`);
    }
    if (lock) {
      if (
        lock.target !== "pixel10a" ||
        lock.device?.codename !== PIXEL10A_DEVICE.codename ||
        lock.device?.androidRelease !== PIXEL10A_DEVICE.androidRelease
      )
        problems.push(
          `${lockFile} is not the Pixel 10a Android 17 source contract`,
        );
      if (lock.developmentOnly !== false)
        problems.push(
          `${lockFile} is still marked developmentOnly; admit its inputs for release in a reviewed change`,
        );
      if (lock.releaseQualified !== false)
        problems.push(`${lockFile}: releaseQualified must stay false`);
    }
  }
  // The reviewed signers: the application release certificate and the image platform certificate.
  if (applicationSignerFile) {
    if (descriptor.signer?.apkDescriptor !== applicationSignerFile)
      problems.push(
        `${file}: signer.apkDescriptor must be ${applicationSignerFile}`,
      );
    else {
      let signer;
      try {
        signer = readJson(root, applicationSignerFile).signerSha256;
      } catch {
        signer = undefined;
      }
      if (!HEX64.test(signer ?? ""))
        problems.push(
          `${applicationSignerFile} signerSha256 is ${JSON.stringify(signer)}, not a reviewed release certificate`,
        );
    }
  } else if (!HEX64.test(descriptor.signer?.applicationCertificateSha256 ?? ""))
    problems.push(
      `${file}: signer.applicationCertificateSha256 must be the reviewed application release certificate`,
    );
  if (!HEX64.test(descriptor.signer?.platformCertificateSha256 ?? ""))
    problems.push(
      `${file}: signer.platformCertificateSha256 must be a SHA-256`,
    );
  if (!safeRelativePath(descriptor.ota?.channel))
    problems.push(
      `${file}: ota.channel must name the update channel record relative to the repository`,
    );
  return [...new Set(problems)];
}

/** AVB inputs the signing job needs from a release descriptor. */
export function avbDescriptorProblems(descriptor, file = "release descriptor") {
  const problems = [];
  const avb = descriptor?.avb;
  if (!HEX64.test(avb?.publicKeySha256 ?? ""))
    problems.push(`${file}: avb.publicKeySha256 must be a SHA-256`);
  if (!AVB_ALGORITHMS.includes(avb?.algorithm))
    problems.push(
      `${file}: avb.algorithm must be an RSA-4096/8192 AVB algorithm`,
    );
  for (const name of ["vbmetaKey", "publicKeyMetadata"])
    if (!/^[A-Za-z0-9_.-]+$/.test(avb?.[name] ?? "") || avb[name] === "..")
      problems.push(
        `${file}: avb.${name} must be a file name in the key directory`,
      );
  if (!Array.isArray(avb?.chainedPartitions))
    problems.push(
      `${file}: avb.chainedPartitions must list the chained vbmeta partitions`,
    );
  else
    for (const partition of avb.chainedPartitions)
      if (!AVB_SIGNABLE_PARTITIONS.includes(partition))
        problems.push(
          `${file}: chained partition ${partition} has no --avb_${partition}_key in sign_target_files_apks (supported: ${AVB_SIGNABLE_PARTITIONS.join(", ")})`,
        );
  return problems;
}

/**
 * Channel fields that must be reviewed before signing. A first release has no
 * known-good predecessor, and drills follow signing. With `sourceLock`, the stock
 * recovery archive must be the locked factory archive.
 */
export function channelSigningProblems(
  channel,
  descriptor,
  file = "update channel",
  sourceLock = null,
) {
  if (!channel || typeof channel !== "object")
    return [`${file} is missing or unreadable`];
  const problems = [];
  const { recovery, drills, ...signing } = channel;
  const { knownGoodRelease, ...stock } = recovery ?? {};
  for (const field of [
    ...placeholderFields(signing),
    ...placeholderFields(stock).map((name) => `recovery.${name}`),
  ])
    problems.push(`${file}: ${field} is unset or a placeholder`);
  if (channel.schema !== 1) problems.push(`${file}: schema must be 1`);
  if (
    channel.product !== descriptor?.product ||
    channel.device !== descriptor?.device?.codename
  )
    problems.push(
      `${file}: channel is not for ${descriptor?.product ?? "the product"} on ${descriptor?.device?.codename ?? "its device"}`,
    );
  if (!/^[a-z][a-z0-9-]*$/.test(channel.channel ?? ""))
    problems.push(`${file}: channel must name the update channel`);
  if (!HEX64.test(channel.otaCertificateSha256 ?? ""))
    problems.push(`${file}: otaCertificateSha256 must be a SHA-256`);
  if (!HEX64.test(channel.avbPublicKeySha256 ?? ""))
    problems.push(`${file}: avbPublicKeySha256 must be a SHA-256`);
  else if (channel.avbPublicKeySha256 !== descriptor?.avb?.publicKeySha256)
    problems.push(
      `${file}: avbPublicKeySha256 is not the product's avb.publicKeySha256`,
    );
  if (channel.downgradeAllowed !== false)
    problems.push(`${file}: downgradeAllowed must be false`);
  if (!HEX64.test(recovery?.stockFactoryImage?.sha256 ?? ""))
    problems.push(
      `${file}: recovery.stockFactoryImage.sha256 must be a SHA-256`,
    );
  else if (
    sourceLock?.factory &&
    (recovery.stockFactoryImage.sha256 !== sourceLock.factory.sha256 ||
      recovery.stockFactoryImage.filename !== sourceLock.factory.filename)
  )
    problems.push(
      `${file}: recovery.stockFactoryImage is not the locked factory archive ${sourceLock.factory.filename}`,
    );
  return problems;
}

/**
 * Problems with distributing a signed release on the channel: a retained known-good
 * recovery release and passed signed-update, interruption, rollback and
 * stock-recovery drills. These are recorded from executed drills; nothing here runs
 * or records them.
 */
export function channelDistributionProblems(channel, file = "update channel") {
  const problems = [];
  const recovery = channel?.recovery?.knownGoodRelease;
  for (const field of ["buildFingerprint", "otaSha256", "recordFile"]) {
    const value = recovery?.[field];
    if (
      typeof value !== "string" ||
      !value.trim() ||
      placeholderFields(value).length
    )
      problems.push(`${file}: recovery.knownGoodRelease.${field} is unset`);
    else if (field === "otaSha256" && !HEX64.test(value))
      problems.push(
        `${file}: recovery.knownGoodRelease.otaSha256 must be a SHA-256`,
      );
  }
  const drills = new Set([
    ...CHANNEL_DRILLS,
    ...Object.keys(channel?.drills ?? {}),
  ]);
  for (const drill of drills) {
    const result = channel?.drills?.[drill];
    if (result !== "passed")
      problems.push(
        `${file}: ${drill} drill is ${JSON.stringify(result)}, not passed`,
      );
  }
  return problems;
}

/**
 * Problems with a brand's recorded distribution gates. Each gate stands alone:
 * 'passed' needs release-level evidence of its own, development evidence never
 * passes a gate, and the record must agree with the source lock, release descriptor
 * and update channel it summarizes. An empty list means the record is consistent,
 * not that any gate passed. Evidence references are root-relative files or HTTPS URLs.
 */
export function qualificationGateProblems(
  record,
  {
    root,
    file = "qualification gates",
    descriptor,
    descriptorFile = "release descriptor",
  },
) {
  if (!record || typeof record !== "object")
    return [`${file} is missing or unreadable`];
  const problems = [];
  if (
    record.schema !== 1 ||
    record.target !== "pixel10a" ||
    record.product !== descriptor?.product
  )
    problems.push(
      `${file}: must be schema 1 for ${descriptor?.product ?? "the product"} on pixel10a`,
    );
  const gates = record.gates ?? {};
  if (JSON.stringify(Object.keys(gates)) !== JSON.stringify(GATE_NAMES))
    problems.push(`${file}: gates must be exactly ${GATE_NAMES.join(", ")}`);
  const exists = (ref) =>
    /^https:\/\//.test(ref) ||
    (safeRelativePath(ref) && fs.existsSync(path.join(root, ref)));
  for (const name of GATE_NAMES) {
    const gate = gates[name],
      at = `${file}: ${name}`;
    if (!gate) continue;
    if (!GATE_STATUSES.includes(gate.status)) {
      problems.push(`${at} status must be one of ${GATE_STATUSES.join(", ")}`);
      continue;
    }
    if (!Array.isArray(gate.evidence)) {
      problems.push(`${at} evidence must be a list`);
      continue;
    }
    for (const entry of gate.evidence) {
      if (!EVIDENCE_LEVELS.includes(entry?.level))
        problems.push(`${at} evidence level must be development or release`);
      if (typeof entry?.ref !== "string" || !entry.ref)
        problems.push(`${at} evidence needs a ref`);
      else if (!exists(entry.ref))
        problems.push(`${at} evidence ${entry.ref} is missing`);
    }
    if (gate.status !== "not run" && !gate.evidence.length)
      problems.push(`${at} is "${gate.status}" without evidence`);
    if (
      gate.status === "passed" &&
      !gate.evidence.some((entry) => entry?.level === "release")
    )
      problems.push(`${at} cannot pass on development evidence`);
  }
  // Source admission must name the exact admitted lock.
  if (gates.sourceAdmission?.status === "passed") {
    const lockFile = descriptor?.sourceLock?.file;
    let lockBytes = null;
    try {
      lockBytes = safeRelativePath(lockFile)
        ? fs.readFileSync(path.join(root, lockFile))
        : null;
    } catch {
      lockBytes = null;
    }
    if (!lockBytes)
      problems.push(
        `${file}: sourceAdmission passed without a readable pinned source lock`,
      );
    else {
      let lock = null;
      try {
        lock = JSON.parse(lockBytes);
      } catch {
        lock = null;
      }
      if (lock?.developmentOnly !== false)
        problems.push(
          `${file}: sourceAdmission passed while the lock is developmentOnly`,
        );
      if (sha256(lockBytes) !== descriptor.sourceLock.sha256)
        problems.push(
          `${file}: sourceAdmission passed while ${descriptorFile} does not pin the lock`,
        );
    }
    const verified = gates.sourceAdmission.evidence
      .filter(
        (entry) =>
          entry?.level === "release" &&
          !/^https:\/\//.test(entry.ref) &&
          exists(entry.ref),
      )
      .map((entry) => {
        try {
          return readJson(root, entry.ref);
        } catch {
          return {};
        }
      });
    if (
      !verified.some(
        (report) =>
          report.sourceLockSha256 === descriptor?.sourceLock?.sha256 &&
          report.developmentOnly === false,
      )
    )
      problems.push(
        `${file}: sourceAdmission evidence does not verify the pinned admitted lock`,
      );
  }
  // The update/recovery gate mirrors the channel drill record.
  if (gates.signedUpdateRecovery?.status === "passed") {
    let channel = null;
    try {
      channel = safeRelativePath(descriptor?.ota?.channel)
        ? readJson(root, descriptor.ota.channel)
        : null;
    } catch {
      channel = null;
    }
    for (const problem of channelDistributionProblems(
      channel,
      descriptor?.ota?.channel,
    ))
      problems.push(`${file}: signedUpdateRecovery passed while ${problem}`);
  }
  // User acceptance follows every other gate.
  if (
    gates.userAcceptance?.status === "passed" &&
    GATE_NAMES.some(
      (name) => name !== "userAcceptance" && gates[name]?.status !== "passed",
    )
  )
    problems.push(
      `${file}: userAcceptance cannot pass before every other gate`,
    );
  return problems;
}

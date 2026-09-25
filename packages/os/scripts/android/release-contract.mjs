/** Shared release authorization. Trust comes from the reviewed repository,
 * never from a downloaded archive or a command-line supplied public key. */
import { createHash, createPublicKey, verify } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertSafeFlashMetadata } from "./flash-metadata.mjs";
import { verifyRevocations } from "./revocations.mjs";

export const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
export function requireThat(ok, message) {
  if (!ok) throw new Error(`[android-contract] ${message}`);
}
const digest = (value) =>
  typeof value === "string" &&
  /^[a-f0-9]{64}$/.test(value) &&
  value !== "0".repeat(64);
const token = (value) =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value);
const strings = (value) =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every(token) &&
  new Set(value).size === value.length;
export const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
export function loadPolicy() {
  return {
    trust: readJson(path.join(root, "android/release-trust.json")),
    inventory: readJson(path.join(root, "android/hardware-targets.json")),
  };
}
export const CVD_CHECKS = [
  "cold-boot",
  "selinux-enforcing",
  "privileged-app",
  "launcher",
  "assistant",
  "local-inference",
  "voice",
  "instrumentation",
];
export const PHONE_CHECKS = [
  ...CVD_CHECKS,
  "encryption",
  "keystore",
  "recovery",
  "display-touch-gpu",
  "camera",
  "audio-bluetooth",
  "wifi",
  "cellular-ims",
  "charging-suspend-thermal",
  "full-ota",
  "incremental-ota",
  "interrupted-os-update",
  "slot-fallback",
  "snapshot-merge",
  "rejected-downgrade",
  "stock-restoration",
  "encrypted-recovery",
  "recovery-after-ota-slot",
  "kernel-vendor-module-pair",
];
const CVD_TARGETS = new Map([
  ["cuttlefish-x86_64", "x86_64"],
  ["cuttlefish-arm64", "arm64"],
  ["cuttlefish-riscv64", "riscv64"],
  ["cuttlefish-riscv64-e1", "riscv64"],
]);

function fileContract(entry) {
  requireThat(
    entry &&
      token(entry.filename) &&
      digest(entry.sha256) &&
      Number.isSafeInteger(entry.sizeBytes) &&
      entry.sizeBytes > 0,
    "invalid file contract",
  );
}
export function validateReleaseShape(release) {
  const r = release;
  requireThat(
    r &&
      token(r.releaseId) &&
      token(r.version) &&
      token(r.tag) &&
      ["canary", "beta", "stable"].includes(r.channel),
    "invalid release identity/channel",
  );
  requireThat(
    ["os-install", "lab-experiment"].includes(r.operation) &&
      r.artifactType === "factory",
    "only OS installation and scoped lab experiments are implemented; firmware transitions and OTA need separate adapters",
  );
  requireThat(
    r.target && token(r.target.id) && token(r.target.codename),
    "invalid target",
  );
  requireThat(
    ["physical", "virtual"].includes(r.target.kind),
    "invalid target kind",
  );
  requireThat(
    ["arm64", "x86_64", "riscv64"].includes(r.target.architecture) &&
      [4096, 16384].includes(r.target.pageSize),
    "invalid architecture/page size",
  );
  requireThat(
    typeof r.buildFingerprint === "string" && r.buildFingerprint.length > 0,
    "missing exact fingerprint",
  );
  const lab = r.operation === "lab-experiment";
  requireThat(
    !lab || (r.channel === "canary" && r.target.kind === "physical"),
    "lab experiments require physical canary scope",
  );
  requireThat(
    r.buildType === "user" ||
      (lab && r.buildType === "userdebug") ||
      (r.target.kind === "virtual" && r.buildType === "userdebug"),
    "physical releases require user builds",
  );
  requireThat(
    r.diagnostics &&
      Object.values(r.diagnostics).every(
        (v) => typeof v === "boolean" && (lab || v === false),
      ) &&
      [
        "initProbes",
        "keymasterNonblocking",
        "graphicsOverride",
        "fstabOverride",
        "sepolicyVersionRewrite",
      ].every(
        (k) =>
          typeof r.diagnostics[k] === "boolean" &&
          (lab || r.diagnostics[k] === false),
      ),
    "diagnostic bypasses cannot qualify",
  );
  requireThat(
    r.sources &&
      ["osCommit", "elizaCommit", "aospCommit"].every((k) =>
        /^[a-f0-9]{40}$/.test(r.sources[k]),
      ) &&
      [
        "sourceLockSha256",
        "vendorSha256",
        "kernelSha256",
        "applicationSha256",
        "bundleSha256",
      ].every((k) => digest(r.sources[k])),
    "missing immutable source provenance",
  );
  fileContract(r.archive);
  requireThat(["", "flash/"].includes(r.archiveRoot), "invalid archive root");
  requireThat(
    r.archive.filename.endsWith(".zip"),
    "factory archive must be a ZIP",
  );
  requireThat(Array.isArray(r.files) && r.files.length > 0, "missing files");
  const names = new Set();
  for (const f of r.files) {
    fileContract(f);
    requireThat(!names.has(f.filename), "duplicate file");
    names.add(f.filename);
  }
  requireThat(
    r.validation &&
      Number.isInteger(r.validation.bootTimeoutSeconds) &&
      r.validation.bootTimeoutSeconds >= 30 &&
      r.validation.bootTimeoutSeconds <= 1800,
    "invalid boot timeout",
  );
  requireThat(
    Number.isInteger(r.validation.flashTimeoutSeconds) &&
      r.validation.flashTimeoutSeconds >= 300 &&
      r.validation.flashTimeoutSeconds <= 1800,
    "invalid flash timeout",
  );
  requireThat(
    r.avb &&
      digest(r.avb.publicKeySha256) &&
      [
        "SHA256_RSA4096",
        "SHA512_RSA4096",
        "SHA256_RSA8192",
        "SHA512_RSA8192",
      ].includes(r.avb.algorithm) &&
      (r.avb.productionKeys === true ||
        ((lab || r.target.kind === "virtual") &&
          r.avb.productionKeys === false)) &&
      Array.isArray(r.avb.rollbackIndexes) &&
      r.avb.rollbackIndexes.length > 0,
    "missing production AVB contract",
  );
  const locations = new Set();
  for (const i of r.avb.rollbackIndexes) {
    requireThat(
      Number.isSafeInteger(i.location) &&
        i.location >= 0 &&
        /^\d+$/.test(i.value) &&
        !locations.has(i.location),
      "invalid AVB rollback index",
    );
    locations.add(i.location);
  }
  if (r.target.kind === "virtual") {
    requireThat(
      CVD_TARGETS.get(r.target.id) === r.target.architecture &&
        r.strategy === "virtual",
      "unknown virtual target/strategy",
    );
    return r;
  }
  requireThat(
    r.target.id === "pixel11pro-grizzly" &&
      r.target.codename === "grizzly" &&
      r.target.architecture === "arm64",
    "physical adapter not implemented for this target",
  );
  requireThat(
    strings(r.target.skus) &&
      r.target.skus.every((s) => ["G7SWN", "GM45K"].includes(s)),
    "unreviewed grizzly SKU",
  );
  requireThat(
    [undefined, "fastboot-sku", "adb-stock-before-reboot"].includes(
      r.target.identityMethod,
    ),
    "unsupported physical identity method",
  );
  requireThat(
    [undefined, "battery-level", "battery-soc"].includes(r.batteryQuery),
    "unsupported battery query",
  );
  requireThat(
    strings(r.target.storageBytes) &&
      r.target.storageBytes.every((v) => /^\d+$/.test(v) && BigInt(v) > 0n),
    "missing qualified userdata capacities",
  );
  requireThat(
    r.strategy === "grizzly-fastboot-info",
    "unsupported physical layout strategy",
  );
  requireThat(
    r.planSha256 ===
      r.files.find((f) => f.filename === "fastboot-info.txt")?.sha256 &&
      names.has("android-info.txt"),
    "missing bound flash metadata",
  );
  requireThat(
    r.geometry &&
      r.geometry.superBytes === 10737418240 &&
      r.geometry.dynamicGroupBytes === 10733223936 &&
      r.geometry.partitionSizes &&
      Object.entries(r.geometry.partitionSizes).length > 0,
    "missing qualified partition geometry",
  );
  for (const [k, v] of Object.entries(r.geometry.partitionSizes))
    requireThat(
      token(k) && /^0x[0-9a-f]+$/.test(v) && BigInt(v) > 0n,
      "invalid partition size",
    );
  requireThat(
    r.geometry.partitionSizes.super &&
      BigInt(r.geometry.partitionSizes.super) === BigInt(r.geometry.superBytes),
    "super capacity mismatch",
  );
  requireThat(
    r.tools &&
      ["adb", "fastboot"].every(
        (k) =>
          digest(r.tools[k]?.sha256) &&
          typeof r.tools[k]?.version === "string" &&
          r.tools[k].version.length > 0,
      ),
    "missing pinned platform tools",
  );
  requireThat(
    Number.isInteger(r.minimumBatteryPercent) &&
      r.minimumBatteryPercent >= 30 &&
      r.minimumBatteryPercent <= 100,
    "missing battery policy",
  );
  requireThat(
    Array.isArray(r.startingStates) && r.startingStates.length > 0,
    "missing qualified starting states",
  );
  const ids = new Set();
  for (const state of r.startingStates) {
    requireThat(
      token(state.id) &&
        !ids.has(state.id) &&
        token(state.bootloader) &&
        token(state.baseband),
      "invalid firmware state",
    );
    ids.add(state.id);
    if (r.target.identityMethod === "adb-stock-before-reboot") {
      requireThat(
        typeof state.stockFingerprint === "string" &&
          /^google\/grizzly\/grizzly:[^\s]+:user\/release-keys$/.test(
            state.stockFingerprint,
          ),
        "missing exact stock fingerprint for Android identity",
      );
    }
    requireThat(
      state.rollback &&
        state.rollback.method === "qualified-firmware-state" &&
        digest(state.rollback.evidenceSha256),
      "unknown rollback state; no implicit zero/default",
    );
    requireThat(
      ["a", "b"].includes(state.currentSlot) &&
        ["a", "b"].includes(state.targetSlot) &&
        typeof state.wipeRequired === "boolean",
      "invalid slot/wipe policy",
    );
    requireThat(
      state.recovery &&
        state.recovery.method === "oem-documented" &&
        /^https:\/\/(developers\.google\.com|developer\.android\.com|support\.google\.com)\//.test(
          state.recovery.instructionsUrl,
        ) &&
        digest(state.recovery.evidenceSha256),
      "missing qualified recovery",
    );
    fileContract(state.recovery.archive);
    requireThat(
      state.getvars &&
        Object.keys(state.getvars).length > 0 &&
        [
          "slot-successful:a",
          "slot-successful:b",
          "slot-unbootable:a",
          "slot-unbootable:b",
        ].every((k) => ["yes", "no"].includes(state.getvars[k])),
      "missing slot health expectations",
    );
    for (const [k, v] of Object.entries(state.getvars))
      requireThat(
        /^[a-z0-9:-]+$/.test(k) && typeof v === "string" && v.length > 0,
        "invalid starting getvar",
      );
  }
  return r;
}

export function validateEnvelope(
  envelope,
  { trust, inventory, now = Date.now() } = loadPolicy(),
) {
  requireThat(
    envelope?.schemaVersion === 2,
    "confirmed installation requires a signed schemaVersion 2 contract; legacy manifests are planning-only",
  );
  const r = validateReleaseShape(envelope.release);
  const subject = sha256(canonical(r));
  requireThat(
    trust?.schemaVersion === 1 &&
      Array.isArray(trust.keys) &&
      Array.isArray(trust.revokedReleaseDigests) &&
      Array.isArray(trust.revokedKeyIds),
    "invalid trusted policy",
  );
  requireThat(
    !trust.revokedReleaseDigests.includes(subject),
    "release revoked",
  );
  if (r.target.kind === "physical") {
    const target = inventory?.targets?.find((t) => t.targetId === r.target.id);
    requireThat(
      (r.operation === "lab-experiment"
        ? target?.labExperimentsEligible === true
        : target?.installerEligible === true) &&
        target.codenames.includes(r.target.codename),
      "target is installer-ineligible",
    );
    requireThat(
      r.buildFingerprint.startsWith(target.expectedFingerprintPrefix) &&
        (r.buildFingerprint.endsWith(":user/release-keys") ||
          (r.operation === "lab-experiment" &&
            r.buildFingerprint.endsWith(":userdebug/test-keys"))),
      "physical fingerprint is not a production identity",
    );
  }
  const bulletin = verifyRevocations(trust, now);
  requireThat(
    !bulletin.revokedReleaseDigests.includes(subject),
    "release revoked by signed bulletin",
  );
  const q = envelope.qualification;
  requireThat(
    q?.subjectSha256 === subject &&
      q.status ===
        (r.operation === "lab-experiment" ? "experiment-authorized" : "pass") &&
      digest(q.evidenceSha256),
    "qualification does not bind these exact release bytes",
  );
  requireThat(
    Number.isFinite(Date.parse(q.issuedAt)) &&
      Date.parse(q.issuedAt) <= now &&
      Date.parse(q.expiresAt) > now &&
      Date.parse(q.expiresAt) > Date.parse(q.issuedAt),
    "qualification expired/not yet valid",
  );
  const checks =
    r.operation === "lab-experiment"
      ? [
          "stock-baseline",
          "recovery",
          "firmware-rollback-policy",
          "cuttlefish-boot",
          "artifact-validation",
        ]
      : r.target.kind === "physical"
        ? PHONE_CHECKS
        : CVD_CHECKS;
  requireThat(
    Array.isArray(q.cases) && q.cases.length > 0,
    "missing qualification cases",
  );
  const combinations =
    r.target.kind === "physical"
      ? r.target.skus.flatMap((sku) =>
          r.target.storageBytes.flatMap((storageBytes) =>
            r.startingStates.map((state) => [sku, state.id, storageBytes]),
          ),
        )
      : [["virtual", "virtual", "virtual"]];
  for (const [sku, stateId, storageBytes] of combinations) {
    const c = q.cases.find(
      (x) =>
        x.sku === sku &&
        x.startingStateId === stateId &&
        x.storageBytes === storageBytes,
    );
    requireThat(
      c &&
        digest(c.evidenceSha256) &&
        checks.every((k) => c.checks?.[k] === "pass"),
      `qualification incomplete: ${sku}/${stateId}/${storageBytes}`,
    );
  }
  const signed = Buffer.from(
    canonical({ schemaVersion: 2, release: r, qualification: q }),
  );
  requireThat(Array.isArray(envelope.signatures), "missing signatures");
  const used = new Set();
  const usedPublicKeys = new Set();
  for (const role of ["release", "qualification"]) {
    const valid = envelope.signatures.find((s) => {
      const key = trust.keys.find(
        (k) =>
          k.id === s.keyId &&
          k.roles?.includes(role) &&
          k.channels?.includes(r.channel) &&
          k.operations?.includes(r.operation),
      );
      if (
        s.role !== role ||
        !key ||
        used.has(key.id) ||
        trust.revokedKeyIds.includes(key.id) ||
        bulletin.revokedKeyIds.includes(key.id) ||
        !(Date.parse(key.expiresAt) > now)
      )
        return false;
      try {
        const publicKey = createPublicKey(key.publicKey);
        const identity = sha256(
          publicKey.export({ type: "spki", format: "der" }),
        );
        return (
          !usedPublicKeys.has(identity) &&
          publicKey.asymmetricKeyType === "ed25519" &&
          verify(null, signed, publicKey, Buffer.from(s.signature, "base64"))
        );
      } catch {
        return false;
      }
    });
    requireThat(valid, `missing trusted independent ${role} signature`);
    used.add(valid.keyId);
    usedPublicKeys.add(
      sha256(
        createPublicKey(
          trust.keys.find((k) => k.id === valid.keyId).publicKey,
        ).export({ type: "spki", format: "der" }),
      ),
    );
  }
  return { release: r, subjectSha256: subject };
}

// Stream images: multi-gigabyte super/ZIP files must not be loaded into RAM.
export function hashFile(file) {
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const before = fs.fstatSync(fd);
    requireThat(
      before.isFile() && before.nlink === 1,
      `not a regular unlinked-to-other-path file: ${file}`,
    );
    const h = createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      h.update(buffer.subarray(0, count));
    }
    const after = fs.fstatSync(fd);
    requireThat(
      before.size === after.size &&
        before.mtimeMs === after.mtimeMs &&
        before.ctimeMs === after.ctimeMs,
      `file changed while hashing: ${file}`,
    );
    return { sha256: h.digest("hex"), sizeBytes: after.size };
  } finally {
    fs.closeSync(fd);
  }
}
export function verifyFile(directory, entry) {
  fileContract(entry);
  const file = path.join(directory, entry.filename);
  const actual = hashFile(file);
  requireThat(
    actual.sha256 === entry.sha256 && actual.sizeBytes === entry.sizeBytes,
    `artifact integrity failed: ${entry.filename}`,
  );
  return file;
}
export function parseAndroidInfo(text) {
  const requirements = new Map();
  for (const line of text
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter((x) => x && !x.startsWith("#"))) {
    const m =
      /^require (board|version-bootloader|version-baseband|partition-exists)=([A-Za-z0-9._+|-]+)$/.exec(
        line,
      );
    requireThat(m, `unsupported android-info directive: ${line}`);
    requireThat(
      !requirements.has(m[1]),
      `duplicate android-info requirement: ${m[1]}`,
    );
    const values = m[2].split("|");
    requireThat(values.every(token), "invalid android-info alternatives");
    requirements.set(m[1], values);
  }
  for (const k of [
    "board",
    "version-bootloader",
    "version-baseband",
    "partition-exists",
  ])
    requireThat(requirements.has(k), `missing android-info ${k}`);
  return requirements;
}
export function verifyInstallFiles(release, directory) {
  for (const f of release.files) verifyFile(directory, f);
  const names = new Set(release.files.map((f) => f.filename));
  for (const name of fs.readdirSync(directory))
    requireThat(
      !name.endsWith(".img") || names.has(name),
      `undeclared image: ${name}`,
    );
  const androidInfo = fs.readFileSync(
    path.join(directory, "android-info.txt"),
    "utf8",
  );
  const fastbootInfo = fs.readFileSync(
    path.join(directory, "fastboot-info.txt"),
    "utf8",
  );
  requireThat(
    sha256(androidInfo) ===
      release.files.find((f) => f.filename === "android-info.txt")?.sha256 &&
      sha256(fastbootInfo) === release.planSha256,
    "metadata changed after integrity check",
  );
  const requirements = parseAndroidInfo(androidInfo);
  requireThat(
    requirements.get("board").length === 1 &&
      requirements.get("board")[0] === release.target.codename,
    "android-info board mismatch",
  );
  for (const s of release.startingStates)
    requireThat(
      requirements.get("version-bootloader").includes(s.bootloader) &&
        requirements.get("version-baseband").includes(s.baseband),
      "starting firmware inconsistent with bundle",
    );
  const parsed = assertSafeFlashMetadata({ androidInfo, fastbootInfo });
  requireThat(
    parsed.artifacts.every((name) => names.has(name)),
    "flash metadata references unbound artifact",
  );
  requireThat(
    release.files
      .filter((f) => f.filename.endsWith(".img"))
      .every((f) => parsed.artifacts.includes(f.filename)),
    "mixed or extraneous image strategy",
  );
  return { requirements, fastbootInfo };
}

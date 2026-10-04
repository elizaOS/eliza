/** Product admission after TUF target authentication. This module neither
 * authenticates metadata nor grants installation authority. No caller may use
 * a parsed descriptor directly as a trusted update. */
import { createHash } from "node:crypto";
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/;
function requireValue(ok, message) {
  if (!ok) throw Error(`OTA descriptor: ${message}`);
}
function object(value, keys, label) {
  requireValue(
    value && typeof value === "object" && !Array.isArray(value),
    label,
  );
  requireValue(
    Object.keys(value).length === keys.length &&
      keys.every((k) => Object.hasOwn(value, k)),
    `${label} fields`,
  );
}
function integer(n, min, max, label) {
  requireValue(Number.isSafeInteger(n) && n >= min && n <= max, label);
}
function text(s, pattern, label) {
  requireValue(typeof s === "string" && pattern.test(s), label);
}
function array(values, min, max, check, label) {
  requireValue(
    Array.isArray(values) && values.length >= min && values.length <= max,
    label,
  );
  for (const v of values) check(v);
  requireValue(
    new Set(values.map((v) => JSON.stringify(v))).size === values.length,
    `${label} duplicates`,
  );
}
function range(r, label) {
  object(r, ["min", "max"], label);
  integer(r.min, 1, 2147483647, label);
  integer(r.max, r.min, 2147483647, label);
}
function epoch(s, label) {
  requireValue(
    typeof s === "string" &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/.test(s) &&
      Number.isFinite(Date.parse(s)) &&
      new Date(s).toISOString() === s,
    label,
  );
  return Date.parse(s);
}
function url(s, hosts) {
  requireValue(typeof s === "string" && s.length <= 2048, "URL length");
  let u;
  try {
    u = new URL(s);
  } catch {
    throw Error("OTA descriptor: invalid URL");
  }
  requireValue(
    u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      !u.port &&
      !u.hash &&
      !u.search &&
      hosts.has(u.hostname) &&
      u.href === s,
    "URL authority",
  );
  requireValue(!/%|\\|\/\.\.?\//.test(u.pathname), "URL path");
  return u;
}
function artifact(a, hosts) {
  object(
    a,
    [
      "sha256",
      "length",
      "url",
      "mirrors",
      "versionCode",
      "versionName",
      "signerSha256",
      "securityEpoch",
      "android",
      "compatibility",
      "runtime",
    ],
    "artifact",
  );
  text(a.sha256, HASH, "artifact hash");
  text(a.signerSha256, HASH, "signer");
  integer(a.length, 1, 1024 ** 3, "artifact length");
  integer(a.versionCode, 1, 2100000000, "versionCode");
  text(a.versionName, /^[a-zA-Z0-9][a-zA-Z0-9.+_-]{0,63}$/, "versionName");
  integer(a.securityEpoch, 1, 2147483647, "security epoch");
  url(a.url, hosts);
  array(a.mirrors, 0, 8, (s) => url(s, hosts), "mirrors");
  requireValue(!a.mirrors.includes(a.url), "duplicate primary mirror");
  object(
    a.android,
    [
      "sdk",
      "targetSdk",
      "abis",
      "models",
      "buildFingerprints",
      "installerCapabilities",
    ],
    "android",
  );
  range(a.android.sdk, "qualified SDK range");
  integer(a.android.targetSdk, a.android.sdk.min, 2147483647, "target SDK");
  array(
    a.android.abis,
    1,
    4,
    (s) => text(s, /^(arm64-v8a|armeabi-v7a|x86_64|x86)$/, "ABI"),
    "abis",
  );
  array(
    a.android.models,
    1,
    128,
    (s) => text(s, /^[a-zA-Z0-9][a-zA-Z0-9 ._()-]{0,127}$/, "model"),
    "models",
  );
  array(
    a.android.buildFingerprints,
    1,
    256,
    (s) =>
      text(
        s,
        /^[a-zA-Z0-9][a-zA-Z0-9:/. _+-]{0,511}$/,
        "qualified fingerprint",
      ),
    "fingerprints",
  );
  array(
    a.android.installerCapabilities,
    1,
    8,
    (s) =>
      requireValue(
        [
          "device-owner",
          "privileged-installer",
          "silent-install",
          "forward-recovery",
        ].includes(s),
        "installer capability",
      ),
    "installer capabilities",
  );
  object(
    a.compatibility,
    [
      "agentProtocol",
      "database",
      "minimumSupervisor",
      "browserProtocol",
      "upgradeOrigins",
    ],
    "compatibility",
  );
  range(a.compatibility.agentProtocol, "agent protocol");
  range(a.compatibility.browserProtocol, "browser protocol");
  integer(
    a.compatibility.minimumSupervisor,
    1,
    2100000000,
    "minimum supervisor",
  );
  object(a.compatibility.database, ["read", "write"], "database");
  range(a.compatibility.database.read, "database read");
  range(a.compatibility.database.write, "database write");
  requireValue(
    a.compatibility.database.read.min <= a.compatibility.database.write.min &&
      a.compatibility.database.read.max >= a.compatibility.database.write.max,
    "writer cannot read its own schema",
  );
  array(
    a.compatibility.upgradeOrigins,
    1,
    128,
    (s) => text(s, HASH, "upgrade origin"),
    "upgrade origins",
  );
  object(
    a.runtime,
    [
      "inventorySha256",
      "agentSha256",
      "gatewaySha256",
      "policySha256",
      "nativeLibraries",
    ],
    "runtime",
  );
  for (const key of [
    "inventorySha256",
    "agentSha256",
    "gatewaySha256",
    "policySha256",
  ])
    text(a.runtime[key], HASH, key);
  requireValue(
    a.runtime.nativeLibraries &&
      typeof a.runtime.nativeLibraries === "object" &&
      !Array.isArray(a.runtime.nativeLibraries),
    "native library inventory",
  );
  const libs = Object.keys(a.runtime.nativeLibraries);
  requireValue(libs.length > 0 && libs.length <= 128, "native library count");
  for (const lib of libs) {
    text(lib, /^lib[a-zA-Z0-9_-]+\.so$/, "native library");
    text(a.runtime.nativeLibraries[lib], HASH, "native digest");
  }
  requireValue(
    Object.hasOwn(a.runtime.nativeLibraries, "libeliza_bun.so"),
    "native agent runtime absent",
  );
}
export function createReleaseContract({
  product,
  packageId,
  cohortNamespace,
} = {}) {
  text(product, ID, "provisioned product");
  text(
    packageId,
    /^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)+$/,
    "provisioned package",
  );
  text(cohortNamespace, ID, "provisioned cohort namespace");
  function validateRelease(d, { artifactHosts } = {}) {
    requireValue(
      artifactHosts instanceof Set && artifactHosts.has("github.com"),
      "provisioned artifact host allowlist required",
    );
    for (const host of artifactHosts)
      requireValue(
        typeof host === "string" &&
          /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(host) &&
          !host.endsWith(".local") &&
          !host.endsWith(".localhost") &&
          !host.endsWith(".internal"),
        "public artifact host",
      );
    object(
      d,
      [
        "schemaVersion",
        "product",
        "packageId",
        "distribution",
        "channel",
        "releaseId",
        "sequence",
        "securityFloor",
        "source",
        "candidate",
        "recovery",
        "safety",
        "rollout",
      ],
      "release",
    );
    requireValue(
      d.schemaVersion === 1 &&
        d.product === product &&
        d.packageId === packageId,
      "product/schema identity",
    );
    requireValue(
      ["standalone", "launcher"].includes(d.distribution),
      "distribution",
    );
    requireValue(["stable", "beta"].includes(d.channel), "channel");
    text(d.releaseId, ID, "release ID");
    integer(d.sequence, 1, Number.MAX_SAFE_INTEGER, "release sequence");
    integer(d.securityFloor, 1, 2147483647, "security floor");
    object(
      d.source,
      ["repository", "tag", "commit", "upstreamCommit", "patchSha256"],
      "source",
    );
    text(
      d.source.repository,
      /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+$/,
      "repository",
    );
    text(d.source.tag, ID, "immutable tag");
    text(d.source.commit, /^[a-f0-9]{40}$/, "source commit");
    text(d.source.upstreamCommit, /^[a-f0-9]{40}$/, "upstream commit");
    array(
      d.source.patchSha256,
      0,
      128,
      (s) => text(s, HASH, "patch digest"),
      "patch digests",
    );
    artifact(d.candidate, artifactHosts);
    artifact(d.recovery, artifactHosts);
    for (const a of [d.candidate, d.recovery]) {
      requireValue(
        a.url.startsWith(
          `https://github.com/${d.source.repository}/releases/download/${d.source.tag}/`,
        ) &&
          /^[-a-zA-Z0-9_.]+\.apk$/.test(
            new URL(a.url).pathname.split("/").at(-1),
          ),
        "immutable GitHub APK URL",
      );
      requireValue(
        a.securityEpoch >= d.securityFloor,
        "artifact below security floor",
      );
    }
    requireValue(
      d.candidate.sha256 !== d.recovery.sha256 &&
        d.recovery.versionCode > d.candidate.versionCode,
      "forward recovery identity",
    );
    requireValue(
      d.recovery.signerSha256 === d.candidate.signerSha256,
      "recovery signing continuity",
    );
    requireValue(
      d.recovery.compatibility.upgradeOrigins.includes(d.candidate.sha256),
      "recovery not authorized for candidate",
    );
    const writes = d.candidate.compatibility.database.write,
      reads = d.recovery.compatibility.database.read;
    requireValue(
      reads.min <= writes.min && reads.max >= writes.max,
      "recovery cannot read candidate data",
    );
    object(
      d.safety,
      [
        "recoveryForSha256",
        "minimumFreeBytes",
        "healthProfile",
        "activationProfile",
      ],
      "safety",
    );
    requireValue(
      d.safety.recoveryForSha256 === d.candidate.sha256,
      "recovery authorization binding",
    );
    integer(
      d.safety.minimumFreeBytes,
      d.candidate.length + d.recovery.length,
      Number.MAX_SAFE_INTEGER,
      "disk reserve",
    );
    text(d.safety.healthProfile, ID, "health profile");
    text(d.safety.activationProfile, ID, "activation profile");
    object(
      d.rollout,
      [
        "seed",
        "threshold",
        "starts",
        "expires",
        "revision",
        "paused",
        "revokedSha256",
      ],
      "rollout",
    );
    text(d.rollout.seed, HASH, "rollout seed");
    integer(d.rollout.threshold, 0, 10000, "cohort threshold");
    integer(d.rollout.revision, 1, Number.MAX_SAFE_INTEGER, "rollout revision");
    requireValue(typeof d.rollout.paused === "boolean", "pause policy");
    requireValue(
      epoch(d.rollout.starts, "start time") <
        epoch(d.rollout.expires, "expiry time"),
      "rollout time order",
    );
    array(
      d.rollout.revokedSha256,
      0,
      4096,
      (s) => text(s, HASH, "revoked digest"),
      "revocations",
    );
    return d;
  }
  const includes = (range, n) =>
    Number.isSafeInteger(n) && n >= range.min && n <= range.max;
  /** Stable per-device cohort; caller provides a randomly provisioned opaque ID,
   * never an email, account ID, phone number or hardware serial. */
  function cohortBucket(opaqueId, seed) {
    text(opaqueId, HASH, "opaque cohort ID");
    text(seed, HASH, "cohort seed");
    return (
      createHash("sha256")
        .update(`${cohortNamespace}\0${seed}\0${opaqueId}`)
        .digest()
        .readUInt32BE(0) % 10000
    );
  }
  function admitRelease(descriptor, device, policy) {
    const d = validateRelease(descriptor, policy);
    // `policy` must come from authenticated, persisted TUF state. A boolean in
    // JSON is deliberately insufficient to establish trusted provenance.
    requireValue(
      typeof policy.trustedNowMs === "number" &&
        Number.isSafeInteger(policy.trustedNowMs) &&
        policy.trustedNowMs >= 0,
      "trusted time unavailable",
    );
    for (const key of [
      "minimumSequence",
      "minimumRolloutRevision",
      "securityFloor",
    ])
      integer(policy[key], 1, Number.MAX_SAFE_INTEGER, `trusted ${key}`);
    object(
      device,
      [
        "requestedChannel",
        "distribution",
        "quarantine",
        "installedSha256",
        "installedVersionCode",
        "signerSha256",
        "sdk",
        "abi",
        "model",
        "buildFingerprint",
        "installerCapabilities",
        "supervisorVersion",
        "agentProtocol",
        "browserProtocol",
        "databaseSchema",
        "freeBytes",
        "healthProfiles",
        "activationProfiles",
        "opaqueCohortId",
      ],
      "device snapshot",
    );
    requireValue(
      ["stable", "beta"].includes(device.requestedChannel) &&
        ["launcher", "standalone"].includes(device.distribution),
      "device channel/distribution",
    );
    for (const key of ["installedSha256", "signerSha256", "opaqueCohortId"])
      text(device[key], HASH, key);
    for (const key of [
      "installedVersionCode",
      "sdk",
      "supervisorVersion",
      "agentProtocol",
      "browserProtocol",
      "databaseSchema",
    ])
      integer(device[key], 1, 2100000000, key);
    integer(device.freeBytes, 0, Number.MAX_SAFE_INTEGER, "available storage");
    array(
      device.quarantine,
      0,
      4096,
      (s) => text(s, HASH, "quarantined digest"),
      "quarantine",
    );
    for (const key of ["abi", "model", "buildFingerprint"])
      requireValue(
        typeof device[key] === "string" &&
          device[key].length > 0 &&
          device[key].length <= 512,
        key,
      );
    for (const key of [
      "installerCapabilities",
      "healthProfiles",
      "activationProfiles",
    ])
      array(device[key], 0, 128, (s) => text(s, ID, key), key);
    text(
      policy.repository,
      /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+$/,
      "provisioned repository",
    );
    const defer = (reason) => ({ decision: "defer", reason });
    if (d.source.repository !== policy.repository)
      return defer("repository-mismatch");
    if (device.requestedChannel !== d.channel) return defer("channel-mismatch");
    if (device.distribution !== d.distribution)
      return defer("distribution-mismatch");
    if (
      d.sequence < policy.minimumSequence ||
      d.rollout.revision < policy.minimumRolloutRevision
    )
      return defer("metadata-rollback");
    if (d.rollout.paused) return defer("rollout-paused");
    if (
      policy.trustedNowMs < Date.parse(d.rollout.starts) ||
      policy.trustedNowMs >= Date.parse(d.rollout.expires)
    )
      return defer("rollout-time");
    if (
      d.rollout.revokedSha256.includes(d.candidate.sha256) ||
      d.rollout.revokedSha256.includes(d.recovery.sha256)
    )
      return defer("revoked-artifact");
    if (
      d.securityFloor < policy.securityFloor ||
      d.candidate.securityEpoch < policy.securityFloor ||
      d.recovery.securityEpoch < policy.securityFloor
    )
      return defer("security-floor");
    if (
      device.quarantine.includes(d.candidate.sha256) ||
      device.quarantine.includes(d.recovery.sha256)
    )
      return defer("quarantined");
    const installed =
      device.installedSha256 === d.candidate.sha256 &&
      device.installedVersionCode === d.candidate.versionCode;
    if (d.candidate.signerSha256 !== device.signerSha256)
      return defer("signer-mismatch");
    if (installed)
      return { decision: "already-installed", effectiveChannel: d.channel };
    if (d.candidate.versionCode <= device.installedVersionCode)
      return defer("await-forward-version");
    if (
      !d.candidate.compatibility.upgradeOrigins.includes(device.installedSha256)
    )
      return defer("bridge-release-required");
    for (const a of [d.candidate, d.recovery]) {
      if (a.signerSha256 !== device.signerSha256)
        return defer("signer-mismatch");
      if (
        !includes(a.android.sdk, device.sdk) ||
        !a.android.abis.includes(device.abi) ||
        !a.android.models.includes(device.model) ||
        !a.android.buildFingerprints.includes(device.buildFingerprint)
      )
        return defer("unqualified-device");
      if (
        !a.android.installerCapabilities.every((cap) =>
          device.installerCapabilities.includes(cap),
        )
      )
        return defer("installer-authority");
      if (
        device.supervisorVersion < a.compatibility.minimumSupervisor ||
        !includes(a.compatibility.agentProtocol, device.agentProtocol) ||
        !includes(a.compatibility.browserProtocol, device.browserProtocol)
      )
        return defer("protocol-incompatible");
      if (!includes(a.compatibility.database.read, device.databaseSchema))
        return defer("data-incompatible");
    }
    if (device.freeBytes < d.safety.minimumFreeBytes)
      return defer("disk-reserve");
    if (
      !device.healthProfiles.includes(d.safety.healthProfile) ||
      !device.activationProfiles.includes(d.safety.activationProfile)
    )
      return defer("unsupported-safety-profile");
    if (
      cohortBucket(device.opaqueCohortId, d.rollout.seed) >= d.rollout.threshold
    )
      return defer("outside-cohort");
    return {
      decision: "eligible",
      releaseId: d.releaseId,
      sequence: d.sequence,
      candidateSha256: d.candidate.sha256,
      recoverySha256: d.recovery.sha256,
    };
  }
  return Object.freeze({ validateRelease, cohortBucket, admitRelease });
}

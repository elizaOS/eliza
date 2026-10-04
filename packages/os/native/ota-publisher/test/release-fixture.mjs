export const hash = (c) => c.repeat(64);
export function fixture() {
  const artifact = (digest, code, origin) => ({
    sha256: hash(digest),
    length: 1024,
    url: `https://github.com/example-org/example-app/releases/download/v2/${code}.apk`,
    mirrors: [],
    versionCode: code,
    versionName: "0.2.0",
    signerSha256: hash("d"),
    securityEpoch: 1,
    android: {
      sdk: { min: 35, max: 35 },
      targetSdk: 36,
      abis: ["arm64-v8a"],
      models: ["Qualified tablet"],
      buildFingerprints: ["vendor/model/product:15/build/release-keys"],
      installerCapabilities: [
        "device-owner",
        "silent-install",
        "forward-recovery",
      ],
    },
    compatibility: {
      agentProtocol: { min: 1, max: 1 },
      database: { read: { min: 1, max: 2 }, write: { min: 2, max: 2 } },
      minimumSupervisor: 1,
      browserProtocol: { min: 1, max: 1 },
      upgradeOrigins: [hash(origin)],
    },
    runtime: {
      inventorySha256: hash("e"),
      agentSha256: hash("e"),
      gatewaySha256: hash("e"),
      policySha256: hash("e"),
      nativeLibraries: { "libeliza_bun.so": hash("e") },
    },
  });
  const release = {
    schemaVersion: 1,
    product: "example-app",
    packageId: "org.example.app",
    distribution: "launcher",
    channel: "stable",
    releaseId: "v2",
    sequence: 2,
    securityFloor: 1,
    source: {
      repository: "example-org/example-app",
      tag: "v2",
      commit: "a".repeat(40),
      upstreamCommit: "b".repeat(40),
      patchSha256: [],
    },
    candidate: artifact("b", 2, "a"),
    recovery: artifact("c", 3, "b"),
    safety: {
      recoveryForSha256: hash("b"),
      minimumFreeBytes: 8192,
      healthProfile: "native-agent-v1",
      activationProfile: "idle-v1",
    },
    rollout: {
      seed: hash("f"),
      threshold: 10000,
      starts: "2026-10-01T00:00:00.000Z",
      expires: "2026-11-01T00:00:00.000Z",
      revision: 1,
      paused: false,
      revokedSha256: [],
    },
  };
  const device = {
    requestedChannel: "stable",
    distribution: "launcher",
    quarantine: [],
    installedSha256: hash("a"),
    installedVersionCode: 1,
    signerSha256: hash("d"),
    sdk: 35,
    abi: "arm64-v8a",
    model: "Qualified tablet",
    buildFingerprint: "vendor/model/product:15/build/release-keys",
    installerCapabilities: [
      "device-owner",
      "silent-install",
      "forward-recovery",
    ],
    supervisorVersion: 1,
    agentProtocol: 1,
    browserProtocol: 1,
    databaseSchema: 1,
    freeBytes: 16384,
    healthProfiles: ["native-agent-v1"],
    activationProfiles: ["idle-v1"],
    opaqueCohortId: hash("1"),
  };
  const policy = {
    repository: "example-org/example-app",
    artifactHosts: new Set(["github.com", "updates.example.com"]),
    trustedNowMs: Date.parse("2026-10-02T00:00:00Z"),
    minimumSequence: 1,
    minimumRolloutRevision: 1,
    securityFloor: 1,
  };
  return { release, device, policy };
}

export const invalid = {
  "unknown mandatory field": (r) => {
    r.unrecognized = true;
  },
  "unknown nested field": (r) => {
    r.candidate.runtime.extra = "value";
  },
  "wrong product": (r) => {
    r.product = "other";
  },
  "wrong package": (r) => {
    r.packageId = "other.app";
  },
  "unsafe integer": (r) => {
    r.sequence = Number.MAX_SAFE_INTEGER + 1;
  },
  "version exhaustion": (r) => {
    r.recovery.versionCode = 2100000001;
  },
  "downgrade recovery": (r) => {
    r.recovery.versionCode = 1;
  },
  "same recovery bytes": (r) => {
    r.recovery.sha256 = r.candidate.sha256;
  },
  "wrong recovery authority": (r) => {
    r.safety.recoveryForSha256 = hash("a");
  },
  "wrong recovery origin": (r) => {
    r.recovery.compatibility.upgradeOrigins = [hash("a")];
  },
  "recovery signer discontinuity": (r) => {
    r.recovery.signerSha256 = hash("a");
  },
  "unreadable candidate data": (r) => {
    r.recovery.compatibility.database.read = { min: 1, max: 1 };
    r.recovery.compatibility.database.write = { min: 1, max: 1 };
  },
  "writer cannot read own schema": (r) => {
    r.candidate.compatibility.database.read = { min: 1, max: 1 };
  },
  "recovery below security floor": (r) => {
    r.securityFloor = 2;
    r.candidate.securityEpoch = 2;
  },
  "unbounded APK": (r) => {
    r.candidate.length = 1024 ** 3 + 1;
  },
  "insufficient paired cache reserve": (r) => {
    r.safety.minimumFreeBytes = 2047;
  },
  "missing native runtime": (r) => {
    r.candidate.runtime.nativeLibraries = { "libother.so": hash("a") };
  },
  "native path traversal": (r) => {
    r.candidate.runtime.nativeLibraries["../lib.so"] = hash("a");
  },
  "wrong GitHub repository": (r) => {
    r.candidate.url = r.candidate.url.replace("example-org", "attacker");
  },
  "mutable latest URL": (r) => {
    r.candidate.url =
      "https://github.com/example-org/example-app/releases/latest/download/app.apk";
  },
  "credentials in URL": (r) => {
    r.candidate.mirrors = ["https://user:secret@updates.example.com/app.apk"];
  },
  "unapproved host": (r) => {
    r.candidate.mirrors = ["https://unapproved.example/app.apk"];
  },
  "private IP URL": (r) => {
    r.candidate.mirrors = ["https://127.0.0.1/app.apk"];
  },
  "encoded traversal": (r) => {
    r.candidate.mirrors = ["https://updates.example.com/%2e%2e/app.apk"];
  },
  "query credential URL": (r) => {
    r.candidate.mirrors = ["https://updates.example.com/app.apk?token=secret"];
  },
  "invalid calendar date": (r) => {
    r.rollout.expires = "2026-02-30T00:00:00.000Z";
  },
  "inverted time window": (r) => {
    r.rollout.expires = r.rollout.starts;
  },
  "duplicate revocations": (r) => {
    r.rollout.revokedSha256 = [hash("a"), hash("a")];
  },
  "unbounded cohort": (r) => {
    r.rollout.threshold = 10001;
  },
  "wildcard device model": (r) => {
    r.candidate.android.models = ["*"];
  },
};
export const deferred = [
  ["channel-mismatch", ({ release }) => (release.channel = "beta")],
  [
    "distribution-mismatch",
    ({ release }) => (release.distribution = "standalone"),
  ],
  ["metadata-rollback", ({ policy }) => (policy.minimumSequence = 3)],
  ["metadata-rollback", ({ policy }) => (policy.minimumRolloutRevision = 2)],
  ["rollout-paused", ({ release }) => (release.rollout.paused = true)],
  [
    "rollout-time",
    ({ policy }) => (policy.trustedNowMs = Date.parse("2027-01-01")),
  ],
  ["rollout-time", ({ policy }) => (policy.trustedNowMs = 0)],
  [
    "revoked-artifact",
    ({ release }) => (release.rollout.revokedSha256 = [hash("c")]),
  ],
  ["security-floor", ({ policy }) => (policy.securityFloor = 2)],
  ["quarantined", ({ device }) => (device.quarantine = [hash("b")])],
  ["quarantined", ({ device }) => (device.quarantine = [hash("c")])],
  ["await-forward-version", ({ device }) => (device.installedVersionCode = 3)],
  [
    "bridge-release-required",
    ({ device }) => (device.installedSha256 = hash("f")),
  ],
  ["signer-mismatch", ({ device }) => (device.signerSha256 = hash("e"))],
  ["unqualified-device", ({ device }) => (device.sdk = 36)],
  ["unqualified-device", ({ device }) => (device.abi = "x86_64")],
  ["unqualified-device", ({ device }) => (device.model = "Unknown tablet")],
  [
    "unqualified-device",
    ({ device }) => (device.buildFingerprint = "new/untested/image"),
  ],
  ["installer-authority", ({ device }) => (device.installerCapabilities = [])],
  ["protocol-incompatible", ({ device }) => (device.agentProtocol = 2)],
  ["protocol-incompatible", ({ device }) => (device.browserProtocol = 2)],
  [
    "protocol-incompatible",
    ({ release }) => (release.recovery.compatibility.minimumSupervisor = 2),
  ],
  ["data-incompatible", ({ device }) => (device.databaseSchema = 3)],
  ["disk-reserve", ({ device }) => (device.freeBytes = 0)],
  ["unsupported-safety-profile", ({ device }) => (device.healthProfiles = [])],
  [
    "unsupported-safety-profile",
    ({ device }) => (device.activationProfiles = []),
  ],
  ["outside-cohort", ({ release }) => (release.rollout.threshold = 0)],
];

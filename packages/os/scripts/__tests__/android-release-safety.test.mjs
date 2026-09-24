import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  assertExecutionOptions,
  checkedRun,
  compilePlan,
  deviceReader,
  executePlan,
  parseGetvar,
  parseOptions,
  pinnedToolRunner,
} from "../android/install-release.mjs";
import { readHealthToken, verifyPostBoot } from "../android/post-boot.mjs";
import { generateUpdateManifest } from "../android/publish-update-manifest.mjs";
import {
  CVD_CHECKS,
  canonical,
  hashFile,
  loadPolicy,
  PHONE_CHECKS,
  parseAndroidInfo,
  sha256,
  validateEnvelope,
  verifyInstallFiles,
} from "../android/release-contract.mjs";

const h = "a".repeat(64),
  commit = "b".repeat(40),
  now = Date.parse("2026-09-22T00:00:00Z");
const plan = `version 1
flash boot
flash init_boot
flash dtbo
flash vendor_kernel_boot
flash pvmfw
flash vendor_boot
flash --apply-vbmeta vbmeta
reboot fastboot
update-super
flash system
flash system_dlkm
flash system_ext
flash product
flash vendor
flash vendor_dlkm
flash --slot-other system system_other.img
if-wipe erase userdata
if-wipe erase metadata
`;
const androidInfo =
  "require board=grizzly\nrequire version-bootloader=bl1\nrequire version-baseband=radio1\nrequire partition-exists=vendor_kernel_boot\n";
function fixture(t, physical = true) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "android-contract-test-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const files = [
    ...new Set(
      [...plan.matchAll(/^flash (?:--\S+ )?(\S+)(?: (\S+))?$/gm)].map(
        (m) => m[2] ?? `${m[1]}.img`,
      ),
    ),
    "super_empty.img",
    "android-info.txt",
    "fastboot-info.txt",
  ];
  const file = (filename, bytes) => {
    fs.writeFileSync(path.join(directory, filename), bytes);
    return { filename, ...hashFile(path.join(directory, filename)) };
  };
  const artifacts = files.map((n) =>
    file(
      n,
      n === "android-info.txt"
        ? androidInfo
        : n === "fastboot-info.txt"
          ? plan
          : `fixture-${n}`,
    ),
  );
  const release = {
    releaseId: "release1",
    version: "1.0.0",
    tag: "v1.0.0",
    channel: "canary",
    operation: "os-install",
    artifactType: "factory",
    target: {
      id: "pixel11pro-grizzly",
      codename: "grizzly",
      kind: "physical",
      architecture: "arm64",
      pageSize: 4096,
      skus: ["G7SWN"],
      storageBytes: ["137438953472"],
    },
    buildFingerprint:
      "elizaOS/eliza_grizzly_phone/grizzly:17/id/1:user/release-keys",
    buildType: "user",
    diagnostics: {
      initProbes: false,
      keymasterNonblocking: false,
      graphicsOverride: false,
      fstabOverride: false,
      sepolicyVersionRewrite: false,
    },
    sources: {
      osCommit: commit,
      elizaCommit: commit,
      aospCommit: commit,
      sourceLockSha256: h,
      vendorSha256: h,
      kernelSha256: h,
      applicationSha256: h,
      bundleSha256: h,
    },
    archiveRoot: "flash/",
    archive: file("elizaos-fixture-android-grizzly.zip", "archive fixture"),
    files: artifacts,
    validation: { bootTimeoutSeconds: 300, flashTimeoutSeconds: 600 },
    avb: {
      publicKeySha256: h,
      algorithm: "SHA256_RSA4096",
      productionKeys: true,
      rollbackIndexes: [{ location: 0, value: "1" }],
    },
    strategy: "grizzly-fastboot-info",
    planSha256: artifacts.find((f) => f.filename === "fastboot-info.txt")
      .sha256,
    geometry: {
      superBytes: 10737418240,
      dynamicGroupBytes: 10733223936,
      partitionSizes: { super: "0x280000000", vendor_kernel_boot: "0x1000000" },
    },
    tools: {
      adb: { sha256: h, version: "35.0.2" },
      fastboot: { sha256: h, version: "35.0.2" },
    },
    minimumBatteryPercent: 40,
    startingStates: [
      {
        id: "stock1",
        bootloader: "bl1",
        baseband: "radio1",
        currentSlot: "a",
        targetSlot: "b",
        wipeRequired: false,
        rollback: { method: "qualified-firmware-state", evidenceSha256: h },
        recovery: {
          method: "oem-documented",
          instructionsUrl: "https://developers.google.com/android/images",
          evidenceSha256: h,
          archiveRoot: "flash/",
          archive: file("stock.zip", "stock fixture"),
        },
        getvars: {
          "slot-successful:a": "yes",
          "slot-successful:b": "yes",
          "slot-unbootable:a": "no",
          "slot-unbootable:b": "no",
        },
      },
    ],
  };
  // Recovery is retained separately in production. Keep the publication fixture
  // directory free of this non-release ZIP.
  fs.renameSync(
    path.join(directory, "stock.zip"),
    path.join(directory, "stock.fixture"),
  );
  if (!physical) {
    release.target = {
      id: "cuttlefish-x86_64",
      codename: "vsoc_x86_64",
      kind: "virtual",
      architecture: "x86_64",
      pageSize: 4096,
    };
    release.strategy = "virtual";
    release.buildType = "userdebug";
  }
  const zipped = spawnSync(
    "python3",
    [
      "-c",
      "import json,sys,zipfile,os; d=json.load(sys.stdin); z=zipfile.ZipFile(os.path.join(d['dir'],d['archive']),'w'); [z.write(os.path.join(d['dir'],f),'flash/'+f) for f in d['files']]; z.close()",
    ],
    {
      input: JSON.stringify({
        dir: directory,
        archive: release.archive.filename,
        files: artifacts.map((f) => f.filename),
      }),
      encoding: "utf8",
    },
  );
  assert.equal(zipped.status, 0, zipped.stderr);
  Object.assign(
    release.archive,
    hashFile(path.join(directory, release.archive.filename)),
  );
  const envelope = {
    schemaVersion: 2,
    release,
    qualification: {
      subjectSha256: sha256(canonical(release)),
      status: "pass",
      evidenceSha256: h,
      issuedAt: "2026-09-21T00:00:00Z",
      expiresAt: "2026-10-21T00:00:00Z",
      cases: [
        {
          sku: physical ? "G7SWN" : "virtual",
          startingStateId: physical ? "stock1" : "virtual",
          storageBytes: physical ? "137438953472" : "virtual",
          evidenceSha256: h,
          checks: Object.fromEntries(
            (physical ? PHONE_CHECKS : CVD_CHECKS).map((k) => [k, "pass"]),
          ),
        },
      ],
    },
    signatures: [],
  };
  const pairs = ["release", "qualification"].map((role) => ({
    role,
    ...generateKeyPairSync("ed25519"),
  }));
  const trust = {
    schemaVersion: 1,
    keys: pairs.map((p) => ({
      id: p.role,
      roles: [p.role],
      channels: ["canary"],
      operations: ["os-install"],
      expiresAt: "2026-12-01T00:00:00Z",
      publicKey: p.publicKey.export({ type: "spki", format: "pem" }),
    })),
    revokedReleaseDigests: [],
    revokedKeyIds: [],
  };
  const revoker = generateKeyPairSync("ed25519");
  trust.keys.push({
    id: "revocation",
    roles: ["revocation"],
    expiresAt: "2026-12-01T00:00:00Z",
    publicKey: revoker.publicKey.export({ type: "spki", format: "pem" }),
  });
  const bulletin = {
    schemaVersion: 1,
    sequence: 1,
    issuedAt: "2026-09-21T00:00:00Z",
    expiresAt: "2026-10-21T00:00:00Z",
    revokedReleaseDigests: [],
    revokedKeyIds: [],
    keyId: "revocation",
  };
  bulletin.signature = sign(
    null,
    Buffer.from(
      JSON.stringify([1, 1, bulletin.issuedAt, bulletin.expiresAt, [], []]),
    ),
    revoker.privateKey,
  ).toString("base64");
  trust.minimumRevocationSequence = 1;
  trust.revocationBulletin = bulletin;
  const policy = {
    trust,
    inventory: {
      targets: [
        {
          targetId: "pixel11pro-grizzly",
          codenames: ["grizzly"],
          installerEligible: true,
          expectedFingerprintPrefix: "elizaOS/eliza_grizzly_phone/grizzly:",
        },
      ],
    },
    now,
  };
  const resign = () => {
    envelope.qualification.subjectSha256 = sha256(canonical(release));
    envelope.signatures = pairs.map((p) => ({
      role: p.role,
      keyId: p.role,
      signature: sign(
        null,
        Buffer.from(
          canonical({
            schemaVersion: 2,
            release,
            qualification: envelope.qualification,
          }),
        ),
        p.privateKey,
      ).toString("base64"),
    }));
  };
  resign();
  return { directory, release, envelope, policy, resign, pairs };
}

test("qualified release requires independent trusted signatures and exact subject", (t) => {
  const f = fixture(t);
  assert.equal(
    validateEnvelope(f.envelope, f.policy).release.target.codename,
    "grizzly",
  );
  for (const change of [
    (e) => e.signatures.pop(),
    (e) => (e.release.version = "other"),
    (e) => (e.qualification.evidenceSha256 = "0".repeat(64)),
    (e) => (e.qualification.expiresAt = "2020-01-01"),
    (e) => delete e.qualification.cases[0].checks.recovery,
  ]) {
    const e = structuredClone(f.envelope);
    change(e);
    assert.throws(() => validateEnvelope(e, f.policy));
  }
  assert.throws(
    () => validateEnvelope(f.envelope, loadPolicy()),
    /installer-ineligible/,
  );
  const p = structuredClone(f.policy);
  p.trust.revokedReleaseDigests.push(f.envelope.qualification.subjectSha256);
  assert.throws(() => validateEnvelope(f.envelope, p), /revoked/);
  p.trust.revokedReleaseDigests = [];
  p.trust.revokedKeyIds = ["qualification"];
  assert.throws(() => validateEnvelope(f.envelope, p), /signature/);
});

test("all SKU/firmware combinations need evidence, no diagnostics or test-key release", (t) => {
  const f = fixture(t);
  for (const change of [
    (r) => r.target.skus.push("GM45K"),
    (r) => (r.buildType = "userdebug"),
    (r) => (r.diagnostics.keymasterNonblocking = true),
    (r) => (r.startingStates[0].rollback = null),
    (r) => (r.geometry.superBytes = 0),
    (r) => (r.target.id = "pixel-arm64"),
    (r) => r.files.push(r.files[0]),
    (r) => (r.files[0].filename = "../boot.img"),
  ]) {
    const e = structuredClone(f.envelope);
    change(e.release);
    assert.throws(() => validateEnvelope(e, f.policy));
  }
});

test("signed metadata and firmware requirements cannot be bypassed", (t) => {
  const f = fixture(t);
  verifyInstallFiles(f.release, f.directory);
  for (const text of [
    "require board=grizzly\n",
    `${androidInfo}require unknown=foo\n`,
    `${androidInfo}require board=other\n`,
  ])
    assert.throws(() => parseAndroidInfo(text));
  fs.writeFileSync(path.join(f.directory, "super.img"), "extra");
  assert.throws(() => verifyInstallFiles(f.release, f.directory), /undeclared/);
  fs.unlinkSync(path.join(f.directory, "super.img"));
  fs.appendFileSync(path.join(f.directory, "boot.img"), "corruption");
  assert.throws(() => verifyInstallFiles(f.release, f.directory), /integrity/);
});

test("signed physical qualification cannot omit recovery and kernel pairing evidence", (t) => {
  for (const check of [
    "encrypted-recovery",
    "recovery-after-ota-slot",
    "kernel-vendor-module-pair",
  ]) {
    for (const result of [undefined, "fail", "skipped"]) {
      const f = fixture(t);
      if (result === undefined)
        delete f.envelope.qualification.cases[0].checks[check];
      else f.envelope.qualification.cases[0].checks[check] = result;
      f.resign();
      assert.throws(
        () => validateEnvelope(f.envelope, f.policy),
        /qualification incomplete/,
      );
    }
  }
});

test("publication rejects unsigned, revoked, ineligible, mislabeled and orphan archives", (t) => {
  const f = fixture(t, false);
  const args = {
    directory: f.directory,
    version: "1.0.0",
    channel: "canary",
    tag: "v1.0.0",
    repository: "elizaOS/os",
    policy: f.policy,
  };
  assert.throws(() => generateUpdateManifest(args), /no signed/);
  fs.writeFileSync(
    path.join(f.directory, "release.android-release.json"),
    JSON.stringify(f.envelope),
  );
  assert.equal(
    generateUpdateManifest(args).artifacts[0].target,
    "cuttlefish-x86_64",
  );
  assert.throws(
    () => generateUpdateManifest({ ...args, channel: "stable" }),
    /mismatch/,
  );
  fs.writeFileSync(path.join(f.directory, "orphan.zip"), "bad");
  assert.throws(() => generateUpdateManifest(args), /without authenticated/);
  fs.unlinkSync(path.join(f.directory, "orphan.zip"));
  f.envelope.signatures = [];
  fs.writeFileSync(
    path.join(f.directory, "release.android-release.json"),
    JSON.stringify(f.envelope),
  );
  assert.throws(() => generateUpdateManifest(args), /signature/);
});

function fakeReader(release, overrides = {}) {
  const vars = {
    product: "grizzly",
    unlocked: "yes",
    "is-userspace": "no",
    "snapshot-update-status": "none",
    sku: "G7SWN",
    "battery-level": "80",
    "partition-size:userdata": "0x2000000000",
    "version-bootloader": "bl1",
    "version-baseband": "radio1",
    "current-slot": "a",
    "partition-size:super": "0x280000000",
    "partition-size:vendor_kernel_boot": "0x1000000",
    ...release.startingStates[0].getvars,
    ...overrides,
  };
  const calls = [];
  const run = (_cmd, args) => {
    calls.push(args);
    if (args[0] === "devices") return "SERIAL\tfastboot\n";
    const key = args.at(-1);
    require(key in vars);
    return `(bootloader) ${key}: ${vars[key]}\n`;
  };
  function require(ok) {
    if (!ok) throw new Error("missing variable");
  }
  return { reader: deviceReader({ fastboot: "fake" }, "SERIAL", run), calls };
}
test("device preflight fails closed on mode, SKU, battery, firmware, slot, geometry and snapshots", (t) => {
  const f = fixture(t);
  assert.equal(fakeReader(f.release).reader.inspect(f.release).id, "stock1");
  for (const override of [
    { product: "other" },
    { unlocked: "no" },
    { "is-userspace": "yes" },
    { "snapshot-update-status": "merging" },
    { sku: "unknown" },
    { "battery-level": "unknown" },
    { "battery-level": "10" },
    { "version-bootloader": "newer" },
    { "current-slot": "unknown" },
    { "slot-unbootable:a": "yes" },
    { "partition-size:super": "0x0" },
    { "partition-size:userdata": "0x1" },
  ])
    assert.throws(() =>
      fakeReader(f.release, override).reader.inspect(f.release),
    );
  assert.throws(
    () => parseGetvar("unlocked: yes\nunlocked: no", "unlocked"),
    /ambiguous/,
  );
  assert.throws(
    () => parseGetvar("FAILED unknown variable", "unlocked"),
    /missing/,
  );
});

test("plan follows generated layout, binds slots, forbids unqualified wipes and never relocks", (t) => {
  const { release } = fixture(t);
  const state = release.startingStates[0];
  const tasks = compilePlan(release, plan, state);
  assert.equal(tasks[0].args.join(" "), "--slot b flash boot boot.img");
  assert(
    tasks.some(
      (p) => p.args.join(" ") === "--slot a flash system system_other.img",
    ),
  );
  assert(
    tasks.findIndex((p) => p.args[0] === "update-super") <
      tasks.findIndex((p) => p.args.includes("system")),
  );
  assert(
    !tasks.some((p) => p.args.includes("erase") || p.args.includes("lock")),
  );
  assert.equal(tasks.at(-1).args[0], "--set-active=b");
  assert.throws(
    () => compilePlan(release, plan, state, { wipe: true }),
    /wipe choice/,
  );
  assert.throws(
    () => parseOptions(["--manifest", "a", "--artifact-dir", "b", "--force"]),
    /unsupported/,
  );
  assert.throws(
    () =>
      assertExecutionOptions(
        parseOptions([
          "--manifest",
          "a",
          "--artifact-dir",
          "b",
          "--execute",
          "--confirm-flash",
        ]),
      ),
    /requires/,
  );
});

test("failure at every flash-plan command stops subsequent writes, activation and reboot", (t) => {
  const f = fixture(t);
  const tool = path.join(f.directory, "fastboot");
  fs.writeFileSync(tool, "tool fixture");
  f.release.tools.fastboot.sha256 = hashFile(tool).sha256;
  const tasks = compilePlan(f.release, plan, f.release.startingStates[0], {
    reboot: true,
  });
  for (let failure = 0; failure < tasks.length; failure++) {
    const journalPath = path.join(f.directory, `journal-${failure}`);
    const journal = fs.openSync(journalPath, "wx");
    const calls = [];
    let activeSlot = "a";
    try {
      assert.throws(
        () =>
          executePlan({
            release: f.release,
            state: f.release.startingStates[0],
            plan: tasks,
            reader: {
              mode() {},
              get(key) {
                return {
                  "current-slot": activeSlot,
                  "version-bootloader": "bl1",
                  "version-baseband": "radio1",
                }[key];
              },
              fb(args) {
                calls.push(args);
                if (calls.length === failure + 1)
                  throw new Error("USB disconnected");
                if (args[0].startsWith("--set-active=")) activeSlot = "b";
                return "OKAY";
              },
            },
            stage: f.directory,
            journal,
            tools: { fastboot: tool },
            serial: "SERIAL",
          }),
        /USB disconnected/,
      );
    } finally {
      fs.closeSync(journal);
    }
    assert.equal(calls.length, failure + 1);
    const events = fs
      .readFileSync(journalPath, "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(events.at(-1).event, "failed");
    assert.equal(
      events.filter((e) => e.event === "command-complete").length,
      failure,
    );
    assert(!events.some((e) => e.event === "installed-runtime-verified"));
  }
});

test("firmware and slot drift after reconnect stop writes; ignored activation cannot succeed", (t) => {
  for (const fault of [
    "slot",
    "bootloader",
    "baseband",
    "missing-slot",
    "activation",
  ]) {
    const f = fixture(t);
    const tool = path.join(f.directory, "fastboot");
    fs.writeFileSync(tool, "tool fixture");
    f.release.tools.fastboot.sha256 = hashFile(tool).sha256;
    const journalPath = path.join(f.directory, "transition-journal");
    const journal = fs.openSync(journalPath, "wx");
    const vars = {
      "current-slot": "a",
      "version-bootloader": "bl1",
      "version-baseband": "radio1",
    };
    let mode = "bootloader";
    const calls = [];
    const reader = {
      get(key) {
        return vars[key];
      },
      mode(expected) {
        assert.equal(mode, expected);
      },
      fb(args) {
        calls.push(args);
        if (args[0] === "reboot" && args[1] === "fastboot") {
          mode = "fastbootd";
          if (fault === "slot") vars["current-slot"] = "b";
          if (fault === "missing-slot") delete vars["current-slot"];
          if (fault === "bootloader") vars["version-bootloader"] = "different";
          if (fault === "baseband") vars["version-baseband"] = "different";
        } else if (args[0] === "reboot" && args[1] === "bootloader")
          mode = "bootloader";
        // Simulate fastboot reporting OKAY without changing the active slot.
        return "OKAY";
      },
    };
    try {
      assert.throws(
        () =>
          executePlan({
            release: f.release,
            state: f.release.startingStates[0],
            plan: compilePlan(f.release, plan, f.release.startingStates[0], {
              reboot: true,
            }),
            reader,
            stage: f.directory,
            journal,
            tools: { fastboot: tool },
            serial: "SERIAL",
          }),
        /changed during installation/,
      );
    } finally {
      fs.closeSync(journal);
    }
    assert.deepEqual(
      calls.at(-1),
      fault === "activation" ? ["--set-active=b"] : ["reboot", "fastboot"],
    );
    const events = fs
      .readFileSync(journalPath, "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(events.at(-1).event, "failed");
    assert(
      !events.some(
        (e) =>
          e.event.startsWith("installed-") ||
          e.event === "active-slot-verified",
      ),
    );
  }
});

test("changed image/tool and wrong mode fail before any write", (t) => {
  for (const reason of ["image", "tool", "mode"]) {
    const f = fixture(t);
    const tool = path.join(f.directory, "fastboot");
    fs.writeFileSync(tool, "tool");
    f.release.tools.fastboot.sha256 = hashFile(tool).sha256;
    const journal = fs.openSync(path.join(f.directory, "journal"), "wx");
    t.after(() => fs.closeSync(journal));
    let writes = 0;
    if (reason === "image")
      fs.appendFileSync(path.join(f.directory, "boot.img"), "changed");
    if (reason === "tool") fs.appendFileSync(tool, "changed");
    const reader = {
      get(key) {
        return {
          "current-slot": "a",
          "version-bootloader": "bl1",
          "version-baseband": "radio1",
        }[key];
      },
      mode() {
        if (reason === "mode") throw new Error("wrong mode");
      },
      fb() {
        writes++;
      },
    };
    assert.throws(() =>
      executePlan({
        release: f.release,
        state: f.release.startingStates[0],
        plan: compilePlan(f.release, plan, f.release.startingStates[0]),
        reader,
        stage: f.directory,
        journal,
        tools: { fastboot: tool },
        serial: "SERIAL",
      }),
    );
    assert.equal(writes, 0);
  }
});

test("revocation freshness, sequence and signature are mandatory", (t) => {
  const f = fixture(t);
  for (const mutate of [
    (p) => (p.trust.revocationBulletin = null),
    (p) => (p.trust.minimumRevocationSequence = 2),
    (p) => (p.trust.revocationBulletin.expiresAt = "2020-01-01"),
    (p) => p.trust.revocationBulletin.revokedReleaseDigests.push(h),
  ]) {
    const p = structuredClone(f.policy);
    mutate(p);
    assert.throws(() => validateEnvelope(f.envelope, p), /revocation|bulletin/);
  }
});

test("two IDs for the same key cannot satisfy independent authorization", (t) => {
  const f = fixture(t);
  const pair = f.pairs[0];
  f.policy.trust.keys.find((k) => k.id === "qualification").publicKey =
    pair.publicKey.export({ type: "spki", format: "pem" });
  f.envelope.signatures[1].signature = sign(
    null,
    Buffer.from(
      canonical({
        schemaVersion: 2,
        release: f.release,
        qualification: f.envelope.qualification,
      }),
    ),
    pair.privateKey,
  ).toString("base64");
  assert.throws(
    () => validateEnvelope(f.envelope, f.policy),
    /independent qualification/,
  );
});

const healthy = () => ({ status: 200, body: JSON.stringify({ ready: true }) });

function bootShell(release, overrides = {}) {
  const values = {
    "getprop sys.boot_completed": "1",
    "getprop ro.product.device": "grizzly",
    "getprop ro.build.fingerprint": release.buildFingerprint,
    "getprop ro.boot.slot_suffix": "_b",
    getenforce: "Enforcing",
    "getconf PAGESIZE": "4096",
    "pm path ai.elizaos.app": "package:/system/priv-app/Eliza/Eliza.apk",
    "sha256sum /system/priv-app/Eliza/Eliza.apk": `${release.sources.applicationSha256}  /system/priv-app/Eliza/Eliza.apk`,
    "cmd role get-role-holders android.app.role.HOME": "ai.elizaos.app",
    "cmd role get-role-holders android.app.role.ASSISTANT": "ai.elizaos.app",
    "pidof ai.elizaos.app": "1234",
    ...overrides,
  };
  return (args) => values[args.join(" ")] ?? "";
}
test("post-boot checks reject fallback, stale APK, missing roles and false healthy HTTP 200", (t) => {
  const { release } = fixture(t);
  assert.equal(
    verifyPostBoot(release, bootShell(release), "b", "test-token", healthy)
      .status,
    "pass",
  );
  for (const override of [
    { "getprop ro.boot.slot_suffix": "_a" },
    { getenforce: "Permissive" },
    { "getprop ro.build.fingerprint": "stock" },
    { "sha256sum /system/priv-app/Eliza/Eliza.apk": "wrong" },
    { "getconf PAGESIZE": "16384" },
    { "cmd role get-role-holders android.app.role.ASSISTANT": "" },
    { health: { status: 200, body: '{"status":"unhealthy"}' } },
    { health: { status: 503, body: "{}" } },
  ])
    assert.throws(() =>
      verifyPostBoot(
        release,
        bootShell(release, override),
        "b",
        "test-token",
        () => override.health ?? healthy(),
      ),
    );
});

test("complete fake-transport installation verifies runtime and journals every transition", (t) => {
  const f = fixture(t);
  const tools = {};
  for (const name of ["adb", "fastboot"]) {
    tools[name] = path.join(f.directory, name);
    fs.writeFileSync(tools[name], name);
    f.release.tools[name].sha256 = hashFile(tools[name]).sha256;
  }
  let mode = "bootloader";
  let activeSlot = "a";
  const calls = [];
  const reader = {
    get(key) {
      return {
        "current-slot": activeSlot,
        "version-bootloader": "bl1",
        "version-baseband": "radio1",
      }[key];
    },
    mode(expected) {
      assert.equal(mode, expected);
    },
    fb(args) {
      calls.push(args);
      if (args[0].startsWith("--set-active=")) activeSlot = "b";
      if (args[0] === "reboot")
        mode =
          args[1] === "fastboot"
            ? "fastbootd"
            : args[1] === "bootloader"
              ? "bootloader"
              : "adb";
      return "OKAY";
    },
  };
  const journalFile = path.join(f.directory, "journal");
  const journal = fs.openSync(journalFile, "wx");
  t.after(() => fs.closeSync(journal));
  executePlan({
    release: f.release,
    state: f.release.startingStates[0],
    plan: compilePlan(f.release, plan, f.release.startingStates[0], {
      reboot: true,
    }),
    reader,
    stage: f.directory,
    journal,
    tools,
    serial: "SERIAL",
    healthToken: "test-token",
    requestHealth: healthy,
    run: (_tool, args) =>
      args[2] === "wait-for-device" ? "" : bootShell(f.release)(args.slice(3)),
  });
  const events = fs
    .readFileSync(journalFile, "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(events.at(-1).event, "installed-runtime-verified");
  assert.equal(
    events.filter((e) => e.event === "command-complete").length,
    calls.length,
  );
  assert(!calls.some((args) => args.includes("lock") || args.includes("oem")));
});

test("archive verification rejects a correctly signed ZIP containing different image bytes", (t) => {
  const f = fixture(t, false);
  fs.appendFileSync(path.join(f.directory, "boot.img"), "tampered");
  const zipped = spawnSync(
    "python3",
    [
      "-c",
      "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],'w'); z.write(sys.argv[2],'flash/boot.img'); z.close()",
      path.join(f.directory, f.release.archive.filename),
      path.join(f.directory, "boot.img"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(zipped.status, 0);
  Object.assign(
    f.release.archive,
    hashFile(path.join(f.directory, f.release.archive.filename)),
  );
  f.resign();
  fs.writeFileSync(
    path.join(f.directory, "test.android-release.json"),
    JSON.stringify(f.envelope),
  );
  assert.throws(
    () =>
      generateUpdateManifest({
        directory: f.directory,
        version: "1.0.0",
        channel: "canary",
        tag: "v1.0.0",
        repository: "elizaOS/os",
        policy: f.policy,
      }),
    /archive content verification failed/,
  );
});

test("scoped lab authorization never grants production installation or publication", (t) => {
  const f = fixture(t);
  f.release.operation = "lab-experiment";
  f.release.buildType = "userdebug";
  f.release.buildFingerprint = f.release.buildFingerprint.replace(
    ":user/release-keys",
    ":userdebug/test-keys",
  );
  f.release.avb.productionKeys = false;
  f.release.diagnostics.sepolicyVersionRewrite = true;
  f.envelope.qualification.status = "experiment-authorized";
  f.envelope.qualification.cases[0].checks = Object.fromEntries(
    [
      "stock-baseline",
      "recovery",
      "firmware-rollback-policy",
      "cuttlefish-boot",
      "artifact-validation",
    ].map((k) => [k, "pass"]),
  );
  f.resign();
  assert.throws(
    () => validateEnvelope(f.envelope, f.policy),
    /installer-ineligible/,
  );
  f.policy.inventory.targets[0].labExperimentsEligible = true;
  assert.throws(() => validateEnvelope(f.envelope, f.policy), /signature/);
  for (const k of f.policy.trust.keys.filter((k) => k.id !== "revocation"))
    k.operations.push("lab-experiment");
  validateEnvelope(f.envelope, f.policy);
  fs.writeFileSync(
    path.join(f.directory, "lab.android-release.json"),
    JSON.stringify(f.envelope),
  );
  assert.throws(
    () =>
      generateUpdateManifest({
        directory: f.directory,
        version: "1.0.0",
        channel: "canary",
        tag: "v1.0.0",
        repository: "elizaOS/os",
        policy: f.policy,
      }),
    /lab experiments cannot/,
  );
});

test("virtual builds can use development AVB keys while physical production cannot", (t) => {
  const f = fixture(t, false);
  f.release.avb.productionKeys = false;
  f.resign();
  validateEnvelope(f.envelope, f.policy);
  f.release.avb.algorithm = "NONE";
  f.resign();
  assert.throws(() => validateEnvelope(f.envelope, f.policy), /AVB/);
});

test("transport timeouts and unsuccessful exits are failures, never empty success", () => {
  assert.throws(
    () => checkedRun(process.execPath, ["-e", "process.exit(7)"]),
    /command failed/,
  );
  assert.throws(
    () =>
      checkedRun(process.execPath, ["-e", "setTimeout(()=>{},10000)"], {
        timeoutMs: 20,
      }),
    /command failed/,
  );
});

test("health credentials stay out of argv and errors; readiness must be explicit", (t) => {
  const { release, directory } = fixture(t);
  const file = path.join(directory, "health-token");
  fs.writeFileSync(file, "test-token\n", { mode: 0o600 });
  assert.equal(readHealthToken(file), "test-token");
  fs.chmodSync(file, 0o644);
  assert.throws(() => readHealthToken(file), /private regular/);
  assert.throws(
    () => verifyPostBoot(release, bootShell(release), "b"),
    /token required/,
  );
  const shell = bootShell(release);
  verifyPostBoot(
    release,
    (args) => {
      assert(!args.join(" ").includes("test-token"));

      return shell(args);
    },
    "b",
    "test-token",
    healthy,
  );
  for (const body of [
    { status: "ready" },
    { ready: false },
    { ready: "true" },
    {},
  ]) {
    assert.throws(
      () =>
        verifyPostBoot(release, bootShell(release), "b", "test-token", () => ({
          status: 200,
          body: JSON.stringify(body),
        })),
      /not ready/,
    );
  }
  assert.throws(
    () =>
      verifyPostBoot(release, shell, "b", "test-token", () => {
        throw new Error("test-token");
      }),
    /^Error: authenticated agent health transport failed$/,
  );
});

test("production CLI and shell entrypoint reject fixture authorization before invoking device tools", (t) => {
  const f = fixture(t);
  const manifest = path.join(f.directory, "signed-fixture.json");
  fs.writeFileSync(manifest, JSON.stringify(f.envelope));
  const tools = path.join(f.directory, "tools");
  fs.mkdirSync(tools);
  const invoked = path.join(f.directory, "device-tool-invoked");
  for (const name of ["adb", "fastboot"])
    fs.writeFileSync(
      path.join(tools, name),
      '#!/bin/sh\nprintf invoked > "$DEVICE_SPY"\nexit 99\n',
      { mode: 0o700 },
    );
  const args = [
    "--manifest",
    manifest,
    "--artifact-dir",
    f.directory,
    "--device",
    "SERIAL",
    "--tool-dir",
    tools,
    "--recovery-dir",
    f.directory,
    "--journal",
    path.join(f.directory, "journal"),
    "--execute",
    "--confirm-flash",
  ];
  for (const [command, entry] of [
    [process.execPath, "scripts/android/install-release.mjs"],
    ["bash", "android/installer/install-elizaos-android.sh"],
  ]) {
    const result = spawnSync(command, [entry, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${tools}:${process.env.PATH}`,
        DEVICE_SPY: invoked,
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /android-contract/);
    assert.equal(fs.existsSync(invoked), false);
  }
});

test("every signed artifact rejects corruption and absence before an install plan can execute", (t) => {
  const f = fixture(t);
  for (const file of f.release.files) {
    const pathname = path.join(f.directory, file.filename);
    const original = fs.readFileSync(pathname);
    fs.writeFileSync(pathname, Buffer.alloc(original.length, 0xff));
    assert.throws(() => verifyInstallFiles(f.release, f.directory));
    fs.unlinkSync(pathname);
    assert.throws(() => verifyInstallFiles(f.release, f.directory));
    fs.writeFileSync(pathname, original);
  }
  verifyInstallFiles(f.release, f.directory);
});

test("fastboot replacement is rejected before inventory, getvar and write dispatch", (t) => {
  for (const phase of ["inventory", "getvar", "write"]) {
    const f = fixture(t);
    const tool = path.join(f.directory, "fastboot");
    fs.writeFileSync(tool, "qualified executable");
    f.release.tools.fastboot.sha256 = hashFile(tool).sha256;
    const tools = { fastboot: tool };
    const calls = [];
    const reader = deviceReader(
      tools,
      "SERIAL",
      pinnedToolRunner(tools, f.release, (_command, args) => {
        calls.push(args);
        // Replacing the binary after inventory must prevent the next getvar.
        fs.writeFileSync(tool, "replacement executable");
        return "SERIAL\tfastboot\n";
      }),
    );
    if (phase !== "getvar") fs.writeFileSync(tool, "replacement executable");
    assert.throws(
      () =>
        phase === "write"
          ? reader.fb(["--slot", "b", "flash", "boot", "boot.img"])
          : reader.mode("bootloader", f.release),
      /fastboot changed/,
    );
    assert.equal(calls.length, phase === "getvar" ? 1 : 0);
  }
});

test("image and credential named pipes fail without waiting for a writer", {
  skip: process.platform !== "linux",
}, (t) => {
  const f = fixture(t);
  const pipe = path.join(f.directory, "pipe");
  const made = spawnSync("mkfifo", ["-m", "600", pipe]);
  assert.equal(made.status, 0);
  for (const [module, method] of [
    ["release-contract.mjs", "hashFile"],
    ["post-boot.mjs", "readHealthToken"],
  ]) {
    const url = new URL(`../android/${module}`, import.meta.url).href;
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { ${method} } from ${JSON.stringify(url)}; ${method}(process.argv[1]);`,
        pipe,
      ],
      { timeout: 2000, encoding: "utf8" },
    );
    assert.equal(
      result.error,
      undefined,
      "file validation must not hang on FIFO open",
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /regular/);
  }
});

test("slot drift during image hashing is detected before the first write", (t) => {
  const f = fixture(t);
  const tool = path.join(f.directory, "fastboot");
  fs.writeFileSync(tool, "tool");
  f.release.tools.fastboot.sha256 = hashFile(tool).sha256;
  const imageInode = fs.statSync(path.join(f.directory, "boot.img")).ino;
  let slot = "a";
  const originalRead = fs.readSync;
  t.mock.method(fs, "readSync", (fd, ...args) => {
    const count = originalRead.call(fs, fd, ...args);
    if (count === 0 && fs.fstatSync(fd).ino === imageInode) slot = "b";
    return count;
  });
  const journal = fs.openSync(
    path.join(f.directory, "hash-drift-journal"),
    "wx",
  );
  t.after(() => fs.closeSync(journal));
  let writes = 0;
  assert.throws(
    () =>
      executePlan({
        release: f.release,
        state: f.release.startingStates[0],
        plan: compilePlan(f.release, plan, f.release.startingStates[0]),
        reader: {
          mode() {},
          get(key) {
            return {
              "current-slot": slot,
              "version-bootloader": "bl1",
              "version-baseband": "radio1",
            }[key];
          },
          fb() {
            writes++;
          },
        },
        stage: f.directory,
        journal,
        tools: { fastboot: tool },
        serial: "SERIAL",
      }),
    /active slot changed/,
  );
  assert.equal(writes, 0);
});

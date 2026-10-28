// Release descriptors, update channels and distribution gates for both Pixel 10a
// brands. These check record consistency only: no gate, drill or signing runs here.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CHANNEL_DRILLS,
  channelDistributionProblems,
  channelSigningProblems,
  GATE_NAMES,
  pixel10aComposition,
  placeholderFields,
  qualificationGateProblems,
  releaseDescriptorProblems,
} from "../android/pixel10a-release.mjs";

const osRoot = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel) =>
  JSON.parse(fs.readFileSync(path.join(osRoot, rel), "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const LOCK = "android/sources/pixel10a-stallion.json";
const DESCRIPTOR = "android/aosp/pixel10a-product.json";
const SIGNER = "android/release-signer.json";
const CHANNEL = "android/aosp/pixel10a-ota-channel.json";
const GATES = "android/aosp/pixel10a-qualification-gates.json";
const SOURCE =
  "vendor/eliza/packages/os/android/sources/pixel10a-stallion.json";

/**
 * A downstream brand's repository: an application signer file, the shared lock at its
 * vendored path, a release descriptor for the shared alpha composition, a channel and
 * a gate record whose evidence files exist.
 */
function brandRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pixel10a-brand-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (rel, value) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(
      path.join(dir, rel),
      typeof value === "string" ? value : JSON.stringify(value, null, 2),
    );
  };
  const lockBytes = fs.readFileSync(path.join(osRoot, LOCK));
  write(SOURCE, lockBytes.toString("utf8"));
  write(SIGNER, { schema: 1, signerSha256: "d".repeat(64) });
  const descriptor = {
    schema: 1,
    product: "alpha_stallion_phone",
    target: "pixel10a",
    device: { codename: "stallion", androidRelease: "17" },
    lunch: {
      development: "alpha_stallion_phone-cp2a-userdebug",
      production: "alpha_stallion_phone-cp2a-user",
    },
    sourceLock: { file: SOURCE, sha256: sha256(lockBytes) },
    signer: {
      apkDescriptor: SIGNER,
      platformCertificateSha256: "c".repeat(64),
      releaseCertificates: { shared: "e".repeat(64) },
    },
    avb: {
      algorithm: "SHA256_RSA4096",
      vbmetaKey: "avb.pem",
      chainedPartitions: ["vbmeta_system", "vbmeta_vendor"],
      publicKeyMetadata: "avb_pkmd.bin",
      publicKeySha256: "a".repeat(64),
    },
    ota: { channel: CHANNEL },
    releaseQualified: false,
    deviceAcceptanceVerified: false,
  };
  write(DESCRIPTOR, descriptor);
  const lock = JSON.parse(lockBytes);
  write(CHANNEL, {
    schema: 1,
    channel: "stable",
    product: "alpha_stallion_phone",
    device: "stallion",
    authority: "Brand",
    releaseOwner: "Owner",
    otaCertificateSha256: "b".repeat(64),
    avbPublicKeySha256: "a".repeat(64),
    downgradeAllowed: false,
    recovery: {
      stockFactoryImage: {
        filename: lock.factory.filename,
        sha256: lock.factory.sha256,
      },
      knownGoodRelease: {
        buildFingerprint: "UNSET",
        otaSha256: "UNSET",
        recordFile: "UNSET",
      },
    },
    drills: Object.fromEntries(CHANNEL_DRILLS.map((name) => [name, "not run"])),
  });
  write("evidence/source.json", {
    sourceLockSha256: sha256(lockBytes),
    developmentOnly: false,
  });
  write("evidence/boot.json", { boot: "development" });
  write(GATES, {
    schema: 1,
    target: "pixel10a",
    product: "alpha_stallion_phone",
    gates: {
      sourceAdmission: {
        status: "passed",
        evidence: [{ ref: "evidence/source.json", level: "release" }],
      },
      apkVariants: {
        status: "passed",
        evidence: [{ ref: "https://example.invalid/run/1", level: "release" }],
      },
      cuttlefishBoot: {
        status: "development",
        evidence: [{ ref: "evidence/boot.json", level: "development" }],
      },
      physicalDevice: {
        status: "development",
        evidence: [{ ref: "evidence/boot.json", level: "development" }],
      },
      signedUpdateRecovery: { status: "not run", evidence: [] },
      userAcceptance: { status: "not run", evidence: [] },
    },
  });
  const readBack = (rel) =>
    JSON.parse(fs.readFileSync(path.join(dir, rel), "utf8"));
  return { dir, write, readBack };
}
const descriptorProblems = (root) =>
  releaseDescriptorProblems(root.readBack(DESCRIPTOR), {
    root: root.dir,
    file: DESCRIPTOR,
    sourceLockPath: SOURCE,
    applicationSignerFile: SIGNER,
  });
const gateProblems = (root) =>
  qualificationGateProblems(root.readBack(GATES), {
    root: root.dir,
    file: GATES,
    descriptor: root.readBack(DESCRIPTOR),
    descriptorFile: DESCRIPTOR,
  });

test("both brands' compositions are shared Pixel 10a targets on one source lock", () => {
  for (const brand of ["alpha", "eliza"]) {
    const product = read(`android/products/pixel10a-${brand}.json`);
    assert.deepEqual(pixel10aComposition(product.productName), product);
  }
  assert.equal(pixel10aComposition("aosp_stallion"), null);
  const inventory = read("android/hardware-targets.json").targets.find(
    (target) => target.targetId === "pixel10a-stallion",
  );
  assert.equal(
    inventory.productName,
    read("android/releases/pixel10a-eliza.json").product,
  );
  assert.equal(inventory.installerEligible, false);
  assert.ok(inventory.lunchTarget.startsWith(`${inventory.productName}-`));
  assert.equal(
    read("android/aosp.lock.json").profiles.pixel10a.sourceInventory.sha256,
    read("android/releases/pixel10a-eliza.json").sourceLock.sha256,
  );
});

test("a brand's complete release descriptor admits staging inputs; each gap is refused", (t) => {
  const root = brandRoot(t);
  assert.deepEqual(descriptorProblems(root), []);
  const refuse = (rel, change, pattern) => {
    const original = fs.readFileSync(path.join(root.dir, rel), "utf8");
    root.write(rel, change(JSON.parse(original)));
    const problems = descriptorProblems(root);
    assert.ok(
      problems.some((problem) => pattern.test(problem)),
      `${pattern}\n${problems.join("\n")}`,
    );
    fs.writeFileSync(path.join(root.dir, rel), original);
  };
  refuse(
    DESCRIPTOR,
    (p) => ({ ...p, releaseQualified: true }),
    /releaseQualified must stay false/,
  );
  refuse(
    DESCRIPTOR,
    (p) => ({ ...p, deviceAcceptanceVerified: true }),
    /deviceAcceptanceVerified must stay false/,
  );
  refuse(
    DESCRIPTOR,
    (p) => ({
      ...p,
      signer: { ...p.signer, platformCertificateSha256: "UNSET" },
    }),
    /platformCertificateSha256/,
  );
  refuse(
    DESCRIPTOR,
    (p) => ({ ...p, sourceLock: { ...p.sourceLock, sha256: "0".repeat(64) } }),
    /differs from the pinned sourceLock\.sha256/,
  );
  refuse(
    DESCRIPTOR,
    (p) => ({ ...p, sourceLock: { ...p.sourceLock, file: LOCK } }),
    /sourceLock\.file must be/,
  );
  refuse(
    DESCRIPTOR,
    (p) => ({ ...p, device: { codename: "frankel", androidRelease: "17" } }),
    /must be stallion on Android 17/,
  );
  refuse(
    DESCRIPTOR,
    (p) => ({
      ...p,
      lunch: { ...p.lunch, production: "alpha_stallion_phone-cp2a-userdebug" },
    }),
    /user build alpha_stallion_phone-cp2a-user/,
  );
  refuse(
    DESCRIPTOR,
    (p) => ({ ...p, product: "alpha_grizzly_phone" }),
    /not a shared Pixel 10a composition/,
  );
  refuse(
    DESCRIPTOR,
    (p) => ({ ...p, signer: { ...p.signer, apkDescriptor: "other.json" } }),
    /signer\.apkDescriptor must be android\/release-signer\.json/,
  );
  refuse(
    DESCRIPTOR,
    (p) => ({ ...p, ota: { channel: "../channel.json" } }),
    /ota\.channel must name/,
  );
  refuse(
    SIGNER,
    (s) => ({ ...s, signerSha256: "unset" }),
    /signerSha256 is "unset"/,
  );
  refuse(
    SOURCE,
    (l) => ({ ...l, developmentOnly: true }),
    /still marked developmentOnly|differs from the pinned/,
  );
  refuse(
    SOURCE,
    (l) => ({ ...l, device: { ...l.device, codename: "frankel" } }),
    /not the Pixel 10a Android 17 source contract|differs from the pinned/,
  );
  // A brand's binding names its own product; another brand's composition is refused.
  const bound = (productName) =>
    releaseDescriptorProblems(root.readBack(DESCRIPTOR), {
      root: root.dir,
      file: DESCRIPTOR,
      sourceLockPath: SOURCE,
      applicationSignerFile: SIGNER,
      productName,
    });
  assert.deepEqual(bound("alpha_stallion_phone"), []);
  assert.ok(
    bound("eliza_stallion_phone").some((problem) =>
      /product must be eliza_stallion_phone, this brand's Pixel 10a composition/.test(
        problem,
      ),
    ),
  );
  // Without an application signer file the descriptor carries the certificate itself.
  const eliza = read("android/releases/pixel10a-eliza.json");
  assert.ok(
    releaseDescriptorProblems(eliza, {
      root: osRoot,
      file: "eliza",
      sourceLockPath: LOCK,
    }).some((problem) =>
      /applicationCertificateSha256 must be the reviewed/.test(problem),
    ),
  );
  assert.deepEqual(
    placeholderFields({ description: "UNSET", a: { b: ["tbd", "ok"] } }),
    ["a.b[0]"],
  );
});

test("the channel binds the product, its AVB key and the locked stock archive", (t) => {
  const root = brandRoot(t);
  const descriptor = root.readBack(DESCRIPTOR),
    channel = root.readBack(CHANNEL),
    lock = root.readBack(SOURCE);
  assert.deepEqual(
    channelSigningProblems(channel, descriptor, CHANNEL, lock),
    [],
  );
  const problems = (change) =>
    channelSigningProblems(
      { ...channel, ...change },
      descriptor,
      CHANNEL,
      lock,
    ).join("\n");
  assert.match(
    problems({ product: "eliza_stallion_phone" }),
    /channel is not for alpha_stallion_phone/,
  );
  assert.match(
    problems({ avbPublicKeySha256: "f".repeat(64) }),
    /not the product's avb\.publicKeySha256/,
  );
  assert.match(
    problems({ downgradeAllowed: true }),
    /downgradeAllowed must be false/,
  );
  assert.match(
    problems({ channel: "Stable Channel" }),
    /channel must name the update channel/,
  );
  assert.match(
    problems({
      recovery: {
        ...channel.recovery,
        stockFactoryImage: { filename: "x.zip", sha256: "1".repeat(64) },
      },
    }),
    /not the locked factory archive/,
  );
  assert.match(
    channelSigningProblems(null, descriptor).join("\n"),
    /missing or unreadable/,
  );
});

test("distribution requires every recovery identity and every update/recovery drill", () => {
  const complete = {
    recovery: {
      knownGoodRelease: {
        buildFingerprint: "Brand/product/stallion:17/X/1:user/release-keys",
        otaSha256: "a".repeat(64),
        recordFile: "releases/1/release-record.json",
      },
    },
    drills: Object.fromEntries(CHANNEL_DRILLS.map((name) => [name, "passed"])),
  };
  assert.deepEqual(channelDistributionProblems(complete), []);
  const additional = structuredClone(complete);
  additional.drills.additionalRecovery = "failed";
  assert.ok(
    channelDistributionProblems(additional).some((problem) =>
      /additionalRecovery drill/.test(problem),
    ),
  );
  for (const field of Object.keys(complete.recovery.knownGoodRelease))
    for (const value of [undefined, null, "", "  ", "UNSET", 42, {}]) {
      const candidate = structuredClone(complete);
      if (value === undefined)
        delete candidate.recovery.knownGoodRelease[field];
      else candidate.recovery.knownGoodRelease[field] = value;
      assert.ok(
        channelDistributionProblems(candidate).some((problem) =>
          problem.includes(`knownGoodRelease.${field}`),
        ),
        field,
      );
    }
  const malformed = structuredClone(complete);
  malformed.recovery.knownGoodRelease.otaSha256 = "not-a-hash";
  assert.ok(
    channelDistributionProblems(malformed).some((problem) =>
      /must be a SHA-256/.test(problem),
    ),
  );
  for (const drill of CHANNEL_DRILLS) {
    const candidate = structuredClone(complete);
    delete candidate.drills[drill];
    assert.ok(
      channelDistributionProblems(candidate).some((problem) =>
        problem.includes(`${drill} drill`),
      ),
      drill,
    );
  }
  for (const candidate of [null, {}, { recovery: {} }])
    assert.ok(channelDistributionProblems(candidate).length >= 7);
});

test("qualification gates stay distinct, need their own release evidence and mirror the channel", (t) => {
  const root = brandRoot(t);
  assert.deepEqual(gateProblems(root), []);
  const gate = (name, change) => {
    const record = root.readBack(GATES);
    root.write(GATES, {
      ...record,
      gates: { ...record.gates, [name]: change(record.gates[name]) },
    });
  };
  const check = (setup, pattern) => {
    const original = fs.readFileSync(path.join(root.dir, GATES), "utf8");
    setup();
    assert.match(gateProblems(root).join("\n"), pattern);
    fs.writeFileSync(path.join(root.dir, GATES), original);
  };
  check(
    () => gate("physicalDevice", (g) => ({ ...g, status: "passed" })),
    /physicalDevice cannot pass on development evidence/,
  );
  check(
    () => gate("cuttlefishBoot", (g) => ({ ...g, evidence: [] })),
    /cuttlefishBoot is "development" without evidence/,
  );
  check(
    () =>
      gate("cuttlefishBoot", (g) => ({
        ...g,
        evidence: [{ ref: "evidence/absent.json", level: "development" }],
      })),
    /evidence evidence\/absent\.json is missing/,
  );
  check(
    () =>
      gate("cuttlefishBoot", (g) => ({
        ...g,
        evidence: [{ ref: "../outside.json", level: "development" }],
      })),
    /evidence \.\.\/outside\.json is missing/,
  );
  check(
    () => gate("userAcceptance", (g) => ({ ...g, status: "accepted" })),
    /status must be one of/,
  );
  check(() => {
    const record = root.readBack(GATES);
    const { cuttlefishBoot: _dropped, ...rest } = record.gates;
    root.write(GATES, { ...record, gates: rest });
  }, /gates must be exactly/);
  check(
    () =>
      gate("userAcceptance", (g) => ({
        ...g,
        status: "passed",
        evidence: [{ ref: "evidence/boot.json", level: "release" }],
      })),
    /userAcceptance cannot pass before every other gate/,
  );
  check(
    () =>
      gate("signedUpdateRecovery", (g) => ({
        ...g,
        status: "passed",
        evidence: [{ ref: CHANNEL, level: "release" }],
      })),
    /signedUpdateRecovery passed while .*signedUpdate drill is "not run"/,
  );
  check(
    () =>
      root.write("evidence/source.json", {
        sourceLockSha256: "0".repeat(64),
        developmentOnly: false,
      }),
    /evidence does not verify the pinned admitted lock/,
  );
  check(
    () =>
      root.write(GATES, {
        ...root.readBack(GATES),
        product: "eliza_stallion_phone",
      }),
    /must be schema 1 for alpha_stallion_phone/,
  );
  assert.deepEqual(Object.keys(root.readBack(GATES).gates), GATE_NAMES);
});

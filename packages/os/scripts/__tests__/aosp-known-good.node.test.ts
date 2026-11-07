// Known-good retention for operator recovery, on synthetic records and zip fixtures. This
// establishes refusals, hashing and the plan a stock-archive run reads; it is not a
// recovery drill, a flash or an image boot.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  KNOWN_GOOD_KIND,
  knownGoodProblems,
  knownGoodRecoveryPlan,
  main,
  parseArgs,
  retainKnownGood,
  stockRecoveryPlan,
} from "../android/aosp-ota-update.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const OTA_CERT = "b".repeat(64);
const AVB_KEY = "a".repeat(64);
const FP =
  "elizaOS/eliza_stallion_phone/stallion:17/CP2A.261005.001/1:user/release-keys";
const CHANNEL = Object.freeze({
  schema: 1,
  channel: "stable",
  product: "eliza_stallion_phone",
  device: "stallion",
  otaCertificateSha256: OTA_CERT,
  avbPublicKeySha256: AVB_KEY,
  downgradeAllowed: false,
  recovery: {
    stockFactoryImage: { filename: "stock.zip", sha256: "0".repeat(64) },
  },
});

function temporary(t) {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "known-good-")),
  );
  t.after(() => {
    execFileSync("chmod", ["-R", "u+w", dir]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function zip(dir, name, files) {
  const staging = path.join(dir, `.${name}-content`);
  fs.mkdirSync(staging);
  for (const [file, bytes] of Object.entries(files))
    fs.writeFileSync(path.join(staging, file), bytes);
  execFileSync(
    "zip",
    ["-q", "-X", path.join(dir, name), ...Object.keys(files)],
    { cwd: staging },
  );
  fs.rmSync(staging, { recursive: true });
  return path.join(dir, name);
}

function fixture(t, overrides = {}) {
  const dir = temporary(t);
  const vbmeta = Buffer.from("signed vbmeta");
  const targetFiles = zip(dir, "signed-target_files.zip", {
    "META-misc_info.txt": "x",
  });
  const image = zip(dir, "stallion-img.zip", {
    "vbmeta.img": vbmeta,
    "boot.img": "boot",
  });
  const tfBytes = fs.readFileSync(targetFiles);
  const record = {
    schema: 1,
    kind: "aosp-release-compatibility",
    product: "eliza_stallion_phone",
    device: "stallion",
    channel: "stable",
    build: {
      fingerprint: FP,
      securityPatch: "2026-10-05",
      dateUtc: "1790000000",
    },
    artifacts: {
      signedTargetFiles: {
        file: "signed-target_files.zip",
        sha256: sha256(tfBytes),
        sizeBytes: tfBytes.length,
      },
      ota: { file: "ota.zip", sha256: "d".repeat(64), type: "full" },
    },
    verifiedBoot: {
      publicKeySha256: AVB_KEY,
      images: { vbmeta: sha256(vbmeta) },
      rollbackIndexes: [{ partition: "vbmeta", location: 0, index: "1" }],
    },
    certificates: { releasekey: OTA_CERT, platform: "c".repeat(64) },
    problems: [],
    imageBooted: false,
    signedUpdateApplied: false,
    releaseQualified: false,
    deviceAcceptanceVerified: false,
    ...overrides,
  };
  const recordFile = path.join(dir, "release-record.json");
  fs.writeFileSync(recordFile, JSON.stringify(record));
  return { dir, targetFiles, image, record, recordFile };
}

const retain = (f, extra = {}) =>
  retainKnownGood({
    channel: CHANNEL,
    recordFile: f.recordFile,
    signedTargetFiles: f.targetFiles,
    signedImage: f.image,
    archiveDir: path.join(f.dir, "retained"),
    createdAt: "2026-10-28T00:00:00.000Z",
    ...extra,
  });

test("a verified signed release is archived with its hashes", (t) => {
  const f = fixture(t);
  const result = retain(f);
  assert.deepEqual(result.problems, []);
  assert.equal(result.retained, true);
  assert.equal(result.executed, false);
  const retained = path.join(f.dir, "retained");
  assert.deepEqual(fs.readdirSync(retained).sort(), [
    "known-good.json",
    "release-record.json",
    "signed-target_files.zip",
    "stallion-img.zip",
  ]);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(retained, "known-good.json"), "utf8"),
  );
  assert.equal(manifest.kind, KNOWN_GOOD_KIND);
  assert.equal(manifest.fingerprint, FP);
  assert.equal(manifest.signedImage.sha256, sha256(fs.readFileSync(f.image)));
  assert.equal(
    manifest.signedTargetFiles.sha256,
    f.record.artifacts.signedTargetFiles.sha256,
  );
  assert.equal(manifest.recoveryDrilled, false);
  // The directory is never reused.
  assert.match(retain(f).problems.join(), /already exists/);
  const plan = knownGoodRecoveryPlan({ channel: CHANNEL, directory: retained });
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(
    plan.steps.map((step) => step.slice(3).join(" ")),
    ["reboot bootloader", "flashing unlock", "-w update stallion-img.zip"],
  );
  assert.match(plan.notes.join("\n"), /erase all user data/);
  assert.equal(plan.executed, false);
  // The retention directory itself is read-only.
  assert.equal(fs.statSync(retained).mode & 0o222, 0);
  // An edited known-good.json naming other bytes is refused: the image is re-bound to the
  // record's vbmeta, not only to the manifest's own hashes.
  const forged = path.join(f.dir, "forged");
  fs.cpSync(retained, forged, { recursive: true });
  execFileSync("chmod", ["-R", "u+w", forged]);
  const other = zip(f.dir, "other-img.zip", {
    "vbmeta.img": "unsigned vbmeta",
    "boot.img": "boot",
  });
  fs.rmSync(path.join(forged, "stallion-img.zip"));
  fs.copyFileSync(other, path.join(forged, "stallion-img.zip"));
  const forgedManifest = JSON.parse(
    fs.readFileSync(path.join(forged, "known-good.json"), "utf8"),
  );
  forgedManifest.signedImage = {
    ...forgedManifest.signedImage,
    sha256: sha256(fs.readFileSync(other)),
    sizeBytes: fs.statSync(other).size,
  };
  fs.writeFileSync(
    path.join(forged, "known-good.json"),
    JSON.stringify(forgedManifest),
  );
  const forgedPlan = knownGoodRecoveryPlan({
    channel: CHANNEL,
    directory: forged,
  });
  assert.match(forgedPlan.problems.join(), /vbmeta\.img is not the record's/);
  assert.deepEqual(forgedPlan.steps, []);
  // Tampering with a retained file after retention removes the plan.
  fs.chmodSync(path.join(retained, "stallion-img.zip"), 0o644);
  fs.appendFileSync(path.join(retained, "stallion-img.zip"), "x");
  const tampered = knownGoodRecoveryPlan({
    channel: CHANNEL,
    directory: retained,
  });
  assert.match(tampered.problems.join(), /signedImage changed/);
  assert.deepEqual(tampered.steps, []);
  assert.match(
    knownGoodRecoveryPlan({
      channel: { ...CHANNEL, channel: "beta" },
      directory: retained,
    }).problems.join(),
    /not this channel's/,
  );
});

test("placeholders, unsigned builds and mismatched inputs are refused before anything is written", (t) => {
  const refused = (f, pattern, extra) => {
    const result = retain(f, extra);
    assert.equal(result.retained, false);
    assert.match(result.problems.join("\n"), pattern);
    assert.equal(fs.existsSync(path.join(f.dir, "retained")), false);
  };
  refused(
    fixture(t, {
      certificates: { releasekey: OTA_CERT, platform: "PLACEHOLDER" },
    }),
    /certificates\.platform is unset or a placeholder/,
  );
  refused(
    fixture(t, {
      build: {
        fingerprint: FP.replace("release-keys", "test-keys"),
        securityPatch: "2026-10-05",
        dateUtc: "1790000000",
      },
    }),
    /not a release-keys user build/,
  );
  refused(
    fixture(t, {
      certificates: { releasekey: "e".repeat(64), platform: "c".repeat(64) },
    }),
    /otaCertificateSha256/,
  );
  refused(fixture(t, { problems: ["payload mismatch"] }), /lists problems/);
  const f = fixture(t);
  fs.appendFileSync(f.targetFiles, "x");
  refused(f, /target-files SHA-256 is not the record's/);
  const g = fixture(t);
  refused(g, /vbmeta\.img is not the record's/, {
    readImageEntry: () => Buffer.from("other"),
  });
  const h = fixture(t);
  refused(h, /has no vbmeta\.img/, { imageEntries: ["boot.img"] });
  assert.match(
    knownGoodProblems({ record: null, channel: CHANNEL }).join("\n"),
    /record is missing[\s\S]*target-files is required[\s\S]*fastboot image is required/,
  );
});

test("stock-archive offers a verified known-good plan alongside the stock plan", (t) => {
  const f = fixture(t);
  retain(f);
  const stockBytes = Buffer.from("not a real factory archive");
  const archive = path.join(f.dir, "stock.zip");
  fs.writeFileSync(archive, stockBytes);
  const channel = {
    ...CHANNEL,
    recovery: {
      stockFactoryImage: { filename: "stock.zip", sha256: sha256(stockBytes) },
    },
  };
  const plan = stockRecoveryPlan({
    channel,
    sourceLock: {
      factory: { filename: "stock.zip", sha256: sha256(stockBytes) },
    },
    archive,
    entries: [],
    knownGood: path.join(f.dir, "retained"),
  });
  // The stock archive fixture has no images, so only the known-good plan is offered.
  assert.deepEqual(plan.steps, []);
  assert.deepEqual(plan.knownGood.problems, []);
  assert.equal(plan.knownGood.steps.length, 3);
  assert.equal(
    stockRecoveryPlan({ channel, sourceLock: {}, archive, entries: [] })
      .knownGood,
    null,
  );
});

test("the CLI binds retain-known-good to its required inputs", (t) => {
  assert.throws(
    () => parseArgs(["retain-known-good", "--channel", "c"]),
    /requires --record/,
  );
  assert.throws(
    () =>
      parseArgs([
        "check",
        "--channel",
        "c",
        "--from",
        "a",
        "--to",
        "b",
        "--known-good",
        "d",
      ]),
    /--known-good belongs to stock-archive/,
  );
  assert.throws(
    () =>
      parseArgs([
        "retain-known-good",
        "--channel",
        "c",
        "--record",
        "r",
        "--signed-target-files",
        "t",
        "--signed-image",
        "i",
        "--archive-dir",
        "d",
        "--execute",
      ]),
    /read-only/,
  );
  const f = fixture(t);
  const channelFile = path.join(f.dir, "channel.json");
  fs.writeFileSync(channelFile, JSON.stringify(CHANNEL));
  const log = console.log;
  console.log = () => {};
  try {
    const result = main(
      [
        "retain-known-good",
        "--record",
        f.recordFile,
        "--signed-target-files",
        f.targetFiles,
        "--signed-image",
        f.image,
        "--archive-dir",
        path.join(f.dir, "cli"),
      ],
      { channel: channelFile },
    );
    assert.equal(result.retained, true);
  } finally {
    console.log = log;
  }
});

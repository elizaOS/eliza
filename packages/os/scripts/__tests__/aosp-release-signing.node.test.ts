// Pixel 10a release signing, OTA and the compatibility record. The AOSP releasetools
// are test doubles (fixtures/aosp-releasetools) and every key is a throwaway value made
// in a temporary directory: these tests establish refusals, command construction and
// record contents. They are not a signed image, an image boot, an applied OTA, or a
// rollback or recovery drill.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, createPublicKey } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  chainedPartitionsFromMiscInfo,
  compatibilityRecord,
  parseProperties,
  parseVbmeta,
  rollbackIndexes,
} from "../android/aosp-release-record.mjs";
import {
  AVB_SIGNABLE_PARTITIONS,
  gitWorkTreeProblem,
  isWithin,
  PKCS11_JAVA_ARGS,
  parseSigningArgs,
  signingCommands,
  signRelease as sign,
  X509_KEYS,
} from "../android/aosp-release-signing.mjs";
import { encodeAvbPublicKey } from "../android/generate-release-keys.ts";

const osRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixtures = fileURLToPath(
  new URL("fixtures/aosp-releasetools/", import.meta.url),
);
const ELIZA = "android/releases/pixel10a-eliza.json";
const CHANNEL = "android/releases/pixel10a-eliza-ota-channel.json";
const LOCK = "android/sources/pixel10a-stallion.json";
const read = (rel) =>
  JSON.parse(fs.readFileSync(path.join(osRoot, rel), "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const FINGERPRINT =
  "elizaOS/eliza_stallion_phone/stallion:17/CP2A.261005.001/42:user/release-keys";
const DEV = "build/make/target/product/security";
const TEST_KEY_DIGEST = "0".repeat(64);
const signRelease = (options) =>
  sign({ descriptorFile: ELIZA, sourceLockPath: LOCK, ...options });

/** Write a zip; object values become nested zips (APKs and APEXes inside target-files). */
function zip(file, entries) {
  execFileSync("python3", [
    "-c",
    "import io,json,sys,zipfile\ndef build(e):\n b=io.BytesIO()\n with zipfile.ZipFile(b,'w') as z:\n  for k,v in e.items(): z.writestr(k, build(v) if isinstance(v,dict) else v)\n return b.getvalue()\nopen(sys.argv[1],'wb').write(build(json.loads(sys.argv[2])))",
    file,
    JSON.stringify(entries),
  ]);
}
const unzipEntry = (file, name) =>
  execFileSync("unzip", ["-p", file, name], { maxBuffer: 16 << 20 });
function temporary(t, prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function certificate(dir, name) {
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-subj",
      `/CN=release-test-${name}`,
      "-days",
      "1",
      "-keyout",
      path.join(dir, `${name}.key.tmp`),
      "-out",
      path.join(dir, `${name}.x509.pem`),
    ],
    { stdio: "ignore" },
  );
  fs.rmSync(path.join(dir, `${name}.key.tmp`));
  fs.chmodSync(path.join(dir, `${name}.x509.pem`), 0o600);
  const der = Buffer.from(
    fs
      .readFileSync(path.join(dir, `${name}.x509.pem`), "utf8")
      .replace(/-----[^-]+-----|\s/g, ""),
    "base64",
  );
  return sha256(der);
}

/** A throwaway key directory in the android/signing layout. Private files hold a marker, never a key. */
function keyDirectory(t) {
  const keys = temporary(t, "release-test-keys-");
  fs.chmodSync(keys, 0o700);
  const platform = certificate(keys, "platform"),
    releasekey = certificate(keys, "releasekey"),
    apex = certificate(keys, "apex");
  const write = (name, value) => {
    fs.writeFileSync(path.join(keys, name), value);
    fs.chmodSync(path.join(keys, name), 0o600);
  };
  for (const name of X509_KEYS) {
    if (!["platform", "releasekey"].includes(name))
      write(
        `${name}.x509.pem`,
        fs.readFileSync(path.join(keys, "releasekey.x509.pem")),
      );
    write(`${name}.pk8`, "TEST-ONLY-PRIVATE-MARKER");
  }
  write("apex.pk8", "TEST-ONLY-PRIVATE-MARKER");
  write("apex_payload.pem", "TEST-ONLY-PRIVATE-MARKER");
  write("apex_payload.avbpubkey", "release apex payload public key");
  write("avb.pem", "TEST-ONLY-PRIVATE-MARKER");
  const pkmd = Buffer.from("test avb public key metadata");
  write("avb_pkmd.bin", pkmd);
  return { keys, platform, releasekey, apex, avb: sha256(pkmd) };
}

/** Reviewed digests for every non-platform certificate; the fixture copies releasekey's certificate to each. */
function releaseCertificates({ releasekey, apex }) {
  return {
    ...Object.fromEntries(
      X509_KEYS.filter(
        (name) => !["platform", "releasekey"].includes(name),
      ).map((name) => [name, releasekey]),
    ),
    apex,
  };
}

/** A copy of this package whose Eliza release descriptor and channel are complete for the given keys. */
function completeRoot(t, { platform, releasekey, apex, avb }) {
  const dir = temporary(t, "release-root-");
  const write = (rel, value) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(
      path.join(dir, rel),
      typeof value === "string" ? value : JSON.stringify(value, null, 2),
    );
  };
  const lock = JSON.stringify({
    schema: 1,
    target: "pixel10a",
    device: { codename: "stallion", androidRelease: "17" },
    developmentOnly: false,
    releaseQualified: false,
    factory: read(LOCK).factory,
  });
  write(LOCK, lock);
  const product = read(ELIZA);
  write(ELIZA, {
    ...product,
    sourceLock: { ...product.sourceLock, sha256: sha256(lock) },
    signer: {
      ...product.signer,
      applicationCertificateSha256: "d".repeat(64),
      platformCertificateSha256: platform,
      releaseCertificates: releaseCertificates({ releasekey, apex }),
    },
    avb: { ...product.avb, publicKeySha256: avb },
  });
  write(CHANNEL, {
    ...read(CHANNEL),
    authority: "elizaOS release",
    releaseOwner: "elizaOS release owner",
    otaCertificateSha256: releasekey,
    avbPublicKeySha256: avb,
  });
  const readBack = (rel) =>
    JSON.parse(fs.readFileSync(path.join(dir, rel), "utf8"));
  return { dir, write, readBack, product: readBack(ELIZA) };
}

/** A fresh copy of the releasetools test doubles with their own call log. */
function releasetools(t) {
  const bin = path.join(temporary(t, "otatools-"), "bin");
  fs.mkdirSync(bin);
  for (const name of [
    "sign_target_files_apks",
    "ota_from_target_files",
    "apksigner",
  ]) {
    fs.copyFileSync(path.join(fixtures, name), path.join(bin, name));
    fs.chmodSync(path.join(bin, name), 0o755);
  }
  return {
    bin,
    configure: (value) =>
      fs.writeFileSync(path.join(bin, "mock.json"), JSON.stringify(value)),
    calls: () =>
      fs.existsSync(path.join(bin, "calls.jsonl"))
        ? fs
            .readFileSync(path.join(bin, "calls.jsonl"), "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [],
  };
}

const MISC_INFO = [
  "avb_enable=true",
  "avb_vbmeta_key_path=external/avb/test/data/testkey_rsa4096.pem",
  "avb_vbmeta_algorithm=SHA256_RSA4096",
  "avb_vbmeta_system=system system_ext",
  "avb_vbmeta_system_key_path=external/avb/test/data/testkey_rsa4096.pem",
  "avb_vbmeta_system_rollback_index_location=1",
  "avb_vbmeta_vendor=vendor",
  "avb_vbmeta_vendor_key_path=external/avb/test/data/testkey_rsa4096.pem",
  "avb_vbmeta_vendor_rollback_index_location=2",
];
const apkcert = (name, cert) =>
  `name="${name}" certificate="${cert}" private_key="${cert === "PRESIGNED" ? "" : cert.replace(/\.x509\.pem$/, ".pk8")}"`;
const APKCERTS = [
  apkcert("Launcher.apk", `${DEV}/testkey.x509.pem`),
  apkcert("Settings.apk", `${DEV}/platform.x509.pem`),
  apkcert("Bluetooth.apk", `${DEV}/bluetooth.x509.pem`),
  apkcert("Vendor.apk", "PRESIGNED"),
];
const APEXKEYS = [
  'name="com.android.foo.apex" public_key="system/apex/foo.avbpubkey" private_key="system/apex/foo.pem" container_certificate="system/apex/foo.x509.pem" container_private_key="system/apex/foo.pk8" partition="system"',
  'name="com.google.bar.apex" public_key="PRESIGNED" private_key="PRESIGNED" container_certificate="PRESIGNED" container_private_key="PRESIGNED" partition="system"',
];

function targetFiles(
  t,
  {
    misc = MISC_INFO,
    apkcerts = APKCERTS,
    apexkeys = APEXKEYS,
    files = {},
    fingerprint = FINGERPRINT,
    dateUtc = "1790000000",
  } = {},
) {
  const file = path.join(
    temporary(t, "target-files-"),
    "unsigned-target_files.zip",
  );
  zip(file, {
    "SYSTEM/build.prop": `# test\nro.system.build.fingerprint=${fingerprint}\nro.build.id=CP2A.261005.001\nro.build.version.incremental=42\nro.build.version.release=17\nro.build.version.sdk=37\nro.build.version.security_patch=2026-10-05\nro.build.date.utc=${dateUtc}\n`,
    "VENDOR/build.prop":
      "ro.vendor.build.fingerprint=google/stallion/stallion:17/CP3A.261005.005/1:user/release-keys\nro.vendor.build.security_patch=2026-10-05\n",
    "META/misc_info.txt": `${misc.join("\n")}\n`,
    "META/apkcerts.txt": `${apkcerts.join("\n")}\n`,
    "META/apexkeys.txt": `${apexkeys.join("\n")}\n`,
    "SYSTEM/app/Launcher/Launcher.apk": { CERT: TEST_KEY_DIGEST },
    "SYSTEM/priv-app/Settings/Settings.apk": { CERT: TEST_KEY_DIGEST },
    "SYSTEM/app/Bluetooth/Bluetooth.apk": { CERT: TEST_KEY_DIGEST },
    "VENDOR/app/Vendor/Vendor.apk": { CERT: "f".repeat(64) },
    "SYSTEM/apex/com.android.foo.apex": {
      CERT: TEST_KEY_DIGEST,
      apex_pubkey: "aosp test apex payload key",
    },
    "SYSTEM/apex/com.google.bar.apex": {
      CERT: "e".repeat(64),
      apex_pubkey: "vendor key",
    },
    ...files,
  });
  return { file, sha256: sha256(fs.readFileSync(file)) };
}

function setup(t, tf = {}) {
  const key = keyDirectory(t),
    repo = completeRoot(t, key),
    target = targetFiles(t, tf),
    ota = releasetools(t);
  const out = path.join(temporary(t, "release-out-"), "release");
  return {
    key,
    repo,
    tf: target,
    ota,
    out,
    options: {
      root: repo.dir,
      targetFiles: target.file,
      targetFilesSha256: target.sha256,
      keysDir: key.keys,
      releasetools: ota.bin,
      out,
    },
  };
}

/** A refused signing: no tool runs, no output appears, and the dry run names the same problem. */
async function refusedBeforeSigning(fixture, options, pattern) {
  await assert.rejects(signRelease(options), pattern);
  assert.deepEqual(fixture.ota.calls(), [], `${pattern}: no releasetool ran`);
  assert.equal(fs.existsSync(fixture.out), false);
  const dry = await signRelease({ ...options, dryRun: true });
  assert.ok(
    dry.problems.some((problem) => pattern.test(problem)),
    `${pattern}\n${dry.problems.join("\n")}`,
  );
}

test("the committed Eliza release descriptor pins the shared source lock and names every unset release input", async (t) => {
  const product = read(ELIZA),
    channel = read(CHANNEL);
  assert.equal(
    product.product,
    read("android/products/pixel10a-eliza.json").productName,
  );
  assert.equal(product.releaseQualified, false);
  assert.equal(product.deviceAcceptanceVerified, false);
  assert.equal(product.ota.channel, CHANNEL);
  assert.equal(
    sha256(fs.readFileSync(path.join(osRoot, LOCK))),
    product.sourceLock.sha256,
  );
  assert.equal(
    channel.recovery.stockFactoryImage.sha256,
    read(LOCK).factory.sha256,
  );
  const out = path.join(temporary(t, "release-out-"), "release");
  const dry = await signRelease({ root: osRoot, out, dryRun: true });
  for (const expected of [
    /signer\.applicationCertificateSha256 must be the reviewed application release certificate/,
    /signer\.platformCertificateSha256 must be a SHA-256/,
    /avb\.publicKeySha256 must be a SHA-256/,
    /otaCertificateSha256 is unset/,
    /authority is unset/,
  ])
    assert.ok(
      dry.problems.some((problem) => expected.test(problem)),
      `${expected}\n${dry.problems.join("\n")}`,
    );
  assert.ok(
    !dry.problems.some((problem) => /sourceLock|developmentOnly/.test(problem)),
    dry.problems.join("\n"),
  );
  assert.equal(dry.ran, false);
});

test("signing commands follow the releasetools job with keys only as runtime paths", () => {
  const product = read(ELIZA);
  const { commands } = signingCommands({
    targetFiles: "/in/tf.zip",
    keysDir: "/dev/shm/keys",
    releasetools: "/otatools/bin",
    out: "/out",
    product,
    incrementalFrom: "/prev/tf.zip",
  });
  assert.deepEqual(
    commands.map((command) => path.basename(command.tool)),
    ["sign_target_files_apks", "ota_from_target_files"],
  );
  assert.deepEqual(commands[0].args.slice(0, 5), [
    "-p",
    "/otatools",
    "-o",
    "-d",
    "/dev/shm/keys",
  ]);
  for (const partition of ["vbmeta", ...product.avb.chainedPartitions]) {
    const at = commands[0].args.indexOf(`--avb_${partition}_key`);
    assert.equal(commands[0].args[at + 1], "/dev/shm/keys/avb.pem", partition);
    assert.equal(
      commands[0].args[
        commands[0].args.indexOf(`--avb_${partition}_algorithm`) + 1
      ],
      "SHA256_RSA4096",
    );
  }
  assert.deepEqual(commands[1].args.slice(2), [
    "-k",
    "/dev/shm/keys/releasekey",
    "-i",
    "/prev/tf.zip",
    "/out/signed-target_files.zip",
    "/out/incremental-ota.zip",
  ]);
  for (const name of ["bluetooth", "nfc"])
    assert.ok(
      commands[0].args.includes(`${DEV}/${name}=/dev/shm/keys/${name}`),
      name,
    );
  const withApex = signingCommands({
    targetFiles: "/in/tf.zip",
    keysDir: "/dev/shm/keys",
    releasetools: "/otatools/bin",
    out: "/out",
    product,
    keyMap: { "vendor/certs/camera": "camera" },
    inspection: {
      apexkeys: [
        {
          name: "com.android.foo.apex",
          private_key: "a.pem",
          container_private_key: "a.pk8",
        },
        {
          name: "com.google.bar.apex",
          private_key: "PRESIGNED",
          container_private_key: "PRESIGNED",
        },
      ],
    },
  }).commands[0].args;
  assert.ok(withApex.includes("vendor/certs/camera=/dev/shm/keys/camera"));
  assert.equal(
    withApex[withApex.indexOf("--extra_apex_payload_key") + 1],
    "com.android.foo.apex=/dev/shm/keys/apex_payload.pem",
  );
  assert.equal(
    withApex[withApex.indexOf("--extra_apks") + 1],
    "com.android.foo.apex=/dev/shm/keys/apex",
  );
  assert.ok(!withApex.some((arg) => arg.startsWith("com.google.bar.apex")));
  assert.deepEqual(
    parseSigningArgs([
      "--map-key",
      "vendor/certs/camera=camera",
      "--map-key",
      "vendor/certs/nfc2=nfc2",
    ]).keyMap,
    { "vendor/certs/camera": "camera", "vendor/certs/nfc2": "nfc2" },
  );
  assert.throws(() => parseSigningArgs(["--keys-dir"]), /Use --target-files/);
  assert.deepEqual(parseSigningArgs(["--dry-run", "--keys-dir", "/k"]), {
    dryRun: true,
    keysDir: "/k",
  });
});

test("a complete fixture signs with the releasetools doubles and writes the compatibility record", async (t) => {
  const { key, ota, out, options, tf } = setup(t);
  const apkManifest = path.join(path.dirname(out), "apk-manifest.json");
  fs.writeFileSync(
    apkManifest,
    JSON.stringify({
      results: [
        {
          file: "launcher-release.apk",
          mode: "release",
          sha256: "a".repeat(64),
          signerSha256: "d".repeat(64),
          versionCode: 7,
          distributable: false,
        },
        { file: "launcher-debug.apk", mode: "debug" },
      ],
    }),
  );
  const result = await signRelease({ ...options, apkManifest });
  assert.equal(result.ran, true);
  const calls = ota.calls();
  assert.deepEqual(
    calls.map((call) => call[0]),
    ["sign_target_files_apks", "ota_from_target_files"],
  );
  assert.ok(calls[0].includes("-o") && calls[0].includes(key.keys));
  assert.equal(
    calls[1][calls[1].indexOf("-k") + 1],
    path.join(key.keys, "releasekey"),
  );
  assert.ok(
    calls[0].includes(`${DEV}/bluetooth=${path.join(key.keys, "bluetooth")}`) &&
      calls[0].includes(`${DEV}/nfc=${path.join(key.keys, "nfc")}`),
  );
  assert.ok(
    calls[0].includes(
      `com.android.foo.apex=${path.join(key.keys, "apex_payload.pem")}`,
    ) &&
      calls[0].includes(`com.android.foo.apex=${path.join(key.keys, "apex")}`),
  );
  assert.ok(!calls[0].some((arg) => arg.startsWith("com.google.bar.apex")));
  assert.equal(fs.statSync(out).mode & 0o777, 0o700);
  assert.deepEqual(
    fs.readFileSync(path.join(out, "avb_pkmd.bin")),
    fs.readFileSync(path.join(key.keys, "avb_pkmd.bin")),
  );
  const text = fs.readFileSync(result.record, "utf8"),
    record = JSON.parse(text);
  assert.doesNotMatch(text, /TEST-ONLY-PRIVATE-MARKER/);
  assert.equal(record.kind, "aosp-release-compatibility");
  assert.equal(record.product, "eliza_stallion_phone");
  assert.equal(record.channel, "stable");
  assert.equal(record.build.fingerprint, FINGERPRINT);
  assert.equal(record.build.androidRelease, "17");
  assert.equal(record.build.securityPatch, "2026-10-05");
  assert.equal(record.build.dateUtc, "1790000000");
  assert.match(record.build.vendorFingerprint, /^google\/stallion/);
  assert.equal(record.inputs.unsignedTargetFilesSha256, tf.sha256);
  assert.equal(record.verifiedBoot.publicKeySha256, key.avb);
  const signed = path.join(out, "signed-target_files.zip");
  assert.equal(
    record.verifiedBoot.images.vbmeta,
    sha256(unzipEntry(signed, "IMAGES/vbmeta.img")),
  );
  assert.deepEqual(record.verifiedBoot.chainedPartitions, [
    "vbmeta_system",
    "vbmeta_vendor",
  ]);
  assert.deepEqual(record.verifiedBoot.rollbackIndexes, [
    { partition: "vbmeta", location: 0, index: "1" },
    { partition: "vbmeta_system", location: 1, index: "1" },
    { partition: "vbmeta_vendor", location: 2, index: "1" },
  ]);
  assert.equal(record.payload.metadata["post-build"], FINGERPRINT);
  assert.equal(record.payload.metadata["post-timestamp"], "1790000000");
  assert.equal(record.certificates.platform, key.platform);
  assert.equal(record.certificates.releasekey, key.releasekey);
  assert.deepEqual(record.apks, [
    {
      file: "launcher-release.apk",
      sha256: "a".repeat(64),
      signerSha256: "d".repeat(64),
      versionCode: 7,
      distributable: false,
    },
  ]);
  assert.equal(record.artifacts.ota.type, "full");
  assert.equal(
    record.artifacts.ota.sha256,
    sha256(fs.readFileSync(path.join(out, "ota.zip"))),
  );
  assert.deepEqual(record.problems, []);
  for (const flag of [
    "imageBooted",
    "signedUpdateApplied",
    "releaseQualified",
    "deviceAcceptanceVerified",
  ])
    assert.equal(record[flag], false, flag);
  assert.equal(record.downgradeAllowed, false);
  assert.ok(
    result.distributionProblems.some((problem) =>
      /signedUpdate drill is "not run"/.test(problem),
    ),
  );
});

test("signing refuses unsafe keys, mismatched digests, changed inputs and unset descriptors without running a tool", async (t) => {
  const refuse = async (change, pattern) => {
    const fixture = setup(t);
    const options = change(fixture) ?? fixture.options;
    const existed = fs.existsSync(fixture.out);
    await assert.rejects(signRelease(options), pattern);
    assert.deepEqual(fixture.ota.calls(), [], `${pattern}: no releasetool ran`);
    if (!existed) assert.equal(fs.existsSync(fixture.out), false);
    const dry = await signRelease({ ...options, dryRun: true });
    assert.equal(dry.ran, false);
    assert.ok(
      dry.problems.some((problem) => pattern.test(problem)),
      `${pattern}\n${dry.problems.join("\n")}`,
    );
  };
  const edit = (repo, rel, change) =>
    repo.write(rel, change(repo.readBack(rel)));
  await refuse(({ key }) => {
    fs.chmodSync(key.keys, 0o755);
  }, /mode 0700/);
  await refuse(({ key }) => {
    fs.rmSync(path.join(key.keys, "platform.pk8"));
  }, /lacks platform\.pk8/);
  await refuse(({ key }) => {
    fs.writeFileSync(path.join(key.keys, "avb_pkmd.bin"), "other");
  }, /avb_pkmd\.bin is not the product's avb\.publicKeySha256/);
  await refuse(({ key }) => {
    certificate(key.keys, "platform");
  }, /platform\.x509\.pem is [0-9a-f]{64}, not the product's/);
  await refuse(({ key }) => {
    certificate(key.keys, "releasekey");
  }, /not the channel's otaCertificateSha256/);
  await refuse(({ key }) => {
    certificate(key.keys, "shared");
  }, /shared\.x509\.pem is [0-9a-f]{64}, not the product's signer\.releaseCertificates\.shared/);
  await refuse(({ key }) => {
    certificate(key.keys, "apex");
  }, /apex\.x509\.pem is [0-9a-f]{64}, not the product's signer\.releaseCertificates\.apex/);
  await refuse(({ repo }) => {
    edit(repo, ELIZA, (p) => ({
      ...p,
      signer: {
        ...p.signer,
        releaseCertificates: {
          ...p.signer.releaseCertificates,
          media: "UNSET",
        },
      },
    }));
  }, /signer\.releaseCertificates\.media must be the reviewed certificate SHA-256/);
  await refuse(
    ({ options }) => ({ ...options, targetFilesSha256: "0".repeat(64) }),
    /differs from --target-files-sha256/,
  );
  await refuse(
    ({ options }) => ({
      ...options,
      keysDir: path.relative(process.cwd(), options.keysDir),
    }),
    /absolute path/,
  );
  await refuse(({ options }) => {
    fs.mkdirSync(options.out);
    fs.chmodSync(options.out, 0o700);
  }, /already exists/);
  await refuse(({ repo }) => {
    edit(repo, CHANNEL, (c) => ({ ...c, avbPublicKeySha256: "UNSET" }));
  }, /avbPublicKeySha256 is unset/);
  await refuse(({ repo }) => {
    edit(repo, CHANNEL, (c) => ({ ...c, downgradeAllowed: true }));
  }, /downgradeAllowed must be false/);
  await refuse(({ repo }) => {
    edit(repo, CHANNEL, (c) => ({
      ...c,
      recovery: {
        ...c.recovery,
        stockFactoryImage: { filename: "other.zip", sha256: "c".repeat(64) },
      },
    }));
  }, /stockFactoryImage is not the locked factory archive/);
  await refuse(({ repo }) => {
    edit(repo, ELIZA, (p) => ({
      ...p,
      signer: { ...p.signer, applicationCertificateSha256: "unset" },
    }));
  }, /applicationCertificateSha256/);
  await refuse(({ repo }) => {
    edit(repo, LOCK, (l) => ({ ...l, developmentOnly: true }));
  }, /differs from the pinned sourceLock\.sha256|still marked developmentOnly/);
  // Keys inside a Git working tree (for example this repository) are refused.
  await refuse(({ options, key }) => {
    const inside = fs.mkdtempSync(path.join(options.root, "keys-"));
    execFileSync("git", ["init", "-q", options.root]);
    for (const name of fs.readdirSync(key.keys))
      fs.copyFileSync(path.join(key.keys, name), path.join(inside, name));
    fs.chmodSync(inside, 0o700);
    return { ...options, keysDir: inside };
  }, /inside this repository|inside a Git working tree/);
});

test("the compatibility record names mismatched OTA metadata and payload hashes", async (t) => {
  const { options, out, ota } = setup(t);
  ota.configure({ postBuild: "other/fingerprint", fileHash: "AAAA" });
  await assert.rejects(
    signRelease(options),
    /Signed outputs are inconsistent[\s\S]*post-build other\/fingerprint[\s\S]*FILE_HASH/,
  );
  const record = JSON.parse(
    fs.readFileSync(path.join(out, "release-record.json"), "utf8"),
  );
  assert.equal(record.releaseQualified, false);
  assert.equal(record.problems.length, 2);
  // A target-files without vbmeta images or build properties is recorded as such, never filled in.
  const empty = path.join(path.dirname(out), "empty.zip"),
    otaZip = path.join(path.dirname(out), "empty-ota.zip");
  zip(empty, { "META/misc_info.txt": "" });
  zip(otaZip, { "other.txt": "" });
  const bare = await compatibilityRecord({
    signedTargetFiles: empty,
    ota: otaZip,
    product: read(ELIZA),
    channel: read(CHANNEL),
  });
  for (const expected of [
    /SYSTEM\/build\.prop is missing/,
    /IMAGES\/vbmeta\.img is missing/,
    /payload\.bin is missing/,
    /no build fingerprint/,
  ])
    assert.ok(
      bare.problems.some((problem) => expected.test(problem)),
      String(expected),
    );
  assert.deepEqual(parseProperties("# c\na=b\nc = d=e\n"), {
    a: "b",
    c: "d=e",
  });
});

test("APK certificates without a release key mapping are refused before signing; --map-key admits them", async (t) => {
  const camera = apkcert("Camera.apk", "vendor/google/certs/camera.x509.pem");
  const withCamera = {
    apkcerts: [...APKCERTS, camera],
    files: { "PRODUCT/app/Camera/Camera.apk": { CERT: TEST_KEY_DIGEST } },
  };
  let fixture = setup(t, withCamera);
  await refusedBeforeSigning(
    fixture,
    fixture.options,
    /APK Camera\.apk is signed with vendor\/google\/certs\/camera\.x509\.pem, which no release key mapping covers/,
  );
  fixture = setup(t, withCamera);
  const cameraDigest = certificate(fixture.key.keys, "camera");
  const pinned = fixture.repo.readBack(ELIZA);
  fixture.repo.write(ELIZA, {
    ...pinned,
    signer: {
      ...pinned.signer,
      releaseCertificates: {
        ...pinned.signer.releaseCertificates,
        camera: cameraDigest,
      },
    },
  });
  fs.writeFileSync(
    path.join(fixture.key.keys, "camera.pk8"),
    "TEST-ONLY-PRIVATE-MARKER",
  );
  fs.chmodSync(path.join(fixture.key.keys, "camera.pk8"), 0o600);
  const result = await signRelease({
    ...fixture.options,
    keyMap: { "vendor/google/certs/camera": "camera" },
  });
  assert.ok(
    fixture.ota
      .calls()[0]
      .includes(
        `vendor/google/certs/camera=${path.join(fixture.key.keys, "camera")}`,
      ),
  );
  assert.equal(
    JSON.parse(fs.readFileSync(result.record, "utf8")).certificates.camera,
    cameraDigest,
  );
  fixture = setup(t, {
    apkcerts: [...APKCERTS, apkcert("Ext.apk", "EXTERNAL")],
    files: { "SYSTEM/app/Ext/Ext.apk": { CERT: TEST_KEY_DIGEST } },
  });
  await refusedBeforeSigning(
    fixture,
    fixture.options,
    /APK Ext\.apk is EXTERNAL/,
  );
  fixture = setup(t, {
    apexkeys: [
      ...APEXKEYS,
      'name="com.x.apex" public_key="PRESIGNED" private_key="PRESIGNED" container_certificate="x.x509.pem" container_private_key="x.pk8"',
    ],
  });
  await refusedBeforeSigning(
    fixture,
    fixture.options,
    /APEX com\.x\.apex is only partly presigned/,
  );
});

test("APEX keys are required when the build re-signs an APEX, and not otherwise", async (t) => {
  let fixture = setup(t);
  fs.rmSync(path.join(fixture.key.keys, "apex_payload.pem"));
  await refusedBeforeSigning(
    fixture,
    fixture.options,
    /lacks apex_payload\.pem/,
  );
  fixture = setup(t);
  fs.rmSync(path.join(fixture.key.keys, "apex.pk8"));
  await refusedBeforeSigning(fixture, fixture.options, /lacks apex\.pk8/);
  fixture = setup(t, {
    apexkeys: [APEXKEYS[1]],
    files: { "SYSTEM/apex/com.android.foo.apex": "" },
  });
  for (const name of ["apex.pk8", "apex_payload.pem"])
    fs.rmSync(path.join(fixture.key.keys, name));
  const dry = await signRelease({ ...fixture.options, dryRun: true });
  assert.ok(
    !dry.problems.some((problem) => /apex/.test(problem)),
    dry.problems.join("\n"),
  );
  assert.ok(!dry.commands[0].args.includes("--extra_apex_payload_key"));
});

test("a test, development or unknown certificate left after signing is refused before any OTA is built", async (t) => {
  for (const [config, pattern] of [
    [
      { skip: ["Launcher.apk"] },
      new RegExp(
        `Launcher\\.apk is signed with ${TEST_KEY_DIGEST}, which is not a release certificate`,
      ),
    ],
    [
      { skip: ["com.android.foo.apex"] },
      /com\.android\.foo\.apex is signed with 0{64}, which is not a release certificate[\s\S]*does not carry the release APEX payload key/,
    ],
    [
      { keepApexKey: true },
      /com\.android\.foo\.apex does not carry the release APEX payload key/,
    ],
  ]) {
    const fixture = setup(t);
    fixture.ota.configure(config);
    await assert.rejects(signRelease(fixture.options), pattern);
    assert.deepEqual(
      fixture.ota.calls().map((call) => call[0]),
      ["sign_target_files_apks"],
    );
    assert.equal(fs.existsSync(path.join(fixture.out, "ota.zip")), false);
    assert.equal(
      fs.existsSync(path.join(fixture.out, "release-record.json")),
      false,
    );
  }
  const stray = setup(t, {
    files: { "SYSTEM/app/Stray/Stray.apk": { CERT: TEST_KEY_DIGEST } },
  });
  await assert.rejects(
    signRelease(stray.options),
    /Stray\.apk is in neither apkcerts\.txt nor apexkeys\.txt/,
  );
  const missing = setup(t);
  fs.rmSync(path.join(missing.ota.bin, "apksigner"));
  await refusedBeforeSigning(
    missing,
    missing.options,
    /an executable apksigner is required/,
  );
});

test("chained AVB partitions come from the target-files and each needs a mapped key before signing", async (t) => {
  assert.deepEqual(
    chainedPartitionsFromMiscInfo(
      parseProperties(
        [
          ...MISC_INFO,
          "avb_boot_key_path=k.pem",
          "avb_init_boot_key_path=k.pem",
          "avb_vendor_boot_key_path=",
          "avb_system_hashtree_enable=true",
        ].join("\n"),
      ),
    ),
    ["boot", "init_boot", "vbmeta_system", "vbmeta_vendor"],
  );
  const bootKey =
    "avb_boot_key_path=external/avb/test/data/testkey_rsa4096.pem";
  let fixture = setup(t, {
    misc: [
      ...MISC_INFO,
      bootKey,
      "avb_init_boot_key_path=external/avb/test/data/testkey_rsa4096.pem",
    ],
  });
  await refusedBeforeSigning(
    fixture,
    fixture.options,
    /chained AVB partition boot has no mapped --avb_boot_key/,
  );
  fixture = setup(t, {
    misc: MISC_INFO.filter((line) => !line.startsWith("avb_vbmeta_vendor")),
  });
  await refusedBeforeSigning(
    fixture,
    fixture.options,
    /maps --avb_vbmeta_vendor_key, but the target-files does not chain vbmeta_vendor/,
  );
  fixture = setup(t, {
    misc: MISC_INFO.map((line) =>
      line === "avb_enable=true" ? "avb_enable=false" : line,
    ),
  });
  await refusedBeforeSigning(fixture, fixture.options, /built without AVB/);
  fixture = setup(t, {
    misc: [...MISC_INFO, bootKey, "avb_boot_rollback_index_location=3"],
  });
  const product = fixture.repo.readBack(ELIZA);
  fixture.repo.write(ELIZA, {
    ...product,
    avb: {
      ...product.avb,
      chainedPartitions: [...product.avb.chainedPartitions, "boot"],
    },
  });
  const result = await signRelease(fixture.options);
  const call = fixture.ota.calls()[0];
  assert.equal(
    call[call.indexOf("--avb_boot_key") + 1],
    path.join(fixture.key.keys, "avb.pem"),
  );
  const record = JSON.parse(fs.readFileSync(result.record, "utf8"));
  assert.deepEqual(Object.keys(record.verifiedBoot.images), [
    "vbmeta",
    "boot",
    "vbmeta_system",
    "vbmeta_vendor",
  ]);
  assert.deepEqual(
    record.verifiedBoot.rollbackIndexes.find((row) => row.partition === "boot"),
    { partition: "boot", location: 3, index: "1" },
  );
  // The record's required images follow the signed build's list: an absent chained image is named.
  const signedWithoutBoot = path.join(path.dirname(fixture.out), "no-boot.zip");
  zip(signedWithoutBoot, {
    "META/misc_info.txt": [...MISC_INFO, "avb_boot_key_path=k.pem"].join("\n"),
    "IMAGES/vbmeta.img": "v",
    "IMAGES/vbmeta_system.img": "s",
    "IMAGES/vbmeta_vendor.img": "x",
  });
  const bare = await compatibilityRecord({
    signedTargetFiles: signedWithoutBoot,
    ota: path.join(fixture.out, "ota.zip"),
    product,
    channel: read(CHANNEL),
  });
  assert.ok(
    bare.problems.includes(
      "IMAGES/boot.img is missing from the signed target-files",
    ),
    bare.problems.join("\n"),
  );
  assert.ok(
    bare.problems.includes("IMAGES/vbmeta.img is not an AVB vbmeta image"),
  );
});

/** A minimal AvbVBMetaImageHeader with chain-partition descriptors (no signature). */
function vbmeta(index, location = 0, chains = []) {
  const descriptors = Buffer.concat(
    chains.map(([name, chainLocation]) => {
      const key = Buffer.from("public key");
      const fixed = Buffer.alloc(16 + 60);
      fixed.writeUInt32BE(chainLocation, 0);
      fixed.writeUInt32BE(Buffer.byteLength(name), 4);
      fixed.writeUInt32BE(key.length, 8);
      let body = Buffer.concat([fixed, Buffer.from(name), key]);
      body = Buffer.concat([body, Buffer.alloc((8 - (body.length % 8)) % 8)]);
      const head = Buffer.alloc(16);
      head.writeBigUInt64BE(4n, 0);
      head.writeBigUInt64BE(BigInt(body.length), 8);
      return Buffer.concat([head, body]);
    }),
  );
  const header = Buffer.alloc(256);
  header.write("AVB0", 0, "latin1");
  header.writeBigUInt64BE(BigInt(descriptors.length), 20);
  header.writeBigUInt64BE(BigInt(descriptors.length), 104);
  header.writeBigUInt64BE(BigInt(index), 112);
  header.writeUInt32BE(location, 124);
  return Buffer.concat([header, descriptors]);
}

test("AVB rollback indexes come from vbmeta headers, chain descriptors and hash footers", () => {
  const main = vbmeta(7, 0, [
    ["vbmeta_system", 1],
    ["boot", 3],
  ]);
  assert.deepEqual(parseVbmeta(main), {
    rollbackIndex: "7",
    flags: 0,
    rollbackIndexLocation: 0,
    chains: [
      {
        partition: "vbmeta_system",
        rollbackIndexLocation: 1,
        publicKeySha256: sha256(Buffer.from("public key")),
      },
      {
        partition: "boot",
        rollbackIndexLocation: 3,
        publicKeySha256: sha256(Buffer.from("public key")),
      },
    ],
  });
  // A partition image carries its vbmeta struct before an AVBf footer at its end.
  const struct = vbmeta(9);
  const footer = Buffer.alloc(64);
  footer.write("AVBf", 0, "latin1");
  footer.writeBigUInt64BE(4096n, 12);
  footer.writeBigUInt64BE(4096n, 20);
  footer.writeBigUInt64BE(BigInt(struct.length), 28);
  const boot = Buffer.concat([
    Buffer.alloc(4096, 1),
    struct,
    Buffer.alloc(512),
    footer,
  ]);
  assert.equal(parseVbmeta(boot)?.rollbackIndex, "9");
  assert.deepEqual(
    rollbackIndexes({ vbmeta: main, vbmeta_system: vbmeta(5), boot }),
    {
      indexes: [
        { partition: "vbmeta", location: 0, index: "7" },
        { partition: "vbmeta_system", location: 1, index: "5" },
        { partition: "boot", location: 3, index: "9" },
      ],
      problems: [],
    },
  );
  assert.deepEqual(
    rollbackIndexes({ vbmeta: main, vendor_boot: vbmeta(1) }).problems,
    ["vbmeta does not chain vendor_boot"],
  );
  assert.deepEqual(
    rollbackIndexes({
      vbmeta: vbmeta(1, 1, [["vbmeta_system", 1]]),
      vbmeta_system: vbmeta(1),
    }).problems,
    ["AVB rollback index location 1 is used twice"],
  );
  for (const bad of [
    Buffer.from("AVB0"),
    Buffer.alloc(300),
    Buffer.concat([vbmeta(1).subarray(0, 255)]),
  ])
    assert.equal(parseVbmeta(bad), null);
  const truncated = Buffer.from(main);
  truncated.writeBigUInt64BE(BigInt(main.length), 104);
  assert.equal(parseVbmeta(truncated), null);
});

test("key files must be private regular files, and commands receive the key directory's real path", async (t) => {
  let fixture = setup(t);
  fs.rmSync(path.join(fixture.key.keys, "platform.pk8"));
  fs.writeFileSync(
    path.join(path.dirname(fixture.out), "elsewhere.pk8"),
    "TEST-ONLY-PRIVATE-MARKER",
  );
  fs.symlinkSync(
    path.join(path.dirname(fixture.out), "elsewhere.pk8"),
    path.join(fixture.key.keys, "platform.pk8"),
  );
  await refusedBeforeSigning(
    fixture,
    fixture.options,
    /platform\.pk8 is a symbolic link/,
  );
  fixture = setup(t);
  fs.chmodSync(path.join(fixture.key.keys, "avb.pem"), 0o644);
  await refusedBeforeSigning(
    fixture,
    fixture.options,
    /avb\.pem must not be readable or writable by group or others/,
  );
  fixture = setup(t);
  fs.chmodSync(path.join(fixture.key.keys, "releasekey.x509.pem"), 0o660);
  await refusedBeforeSigning(
    fixture,
    fixture.options,
    /releasekey\.x509\.pem must not be readable or writable/,
  );
  fixture = setup(t);
  const link = path.join(path.dirname(fixture.out), "keys-link");
  fs.symlinkSync(fixture.key.keys, link);
  const dry = await signRelease({
    ...fixture.options,
    keysDir: link,
    dryRun: true,
  });
  assert.deepEqual(dry.problems, []);
  const args = dry.commands.flatMap((command) => command.args);
  assert.ok(args.some((arg) => arg === fixture.key.keys));
  assert.ok(!args.some((arg) => arg.includes("keys-link")));
});

test("git that cannot run is not proof the key directory is outside a working tree", () => {
  assert.match(
    gitWorkTreeProblem("/k", () => ({
      error: new Error("spawn git ENOENT"),
      status: null,
    })),
    /could not be confirmed/,
  );
  assert.match(
    gitWorkTreeProblem("/k", () => ({ status: null, signal: "SIGKILL" })),
    /could not be confirmed/,
  );
  assert.match(
    gitWorkTreeProblem("/k", () => ({
      status: 128,
      stderr: "fatal: detected dubious ownership",
    })),
    /could not be confirmed/,
  );
  assert.match(
    gitWorkTreeProblem("/k", () => ({ status: 0, stdout: "true\n" })),
    /inside a Git working tree/,
  );
  assert.equal(
    gitWorkTreeProblem("/k", () => ({
      status: 128,
      stdout: "",
      stderr:
        "fatal: not a git repository (or any of the parent directories): .git",
    })),
    null,
  );
  assert.equal(isWithin("/repo", "/repo/..keys"), true);
  assert.equal(isWithin("/repo/sub", "/repo/..keys"), false);
  assert.equal(isWithin("/repo", "/repo"), true);
  assert.equal(isWithin("/repo", "/other"), false);
  assert.equal(isWithin("/repo", "/"), false);
});

test("an incremental OTA records its predecessor on the signing and the standalone record paths", async (t) => {
  const previous = setup(t, {
    fingerprint: FINGERPRINT.replace("/42:", "/41:"),
    dateUtc: "1780000000",
  });
  await signRelease(previous.options);
  const prior = path.join(previous.out, "signed-target_files.zip"),
    priorSha = sha256(fs.readFileSync(prior));
  const fixture = setup(t);
  const result = await signRelease({
    ...fixture.options,
    incrementalFrom: prior,
  });
  const record = JSON.parse(fs.readFileSync(result.record, "utf8"));
  assert.equal(record.artifacts.ota.type, "incremental");
  assert.deepEqual(record.artifacts.ota.incrementalFrom, {
    file: "signed-target_files.zip",
    sha256: priorSha,
  });
  assert.equal(
    record.payload.metadata["pre-build"],
    FINGERPRINT.replace("/42:", "/41:"),
  );
  const file = path.join(path.dirname(fixture.out), "standalone-record.json");
  const out = spawnSync(
    process.execPath,
    [
      path.join(osRoot, "scripts/android/aosp-release-record.mjs"),
      "--product",
      ELIZA,
      "--signed-target-files",
      path.join(fixture.out, "signed-target_files.zip"),
      "--ota",
      path.join(fixture.out, "incremental-ota.zip"),
      "--incremental-from",
      prior,
      "--out",
      file,
    ],
    { cwd: fixture.repo.dir, encoding: "utf8" },
  );
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(file, "utf8")).artifacts.ota.incrementalFrom,
    record.artifacts.ota.incrementalFrom,
  );
  const loose = await compatibilityRecord({
    signedTargetFiles: path.join(fixture.out, "signed-target_files.zip"),
    ota: path.join(fixture.out, "incremental-ota.zip"),
    product: read(ELIZA),
    channel: read(CHANNEL),
    incrementalFrom: "signed-target_files.zip",
  });
  assert.ok(
    loose.problems.some((problem) =>
      /incrementalFrom must identify the previous signed target-files/.test(
        problem,
      ),
    ),
  );
  const unmarked = await compatibilityRecord({
    signedTargetFiles: path.join(fixture.out, "signed-target_files.zip"),
    ota: path.join(fixture.out, "incremental-ota.zip"),
    product: read(ELIZA),
    channel: read(CHANNEL),
  });
  assert.ok(
    unmarked.problems.includes("a full OTA records a pre-build fingerprint"),
  );
});

/**
 * Managed (hardware-backed) signing: the key directory holds only certificates and
 * public keys, and the token, AVB helper and payload signer are throwaway files.
 */
function managedSetup(t, tf = {}) {
  const fixture = setup(t, tf);
  const { keys } = fixture.key;
  for (const name of fs
    .readdirSync(keys)
    .filter((item) => item.endsWith(".pk8")))
    fs.rmSync(path.join(keys, name));
  const publicKey = (pem, metadata) => {
    const scratch = temporary(t, "avb-key-");
    execFileSync(
      "openssl",
      ["genrsa", "-out", path.join(scratch, "private.pem"), "2048"],
      { stdio: "ignore" },
    );
    execFileSync(
      "openssl",
      [
        "rsa",
        "-in",
        path.join(scratch, "private.pem"),
        "-pubout",
        "-out",
        path.join(keys, pem),
      ],
      { stdio: "ignore" },
    );
    fs.writeFileSync(
      path.join(keys, metadata),
      encodeAvbPublicKey(
        createPublicKey(fs.readFileSync(path.join(keys, pem))),
      ),
    );
    for (const name of [pem, metadata])
      fs.chmodSync(path.join(keys, name), 0o600);
  };
  publicKey("avb.pem", "avb_pkmd.bin");
  publicKey("apex_payload.pem", "apex_payload.avbpubkey");
  const avb = sha256(fs.readFileSync(path.join(keys, "avb_pkmd.bin")));
  const product = fixture.repo.readBack(ELIZA);
  fixture.repo.write(ELIZA, {
    ...product,
    avb: { ...product.avb, publicKeySha256: avb },
  });
  fixture.repo.write(CHANNEL, {
    ...fixture.repo.readBack(CHANNEL),
    avbPublicKeySha256: avb,
  });
  const tools = temporary(t, "managed-signing-");
  const pkcs11Config = path.join(tools, "token.cfg"),
    avbSigningHelper = path.join(tools, "avb-helper"),
    payloadSigner = path.join(tools, "payload-signer");
  fs.writeFileSync(
    pkcs11Config,
    "name = ElizaRelease\nlibrary = /usr/lib/pkcs11/token.so\n",
  );
  for (const file of [avbSigningHelper, payloadSigner]) {
    fs.writeFileSync(file, "#!/bin/sh\nexit 1\n");
    fs.chmodSync(file, 0o755);
  }
  const managed = {
    pkcs11Config,
    avbSigningHelper,
    payloadSigner,
    payloadSignerArgs: ["-key", "eliza-release-ota"],
    payloadSignerSignatureSize: "512",
  };
  return { ...fixture, managed, options: { ...fixture.options, ...managed } };
}

test("managed signing keeps private keys in the token and passes the helper, keystore and payload signer to the releasetools", async (t) => {
  const fixture = managedSetup(t);
  const { keys } = fixture.key,
    { managed } = fixture;
  const dry = await signRelease({ ...fixture.options, dryRun: true });
  assert.deepEqual(dry.problems, []);
  assert.equal(dry.signingMode, "managed");
  assert.equal(dry.tokenLabels.platform, path.join(keys, "platform.pk8"));
  assert.equal(dry.tokenLabels.apex, path.join(keys, "apex.pk8"));
  const result = await signRelease(fixture.options);
  const [signCall, otaCall] = fixture.ota.calls();
  const value = (call, flag) => call[call.indexOf(flag) + 1];
  const keystore = `-providerClass sun.security.pkcs11.SunPKCS11 -providerArg ${managed.pkcs11Config} -loadPrivateKeysFromKeyStore PKCS11`;
  for (const call of [signCall, otaCall]) {
    assert.equal(value(call, "--extra_signapk_args"), keystore);
    assert.equal(value(call, "--java_args"), PKCS11_JAVA_ARGS.join(" "));
  }
  for (const partition of [
    "vbmeta",
    ...fixture.repo.product.avb.chainedPartitions,
    "apex",
  ])
    assert.equal(
      value(signCall, `--avb_${partition}_extra_args`),
      `--signing_helper_with_files ${managed.avbSigningHelper}`,
      partition,
    );
  assert.equal(value(signCall, "--avb_vbmeta_key"), path.join(keys, "avb.pem"));
  assert.equal(value(otaCall, "-k"), path.join(keys, "releasekey"));
  assert.equal(value(signCall, "--package_key"), path.join(keys, "releasekey"));
  assert.equal(value(signCall, "--payload_signer"), managed.payloadSigner);
  assert.equal(
    value(signCall, "--payload_signer_maximum_signature_size"),
    "512",
  );
  assert.equal(value(otaCall, "--payload_signer"), managed.payloadSigner);
  assert.equal(
    value(otaCall, "--payload_signer_args"),
    "-key eliza-release-ota",
  );
  assert.equal(
    value(otaCall, "--payload_signer_maximum_signature_size"),
    "512",
  );
  const text = fs.readFileSync(result.record, "utf8");
  assert.equal(JSON.parse(text).inputs.signingMode, "managed");
  assert.doesNotMatch(text, /TEST-ONLY/);
  const plain = setup(t);
  const record = JSON.parse(
    fs.readFileSync((await signRelease(plain.options)).record, "utf8"),
  );
  assert.equal(record.inputs.signingMode, "key-files");
  assert.ok(
    !plain.ota
      .calls()
      .flat()
      .some((arg) =>
        /signing_helper|payload_signer|extra_signapk_args|java_args/.test(arg),
      ),
  );
});

test("managed signing refuses mixed or unsafe inputs before any tool runs", async (t) => {
  const refuse = async (change, pattern) => {
    const fixture = managedSetup(t);
    await refusedBeforeSigning(
      fixture,
      change(fixture) ?? fixture.options,
      pattern,
    );
  };
  await refuse(
    ({ options }) => ({ ...options, payloadSigner: undefined }),
    /managed signing needs .* together; missing --payload-signer/,
  );
  await refuse(
    ({ options }) => ({ ...options, payloadSignerSignatureSize: undefined }),
    /missing --payload-signer-signature-size/,
  );
  await refuse(({ key }) => {
    fs.writeFileSync(
      path.join(key.keys, "platform.pk8"),
      "TEST-ONLY-PRIVATE-MARKER",
    );
    fs.chmodSync(path.join(key.keys, "platform.pk8"), 0o600);
  }, /holds platform\.pk8; managed signing keeps private keys in the PKCS#11 token/);
  await refuse(({ key }) => {
    fs.writeFileSync(
      path.join(key.keys, "avb.pem"),
      "TEST-ONLY-PRIVATE-MARKER",
    );
  }, /avb\.pem must be the public key/);
  await refuse(({ key }) => {
    fs.copyFileSync(
      path.join(key.keys, "apex_payload.pem"),
      path.join(key.keys, "avb.pem"),
    );
  }, /avb\.pem is not the key in avb_pkmd\.bin/);
  await refuse(({ key }) => {
    fs.copyFileSync(
      path.join(key.keys, "avb.pem"),
      path.join(key.keys, "apex_payload.pem"),
    );
  }, /apex_payload\.pem is not the key in apex_payload\.avbpubkey/);
  await refuse(({ key }) => {
    fs.rmSync(path.join(key.keys, "media.x509.pem"));
  }, /lacks media\.x509\.pem \(managed signing needs every release certificate and public key\)/);
  await refuse(
    ({ options }) => ({ ...options, pkcs11Config: "token.cfg" }),
    /--pkcs11-config must be an absolute path/,
  );
  await refuse(({ options }) => {
    const spaced = path.join(
      path.dirname(options.avbSigningHelper),
      "avb helper",
    );
    fs.copyFileSync(options.avbSigningHelper, spaced);
    fs.chmodSync(spaced, 0o755);
    return { ...options, avbSigningHelper: spaced };
  }, /--avb-signing-helper must be a path without spaces/);
  await refuse(({ options }) => {
    fs.chmodSync(options.payloadSigner, 0o644);
  }, /--payload-signer .* is not executable/);
  await refuse(
    ({ options }) => ({ ...options, payloadSignerSignatureSize: "0" }),
    /maximum signature size in bytes/,
  );
  await refuse(
    ({ options }) => ({ ...options, payloadSignerArgs: ["-pin", "1234 5678"] }),
    /--payload-signer-arg "1234 5678" must be a plain word/,
  );
});

test("only chained partitions sign_target_files_apks can re-sign are admitted", async (t) => {
  assert.deepEqual([...AVB_SIGNABLE_PARTITIONS].sort(), [
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
  const fixture = setup(t, {
    misc: [
      ...MISC_INFO,
      "avb_vendor_boot_key_path=external/avb/test/data/testkey_rsa4096.pem",
    ],
  });
  const product = fixture.repo.readBack(ELIZA);
  fixture.repo.write(ELIZA, {
    ...product,
    avb: {
      ...product.avb,
      chainedPartitions: [...product.avb.chainedPartitions, "vendor_boot"],
    },
  });
  await refusedBeforeSigning(
    fixture,
    fixture.options,
    /chained partition vendor_boot has no --avb_vendor_boot_key in sign_target_files_apks/,
  );
});

test("managed signing options parse from the command line; a signer argument may start with dashes", () => {
  assert.deepEqual(
    parseSigningArgs([
      "--pkcs11-config",
      "/t.cfg",
      "--avb-signing-helper",
      "/h",
      "--payload-signer",
      "/s",
      "--payload-signer-arg",
      "--key",
      "--payload-signer-arg",
      "ota",
      "--payload-signer-signature-size",
      "512",
    ]),
    {
      dryRun: false,
      pkcs11Config: "/t.cfg",
      avbSigningHelper: "/h",
      payloadSigner: "/s",
      payloadSignerArgs: ["--key", "ota"],
      payloadSignerSignatureSize: "512",
    },
  );
  assert.throws(
    () => parseSigningArgs(["--payload-signer-arg"]),
    /Use --target-files/,
  );
  assert.throws(
    () => parseSigningArgs(["--pkcs11-config", "/a", "--pkcs11-config", "/b"]),
    /Use --target-files/,
  );
});

test("only APKs packaged in the target-files need a release key mapping", async (t) => {
  const cts = apkcert(
    "CtsTestApp.apk",
    "cts/hostsidetests/appsecurity/certs/cts-testkey1.x509.pem",
  );
  const fixture = setup(t, { apkcerts: [...APKCERTS, cts] });
  const dry = await signRelease({ ...fixture.options, dryRun: true });
  assert.deepEqual(dry.problems, []);
  const packaged = setup(t, {
    apkcerts: [...APKCERTS, cts],
    files: {
      "SYSTEM/app/CtsTestApp/CtsTestApp.apk": { CERT: TEST_KEY_DIGEST },
    },
  });
  await refusedBeforeSigning(
    packaged,
    packaged.options,
    /APK CtsTestApp\.apk is signed with cts\/hostsidetests\/appsecurity\/certs\/cts-testkey1\.x509\.pem, which no release key mapping covers/,
  );
});

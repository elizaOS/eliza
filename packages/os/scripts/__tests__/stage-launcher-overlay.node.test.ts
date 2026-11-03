import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { crc32, deflateRawSync } from "node:zlib";
import { soongAppNativePatch } from "../android/soong-app-native.mjs";
import {
  createDevelopmentLauncherDescriptor,
  readNativeLibraries,
  renderNativeOverlay,
  renderOverlay,
  stageLauncher,
  validateCompanionInspection,
  validateDescriptor,
  validateInspection,
} from "../android/stage-launcher-overlay.ts";

test("development descriptor requires opt-in before reading files or invoking tools", () => {
  assert.throws(
    () =>
      createDevelopmentLauncherDescriptor({
        identity: descriptor,
        apk: "absent",
        apksigner: "must-not-run",
        development: false,
      }),
    /explicit development/,
  );
});

test("development descriptor verifies a private copy and refuses malformed or multiple signers", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "launcher-descriptor-test-"),
  );
  try {
    const apk = path.join(root, "original.apk"),
      tool = path.join(root, "signer"),
      record = path.join(root, "inspected");
    fs.writeFileSync(apk, "fixture-apk");
    fs.writeFileSync(
      tool,
      `#!${process.execPath}\nconst fs=require('node:fs');if(process.argv[2]!=='verify'||process.argv[3]!=='--print-certs')process.exit(2);fs.writeFileSync(process.env.RECORD,process.argv[4]);if(fs.readFileSync(process.argv[4],'utf8')!=='fixture-apk')process.exit(3);console.log(process.env.SIGNATURES);`,
      { mode: 0o700 },
    );
    const options = {
      identity: descriptor,
      apk,
      apksigner: tool,
      development: true,
      env: { ...process.env, RECORD: record, SIGNATURES: signer },
    };
    const result = createDevelopmentLauncherDescriptor(options);
    assert.equal(result.certificateSha256, descriptor.certificateSha256);
    assert.equal(
      result.apkSha256,
      createHash("sha256").update("fixture-apk").digest("hex"),
    );
    const inspected = fs.readFileSync(record, "utf8");
    assert.notEqual(inspected, apk);
    assert.equal(fs.existsSync(inspected), false);
    for (const signatures of [
      "",
      `${signer}\n${signer}`,
      `certificate SHA-256 digest: ${"b".repeat(64)}g`,
    ])
      assert.throws(
        () =>
          createDevelopmentLauncherDescriptor({
            ...options,
            env: { ...options.env, SIGNATURES: signatures },
          }),
        /valid launcher signer/,
      );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const descriptor = {
  schemaVersion: 1 as const,
  brand: "alpha_phone",
  moduleName: "AlphaPhone",
  packageName: "ai.elizaresearch.alphaphone",
  apkSha256: "a".repeat(64),
  certificateSha256: "b".repeat(64),
};
const badging = `package: name='${descriptor.packageName}'`;
const xml = `  E: activity\n    A: android:exported(0x01010010)=(type 0x12)0xffffffff\n    E: intent-filter\n      E: action\n        A: android:name="android.intent.action.MAIN"\n      E: category\n        A: android:name="android.intent.category.HOME"\n      E: category\n        A: android:name="android.intent.category.DEFAULT"`;
const signer = `Signer #1 certificate SHA-256 digest: ${descriptor.certificateSha256}`;
test("descriptor rejects code and path injection", () => {
  for (const field of [
    "brand",
    "moduleName",
    "packageName",
    "apkSha256",
    "certificateSha256",
  ])
    assert.throws(() =>
      validateDescriptor({ ...descriptor, [field]: '../evil"' }),
    );
  assert.throws(() => validateDescriptor(null));
  assert.throws(() => validateDescriptor({ ...descriptor, schemaVersion: 2 }));
  assert.deepEqual(validateDescriptor(descriptor), descriptor);
});
test("valid launcher remains additive and nonprivileged", () => {
  validateInspection(descriptor, badging, xml, signer, false);
  const generated = renderOverlay(descriptor);
  assert.match(generated.blueprint, /presigned: true/);
  assert.doesNotMatch(generated.blueprint, /privileged: true|overrides:/);
  assert.match(generated.product, /PRODUCT_PACKAGES \+= AlphaPhone/);
});
test("rejects wrong package, signer, multiple signers, missing HOME, and separated filters", () => {
  assert.throws(() =>
    validateInspection(descriptor, "package: name='wrong'", xml, signer, false),
  );
  assert.throws(() =>
    validateInspection(
      descriptor,
      badging,
      xml,
      signer.replaceAll("b", "c"),
      false,
    ),
  );
  assert.throws(() =>
    validateInspection(descriptor, badging, xml, `${signer}\n${signer}`, false),
  );
  assert.throws(() =>
    validateInspection(
      descriptor,
      badging,
      xml.replace("category.HOME", "category.LAUNCHER"),
      signer,
      false,
    ),
  );
  assert.throws(() =>
    validateInspection(
      descriptor,
      badging,
      xml.replace(
        "      E: category",
        "    E: intent-filter\n      E: category",
      ),
      signer,
      false,
    ),
  );
});
test("debug APK requires an explicit development lane", () => {
  const debugXml = `A: android:debuggable(0x0101000f)=(type 0x12)0xffffffff\n${xml}`;
  assert.throws(() =>
    validateInspection(descriptor, badging, debugXml, signer, false),
  );
  validateInspection(descriptor, badging, debugXml, signer, true);
});
test("digest mismatch stages nothing and never invokes SDK tools", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-test-"));
  try {
    const file = path.join(dir, "apk");
    fs.writeFileSync(file, "wrong");
    const descriptorPath = path.join(dir, "descriptor.json");
    fs.writeFileSync(descriptorPath, JSON.stringify(descriptor));
    assert.throws(
      () =>
        stageLauncher({
          descriptor: descriptorPath,
          apk: file,
          output: path.join(dir, "out"),
          aapt: "must-not-run",
          apksigner: "must-not-run",
          development: true,
        }),
      /hash mismatch/,
    );
    assert.equal(fs.existsSync(path.join(dir, "out")), false);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["apk", "descriptor.json"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects private, disabled and non-activity HOME filters", () => {
  for (const invalid of [
    xml.replace("0xffffffff", "0x0"),
    xml.replace("E: activity", "E: receiver"),
    xml.replace(
      "    E: intent-filter",
      "    A: android:enabled(0x0101000e)=(type 0x12)0x0\n    E: intent-filter",
    ),
  ])
    assert.throws(() =>
      validateInspection(descriptor, badging, invalid, signer, true),
    );
});

test("intent names must belong to the correct action and category elements", () => {
  for (const invalid of [
    xml.replace("E: action", "E: category"),
    xml.replaceAll("E: category", "E: action"),
    xml.replace(
      'android:name="android.intent.category.HOME',
      'android:label="android.intent.category.HOME',
    ),
  ])
    assert.throws(() =>
      validateInspection(descriptor, badging, invalid, signer, false),
    );
});

test("reviewed default permissions are declared by the APK and granted revocably", () => {
  const granted = {
    ...descriptor,
    defaultPermissions: [
      "android.permission.RECORD_AUDIO",
      "android.permission.POST_NOTIFICATIONS",
    ],
  };
  assert.deepEqual(validateDescriptor(granted), granted);
  for (const defaultPermissions of [
    [],
    ["android.permission.RECORD_AUDIO", "android.permission.RECORD_AUDIO"],
    ['android.permission.X"/><permission name="android.permission.Y'],
    ["com.example.permission.PRIVATE"],
    Array.from({ length: 33 }, (_, i) => `android.permission.P${i}`),
  ])
    assert.throws(
      () => validateDescriptor({ ...descriptor, defaultPermissions }),
      /Invalid default permissions/,
    );
  const declared = `${badging}\nuses-permission: name='android.permission.RECORD_AUDIO'\nuses-permission: name='android.permission.POST_NOTIFICATIONS'`;
  validateInspection(granted, declared, xml, signer, false);
  assert.throws(
    () => validateInspection(granted, badging, xml, signer, false),
    /does not declare android.permission.RECORD_AUDIO/,
  );
  const generated = renderOverlay(granted);
  assert.match(generated.blueprint, /prebuilt_etc \{/);
  assert.match(generated.blueprint, /sub_dir: "default-permissions"/);
  assert.match(
    generated.product,
    /PRODUCT_PACKAGES \+= AlphaPhone AlphaPhoneDefaultPermissions/,
  );
  assert.match(
    generated.permissions ?? "",
    /<exception package="ai.elizaresearch.alphaphone">/,
  );
  assert.equal(
    (generated.permissions ?? "").match(/fixed="false"/g)?.length,
    2,
  );
  assert.equal(renderOverlay(descriptor).permissions, null);
  assert.doesNotMatch(renderOverlay(descriptor).blueprint, /prebuilt_etc/);
});

// Explicit system placement avoids relying on the base product partition layout.
test("system-only launcher keeps the APK and revocable grants in the same image", () => {
  const d = {
    ...descriptor,
    partition: "system" as const,
    defaultPermissions: ["android.permission.RECORD_AUDIO"],
  };
  const generated = renderOverlay(d);
  assert.doesNotMatch(
    generated.blueprint,
    /product_specific|system_ext_specific|privileged:/,
  );
  assert.match(generated.blueprint, /android_app_import/);
  assert.match(generated.blueprint, /prebuilt_etc/);
  assert.ok(generated.permissions);
  assert.match(generated.permissions, /fixed="false"/);
  assert.equal(
    (
      renderOverlay({ ...d, partition: "product" }).blueprint.match(
        /product_specific: true/g,
      ) ?? []
    ).length,
    2,
  );
  assert.throws(
    () => validateDescriptor({ ...d, partition: "vendor" }),
    /partition/,
  );
  assert.throws(
    () => renderOverlay({ ...d, partition: "vendor" } as never),
    /partition/,
  );
});

// A second presigned package (for example an update supervisor) of the same product.
const updater = {
  moduleName: "AlphaPhoneUpdater",
  packageName: "ai.elizaresearch.alphaphone.updater",
  apkSha256: "c".repeat(64),
};
test("companions are pinned, distinct, and staged without grants or privilege", () => {
  const d = { ...descriptor, companions: [updater] };
  assert.deepEqual(validateDescriptor(d), d);
  for (const companions of [
    [],
    [{ ...updater, moduleName: descriptor.moduleName }],
    [{ ...updater, moduleName: "Launcher" }],
    [{ ...updater, moduleName: "AlphaPhoneDefaultPermissions" }],
    [{ ...updater, packageName: descriptor.packageName }],
    [updater, { ...updater, packageName: "ai.elizaresearch.other" }],
    [{ ...updater, apkSha256: "C".repeat(64) }],
    [{ ...updater, moduleName: 'X"/>' }],
    // A companion carries no grants and no signer of its own.
    [{ ...updater, defaultPermissions: ["android.permission.RECORD_AUDIO"] }],
    [{ ...updater, certificateSha256: "d".repeat(64) }],
  ])
    assert.throws(
      () => validateDescriptor({ ...descriptor, companions }),
      /Invalid companion/,
    );
  const generated = renderOverlay({
    ...d,
    defaultPermissions: ["android.permission.RECORD_AUDIO"],
  });
  assert.equal(generated.blueprint.match(/android_app_import \{/g)?.length, 2);
  assert.match(generated.blueprint, /apk: "AlphaPhoneUpdater\.apk"/);
  assert.equal(generated.blueprint.match(/product_specific: true/g)?.length, 3);
  assert.doesNotMatch(generated.blueprint, /privileged|overrides:/);
  assert.match(
    generated.product,
    /PRODUCT_PACKAGES \+= AlphaPhone AlphaPhoneDefaultPermissions AlphaPhoneUpdater\n/,
  );
  assert.doesNotMatch(generated.permissions ?? "", /updater/);
  assert.doesNotMatch(
    renderOverlay({ ...d, partition: "system" }).blueprint,
    /product_specific/,
  );
});
test("companion inspection requires its package, the launcher signer, and no HOME", () => {
  const d = { ...descriptor, companions: [updater] };
  const companionBadging = `package: name='${updater.packageName}'`;
  const service =
    "  E: service\n    A: android:exported(0x01010010)=(type 0x12)0xffffffff";
  validateCompanionInspection(
    d,
    updater,
    companionBadging,
    service,
    signer,
    false,
  );
  assert.throws(
    () =>
      validateCompanionInspection(d, updater, badging, service, signer, false),
    /package mismatch/,
  );
  assert.throws(
    () =>
      validateCompanionInspection(
        d,
        updater,
        companionBadging,
        service,
        signer.replaceAll("b", "c"),
        false,
      ),
    /signer differs/,
  );
  assert.throws(() =>
    validateCompanionInspection(
      d,
      updater,
      companionBadging,
      service,
      `${signer}\n${signer}`,
      false,
    ),
  );
  assert.throws(
    () =>
      validateCompanionInspection(
        d,
        updater,
        companionBadging,
        xml,
        signer,
        false,
      ),
    /must not be a launcher/,
  );
  for (const home of [
    xml.replace("E: activity", "E: activity-alias"),
    xml.replace(/ {4}A: android:exported[^\n]*\n/, ""),
  ]) {
    assert.throws(
      () =>
        validateCompanionInspection(
          d,
          updater,
          companionBadging,
          home,
          signer,
          false,
        ),
      /must not be a launcher/,
    );
  }
  const debug = `A: android:debuggable(0x0101000f)=(type 0x12)0xffffffff\n${service}`;
  assert.throws(
    () =>
      validateCompanionInspection(
        d,
        updater,
        companionBadging,
        debug,
        signer,
        false,
      ),
    /requires --development/,
  );
  validateCompanionInspection(
    d,
    updater,
    companionBadging,
    debug,
    signer,
    true,
  );
});
test("companion APKs must match the descriptor before any SDK tool runs", () => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "launcher-companion-test-"),
  );
  try {
    const launcher = path.join(dir, "launcher.apk");
    const companion = path.join(dir, "updater.apk");
    fs.writeFileSync(launcher, "launcher");
    fs.writeFileSync(companion, "wrong");
    const descriptorPath = path.join(dir, "descriptor.json");
    const sha = (text: string) =>
      createHash("sha256").update(text).digest("hex");
    fs.writeFileSync(
      descriptorPath,
      JSON.stringify({
        ...descriptor,
        apkSha256: sha("launcher"),
        companions: [{ ...updater, apkSha256: sha("updater") }],
      }),
    );
    const stage = (companions?: Record<string, string>) =>
      stageLauncher({
        descriptor: descriptorPath,
        apk: launcher,
        ...(companions ? { companions } : {}),
        output: path.join(dir, "out"),
        aapt: "must-not-run",
        apksigner: "must-not-run",
        development: true,
      });
    for (const companions of [
      undefined,
      {},
      { AlphaPhoneUpdater: companion, Other: companion },
    ])
      assert.throws(() => stage(companions), /exactly one APK/);
    assert.throws(
      () => stage({ AlphaPhoneUpdater: companion }),
      /AlphaPhoneUpdater APK hash mismatch/,
    );
    assert.deepEqual(fs.readdirSync(dir).sort(), [
      "descriptor.json",
      "launcher.apk",
      "updater.apk",
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A minimal APK-shaped ZIP: each entry stored unless `deflate` is set. */
function zip(entries: { name: string; data: Buffer; deflate?: boolean }[]) {
  const locals: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const { name, data, deflate } of entries) {
    const body = deflate ? deflateRawSync(data) : data;
    const file = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(file.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(deflate ? 8 : 0, 10);
    header.writeUInt32LE(crc32(data), 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(file.length, 28);
    header.writeUInt32LE(offset, 42);
    locals.push(local, file, body);
    central.push(header, file);
    offset += 30 + file.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
/** A little-endian ELF64 header for the machine, padded to a plausible library. */
function elf(machine: number, fill: string) {
  const data = Buffer.alloc(128, fill);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(data);
  data.writeUInt16LE(machine, 18);
  return data;
}
const arm64 = 0xb7;
const launcherApk = (
  extra: { name: string; data: Buffer; deflate?: boolean }[] = [],
) =>
  zip([
    {
      name: "AndroidManifest.xml",
      data: Buffer.from("manifest"),
      deflate: true,
    },
    { name: "classes.dex", data: Buffer.alloc(256, "d"), deflate: true },
    { name: "lib/arm64-v8a/libeliza_bun.so", data: elf(arm64, "b") },
    { name: "lib/arm64-v8a/libc++_shared.so", data: elf(arm64, "c") },
    {
      name: "lib/arm64-v8a/libeliza_ld_musl_aarch64.so",
      data: elf(arm64, "l"),
    },
    { name: "lib/x86_64/libother.so", data: elf(0x3e, "x"), deflate: true },
    ...extra,
  ]);

test("bundled JNI is read byte for byte from the stored lib/<abi> entries only", () => {
  const libraries = readNativeLibraries(launcherApk(), "arm64-v8a");
  assert.deepEqual(
    libraries.map((library) => library.name),
    ["libc++_shared.so", "libeliza_bun.so", "libeliza_ld_musl_aarch64.so"],
  );
  assert.deepEqual(libraries[1]?.data, elf(arm64, "b"));
  assert.equal(
    libraries[1]?.sha256,
    createHash("sha256").update(elf(arm64, "b")).digest("hex"),
  );
  // The x86_64 entry is compressed, so the other ABI is never accepted silently.
  assert.throws(
    () => readNativeLibraries(launcherApk(), "x86_64"),
    /compressed/,
  );
  for (const [extra, message] of [
    [
      { name: "lib/arm64-v8a/libz.so", data: elf(arm64, "z"), deflate: true },
      /compressed/,
    ],
    [
      { name: "lib/arm64-v8a/libz.so", data: elf(0x3e, "z") },
      /ELF64 arm64-v8a/,
    ],
    [
      { name: "lib/arm64-v8a/sub/libz.so", data: elf(arm64, "z") },
      /unexpected native path/,
    ],
    [
      { name: "lib/arm64-v8a/run.sh", data: elf(arm64, "z") },
      /unexpected native path/,
    ],
    [
      { name: "lib/arm64-v8a/libeliza_bun.so", data: elf(arm64, "b") },
      /repeats/,
    ],
  ] as const)
    assert.throws(
      () => readNativeLibraries(launcherApk([extra]), "arm64-v8a"),
      message,
    );
  const tampered = launcherApk();
  const flipped = tampered.indexOf(elf(arm64, "c")) + 100;
  tampered.writeUInt8((tampered.readUInt8(flipped) ^ 1) & 0xff, flipped);
  assert.throws(
    () => readNativeLibraries(tampered, "arm64-v8a"),
    /does not match its CRC/,
  );
  assert.throws(
    () =>
      readNativeLibraries(
        zip([{ name: "classes.dex", data: Buffer.alloc(64) }]),
        "arm64-v8a",
      ),
    /no lib\/arm64-v8a\/ libraries/,
  );
  assert.throws(() =>
    readNativeLibraries(Buffer.from("not a zip"), "arm64-v8a"),
  );
  assert.throws(
    () => readNativeLibraries(launcherApk(), "toString" as never),
    /Unsupported native ABI/,
  );
});

test("the launcher moves to Android.mk with its JNI; grants and companions stay in Soong", () => {
  const d = {
    ...descriptor,
    defaultPermissions: ["android.permission.RECORD_AUDIO"],
    companions: [
      {
        moduleName: "AlphaPhoneUpdater",
        packageName: "ai.elizaresearch.alphaphone.updater",
        apkSha256: "c".repeat(64),
      },
    ],
  };
  const libraries = readNativeLibraries(launcherApk(), "arm64-v8a");
  const native = renderNativeOverlay(d, "arm64-v8a", libraries);
  assert.ok(native.makefile !== null);
  assert.equal(native.directory, "native-arm64");
  assert.doesNotMatch(native.blueprint, /name: "AlphaPhone",/);
  assert.match(native.blueprint, /name: "AlphaPhoneUpdater"/);
  assert.match(native.blueprint, /name: "AlphaPhoneDefaultPermissions"/);
  assert.match(native.makefile, /^LOCAL_MODULE := AlphaPhone$/m);
  assert.match(native.makefile, /^LOCAL_CERTIFICATE := PRESIGNED$/m);
  assert.match(native.makefile, /^LOCAL_PRODUCT_MODULE := true$/m);
  assert.match(native.makefile, /^LOCAL_MODULE_TARGET_ARCH := arm64$/m);
  assert.match(
    native.makefile,
    /^LOCAL_PREBUILT_JNI_LIBS := native-arm64\/libc\+\+_shared\.so native-arm64\/libeliza_bun\.so native-arm64\/libeliza_ld_musl_aarch64\.so$/m,
  );
  assert.doesNotMatch(native.makefile, /PRIVILEGED|LOCAL_OVERRIDES/);
  assert.match(
    native.product,
    /PRODUCT_PACKAGES \+= AlphaPhone AlphaPhoneDefaultPermissions AlphaPhoneUpdater\n/,
  );
  assert.match(
    native.product,
    /TARGET_FS_CONFIG_GEN \+= \$\(launcher_native_dir\)\/config\.fs/,
  );
  assert.match(
    native.config,
    /\[product\/app\/AlphaPhone\/lib\/arm64\/libeliza_bun\.so\]\nmode: 0755\n/,
  );
  assert.match(
    native.config,
    /\[product\/app\/AlphaPhone\/lib\/arm64\/libeliza_ld_musl_aarch64\.so\]\nmode: 0755\n/,
  );
  assert.match(
    native.config,
    /\[product\/app\/AlphaPhone\/lib\/arm64\/libc\+\+_shared\.so\]\nmode: 0644\n/,
  );
  assert.equal(native.report.runtimeAdmitted, false);
  assert.equal(native.report.deployReady, false);
  assert.equal(native.report.libraries[1]?.sha256, libraries[1]?.sha256);
  const system = renderNativeOverlay(
    { ...descriptor, partition: "system" },
    "arm64-v8a",
    libraries,
  );
  assert.ok(system.makefile !== null);
  assert.doesNotMatch(system.makefile, /LOCAL_PRODUCT_MODULE/);
  assert.match(
    system.config,
    /^\[system\/app\/AlphaPhone\/lib\/arm64\/libeliza_bun\.so\]$/m,
  );
  assert.equal(
    system.blueprint,
    "// The launcher AlphaPhone is in Android.mk, which installs its bundled JNI.\n",
  );
  for (const invalid of [[], [{ name: "../libx.so", sha256: "a".repeat(64) }]])
    assert.throws(
      () => renderNativeOverlay(descriptor, "arm64-v8a", invalid),
      /Invalid native library list/,
    );
});

test("staging with a native ABI writes the pinned JNI beside the launcher, or nothing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-native-test-"));
  try {
    const tool = path.join(dir, "tool");
    fs.writeFileSync(
      tool,
      `#!${process.execPath}\nconst a=process.argv.slice(2);if(a[0]==='verify')console.log(process.env.SIGNATURES);else if(a[1]==='badging')console.log(process.env.BADGING);else console.log(process.env.XML);`,
      { mode: 0o700 },
    );
    const env = {
      ...process.env,
      SIGNATURES: signer,
      BADGING: badging,
      XML: xml,
    };
    const stage = (bytes: Buffer, output: string) => {
      const apk = path.join(dir, `${output}.apk`);
      fs.writeFileSync(apk, bytes);
      const descriptorPath = path.join(dir, `${output}.json`);
      fs.writeFileSync(
        descriptorPath,
        JSON.stringify({
          ...descriptor,
          apkSha256: createHash("sha256").update(bytes).digest("hex"),
        }),
      );
      return stageLauncher({
        descriptor: descriptorPath,
        apk,
        output: path.join(dir, output),
        aapt: tool,
        apksigner: tool,
        development: false,
        nativeAbi: "arm64-v8a",
        env,
      });
    };
    const bytes = launcherApk();
    const output = stage(bytes, "out");
    assert.deepEqual(fs.readdirSync(output).sort(), [
      "Android.bp",
      "Android.mk",
      "Launcher.apk",
      "config.fs",
      "launcher.json",
      "native-arm64",
      "native-libraries.json",
      "product.mk",
    ]);
    assert.deepEqual(fs.readFileSync(path.join(output, "Launcher.apk")), bytes);
    assert.deepEqual(
      fs.readFileSync(path.join(output, "native-arm64", "libeliza_bun.so")),
      elf(arm64, "b"),
    );
    const report = JSON.parse(
      fs.readFileSync(path.join(output, "native-libraries.json"), "utf8"),
    );
    assert.equal(report.libraries.length, 3);
    assert.equal(report.installRule, "android-mk");
    assert.equal(
      report.apkSha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    assert.throws(
      () =>
        stage(
          launcherApk([
            {
              name: "lib/arm64-v8a/libz.so",
              data: elf(arm64, "z"),
              deflate: true,
            },
          ]),
          "refused",
        ),
      /compressed/,
    );
    assert.equal(fs.existsSync(path.join(dir, "refused")), false);
    assert.equal(
      fs.readdirSync(dir).some((name) => name.startsWith(".launcher-stage-")),
      false,
    );
    assert.throws(
      () =>
        stageLauncher({
          descriptor: path.join(dir, "out.json"),
          apk: path.join(dir, "out.apk"),
          output: path.join(dir, "other"),
          aapt: "must-not-run",
          apksigner: "must-not-run",
          development: false,
          nativeAbi: "armeabi-v7a" as never,
        }),
      /Unsupported native ABI/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a Soong-only product gets prebuilt_app_native rules required by the launcher", () => {
  const d = {
    ...descriptor,
    defaultPermissions: ["android.permission.RECORD_AUDIO"],
    companions: [
      {
        moduleName: "AlphaPhoneUpdater",
        packageName: "ai.elizaresearch.alphaphone.updater",
        apkSha256: "c".repeat(64),
      },
    ],
  };
  const libraries = readNativeLibraries(launcherApk(), "arm64-v8a");
  const make = renderNativeOverlay(d, "arm64-v8a", libraries);
  const native = renderNativeOverlay(d, "arm64-v8a", libraries, "soong");
  assert.equal(native.makefile, null);
  // Same install paths, modes and bytes as the Android.mk rule.
  assert.equal(native.config, make.config);
  assert.equal(native.product, make.product);
  assert.deepEqual(native.report.libraries, make.report.libraries);
  assert.equal(native.report.installRule, "soong-app-native");
  const patch = soongAppNativePatch();
  assert.deepEqual(native.report.soongPatch, {
    name: "soong-app-native",
    manifestSha256: patch.manifestSha256,
    project: "build/soong",
    revision: patch.manifest.revision,
    files: patch.manifest.files,
  });
  assert.equal(make.report.soongPatch, undefined);
  assert.equal(native.report.runtimeAdmitted, false);
  assert.equal(native.report.deployReady, false);
  const launcher =
    /android_app_import \{\n {4}name: "AlphaPhone",\n[\s\S]*?\n\}\n/.exec(
      native.blueprint,
    )?.[0];
  assert.ok(launcher, native.blueprint);
  assert.match(launcher, /^ {4}presigned: true,$/m);
  assert.match(launcher, /^ {4}preprocessed: true,$/m);
  assert.match(launcher, /^ {4}product_specific: true,$/m);
  assert.match(
    launcher,
    /^ {4}required: \["AlphaPhone_native_0", "AlphaPhone_native_1", "AlphaPhone_native_2"\],$/m,
  );
  assert.doesNotMatch(native.blueprint, /privileged|prebuilt_any|overrides/);
  const modules = [
    ...native.blueprint.matchAll(/prebuilt_app_native \{\n([^}]*)\}/g),
  ].map((match) => match[1]);
  assert.deepEqual(
    modules,
    libraries.map(
      (library, index) =>
        `    name: "AlphaPhone_native_${index}",\n    src: "native-arm64/${library.name}",\n    filename: "${library.name}",\n    relative_install_path: "AlphaPhone/lib/arm64",\n    product_specific: true,\n`,
    ),
  );
  // Grants and companions are unchanged from the plain overlay.
  assert.ok(
    native.blueprint.endsWith(make.blueprint.split("\n").slice(1).join("\n")),
  );
  assert.match(native.blueprint, /name: "AlphaPhoneDefaultPermissions"/);
  assert.match(native.blueprint, /name: "AlphaPhoneUpdater"/);

  const system = renderNativeOverlay(
    { ...descriptor, partition: "system" },
    "x86_64",
    [{ name: "libeliza_bun.so", sha256: "a".repeat(64) }],
    "soong",
  );
  assert.doesNotMatch(system.blueprint, /product_specific/);
  assert.match(
    system.blueprint,
    /relative_install_path: "AlphaPhone\/lib\/x86_64",\n\}/,
  );
  assert.match(
    system.config,
    /^\[system\/app\/AlphaPhone\/lib\/x86_64\/libeliza_bun\.so\]\nmode: 0755$/m,
  );
  assert.throws(
    () =>
      renderNativeOverlay(descriptor, "arm64-v8a", libraries, "bazel" as never),
    /Unsupported native install rule/,
  );
});

test("staging for a Soong-only product writes no Android.mk, or nothing on refusal", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-soong-test-"));
  try {
    const tool = path.join(dir, "tool");
    fs.writeFileSync(
      tool,
      `#!${process.execPath}\nconst a=process.argv.slice(2);if(a[0]==='verify')console.log(process.env.SIGNATURES);else if(a[1]==='badging')console.log(process.env.BADGING);else console.log(process.env.XML);`,
      { mode: 0o700 },
    );
    const env = {
      ...process.env,
      SIGNATURES: signer,
      BADGING: badging,
      XML: xml,
    };
    const bytes = launcherApk();
    const apk = path.join(dir, "launcher.apk");
    fs.writeFileSync(apk, bytes);
    const descriptorPath = path.join(dir, "launcher.json");
    fs.writeFileSync(
      descriptorPath,
      JSON.stringify({
        ...descriptor,
        apkSha256: createHash("sha256").update(bytes).digest("hex"),
      }),
    );
    const output = stageLauncher({
      descriptor: descriptorPath,
      apk,
      output: path.join(dir, "out"),
      aapt: tool,
      apksigner: tool,
      development: false,
      nativeAbi: "arm64-v8a",
      nativeInstall: "soong",
      env,
    });
    assert.deepEqual(fs.readdirSync(output).sort(), [
      "Android.bp",
      "Launcher.apk",
      "config.fs",
      "launcher.json",
      "native-arm64",
      "native-libraries.json",
      "product.mk",
    ]);
    const blueprint = fs.readFileSync(path.join(output, "Android.bp"), "utf8");
    for (const library of fs.readdirSync(path.join(output, "native-arm64"))) {
      assert.match(
        blueprint,
        new RegExp(
          `src: "native-arm64/${library.replaceAll(".", "\\.").replaceAll("+", "\\+")}"`,
        ),
      );
    }
    assert.deepEqual(
      fs.readFileSync(path.join(output, "native-arm64", "libeliza_bun.so")),
      elf(arm64, "b"),
    );
    const report = JSON.parse(
      fs.readFileSync(path.join(output, "native-libraries.json"), "utf8"),
    );
    assert.equal(report.installRule, "soong-app-native");
    assert.equal(
      report.soongPatch.manifestSha256,
      soongAppNativePatch().manifestSha256,
    );
    for (const [options, message] of [
      [{ nativeInstall: "soong" }, /requires a native ABI/],
      [
        { nativeAbi: "arm64-v8a", nativeInstall: "ninja" },
        /Unsupported native install rule/,
      ],
    ] as const)
      assert.throws(
        () =>
          stageLauncher({
            descriptor: descriptorPath,
            apk,
            output: path.join(dir, "refused"),
            aapt: "must-not-run",
            apksigner: "must-not-run",
            development: false,
            ...(options as object),
          }),
        message,
      );
    assert.equal(fs.existsSync(path.join(dir, "refused")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
/** Validate a downstream HOME APK and stage an additive AOSP product overlay.
 * An optional reviewed list of runtime permissions is granted on first boot.
 * With a native ABI, the launcher's stored lib/<abi> libraries are installed beside it,
 * through Android.mk or, for a Soong-only product, the reviewed soong-app-native rule.
 * This does not claim agent payload, privileged permissions, default HOME policy,
 * image boot, or release qualification. The caller owns those separate gates.
 * Companion APKs (for example an update supervisor) are staged beside it only when
 * they carry the launcher's signer; they get no grants and no privileged placement.
 * Pinned browser and vault APKs are staged by stage-browser-apps.ts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";
import { soongAppNativePatch } from "./soong-app-native.mjs";

/** A second presigned package of the same product, pinned by hash. Its signer pin is
 * the launcher's certificateSha256, so a companion cannot carry another signer. */
export interface CompanionDescriptor {
  moduleName: string;
  packageName: string;
  apkSha256: string;
}
export interface LauncherDescriptor {
  schemaVersion: 1;
  brand: string;
  moduleName: string;
  packageName: string;
  apkSha256: string;
  certificateSha256: string;
  /**
   * Runtime permissions the image grants this launcher on first boot, through
   * a product default-permissions file. Each must be declared by the APK.
   */
  defaultPermissions?: string[];
  /** Default: product. A system-only GSI must carry both APK and grants in system. */
  partition?: "product" | "system";
  /** Same-signer packages staged in the same partition, without grants or HOME. */
  companions?: CompanionDescriptor[];
}
const MODULE = /^[A-Z][A-Za-z0-9]*$/;
const PACKAGE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const PERMISSION = /^android\.permission\.[A-Z][A-Z0-9_]{0,63}$/;
export function validateDescriptor(value: unknown): LauncherDescriptor {
  if (!value || typeof value !== "object")
    throw new Error("Launcher descriptor must be an object");
  const d = value as LauncherDescriptor;
  for (const key of [
    "brand",
    "moduleName",
    "packageName",
    "apkSha256",
    "certificateSha256",
  ] as const) {
    if (typeof d[key] !== "string") throw new Error(`Missing string ${key}`);
  }
  if (d.schemaVersion !== 1)
    throw new Error("Unsupported launcher descriptor version");
  if (!/^[a-z][a-z0-9_]*$/.test(d.brand))
    throw new Error("Invalid launcher brand");
  if (!MODULE.test(d.moduleName)) throw new Error("Invalid module name");
  if (!PACKAGE.test(d.packageName)) throw new Error("Invalid package name");
  for (const key of ["apkSha256", "certificateSha256"] as const) {
    if (!SHA256.test(d[key])) throw new Error(`Invalid ${key}`);
  }
  if (
    d.defaultPermissions !== undefined &&
    (!Array.isArray(d.defaultPermissions) ||
      !d.defaultPermissions.length ||
      d.defaultPermissions.length > 32 ||
      new Set(d.defaultPermissions).size !== d.defaultPermissions.length ||
      d.defaultPermissions.some(
        (permission) =>
          typeof permission !== "string" || !PERMISSION.test(permission),
      ))
  )
    throw new Error("Invalid default permissions");
  if (d.partition !== undefined && !["product", "system"].includes(d.partition))
    throw new Error("Invalid launcher partition");
  if (d.companions !== undefined) {
    if (!Array.isArray(d.companions) || !d.companions.length)
      throw new Error("Invalid companions");
    // Staged file and Soong module names must not collide with the launcher's.
    const modules = new Set([
      d.moduleName,
      `${d.moduleName}DefaultPermissions`,
      "Launcher",
    ]);
    const packages = new Set([d.packageName]);
    for (const c of d.companions) {
      if (
        !c ||
        typeof c !== "object" ||
        Object.keys(c).sort().join() !== "apkSha256,moduleName,packageName" ||
        typeof c.moduleName !== "string" ||
        typeof c.packageName !== "string" ||
        typeof c.apkSha256 !== "string" ||
        !MODULE.test(c.moduleName) ||
        !PACKAGE.test(c.packageName) ||
        !SHA256.test(c.apkSha256) ||
        modules.has(c.moduleName) ||
        packages.has(c.packageName)
      )
        throw new Error("Invalid companion");
      modules.add(c.moduleName);
      packages.add(c.packageName);
    }
  }
  return d;
}

function launcherSigner(signatures: string): string {
  const certificates = [
    ...signatures.matchAll(/certificate SHA-256 digest:\s*(\S+)/g),
  ].map((match) => match[1].replaceAll(":", "").toLowerCase());
  if (certificates.length !== 1 || !/^[a-f0-9]{64}$/.test(certificates[0]))
    throw new Error("Exactly one valid launcher signer is required");
  return certificates[0];
}

/** Self-selecting an APK signer is allowed only for explicit development staging.
 * Production still requires an independently reviewed descriptor. Inspect a
 * private copy; stageLauncher rechecks the actual staged bytes against this pin.
 */
export function createDevelopmentLauncherDescriptor(options: {
  identity: Pick<LauncherDescriptor, "brand" | "moduleName" | "packageName">;
  apk: string;
  apksigner: string;
  development: boolean;
  env?: NodeJS.ProcessEnv;
}): LauncherDescriptor {
  if (options.development !== true)
    throw new Error("Descriptor generation requires explicit development mode");
  const identity = validateDescriptor({
    schemaVersion: 1,
    brand: options.identity.brand,
    moduleName: options.identity.moduleName,
    packageName: options.identity.packageName,
    apkSha256: "0".repeat(64),
    certificateSha256: "0".repeat(64),
  });
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "launcher-descriptor-"),
  );
  try {
    const apk = path.join(temporary, "Launcher.apk");
    fs.copyFileSync(options.apk, apk);
    const apkSha256 = createHash("sha256")
      .update(fs.readFileSync(apk))
      .digest("hex");
    const signatures = execFileSync(
      options.apksigner,
      ["verify", "--print-certs", apk],
      {
        encoding: "utf8",
        env: options.env,
        timeout: 30000,
      },
    );
    return {
      ...identity,
      apkSha256,
      certificateSha256: launcherSigner(signatures),
    };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
/** True when one eligible exported activity has MAIN/HOME/DEFAULT together.
 * A receiver or a private/disabled activity does not qualify as a launcher. */
function hasHomeActivity(xml: string, anyHomeDeclaration = false): boolean {
  interface ManifestElement {
    indent: number;
    name: string;
    attributes: string[];
    children: ManifestElement[];
    parent?: ManifestElement;
  }
  const elements: ManifestElement[] = [];
  const ancestors: ManifestElement[] = [];
  for (const line of xml.split("\n")) {
    const match = /^(\s*)E: ([\w-]+)/.exec(line);
    if (!match) {
      if (/^\s*A:/.test(line)) ancestors.at(-1)?.attributes.push(line);
      continue;
    }
    const indent = match[1].length;
    while ((ancestors.at(-1)?.indent ?? -1) >= indent) ancestors.pop();
    const parent = ancestors.at(-1);
    const element: ManifestElement = {
      indent,
      name: match[2],
      attributes: [],
      children: [],
      parent,
    };
    parent?.children.push(element);
    elements.push(element);
    ancestors.push(element);
  }
  const disabled = (element: ManifestElement) =>
    element.attributes.some((attribute) =>
      /android:enabled[^\n]*\)0x0(?:\s|$)/.test(attribute),
    );
  const named = (element: ManifestElement, name: string) =>
    element.attributes.some(
      (attribute) =>
        /^\s*A: android:name(?:\([^)]*\))?=/.test(attribute) &&
        attribute.includes(`"${name}"`),
    );
  return elements.some((filter) => {
    const activity = filter.parent;
    if (filter.name !== "intent-filter") return false;
    // Companion packages must not declare HOME, including aliases and older
    // manifests whose exported state is implicit. They may become enabled later.
    if (anyHomeDeclaration)
      return (
        ["activity", "activity-alias"].includes(activity?.name ?? "") &&
        filter.children.some(
          (child) =>
            child.name === "category" &&
            named(child, "android.intent.category.HOME"),
        )
      );
    if (activity?.name !== "activity") return false;
    if (
      !activity.attributes.some((attribute) =>
        /android:exported[^\n]*0xffffffff/.test(attribute),
      ) ||
      disabled(activity)
    )
      return false;
    for (let parent = activity.parent; parent; parent = parent.parent) {
      if (parent.name === "application" && disabled(parent)) return false;
    }
    return (
      filter.children.some(
        (child) =>
          child.name === "action" && named(child, "android.intent.action.MAIN"),
      ) &&
      ["android.intent.category.HOME", "android.intent.category.DEFAULT"].every(
        (category) =>
          filter.children.some(
            (child) => child.name === "category" && named(child, category),
          ),
      )
    );
  });
}
const DEBUGGABLE = /android:debuggable[^\n]*0xffffffff/;
export function validateInspection(
  d: LauncherDescriptor,
  badging: string,
  xml: string,
  signatures: string,
  development: boolean,
) {
  if (/package: name='([^']+)'/.exec(badging)?.[1] !== d.packageName)
    throw new Error("Launcher package mismatch");
  if (!hasHomeActivity(xml))
    throw new Error("APK is not a MAIN/HOME/DEFAULT launcher");
  if (!development && DEBUGGABLE.test(xml))
    throw new Error("Debug launcher requires --development");
  if (launcherSigner(signatures) !== d.certificateSha256)
    throw new Error("Launcher signer mismatch or multiple signers");
  const declared = new Set(
    [...badging.matchAll(/^uses-permission: name='([^']+)'/gm)].map(
      (match) => match[1],
    ),
  );
  for (const permission of d.defaultPermissions ?? [])
    if (!declared.has(permission))
      throw new Error(`Launcher does not declare ${permission}`);
}
/** A companion must be the pinned package, carry exactly the launcher's signer and
 * offer no second HOME activity. */
export function validateCompanionInspection(
  d: LauncherDescriptor,
  companion: CompanionDescriptor,
  badging: string,
  xml: string,
  signatures: string,
  development: boolean,
) {
  const name = companion.moduleName;
  if (/package: name='([^']+)'/.exec(badging)?.[1] !== companion.packageName)
    throw new Error(`${name} package mismatch`);
  if (hasHomeActivity(xml, true))
    throw new Error(`${name} must not be a launcher`);
  if (!development && DEBUGGABLE.test(xml))
    throw new Error(`Debug ${name} requires --development`);
  if (launcherSigner(signatures) !== d.certificateSha256)
    throw new Error(`${name} signer differs from the launcher signer`);
}
export function renderOverlay(d: LauncherDescriptor) {
  validateDescriptor(d);
  const partitionProperty =
    d.partition === "system" ? "" : "    product_specific: true,\n";
  const permissionsModule = `${d.moduleName}DefaultPermissions`;
  const permissions = d.defaultPermissions?.length
    ? `<?xml version="1.0" encoding="utf-8"?>\n<!-- Generated from the reviewed launcher descriptor. -->\n<exceptions>\n    <exception package="${d.packageName}">\n${d.defaultPermissions.map((permission) => `        <permission name="${permission}" fixed="false"/>\n`).join("")}    </exception>\n</exceptions>\n`
    : null;
  const app = (name: string, apk: string) =>
    `android_app_import {\n    name: "${name}",\n    apk: "${apk}",\n    presigned: true,\n    preprocessed: true,\n${partitionProperty}    dex_preopt: { enabled: false },\n}\n`;
  const companions = d.companions ?? [];
  return {
    blueprint: `// Generated from a hash- and signer-verified downstream launcher.\n${app(d.moduleName, "Launcher.apk")}${permissions ? `\n// First-boot runtime grants the person can still revoke (fixed="false").\nprebuilt_etc {\n    name: "${permissionsModule}",\n    src: "default-permissions.xml",\n    sub_dir: "default-permissions",\n    filename: "default-permissions-${d.packageName}.xml",\n${partitionProperty}}\n` : ""}${companions.map((c) => `\n// Companion ${c.packageName}: same signer as the launcher, no grants.\n${app(c.moduleName, `${c.moduleName}.apk`)}`).join("")}`,
    product: `# Additive: default HOME selection and privilege policy belong to device provisioning.\nPRODUCT_PACKAGES += ${[d.moduleName, ...(permissions ? [permissionsModule] : []), ...companions.map((c) => c.moduleName)].join(" ")}\n`,
    permissions,
  };
}
/** Android ABIs a launcher's bundled JNI can be installed for, never inferred from a fat APK. */
export const NATIVE_TARGETS = {
  "arm64-v8a": { arch: "arm64", machine: 0xb7, musl: "aarch64" },
  x86_64: { arch: "x86_64", machine: 0x3e, musl: "x86_64" },
} as const;
export type NativeAbi = keyof typeof NATIVE_TARGETS;
/**
 * How the image installs the bundled JNI. `make`: Android.mk's `LOCAL_PREBUILT_JNI_LIBS`,
 * which a product that still reads Android.mk honours. `soong`: one `prebuilt_app_native`
 * module per library, `required` by the `android_app_import`, for products that ignore
 * Android.mk (`PRODUCT_SOONG_ONLY`, as Android 17 Cuttlefish sets through
 * `RELEASE_SOONG_ONLY_CUTTLEFISH`). That module type is the reviewed build/soong patch
 * `patches/soong-app-native`, which the consumer applies in its AOSP checkout.
 */
export const NATIVE_INSTALLS = ["make", "soong"] as const;
export type NativeInstall = (typeof NATIVE_INSTALLS)[number];
const JNI_NAME = /^lib[A-Za-z0-9_.+-]+\.so$/;
const MAX_JNI_BYTES = 1024 ** 3;

/**
 * The stored `lib/<abi>/*.so` entries of an already hash-pinned APK, byte for byte.
 * Android never extracts a bundled app's libraries, so the image must carry them beside
 * the APK for `nativeLibraryDir`. Every entry must be stored (as `preprocessed` already
 * requires), a flat library name, a little-endian ELF64 for the ABI and match its CRC.
 */
export function readNativeLibraries(bytes: Buffer, abi: NativeAbi) {
  if (!Object.hasOwn(NATIVE_TARGETS, abi))
    throw new Error("Unsupported native ABI");
  const target = NATIVE_TARGETS[abi];
  const fail = (message: string): never => {
    throw new Error(`Launcher native libraries: ${message}`);
  };
  let eocd = -1;
  for (
    let at = bytes.length - 22;
    at >= Math.max(0, bytes.length - 22 - 0xffff);
    at--
  )
    if (bytes.readUInt32LE(at) === 0x06054b50) {
      eocd = at;
      break;
    }
  if (eocd < 0) fail("the APK has no end-of-central-directory record");
  const count = bytes.readUInt16LE(eocd + 10),
    size = bytes.readUInt32LE(eocd + 12),
    offset = bytes.readUInt32LE(eocd + 16);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff)
    fail("ZIP64 APKs are not admitted");
  if (offset + size > eocd) fail("the central directory is outside the APK");
  const prefix = `lib/${abi}/`;
  const names = new Set<string>();
  const libraries: { name: string; data: Buffer; sha256: string }[] = [];
  let at = offset;
  for (let index = 0; index < count; index++) {
    if (at + 46 > offset + size || bytes.readUInt32LE(at) !== 0x02014b50)
      fail("the central directory is malformed");
    const flags = bytes.readUInt16LE(at + 8),
      method = bytes.readUInt16LE(at + 10),
      crc = bytes.readUInt32LE(at + 16),
      compressed = bytes.readUInt32LE(at + 20),
      uncompressed = bytes.readUInt32LE(at + 24),
      nameLength = bytes.readUInt16LE(at + 28),
      extraLength = bytes.readUInt16LE(at + 30),
      commentLength = bytes.readUInt16LE(at + 32),
      local = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    at += 46 + nameLength + extraLength + commentLength;
    if (names.has(name)) fail(`the APK repeats ${name}`);
    names.add(name);
    if (!name.startsWith(prefix)) continue;
    const file = name.slice(prefix.length);
    if (!JNI_NAME.test(file)) fail(`unexpected native path ${name}`);
    if (flags & 0x1) fail(`${name} is encrypted`);
    if (method !== 0 || compressed !== uncompressed)
      fail(`${name} is compressed; the image installs stored libraries only`);
    if (uncompressed < 64 || uncompressed > MAX_JNI_BYTES)
      fail(`${name} has an implausible size`);
    if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50)
      fail(`${name} has no local header`);
    const start =
      local +
      30 +
      bytes.readUInt16LE(local + 26) +
      bytes.readUInt16LE(local + 28);
    if (start + compressed > offset) fail(`${name} is truncated`);
    const data = bytes.subarray(start, start + compressed);
    if (crc32(data) !== crc) fail(`${name} does not match its CRC`);
    if (
      data.readUInt32BE(0) !== 0x7f454c46 ||
      data[4] !== 2 ||
      data[5] !== 1 ||
      data.readUInt16LE(18) !== target.machine
    )
      fail(`${name} is not a little-endian ELF64 ${abi} library`);
    libraries.push({
      name: file,
      data,
      sha256: createHash("sha256").update(data).digest("hex"),
    });
  }
  if (!libraries.length) fail(`the APK has no ${prefix} libraries`);
  return libraries.sort((a, b) => (a.name < b.name ? -1 : 1));
}

/**
 * Build rules that install the pinned launcher with its bundled JNI beside it.
 * AOSP's supported prebuilt app rule (`LOCAL_PREBUILT_JNI_LIBS` with `BUILD_PREBUILT`)
 * installs the libraries in `<partition>/app/<module>/lib/<arch>` and keeps the presigned
 * APK unchanged; Soong's `android_app_import` installs none. The rest of the overlay
 * (grants, companions) stays in Soong. With `install: "soong"` the launcher stays an
 * `android_app_import` that `required`s one `prebuilt_app_native` per library, installed
 * at the same path (the rules stage-android-native.py's `finalize_soong` writes).
 * `config.fs` gives the shared Eliza runtime's loader and Bun their executable mode
 * (the table in stage-android-native.py); every other library is 0644 as for any app.
 */
export function renderNativeOverlay(
  d: LauncherDescriptor,
  abi: NativeAbi,
  libraries: { name: string; sha256: string }[],
  install: NativeInstall = "make",
) {
  validateDescriptor(d);
  if (!Object.hasOwn(NATIVE_TARGETS, abi))
    throw new Error("Unsupported native ABI");
  if (!NATIVE_INSTALLS.includes(install))
    throw new Error("Unsupported native install rule");
  const target = NATIVE_TARGETS[abi];
  if (!libraries.length || libraries.some((l) => !JNI_NAME.test(l.name)))
    throw new Error("Invalid native library list");
  const full = renderOverlay(d);
  const { defaultPermissions: _grants, companions: _companions, ...alone } = d;
  const main = renderOverlay(alone).blueprint;
  if (!full.blueprint.startsWith(main))
    throw new Error("Cannot separate the launcher module");
  const partition = d.partition ?? "product";
  const executables = new Set([
    "libeliza_bun.so",
    `libeliza_ld_musl_${target.musl}.so`,
    `libeliza_ld_musl_${target.musl}_real.so`,
  ]);
  const directory = `native-${target.arch}`;
  const records = libraries.map((library) => ({
    apkEntry: `lib/${abi}/${library.name}`,
    path: `${directory}/${library.name}`,
    installPath: `/${partition}/app/${d.moduleName}/lib/${target.arch}/${library.name}`,
    mode: executables.has(library.name) ? "0755" : "0644",
    sha256: library.sha256,
  }));
  const rest = full.blueprint.slice(main.length);
  // Module names with "_" cannot collide: launcher and companion names are [A-Za-z0-9].
  const nativeModules = records.map((_, i) => `${d.moduleName}_native_${i}`);
  const partitionProperty =
    partition === "product" ? "    product_specific: true,\n" : "";
  const patch = install === "soong" ? soongAppNativePatch() : null;
  const soongBlueprint = () => {
    const launcher = main.replace(
      "    dex_preopt:",
      `    required: [${nativeModules.map((m) => `"${m}"`).join(", ")}],\n    dex_preopt:`,
    );
    if (launcher === main) throw new Error("Cannot extend the launcher module");
    return `${launcher.replace(
      "// Generated from a hash- and signer-verified downstream launcher.\n",
      `// Generated from a hash- and signer-verified downstream launcher and its bundled ${abi} JNI.\n// prebuilt_app_native is the reviewed build/soong patch soong-app-native; apply it first.\n`,
    )}${records
      .map(
        (r, i) =>
          `\nprebuilt_app_native {\n    name: "${nativeModules[i]}",\n    src: "${r.path}",\n    filename: "${libraries[i]?.name}",\n    relative_install_path: "${d.moduleName}/lib/${target.arch}",\n${partitionProperty}}\n`,
      )
      .join("")}${rest}`;
  };
  return {
    directory,
    blueprint:
      install === "soong"
        ? soongBlueprint()
        : `// The launcher ${d.moduleName} is in Android.mk, which installs its bundled JNI.\n${rest}`,
    makefile:
      install === "soong"
        ? null
        : `# Generated from a hash- and signer-verified downstream launcher and its bundled ${abi} JNI.\nLOCAL_PATH := $(call my-dir)\ninclude $(CLEAR_VARS)\nLOCAL_MODULE := ${d.moduleName}\nLOCAL_MODULE_CLASS := APPS\nLOCAL_MODULE_SUFFIX := .apk\nLOCAL_SRC_FILES := Launcher.apk\nLOCAL_CERTIFICATE := PRESIGNED\nLOCAL_SDK_VERSION := 36\n${partition === "product" ? "LOCAL_PRODUCT_MODULE := true\n" : ""}LOCAL_MULTILIB := 64\nLOCAL_MODULE_TARGET_ARCH := ${target.arch}\nLOCAL_DEX_PREOPT := false\nLOCAL_PREBUILT_JNI_LIBS := ${records.map((r) => r.path).join(" ")}\ninclude $(BUILD_PREBUILT)\n`,
    product: `${full.product}\n# Exact modes for the launcher's bundled JNI.\nlauncher_native_dir := $(patsubst %/,%,$(dir $(lastword $(MAKEFILE_LIST))))\nTARGET_FS_CONFIG_GEN += $(launcher_native_dir)/config.fs\n`,
    config: records
      .map(
        (r) =>
          `[${r.installPath.slice(1)}]\nmode: ${r.mode}\nuser: AID_ROOT\ngroup: AID_ROOT\ncaps: 0\n\n`,
      )
      .join(""),
    report: {
      schemaVersion: 1,
      apkSha256: d.apkSha256,
      abi,
      moduleName: d.moduleName,
      installRule: install === "soong" ? "soong-app-native" : "android-mk",
      ...(patch
        ? {
            // The consumer's build/soong must carry exactly this reviewed patch.
            soongPatch: {
              name: patch.name,
              manifestSha256: patch.manifestSha256,
              project: patch.manifest.project,
              revision: patch.manifest.revision,
              files: patch.manifest.files,
            },
          }
        : {}),
      libraries: records,
      // The bytes are the pinned APK's; the runtime they hold is not admitted here.
      runtimeAdmitted: false,
      fsConfigRequired: true,
      deployReady: false,
    },
  };
}
export function stageLauncher(options: {
  env?: NodeJS.ProcessEnv;
  descriptor: string;
  apk: string;
  /** One APK path for each descriptor companion, keyed by its moduleName. */
  companions?: Record<string, string>;
  output: string;
  aapt: string;
  apksigner: string;
  development: boolean;
  /** Install the launcher's stored lib/<abi> libraries beside it in the image. */
  nativeAbi?: NativeAbi;
  /** With nativeAbi: Android.mk (default) or the Soong-only soong-app-native rule. */
  nativeInstall?: NativeInstall;
}) {
  if (
    options.nativeAbi !== undefined &&
    !Object.hasOwn(NATIVE_TARGETS, options.nativeAbi)
  )
    throw new Error("Unsupported native ABI");
  if (options.nativeInstall !== undefined) {
    if (!NATIVE_INSTALLS.includes(options.nativeInstall))
      throw new Error("Unsupported native install rule");
    if (options.nativeAbi === undefined)
      throw new Error("A native install rule requires a native ABI");
  }
  const d = validateDescriptor(
    JSON.parse(fs.readFileSync(options.descriptor, "utf8")),
  );
  const companions = d.companions ?? [];
  const supplied = Object.keys(options.companions ?? {}).sort();
  if (
    supplied.join() !==
    companions
      .map((c) => c.moduleName)
      .sort()
      .join()
  )
    throw new Error("Supply exactly one APK for each descriptor companion");
  if (fs.existsSync(options.output))
    throw new Error("Output exists; choose a new staging directory");
  // Inspect the same private copy that is ultimately staged, avoiding a mutable-input race.
  const parent = path.dirname(path.resolve(options.output));
  fs.mkdirSync(parent, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(parent, ".launcher-stage-"));
  try {
    const copy = (source: string, name: string, sha256: string) => {
      const apk = path.join(temporary, name);
      fs.copyFileSync(source, apk);
      const digest = createHash("sha256")
        .update(fs.readFileSync(apk))
        .digest("hex");
      if (digest !== sha256)
        throw new Error(`${name.slice(0, -4)} APK hash mismatch`);
      return apk;
    };
    // Every hash is checked before any SDK tool runs.
    const apk = copy(options.apk, "Launcher.apk", d.apkSha256);
    const companionApks = companions.map(
      (c) =>
        [
          c,
          copy(
            options.companions?.[c.moduleName] ?? "",
            `${c.moduleName}.apk`,
            c.apkSha256,
          ),
        ] as const,
    );
    const run = (command: string, args: string[]) =>
      execFileSync(command, args, { encoding: "utf8", env: options.env });
    const inspect = (file: string) =>
      [
        run(options.aapt, ["dump", "badging", file]),
        run(options.aapt, ["dump", "xmltree", file, "AndroidManifest.xml"]),
        run(options.apksigner, ["verify", "--print-certs", file]),
      ] as const;
    validateInspection(d, ...inspect(apk), options.development);
    for (const [c, file] of companionApks)
      validateCompanionInspection(d, c, ...inspect(file), options.development);
    const overlay = renderOverlay(d);
    if (options.nativeAbi) {
      const libraries = readNativeLibraries(
        fs.readFileSync(apk),
        options.nativeAbi,
      );
      const native = renderNativeOverlay(
        d,
        options.nativeAbi,
        libraries,
        options.nativeInstall ?? "make",
      );
      fs.mkdirSync(path.join(temporary, native.directory));
      for (const library of libraries)
        fs.writeFileSync(
          path.join(temporary, native.directory, library.name),
          library.data,
        );
      fs.writeFileSync(path.join(temporary, "Android.bp"), native.blueprint);
      if (native.makefile !== null)
        fs.writeFileSync(path.join(temporary, "Android.mk"), native.makefile);
      fs.writeFileSync(path.join(temporary, "product.mk"), native.product);
      fs.writeFileSync(path.join(temporary, "config.fs"), native.config);
      fs.writeFileSync(
        path.join(temporary, "native-libraries.json"),
        `${JSON.stringify(native.report, null, 2)}\n`,
      );
    } else {
      fs.writeFileSync(path.join(temporary, "Android.bp"), overlay.blueprint);
      fs.writeFileSync(path.join(temporary, "product.mk"), overlay.product);
    }
    if (overlay.permissions)
      fs.writeFileSync(
        path.join(temporary, "default-permissions.xml"),
        overlay.permissions,
      );
    fs.writeFileSync(
      path.join(temporary, "launcher.json"),
      `${JSON.stringify({ ...d, development: options.development }, null, 2)}\n`,
    );
    fs.renameSync(temporary, options.output);
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
  return path.resolve(options.output);
}
export function main(argv = process.argv.slice(2)) {
  const args: Record<string, string> = {};
  const companions: Record<string, string> = {};
  let development = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] ?? "";
    if (flag === "--development") {
      development = true;
      continue;
    }
    const value = argv[++i] ?? "";
    const companion =
      flag === "--companion" ? /^([A-Z][A-Za-z0-9]*)=(.+)$/.exec(value) : null;
    if (
      ![
        "--descriptor",
        "--apk",
        "--companion",
        "--output",
        "--aapt",
        "--apksigner",
        "--native-abi",
        "--native-install",
      ].includes(flag) ||
      !value ||
      value.startsWith("--") ||
      (flag === "--companion" &&
        (!companion?.[1] || !companion[2] || companion[1] in companions))
    )
      throw new Error(
        "Expected --descriptor PATH --apk PATH [--companion MODULE=PATH ...] --output NEW_DIR [--native-abi arm64-v8a|x86_64 [--native-install make|soong]] [--aapt PATH] [--apksigner PATH] [--development]",
      );
    if (companion?.[1] && companion[2]) companions[companion[1]] = companion[2];
    else args[flag.slice(2)] = value;
  }
  if (!args.descriptor || !args.apk || !args.output)
    throw new Error("Descriptor, APK and new output directory are required");
  console.log(
    stageLauncher({
      descriptor: args.descriptor,
      apk: args.apk,
      companions,
      output: args.output,
      aapt: args.aapt || "aapt",
      apksigner: args.apksigner || "apksigner",
      development,
      ...(args["native-abi"]
        ? { nativeAbi: args["native-abi"] as NativeAbi }
        : {}),
      ...(args["native-install"]
        ? { nativeInstall: args["native-install"] as NativeInstall }
        : {}),
    }),
  );
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();

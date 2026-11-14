#!/usr/bin/env node
/**
 * validate.ts — Static validator for a brand's AOSP vendor tree + APK.
 *
 * Brand-aware: package id, app name, product name, classPrefix, and
 * envPrefix are read from the brand config (see brand-config.ts).
 * Class names like `<Brand>DialActivity` are derived from
 * `brand.classPrefix`; env vars like `<BRAND>_PIXEL_CODENAME` from
 * `brand.envPrefix`.
 *
 * The product layer follows the nonprivileged-launcher profile: the launcher is
 * staged from the signed APK into `<vendorDir>/launcher` by image-launcher.ts,
 * and nothing in the vendor tree may make it privileged, platform-signed,
 * a dialer/SMS default, or remove a stock package.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadBrandFromArgv } from "./brand-config.ts";
import {
  LAUNCHER_DIRECTORY,
  loadImagesPolicy,
  verifyStagedLauncher,
} from "./image-launcher.ts";
import { lintInitRc } from "./lint-init-rc.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

/** Telephony and contacts surfaces the APK keeps for user-chosen roles. */
const telephonyPermissions = [
  "android.permission.READ_CONTACTS",
  "android.permission.WRITE_CONTACTS",
  "android.permission.CALL_PHONE",
  "android.permission.READ_PHONE_STATE",
  "android.permission.ANSWER_PHONE_CALLS",
  "android.permission.READ_CALL_LOG",
  "android.permission.WRITE_CALL_LOG",
  "android.permission.READ_SMS",
  "android.permission.SEND_SMS",
  "android.permission.RECEIVE_SMS",
  "android.permission.RECEIVE_MMS",
  "android.permission.RECEIVE_WAP_PUSH",
];

function requiredApkPermissions() {
  return [
    ...telephonyPermissions,
    "android.permission.MANAGE_OWN_CALLS",
    "android.permission.RECEIVE_BOOT_COMPLETED",
    ...loadImagesPolicy().defaultPermissions,
  ];
}

/** Framework role defaults that only the staged provisioning overlay may set. */
const provisionedRoleResources = [
  "config_defaultHome",
  "config_defaultDialer",
  "config_defaultSms",
  "config_defaultAssistant",
  "config_defaultAutofillService",
];

export function parseSubArgs(argv, brand) {
  const args = {
    aospRoot: null,
    apk: null,
    vendorDir: path.resolve(repoRoot, brand.vendorDir),
  };
  const readFlagValue = (flag, index) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a path value`);
    }
    return path.resolve(value);
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--aosp-root") {
      args.aospRoot = readFlagValue(arg, i);
      i += 1;
    } else if (arg === "--apk") {
      args.apk = readFlagValue(arg, i);
      i += 1;
    } else if (arg === "--vendor-dir") {
      args.vendorDir = readFlagValue(arg, i);
      i += 1;
    } else if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: node scripts/android/validate.ts [--brand-config <PATH>] [--apk <APK>] [--vendor-dir <VENDOR_DIR>] [--aosp-root <AOSP_ROOT>]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  // The staged, signed launcher bytes, not the unsigned build output.
  args.apk ??= path.join(args.vendorDir, LAUNCHER_DIRECTORY, "Launcher.apk");
  return args;
}

function fail(message) {
  throw new Error(`[distro-android:validate] ${message}`);
}

function assertFile(filePath, label = filePath) {
  if (!fs.existsSync(filePath)) {
    fail(`Missing ${label}: ${filePath}`);
  }
}

function read(filePath) {
  assertFile(filePath);
  return fs.readFileSync(filePath, "utf8");
}

function collectBlueprintModuleNames(root) {
  const names = new Set();
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        // The staged launcher is generated and checked by verifyStagedLauncher.
        if (entryPath !== path.join(root, LAUNCHER_DIRECTORY)) visit(entryPath);
      } else if (entry.isFile() && entry.name === "Android.bp") {
        const source = fs.readFileSync(entryPath, "utf8");
        for (const match of source.matchAll(/\bname\s*:\s*"([^"]+)"/g)) {
          names.add(match[1]);
        }
      }
    }
  };
  visit(root);
  return names;
}

function assertLocallyOwnedProductModulesResolve(common, vendorDir, brand) {
  const addition = common.match(
    /PRODUCT_PACKAGES\s*\+=\s*\\\s*\n([\s\S]*?)(?=\n\s*\n|\n[A-Z][A-Z0-9_]*\s*[:+?]?=)/,
  )?.[1];
  if (!addition) fail("PRODUCT_PACKAGES += block cannot be parsed");
  const localPrefixes = [brand.brand, brand.appName].map((value) =>
    value.toLowerCase(),
  );
  const localModules = addition
    .split("\n")
    .map((line) => line.replace(/#.*/, "").replace(/\\/g, "").trim())
    .filter(Boolean)
    .filter((name) =>
      localPrefixes.some((prefix) => name.toLowerCase().startsWith(prefix)),
    );
  const defined = collectBlueprintModuleNames(vendorDir);
  for (const moduleName of localModules) {
    if (!defined.has(moduleName)) {
      fail(
        `${brand.commonMakefile} adds local module ${moduleName}, but no Android.bp under ${vendorDir} defines it`,
      );
    }
  }
}

function assertIncludes(content, needle, label) {
  if (!content.includes(needle)) {
    fail(`${label} is missing ${needle}`);
  }
}

function assertMatches(content, pattern, label, description) {
  if (!pattern.test(content)) {
    fail(`${label} is missing ${description}`);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertCountAtLeast(content, needle, expectedCount, label) {
  const count = content.split(needle).length - 1;
  if (count < expectedCount) {
    fail(
      `${label} needs at least ${expectedCount} occurrence(s) of ${needle}; found ${count}`,
    );
  }
}

function xmlElementBlockByName(xml, tagName, name, label) {
  const match = xml.match(
    new RegExp(
      `<${tagName}\\b(?=[^>]*\\bname="${escapeRegExp(name)}")[\\s\\S]*?<\\/${tagName}>`,
    ),
  );
  if (!match) {
    fail(`${label} is missing ${tagName} ${name}`);
  }
  return match[0];
}

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) {
    fail(`${command} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(
      `${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

function commandExists(command) {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    stdio: "ignore",
  });
  return !result.error;
}

function findFiles(dir, predicate, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findFiles(fullPath, predicate, out);
    } else if (predicate(fullPath)) {
      out.push(fullPath);
    }
  }
  return out;
}

function compareVersions(a, b) {
  const aa = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const bb = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const len = Math.max(aa.length, bb.length);
  for (let i = 0; i < len; i += 1) {
    const delta = (aa[i] ?? 0) - (bb[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function resolveAapt() {
  const explicit = process.env.AAPT;
  if (explicit && fs.existsSync(explicit)) return explicit;

  const sdkRoots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(os.homedir(), "Library", "Android", "sdk"),
    path.join(os.homedir(), "Android", "Sdk"),
  ].filter(Boolean);

  for (const sdkRoot of sdkRoots) {
    const buildTools = path.join(sdkRoot, "build-tools");
    if (!fs.existsSync(buildTools)) continue;
    const versions = fs.readdirSync(buildTools).sort(compareVersions).reverse();
    for (const version of versions) {
      const candidate = path.join(buildTools, version, "aapt");
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  fail("Could not find aapt. Set AAPT or ANDROID_HOME/ANDROID_SDK_ROOT.");
}

export function validateXmlFiles(vendorDir, brand) {
  const xmlFiles = findFiles(vendorDir, (file) => file.endsWith(".xml"));
  if (xmlFiles.length === 0)
    fail(`No XML files found under vendor/${brand.brand}`);
  if (!commandExists("xmllint")) {
    fail(
      "xmllint is required for XML parser validation. Install libxml2 or set PATH to xmllint.",
    );
  }
  run("xmllint", ["--noout", ...xmlFiles]);
  console.log(
    `[distro-android:validate] XML parse check passed for ${xmlFiles.length} file(s).`,
  );
}

export function validateProductLayer(vendorDir, brand) {
  const product = read(
    path.join(vendorDir, "products", `${brand.productName}.mk`),
  );
  // The product makefile must inherit from a device tree. By default we
  // assume the compatibility Cuttlefish base (`aosp_cf.mk`); brand configs for
  // non-Cuttlefish products (e.g. real-hardware SoC fusions like the
  // OpenAgent E1) MUST declare `aospDeviceTreePaths` listing the device
  // tree files they expect to find in the imported AOSP checkout. The
  // first entry is treated as the primary inherit target the product
  // makefile must reference; any additional entries are existence-checked
  // against `--aosp-root` when present (see `validateAospDeviceTreePaths`).
  // We intentionally do not fold a "found one of many" loop here: a
  // product either inherits the documented base or it is misconfigured.
  const deviceTreePaths = brand.aospDeviceTreePaths;
  const primaryInherit =
    Array.isArray(deviceTreePaths) && deviceTreePaths.length > 0
      ? deviceTreePaths[0]
      : "device/google/cuttlefish/vsoc_x86_64_only/phone/aosp_cf.mk";
  assertIncludes(product, primaryInherit, "product");
  const localVendorPrefix = `vendor/${brand.brand}/`;
  const productContract = primaryInherit.startsWith(localVendorPrefix)
    ? `${product}\n${read(path.join(vendorDir, primaryInherit.slice(localVendorPrefix.length)))}`
    : product;
  assertIncludes(
    productContract,
    `vendor/${brand.brand}/${brand.commonMakefile}`,
    `product (must inherit ${brand.commonMakefile} for shared OS-path invariants)`,
  );
  assertIncludes(productContract, `${brand.envPrefix}_PRODUCT_TAG`, "product");

  const common = read(path.join(vendorDir, brand.commonMakefile));
  assertIncludes(common, "PRODUCT_PACKAGES +=", brand.commonMakefile);
  assertLocallyOwnedProductModulesResolve(common, vendorDir, brand);
  // The launcher module, its grants and provisioning come only from the
  // staged launcher product, which the common layer must require.
  assertIncludes(
    common,
    `vendor/${brand.brand}/${LAUNCHER_DIRECTORY}/product.mk`,
    brand.commonMakefile,
  );
  assertMatches(
    common,
    new RegExp(
      `^\\$\\(call inherit-product, (?:vendor/${escapeRegExp(brand.brand)}/${LAUNCHER_DIRECTORY}/product\\.mk|\\$\\(${escapeRegExp(brand.envPrefix)}_LAUNCHER_PRODUCT\\))\\)$`,
      "m",
    ),
    brand.commonMakefile,
    "inherit-product of the staged launcher product",
  );
  for (const [pattern, what] of [
    [/privapp-permissions/, "a privapp allowlist"],
    [/priv-app\//, "a priv-app path"],
    [/SEPOLICY_DIRS/, "app SELinux policy"],
    [
      new RegExp(`^\\s+${escapeRegExp(brand.appName)}(?:\\s+\\\\)?$`, "m"),
      "the launcher module outside the staged launcher",
    ],
  ] as const) {
    if (pattern.test(stripMakeComments(common)))
      fail(`${brand.commonMakefile} must not add ${what}`);
  }
  assertNonprivilegedVendorTree(vendorDir, brand);
  // PRODUCT_PACKAGE_OVERLAYS root must mirror the AOSP source tree from
  // there: e.g. <root>/frameworks/base/core/res/res/values/config.xml
  // overlays the framework-res package's config_default* strings. The
  // older path "vendor/<brand>/overlays/framework-res" never merged
  // because Soong looks under the overlay root for `LOCAL_RESOURCE_DIR`
  // (frameworks/base/core/res/res), not for a directory called
  // "framework-res".
  assertIncludes(
    common,
    `vendor/${brand.brand}/overlays`,
    brand.commonMakefile,
  );
  assertFile(
    path.join(
      vendorDir,
      "overlays",
      "frameworks",
      "base",
      "core",
      "res",
      "res",
      "values",
      "config.xml",
    ),
    "framework-res overlay (must mirror frameworks/base/core/res/res/...)",
  );
  // Package names in an unsupported subtraction were never removal evidence.
  // Validate the actual setup property and overlay defaults below instead.
  if (/^\s*PRODUCT_PACKAGES\s*-=/m.test(common)) {
    fail(
      `${brand.commonMakefile} uses unsupported PRODUCT_PACKAGES subtraction`,
    );
  }
  assertIncludes(common, "ro.setupwizard.mode=DISABLED", brand.commonMakefile);
  const setupDefaultsPath = path.join(
    vendorDir,
    "overlays",
    "frameworks",
    "base",
    "packages",
    "SettingsProvider",
    "res",
    "values",
    "defaults.xml",
  );
  assertFile(setupDefaultsPath, "SettingsProvider setup-completion defaults");
  const setupDefaults = fs.readFileSync(setupDefaultsPath, "utf8");
  for (const name of ["def_device_provisioned", "def_user_setup_complete"]) {
    assertIncludes(
      setupDefaults,
      `<bool name="${name}">true</bool>`,
      setupDefaultsPath,
    );
  }

  // Boot-time scaffolds.
  assertIncludes(
    common,
    brand.initRcName,
    `${brand.commonMakefile} PRODUCT_COPY_FILES`,
  );
  if (common.includes("PermissionController")) {
    fail(
      `${brand.commonMakefile} still references a PermissionController overlay; role defaults live in framework-res strings.`,
    );
  }

  const androidProducts = read(path.join(vendorDir, "AndroidProducts.mk"));
  assertMatches(
    androidProducts,
    new RegExp(`\\$\\(LOCAL_DIR\\)/products/${brand.productName}\\.mk`),
    "AndroidProducts.mk",
    `PRODUCT_MAKEFILES entry for ${brand.productName}`,
  );
  assertMatches(
    androidProducts,
    new RegExp(`(?:^|\\s)${brand.lunchTarget}(?:\\s|$)`),
    "AndroidProducts.mk",
    `${brand.lunchTarget} lunch choice`,
  );

  // Init script required by the product overlay.
  assertFile(
    path.join(vendorDir, "init", brand.initRcName),
    `vendor/${brand.brand} init script`,
  );

  // Lint the init script syntactically — typos here only show up at
  // boot otherwise.
  const initIssues = lintInitRc(path.join(vendorDir, "init", brand.initRcName));
  const initErrors = initIssues.filter((i) => !i.soft);
  if (initErrors.length > 0) {
    fail(
      `${brand.initRcName} has lint errors:\n - ${initErrors
        .map((i) => `line ${i.line}: ${i.message}`)
        .join("\n - ")}`,
    );
  }

  const initRc = stripMakeComments(
    read(path.join(vendorDir, "init", brand.initRcName)),
  );
  // Init grants nothing to the nonprivileged launcher (no appops or runtime
  // permission changes behind the reviewed default-permissions file).
  if (/\b(appops|pm\s+grant|cmd\s+role)\b/.test(initRc))
    fail(
      `${brand.initRcName} must not grant the launcher appops, permissions or roles`,
    );

  const frameworkConfig = read(
    path.join(
      vendorDir,
      "overlays",
      "frameworks",
      "base",
      "core",
      "res",
      "res",
      "values",
      "config.xml",
    ),
  );
  for (const resourceName of provisionedRoleResources) {
    if (frameworkConfig.includes(`name="${resourceName}"`))
      fail(
        `framework-res overlay must not set ${resourceName}; HOME, assistant and Autofill come from the staged launcher, and dialer and SMS are not preassigned`,
      );
  }
  if (
    fs.existsSync(
      path.join(
        vendorDir,
        "overlays/packages/services/Telecomm/res/values/config.xml",
      ),
    )
  )
    fail(
      "Telecom overlay must not exist: the image does not preassign a dialer, so its classes would misname the stock default",
    );

  const obsoleteRoleFiles = findFiles(vendorDir, (file) =>
    file.endsWith(".xml"),
  ).filter((file) => /config_default.*RoleHolders/.test(read(file)));
  if (obsoleteRoleFiles.length > 0) {
    fail(
      `Obsolete PermissionController role-holder resources found: ${obsoleteRoleFiles.join(", ")}`,
    );
  }

  console.log("[distro-android:validate] Product layer checks passed.");
}

function stripMakeComments(text) {
  return text.replace(/^\s*#.*$/gm, "");
}

/**
 * No hand-written module, permission file or overlay in the vendor tree may
 * reintroduce the privileged profile: priv-app placement, the platform
 * certificate, Soong overrides of stock apps, or a privapp allowlist.
 */
export function assertNonprivilegedVendorTree(vendorDir, brand) {
  const staged = path.join(vendorDir, LAUNCHER_DIRECTORY);
  const files = findFiles(
    vendorDir,
    (file) => !file.startsWith(`${staged}${path.sep}`),
  );
  for (const file of files) {
    const name = path.basename(file);
    if (/^privapp-permissions.*\.xml$/.test(name))
      fail(`Privapp allowlist is not allowed for the launcher: ${file}`);
    if (/^default-permissions-.*\.xml$/.test(name))
      fail(`Default grants come only from the staged launcher: ${file}`);
    if (name !== "Android.bp" && name !== "Android.mk") continue;
    const source = read(file).replace(/^\s*\/\/.*$/gm, "");
    if (
      /\bprivileged\s*:\s*true\b/.test(source) ||
      /\bcertificate\s*:\s*"platform"/.test(source) ||
      /\boverrides\s*:/.test(source) ||
      /LOCAL_PRIVILEGED_MODULE\s*:?=\s*true/.test(source) ||
      /LOCAL_CERTIFICATE\s*:?=\s*platform/.test(source) ||
      new RegExp(`\\bname\\s*:\\s*"${escapeRegExp(brand.appName)}"`).test(
        source,
      )
    )
      fail(
        `${file} must not define the launcher, a privileged or platform-signed app, or overrides of stock packages`,
      );
  }
}

/**
 * The launcher runs in untrusted_app, which AOSP's W^X neverallow forbids from
 * executing app data. The former platform_app rules do not apply to it and
 * must not return under another domain.
 */
export function validateSepolicy(vendorDir, brand) {
  const policies = findFiles(path.join(vendorDir, "sepolicy"), (file) =>
    file.endsWith(".te"),
  );
  for (const file of policies) {
    const policy = read(file).replace(/^\s*#.*$/gm, "");
    if (/\bapp_data_file\s*:\s*file\b[^;]*\bexecute(_no_trans)?\b/.test(policy))
      fail(
        `${file} allows executing app data; the ${brand.appName} agent executes its admitted native runtime instead`,
      );
  }
  console.log("[distro-android:validate] Sepolicy checks passed.");
}

/** The staged launcher in the vendor tree, bound to this brand's product. */
export function validateStagedLauncher(vendorDir, brand) {
  const evidence = verifyStagedLauncher(
    path.join(vendorDir, LAUNCHER_DIRECTORY),
    brand,
  );
  console.log(
    `[distro-android:validate] Staged launcher checks passed (${evidence.installPath}, resident runtime ${evidence.residentAgentIncluded ? "included" : "not included"}).`,
  );
  return evidence;
}

function manifestElementBlocks(manifest, elementName) {
  const blocks = [];
  const lines = manifest.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const start = lines[i].match(new RegExp(`^(\\s*)E: ${elementName}\\b`));
    if (!start) continue;
    const indent = start[1].length;
    const block = [lines[i]];
    for (let j = i + 1; j < lines.length; j += 1) {
      const nextElement = lines[j].match(/^(\s*)E: /);
      if (nextElement && nextElement[1].length <= indent) break;
      block.push(lines[j]);
    }
    blocks.push(block.join("\n"));
  }
  return blocks;
}

function manifestComponentBlock(manifest, elementName, componentName) {
  const block = manifestElementBlocks(manifest, elementName).find((candidate) =>
    candidate.includes(`"${componentName}"`),
  );
  if (!block) {
    fail(`APK manifest is missing ${elementName} ${componentName}`);
  }
  return block;
}

function assertManifestBlockIncludes(block, needle, label) {
  assertIncludes(block, needle, `APK manifest ${label}`);
}

function validateApkManifest(manifest, brand) {
  const cls = (suffix) => `${brand.classPrefix}${suffix}`;
  const fq = (suffix) => `${brand.packageName}.${cls(suffix)}`;

  const mainActivity = manifestComponentBlock(
    manifest,
    "activity",
    `${brand.packageName}.MainActivity`,
  );
  assertManifestBlockIncludes(
    mainActivity,
    "android.intent.action.MAIN",
    "MainActivity",
  );
  assertManifestBlockIncludes(
    mainActivity,
    "android.intent.category.HOME",
    "MainActivity",
  );
  assertManifestBlockIncludes(
    mainActivity,
    "android.intent.category.DEFAULT",
    "MainActivity",
  );

  const dialActivity = manifestComponentBlock(
    manifest,
    "activity",
    fq("DialActivity"),
  );
  assertCountAtLeast(
    dialActivity,
    "android.intent.action.DIAL",
    2,
    `APK manifest ${cls("DialActivity")}`,
  );
  assertManifestBlockIncludes(
    dialActivity,
    "android.intent.category.DEFAULT",
    cls("DialActivity"),
  );
  assertManifestBlockIncludes(
    dialActivity,
    'android:scheme(0x01010027)="tel"',
    cls("DialActivity"),
  );

  const assistActivity = manifestComponentBlock(
    manifest,
    "activity",
    fq("AssistActivity"),
  );
  assertManifestBlockIncludes(
    assistActivity,
    "android.intent.action.ASSIST",
    cls("AssistActivity"),
  );
  assertManifestBlockIncludes(
    assistActivity,
    "android.intent.category.DEFAULT",
    cls("AssistActivity"),
  );

  const inCallService = manifestComponentBlock(
    manifest,
    "service",
    fq("InCallService"),
  );
  assertManifestBlockIncludes(
    inCallService,
    "android.permission.BIND_INCALL_SERVICE",
    cls("InCallService"),
  );
  assertManifestBlockIncludes(
    inCallService,
    "android.telecom.InCallService",
    cls("InCallService"),
  );
  assertManifestBlockIncludes(
    inCallService,
    "android.telecom.IN_CALL_SERVICE_UI",
    cls("InCallService"),
  );

  const smsReceiver = manifestComponentBlock(
    manifest,
    "receiver",
    fq("SmsReceiver"),
  );
  assertManifestBlockIncludes(
    smsReceiver,
    "android.permission.BROADCAST_SMS",
    cls("SmsReceiver"),
  );
  assertManifestBlockIncludes(
    smsReceiver,
    "android.provider.Telephony.SMS_DELIVER",
    cls("SmsReceiver"),
  );

  const mmsReceiver = manifestComponentBlock(
    manifest,
    "receiver",
    fq("MmsReceiver"),
  );
  assertManifestBlockIncludes(
    mmsReceiver,
    "android.permission.BROADCAST_WAP_PUSH",
    cls("MmsReceiver"),
  );
  assertManifestBlockIncludes(
    mmsReceiver,
    "android.provider.Telephony.WAP_PUSH_DELIVER",
    cls("MmsReceiver"),
  );
  assertManifestBlockIncludes(
    mmsReceiver,
    "application/vnd.wap.mms-message",
    cls("MmsReceiver"),
  );

  const respondService = manifestComponentBlock(
    manifest,
    "service",
    fq("RespondViaMessageService"),
  );
  assertManifestBlockIncludes(
    respondService,
    "android.permission.SEND_RESPOND_VIA_MESSAGE",
    cls("RespondViaMessageService"),
  );
  assertManifestBlockIncludes(
    respondService,
    "android.intent.action.RESPOND_VIA_MESSAGE",
    cls("RespondViaMessageService"),
  );
  assertManifestBlockIncludes(
    respondService,
    'android:scheme(0x01010027)="smsto"',
    cls("RespondViaMessageService"),
  );

  const composeActivity = manifestComponentBlock(
    manifest,
    "activity",
    fq("SmsComposeActivity"),
  );
  assertManifestBlockIncludes(
    composeActivity,
    "android.intent.action.SENDTO",
    cls("SmsComposeActivity"),
  );
  assertManifestBlockIncludes(
    composeActivity,
    'android:scheme(0x01010027)="smsto"',
    cls("SmsComposeActivity"),
  );

  const bootReceiver = manifestComponentBlock(
    manifest,
    "receiver",
    fq("BootReceiver"),
  );
  assertManifestBlockIncludes(
    bootReceiver,
    "android.intent.action.LOCKED_BOOT_COMPLETED",
    cls("BootReceiver"),
  );
  assertManifestBlockIncludes(
    bootReceiver,
    "android.intent.action.BOOT_COMPLETED",
    cls("BootReceiver"),
  );

  // Replacement activities for stripped role apps. These soft-warn
  // instead of failing because the activity Java sources land in the
  // brand's source tree and a staged APK built before they were added
  // is still a valid OS-path image — just one with intent-resolution
  // gaps for the corresponding system intents.
  const REPLACEMENT_ACTIVITIES = [
    {
      name: cls("BrowserActivity"),
      markers: [
        "android.intent.action.VIEW",
        "android.intent.category.BROWSABLE",
        'android:scheme(0x01010027)="http"',
        'android:scheme(0x01010027)="https"',
      ],
    },
    {
      name: cls("ContactsActivity"),
      markers: ["android.intent.category.APP_CONTACTS"],
    },
    {
      name: cls("CameraActivity"),
      markers: [
        "android.media.action.STILL_IMAGE_CAMERA",
        "android.media.action.IMAGE_CAPTURE",
      ],
    },
    {
      name: cls("ClockActivity"),
      markers: [
        "android.intent.action.SET_ALARM",
        "android.intent.action.SHOW_ALARMS",
      ],
    },
    {
      name: cls("CalendarActivity"),
      markers: ["android.intent.category.APP_CALENDAR"],
    },
  ];

  const replacementWarnings = [];
  for (const { name, markers } of REPLACEMENT_ACTIVITIES) {
    const blocks = manifestElementBlocks(manifest, "activity").filter((b) =>
      b.includes(`"${brand.packageName}.${name}"`),
    );
    if (blocks.length === 0) {
      replacementWarnings.push(
        `[soft] APK manifest is missing activity ${brand.packageName}.${name} — system intent will have no resolver after stripping the corresponding AOSP app.`,
      );
      continue;
    }
    const block = blocks[0];
    for (const marker of markers) {
      if (!block.includes(marker)) {
        replacementWarnings.push(
          `[soft] APK manifest ${name} is missing ${marker}`,
        );
      }
    }
  }
  if (replacementWarnings.length > 0) {
    console.warn(
      `[distro-android:validate] Soft warnings (rebuild APK to clear):\n - ${replacementWarnings.join("\n - ")}`,
    );
  }
}

export function validateApk(apkPath, brand) {
  assertFile(apkPath, `${brand.appName} APK`);
  const aapt = resolveAapt();
  const badging = run(aapt, ["dump", "badging", apkPath]);
  assertIncludes(
    badging,
    `package: name='${brand.packageName}'`,
    "APK badging",
  );
  assertIncludes(
    badging,
    `application-label:'${brand.appName}'`,
    "APK badging",
  );
  for (const permission of requiredApkPermissions()) {
    assertIncludes(
      badging,
      `uses-permission: name='${permission}'`,
      "APK badging",
    );
  }

  const manifest = run(aapt, [
    "dump",
    "xmltree",
    apkPath,
    "AndroidManifest.xml",
  ]);
  validateApkManifest(manifest, brand);
  console.log(`[distro-android:validate] APK checks passed with ${aapt}.`);
}

/** Verify brand-declared device trees in the imported AOSP checkout. */
export function validateAospDeviceTreePaths(aospRoot, brand) {
  const paths = brand.aospDeviceTreePaths;
  if (!Array.isArray(paths) || paths.length === 0) return;
  for (const relPath of paths) {
    if (typeof relPath !== "string" || relPath.length === 0) {
      fail(
        `brand.aospDeviceTreePaths must be an array of non-empty strings; got ${JSON.stringify(relPath)}`,
      );
    }
    assertFile(
      path.join(aospRoot, relPath),
      `AOSP device tree file declared by brand (${relPath})`,
    );
  }
  console.log(
    `[distro-android:validate] AOSP device tree checks passed for ${paths.length} declared path(s).`,
  );
}

export function validateAospRoot(aospRoot) {
  const buildEnvsetup = path.join(aospRoot, "build", "envsetup.sh");
  assertFile(buildEnvsetup, "AOSP build/envsetup.sh");

  const rolesXml = read(
    path.join(
      aospRoot,
      "packages",
      "modules",
      "Permission",
      "PermissionController",
      "res",
      "xml",
      "roles.xml",
    ),
  );
  const assistantRole = xmlElementBlockByName(
    rolesXml,
    "role",
    "android.app.role.ASSISTANT",
    "AOSP roles.xml",
  );
  assertIncludes(
    assistantRole,
    'defaultHolders="config_defaultAssistant"',
    "AOSP ASSISTANT role",
  );
  assertIncludes(assistantRole, "AssistantRoleBehavior", "AOSP ASSISTANT role");

  const homeRole = xmlElementBlockByName(
    rolesXml,
    "role",
    "android.app.role.HOME",
    "AOSP roles.xml",
  );
  assertIncludes(homeRole, "android.intent.category.HOME", "AOSP HOME role");
  if (homeRole.includes("defaultHolders=")) {
    fail(
      "AOSP HOME role unexpectedly has a defaultHolders config; the launcher's default HOME is a preferred activity.",
    );
  }

  const frameworkConfig = read(
    path.join(
      aospRoot,
      "frameworks",
      "base",
      "core",
      "res",
      "res",
      "values",
      "config.xml",
    ),
  );
  // The staged provisioning overlay sets these two; dialer and SMS stay stock.
  for (const resourceName of [
    "config_defaultAssistant",
    "config_defaultAutofillService",
  ]) {
    assertIncludes(
      frameworkConfig,
      `name="${resourceName}"`,
      "AOSP framework config.xml",
    );
  }

  console.log(
    "[distro-android:validate] AOSP source compatibility checks passed.",
  );
}

export function main(argv = process.argv.slice(2)) {
  const { brand, remaining } = loadBrandFromArgv(argv);
  const args = parseSubArgs(remaining, brand);
  validateXmlFiles(args.vendorDir, brand);
  validateProductLayer(args.vendorDir, brand);
  validateSepolicy(args.vendorDir, brand);
  validateStagedLauncher(args.vendorDir, brand);
  validateApk(args.apk, brand);
  if (args.aospRoot) {
    validateAospRoot(args.aospRoot);
    validateAospDeviceTreePaths(args.aospRoot, brand);
  }
  console.log(`[distro-android:validate] ${brand.distroName} checks passed.`);
}

if (import.meta.main) {
  main();
}

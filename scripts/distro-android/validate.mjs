#!/usr/bin/env node
/**
 * validate.mjs — Static validator for a brand's AOSP vendor tree + APK.
 *
 * Brand-aware: package id, app name, product name, classPrefix, and
 * envPrefix are read from the brand config (see brand-config.mjs).
 * Class names like `<Brand>DialActivity` are derived from
 * `brand.classPrefix`; env vars like `<BRAND>_PIXEL_CODENAME` from
 * `brand.envPrefix`.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadBrandFromArgv } from "./brand-config.mjs";
import { lintInitRc } from "./lint-init-rc.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

const defaultGrantPermissions = [
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
  "android.permission.POST_NOTIFICATIONS",
];

const requiredApkPermissions = [
  ...defaultGrantPermissions,
  "android.permission.MANAGE_OWN_CALLS",
  "android.permission.RECEIVE_BOOT_COMPLETED",
  "android.permission.PACKAGE_USAGE_STATS",
  "android.permission.SYSTEM_ALERT_WINDOW",
  "android.permission.MANAGE_APP_OPS_MODES",
];

const privilegedPermissions = [
  "android.permission.PACKAGE_USAGE_STATS",
  "android.permission.MANAGE_APP_OPS_MODES",
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
        "Usage: node scripts/distro-android/validate.mjs [--brand-config <PATH>] [--apk <APK>] [--vendor-dir <VENDOR_DIR>] [--aosp-root <AOSP_ROOT>]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  args.apk ??= path.join(
    args.vendorDir,
    "apps",
    brand.appName,
    `${brand.appName}.apk`,
  );
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

function xmlStringValue(xml, name, label) {
  const match = xml.match(
    new RegExp(
      `<string\\b(?=[^>]*\\bname="${escapeRegExp(name)}")[^>]*>([^<]*)<\\/string>`,
    ),
  );
  if (!match) {
    fail(`${label} is missing string resource ${name}`);
  }
  return match[1].trim();
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
  assertIncludes(
    product,
    "device/google/cuttlefish/vsoc_x86_64_only/phone/aosp_cf.mk",
    "product",
  );
  assertIncludes(
    product,
    `vendor/${brand.brand}/${brand.commonMakefile}`,
    `product (must inherit ${brand.commonMakefile} for shared OS-path invariants)`,
  );
  assertIncludes(product, `${brand.envPrefix}_PRODUCT_TAG`, "product");

  const common = read(path.join(vendorDir, brand.commonMakefile));
  assertIncludes(common, "PRODUCT_PACKAGES +=", brand.commonMakefile);
  assertIncludes(common, "PRODUCT_PACKAGES -=", brand.commonMakefile);
  assertIncludes(common, brand.appName, brand.commonMakefile);
  assertIncludes(
    common,
    `default-permissions-${brand.packageName}.xml`,
    brand.commonMakefile,
  );
  assertIncludes(
    common,
    `privapp-permissions-${brand.packageName}.xml`,
    brand.commonMakefile,
  );
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
  // Ensure no first-boot UX leaks through.
  for (const marker of ["Provision", "SetupWizard", "ManagedProvisioning"]) {
    assertIncludes(
      common,
      marker,
      `${brand.commonMakefile} PRODUCT_PACKAGES -= strip list`,
    );
  }
  assertIncludes(common, "ro.setupwizard.mode=DISABLED", brand.commonMakefile);
  // Boot-time scaffolds.
  assertIncludes(
    common,
    brand.initRcName,
    `${brand.commonMakefile} PRODUCT_COPY_FILES`,
  );
  assertIncludes(common, "BOARD_VENDOR_SEPOLICY_DIRS", brand.commonMakefile);
  assertIncludes(
    common,
    `vendor/${brand.brand}/sepolicy`,
    brand.commonMakefile,
  );
  if (common.includes("PermissionController")) {
    fail(
      `${brand.commonMakefile} still references a PermissionController overlay; role defaults live in framework-res strings.`,
    );
  }

  // Per-Pixel templates exist and follow the same <BRAND>_PIXEL_CODENAME contract.
  const pixelMakefile = `${brand.pixelMakefilePrefix}_pixel_phone.mk`;
  const pixelTemplate = read(path.join(vendorDir, "products", pixelMakefile));
  assertIncludes(
    pixelTemplate,
    `${brand.envPrefix}_PIXEL_CODENAME`,
    pixelMakefile,
  );
  assertIncludes(
    pixelTemplate,
    `vendor/${brand.brand}/${brand.commonMakefile}`,
    pixelMakefile,
  );

  const androidProducts = read(path.join(vendorDir, "AndroidProducts.mk"));
  assertMatches(
    androidProducts,
    new RegExp(`\\$\\(LOCAL_DIR\\)/products/${brand.productName}\\.mk`),
    "AndroidProducts.mk",
    `PRODUCT_MAKEFILES entry for ${brand.productName}`,
  );
  assertMatches(
    androidProducts,
    new RegExp(`${brand.productName}-trunk_staging-userdebug`),
    "AndroidProducts.mk",
    `${brand.productName}-trunk_staging-userdebug lunch choice`,
  );

  // Init script + sepolicy scaffold present.
  assertFile(
    path.join(vendorDir, "init", brand.initRcName),
    `vendor/${brand.brand} init script`,
  );
  assertFile(
    path.join(vendorDir, "sepolicy", "file_contexts"),
    `vendor/${brand.brand} sepolicy file_contexts`,
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

  const androidBp = read(
    path.join(vendorDir, "apps", brand.appName, "Android.bp"),
  );
  for (const marker of [
    "android_app_import",
    `name: "${brand.appName}"`,
    `apk: "${brand.appName}.apk"`,
    "privileged: true",
    'certificate: "platform"',
    '"Launcher3"',
    '"Launcher3QuickStep"',
    '"Dialer"',
    // Both "messaging" (lowercase, the actual Soong module name from
    // packages/apps/Messaging/Android.bp) and "Messaging" (legacy
    // / lineage variants) — the lowercase one is the load-bearing
    // entry; the capital is kept for non-AOSP forks that diverge.
    '"messaging"',
    '"Messaging"',
    '"Contacts"',
    '"Trebuchet"',
  ]) {
    assertIncludes(androidBp, marker, `${brand.appName} Android.bp`);
  }

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
  for (const resourceName of [
    "config_defaultDialer",
    "config_defaultSms",
    "config_defaultAssistant",
    "config_defaultBrowser",
  ]) {
    const value = xmlStringValue(
      frameworkConfig,
      resourceName,
      "framework-res overlay",
    );
    if (value !== brand.packageName) {
      fail(
        `framework-res overlay ${resourceName} must be ${brand.packageName}; found ${value || "<empty>"}`,
      );
    }
  }

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

export function validateDefaultPermissions(vendorDir, brand) {
  const defaultPermissions = read(
    path.join(
      vendorDir,
      "permissions",
      `default-permissions-${brand.packageName}.xml`,
    ),
  );
  assertIncludes(
    defaultPermissions,
    `<exception package="${brand.packageName}">`,
    "default permissions",
  );
  for (const permission of defaultGrantPermissions) {
    assertIncludes(
      defaultPermissions,
      `name="${permission}"`,
      "default permissions",
    );
  }

  const privPermissions = read(
    path.join(
      vendorDir,
      "permissions",
      `privapp-permissions-${brand.packageName}.xml`,
    ),
  );
  assertIncludes(
    privPermissions,
    `<privapp-permissions package="${brand.packageName}"`,
    "privapp permissions",
  );
  for (const permission of privilegedPermissions) {
    assertIncludes(
      privPermissions,
      `name="${permission}"`,
      "privapp permissions",
    );
  }

  // The product makefile lists these XMLs by module name in PRODUCT_PACKAGES.
  // Soong needs prebuilt_etc{} declarations or `m` exits with "module not defined".
  const permissionsBp = read(path.join(vendorDir, "permissions", "Android.bp"));
  for (const moduleName of [
    `default-permissions-${brand.packageName}.xml`,
    `privapp-permissions-${brand.packageName}.xml`,
  ]) {
    assertIncludes(
      permissionsBp,
      `name: "${moduleName}"`,
      "permissions/Android.bp",
    );
  }
  assertIncludes(
    permissionsBp,
    'sub_dir: "default-permissions"',
    "permissions/Android.bp",
  );
  assertIncludes(
    permissionsBp,
    'sub_dir: "permissions"',
    "permissions/Android.bp",
  );

  console.log("[distro-android:validate] Permission XML checks passed.");
}

/**
 * Vendor sepolicy files exist on the AOSP build path
 * (`BOARD_VENDOR_SEPOLICY_DIRS += vendor/<brand>/sepolicy`). For the
 * local-agent-on-Android landing we currently rely on the on-device
 * agent running in the priv_app domain (assigned to the privileged
 * APK by AOSP's seapp_contexts). A custom `<brand>_agent` domain was
 * attempted but tripped AOSP's neverallow envelope (priv_app cannot
 * transition to arbitrary domains, app domains cannot have
 * file_contexts targeting /data/data paths, etc.) — landing it
 * requires deeper sepolicy work than the spike scope. The validator
 * pins the file existence so the build doesn't break, but keeps the
 * assertions narrow until the custom domain is reintroduced.
 *
 * See vendor/<brand>/sepolicy/README.md for the design.
 */
export function validateSepolicy(vendorDir, brand) {
  // file_contexts must exist for `BOARD_VENDOR_SEPOLICY_DIRS` to point
  // at a non-empty directory; AOSP's sepolicy build chokes if the
  // listed dir has no policy files at all. An empty file is fine.
  const fileContextsPath = path.join(vendorDir, "sepolicy", "file_contexts");
  assertFile(fileContextsPath, `vendor/${brand.brand} sepolicy/file_contexts`);

  // The agent runs as platform_app and must be able to execve the
  // bundled bun runtime out of /data/data/<pkg>/files/agent/. AOSP's
  // stock platform_app.te has no such allow rule (only priv_app does),
  // so we add it here.
  const teFile = `${brand.brand}_agent.te`;
  const tePath = path.join(vendorDir, "sepolicy", teFile);
  assertFile(tePath, `vendor/${brand.brand} sepolicy/${teFile}`);
  const te = read(tePath);
  assertMatches(
    te,
    /allow\s+platform_app\s+app_data_file\s*:\s*file\b[^;]*\bexecute_no_trans\b[^;]*;/,
    teFile,
    "allow platform_app app_data_file:file { execute execute_no_trans } (on-device agent exec)",
  );

  console.log("[distro-android:validate] Sepolicy checks passed.");
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
  for (const permission of requiredApkPermissions) {
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
  const dialerRole = xmlElementBlockByName(
    rolesXml,
    "role",
    "android.app.role.DIALER",
    "AOSP roles.xml",
  );
  assertIncludes(
    dialerRole,
    'defaultHolders="config_defaultDialer"',
    "AOSP DIALER role",
  );
  assertIncludes(dialerRole, "android.intent.action.DIAL", "AOSP DIALER role");
  assertIncludes(
    dialerRole,
    "android.telecom.InCallService",
    "AOSP DIALER role",
  );

  const smsRole = xmlElementBlockByName(
    rolesXml,
    "role",
    "android.app.role.SMS",
    "AOSP roles.xml",
  );
  assertIncludes(
    smsRole,
    'defaultHolders="config_defaultSms"',
    "AOSP SMS role",
  );
  for (const marker of [
    "android.provider.Telephony.SMS_DELIVER",
    "android.provider.Telephony.WAP_PUSH_DELIVER",
    "android.intent.action.RESPOND_VIA_MESSAGE",
    "android.intent.action.SENDTO",
  ]) {
    assertIncludes(smsRole, marker, "AOSP SMS role");
  }

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
      "AOSP HOME role unexpectedly has a defaultHolders config; revisit brand home defaulting.",
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
  for (const resourceName of [
    "config_defaultAssistant",
    "config_defaultDialer",
    "config_defaultSms",
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
  validateDefaultPermissions(args.vendorDir, brand);
  validateSepolicy(args.vendorDir, brand);
  validateApk(args.apk, brand);
  if (args.aospRoot) {
    validateAospRoot(args.aospRoot);
  }
  console.log(`[distro-android:validate] ${brand.distroName} checks passed.`);
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main();
}

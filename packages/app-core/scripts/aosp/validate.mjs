#!/usr/bin/env node
// Validate a fork's `os/android/vendor/<vendorDir>/` tree matches the
// AOSP system-app contract: product makefile inheritance, permission
// XMLs, sepolicy file_contexts, init.rc syntax, the staged APK's
// manifest declarations, etc.
//
// Reads packageName + appName + productName + vendorDir + commonMk
// from `app.config.ts > aosp:`. `--app-config <PATH>` overrides the
// config location for tests.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolveRepoRootFromImportMeta } from "../lib/repo-root.mjs";
import {
  loadAospVariantConfig,
  resolveAppConfigPath,
} from "./lib/load-variant-config.mjs";
import { lintInitRc } from "./lint-init-rc.mjs";

const repoRoot = resolveRepoRootFromImportMeta(import.meta.url);

/**
 * Derive the full product makefile basename from the variant.
 * `productLunch` looks like
 * `"<productFullName>-<variantSuffix>-<userdebug-or-user>"`. The .mk
 * file under `vendor/<vendorDir>/products/` is named
 * `<productFullName>.mk`.
 */
function productFullNameFromLunch(productLunch) {
  // First dash splits the product name off the build variant.
  const dash = productLunch.indexOf("-");
  return dash < 0 ? productLunch : productLunch.slice(0, dash);
}

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

export function parseArgs(argv) {
  const args = {
    aospRoot: null,
    apk: null,
    vendorDir: null,
    appConfigPath: null,
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
    } else if (arg === "--app-config") {
      args.appConfigPath = readFlagValue(arg, i);
      i += 1;
    } else if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: node eliza/packages/app-core/scripts/aosp/validate.mjs [--apk <APK>] [--vendor-dir <VENDOR_DIR>] [--aosp-root <AOSP_ROOT>] [--app-config <PATH>]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

/**
 * Resolve the variant config + paths so callers don't have to repeat
 * the lookup logic. Throws when no AOSP variant is declared.
 */
export function resolveValidationContext({ args }) {
  const cfgPath = resolveAppConfigPath({
    repoRoot,
    flagValue: args.appConfigPath,
  });
  if (!fs.existsSync(cfgPath)) {
    throw new Error(`[aosp:validate] app.config.ts not found at ${cfgPath}.`);
  }
  const variant = loadAospVariantConfig({ appConfigPath: cfgPath });
  if (!variant) {
    throw new Error(
      `[aosp:validate] No \`aosp:\` block in ${cfgPath}; nothing to validate.`,
    );
  }
  const vendorDir =
    args.vendorDir ??
    path.join(repoRoot, "os", "android", "vendor", variant.vendorDir);
  const apkPath =
    args.apk ??
    path.join(vendorDir, "apps", variant.appName, `${variant.appName}.apk`);
  const productFullName = productFullNameFromLunch(variant.productLunch);
  // Build variant suffix is the rest of the lunch target after the
  // first dash, e.g. "trunk_staging-userdebug".
  const dash = variant.productLunch.indexOf("-");
  const buildVariant = dash < 0 ? "" : variant.productLunch.slice(dash + 1);
  // Last path segment of `commonMk`, used in error messages and
  // filename references (e.g. "acme_common.mk").
  const commonMkBasename = path.basename(variant.commonMk);
  return {
    variant,
    vendorDir,
    apkPath,
    productFullName,
    buildVariant,
    commonMkBasename,
  };
}

function fail(message) {
  throw new Error(`[aosp:validate] ${message}`);
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

export function validateXmlFiles(ctx) {
  const { vendorDir, variant } = ctx;
  const xmlFiles = findFiles(vendorDir, (file) => file.endsWith(".xml"));
  if (xmlFiles.length === 0) {
    fail(`No XML files found under vendor/${variant.vendorDir}`);
  }
  if (!commandExists("xmllint")) {
    fail(
      "xmllint is required for XML parser validation. Install libxml2 or set PATH to xmllint.",
    );
  }
  run("xmllint", ["--noout", ...xmlFiles]);
  console.log(
    `[aosp:validate] XML parse check passed for ${xmlFiles.length} file(s).`,
  );
}

export function validateProductLayer(ctx) {
  const {
    vendorDir,
    variant,
    productFullName,
    buildVariant,
    commonMkBasename,
  } = ctx;
  const productTagSym = `${variant.vendorDir.toUpperCase()}_PRODUCT_TAG`;
  const pixelCodenameSym = `${variant.vendorDir.toUpperCase()}_PIXEL_CODENAME`;
  const initRcName = `init.${variant.vendorDir}.rc`;
  const initRcPath = path.join(vendorDir, "init", initRcName);

  const product = read(
    path.join(vendorDir, "products", `${productFullName}.mk`),
  );
  assertIncludes(
    product,
    "device/google/cuttlefish/vsoc_x86_64_only/phone/aosp_cf.mk",
    "product",
  );
  assertIncludes(
    product,
    variant.commonMk,
    `product (must inherit ${commonMkBasename} for shared OS-path invariants)`,
  );
  assertIncludes(product, productTagSym, "product");

  const common = read(path.join(vendorDir, commonMkBasename));
  assertIncludes(common, "PRODUCT_PACKAGES +=", commonMkBasename);
  assertIncludes(common, "PRODUCT_PACKAGES -=", commonMkBasename);
  assertIncludes(common, variant.appName, commonMkBasename);
  assertIncludes(
    common,
    `default-permissions-${variant.packageName}.xml`,
    commonMkBasename,
  );
  assertIncludes(
    common,
    `privapp-permissions-${variant.packageName}.xml`,
    commonMkBasename,
  );
  // PRODUCT_PACKAGE_OVERLAYS root must mirror the AOSP source tree from
  // there: e.g. <root>/frameworks/base/core/res/res/values/config.xml
  // overlays the framework-res package's config_default* strings. The
  // older path "vendor/<vendor>/overlays/framework-res" never merged
  // because Soong looks under the overlay root for `LOCAL_RESOURCE_DIR`
  // (frameworks/base/core/res/res), not for a directory called
  // "framework-res".
  assertIncludes(
    common,
    `vendor/${variant.vendorDir}/overlays`,
    commonMkBasename,
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
      `${commonMkBasename} PRODUCT_PACKAGES -= strip list`,
    );
  }
  assertIncludes(common, "ro.setupwizard.mode=DISABLED", commonMkBasename);
  // Boot-time scaffolds.
  assertIncludes(common, initRcName, `${commonMkBasename} PRODUCT_COPY_FILES`);
  assertIncludes(common, "BOARD_VENDOR_SEPOLICY_DIRS", commonMkBasename);
  assertIncludes(
    common,
    `vendor/${variant.vendorDir}/sepolicy`,
    commonMkBasename,
  );
  if (common.includes("PermissionController")) {
    fail(
      `${commonMkBasename} still references a PermissionController overlay; role defaults live in framework-res strings.`,
    );
  }

  // Per-Pixel templates exist and follow the same <PIXEL_CODENAME>
  // contract.
  const pixelTemplate = read(
    path.join(vendorDir, "products", `${variant.vendorDir}_pixel_phone.mk`),
  );
  assertIncludes(
    pixelTemplate,
    pixelCodenameSym,
    `${variant.vendorDir}_pixel_phone.mk`,
  );
  assertIncludes(
    pixelTemplate,
    variant.commonMk,
    `${variant.vendorDir}_pixel_phone.mk`,
  );

  const androidProducts = read(path.join(vendorDir, "AndroidProducts.mk"));
  assertMatches(
    androidProducts,
    new RegExp(
      `\\$\\(LOCAL_DIR\\)/products/${escapeRegExp(productFullName)}\\.mk`,
    ),
    "AndroidProducts.mk",
    `PRODUCT_MAKEFILES entry for ${productFullName}`,
  );
  if (buildVariant) {
    assertMatches(
      androidProducts,
      new RegExp(
        `${escapeRegExp(productFullName)}-${escapeRegExp(buildVariant)}`,
      ),
      "AndroidProducts.mk",
      `${variant.productLunch} lunch choice`,
    );
  }

  // Init script + sepolicy scaffold present.
  assertFile(initRcPath, `vendor/${variant.vendorDir} init script`);
  assertFile(
    path.join(vendorDir, "sepolicy", "file_contexts"),
    `vendor/${variant.vendorDir} sepolicy file_contexts`,
  );

  // Lint the init script syntactically — typos here only show up at
  // boot otherwise.
  const initIssues = lintInitRc(initRcPath);
  const initErrors = initIssues.filter((i) => !i.soft);
  if (initErrors.length > 0) {
    fail(
      `${initRcName} has lint errors:\n - ${initErrors
        .map((i) => `line ${i.line}: ${i.message}`)
        .join("\n - ")}`,
    );
  }

  const androidBp = read(
    path.join(vendorDir, "apps", variant.appName, "Android.bp"),
  );
  for (const marker of [
    "android_app_import",
    `name: "${variant.appName}"`,
    `apk: "${variant.appName}.apk"`,
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
    assertIncludes(androidBp, marker, `${variant.appName} Android.bp`);
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
    if (value !== variant.packageName) {
      fail(
        `framework-res overlay ${resourceName} must be ${variant.packageName}; found ${value || "<empty>"}`,
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

  console.log("[aosp:validate] Product layer checks passed.");
}

export function validateDefaultPermissions(ctx) {
  const { vendorDir, variant } = ctx;
  const defaultPermissions = read(
    path.join(
      vendorDir,
      "permissions",
      `default-permissions-${variant.packageName}.xml`,
    ),
  );
  assertIncludes(
    defaultPermissions,
    `<exception package="${variant.packageName}">`,
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
      `privapp-permissions-${variant.packageName}.xml`,
    ),
  );
  assertIncludes(
    privPermissions,
    `<privapp-permissions package="${variant.packageName}"`,
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
    `default-permissions-${variant.packageName}.xml`,
    `privapp-permissions-${variant.packageName}.xml`,
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

  console.log("[aosp:validate] Permission XML checks passed.");
}

/**
 * Vendor sepolicy files exist on the AOSP build path
 * (`BOARD_VENDOR_SEPOLICY_DIRS += vendor/<vendorDir>/sepolicy`). For
 * the local-agent-on-Android landing we currently rely on the
 * on-device agent running in the platform_app domain (assigned to
 * the variant APK by AOSP's seapp_contexts because the APK is
 * platform-signed). A custom `<vendorDir>_agent` domain was attempted
 * but tripped AOSP's neverallow envelope (platform_app cannot
 * transition to arbitrary domains, app domains cannot have
 * file_contexts targeting /data/data paths, etc.) — landing the full
 * domain transition requires a custom seinfo entry tied to a
 * different signing certificate.
 *
 * The validator pins:
 *   - file_contexts exists (BOARD_VENDOR_SEPOLICY_DIRS chokes if the
 *     listed dir has no policy files at all)
 *   - the primary `allow platform_app app_data_file:file { execute
 *     execute_no_trans };` rule that lets bun start
 *   - <vendorDir>_agent_exec and <vendorDir>_agent_data type
 *     declarations so a future custom-seinfo build can land its
 *     restorecon hooks without a churn rename
 *   - the documented-intent seccomp syscall list, so the runtime
 *     mitigation in ElizaAgentService.startAgentProcess()
 *     (BUN_FEATURE_FLAG_*) cannot drift away from the .te comment
 *     block silently
 *
 * SELinux cannot relax seccomp filters — those are installed at
 * zygote fork via `prctl(PR_SET_NO_NEW_PRIVS, 1)` from the per-arch
 * allowlists in `bionic/libc/seccomp/{x86_64,arm64}_app_policy.cpp`.
 * The bun feature flags are the runtime workaround; the .te comment
 * block is the audit trail; the second-line "kernel exemption" path
 * (which the spec asked about) lives in bionic itself, not here.
 *
 * See `os/android/vendor/<vendorDir>/sepolicy/README.md` for the
 * design.
 */
export function validateSepolicy(ctxOrVendorDir, maybeVariant) {
  // Back-compat: callers may pass either a context object (the new
  // shape) or a (vendorDir, variant) pair (used by build-aosp.mjs's
  // pre-build pin). Normalize.
  const ctx =
    typeof ctxOrVendorDir === "string"
      ? { vendorDir: ctxOrVendorDir, variant: maybeVariant }
      : ctxOrVendorDir;
  const { vendorDir, variant } = ctx;
  if (!variant) {
    throw new Error(
      "[aosp:validate] validateSepolicy requires a variant config; pass via ctx.variant.",
    );
  }
  const escPkg = variant.packageName.replace(/\./g, "\\\\.");
  const agentExecType = `${variant.vendorDir}_agent_exec`;
  const agentDataType = `${variant.vendorDir}_agent_data`;
  const teName = `${variant.vendorDir}_agent.te`;
  const sepolicyLabel = `vendor/${variant.vendorDir} sepolicy`;

  // file_contexts must exist for `BOARD_VENDOR_SEPOLICY_DIRS` to point at
  // a non-empty directory; AOSP's sepolicy build chokes if the listed
  // dir has no policy files at all. An empty file is fine.
  const fileContextsPath = path.join(vendorDir, "sepolicy", "file_contexts");
  assertFile(fileContextsPath, `${sepolicyLabel}/file_contexts`);
  const fileContexts = read(fileContextsPath);
  // file_contexts entries are advisory until a custom-seinfo build
  // re-introduces the domain transition, but the patterns must be
  // present so ElizaAgentService.relabelAgentTree()'s restorecon
  // call has labels to apply.
  assertMatches(
    fileContexts,
    new RegExp(`/data/data/${escPkg}/files/agent/x86_64.*${agentExecType}`),
    `${sepolicyLabel}/file_contexts`,
    "x86_64 binary tree label entry",
  );
  assertMatches(
    fileContexts,
    new RegExp(`/data/data/${escPkg}/files/agent/arm64-v8a.*${agentExecType}`),
    `${sepolicyLabel}/file_contexts`,
    "arm64-v8a binary tree label entry",
  );
  assertMatches(
    fileContexts,
    new RegExp(`/data/data/${escPkg}/files/agent.*${agentDataType}`),
    `${sepolicyLabel}/file_contexts`,
    "agent state dir label entry",
  );

  // The agent runs as platform_app and must be able to execve the bundled
  // bun runtime out of /data/data/<pkg>/files/agent/. AOSP's stock
  // platform_app.te has no such allow rule (only priv_app does), so we
  // add it here.
  const tePath = path.join(vendorDir, "sepolicy", teName);
  assertFile(tePath, `${sepolicyLabel}/${teName}`);
  const te = read(tePath);
  assertMatches(
    te,
    /allow\s+platform_app\s+app_data_file\s*:\s*file\b[^;]*\bexecute_no_trans\b[^;]*;/,
    teName,
    "allow platform_app app_data_file:file { execute execute_no_trans } (on-device agent exec)",
  );

  // Type declarations land the future-proofing seam. The custom
  // domain itself is not declared (it tripped neverallow checks
  // without a custom seinfo entry), but the file types are needed
  // by file_contexts and a future restorecon path.
  for (const typeName of [agentExecType, agentDataType]) {
    assertMatches(
      te,
      new RegExp(`\\btype\\s+${typeName}\\b`),
      teName,
      `type declaration for ${typeName}`,
    );
  }

  // The .te file documents the seccomp-blocked syscall list as a
  // comment block. ElizaAgentService.startAgentProcess() must
  // export the matching BUN_FEATURE_FLAG_* env vars at runtime.
  // Pin both ends so the docs and the mitigation can't drift.
  const documentedSyscalls = [
    "io_uring_setup",
    "io_uring_enter",
    "io_uring_register",
    "pidfd_open",
    "pidfd_send_signal",
    "pidfd_getfd",
    "clone3",
    "preadv2",
    "pwritev2",
  ];
  for (const syscall of documentedSyscalls) {
    assertIncludes(te, syscall, `${teName} (seccomp documented-intent block)`);
  }

  validateBunFeatureFlagsParity(te, variant);

  console.log("[aosp:validate] Sepolicy checks passed.");
}

/**
 * Pin the BUN_FEATURE_FLAG_* names that show up in the .te comment
 * block to the names ElizaAgentService.startAgentProcess() actually
 * exports. The Java service is the runtime mitigation; the comment
 * block is the audit trail; if the two drift a future bun upgrade
 * could quietly re-introduce a SIGSYS without anyone noticing.
 *
 * ElizaAgentService.java lives in two places:
 *   - apps/app/android/app/src/main/java/<host-app-package>/
 *     (parent fork's generated overlay, written by
 *     run-mobile-build.mjs / overlayAndroid() into a path derived
 *     from the AppConfig's `appId`)
 *   - eliza/packages/app-core/platforms/android/app/src/main/java/
 *     ai/elizaos/app/ (this submodule, source of truth for the
 *     overlay)
 *
 * We check whichever is on disk; on a fresh checkout only the eliza
 * submodule path is guaranteed.
 */
function validateBunFeatureFlagsParity(teContent, variant) {
  const expected = [
    "BUN_FEATURE_FLAG_DISABLE_IO_POOL",
    "BUN_FEATURE_FLAG_FORCE_WAITER_THREAD",
    "BUN_FEATURE_FLAG_DISABLE_RWF_NONBLOCK",
    "BUN_FEATURE_FLAG_DISABLE_SPAWNSYNC_FAST_PATH",
  ];
  const teName = `${variant.vendorDir}_agent.te`;
  for (const flag of expected) {
    if (!teContent.includes(flag)) {
      fail(
        `${teName} seccomp comment block is missing documented flag ${flag}`,
      );
    }
  }

  // ElizaAgentService.java may live under either the host's templated
  // `apps/app/android/app/src/main/java/<reverse-dns-of-packageName>/`
  // overlay (generated by run-mobile-build.mjs) or under the elizaOS
  // submodule's `platforms/android/app/.../ai/elizaos/app/`. Check
  // both; on a fresh checkout only the submodule path is guaranteed.
  const pkgPathSegments = variant.packageName.split(".");
  const candidatePaths = [
    path.join(
      repoRoot,
      "apps",
      "app",
      "android",
      "app",
      "src",
      "main",
      "java",
      ...pkgPathSegments,
      "ElizaAgentService.java",
    ),
    path.join(
      repoRoot,
      "eliza",
      "packages",
      "app-core",
      "platforms",
      "android",
      "app",
      "src",
      "main",
      "java",
      "ai",
      "elizaos",
      "app",
      "ElizaAgentService.java",
    ),
    // When this script runs from inside the eliza repo (no `eliza/`
    // submodule prefix), the same source-of-truth file lives at
    // `packages/app-core/platforms/...`.
    path.join(
      repoRoot,
      "packages",
      "app-core",
      "platforms",
      "android",
      "app",
      "src",
      "main",
      "java",
      "ai",
      "elizaos",
      "app",
      "ElizaAgentService.java",
    ),
  ];
  const javaPath = candidatePaths.find((p) => fs.existsSync(p));
  if (!javaPath) {
    // First-checkout state where neither overlay has been generated
    // yet. The .te comment block is still pinned above; runtime
    // parity gets re-checked on the next build that produces a Java
    // file on disk.
    console.log(
      "[aosp:validate] Skipping BUN_FEATURE_FLAG_* runtime parity check — no ElizaAgentService.java on disk yet.",
    );
    return;
  }
  const java = fs.readFileSync(javaPath, "utf8");
  for (const flag of expected) {
    if (!java.includes(flag)) {
      fail(
        `ElizaAgentService.java (${javaPath}) is missing seccomp mitigation flag ${flag}; documented in ${teName} but not exported at runtime`,
      );
    }
  }
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

function validateApkManifest(manifest, variant) {
  // Activity / Service / Receiver class names are framework-injected
  // by `run-mobile-build.mjs:overlayAndroid()` and always carry the
  // `Eliza<Role>` prefix regardless of fork. The package name is
  // per-fork (variant.packageName).
  const pkg = variant.packageName;

  const mainActivity = manifestComponentBlock(
    manifest,
    "activity",
    `${pkg}.MainActivity`,
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
    `${pkg}.ElizaDialActivity`,
  );
  assertCountAtLeast(
    dialActivity,
    "android.intent.action.DIAL",
    2,
    "APK manifest ElizaDialActivity",
  );
  assertManifestBlockIncludes(
    dialActivity,
    "android.intent.category.DEFAULT",
    "ElizaDialActivity",
  );
  assertManifestBlockIncludes(
    dialActivity,
    'android:scheme(0x01010027)="tel"',
    "ElizaDialActivity",
  );

  const assistActivity = manifestComponentBlock(
    manifest,
    "activity",
    `${pkg}.ElizaAssistActivity`,
  );
  assertManifestBlockIncludes(
    assistActivity,
    "android.intent.action.ASSIST",
    "ElizaAssistActivity",
  );
  assertManifestBlockIncludes(
    assistActivity,
    "android.intent.category.DEFAULT",
    "ElizaAssistActivity",
  );

  const inCallService = manifestComponentBlock(
    manifest,
    "service",
    `${pkg}.ElizaInCallService`,
  );
  assertManifestBlockIncludes(
    inCallService,
    "android.permission.BIND_INCALL_SERVICE",
    "ElizaInCallService",
  );
  assertManifestBlockIncludes(
    inCallService,
    "android.telecom.InCallService",
    "ElizaInCallService",
  );
  assertManifestBlockIncludes(
    inCallService,
    "android.telecom.IN_CALL_SERVICE_UI",
    "ElizaInCallService",
  );

  const smsReceiver = manifestComponentBlock(
    manifest,
    "receiver",
    `${pkg}.ElizaSmsReceiver`,
  );
  assertManifestBlockIncludes(
    smsReceiver,
    "android.permission.BROADCAST_SMS",
    "ElizaSmsReceiver",
  );
  assertManifestBlockIncludes(
    smsReceiver,
    "android.provider.Telephony.SMS_DELIVER",
    "ElizaSmsReceiver",
  );

  const mmsReceiver = manifestComponentBlock(
    manifest,
    "receiver",
    `${pkg}.ElizaMmsReceiver`,
  );
  assertManifestBlockIncludes(
    mmsReceiver,
    "android.permission.BROADCAST_WAP_PUSH",
    "ElizaMmsReceiver",
  );
  assertManifestBlockIncludes(
    mmsReceiver,
    "android.provider.Telephony.WAP_PUSH_DELIVER",
    "ElizaMmsReceiver",
  );
  assertManifestBlockIncludes(
    mmsReceiver,
    "application/vnd.wap.mms-message",
    "ElizaMmsReceiver",
  );

  const respondService = manifestComponentBlock(
    manifest,
    "service",
    `${pkg}.ElizaRespondViaMessageService`,
  );
  assertManifestBlockIncludes(
    respondService,
    "android.permission.SEND_RESPOND_VIA_MESSAGE",
    "ElizaRespondViaMessageService",
  );
  assertManifestBlockIncludes(
    respondService,
    "android.intent.action.RESPOND_VIA_MESSAGE",
    "ElizaRespondViaMessageService",
  );
  assertManifestBlockIncludes(
    respondService,
    'android:scheme(0x01010027)="smsto"',
    "ElizaRespondViaMessageService",
  );

  const composeActivity = manifestComponentBlock(
    manifest,
    "activity",
    `${pkg}.ElizaSmsComposeActivity`,
  );
  assertManifestBlockIncludes(
    composeActivity,
    "android.intent.action.SENDTO",
    "ElizaSmsComposeActivity",
  );
  assertManifestBlockIncludes(
    composeActivity,
    'android:scheme(0x01010027)="smsto"',
    "ElizaSmsComposeActivity",
  );

  const bootReceiver = manifestComponentBlock(
    manifest,
    "receiver",
    `${pkg}.ElizaBootReceiver`,
  );
  assertManifestBlockIncludes(
    bootReceiver,
    "android.intent.action.LOCKED_BOOT_COMPLETED",
    "ElizaBootReceiver",
  );
  assertManifestBlockIncludes(
    bootReceiver,
    "android.intent.action.BOOT_COMPLETED",
    "ElizaBootReceiver",
  );

  // Replacement activities for the role apps stripped from PRODUCT_PACKAGES.
  // Without these, the system has no resolver for the corresponding intents
  // and a stripped phone is a broken phone — http URLs can't open, alarms
  // can't be set, etc.

  // Replacement activities for stripped role apps (Browser2, Contacts,
  // Camera2, DeskClock, Calendar). These soft-warn instead of failing
  // because the activity Java sources land in the elizaOS submodule
  // and a staged APK built before they were added is still a valid
  // OS-path image — just one with intent-resolution gaps for the
  // corresponding system intents.
  const REPLACEMENT_ACTIVITIES = [
    {
      name: "ElizaBrowserActivity",
      markers: [
        "android.intent.action.VIEW",
        "android.intent.category.BROWSABLE",
        'android:scheme(0x01010027)="http"',
        'android:scheme(0x01010027)="https"',
      ],
    },
    {
      name: "ElizaContactsActivity",
      markers: ["android.intent.category.APP_CONTACTS"],
    },
    {
      name: "ElizaCameraActivity",
      markers: [
        "android.media.action.STILL_IMAGE_CAMERA",
        "android.media.action.IMAGE_CAPTURE",
      ],
    },
    {
      name: "ElizaClockActivity",
      markers: [
        "android.intent.action.SET_ALARM",
        "android.intent.action.SHOW_ALARMS",
      ],
    },
    {
      name: "ElizaCalendarActivity",
      markers: ["android.intent.category.APP_CALENDAR"],
    },
  ];

  const replacementWarnings = [];
  for (const { name, markers } of REPLACEMENT_ACTIVITIES) {
    const blocks = manifestElementBlocks(manifest, "activity").filter((b) =>
      b.includes(`"${pkg}.${name}"`),
    );
    if (blocks.length === 0) {
      replacementWarnings.push(
        `[soft] APK manifest is missing activity ${pkg}.${name} — system intent will have no resolver after stripping the corresponding AOSP app.`,
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
      `[aosp:validate] Soft warnings (rebuild APK to clear):\n - ${replacementWarnings.join("\n - ")}`,
    );
  }
}

export function validateApk(ctx) {
  const { apkPath, variant } = ctx;
  assertFile(apkPath, `${variant.appName} APK`);
  const aapt = resolveAapt();
  const badging = run(aapt, ["dump", "badging", apkPath]);
  assertIncludes(
    badging,
    `package: name='${variant.packageName}'`,
    "APK badging",
  );
  assertIncludes(
    badging,
    `application-label:'${variant.appName}'`,
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
  validateApkManifest(manifest, variant);
  console.log(`[aosp:validate] APK checks passed with ${aapt}.`);
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
      "AOSP HOME role unexpectedly has a defaultHolders config; revisit variant home defaulting.",
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

  console.log("[aosp:validate] AOSP source compatibility checks passed.");
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const ctx = resolveValidationContext({ args });
  validateXmlFiles(ctx);
  validateProductLayer(ctx);
  validateDefaultPermissions(ctx);
  validateSepolicy(ctx);
  validateApk(ctx);
  if (args.aospRoot) {
    validateAospRoot(args.aospRoot);
  }
  console.log(`[aosp:validate] ${ctx.variant.variantName} checks passed.`);
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main();
}

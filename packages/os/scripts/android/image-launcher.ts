#!/usr/bin/env node
/**
 * Eliza image launcher staging: the nonprivileged-launcher profile for
 * Eliza's own AOSP products (Cuttlefish, GSI and grizzly), the same
 * least-privilege composition the Pixel 10a Eliza product uses.
 *
 * The signed Eliza APK is staged as an additive, hash- and certificate-pinned
 * product launcher (stage-launcher-overlay.ts) with the reviewed first-boot
 * runtime grants from android/products/eliza-images.json, the default HOME,
 * assistant role and Autofill offer (launcher-provisioning.mjs), the image
 * capability feature (image-capability.mjs) and the system Clock requirement.
 * No privapp allowlist, platform certificate, priv-app placement, role-app
 * override or dialer/SMS preassignment is produced, and stock apps stay
 * installed as recovery paths.
 *
 * Where the product has a native installation target the admitted resident
 * runtime is installed beside the APK (android-native-admission.mjs), so the
 * untrusted_app agent executes it from its read-only native library directory
 * instead of from app data, which Android's W^X neverallow forbids.
 *
 * The output is staging evidence only. It is not an image build, an image
 * boot, or proof that Android applied the defaults.
 *
 *   node scripts/android/image-launcher.ts [--brand-config PATH] --apk SIGNED_APK
 *     (--descriptor REVIEWED_JSON | --development) [--output NEW_DIR]
 *     [--source-commit COMMIT] [--runtime-source ELIZA_ROOT] [--bun-target linux-musl|android]
 *     [--aapt PATH] [--apksigner PATH]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolveElizaSourceRoot } from "../eliza-source.ts";
import {
  elizaNativeAdmission,
  stageAndroidNative,
} from "./android-native-admission.mjs";
import { requireClockProduct } from "./aosp-clock-handlers.mjs";
import { loadBrandFromArgv } from "./brand-config.ts";
import {
  stagedImageFeature,
  writeImageCapability,
} from "./image-capability.mjs";
import {
  provisioningComponents,
  writeProvisioningOverlay,
} from "./launcher-provisioning.mjs";
import {
  createDevelopmentLauncherDescriptor,
  renderOverlay,
  stageLauncher,
  validateDescriptor,
} from "./stage-launcher-overlay.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

export const ELIZA_IMAGES_POLICY = path.join(
  repoRoot,
  "android",
  "products",
  "eliza-images.json",
);
/** Staged launcher directory inside a brand vendor tree (gitignored). */
export const LAUNCHER_DIRECTORY = "launcher";
export const IMAGE_LAUNCHER_EVIDENCE = "image-launcher.json";
const PROFILE = "nonprivileged-launcher";
const PARTITIONS = ["product", "system"];
/** Native installation targets of stage-android-native.py (product partition only). */
const NATIVE_TARGETS = ["cuttlefish"];
const PRODUCT = /^[a-z][a-z0-9_]*$/;
const PERMISSION = /^android\.permission\.[A-Z][A-Z0-9_]{0,63}$/;
/** Never part of a reviewed first-boot grant list for a nonprivileged launcher. */
const NEVER_GRANTED = new Set([
  "android.permission.MANAGE_APP_OPS_MODES",
  "android.permission.PACKAGE_USAGE_STATS",
  "android.permission.INJECT_EVENTS",
  "android.permission.READ_FRAME_BUFFER",
  "android.permission.REAL_GET_TASKS",
  "android.permission.MANAGE_VIRTUAL_MACHINE",
  "android.permission.SYSTEM_ALERT_WINDOW",
  "android.permission.WRITE_SECURE_SETTINGS",
]);

const sha256 = (file: string) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");

export interface ImageProduct {
  partition: "product" | "system";
  nativeTarget: string | null;
}
export interface ImagesPolicy {
  schemaVersion: 1;
  profile: typeof PROFILE;
  launcher: { brand: string; moduleName: string; packageName: string };
  defaultPermissions: string[];
  products: Record<string, ImageProduct>;
}

/** Validate the reviewed image launcher policy. */
export function validateImagesPolicy(value: unknown): ImagesPolicy {
  const policy = value as ImagesPolicy;
  if (
    !policy ||
    typeof policy !== "object" ||
    policy.schemaVersion !== 1 ||
    policy.profile !== PROFILE
  )
    throw new Error(`Expected a schema 1 ${PROFILE} image policy`);
  // The launcher identity uses the descriptor validator's own rules.
  validateDescriptor({
    schemaVersion: 1,
    ...policy.launcher,
    apkSha256: "0".repeat(64),
    certificateSha256: "0".repeat(64),
    defaultPermissions: policy.defaultPermissions,
  });
  if (
    !Array.isArray(policy.defaultPermissions) ||
    policy.defaultPermissions.some(
      (name) => !PERMISSION.test(name) || NEVER_GRANTED.has(name),
    )
  )
    throw new Error("Image policy grants a privileged or invalid permission");
  const products = Object.entries(policy.products ?? {});
  if (!products.length) throw new Error("Image policy lists no products");
  for (const [name, product] of products) {
    if (
      !PRODUCT.test(name) ||
      !product ||
      typeof product !== "object" ||
      Object.keys(product).sort().join() !== "nativeTarget,partition" ||
      !PARTITIONS.includes(product.partition) ||
      (product.nativeTarget !== null &&
        !NATIVE_TARGETS.includes(product.nativeTarget)) ||
      // Native payloads install beside the APK on the product partition only.
      (product.nativeTarget !== null && product.partition !== "product")
    )
      throw new Error(`Invalid image policy product ${name}`);
  }
  return policy;
}

export function loadImagesPolicy(file = ELIZA_IMAGES_POLICY): ImagesPolicy {
  return validateImagesPolicy(JSON.parse(fs.readFileSync(file, "utf8")));
}

/** The policy entry for one product, bound to the brand's launcher identity. */
export function imageProduct(
  policy: ImagesPolicy,
  brand: { productName: string; packageName: string; appName: string },
) {
  const product = Object.hasOwn(policy.products, brand.productName)
    ? policy.products[brand.productName]
    : undefined;
  if (!product)
    throw new Error(
      `${brand.productName} is not an image product of the ${PROFILE} policy`,
    );
  if (
    brand.packageName !== policy.launcher.packageName ||
    brand.appName !== policy.launcher.moduleName
  )
    throw new Error(
      `Brand ${brand.productName} does not match the reviewed launcher identity`,
    );
  return {
    productName: brand.productName,
    ...product,
    ...policy.launcher,
    installPath: `/${product.partition}/app/${policy.launcher.moduleName}/${policy.launcher.moduleName}.apk`,
  };
}

/** Exact installed APK path a booted image of this product must report. */
export function installedLauncherPath(
  brand: { productName: string; packageName: string; appName: string },
  policy = loadImagesPolicy(),
) {
  return imageProduct(policy, brand).installPath;
}

/**
 * A reviewed descriptor must carry the policy's identity, its exact grant list,
 * the product's partition and no companions.
 */
export function reviewDescriptor(
  policy: ImagesPolicy,
  brand: { productName: string; packageName: string; appName: string },
  value: unknown,
) {
  const descriptor = validateDescriptor(value);
  const product = imageProduct(policy, brand);
  if (
    descriptor.brand !== policy.launcher.brand ||
    descriptor.moduleName !== policy.launcher.moduleName ||
    descriptor.packageName !== policy.launcher.packageName
  )
    throw new Error("Descriptor does not carry the reviewed launcher identity");
  if (
    JSON.stringify(descriptor.defaultPermissions ?? []) !==
    JSON.stringify(policy.defaultPermissions)
  )
    throw new Error(
      "Descriptor default permissions differ from the reviewed image policy",
    );
  if ((descriptor.partition ?? "product") !== product.partition)
    throw new Error(
      `Descriptor partition must be ${product.partition} for ${brand.productName}`,
    );
  if (descriptor.companions !== undefined)
    throw new Error("Eliza image launchers stage no companions");
  return descriptor;
}

/** Makefile guard binding the staged directory to the product it was staged for. */
export function productGuard(productName: string) {
  if (!PRODUCT.test(productName)) throw new Error("Invalid product name");
  return `# Staged for ${productName} only (scripts/android/image-launcher.ts).\nifneq ($(ELIZA_PRODUCT_TAG),${productName})\n$(error vendor/eliza/${LAUNCHER_DIRECTORY} was staged for ${productName}, not $(ELIZA_PRODUCT_TAG); restage it)\nendif\n`;
}

/** stage-android-native.py moves the launcher into Android.mk and keeps the rest. */
const NATIVE_BLUEPRINT_HEADER =
  "// The launcher is defined in Android.mk for bundled JNI installation.\n";
const NATIVE_CONFIG = `\n# Exact executable modes for the admitted resident runtime JNI.\nimage_launcher_dir := $(patsubst %/,%,$(dir $(lastword $(MAKEFILE_LIST))))\nTARGET_FS_CONFIG_GEN += $(image_launcher_dir)/config.fs\n`;

export interface StageOptions {
  brand: { productName: string; packageName: string; appName: string };
  policy?: ImagesPolicy;
  apk: string;
  descriptor?: string | null;
  development: boolean;
  output: string;
  aapt: string;
  apksigner: string;
  env?: NodeJS.ProcessEnv;
  sourceCommit?: string | null;
  runtimeSource?: string | null;
  bunTarget?: "linux-musl" | "android";
}

export function stageImageLauncher(options: StageOptions) {
  const policy = options.policy ?? loadImagesPolicy();
  const product = imageProduct(policy, options.brand);
  if (!options.development && !options.descriptor)
    throw new Error(
      "Production image staging requires an independently reviewed --descriptor with pinned hash and signer",
    );
  if (!options.development && !product.nativeTarget)
    throw new Error(
      `Production staging of ${product.productName} needs the admitted resident runtime, and this product has no native installation target yet`,
    );
  if (product.nativeTarget && !options.sourceCommit)
    throw new Error(
      `${product.productName} installs the resident runtime: --source-commit is required`,
    );
  const output = path.resolve(options.output);
  if (fs.existsSync(output))
    throw new Error("Output exists; choose a new staging directory");
  const parent = path.dirname(output);
  fs.mkdirSync(parent, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(parent, ".image-launcher-"));
  try {
    let descriptor: ReturnType<typeof validateDescriptor>;
    if (options.descriptor) {
      descriptor = reviewDescriptor(
        policy,
        options.brand,
        JSON.parse(fs.readFileSync(options.descriptor, "utf8")),
      );
    } else {
      const generated = createDevelopmentLauncherDescriptor({
        identity: policy.launcher,
        apk: options.apk,
        apksigner: options.apksigner,
        development: true,
        env: options.env,
      });
      descriptor = reviewDescriptor(policy, options.brand, {
        ...generated,
        defaultPermissions: [...policy.defaultPermissions],
        ...(product.partition === "system" ? { partition: "system" } : {}),
      });
    }
    const descriptorFile = path.join(temporary, "descriptor.json");
    fs.writeFileSync(
      descriptorFile,
      `${JSON.stringify(descriptor, null, 2)}\n`,
    );
    const staged = path.join(temporary, LAUNCHER_DIRECTORY);
    stageLauncher({
      descriptor: descriptorFile,
      apk: options.apk,
      output: staged,
      aapt: options.aapt,
      apksigner: options.apksigner,
      development: options.development,
      env: options.env,
    });
    const launcherApk = path.join(staged, "Launcher.apk");
    const xml = execFileSync(
      options.aapt,
      ["dump", "xmltree", launcherApk, "AndroidManifest.xml"],
      { encoding: "utf8", env: options.env, maxBuffer: 64 << 20 },
    );
    const components = provisioningComponents(xml, descriptor.packageName);
    let native = null;
    if (product.nativeTarget) {
      native = stageAndroidNative({
        apk: launcherApk,
        output: staged,
        moduleName: descriptor.moduleName,
        target: product.nativeTarget,
        launcher: descriptor,
        admission: elizaNativeAdmission({
          sourceRoot: options.runtimeSource ?? resolveElizaSourceRoot(),
          sourceCommit: options.sourceCommit,
          packageName: descriptor.packageName,
          bunTarget: options.bunTarget ?? "linux-musl",
        }),
      });
      if (!native.residentAgentIncluded)
        throw new Error(
          `${product.productName} requires the admitted resident runtime`,
        );
    }
    writeProvisioningOverlay(staged, descriptor.packageName, components);
    writeImageCapability(staged, descriptor.packageName);
    const productMakefile = path.join(staged, "product.mk");
    fs.writeFileSync(
      productMakefile,
      `${productGuard(product.productName)}${requireClockProduct(fs.readFileSync(productMakefile, "utf8"))}${native ? NATIVE_CONFIG : ""}`,
    );
    const evidence = {
      schemaVersion: 1,
      profile: PROFILE,
      product: product.productName,
      partition: product.partition,
      installPath: product.installPath,
      packageName: descriptor.packageName,
      moduleName: descriptor.moduleName,
      apkSha256: descriptor.apkSha256,
      certificateSha256: descriptor.certificateSha256,
      defaultPermissions: descriptor.defaultPermissions ?? [],
      provisioning: components,
      imageFeature: stagedImageFeature(staged, descriptor.packageName),
      nativeTarget: product.nativeTarget,
      nativeLibrariesStaged: native !== null,
      residentAgentIncluded: native?.residentAgentIncluded === true,
      privileged: false,
      development: options.development,
      imageBuilt: false,
      imageBooted: false,
    };
    fs.writeFileSync(
      path.join(staged, IMAGE_LAUNCHER_EVIDENCE),
      `${JSON.stringify(evidence, null, 2)}\n`,
      { flag: "wx" },
    );
    verifyStagedLauncher(staged, options.brand, policy);
    if (fs.existsSync(output))
      throw new Error(`Output appeared during staging: ${output}`);
    fs.renameSync(staged, output);
    return evidence;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function fail(directory: string, message: string): never {
  throw new Error(`Staged launcher ${directory}: ${message}`);
}

function walk(directory: string, out: string[] = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`Link in staged launcher: ${file}`);
    if (entry.isDirectory()) walk(file, out);
    else out.push(file);
  }
  return out;
}

/**
 * Read-only check of a staged launcher directory: pinned bytes, nonprivileged
 * install rules, reviewed grants, provisioning, capability, Clock and product
 * guard. Returns the recorded staging evidence.
 */
export function verifyStagedLauncher(
  directory: string,
  brand: { productName: string; packageName: string; appName: string },
  policy = loadImagesPolicy(),
) {
  const at = (name: string) => path.join(directory, name);
  if (!fs.existsSync(at(IMAGE_LAUNCHER_EVIDENCE)))
    fail(
      directory,
      "is not staged; run scripts/android/image-launcher.ts with the signed launcher APK",
    );
  const product = imageProduct(policy, brand);
  const evidence = JSON.parse(
    fs.readFileSync(at(IMAGE_LAUNCHER_EVIDENCE), "utf8"),
  );
  const recorded = JSON.parse(fs.readFileSync(at("launcher.json"), "utf8"));
  const { development, ...launcher } = recorded;
  const descriptor = reviewDescriptor(policy, brand, launcher);
  if (
    evidence.schemaVersion !== 1 ||
    evidence.profile !== PROFILE ||
    evidence.product !== product.productName ||
    evidence.partition !== product.partition ||
    evidence.installPath !== product.installPath ||
    evidence.apkSha256 !== descriptor.apkSha256 ||
    evidence.certificateSha256 !== descriptor.certificateSha256 ||
    evidence.privileged !== false ||
    evidence.development !== development ||
    evidence.nativeTarget !== product.nativeTarget
  )
    fail(directory, `evidence does not belong to ${product.productName}`);
  if (sha256(at("Launcher.apk")) !== descriptor.apkSha256)
    fail(directory, "Launcher.apk differs from the pinned launcher hash");
  const files = walk(directory).map((file) => path.relative(directory, file));
  if (files.some((file) => /(^|\/)privapp-permissions[^/]*\.xml$/.test(file)))
    fail(directory, "a nonprivileged launcher carries no privapp allowlist");
  const blueprint = fs.readFileSync(at("Android.bp"), "utf8");
  const makefile = fs.existsSync(at("Android.mk"))
    ? fs.readFileSync(at("Android.mk"), "utf8")
    : "";
  if (
    /\bprivileged\s*:\s*true\b/.test(blueprint) ||
    /\bcertificate\s*:/.test(blueprint) ||
    /LOCAL_PRIVILEGED_MODULE\s*:?=\s*true/.test(makefile)
  )
    fail(directory, "the launcher must remain a presigned nonprivileged app");
  const overlay = renderOverlay(descriptor);
  if (product.nativeTarget) {
    if (
      evidence.nativeLibrariesStaged !== true ||
      evidence.residentAgentIncluded !== true ||
      !/^LOCAL_CERTIFICATE := PRESIGNED$/m.test(makefile) ||
      !/^LOCAL_PRODUCT_MODULE := true$/m.test(makefile) ||
      blueprint !==
        NATIVE_BLUEPRINT_HEADER +
          overlay.blueprint.slice(
            renderOverlay({ ...descriptor, defaultPermissions: undefined })
              .blueprint.length,
          )
    )
      fail(directory, "the admitted resident runtime is not staged");
    const native = JSON.parse(
      fs.readFileSync(at("native-libraries.json"), "utf8"),
    );
    if (
      native.apkSha256 !== descriptor.apkSha256 ||
      native.moduleName !== descriptor.moduleName ||
      native.target !== product.nativeTarget ||
      native.residentAgentIncluded !== true
    )
      fail(directory, "native staging evidence differs from the launcher");
    for (const library of native.libraries ?? [])
      if (sha256(at(library.path)) !== library.sha256)
        fail(directory, `native library ${library.path} changed`);
  } else if (makefile || blueprint !== overlay.blueprint)
    fail(directory, "Android.bp is not the admitted launcher overlay");
  const grants = fs.readFileSync(at("default-permissions.xml"), "utf8");
  const granted = [
    ...grants.matchAll(/<permission name="([^"]+)" fixed="false"\/>/g),
  ].map((match) => match[1]);
  if (
    JSON.stringify(granted) !== JSON.stringify(policy.defaultPermissions) ||
    /fixed="true"/.test(grants)
  )
    fail(directory, "default permissions differ from the reviewed policy");
  const assistant = fs.readFileSync(
    at("provisioning/overlay/frameworks/base/core/res/res/values/config.xml"),
    "utf8",
  );
  if (
    !assistant.includes(
      `<string name="config_defaultAssistant" translatable="false">${descriptor.packageName}</string>`,
    ) ||
    /config_default(Dialer|Sms)/.test(assistant)
  )
    fail(directory, "provisioning must assign only the assistant and Autofill");
  const home = fs.readFileSync(
    at("provisioning/preferred-apps/launcher-home.xml"),
    "utf8",
  );
  if (!home.includes(`<set name="${descriptor.packageName}/`))
    fail(directory, "default HOME is not the launcher");
  if (!stagedImageFeature(directory, descriptor.packageName))
    fail(directory, "the image capability feature is missing");
  const productMk = fs.readFileSync(at("product.mk"), "utf8");
  if (
    !productMk.startsWith(productGuard(product.productName)) ||
    !new RegExp(`^PRODUCT_PACKAGES \\+= ${descriptor.moduleName}\\b`, "m").test(
      productMk,
    ) ||
    requireClockProduct(productMk) !== productMk ||
    !productMk.includes("$(launcher_provisioning_dir)/overlay")
  )
    fail(directory, "product.mk is not the staged launcher composition");
  return evidence;
}

export function main(argv = process.argv.slice(2)) {
  const { brand, remaining } = loadBrandFromArgv(argv);
  const fields: Record<string, string> = {
    "--apk": "apk",
    "--descriptor": "descriptor",
    "--output": "output",
    "--source-commit": "sourceCommit",
    "--runtime-source": "runtimeSource",
    "--bun-target": "bunTarget",
    "--aapt": "aapt",
    "--apksigner": "apksigner",
  };
  const options: Record<string, string> = {};
  let development = false;
  for (let i = 0; i < remaining.length; i++) {
    const flag = remaining[i] ?? "";
    if (flag === "--development") {
      development = true;
      continue;
    }
    if (flag === "-h" || flag === "--help") {
      console.log(
        "Usage: node scripts/android/image-launcher.ts [--brand-config PATH] --apk SIGNED_APK (--descriptor REVIEWED_JSON | --development) [--output NEW_DIR] [--source-commit COMMIT] [--runtime-source ELIZA_ROOT] [--bun-target linux-musl|android] [--aapt PATH] [--apksigner PATH]",
      );
      return null;
    }
    const field = fields[flag];
    const value = remaining[++i];
    if (!field || !value || value.startsWith("--") || field in options)
      throw new Error(`Unexpected argument: ${flag}`);
    options[field] = value;
  }
  if (!options.apk) throw new Error("--apk SIGNED_APK is required");
  if (
    options.bunTarget !== undefined &&
    !["linux-musl", "android"].includes(options.bunTarget)
  )
    throw new Error("--bun-target must be linux-musl or android");
  const evidence = stageImageLauncher({
    brand,
    apk: path.resolve(options.apk),
    descriptor: options.descriptor ? path.resolve(options.descriptor) : null,
    development,
    output: path.resolve(
      options.output ??
        path.join(repoRoot, brand.vendorDir, LAUNCHER_DIRECTORY),
    ),
    aapt: options.aapt ?? "aapt",
    apksigner: options.apksigner ?? "apksigner",
    sourceCommit: options.sourceCommit ?? null,
    runtimeSource: options.runtimeSource ?? null,
    bunTarget: (options.bunTarget as "linux-musl" | "android") ?? "linux-musl",
  });
  console.log(JSON.stringify(evidence, null, 2));
  return evidence;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();

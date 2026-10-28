import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireClockProduct } from "./aosp-clock-handlers.mjs";
import {
  stagedImageFeature,
  writeImageCapability,
} from "./image-capability.mjs";
import {
  admitBrandAssets,
  validateBrandAssets,
  writeBrandAssets,
} from "./pixel10a-brand-assets.mjs";
import { renderOverlay, validateDescriptor } from "./stage-launcher-overlay.ts";

const hardwareRoot = fileURLToPath(
  new URL("../../android/devices/pixel10a/", import.meta.url),
);
const token = /^[a-z][a-z0-9_]*$/;
const packageName = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
export const sensePrivileges = [
  "android.permission.CAPTURE_AUDIO_HOTWORD",
  "android.permission.START_ACTIVITIES_FROM_BACKGROUND",
];

export function validatePixel10aProduct(value) {
  if (
    value?.schemaVersion !== 1 ||
    value.target !== "pixel10a" ||
    value.sourceProfile !== "pixel10a" ||
    value.vendorDirectory !== "alphaphone" ||
    value.releaseQualified !== false
  )
    throw new Error(
      "Expected unqualified Pixel 10a product on the shared source and compatibility vendor path",
    );
  if (
    !token.test(value.productName) ||
    !/^[a-z0-9_]+$/.test(value.releaseConfig) ||
    !/^[A-Z][A-Za-z0-9]*$/.test(value.launcher?.moduleName) ||
    !packageName.test(value.launcher?.packageName)
  )
    throw new Error("Invalid Pixel 10a product or launcher identity");
  for (const name of ["model", "brand", "manufacturer"]) {
    if (
      typeof value[name] !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/.test(value[name])
    )
      throw new Error(`Invalid Pixel 10a ${name}`);
  }
  validateBrandAssets(value.brandAssets);
  return value;
}

/** The only privileged package in this product is its separately admitted listener. */
export function renderSensePermissions(appId) {
  if (!packageName.test(appId))
    throw new Error("Invalid listener application identity");
  return `<?xml version="1.0" encoding="utf-8"?>\n<permissions>\n    <privapp-permissions package="${appId}.sense">\n${sensePrivileges.map((name) => `        <permission name="${name}" />\n`).join("")}    </privapp-permissions>\n</permissions>\n`;
}

function checkListenerPolicy(output, appId) {
  const directory = path.join(output, "listener");
  if (!fs.existsSync(directory)) return;
  const files = fs.readdirSync(path.join(directory, "permissions"));
  const entries = files.filter(
    (name) => name.startsWith("privapp-permissions-") && name.endsWith(".xml"),
  );
  if (entries.length !== 1)
    throw new Error("Pixel 10a listener must have one exact privapp allowlist");
  const xml = fs
    .readFileSync(path.join(directory, "permissions", entries[0]), "utf8")
    .replace(/<!--[\s\S]*?-->/g, "");
  const packages = [
    ...xml.matchAll(/<privapp-permissions\s+package="([^"]+)"/g),
  ].map((row) => row[1]);
  const permissions = [...xml.matchAll(/<permission\s+name="([^"]+)"\s*\/>/g)]
    .map((row) => row[1])
    .sort();
  if (
    packages.length !== 1 ||
    packages[0] !== `${appId}.sense` ||
    JSON.stringify(permissions) !==
      JSON.stringify([...sensePrivileges].sort()) ||
    /<deny-permission/.test(xml)
  )
    throw new Error(
      "Pixel 10a listener grants must remain the exact minimal Sense permissions",
    );
}

function verifyNativeStaging(output, launcher, evidence) {
  if (evidence === undefined) return false;
  if (
    evidence.schemaVersion !== 1 ||
    evidence.nativeLibrariesStaged !== true ||
    evidence.target !== "stallion" ||
    evidence.moduleName !== launcher.moduleName ||
    evidence.apkSha256 !== launcher.apkSha256 ||
    !Array.isArray(evidence.libraries) ||
    !evidence.libraries.length ||
    evidence.libraries.length > 256 ||
    evidence.runtimeVerified !== false ||
    evidence.deployReady !== false
  )
    throw new Error(
      "Native staging evidence differs from the admitted launcher",
    );
  const recorded = JSON.parse(
    fs.readFileSync(path.join(output, "native-libraries.json"), "utf8"),
  );
  if (JSON.stringify(recorded) !== JSON.stringify(evidence))
    throw new Error("Native staging receipt differs");
  const names = new Set();
  for (const library of evidence.libraries) {
    const name =
      typeof library.path === "string" ? path.posix.basename(library.path) : "";
    const mode = [
      "libeliza_bun.so",
      "libeliza_ld_musl_aarch64.so",
      "libeliza_ld_musl_aarch64_real.so",
    ].includes(name)
      ? "0755"
      : "0644";
    if (
      !/^native-arm64\/lib[A-Za-z0-9_.+-]+\.so$/.test(library.path) ||
      !/^[a-f0-9]{64}$/.test(library.sha256) ||
      names.has(name) ||
      library.apkEntry !== `lib/arm64-v8a/${name}` ||
      library.installPath !==
        `/product/app/${launcher.moduleName}/lib/arm64/${name}` ||
      library.mode !== mode
    )
      throw new Error("Invalid native staging entry");
    names.add(name);
    const file = path.join(output, library.path);
    if (
      !fs.lstatSync(file).isFile() ||
      createHash("sha256").update(fs.readFileSync(file)).digest("hex") !==
        library.sha256
    )
      throw new Error("Native staged bytes differ");
  }
  const expected = evidence.libraries
    .map(
      (library) =>
        `[${library.installPath.slice(1)}]\nmode: ${library.mode}\nuser: AID_ROOT\ngroup: AID_ROOT\ncaps: 0\n\n`,
    )
    .join("");
  if (fs.readFileSync(path.join(output, "config.fs"), "utf8") !== expected)
    throw new Error(
      "Native filesystem configuration differs from admitted libraries",
    );
  return true;
}

/** Compose a previously admitted, nonprivileged launcher overlay. No source or device writes. */
export function composePixel10aProduct({
  output,
  product,
  launcher,
  sourceEvidence,
  nativeStagingEvidence,
  production = false,
  bootAnimation = null,
  vendorApi = null,
}) {
  product = validatePixel10aProduct(product);
  launcher = validateDescriptor(launcher);
  if (
    launcher.packageName !== product.launcher.packageName ||
    launcher.moduleName !== product.launcher.moduleName ||
    launcher.partition === "system"
  )
    throw new Error(
      "Launcher differs from the Pixel 10a product identity or product partition",
    );
  const blueprint = fs.readFileSync(path.join(output, "Android.bp"), "utf8");
  const makefile = fs.existsSync(path.join(output, "Android.mk"))
    ? fs.readFileSync(path.join(output, "Android.mk"), "utf8")
    : "";
  if (
    /\bprivileged\s*:\s*true\b/.test(blueprint) ||
    /LOCAL_PRIVILEGED_MODULE\s*:?=\s*true/.test(makefile)
  )
    throw new Error("Pixel 10a main launcher must remain nonprivileged");
  if (!makefile && blueprint !== renderOverlay(launcher).blueprint)
    throw new Error("Pixel 10a requires an admitted launcher overlay");
  const nativeLibrariesStaged = verifyNativeStaging(
    output,
    launcher,
    nativeStagingEvidence,
  );
  checkListenerPolicy(output, launcher.packageName);
  // Pinned brand assets are verified before anything is written.
  const brandAssets = admitBrandAssets(product, { bootAnimation });
  for (const name of [
    "AndroidProducts.mk",
    `${product.productName}.mk`,
    "stallion",
    "brand",
    "physical-product.json",
  ])
    if (fs.existsSync(path.join(output, name)))
      throw new Error(`Pixel 10a composition already exists: ${name}`);
  fs.cpSync(hardwareRoot, path.join(output, "stallion"), {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  fs.writeFileSync(
    path.join(output, `${product.productName}.mk`),
    `# Shared Pixel 10a/stallion hardware; retain the verified compatibility vendor path.\nUSE_STOCK_KERNEL := true\n$(call inherit-product, vendor/google_devices/stallion/stallion.mk)\n$(call inherit-product, vendor/alphaphone/product.mk)\n\nPRODUCT_NAME := ${product.productName}\nPRODUCT_DEVICE := stallion\nPRODUCT_MODEL := ${product.model}\nPRODUCT_BRAND := ${product.brand}\nPRODUCT_MANUFACTURER := ${product.manufacturer}\n${brandAssets.makefile ?? ""}`,
    { flag: "wx" },
  );
  writeBrandAssets(output, brandAssets);
  fs.writeFileSync(
    path.join(output, "AndroidProducts.mk"),
    `PRODUCT_MAKEFILES := $(LOCAL_DIR)/${product.productName}.mk\nCOMMON_LUNCH_CHOICES := \\\n    ${product.productName}-${product.releaseConfig}-userdebug \\\n    ${product.productName}-${product.releaseConfig}-user\n`,
    { flag: "wx" },
  );
  if (makefile)
    fs.appendFileSync(
      path.join(output, "product.mk"),
      "\n# Exact executable modes for admitted bundled JNI.\nTARGET_FS_CONFIG_GEN += vendor/alphaphone/config.fs\n",
    );
  // Alarms and timers stay with the system Clock in every brand's image.
  const productMakefile = path.join(output, "product.mk");
  const launcherProduct = fs.readFileSync(productMakefile, "utf8");
  const withClock = requireClockProduct(launcherProduct);
  if (withClock !== launcherProduct)
    fs.writeFileSync(productMakefile, withClock);
  // Image-only surfaces (Phone, Contacts, SMS) need the launcher's image
  // feature; every brand's Pixel image declares it exactly once.
  if (!stagedImageFeature(output, launcher.packageName))
    writeImageCapability(output, launcher.packageName);
  const imageFeature = stagedImageFeature(output, launcher.packageName);
  const evidence = {
    schema: 1,
    target: "pixel10a",
    product: product.productName,
    lunch: `${product.productName}-${product.releaseConfig}-${production ? "user" : "userdebug"}`,
    production,
    developmentOnly: !production,
    nativeLibrariesStaged,
    brandAssets: brandAssets.evidence,
    sourceEvidence,
    vendorApi,
    imageFeature,
    imageBuilt: false,
    imageSigned: false,
    releaseQualified: false,
    deviceAcceptanceVerified: false,
  };
  fs.writeFileSync(
    path.join(output, "physical-product.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
    { flag: "wx" },
  );
  return evidence;
}

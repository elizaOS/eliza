import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireClockProduct } from "./aosp-clock-handlers.mjs";
import {
  renderImageProvisioningOverlay,
  stagedImageFeature,
  writeImageCapability,
  writeImageProvisioningOverlay,
} from "./image-capability.mjs";
import {
  admitBrandAssets,
  validateBrandAssets,
  writeBrandAssets,
} from "./pixel10a-brand-assets.mjs";
import { assertNoLockScreenSurface } from "./secure-camera.mjs";
import { renderOverlay, validateDescriptor } from "./stage-launcher-overlay.ts";
import {
  admitSystemUpdater,
  writeSystemUpdater,
} from "./system-updater-staging.mjs";

const hardwareRoot = fileURLToPath(
  new URL("../../android/devices/pixel10a/", import.meta.url),
);
const token = /^[a-z][a-z0-9_]*$/;
const packageName = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const moduleName = /^[A-Z][A-Za-z0-9]*$/;
const defaultPixelConfig = Object.freeze({
  moduleName: "PixelConfig",
  packageName: "ai.eliza.hardware.pixelconfig",
  mimeType: "vnd.android.cursor.dir/vnd.eliza.pixel-flags",
});

function pixelConfigIdentity(product) {
  const identity =
    product.pixelConfig === undefined
      ? defaultPixelConfig
      : product.pixelConfig;
  if (
    !identity ||
    typeof identity !== "object" ||
    Array.isArray(identity) ||
    Object.keys(identity).some(
      (key) => !["moduleName", "packageName", "mimeType"].includes(key),
    ) ||
    typeof identity.moduleName !== "string" ||
    !moduleName.test(identity.moduleName) ||
    typeof identity.packageName !== "string" ||
    !packageName.test(identity.packageName) ||
    typeof identity.mimeType !== "string" ||
    !/^vnd\.android\.cursor\.dir\/vnd\.[a-z0-9][a-z0-9_.-]*$/.test(
      identity.mimeType,
    ) ||
    identity.moduleName === product.launcher?.moduleName ||
    identity.moduleName === product.sense?.moduleName ||
    identity.packageName === product.launcher?.packageName ||
    identity.packageName === `${product.launcher?.packageName}.sense`
  )
    throw new Error("Invalid Pixel 10a pixelConfig identity");
  return identity;
}
export const sensePrivileges = [
  "android.permission.CAPTURE_AUDIO_HOTWORD",
  "android.permission.START_ACTIVITIES_FROM_BACKGROUND",
];

export function validatePixel10aProduct(value) {
  if (
    value?.schemaVersion !== 1 ||
    value.target !== "pixel10a" ||
    value.sourceProfile !== "pixel10a" ||
    typeof value.vendorDirectory !== "string" ||
    !token.test(value.vendorDirectory) ||
    value.releaseQualified !== false
  )
    throw new Error(
      "Expected unqualified Pixel 10a product with an explicit safe vendorDirectory",
    );
  if (
    !token.test(value.productName) ||
    !/^[a-z0-9_]+$/.test(value.releaseConfig) ||
    !moduleName.test(value.launcher?.moduleName) ||
    !packageName.test(value.launcher?.packageName)
  )
    throw new Error("Invalid Pixel 10a product or launcher identity");
  if (
    value.launcher.refuseLockScreenSurfaces !== undefined &&
    typeof value.launcher.refuseLockScreenSurfaces !== "boolean"
  )
    throw new Error("launcher.refuseLockScreenSurfaces must be a boolean");
  if (
    value.launcher.assistantRole !== undefined &&
    typeof value.launcher.assistantRole !== "boolean"
  )
    throw new Error("launcher.assistantRole must be a boolean");
  if (value.launcher.imageProvisioning !== undefined) {
    const provisioning = value.launcher.imageProvisioning;
    if (
      !provisioning ||
      typeof provisioning !== "object" ||
      Object.keys(provisioning).some(
        (key) => !["module", "overlayable", "resource"].includes(key),
      )
    )
      throw new Error(
        "launcher.imageProvisioning takes only module, overlayable and resource",
      );
    renderImageProvisioningOverlay(value.launcher.packageName, provisioning);
  }
  for (const name of ["model", "brand", "manufacturer"]) {
    if (
      typeof value[name] !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/.test(value[name])
    )
      throw new Error(`Invalid Pixel 10a ${name}`);
  }
  if (
    value.systemUpdater !== undefined &&
    typeof value.systemUpdater !== "boolean"
  )
    throw new Error(
      "systemUpdater must be a boolean; enrollment is a separate gate",
    );
  validateBrandAssets(value.brandAssets);
  pixelConfigIdentity(value);
  return value;
}

/** Check the selected layout only after the complete source inventory is admitted. */
export function assertPixel10aSourceLayout(aospRoot, product) {
  validatePixel10aProduct(product);
  const file = "vendor/google_devices/stallion/stallion.mk";
  const bytes = fs.readFileSync(path.join(aospRoot, file));
  const includes = [
    ...bytes
      .toString("utf8")
      .matchAll(
        /^\$\(call inherit-product, (vendor\/[a-z][a-z0-9_]*\/stallion\/device\.mk)\)\s*$/gm,
      ),
  ];
  const expected = `vendor/${product.vendorDirectory}/stallion/device.mk`;
  if (includes.length !== 1 || includes[0][1] !== expected)
    throw new Error(
      `Pixel 10a source layout differs: admitted source must inherit ${expected}; use a matching reviewed source inventory`,
    );
  return {
    vendorDirectory: product.vendorDirectory,
    path: file,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/** Render hardware-owned templates without changing the locked AOSP source. */
function renderHardware(product) {
  const pixelConfig = pixelConfigIdentity(product);
  const replacements = {
    "@VENDOR_DIRECTORY@": product.vendorDirectory,
    "@PIXEL_CONFIG_MODULE@": pixelConfig.moduleName,
  };
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const files = [];
  for (const name of fs.readdirSync(hardwareRoot, { recursive: true }).sort()) {
    const file = path.join(hardwareRoot, name);
    const stat = fs.lstatSync(file);
    if (stat.isDirectory()) continue;
    if (!stat.isFile())
      throw new Error(`Invalid Pixel hardware input: ${name}`);
    const before = fs.readFileSync(file);
    const original = before.toString("utf8");
    let text = original;
    for (const [token, value] of Object.entries(replacements))
      text = text.replaceAll(token, value);
    // Existing installed identities are explicit product compatibility data.
    if (name.startsWith("vendor-config/"))
      text = text
        .replaceAll(defaultPixelConfig.moduleName, pixelConfig.moduleName)
        .replaceAll(defaultPixelConfig.packageName, pixelConfig.packageName)
        .replaceAll(defaultPixelConfig.mimeType, pixelConfig.mimeType);
    const relative = name.replace(
      "src/ai/eliza/hardware/pixelconfig/",
      `src/${pixelConfig.packageName.replaceAll(".", "/")}/`,
    );
    const bytes = text === original ? before : Buffer.from(text);
    files.push({
      sourcePath: name,
      path: `stallion/${relative}`,
      sourceSha256: digest(before),
      sha256: digest(bytes),
      mode: stat.mode & 0o777,
      bytes,
    });
  }
  return { files, pixelConfig };
}

/**
 * A brand that leaves capture over Keyguard to the system Camera2 sets
 * launcher.refuseLockScreenSurfaces; its launcher manifest (aapt xmltree)
 * must then declare no activity shown over Keyguard and no secure-capture
 * handler. Brands with their own lock-screen surfaces (for example an alarm
 * ringing activity) leave it unset.
 */
export function enforceLauncherLockScreenPolicy(product, xmltree) {
  if (product.launcher.refuseLockScreenSurfaces !== true) return false;
  return assertNoLockScreenSurface(xmltree, { brand: product.brand });
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
  const hardware = renderHardware(product);
  const updater = admitSystemUpdater(product);
  for (const name of [
    "AndroidProducts.mk",
    `${product.productName}.mk`,
    "stallion",
    "brand",
    "physical-product.json",
    ...(updater ? ["system-updater"] : []),
  ])
    if (fs.existsSync(path.join(output, name)))
      throw new Error(`Pixel 10a composition already exists: ${name}`);
  for (const file of hardware.files) {
    const target = path.join(output, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.bytes, { flag: "wx" });
    fs.chmodSync(target, file.mode);
  }
  fs.writeFileSync(
    path.join(output, `${product.productName}.mk`),
    `# Shared Pixel 10a/stallion hardware with the selected product layout.\nUSE_STOCK_KERNEL := true\n$(call inherit-product, vendor/google_devices/stallion/stallion.mk)\n$(call inherit-product, vendor/${product.vendorDirectory}/product.mk)\n\nPRODUCT_NAME := ${product.productName}\nPRODUCT_DEVICE := stallion\nPRODUCT_MODEL := ${product.model}\nPRODUCT_BRAND := ${product.brand}\nPRODUCT_MANUFACTURER := ${product.manufacturer}\n${brandAssets.makefile ?? ""}`,
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
      `\n# Exact executable modes for admitted bundled JNI.\nTARGET_FS_CONFIG_GEN += vendor/${product.vendorDirectory}/config.fs\n`,
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
  // A presigned launcher that reads an overlayable provisioning resource
  // (launcher.imageProvisioning) gets it set by a product RRO in production
  // images only; development images leave the APK's false default.
  let imageProvisioning = null;
  if (production && product.launcher.imageProvisioning) {
    const files = writeImageProvisioningOverlay(
      output,
      launcher.packageName,
      product.launcher.imageProvisioning,
    );
    imageProvisioning = {
      module: /name: "([^"]+)"/.exec(files["image-capabilities/Android.bp"])[1],
      overlayable: /android:targetName="([^"]+)"/.exec(
        files["image-capabilities/AndroidManifest.xml"],
      )[1],
    };
  }
  const systemUpdater = writeSystemUpdater(output, product, updater);
  const evidence = {
    schema: 1,
    target: "pixel10a",
    product: product.productName,
    lunch: `${product.productName}-${product.releaseConfig}-${production ? "user" : "userdebug"}`,
    production,
    developmentOnly: !production,
    nativeLibrariesStaged,
    hardwareComposition: {
      vendorDirectory: product.vendorDirectory,
      pixelConfig: hardware.pixelConfig,
      files: hardware.files.map(({ bytes, ...record }) => record),
    },
    brandAssets: brandAssets.evidence,
    systemUpdater,
    sourceEvidence,
    vendorApi,
    imageFeature,
    imageProvisioning,
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

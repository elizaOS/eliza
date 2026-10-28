#!/usr/bin/env node
/** Explicit Pixel 10a source/product staging. This never writes into the AOSP source. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElizaSourceRoot } from "../eliza-source.ts";
import {
  elizaNativeAdmission,
  finalizeAndroidNative,
  stageAndroidNative,
} from "./android-native-admission.mjs";
import {
  provisioningComponents,
  writeProvisioningOverlay,
} from "./launcher-provisioning.mjs";
import {
  composePixel10aProduct,
  validatePixel10aProduct,
} from "./pixel10a-product.ts";
import { stageSenseApk, validateSenseProduct } from "./sense-listener.mjs";
import { senseSystemuiPatch } from "./sense-systemui.mjs";
import { soongAppNativePatch } from "./soong-app-native.mjs";
import { stageLauncher, validateDescriptor } from "./stage-launcher-overlay.ts";
import { loadProfile, verifyProfileSource } from "./verify-source-lock.ts";

export async function stagePixel10aProduct(options) {
  const product = validatePixel10aProduct(
    JSON.parse(fs.readFileSync(options.product, "utf8")),
  );
  validateSenseProduct(product);
  const launcher = validateDescriptor(
    JSON.parse(fs.readFileSync(options.descriptor, "utf8")),
  );
  if (
    launcher.packageName !== product.launcher.packageName ||
    launcher.moduleName !== product.launcher.moduleName
  )
    throw new Error("Launcher does not match the selected Pixel 10a product");
  if (fs.existsSync(options.output))
    throw new Error("Output exists; choose a new staging directory");
  // Resolve existing ancestors before creating any output directory, including symlinks.
  let ancestor = path.resolve(options.output);
  const suffix = [];
  while (!fs.existsSync(ancestor)) {
    suffix.unshift(path.basename(ancestor));
    ancestor = path.dirname(ancestor);
  }
  const destination = path.join(fs.realpathSync(ancestor), ...suffix);
  const sourceRoot = fs.realpathSync(options.aospRoot);
  if (
    destination === sourceRoot ||
    destination.startsWith(`${sourceRoot}${path.sep}`)
  )
    throw new Error(
      "Pixel staging output must be outside the AOSP source tree",
    );
  if (
    !options.development &&
    (!options.listenerApk || !options.listenerDescriptor || !options.voiceHost)
  )
    throw new Error(
      "Pixel 10a production requires Sense APK, reviewed listener descriptor and voice-host record",
    );
  if (options.listenerApk && !options.voiceHost)
    throw new Error("Sense staging requires a voice-host record");
  if (!options.appliedAppNativePatch)
    throw new Error(
      "Pixel 10a staging requires --applied-app-native-patch for native Soong installation",
    );
  const admission = elizaNativeAdmission({
    sourceRoot: options.runtimeSource ?? resolveElizaSourceRoot(),
    sourceCommit: options.sourceCommit,
    packageName: launcher.packageName,
    bunTarget: options.bunTarget ?? "linux-musl",
  });
  const sourceEvidence = await verifyProfileSource(
    loadProfile(product.sourceProfile),
    {
      aospRoot: options.aospRoot,
      archivePath: options.archivePath,
      appliedPatches: [
        soongAppNativePatch(),
        ...(options.appliedSensePatch ? [senseSystemuiPatch()] : []),
      ],
    },
  );
  const parent = path.dirname(path.resolve(options.output));
  fs.mkdirSync(parent, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(parent, ".pixel10a-product-"));
  const output = path.join(temporary, "overlay");
  try {
    stageLauncher({ ...options, output });
    const xml = execFileSync(
      options.aapt,
      [
        "dump",
        "xmltree",
        path.join(output, "Launcher.apk"),
        "AndroidManifest.xml",
      ],
      { encoding: "utf8", env: options.env },
    );
    const components = provisioningComponents(xml, launcher.packageName);
    writeProvisioningOverlay(output, launcher.packageName, components);
    const nativeStagingEvidence = stageAndroidNative({
      apk: path.join(output, "Launcher.apk"),
      output,
      moduleName: launcher.moduleName,
      launcher,
      admission,
    });
    if (!nativeStagingEvidence.residentAgentIncluded)
      throw new Error("Pixel 10a requires the admitted resident runtime");
    if (options.listenerApk)
      stageSenseApk({
        apk: options.listenerApk,
        output,
        product,
        launcherSigner: launcher.certificateSha256,
        descriptor: options.listenerDescriptor
          ? JSON.parse(fs.readFileSync(options.listenerDescriptor, "utf8"))
          : undefined,
        voiceHost: JSON.parse(fs.readFileSync(options.voiceHost, "utf8")),
        production: !options.development,
        aapt: options.aapt,
        apksigner: options.apksigner,
        env: options.env,
      });
    const result = composePixel10aProduct({
      output,
      product,
      launcher,
      sourceEvidence,
      nativeStagingEvidence,
      production: !options.development,
    });
    finalizeAndroidNative({
      apk: path.join(output, "Launcher.apk"),
      output,
      moduleName: launcher.moduleName,
      launcher,
      admission,
    });
    fs.renameSync(output, options.output);
    return result;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === "--help") {
    console.log(
      "Usage: node stage-pixel10a-product.ts --product PRODUCT_JSON --launcher-descriptor LAUNCHER_JSON --apk APK --aosp-root AOSP --vendor-archive FACTORY --output NEW_DIR --source-commit COMMIT --applied-app-native-patch [--runtime-source ELIZA_ROOT] [--bun-target linux-musl|android] [--listener-apk APK --listener-descriptor JSON --voice-host JSON] [--applied-sense-patch] [--development] [--aapt TOOL] [--apksigner TOOL]",
    );
    return;
  }
  const options = {
    appliedSensePatch: false,
    aapt: "aapt",
    apksigner: "apksigner",
    development: false,
  };
  const fields = {
    "--listener-apk": "listenerApk",
    "--listener-descriptor": "listenerDescriptor",
    "--voice-host": "voiceHost",
    "--product": "product",
    "--launcher-descriptor": "descriptor",
    "--apk": "apk",
    "--output": "output",
    "--aosp-root": "aospRoot",
    "--vendor-archive": "archivePath",
    "--aapt": "aapt",
    "--apksigner": "apksigner",
    "--runtime-source": "runtimeSource",
    "--source-commit": "sourceCommit",
    "--bun-target": "bunTarget",
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--applied-sense-patch") options.appliedSensePatch = true;
    else if (argv[i] === "--applied-app-native-patch")
      options.appliedAppNativePatch = true;
    else if (argv[i] === "--development") options.development = true;
    else {
      const field = fields[argv[i]],
        value = argv[++i];
      if (!field || !value || value.startsWith("--"))
        throw new Error(
          "Expected Pixel 10a product, launcher descriptor/APK, source, factory archive and new output paths",
        );
      options[field] = value;
    }
  }
  for (const field of [
    "product",
    "descriptor",
    "apk",
    "output",
    "aospRoot",
    "archivePath",
    "sourceCommit",
  ])
    if (!options[field]) throw new Error(`Pixel 10a staging requires ${field}`);
  console.log(JSON.stringify(await stagePixel10aProduct(options), null, 2));
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();

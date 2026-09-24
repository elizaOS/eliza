#!/usr/bin/env node
/** Stages a complete privileged APK vendor tree into the selected AOSP checkout. */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadBrandFromArgv } from "./brand-config.mjs";
import { isMainModule } from "./is-main.mjs";
import { assertBrowserAppsStaged } from "./stage-browser-apps.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const USAGE =
  "Usage: node scripts/distro-android/sync-to-aosp.mjs [--brand-config <PATH>] [--source-vendor <VENDOR_DIR>] <AOSP_ROOT>";

export function parseSubArgs(argv, brand) {
  const args = {
    aospRoot: null,
    sourceVendor: path.resolve(repoRoot, brand.vendorDir),
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
    if (arg === "--source-vendor") {
      args.sourceVendor = readFlagValue(arg, i);
      i += 1;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown argument: ${arg}`);
    } else if (!args.aospRoot) {
      args.aospRoot = path.resolve(arg);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

export function syncToAosp({ aospRoot, sourceVendor, brand }) {
  if (!aospRoot) throw new Error(USAGE);
  if (!fs.existsSync(sourceVendor)) {
    throw new Error(
      `Missing ${brand.distroName} vendor source: ${sourceVendor}`,
    );
  }

  const buildEnvsetup = path.join(aospRoot, "build", "envsetup.sh");
  if (!fs.existsSync(buildEnvsetup)) {
    throw new Error(
      `${aospRoot} does not look like an AOSP checkout; missing build/envsetup.sh`,
    );
  }

  if (
    !/^[a-z][a-z0-9_]*$/.test(brand.brand) ||
    !/^[A-Za-z][A-Za-z0-9_-]*$/.test(brand.appName)
  ) {
    throw new Error(
      "Vendor brand and application name must be simple directory names.",
    );
  }
  const targetVendor = path.join(aospRoot, "vendor", brand.brand);
  const source = fs.realpathSync(sourceVendor);
  const destination = path.resolve(
    fs.realpathSync(aospRoot),
    "vendor",
    brand.brand,
  );
  const vendorRoot = path.join(fs.realpathSync(aospRoot), "vendor");
  if (fs.existsSync(vendorRoot) && fs.lstatSync(vendorRoot).isSymbolicLink()) {
    throw new Error("AOSP vendor directory must not be a symbolic link.");
  }
  if (
    source === destination ||
    source.startsWith(`${destination}${path.sep}`) ||
    destination.startsWith(`${source}${path.sep}`)
  ) {
    throw new Error("Source and destination vendor trees must not overlap.");
  }
  const sourceApk = path.join(
    source,
    "apps",
    brand.appName,
    `${brand.appName}.apk`,
  );
  if (
    !fs.existsSync(sourceApk) ||
    !fs.statSync(sourceApk).isFile() ||
    fs.statSync(sourceApk).size === 0
  ) {
    throw new Error(
      `Missing non-empty privileged APK: ${sourceApk}. Run ${brand.buildAndroidSystemCmd.join(" ")} before syncing.`,
    );
  }
  if (fs.existsSync(path.join(source, "manifests/browser-apps.json"))) {
    const inferredArchitecture = brand.productName?.match(
      /(?:^|_)(x86_64|arm64|riscv64)(?:_|$)/,
    )?.[1];
    const architecture = brand.architecture ?? inferredArchitecture;
    if (
      brand.architecture &&
      inferredArchitecture &&
      brand.architecture !== inferredArchitecture
    ) {
      throw new Error("Explicit architecture conflicts with the AOSP product.");
    }
    if (!architecture) {
      throw new Error(
        "Browser APK architecture must be qualified for this AOSP product before sync.",
      );
    }
    assertBrowserAppsStaged(source, architecture);
  }
  fs.rmSync(targetVendor, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
  fs.mkdirSync(path.dirname(targetVendor), { recursive: true });
  fs.cpSync(sourceVendor, targetVendor, {
    recursive: true,
    filter: (source) => !source.endsWith(".DS_Store"),
  });

  const apk = path.join(
    targetVendor,
    "apps",
    brand.appName,
    `${brand.appName}.apk`,
  );
  if (!fs.existsSync(apk)) {
    const buildCmd = brand.buildAndroidSystemCmd.join(" ");
    throw new Error(
      `[distro-android] vendor/${brand.brand} synced without ${brand.appName}.apk. Run \`${buildCmd}\` before syncing the AOSP product.`,
    );
  }

  return targetVendor;
}

export function main(argv = process.argv.slice(2)) {
  const { brand, remaining } = loadBrandFromArgv(argv);
  const { aospRoot, sourceVendor } = parseSubArgs(remaining, brand);
  const targetVendor = syncToAosp({ aospRoot, sourceVendor, brand });
  console.log(`[distro-android] Synced ${sourceVendor} -> ${targetVendor}`);
}

const isMain = isMainModule(import.meta);

if (isMain) {
  main();
}

#!/usr/bin/env node
/**
 * Stages a complete vendor tree, with its verified nonprivileged launcher, into
 * the selected AOSP checkout. The unsigned build output under apps/<AppName>
 * is an input to signing and is never copied.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadBrandFromArgv } from "./brand-config.ts";
import { LAUNCHER_DIRECTORY, verifyStagedLauncher } from "./image-launcher.ts";
import { admitBrowserVendor } from "./stage-browser-apps.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const USAGE =
  "Usage: node scripts/android/sync-to-aosp.ts [--brand-config <PATH>] [--source-vendor <VENDOR_DIR>] <AOSP_ROOT>";

export function parseSubArgs(argv, brand) {
  const args = {
    aospRoot: null,
    allowDevelopmentBrowser: false,
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
    } else if (arg === "--allow-development-browser") {
      args.allowDevelopmentBrowser = true;
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

export function syncToAosp({
  aospRoot,
  sourceVendor,
  brand,
  allowDevelopmentBrowser = false,
}) {
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
  const sourceLauncher = path.join(source, LAUNCHER_DIRECTORY);
  if (!fs.existsSync(sourceLauncher)) {
    throw new Error(
      `Missing staged launcher: ${sourceLauncher}. Run ${brand.buildAndroidSystemCmd.join(" ")}, sign the APK and stage it with scripts/android/image-launcher.ts before syncing.`,
    );
  }
  const staged = verifyStagedLauncher(sourceLauncher, brand);
  const unsignedBuildOutput = path.join(
    source,
    "apps",
    brand.appName,
    `${brand.appName}.apk`,
  );
  const admission = admitBrowserVendor(source, brand, {
    allowDevelopmentBrowser,
  });
  fs.mkdirSync(vendorRoot, { recursive: true });
  const temporary = fs.mkdtempSync(
    path.join(vendorRoot, `.${brand.brand}-staging-`),
  );
  try {
    fs.cpSync(source, temporary, {
      recursive: true,
      filter: (file) =>
        !file.endsWith(".DS_Store") && file !== unsignedBuildOutput,
    });
    const copied = admitBrowserVendor(temporary, brand, {
      allowDevelopmentBrowser,
    });
    if (JSON.stringify(copied?.pins) !== JSON.stringify(admission?.pins))
      throw new Error(
        "Browser pin manifest changed while copying the vendor tree.",
      );
    const copiedLauncher = verifyStagedLauncher(
      path.join(temporary, LAUNCHER_DIRECTORY),
      brand,
    );
    if (copiedLauncher.apkSha256 !== staged.apkSha256)
      throw new Error("Staged launcher changed while copying the vendor tree.");
    fs.rmSync(targetVendor, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
    fs.renameSync(temporary, targetVendor);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }

  return targetVendor;
}

export function main(argv = process.argv.slice(2)) {
  const { brand, remaining } = loadBrandFromArgv(argv);
  const { aospRoot, sourceVendor, allowDevelopmentBrowser } = parseSubArgs(
    remaining,
    brand,
  );
  const targetVendor = syncToAosp({
    aospRoot,
    sourceVendor,
    brand,
    allowDevelopmentBrowser,
  });
  console.log(`[distro-android] Synced ${sourceVendor} -> ${targetVendor}`);
}

if (import.meta.main) {
  main();
}

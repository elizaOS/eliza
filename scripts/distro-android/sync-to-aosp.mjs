#!/usr/bin/env node
/**
 * sync-to-aosp.mjs — Copy the brand vendor tree into an AOSP checkout.
 *
 * Brand-aware: vendor source dir, target vendor name, and APK path are
 * driven by the brand config (see brand-config.mjs). Defaults to the
 * eliza brand at scripts/distro-android/brand.eliza.json; downstream
 * brands pass --brand-config <path>.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadBrandFromArgv } from "./brand-config.mjs";

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

  const targetVendor = path.join(aospRoot, "vendor", brand.brand);
  fs.rmSync(targetVendor, { recursive: true, force: true });
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

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main();
}

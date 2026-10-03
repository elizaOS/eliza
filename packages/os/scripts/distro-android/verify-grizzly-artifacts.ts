#!/usr/bin/env node

/** Attest packaged Grizzly images against their prepare stamp and record hashes.
 * Usage: attest --aosp-root <checkout> [--out <manifest>]
 *        check --manifest <manifest> --artifact-dir <images>
 * Staged ELF inspection covers unpacked Eliza libraries only; it does not
 * qualify APK-contained libraries or demonstrate device boot success.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const PRODUCT_DEVICE = "grizzly";
const STAMP_RELATIVE_PATH =
  "vendor/google_devices/grizzly/.elizaos-prepare-stamp.json";
// Partitions in the coherent grizzly flash handoff. Keep boot-chain and
// logical-partition metadata pinned too; mixing generations is unsafe.
const REQUIRED_ATTESTED_IMAGES = [
  "boot.img",
  "init_boot.img",
  "dtbo.img",
  "vendor_kernel_boot.img",
  "pvmfw.img",
  "vendor_boot.img",
  "vbmeta.img",
  "system.img",
  "system_ext.img",
  "product.img",
  "vendor.img",
  "vendor_dlkm.img",
  "system_dlkm.img",
  "system_other.img",
  "super_empty.img",
];
const OPTIONAL_ATTESTED_IMAGES = ["vbmeta_system.img", "vbmeta_vendor.img"];

function fail(message) {
  console.error(`[verify-grizzly-artifacts] ERROR: ${message}`);
  process.exit(1);
}

function warn(message) {
  console.warn(`[verify-grizzly-artifacts] WARN: ${message}`);
}

function info(message) {
  console.log(`[verify-grizzly-artifacts] ${message}`);
}

function sha256File(filePath) {
  const hash = createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    while (true) {
      const length = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (length === 0) break;
      hash.update(buffer.subarray(0, length));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const args = { mode };
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    const value = rest[index + 1];
    switch (key) {
      case "--aosp-root":
      case "--out":
      case "--manifest":
      case "--artifact-dir":
        if (!value) fail(`${key} requires a value`);
        args[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] =
          path.resolve(value);
        index += 1;
        break;
      default:
        fail(`unknown argument: ${key}`);
    }
  }
  if (mode !== "attest" && mode !== "check") {
    fail("first argument must be `attest` or `check` (see file header)");
  }
  return args;
}

function newestMtimeUnder(dir, filterRegex = null) {
  let newest = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT" && current === dir) continue;
      throw error;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (!filterRegex || filterRegex.test(full)) {
        // Image symlinks can target device-only absolute paths. Their own
        // metadata is packaged; following them would inspect the build host.
        const mtime = fs.lstatSync(full).mtimeMs;
        if (mtime > newest) newest = mtime;
      }
    }
  }
  return newest;
}

function readStamp(aospRoot) {
  const stampPath = path.join(aospRoot, STAMP_RELATIVE_PATH);
  if (!fs.existsSync(stampPath)) {
    fail(
      `prepare stamp missing (${STAMP_RELATIVE_PATH}); run prepare-grizzly before attesting`,
    );
  }
  return JSON.parse(fs.readFileSync(stampPath, "utf8"));
}

function productOutDir(aospRoot) {
  const configured = process.env.OUT_DIR?.trim() || "out";
  const outRoot = path.isAbsolute(configured)
    ? configured
    : path.join(aospRoot, configured);
  return path.join(outRoot, "target", "product", PRODUCT_DEVICE);
}

// Modern AOSP removes unpacked staging trees after packaging. Read final
// sparse ext4 images for the contract checks so we verify what fastboot gets.
function readImageEntry(aospRoot, imagePath, entryPath) {
  if (!fs.existsSync(imagePath)) return null;
  const configured = process.env.OUT_DIR?.trim() || "out";
  const outRoot = path.isAbsolute(configured)
    ? configured
    : path.join(aospRoot, configured);
  const simg2img = path.join(outRoot, "host/linux-x86/bin/simg2img");
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "grizzly-img-"));
  const rawPath = path.join(temporaryDir, "image.raw");
  try {
    const header = Buffer.alloc(4);
    const fd = fs.openSync(imagePath, "r");
    try {
      fs.readSync(fd, header, 0, 4, 0);
    } finally {
      fs.closeSync(fd);
    }
    let sourcePath = imagePath;
    if (header.equals(Buffer.from([0x3a, 0xff, 0x26, 0xed]))) {
      if (!fs.existsSync(simg2img))
        throw new Error(`Sparse image conversion requires ${simg2img}`);
      execFileSync(simg2img, [imagePath, rawPath]);
      sourcePath = rawPath;
    }
    const result = spawnSync(
      "debugfs",
      ["-R", `cat /${entryPath}`, sourcePath],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    if (result.error || result.status !== 0)
      throw new Error(
        `Cannot read ${entryPath} from ${imagePath}: ${result.stderr}`,
        { cause: result.error },
      );
    const diagnostic = result.stderr
      .split("\n")
      .filter((line) => !/^debugfs \d/.test(line))
      .join("\n")
      .trim();
    if (
      diagnostic === `/${entryPath}: File not found by ext2_lookup` &&
      result.stdout === ""
    )
      return null;
    if (diagnostic)
      throw new Error(
        `Cannot read ${entryPath} from ${imagePath}: ${diagnostic}`,
      );
    return result.stdout;
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
}

// The staged vendor/build.prop is what vendor.img is packaged from; verifying
// it (rather than the source tree) catches the built-before-edited hazard.
function assertStagedRenderEngine(stagedVendorDir, stamp) {
  const buildProp = path.join(stagedVendorDir, "build.prop");
  if (!fs.existsSync(buildProp)) {
    fail(`staged vendor build.prop missing: ${buildProp}`);
  }
  const contents = fs.readFileSync(buildProp, "utf8");
  const backendMatch = contents.match(/^debug\.renderengine\.backend=(\S+)$/m);
  const stagedBackend = backendMatch ? backendMatch[1] : null;
  if (stagedBackend !== (stamp.renderengineBackend ?? null)) {
    fail(
      `staged vendor build.prop backend=${JSON.stringify(stagedBackend)} but prepare stamp says ${JSON.stringify(stamp.renderengineBackend)}; the image would not run the intended renderer — rebuild after re-running prepare-grizzly`,
    );
  }
  const graphiteMatch = contents.match(
    /^debug\.renderengine\.graphite=(true|false)$/m,
  );
  if (!graphiteMatch) {
    fail("staged vendor build.prop has no debug.renderengine.graphite line");
  }
  const stagedGraphite = graphiteMatch[1] === "true";
  if (stagedGraphite !== stamp.renderengineGraphite) {
    fail(
      `staged vendor build.prop graphite=${stagedGraphite} but prepare stamp says ${stamp.renderengineGraphite}; rebuild after re-running prepare-grizzly`,
    );
  }
  const stagedAngle = /^persist\.graphics\.egl=angle$/m.test(contents);
  if (stamp.eglSelection === "native" && stagedAngle) {
    fail(
      "prepare stamp selects the native PowerVR EGL driver but the staged vendor build.prop still routes through ANGLE; rebuild after re-running prepare-grizzly",
    );
  }
  if (stamp.eglSelection !== "native" && !stagedAngle) {
    fail(
      "staged vendor build.prop lost the stock persist.graphics.egl=angle selection without a native-EGL stamp; the image does not match any declared stance",
    );
  }
  info(
    `staged renderengine verified: backend=${stagedBackend ?? "(stock)"} graphite=${stagedGraphite} egl=${stamp.eglSelection ?? "(stock angle)"}`,
  );
}

function assertStagedFstab(stagedVendorDir, stamp) {
  const fstab = path.join(stagedVendorDir, "etc", "fstab.malibu");
  if (!fs.existsSync(fstab)) {
    fail(`staged vendor fstab missing: ${fstab}`);
  }
  const contents = fs.readFileSync(fstab, "utf8");
  const userdataLine = contents
    .split("\n")
    .find((line) => /\s\/data\s/.test(line) && !line.trim().startsWith("#"));
  if (!userdataLine) fail("staged fstab has no /data entry");
  const rewritten = /elizaos/i.test(contents);
  if (stamp.conservativeF2fs !== rewritten) {
    fail(
      `staged fstab stance (rewritten=${rewritten}) does not match prepare stamp (conservativeF2fs=${stamp.conservativeF2fs}); rebuild after re-running prepare-grizzly`,
    );
  }
  if (!stamp.conservativeF2fs) {
    for (const required of ["fileencryption=", "metadata_encryption="]) {
      if (!userdataLine.includes(required)) {
        fail(
          `stock fstab stance selected but staged /data entry lacks ${required} — the factory encryption contract is broken: ${userdataLine.trim()}`,
        );
      }
    }
  }
  info(
    `staged fstab stance verified (conservativeF2fs=${stamp.conservativeF2fs})`,
  );
}

function assertStagedProbes(stagedVendorDir, stamp) {
  const probeRc = path.join(
    stagedVendorDir,
    "etc",
    "init",
    "hw",
    "init.elizaos-debug.rc",
  );
  const staged = fs.existsSync(probeRc);
  if (staged !== stamp.earlyBootProbes) {
    fail(
      `probe init rc staged=${staged} but prepare stamp earlyBootProbes=${stamp.earlyBootProbes}; rebuild after re-running prepare-grizzly`,
    );
  }
  info(`staged bring-up probes verified (enabled=${stamp.earlyBootProbes})`);
}

function assertPackagedVendorEntries(aospRoot, productDir, stamp) {
  const vendorImage = path.join(productDir, "vendor.img");
  const buildProp = readImageEntry(aospRoot, vendorImage, "build.prop");
  const fstab = readImageEntry(aospRoot, vendorImage, "etc/fstab.malibu");
  if (!buildProp || !fstab)
    fail(
      "vendor.img is missing packaged build.prop or fstab.malibu; refusing to attest an opaque image",
    );
  const backendMatch = buildProp.match(/^debug\.renderengine\.backend=(\S+)$/m);
  const stagedBackend = backendMatch ? backendMatch[1] : null;
  if (stagedBackend !== (stamp.renderengineBackend ?? null))
    fail(
      `packaged vendor build.prop backend=${JSON.stringify(stagedBackend)} does not match prepare stamp`,
    );
  const graphiteMatch = buildProp.match(
    /^debug\.renderengine\.graphite=(true|false)$/m,
  );
  if (
    !graphiteMatch ||
    (graphiteMatch[1] === "true") !== stamp.renderengineGraphite
  )
    fail(
      "packaged vendor build.prop graphite value does not match prepare stamp",
    );
  const stagedAngle = /^persist\.graphics\.egl=angle$/m.test(buildProp);
  if (
    (stamp.eglSelection === "native" && stagedAngle) ||
    (stamp.eglSelection !== "native" && !stagedAngle)
  )
    fail("packaged vendor EGL selection does not match prepare stamp");
  const rewritten = /elizaos/i.test(fstab);
  if (stamp.conservativeF2fs !== rewritten)
    fail("packaged vendor fstab stance does not match prepare stamp");
  if (!stamp.conservativeF2fs) {
    const userdataLine = fstab
      .split("\n")
      .find((line) => /\s\/data\s/.test(line) && !line.trim().startsWith("#"));
    if (
      !userdataLine?.includes("fileencryption=") ||
      !userdataLine.includes("metadata_encryption=")
    )
      fail("packaged vendor fstab lost the stock /data encryption contract");
  }
  const probe = readImageEntry(
    aospRoot,
    vendorImage,
    "etc/init/hw/init.elizaos-debug.rc",
  );
  if ((probe !== null) !== stamp.earlyBootProbes)
    fail("packaged vendor probe state does not match prepare stamp");
  info(
    `packaged vendor image verified: backend=${stagedBackend ?? "(stock)"} graphite=${stamp.renderengineGraphite}`,
  );
}

// 16 KiB page-size kernels refuse to map ELFs whose LOAD segments are aligned
// below 16384. Inspect unpacked Eliza libraries with the AOSP host toolchain.
export function checkElfAlignment(aospRoot, stagedProductDir) {
  const readelfCandidates = [
    path.join(
      aospRoot,
      "prebuilts/clang/host/linux-x86/llvm-binutils-stable/llvm-readelf",
    ),
  ];
  const readelf = readelfCandidates.find((candidate) =>
    fs.existsSync(candidate),
  );
  const targets = [];
  const elizaApp = path.join(stagedProductDir, "system", "priv-app", "Eliza");
  const stack = [elizaApp];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT" && current === elizaApp) continue;
      throw error;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.endsWith(".so")) targets.push(full);
    }
  }
  if (targets.length === 0) {
    info(
      "No unpacked Eliza libraries available for the staged ELF alignment check.",
    );
    return;
  }
  if (!readelf)
    fail("llvm-readelf is required to inspect staged Eliza libraries");
  for (const target of targets) {
    const output = execFileSync(readelf, ["-W", "-l", target], {
      encoding: "utf8",
    });
    const loads = output.split("\n").filter((line) => /^\s*LOAD\s/.test(line));
    if (loads.length === 0) fail(`No ELF LOAD segments found: ${target}`);
    for (const line of loads) {
      const alignment = line.trim().split(/\s+/).at(-1);
      const value = /^0x[0-9a-f]+$/i.test(alignment) ? Number(alignment) : NaN;
      if (
        !Number.isSafeInteger(value) ||
        value < 16384 ||
        !Number.isInteger(Math.log2(value))
      )
        fail(`Invalid or sub-16KiB ELF LOAD alignment ${alignment}: ${target}`);
    }
  }
  info(`ELF 16KiB alignment verified for ${targets.length} staged libraries`);
}

function attest({ aospRoot, out }) {
  if (!aospRoot) fail("attest requires --aosp-root");
  const stamp = readStamp(aospRoot);
  const productDir = productOutDir(aospRoot);
  if (!fs.existsSync(productDir)) {
    fail(`product out dir missing: ${productDir}; build first`);
  }
  const stagedVendorDir = path.join(productDir, "vendor");
  if (fs.existsSync(path.join(stagedVendorDir, "build.prop"))) {
    assertStagedRenderEngine(stagedVendorDir, stamp);
    assertStagedFstab(stagedVendorDir, stamp);
    assertStagedProbes(stagedVendorDir, stamp);
  }
  // Staging alone cannot prove what was packaged, even with matching mtimes.
  assertPackagedVendorEntries(aospRoot, productDir, stamp);
  checkElfAlignment(aospRoot, productDir);
  const init = readImageEntry(
    aospRoot,
    path.join(productDir, "system.img"),
    "etc/init/hw/init.rc",
  );
  if (!init)
    fail(
      "system init.rc unavailable; cannot attest keymaster diagnostic stance",
    );
  const background =
    /exec_background - system system -- \/system\/bin\/vdc keymaster earlyBootEnded/m.test(
      init,
    );
  const marked =
    /# elizaOS: diagnostic non-blocking keymaster notification\n[ \t]*exec_background - system system -- \/system\/bin\/vdc keymaster earlyBootEnded/m.test(
      init,
    );
  if (
    background !== (stamp.keymasterNonblocking === true) ||
    (background && !marked)
  ) {
    fail("system init keymaster stance does not match prepare stamp");
  }
  if (
    !background &&
    !/^[ \t]*exec - system system -- \/system\/bin\/vdc keymaster earlyBootEnded[ \t]*$/m.test(
      init,
    )
  ) {
    fail("system init lacks the expected blocking keymaster notification");
  }
  // The diagnostic fstab also changes first-stage mount behavior. Until the
  // packaged vendor_boot ramdisk is inspected, do not claim this stance is
  // verified merely because the vendor staging tree matches.
  if (stamp.conservativeF2fs)
    fail(
      "conservative f2fs attestation requires packaged vendor_boot ramdisk verification, which is not implemented",
    );

  for (const partition of [
    "vendor",
    "system",
    "system_ext",
    "product",
    "vendor_dlkm",
    "system_dlkm",
  ]) {
    const imagePath = path.join(productDir, `${partition}.img`);
    if (!fs.existsSync(imagePath))
      fail(`required image absent: ${partition}.img`);
    const imageMtime = fs.statSync(imagePath).mtimeMs;
    const newestStaged = newestMtimeUnder(path.join(productDir, partition));
    if (newestStaged > imageMtime) {
      fail(
        `${partition}.img is older than the staged ${partition} tree (image ${new Date(imageMtime).toISOString()} < staged ${new Date(newestStaged).toISOString()}); rebuild before attesting`,
      );
    }
  }

  const images = {};
  for (const name of [
    ...REQUIRED_ATTESTED_IMAGES,
    ...OPTIONAL_ATTESTED_IMAGES,
  ]) {
    const imagePath = path.join(productDir, name);
    if (!fs.existsSync(imagePath)) {
      if (REQUIRED_ATTESTED_IMAGES.includes(name))
        fail(`required image absent: ${name}`);
      warn(`image absent, not attested: ${name}`);
      continue;
    }
    const stat = fs.lstatSync(imagePath);
    if (!stat.isFile()) fail(`image is not a regular file: ${name}`);
    images[name] = {
      sha256: sha256File(imagePath),
      size: stat.size,
      mtime: new Date(stat.mtimeMs).toISOString(),
    };
    info(`attested ${name} sha256=${images[name].sha256.slice(0, 16)}…`);
  }
  if (Object.keys(images).length === 0) {
    fail("no images found to attest");
  }
  const manifest = {
    schemaVersion: 1,
    device: PRODUCT_DEVICE,
    attestedAt: new Date().toISOString(),
    prepareStamp: stamp,
    images,
  };
  const outPath = out ?? path.join(productDir, "grizzly-artifacts.json");
  fs.writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
  info(`wrote attestation manifest: ${outPath}`);
  info(
    "copy this manifest with the images; on the flash host run the `check` mode before fastboot",
  );
}

function check({ manifest: manifestPath, artifactDir }) {
  if (!manifestPath || !artifactDir) {
    fail("check requires --manifest and --artifact-dir");
  }
  if (!fs.existsSync(manifestPath))
    fail(`manifest does not exist: ${manifestPath}`);
  if (!fs.existsSync(artifactDir) || !fs.statSync(artifactDir).isDirectory()) {
    fail(`artifact dir does not exist or is not a directory: ${artifactDir}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail(`manifest is not valid JSON: ${error.message}`);
  }
  if (manifest.device !== PRODUCT_DEVICE) {
    fail(`manifest device is ${manifest.device}, expected ${PRODUCT_DEVICE}`);
  }
  if (
    manifest.schemaVersion !== 1 ||
    !manifest.images ||
    typeof manifest.images !== "object" ||
    Array.isArray(manifest.images)
  )
    fail("unsupported or malformed attestation manifest");
  const names = Object.keys(manifest.images ?? {});
  if (names.length === 0) fail("manifest attests no images");
  const unattested = fs
    .readdirSync(artifactDir)
    .filter((name) => name.endsWith(".img") && !names.includes(name));
  if (unattested.length)
    fail(`artifact dir contains unattested images: ${unattested.join(", ")}`);
  let checked = 0;
  for (const name of names) {
    if (path.basename(name) !== name || !/^[a-z0-9_]+\.img$/.test(name)) {
      fail(`manifest image name is unsafe: ${name}`);
    }
    const expected = manifest.images[name]?.sha256;
    if (!/^[a-f0-9]{64}$/.test(expected ?? "")) {
      fail(`manifest image ${name} has an invalid sha256`);
    }
    const local = path.join(artifactDir, name);
    if (!fs.existsSync(local)) {
      fail(
        `attested image missing from artifact dir: ${name} — flashing a partial set silently mixes build generations`,
      );
    }
    if (!fs.lstatSync(local).isFile())
      fail(`image is not a regular file: ${name}`);
    const actual = sha256File(local);
    if (actual !== expected) {
      fail(
        `${name} sha256 mismatch: local ${actual} vs attested ${expected} — this is NOT the attested build`,
      );
    }
    checked += 1;
  }
  const missingCore = REQUIRED_ATTESTED_IMAGES.filter(
    (name) => !names.includes(name),
  );
  if (missingCore.length)
    fail(`manifest omits required images: ${missingCore.join(", ")}`);
  info(
    `verified ${checked} image(s) against attestation from ${manifest.attestedAt}`,
  );
  info(`attested prepare stamp: ${JSON.stringify(manifest.prepareStamp)}`);
  info(
    "image hashes match; device compatibility and flash authorization remain separate checks",
  );
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === "attest") attest(args);
  else check(args);
}

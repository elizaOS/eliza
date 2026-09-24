#!/usr/bin/env node
/** Verifies pinned browser and vault APKs before staging unchanged upstream-signed product apps. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";

const defaultVendor = fileURLToPath(
  new URL("../../android/vendor/eliza", import.meta.url),
);
const applications = {
  chromium: { directory: "Chromium", packageName: "org.chromium.chrome" },
  bitwarden: { directory: "Bitwarden", packageName: "com.x8bit.bitwarden" },
};

export function sha256File(file) {
  const hash = createHash("sha256");
  const descriptor = fs.openSync(file, "r");
  const chunk = Buffer.alloc(1024 * 1024);
  try {
    for (;;) {
      const length = fs.readSync(descriptor, chunk);
      if (length === 0) break;
      hash.update(chunk.subarray(0, length));
    }
    return hash.digest("hex");
  } finally {
    fs.closeSync(descriptor);
  }
}

export function readBrowserAppPins(vendorDir) {
  const pins = JSON.parse(
    fs.readFileSync(
      path.join(vendorDir, "manifests/browser-apps.json"),
      "utf8",
    ),
  );
  if (![1, 2].includes(pins.schemaVersion))
    throw new Error("Unsupported browser application manifest.");
  for (const [name, expected] of Object.entries(applications)) {
    const entry = pins[name];
    const variants = pins.schemaVersion === 2 && entry?.variants;
    if (
      variants &&
      (typeof variants !== "object" ||
        Array.isArray(variants) ||
        Object.keys(variants).length === 0)
    )
      throw new Error(`Invalid pinned ${name} APK variants.`);
    for (const [architecture, app] of variants
      ? Object.entries(variants)
      : [[null, entry]]) {
      if (
        !app ||
        app.packageName !== expected.packageName ||
        !/^[a-f0-9]{64}$/.test(app.sha256) ||
        !/^[a-f0-9]{64}$/.test(app.signerSha256) ||
        !/^[0-9]+$/.test(app.versionCode) ||
        typeof app.versionName !== "string" ||
        !Array.isArray(app.architectures) ||
        app.architectures.length === 0 ||
        !app.architectures.every((arch) =>
          ["x86_64", "arm64", "riscv64"].includes(arch),
        ) ||
        !["stable", "development"].includes(app.channel)
      ) {
        throw new Error(`Invalid pinned ${name} APK identity.`);
      }
      if (
        architecture &&
        (app.architectures.length !== 1 ||
          app.architectures[0] !== architecture)
      )
        throw new Error(`Invalid pinned ${name} APK variant architecture.`);
      const source = new URL(app.sourceUrl);
      const allowedHost =
        name === "chromium"
          ? "storage.googleapis.com"
          : "mobileapp.bitwarden.com";
      const allowedPrefix =
        name === "chromium" ? "/chromium-browser-snapshots/" : "/fdroid/repo/";
      if (
        source.protocol !== "https:" ||
        source.hostname !== allowedHost ||
        !source.pathname.startsWith(allowedPrefix) ||
        source.username ||
        source.password
      ) {
        throw new Error(`Unrecognized upstream source for ${name}.`);
      }
    }
  }
  return pins;
}

function selectPin(pins, name, arch) {
  const entry = pins[name];
  const pin =
    pins.schemaVersion === 2 && entry.variants ? entry.variants[arch] : entry;
  if (!pin || (arch && !pin.architectures.includes(arch)))
    throw new Error(
      `No verified ${name} artifact for ${arch ?? "an unspecified architecture"}.`,
    );
  return pin;
}

function apkPath(vendorDir, pins, name, arch) {
  const directory = applications[name].directory;
  return path.join(
    vendorDir,
    "apps",
    directory,
    ...(pins.schemaVersion === 2 && pins[name].variants ? [arch] : []),
    `${directory}.apk`,
  );
}

/** Checks content against the reviewed pins, including after copying into AOSP. */
export function assertBrowserAppsStaged(vendorDir, arch) {
  const pins = readBrowserAppPins(vendorDir);
  for (const name of Object.keys(applications)) {
    const pin = selectPin(pins, name, arch);
    const file = apkPath(vendorDir, pins, name, arch);
    if (
      !fs.existsSync(file) ||
      !fs.statSync(file).isFile() ||
      sha256File(file) !== pin.sha256
    ) {
      throw new Error(
        `Missing or unverified ${name} APK. Run stage-browser-apps.mjs with the pinned upstream artifacts before syncing AOSP.`,
      );
    }
  }
}

function verifyApk(file, pin, { apksigner, aapt }) {
  if (sha256File(file) !== pin.sha256)
    throw new Error(`APK checksum mismatch for ${pin.packageName}.`);
  const signature = execFileSync(
    apksigner,
    ["verify", "--verbose", "--print-certs", file],
    { encoding: "utf8", maxBuffer: 1024 * 1024 },
  );
  const signers = [
    ...signature.matchAll(
      /^Signer #\d+ certificate SHA-256 digest: ([a-f0-9]{64})$/gm,
    ),
  ].map((match) => match[1]);
  if (signers.length !== 1 || signers[0] !== pin.signerSha256)
    throw new Error(`APK signer mismatch for ${pin.packageName}.`);
  const metadata = execFileSync(aapt, ["dump", "badging", file], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  const identity = metadata.match(
    /^package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'/m,
  );
  if (
    !identity ||
    identity[1] !== pin.packageName ||
    identity[2] !== pin.versionCode ||
    identity[3] !== pin.versionName
  ) {
    throw new Error(`APK package or version mismatch for ${pin.packageName}.`);
  }
  const abis =
    metadata
      .match(/^native-code:\s*(.*)$/m)?.[1]
      .match(/'([^']+)'/g)
      ?.map((abi) => abi.slice(1, -1)) ?? [];
  const expectedAbis = {
    arm64: "arm64-v8a",
    x86_64: "x86_64",
    riscv64: "riscv64",
  };
  if (pin.architectures.some((arch) => !abis.includes(expectedAbis[arch])))
    throw new Error(`APK native ABI mismatch for ${pin.packageName}.`);
}

export function stageBrowserApps({
  vendorDir = defaultVendor,
  chromiumApk,
  bitwardenApk,
  arch,
  allowDevelopmentBrowser = false,
  apksigner = "apksigner",
  aapt = "aapt",
}) {
  const pins = readBrowserAppPins(vendorDir);
  if (!["x86_64", "arm64", "riscv64"].includes(arch))
    throw new Error("An explicit supported APK architecture is required.");
  const selected = Object.fromEntries(
    Object.keys(applications).map((name) => [
      name,
      selectPin(pins, name, arch),
    ]),
  );
  const sources = { chromium: chromiumApk, bitwarden: bitwardenApk };
  for (const name of Object.keys(applications)) {
    if (!sources[name])
      throw new Error(`An explicit ${name} APK path is required.`);
    if (selected[name].channel !== "stable" && !allowDevelopmentBrowser)
      throw new Error(
        "The pinned Chromium artifact is a development snapshot. Pass --allow-development-browser only for development images; it is not release qualification.",
      );
  }
  const temporary = fs.mkdtempSync(path.join(vendorDir, ".browser-apps-"));
  try {
    for (const [name, app] of Object.entries(applications)) {
      const file = path.join(temporary, `${app.directory}.apk`);
      fs.copyFileSync(path.resolve(sources[name]), file);
      verifyApk(file, selected[name], { apksigner, aapt });
    }
    // Verify the whole set before replacing any previously staged application.
    for (const [name, app] of Object.entries(applications)) {
      const destination = apkPath(vendorDir, pins, name, arch);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.renameSync(path.join(temporary, `${app.directory}.apk`), destination);
    }
    assertBrowserAppsStaged(vendorDir, arch);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  return {
    vendorDir: path.resolve(vendorDir),
    arch,
    releaseQualified: false,
    applications: Object.keys(applications).map((name) => ({
      name,
      ...selected[name],
    })),
  };
}

export function main(argv = process.argv.slice(2)) {
  const options = {};
  const flags = {
    "--vendor-dir": "vendorDir",
    "--chromium-apk": "chromiumApk",
    "--bitwarden-apk": "bitwardenApk",
    "--arch": "arch",
    "--apksigner": "apksigner",
    "--aapt": "aapt",
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--allow-development-browser") {
      options.allowDevelopmentBrowser = true;
      continue;
    }
    const field = flags[argv[i]];
    if (!field || !argv[i + 1] || argv[i + 1].startsWith("--"))
      throw new Error(`Invalid argument: ${argv[i]}`);
    options[field] = argv[++i];
  }
  console.log(JSON.stringify(stageBrowserApps(options), null, 2));
}

if (isMainModule(import.meta)) main();

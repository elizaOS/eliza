// @ts-check
/**
 * Installs one reviewed Sideloader CLI archive from immutable release metadata.
 * Both the postinstall downloader and the runtime dependency manager use this
 * module so architecture selection, verification, and ZIP handling cannot drift.
 */

import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";

const SUPPORTED_PLATFORMS = new Set(["darwin", "linux", "win32"]);
const SUPPORTED_ARCHITECTURES = new Set(["arm64", "x64"]);

function assertSimpleFilename(value, field) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\")
  ) {
    throw new Error(`Invalid Sideloader ${field}`);
  }
}

/**
 * @param {import("./sideloader-installer.mjs").SideloaderConfig} config
 * @param {NodeJS.Platform} platform
 * @param {string} arch
 */
export function resolvePinnedSideloaderTarget(config, platform, arch) {
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    throw new Error(`Sideloader is unsupported on platform ${platform}`);
  }
  if (!SUPPORTED_ARCHITECTURES.has(arch)) {
    throw new Error(`Sideloader is unsupported on architecture ${arch}`);
  }

  const version = config?.pinned?.version;
  const key = `${platform}-${arch}`;
  const target = config?.pinned?.targets?.[key];
  if (!version || !target) {
    throw new Error(`No pinned Sideloader target for ${key}`);
  }

  assertSimpleFilename(target.archive, "archive name");
  assertSimpleFilename(target.binary, "binary name");
  if (!/^[0-9a-f]{64}$/.test(target.sha256)) {
    throw new Error(`Invalid Sideloader SHA-256 for ${key}`);
  }
  if (!Number.isSafeInteger(target.size) || target.size <= 0) {
    throw new Error(`Invalid Sideloader archive size for ${key}`);
  }

  const url = new URL(target.asset);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    !url.pathname.startsWith(
      `/Dadoum/Sideloader/releases/download/${version}/`,
    ) ||
    basename(url.pathname) !== target.archive
  ) {
    throw new Error(`Invalid Sideloader release URL for ${key}`);
  }

  return { ...target, key, version };
}

function runChild(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(undefined);
      else reject(new Error(`${binary} exited ${code}`));
    });
  });
}

async function extractZip(zipPath, destination, platform) {
  mkdirSync(destination, { recursive: true });
  if (platform === "win32") {
    const psSafe = (value) => `'${value.replace(/'/g, "''")}'`;
    await runChild("powershell.exe", [
      "-NonInteractive",
      "-NoProfile",
      "-Command",
      `$ErrorActionPreference = "Stop"; Expand-Archive -Force -Path ${psSafe(zipPath)} -DestinationPath ${psSafe(destination)}`,
    ]);
    return;
  }
  await runChild("unzip", ["-oq", zipPath, "-d", destination]);
}

async function downloadVerifiedArchive(target, destination, fetchImpl) {
  const response = await fetchImpl(target.asset, {
    redirect: "follow",
    headers: { "User-Agent": "elizaos-setup/1.0" },
  });
  if (!response.ok || !response.body) {
    throw new Error(
      `Sideloader download failed: HTTP ${response.status} ${response.statusText}`,
    );
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) !== target.size) {
    throw new Error("Sideloader archive size does not match pinned metadata");
  }

  const hash = createHash("sha256");
  let bytes = 0;
  await pipeline(
    response.body,
    async function* (source) {
      for await (const chunk of source) {
        bytes += chunk.length;
        hash.update(chunk);
        yield chunk;
      }
    },
    createWriteStream(destination, { flags: "wx", mode: 0o600 }),
  );

  if (bytes !== target.size) {
    throw new Error(
      `Sideloader archive size mismatch: expected ${target.size}, got ${bytes}`,
    );
  }
  const actualSha256 = hash.digest("hex");
  if (actualSha256 !== target.sha256) {
    throw new Error(
      `Sideloader checksum mismatch: expected ${target.sha256}, got ${actualSha256}`,
    );
  }
}

/**
 * @param {import("./sideloader-installer.mjs").InstallPinnedSideloaderOptions} options
 */
export async function installPinnedSideloader(options) {
  const {
    vendorRoot,
    platform,
    arch,
    config,
    fetchImpl = fetch,
    log = () => undefined,
  } = options;
  const target = resolvePinnedSideloaderTarget(config, platform, arch);
  const suffix = `${process.pid}-${Date.now()}`;
  const archivePath = join(vendorRoot, `.sideloader-${suffix}.zip`);
  const extractRoot = join(vendorRoot, `.sideloader-${suffix}`);
  const destinationName = platform === "win32" ? "sideloader.exe" : "sideloader";
  const destinationPath = join(vendorRoot, destinationName);
  const stagedPath = `${destinationPath}.${suffix}.new`;

  mkdirSync(vendorRoot, { recursive: true });
  log(`Using pinned Sideloader ${target.version} for ${target.key}`);

  try {
    await downloadVerifiedArchive(target, archivePath, fetchImpl);
    log(`Verified ${target.archive} (${target.sha256})`);
    await extractZip(archivePath, extractRoot, platform);

    const extractedBinary = join(extractRoot, target.binary);
    if (!existsSync(extractedBinary)) {
      throw new Error(
        `Pinned Sideloader archive did not contain ${target.binary}`,
      );
    }

    copyFileSync(extractedBinary, stagedPath);
    if (platform !== "win32") chmodSync(stagedPath, 0o755);
    if (platform === "win32" && existsSync(destinationPath)) {
      rmSync(destinationPath, { force: true });
    }
    renameSync(stagedPath, destinationPath);
    log(`Sideloader ready: ${destinationPath}`);
    return destinationPath;
  } finally {
    rmSync(archivePath, { force: true });
    rmSync(extractRoot, { recursive: true, force: true });
    rmSync(stagedPath, { force: true });
  }
}

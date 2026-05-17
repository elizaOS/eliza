#!/usr/bin/env node
// @ts-check
/**
 * Download vendor binaries (adb, fastboot, sideloader) for aosp-flasher.
 * Installs to ~/.elizaos/flasher/vendor/bin/{platform}/
 *
 * Usage:
 *   node vendor/download.mjs
 *   bun vendor/download.mjs
 */

import { createWriteStream, existsSync, mkdirSync, chmodSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

// ── Platform detection ────────────────────────────────────────────────────────

const PLATFORM = process.platform; // "darwin" | "linux" | "win32"

const PLATFORM_TOOLS_URLS = {
  darwin: "https://dl.google.com/android/repository/platform-tools-latest-darwin.zip",
  linux: "https://dl.google.com/android/repository/platform-tools-latest-linux.zip",
  win32: "https://dl.google.com/android/repository/platform-tools-latest-windows.zip",
};

if (!PLATFORM_TOOLS_URLS[PLATFORM]) {
  console.error(`[vendor] Unsupported platform: ${PLATFORM}`);
  process.exit(1);
}

// ── Install root ─────────────────────────────────────────────────────────────

const VENDOR_ROOT = join(homedir(), ".elizaos", "flasher", "vendor", "bin", PLATFORM);

function ensureDir(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    console.log(`[vendor] Created directory: ${dir}`);
  }
}

// ── Download helpers ──────────────────────────────────────────────────────────

/**
 * Download a URL to a local file, following redirects.
 * @param {string} url
 * @param {string} destPath
 */
async function downloadFile(url, destPath) {
  console.log(`[vendor] Downloading ${url}`);
  console.log(`[vendor]   → ${destPath}`);

  const response = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "elizaos-aosp-flasher/1.0" },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
  }

  const contentLength = response.headers.get("content-length");
  const total = contentLength ? parseInt(contentLength, 10) : null;
  let received = 0;
  let lastPct = -1;

  const fileStream = createWriteStream(destPath);

  // Stream body with progress logging
  await pipeline(
    /** @type {any} */ (response.body),
    async function* (source) {
      for await (const chunk of source) {
        received += chunk.length;
        if (total) {
          const pct = Math.floor((received / total) * 100);
          if (pct !== lastPct && pct % 10 === 0) {
            console.log(`[vendor]   ${pct}% (${(received / 1024 / 1024).toFixed(1)} MB)`);
            lastPct = pct;
          }
        }
        yield chunk;
      }
    },
    fileStream,
  );

  console.log(`[vendor] Download complete: ${destPath}`);
}

// ── Zip extraction ────────────────────────────────────────────────────────────

/**
 * Extract a zip file to a destination directory.
 * Shells out to `unzip` (macOS/Linux) or `Expand-Archive` (Windows).
 * @param {string} zipPath
 * @param {string} destDir
 */
async function extractZip(zipPath, destDir) {
  console.log(`[vendor] Extracting ${zipPath} → ${destDir}`);

  if (PLATFORM === "win32") {
    const cmd = `powershell -NoProfile -Command "Expand-Archive -Force -Path '${zipPath}' -DestinationPath '${destDir}'"`;
    await execAsync(cmd);
  } else {
    // -o: overwrite without prompting, -q: quiet
    await execAsync(`unzip -oq "${zipPath}" -d "${destDir}"`);
  }

  console.log(`[vendor] Extraction complete`);
}

// ── Platform Tools (adb + fastboot) ──────────────────────────────────────────

async function downloadPlatformTools() {
  console.log(`\n[vendor] === Android Platform Tools ===`);

  const url = PLATFORM_TOOLS_URLS[PLATFORM];
  const zipPath = join(VENDOR_ROOT, "platform-tools.zip");

  try {
    await downloadFile(url, zipPath);
    await extractZip(zipPath, VENDOR_ROOT);

    // Verify adb binary exists after extraction
    const adbName = PLATFORM === "win32" ? "adb.exe" : "adb";
    const adbPath = join(VENDOR_ROOT, "platform-tools", adbName);
    if (existsSync(adbPath)) {
      console.log(`[vendor] adb ready: ${adbPath}`);
    } else {
      console.warn(`[vendor] WARNING: adb not found at expected path ${adbPath}`);
    }

    // Make binaries executable on Unix
    if (PLATFORM !== "win32") {
      for (const bin of ["adb", "fastboot", "mke2fs"]) {
        const binPath = join(VENDOR_ROOT, "platform-tools", bin);
        if (existsSync(binPath)) {
          chmodSync(binPath, 0o755);
        }
      }
    }

    return true;
  } catch (err) {
    console.warn(`[vendor] WARNING: Failed to download platform-tools: ${err.message}`);
    return false;
  }
}

// ── Sideloader ────────────────────────────────────────────────────────────────

/**
 * Map process.platform to the Sideloader GitHub release asset name segment.
 */
const SIDELOADER_PLATFORM_MAP = {
  darwin: "darwin",
  linux: "linux",
  win32: "windows",
};

async function downloadSideloader() {
  console.log(`\n[vendor] === Sideloader ===`);

  const platformKey = SIDELOADER_PLATFORM_MAP[PLATFORM];
  const destName = PLATFORM === "win32" ? "sideloader.exe" : "sideloader";
  const destPath = join(VENDOR_ROOT, destName);

  try {
    // Fetch latest release metadata from GitHub API
    console.log(`[vendor] Fetching latest Sideloader release info…`);
    const apiResponse = await fetch(
      "https://api.github.com/repos/Dadoum/Sideloader/releases/latest",
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "elizaos-aosp-flasher/1.0",
        },
      },
    );

    if (!apiResponse.ok) {
      throw new Error(
        `GitHub API returned HTTP ${apiResponse.status} ${apiResponse.statusText}`,
      );
    }

    const release = /** @type {any} */ (await apiResponse.json());
    const assets = release.assets ?? [];

    // Find asset matching the platform key (e.g. "sideloader-darwin", "sideloader-linux")
    const asset = assets.find(
      (/** @type {any} */ a) =>
        typeof a.name === "string" &&
        a.name.toLowerCase().includes(`sideloader-${platformKey}`),
    );

    if (!asset) {
      const names = assets.map((/** @type {any} */ a) => a.name).join(", ");
      throw new Error(
        `No Sideloader asset found for platform "${platformKey}". Available: ${names || "(none)"}`,
      );
    }

    await downloadFile(asset.browser_download_url, destPath);

    // Make executable on Unix
    if (PLATFORM !== "win32") {
      chmodSync(destPath, 0o755);
      console.log(`[vendor] Sideloader ready (chmod +x): ${destPath}`);
    } else {
      console.log(`[vendor] Sideloader ready: ${destPath}`);
    }

    return true;
  } catch (err) {
    console.warn(`[vendor] WARNING: Failed to download Sideloader: ${err.message}`);
    console.warn(`[vendor]   Sideloader is optional — adb/fastboot will still work.`);
    return false;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[vendor] Platform: ${PLATFORM}`);
  console.log(`[vendor] Install root: ${VENDOR_ROOT}`);

  ensureDir(VENDOR_ROOT);

  const [platformToolsOk, sideloaderOk] = await Promise.allSettled([
    downloadPlatformTools(),
    downloadSideloader(),
  ]).then((results) =>
    results.map((r) => (r.status === "fulfilled" ? r.value : false)),
  );

  console.log(`\n[vendor] ── Summary ──────────────────────────────────`);
  console.log(`[vendor] Platform tools (adb/fastboot): ${platformToolsOk ? "OK" : "FAILED"}`);
  console.log(`[vendor] Sideloader:                    ${sideloaderOk ? "OK" : "FAILED (optional)"}`);
  console.log(`[vendor] Binaries installed to: ${VENDOR_ROOT}`);

  if (!platformToolsOk) {
    console.error(`[vendor] ERROR: Required platform tools failed to download.`);
    process.exit(1);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(`[vendor] Fatal error: ${err.message}`);
  process.exit(1);
});

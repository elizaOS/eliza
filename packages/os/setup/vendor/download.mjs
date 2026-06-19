#!/usr/bin/env node
// @ts-check
/**
 * Download vendor binaries (adb, fastboot, sideloader) for elizaos-setup.
 * Installs to ~/.elizaos/flasher/vendor/bin/{platform}/
 *
 * Usage:
 *   node vendor/download.mjs                # best-effort (postinstall default)
 *   node vendor/download.mjs --strict       # fail hard on any missing binary
 *   bun vendor/download.mjs
 *
 * Behavior:
 *   - SHA-256 verifies every download against vendor/checksums.json.
 *     A mismatch deletes the partial file and exits 1 (or warns in
 *     best-effort mode for optional components).
 *   - In --best-effort mode, a transient offline state exits 0 with a clear
 *     message telling the user to re-run `bun run vendor:update` later.
 *   - In --strict mode (CI / explicit `vendor:update`), any failure exits 1.
 */

import {
  createWriteStream,
  existsSync,
  mkdirSync,
  chmodSync,
  unlinkSync,
  readFileSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

// ── Mode ─────────────────────────────────────────────────────────────────────

const STRICT = process.argv.includes("--strict");
const BEST_EFFORT = !STRICT;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Platform detection ───────────────────────────────────────────────────────

const PLATFORM = process.platform; // "darwin" | "linux" | "win32"

if (PLATFORM !== "darwin" && PLATFORM !== "linux" && PLATFORM !== "win32") {
  console.error(`[vendor] Unsupported platform: ${PLATFORM}`);
  process.exit(1);
}

// ── Install root ─────────────────────────────────────────────────────────────

const VENDOR_ROOT = join(
  homedir(),
  ".elizaos",
  "flasher",
  "vendor",
  "bin",
  PLATFORM,
);

function ensureDir(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    console.log(`[vendor] Created directory: ${dir}`);
  }
}

// ── Checksums ────────────────────────────────────────────────────────────────

const CHECKSUMS_PATH = join(__dirname, "checksums.json");

/**
 * @returns {{
 *   "platform-tools": Record<string, { url: string, sha256: string | null, size: number | null }>,
 *   sideloader: {
 *     pinned: {
 *       version: string | null,
 *       darwin: { asset: string | null, sha256: string | null },
 *       linux: { asset: string | null, sha256: string | null },
 *       win32: { asset: string | null, sha256: string | null }
 *     }
 *   }
 * }}
 */
function loadChecksums() {
  const raw = readFileSync(CHECKSUMS_PATH, "utf8");
  return JSON.parse(raw);
}

const CHECKSUMS = loadChecksums();

// ── Offline detection ────────────────────────────────────────────────────────

async function isOnline() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch("https://dl.google.com", {
      method: "HEAD",
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

// ── Download helpers ─────────────────────────────────────────────────────────

/**
 * Download a URL to a local file, following redirects, while computing SHA-256.
 * If `expectedSha256` is non-null, verifies the hash on completion. A mismatch
 * deletes the partial file and throws.
 *
 * @param {string} url
 * @param {string} destPath
 * @param {string | null} expectedSha256
 * @returns {Promise<{ sha256: string, bytes: number }>}
 */
async function downloadFile(url, destPath, expectedSha256) {
  console.log(`[vendor] downloading ${url}`);
  console.log(`[vendor]   → ${destPath}`);

  const response = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "elizaos-setup/1.0" },
  });

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} ${response.statusText} for ${url}`,
    );
  }

  const contentLength = response.headers.get("content-length");
  const total = contentLength ? parseInt(contentLength, 10) : null;
  if (total) {
    console.log(`[vendor]   expected ${total} bytes`);
  }

  let received = 0;
  let lastPct = -1;
  const hash = createHash("sha256");

  const fileStream = createWriteStream(destPath);

  try {
    await pipeline(
      /** @type {any} */ (response.body),
      async function* (source) {
        for await (const chunk of source) {
          received += chunk.length;
          hash.update(chunk);
          if (total) {
            const pct = Math.floor((received / total) * 100);
            if (pct !== lastPct && pct % 10 === 0) {
              console.log(
                `[vendor]   ${pct}% (${(received / 1024 / 1024).toFixed(1)} MB)`,
              );
              lastPct = pct;
            }
          }
          yield chunk;
        }
      },
      fileStream,
    );
  } catch (err) {
    try { unlinkSync(destPath); } catch { /* ignore */ }
    throw err;
  }

  const actualSha256 = hash.digest("hex");

  if (expectedSha256) {
    if (actualSha256 !== expectedSha256) {
      try { unlinkSync(destPath); } catch { /* ignore */ }
      const msg =
        `[vendor] hash MISMATCH for ${url}\n` +
        `[vendor]   expected=${expectedSha256}\n` +
        `[vendor]   got     =${actualSha256}`;
      console.error(msg);
      throw new Error("Checksum mismatch — refusing to install unverified binary");
    }
    console.log(`[vendor] hash MATCH (${actualSha256})`);
  } else {
    console.log(`[vendor] hash ${actualSha256} (no pinned value to compare)`);
  }

  return { sha256: actualSha256, bytes: received };
}

// ── Zip extraction (argv arrays, never shell-strings) ────────────────────────

/**
 * Run a binary with an explicit argv array. Resolves true on exit 0.
 * @param {string} binary
 * @param {string[]} args
 */
function runChild(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(undefined);
      else reject(new Error(`${binary} exited ${code}`));
    });
  });
}

/**
 * Extract a zip file to a destination directory.
 * @param {string} zipPath
 * @param {string} destDir
 */
async function extractZip(zipPath, destDir) {
  console.log(`[vendor] Extracting ${zipPath} → ${destDir}`);

  if (PLATFORM === "win32") {
    await runChild("powershell", [
      "-NoProfile",
      "-Command",
      `Expand-Archive -Force -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}'`,
    ]);
  } else {
    await runChild("unzip", ["-oq", zipPath, "-d", destDir]);
  }

  console.log(`[vendor] Extraction complete`);
}

// ── Platform Tools (adb + fastboot) ──────────────────────────────────────────

async function downloadPlatformTools() {
  console.log(`\n[vendor] === Android Platform Tools ===`);

  const entry = CHECKSUMS["platform-tools"][PLATFORM];
  if (!entry) {
    throw new Error(`No platform-tools entry for ${PLATFORM}`);
  }

  const url = entry.url;
  const zipPath = join(VENDOR_ROOT, "platform-tools.zip");

  await downloadFile(url, zipPath, entry.sha256 ?? null);
  if (!entry.sha256) {
    console.warn(
      `[vendor] WARNING: no pinned SHA-256 for platform-tools/${PLATFORM} — ` +
        `relying on TLS only. Run the update-vendor-checksums workflow to pin.`,
    );
  }
  await extractZip(zipPath, VENDOR_ROOT);

  // Verify adb binary exists after extraction
  const adbName = PLATFORM === "win32" ? "adb.exe" : "adb";
  const adbPath = join(VENDOR_ROOT, "platform-tools", adbName);
  if (!existsSync(adbPath)) {
    throw new Error(`adb not found at expected path ${adbPath} after extract`);
  }
  console.log(`[vendor] adb ready: ${adbPath}`);

  if (PLATFORM !== "win32") {
    for (const bin of ["adb", "fastboot", "mke2fs"]) {
      const binPath = join(VENDOR_ROOT, "platform-tools", bin);
      if (existsSync(binPath)) {
        chmodSync(binPath, 0o755);
      }
    }
  }

  return true;
}

// ── Sideloader ───────────────────────────────────────────────────────────────

const SIDELOADER_PLATFORM_MAP = {
  darwin: "darwin",
  linux: "linux",
  win32: "windows",
};

/**
 * Try to find a sibling `.sha256` asset on the release. Returns its content
 * (the hex hash) or null if not present.
 * @param {Array<{ name: string, browser_download_url: string }>} assets
 * @param {string} primaryAssetName
 */
async function fetchSiblingSha256(assets, primaryAssetName) {
  const sigName = `${primaryAssetName}.sha256`;
  const sibling = assets.find((a) => a.name === sigName);
  if (!sibling) return null;
  const res = await fetch(sibling.browser_download_url, {
    headers: { "User-Agent": "elizaos-setup/1.0" },
  });
  if (!res.ok) return null;
  const text = (await res.text()).trim();
  // Common formats: "<hash>" or "<hash>  <filename>"
  const first = text.split(/\s+/)[0];
  return first && /^[0-9a-fA-F]{64}$/.test(first) ? first.toLowerCase() : null;
}

async function downloadSideloader() {
  console.log(`\n[vendor] === Sideloader ===`);

  const platformKey = SIDELOADER_PLATFORM_MAP[PLATFORM];
  const destName = PLATFORM === "win32" ? "sideloader.exe" : "sideloader";
  const destPath = join(VENDOR_ROOT, destName);

  const pinned = CHECKSUMS.sideloader?.pinned?.[PLATFORM];
  if (pinned && pinned.asset && pinned.sha256) {
    // Pinned path — download the exact asset URL and verify against the pinned hash.
    const url = pinned.asset;
    console.log(`[vendor] using pinned Sideloader asset: ${url}`);
    await downloadFile(url, destPath, pinned.sha256);
  } else {
    console.log(`[vendor] Fetching latest Sideloader release info…`);
    const apiResponse = await fetch(
      "https://api.github.com/repos/Dadoum/Sideloader/releases/latest",
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "elizaos-setup/1.0",
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

    const asset = assets.find(
      (/** @type {any} */ a) =>
        typeof a.name === "string" &&
        a.name.toLowerCase().includes(`sideloader-${platformKey}`) &&
        !a.name.endsWith(".sha256") &&
        !a.name.endsWith(".sig"),
    );

    if (!asset) {
      const names = assets.map((/** @type {any} */ a) => a.name).join(", ");
      throw new Error(
        `No Sideloader asset for "${platformKey}". Available: ${names || "(none)"}`,
      );
    }

    const expectedSha = await fetchSiblingSha256(assets, asset.name);
    if (!expectedSha) {
      throw new Error(
        "Sideloader checksum unavailable — refusing to install unverified " +
          "binary. Pin a known-good version in vendor/checksums.json instead.",
      );
    }
    await downloadFile(asset.browser_download_url, destPath, expectedSha);
  }

  if (PLATFORM !== "win32") {
    chmodSync(destPath, 0o755);
  }
  console.log(`[vendor] Sideloader ready: ${destPath}`);
  return true;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[vendor] Platform: ${PLATFORM}`);
  console.log(`[vendor] Mode:     ${STRICT ? "strict" : "best-effort"}`);
  console.log(`[vendor] Install root: ${VENDOR_ROOT}`);

  ensureDir(VENDOR_ROOT);

  if (!(await isOnline())) {
    const msg =
      "[vendor] No network reachable (https://dl.google.com unreachable in 5s).";
    if (STRICT) {
      console.error(`${msg} Failing strict mode.`);
      process.exit(1);
    }
    console.warn(`${msg} Skipping vendor download.`);
    console.warn(
      `[vendor] Run \`bun run vendor:update\` after going online to bundle binaries.`,
    );
    process.exit(0);
  }

  /** @type {{ name: string, required: boolean, fn: () => Promise<boolean> }[]} */
  const tasks = [
    { name: "platform-tools", required: true, fn: downloadPlatformTools },
    { name: "sideloader", required: false, fn: downloadSideloader },
  ];

  /** @type {{ name: string, ok: boolean, required: boolean, error?: string }[]} */
  const results = [];

  for (const task of tasks) {
    try {
      const ok = await task.fn();
      results.push({ name: task.name, ok, required: task.required });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[vendor] ${task.name} FAILED: ${msg}`);
      results.push({
        name: task.name,
        ok: false,
        required: task.required,
        error: msg,
      });
    }
  }

  console.log(`\n[vendor] ── Summary ──────────────────────────────────`);
  for (const r of results) {
    const label = r.required ? "required" : "optional";
    console.log(
      `[vendor] ${r.name.padEnd(16)} (${label}) — ${r.ok ? "OK" : `FAILED${r.error ? `: ${r.error}` : ""}`}`,
    );
  }
  console.log(`[vendor] Binaries installed to: ${VENDOR_ROOT}`);

  const missingRequired = results.filter((r) => !r.ok && r.required);
  const missingOptional = results.filter((r) => !r.ok && !r.required);

  if (STRICT) {
    const anyFail = results.some((r) => !r.ok);
    if (anyFail) {
      console.error("[vendor] strict mode: one or more downloads failed.");
      process.exit(1);
    }
  } else {
    if (missingRequired.length > 0) {
      console.warn(
        `[vendor] best-effort mode: required components missing (${missingRequired
          .map((r) => r.name)
          .join(", ")}). The app will prompt the user to install them at runtime.`,
      );
    }
    if (missingOptional.length > 0) {
      console.warn(
        `[vendor] best-effort mode: optional components missing (${missingOptional
          .map((r) => r.name)
          .join(", ")}). Functionality requiring them will be unavailable.`,
      );
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(`[vendor] Fatal error: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});

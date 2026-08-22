#!/usr/bin/env node
/**
 * Fetches the pinned Bun release zip for CI with GitHub Releases retries and
 * an npm registry fallback, then optionally serves it on localhost so
 * oven-sh/setup-bun does not have to download from GitHub itself.
 *
 * GitHub-hosted jobs set setup-bun `no-cache: true` because the extracted
 * executable lives in an ephemeral per-job HOME. That is correct for shared
 * runners, but it also means every job re-downloads bun-linux-x64.zip from
 * GitHub Releases. A develop merge then stampedes that CDN and fails with
 * `socket hang up`. This script caches the immutable zip (not the HOME path)
 * and mirrors through registry.npmjs.org.
 */
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { crc32 } from "node:zlib";

const BUN_VERSION = "1.3.14";
const ZIP_NAME = "bun.zip";
const DEFAULT_ATTEMPTS = 6;
// Six deadlines plus the existing 22.5s backoff still leave 5m jobs time to use npm.
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * @typedef {{
 *   platform: string,
 *   arch: string,
 *   hasAvx2?: boolean,
 * }} HostProbe
 */

/**
 * @param {HostProbe} host
 */
export function resolveBunAsset(host) {
  const platform = host.platform;
  const arch = host.arch === "x64" || host.arch === "ia32" ? "x64" : host.arch;
  if (platform === "linux" && arch === "x64") {
    const baseline = host.hasAvx2 === false;
    return {
      variant: baseline ? "linux-x64-baseline" : "linux-x64",
      githubAsset: baseline
        ? "bun-linux-x64-baseline.zip"
        : "bun-linux-x64.zip",
      npmPackage: baseline
        ? "@oven/bun-linux-x64-baseline"
        : "@oven/bun-linux-x64",
      zipRoot: baseline ? "bun-linux-x64-baseline" : "bun-linux-x64",
    };
  }
  if (platform === "linux" && (arch === "arm64" || arch === "aarch64")) {
    return {
      variant: "linux-arm64",
      githubAsset: "bun-linux-aarch64.zip",
      npmPackage: "@oven/bun-linux-aarch64",
      zipRoot: "bun-linux-aarch64",
    };
  }
  if (platform === "darwin" && arch === "x64") {
    return {
      variant: "darwin-x64",
      githubAsset: "bun-darwin-x64.zip",
      npmPackage: "@oven/bun-darwin-x64",
      zipRoot: "bun-darwin-x64",
    };
  }
  if (platform === "darwin" && (arch === "arm64" || arch === "aarch64")) {
    return {
      variant: "darwin-arm64",
      githubAsset: "bun-darwin-aarch64.zip",
      npmPackage: "@oven/bun-darwin-aarch64",
      zipRoot: "bun-darwin-aarch64",
    };
  }
  if (platform === "win32" && arch === "x64") {
    return {
      variant: "win-x64",
      githubAsset: "bun-windows-x64.zip",
      npmPackage: "@oven/bun-windows-x64",
      zipRoot: "bun-windows-x64",
    };
  }
  if (platform === "win32" && (arch === "arm64" || arch === "aarch64")) {
    return {
      variant: "win-arm64",
      githubAsset: "bun-windows-aarch64.zip",
      npmPackage: "@oven/bun-windows-aarch64",
      zipRoot: "bun-windows-aarch64",
    };
  }
  throw new Error(
    `unsupported Bun CI host: platform=${platform} arch=${host.arch}`,
  );
}

/**
 * @param {string} version
 * @param {ReturnType<typeof resolveBunAsset>} asset
 */
export function bunReleaseUrls(version, asset) {
  const github = `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${asset.githubAsset}`;
  const npmName = asset.npmPackage.replace("@oven/", "");
  const npm = `https://registry.npmjs.org/${asset.npmPackage}/-/${npmName}-${version}.tgz`;
  if (version === BUN_VERSION) {
    return [github, npm];
  }
  return [github.replace(`bun-v${BUN_VERSION}`, `bun-v${version}`), npm];
}

export function detectLinuxAvx2(cpuInfo) {
  return /(^|\s)avx2(\s|$)/.test(cpuInfo);
}

export function probeHost(env = process.env, cpuInfo = "") {
  const platform = env.ELIZA_BUN_PLATFORM || process.platform;
  const arch = env.ELIZA_BUN_ARCH || process.arch;
  let hasAvx2;
  if (platform === "linux" && (arch === "x64" || arch === "ia32")) {
    const info =
      cpuInfo ||
      (existsSync("/proc/cpuinfo")
        ? readFileSync("/proc/cpuinfo", "utf8")
        : "");
    hasAvx2 = detectLinuxAvx2(info);
  }
  return { platform, arch, hasAvx2 };
}

function zipLooksValid(bytes) {
  return bytes.length > 32 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

function tgzLooksValid(bytes) {
  return bytes.length > 20 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function validateRequestTimeoutMs(value) {
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_TIMER_DELAY_MS
  ) {
    throw new TypeError(
      `requestTimeoutMs must be an integer between 1 and ${MAX_TIMER_DELAY_MS}; received ${String(value)}`,
    );
  }
}

async function downloadBytes(
  url,
  {
    fetchImpl,
    attempts,
    retryDelayMs = 1500,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  },
) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchImpl(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (!response.ok) {
        throw new Error(`${url} -> HTTP ${response.status}`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length < 32) {
        throw new Error(`${url} returned ${bytes.length} bytes`);
      }
      return bytes;
    } catch (error) {
      // error-policy:J1 retry a transient GitHub/npm hang, then fail this URL
      lastError = error;
      if (attempt === attempts) break;
      await new Promise((resolve) =>
        setTimeout(resolve, attempt * retryDelayMs),
      );
    }
  }
  const cause =
    lastError instanceof Error ? lastError : new Error(String(lastError));
  throw new Error(
    `Bun release request failed after ${attempts} attempt(s) with a ${requestTimeoutMs}ms deadline: ${url}: ${cause.message}`,
    { cause },
  );
}

/**
 * Writes a STORE-method zip. Self-hosted runners do not ship a `zip` binary,
 * and the npm fallback has to reshape a tarball into the GitHub release layout
 * that oven-sh/setup-bun expects (`<zipRoot>/bun`).
 *
 * @param {string} zipPath
 * @param {Array<{ name: string, data: Buffer, executable?: boolean }>} entries
 */
export function writeStoredZip(zipPath, entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name.replaceAll("\\", "/"), "utf8");
    const data = entry.data;
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const localHeader = Buffer.concat([local, name, data]);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    const mode = entry.executable ? 0o100755 : 0o100644;
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(localHeader);
    centrals.push(Buffer.concat([central, name]));
    offset += localHeader.length;
  }
  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  writeFileSync(zipPath, Buffer.concat([...locals, centralDir, eocd]));
}

function npmTgzToGithubZip(tgzPath, zipPath, zipRoot) {
  const extractRoot = mkdtempSync(join(tmpdir(), "eliza-bun-npm-"));
  execFileSync("tar", ["-xzf", tgzPath, "-C", extractRoot], {
    stdio: "pipe",
  });
  const bunName = process.platform === "win32" ? "bun.exe" : "bun";
  const found = readdirSync(extractRoot, { recursive: true, encoding: "utf8" })
    .map((rel) => join(extractRoot, rel))
    .find((abs) => abs.endsWith(`/${bunName}`) || abs.endsWith(`\\${bunName}`));
  if (!found) {
    throw new Error(`npm tarball at ${tgzPath} did not contain ${bunName}`);
  }
  writeStoredZip(zipPath, [
    {
      name: `${zipRoot}/${bunName}`,
      data: readFileSync(found),
      executable: process.platform !== "win32",
    },
  ]);
}

export async function ensureBunReleaseZip(options) {
  const {
    outDir,
    version = BUN_VERSION,
    host = probeHost(),
    fetchImpl = globalThis.fetch,
    attempts = DEFAULT_ATTEMPTS,
    retryDelayMs = 1500,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  } = options;
  validateRequestTimeoutMs(requestTimeoutMs);
  mkdirSync(outDir, { recursive: true });
  const zipPath = join(outDir, ZIP_NAME);
  if (existsSync(zipPath)) {
    const existing = readFileSync(zipPath);
    if (zipLooksValid(existing)) {
      return { zipPath, cacheHit: true, asset: resolveBunAsset(host) };
    }
  }
  const asset = resolveBunAsset(host);
  const urls = bunReleaseUrls(version, asset);
  let lastError;
  for (const url of urls) {
    try {
      const bytes = await downloadBytes(url, {
        fetchImpl,
        attempts,
        retryDelayMs,
        requestTimeoutMs,
      });
      if (zipLooksValid(bytes)) {
        writeFileSync(zipPath, bytes);
      } else if (tgzLooksValid(bytes)) {
        const tgzPath = join(outDir, "bun.tgz");
        writeFileSync(tgzPath, bytes);
        npmTgzToGithubZip(tgzPath, zipPath, asset.zipRoot);
      } else {
        throw new Error(`${url} was neither a zip nor a gzip tarball`);
      }
      return { zipPath, cacheHit: false, asset, source: url };
    } catch (error) {
      // error-policy:J1 try the next mirror, then fail the CI download
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Bun release download failed");
}

export function serveBunZip(zipPath, urlFile) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.url !== `/${ZIP_NAME}` && req.url !== "/") {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/zip" });
      createReadStream(zipPath).pipe(res);
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Bun zip server did not bind a TCP port"));
        return;
      }
      const url = `http://127.0.0.1:${address.port}/${ZIP_NAME}`;
      if (urlFile) {
        mkdirSync(dirname(urlFile), { recursive: true });
        writeFileSync(urlFile, `${url}\n`);
      }
      resolve({ url, server });
    });
  });
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--print-variant") args.printVariant = true;
    else if (token === "--serve-only") args.serveOnly = true;
    else if (token === "--out-dir") args.outDir = argv[++i];
    else if (token === "--url-file") args.urlFile = argv[++i];
    else args._.push(token);
  }
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const host = probeHost();
  const asset = resolveBunAsset(host);
  if (args.printVariant) {
    process.stdout.write(`${asset.variant}\n`);
    const githubOutput = process.env.GITHUB_OUTPUT;
    if (githubOutput) {
      appendFileSync(githubOutput, `variant=${asset.variant}\n`);
    }
    return;
  }
  const outDir = args.outDir;
  if (!outDir) {
    throw new Error("ci-fetch-bun-release: --out-dir is required");
  }
  const zipPath = join(outDir, ZIP_NAME);
  if (!args.serveOnly) {
    const result = await ensureBunReleaseZip({
      outDir,
      version: process.env.BUN_VERSION || BUN_VERSION,
      host,
    });
    process.stdout.write(
      `bun zip ready variant=${result.asset.variant} cacheHit=${result.cacheHit} path=${result.zipPath}\n`,
    );
  }
  if (!existsSync(zipPath)) {
    throw new Error(`ci-fetch-bun-release: missing ${zipPath}`);
  }
  if (args.serveOnly || args.urlFile) {
    const { url } = await serveBunZip(zipPath, args.urlFile);
    process.stdout.write(`bun zip url ${url}\n`);
    if (args.serveOnly) {
      process.on("SIGHUP", () => {});
      await new Promise(() => {});
    }
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    // error-policy:J1 the executable boundary prints one message and exits
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
